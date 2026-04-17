/**
 * ascii-strobe.js  —  Volumetric ASCII 3D head renderer
 *
 * Renders the character's lathe-mesh head as filled, lit solid polygons
 * to an offscreen canvas, then converts the shaded image to ASCII
 * characters where glyph density represents surface brightness/depth.
 *
 * Features:
 *   - Painter's-algorithm polygon fill with back-face culling
 *   - Directional diffuse + specular + Fresnel rim lighting
 *   - Eye-socket and mouth cavity darkening
 *   - Nose ridge highlight
 *   - Beat-triggered strobe envelope (4 profiles)
 *   - Bass-reactive color boost and jitter
 *   - Phosphor-glow post-processing
 *   - Scanline dimming for CRT aesthetic
 *   - Box-head support (filled 3D box)
 *
 * Public API:  window.asciiStrobe  (drop-in replacement)
 */
(function () {
    'use strict';

    /* ================================================================
     *  CONFIGURATION
     * ================================================================ */

    // ASCII density ramps (ordered by visual ink weight)
    var RAMP_CLEAN  = ' .,:;=+*?S#%@$';           // 14 chars, clean look
    var RAMP_FULL   = " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$";
    var RAMP_BLOCK  = ' .\u00b7:+*#\u2593\u2588'; // 9 chars  · ▓ █

    // CP437 high-glyph ramp — shader blocks, box-drawing, and geometric chars
    // from the same character set TDF fonts are built with
    var RAMP_CP437  = ' .░▒▓█';              // 6 chars: space . ░ ▒ ▓ █
    //                  .    ░    ▒    ▓    █     (5 chars)

    var ramp    = RAMP_CLEAN;
    var rampLen = ramp.length;

    // Beat-alternating ramp: swap between user-selected ramp and CP437 each beat
    var _baseRamp     = RAMP_CLEAN;    // the user's chosen ramp
    var _altRamp      = RAMP_CP437;    // alternate ramp (CP437 shader blocks)
    var _useAltRamp   = false;         // toggled each beat

    // Target ASCII grid size (cell px derived from canvas size)
    var TARGET_COLS = 110;

    // Offscreen solid-render resolution
    var SOLID_W = 480;
    var SOLID_H = 360;

    // Lighting (in camera / eye space)
    var LIGHT = (function () {
        // Light from the viewer's position — like a projector beam
        var x = 0.10, y = 0.25, z = 0.96;
        var l = Math.sqrt(x * x + y * y + z * z);
        return { x: x / l, y: y / l, z: z / l };
    })();
    var AMBIENT          = 0.22;
    var DIFFUSE          = 0.55;
    var SPECULAR         = 0.22;
    var SPEC_POWER       = 5;
    var FRESNEL_STRENGTH = 0.18;
    var SCANLINE_DIM     = 0.88;   // odd rows get multiplied by this

    // Strobe profiles  { attack, hold, decay } in ms
    var PROFILES = {
        flash:   { attack: 35,  hold: 80,   decay: 300,  glitch: false, glitchProb: 0 },
        pulse:   { attack: 90,  hold: 130,  decay: 500,  glitch: false, glitchProb: 0 },
        sustain: { attack: 55,  hold: 400,  decay: 700,  glitch: false, glitchProb: 0 },
        glitch:  { attack: 20,  hold: 50,   decay: 220,  glitch: true,  glitchProb: 0.30 }
    };
    var PROFILE_NAMES = Object.keys(PROFILES);

    /* ================================================================
     *  STATE
     * ================================================================ */

    var enabled      = true;
    var profileIdx   = 0;
    var profile      = PROFILES[PROFILE_NAMES[0]];

    var wireCanvasRef = null;
    var asciiCanvas   = null;
    var asciiCtx      = null;
    var solidCanvas   = null;
    var solidCtx      = null;

    var cellW = 12, cellH = 18;   // recalculated on resize
    var cols  = 0,  rows  = 0;

    // Body-from-wireframe: downsampled capture of the wireframe canvas
    var bodyOffscreen = null;
    var bodyOffCtx    = null;

    // Strobe envelope
    var strobePhase  = 'idle';
    var phaseStart   = 0;
    var mixValue     = 0;
    var lastBeatCount = 0;

    /* ================================================================
     *  MATH HELPERS
     * ================================================================ */

    function now()      { return performance.now(); }
    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    function easeOut(t) { return 1 - (1 - t) * (1 - t); }

    function cross(ax, ay, az, bx, by, bz) {
        return {
            x: ay * bz - az * by,
            y: az * bx - ax * bz,
            z: ax * by - ay * bx
        };
    }

    /* ================================================================
     *  INIT / DESTROY / RESIZE
     * ================================================================ */

    function init(wireCanvas, container) {
        wireCanvasRef = wireCanvas;

        // Tear down previous
        if (asciiCanvas && asciiCanvas.parentNode)
            asciiCanvas.parentNode.removeChild(asciiCanvas);

        asciiCanvas = document.createElement('canvas');
        asciiCanvas.id = 'viz-ascii';
        asciiCanvas.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;' +
            'pointer-events:none;opacity:0;z-index:2;';
        if (container) container.appendChild(asciiCanvas);

        // Offscreen for solid 3D render (never in DOM)
        solidCanvas = document.createElement('canvas');

        // Offscreen for wireframe body capture
        bodyOffscreen = document.createElement('canvas');
        bodyOffCtx = bodyOffscreen.getContext('2d', { willReadFrequently: true });
        solidCanvas.width  = SOLID_W;
        solidCanvas.height = SOLID_H;
        solidCtx = solidCanvas.getContext('2d', { willReadFrequently: true });

        resize(wireCanvas.width, wireCanvas.height);
    }

    function destroy() {
        if (asciiCanvas && asciiCanvas.parentNode)
            asciiCanvas.parentNode.removeChild(asciiCanvas);
        asciiCanvas = asciiCtx = solidCanvas = solidCtx = wireCanvasRef = null;
        bodyOffscreen = bodyOffCtx = null;
    }

    function resize(w, h) {
        if (!asciiCanvas) return;
        asciiCanvas.width  = w;
        asciiCanvas.height = h;
        asciiCtx = asciiCanvas.getContext('2d');

        // Derive cell size from target column count
        cellW = Math.max(7, Math.round(w / TARGET_COLS));
        cellH = Math.round(cellW * 1.55);           // monospace aspect ≈ 0.6
        cols  = Math.floor(w / cellW);
        rows  = Math.floor(h / cellH);
    }

    /* ================================================================
     *  STROBE ENVELOPE
     * ================================================================ */

    function triggerStrobe() {
        strobePhase = 'attack';
        phaseStart  = now();
    }

    function updateEnvelope() {
        var t = now(), elapsed = t - phaseStart;
        switch (strobePhase) {
            case 'attack':
                mixValue = clamp01(elapsed / profile.attack);
                if (elapsed >= profile.attack) { strobePhase = 'hold'; phaseStart = t; mixValue = 1; }
                break;
            case 'hold':
                mixValue = 1;
                if (elapsed >= profile.hold) { strobePhase = 'decay'; phaseStart = t; }
                break;
            case 'decay':
                mixValue = 1 - easeOut(clamp01(elapsed / profile.decay));
                if (elapsed >= profile.decay) { strobePhase = 'idle'; mixValue = 0; }
                break;
            default:
                mixValue = 0;
        }
        if (profile.glitch && strobePhase !== 'idle' && Math.random() < profile.glitchProb)
            mixValue *= (0.25 + Math.random() * 0.75);
    }

    /* ================================================================
     *  MESH → FACE LIST  (lathe revolution surface)
     * ================================================================ */

    function buildLatheFaces(charProfile, ringN, projState) {
        var cosY = projState.cosY, sinY = projState.sinY;
        var cosX = projState.cosX, sinX = projState.sinX;
        var pulse = projState.pulse || 1;
        var pLen = charProfile.length;

        // --- vertices in camera space ---
        var V = new Array(pLen);
        for (var p = 0; p < pLen; p++) {
            V[p] = new Array(ringN + 1);
            var R = charProfile[p][0] * pulse;
            var Y = charProfile[p][1] * pulse;
            for (var s = 0; s <= ringN; s++) {
                var a  = (s / ringN) * 6.2831853;
                var mx = R * Math.cos(a), mz = R * Math.sin(a);
                var rx  = mx * cosY - mz * sinY;
                var rz  = mx * sinY + mz * cosY;
                var ry  = Y  * cosX - rz * sinX;
                var rz2 = Y  * sinX + rz * cosX;
                V[p][s] = { x: rx, y: ry, z: rz2 };
            }
        }

        // --- quad faces ---
        var faces = [];
        for (var p = 0; p < pLen - 1; p++) {
            for (var s = 0; s < ringN; s++) {
                var v0 = V[p][s], v1 = V[p][s+1], v2 = V[p+1][s+1], v3 = V[p+1][s];

                // normal via diagonal cross product
                var n = cross(
                    v2.x-v0.x, v2.y-v0.y, v2.z-v0.z,
                    v3.x-v1.x, v3.y-v1.y, v3.z-v1.z
                );
                var nl = Math.sqrt(n.x*n.x + n.y*n.y + n.z*n.z);
                if (nl < 1e-7) continue;
                n.x /= nl; n.y /= nl; n.z /= nl;

                // back-face cull  (camera looks +z, front normals point -z)
                if (n.z > 0.02) continue;

                // diffuse
                var NdL = -(n.x*LIGHT.x + n.y*LIGHT.y + n.z*LIGHT.z);
                if (NdL < 0) NdL = 0;

                // specular  (cheap Blinn-ish: NdotL^power)
                var spec = Math.pow(NdL, SPEC_POWER) * SPECULAR;

                // fresnel rim glow
                var fres = 1.0 - Math.abs(n.z);
                fres *= fres;

                var bright = clamp01(AMBIENT + DIFFUSE * NdL + spec + FRESNEL_STRENGTH * fres);

                faces.push({
                    v: [v0, v1, v2, v3],
                    b: bright,
                    d: (v0.z + v1.z + v2.z + v3.z) * 0.25
                });
            }
        }

        // painter's sort (far first)
        faces.sort(function (a, b) { return b.d - a.d; });
        return faces;
    }

    /* ================================================================
     *  MESH → FACE LIST  (box head shape)
     * ================================================================ */

    function buildBoxFaces(boxDims, projState) {
        var cosY = projState.cosY, sinY = projState.sinY;
        var cosX = projState.cosX, sinX = projState.sinX;
        var pulse = projState.pulse || 1;
        var w = boxDims.w * pulse, h = boxDims.h * pulse, d = boxDims.d * pulse;

        function rot(x, y, z) {
            var rx  = x * cosY - z * sinY;
            var rz  = x * sinY + z * cosY;
            var ry  = y * cosX - rz * sinX;
            var rz2 = y * sinX + rz * cosX;
            return { x: rx, y: ry, z: rz2 };
        }

        // 8 corners
        var c = [
            rot(-w,  h,  d), rot( w,  h,  d), rot( w, -h,  d), rot(-w, -h,  d),  // front
            rot(-w,  h, -d), rot( w,  h, -d), rot( w, -h, -d), rot(-w, -h, -d)   // back
        ];

        // 6 faces  [v0,v1,v2,v3] wound CCW from outside
        var quads = [
            [c[0], c[1], c[2], c[3]],   // front
            [c[5], c[4], c[7], c[6]],   // back
            [c[4], c[0], c[3], c[7]],   // left
            [c[1], c[5], c[6], c[2]],   // right
            [c[4], c[5], c[1], c[0]],   // top
            [c[3], c[2], c[6], c[7]]    // bottom
        ];

        var faces = [];
        for (var i = 0; i < quads.length; i++) {
            var q = quads[i];
            var n = cross(
                q[2].x-q[0].x, q[2].y-q[0].y, q[2].z-q[0].z,
                q[3].x-q[1].x, q[3].y-q[1].y, q[3].z-q[1].z
            );
            var nl = Math.sqrt(n.x*n.x + n.y*n.y + n.z*n.z);
            if (nl < 1e-7) continue;
            n.x /= nl; n.y /= nl; n.z /= nl;
            if (n.z > 0.02) continue;

            var NdL = -(n.x*LIGHT.x + n.y*LIGHT.y + n.z*LIGHT.z);
            if (NdL < 0) NdL = 0;
            var spec = Math.pow(NdL, SPEC_POWER) * SPECULAR;
            var fres = 1.0 - Math.abs(n.z); fres *= fres;
            var bright = clamp01(AMBIENT + DIFFUSE * NdL + spec + FRESNEL_STRENGTH * fres);

            faces.push({
                v: q,
                b: bright,
                d: (q[0].z + q[1].z + q[2].z + q[3].z) * 0.25
            });
        }
        faces.sort(function (a, b) { return b.d - a.d; });
        return faces;
    }

    /* ================================================================
     *  RENDER SOLID TO OFFSCREEN CANVAS
     * ================================================================ */

    function renderSolid(faces, projState) {
        solidCtx.clearRect(0, 0, SOLID_W, SOLID_H);
        var cx = SOLID_W * 0.5;
        var cy = SOLID_H * 0.42;
        var sc = Math.min(SOLID_W, SOLID_H) * 0.3;
        var fl = projState.fl;
        var S  = sc * (projState.pulse || 1);

        for (var i = 0; i < faces.length; i++) {
            var f = faces[i];
            var g = Math.round(f.b * 255);
            solidCtx.fillStyle = 'rgb(' + g + ',' + g + ',' + g + ')';
            solidCtx.beginPath();
            for (var j = 0; j < f.v.length; j++) {
                var v = f.v[j];
                var d = fl / (fl + v.z);
                var sx = cx + v.x * S * d;
                var sy = cy - v.y * S * d;
                j === 0 ? solidCtx.moveTo(sx, sy) : solidCtx.lineTo(sx, sy);
            }
            solidCtx.closePath();
            solidCtx.fill();
        }
    }

    /* ================================================================
     *  FACIAL CAVITIES  (eyes, mouth, nose)
     * ================================================================ */

    function renderCavities(ch, projState, mOpen) {
        if (!ch.eyes) return;
        var cx = SOLID_W * 0.5;
        var cy = SOLID_H * 0.42;
        var sc = Math.min(SOLID_W, SOLID_H) * 0.3;
        var fl = projState.fl;
        var S  = sc * (projState.pulse || 1);
        var cosY = projState.cosY, sinY = projState.sinY;
        var cosX = projState.cosX, sinX = projState.sinX;

        function proj(x, y, z) {
            var rx  = x * cosY - z * sinY;
            var rz  = x * sinY + z * cosY;
            var ry  = y * cosX - rz * sinX;
            var rz2 = y * sinX + rz * cosX;
            var d   = fl / (fl + rz2);
            return { sx: cx + rx * S * d, sy: cy - ry * S * d, d: d, rz: rz2 };
        }

        // Deep black for cavities
        solidCtx.fillStyle = 'rgb(2,2,2)';

        // Eye sockets
        var eR = (ch.eyes.left.r || 0.08) * S * 2.0;

        var le = proj(ch.eyes.left.x, ch.eyes.left.y, ch.eyes.left.z);
        if (le.rz < 0.6) {
            solidCtx.beginPath();
            solidCtx.arc(le.sx, le.sy, eR * le.d, 0, 6.2832);
            solidCtx.fill();
        }

        var re = proj(ch.eyes.right.x, ch.eyes.right.y, ch.eyes.right.z);
        if (re.rz < 0.6) {
            solidCtx.beginPath();
            solidCtx.arc(re.sx, re.sy, eR * re.d, 0, 6.2832);
            solidCtx.fill();
        }

        // Mouth cavity
        if (ch.mouth) {
            var m  = proj(0, ch.mouth.y, ch.mouth.z);
            if (m.rz < 0.6) {
                var mw = (ch.mouth.hw || 0.15) * S * m.d * 1.1;
                var mh = Math.max(0.025, mOpen || 0) * S * m.d * 0.55;
                solidCtx.beginPath();
                solidCtx.ellipse(m.sx, m.sy, mw, mh, 0, 0, 6.2832);
                solidCtx.fill();
            }
        }

        // Nose ridge (bright highlight along bridge)
        if (ch.nose && ch.nose.bridge && ch.nose.bridge.length > 1) {
            solidCtx.strokeStyle = 'rgb(220,220,220)';
            solidCtx.lineWidth   = 2.5;
            solidCtx.lineCap     = 'round';
            solidCtx.beginPath();
            var allVisible = true;
            for (var i = 0; i < ch.nose.bridge.length; i++) {
                var nb = ch.nose.bridge[i];
                var np = proj(nb[0], nb[1], nb[2]);
                if (np.rz > 0.6) { allVisible = false; break; }
                i === 0 ? solidCtx.moveTo(np.sx, np.sy) : solidCtx.lineTo(np.sx, np.sy);
            }
            if (allVisible) solidCtx.stroke();
        }
    }

    /* ================================================================
     *  CAPTURE WIREFRAME BODY  →  downsampled luminance grid
     * ================================================================ */

    function captureWireframeGrid() {
        // Downsample wireframe canvas to cols×rows for body/accessory coverage
        if (!wireCanvasRef || !bodyOffscreen || cols < 2 || rows < 2) return null;
        bodyOffscreen.width  = cols;
        bodyOffscreen.height = rows;
        bodyOffCtx.drawImage(wireCanvasRef, 0, 0, cols, rows);
        try { return bodyOffCtx.getImageData(0, 0, cols, rows); }
        catch (e) { return null; }
    }

    /* ================================================================
     *  GEOMETRIC SILHOUETTE MASK
     *  Constrains ASCII characters to only appear inside the character's
     *  head and body regions, preventing glow/shadowBlur bleed artifacts.
     * ================================================================ */

    var MASK_PAD_CELLS = 0.0;  // no padding — strobe only on actual surface

    function _projectPt(ps, x, y, z) {
        // Minimal projectHeadPoint clone — avoids cross-file dependency
        var rx  = x * ps.cosY - z * ps.sinY;
        var rz  = x * ps.sinY + z * ps.cosY;
        var ry2 = y * ps.cosX - rz * ps.sinX;
        var rz2 = y * ps.sinX + rz * ps.cosX;
        var d   = ps.fl / (ps.fl + rz2);
        var S   = ps.scale * (ps.pulse || 1);
        return { x: ps.cx + rx * S * d, y: ps.cy - ry2 * S * d };
    }

    function _getProfileRadius(profile, y) {
        // Interpolate head radius at local y — clone of visualizer's getHeadRadius
        if (!profile || profile.length < 2) return 0;
        var first = profile[0], last = profile[profile.length - 1];
        if (y <= first[1]) return first[0];
        if (y >= last[1])  return last[0];
        for (var i = 0; i < profile.length - 1; i++) {
            var ay = profile[i][1], by = profile[i + 1][1];
            if (y >= ay && y <= by) {
                var f = (by === ay) ? 0 : (y - ay) / (by - ay);
                return profile[i][0] + (profile[i + 1][0] - profile[i][0]) * f;
            }
        }
        return 0;
    }

    function buildSilhouetteMask(char, ps) {
        // Returns a Uint8Array of cols*rows, 1 = inside silhouette, 0 = outside
        // Returns null for wireframe-only shapes (metatronscube etc.) to skip masking
        if (!ps || cols < 2 || rows < 2) return null;

        var profile = char.profile;
        var box = char.boxDims;
        var hasHead = (profile && profile.length >= 2) || box;
        var hasBody = char.body && char.body.skeleton;
        if (!hasHead && !hasBody) return null;  // wireframe-only → no mask

        // Reuse mask buffer to reduce GC pressure
        if (!buildSilhouetteMask._buf || buildSilhouetteMask._buf.length !== cols * rows) {
            buildSilhouetteMask._buf = new Uint8Array(cols * rows);
        }
        var mask = buildSilhouetteMask._buf;
        mask.fill(0);
        var W = cols * cellW, H = rows * cellH;
        var padX = MASK_PAD_CELLS * cellW;
        var padY = MASK_PAD_CELLS * cellH;
        var pulse = ps.pulse || 1;

        // ---- HEAD SILHOUETTE ----

        if (profile && profile.length >= 2) {
            // Lathe head: walk profile Y range and project screen bounds per row
            var yMin = profile[0][1] * pulse;
            var yMax = profile[profile.length - 1][1] * pulse;
            // Hair is rendered via wireframe; no Y extension needed for mask
            var STEPS = 40;  // sample head at 40 height slices for accuracy
            // Build an array of screen-space horizontal extents
            var headSpans = [];  // {screenY, screenLeft, screenRight}
            for (var s = 0; s <= STEPS; s++) {
                var localY = yMin + (yMax - yMin) * (s / STEPS);
                var r = _getProfileRadius(profile, localY / pulse) * pulse;
                if (r < 0.001) r = 0.02;  // thin tip still needs a sliver of coverage
                // Hair extent is handled by wireframe, not the geometric mask
                // Project leftmost and rightmost points at this Y
                // At head rotation, the widest visible extent is at x=+/-r, z=0
                // But we also need to check x=0, z=+/-r for front/back thickness
                // Take the max screen extent from ring samples
                var minSX = Infinity, maxSX = -Infinity, screenY = 0;
                var RING_SAMPLES = 8;
                for (var rs = 0; rs < RING_SAMPLES; rs++) {
                    var a = (rs / RING_SAMPLES) * 6.2831853;
                    var px = r * Math.cos(a);
                    var pz = r * Math.sin(a);
                    var pt = _projectPt(ps, px, localY, pz);
                    if (pt.x < minSX) minSX = pt.x;
                    if (pt.x > maxSX) maxSX = pt.x;
                    screenY = pt.y;  // Y is the same for all ring samples (same localY)
                }
                headSpans.push({ y: screenY, l: minSX - padX, r: maxSX + padX });
            }
            // For each ASCII grid row, find head column bounds by interpolating spans
            for (var row = 0; row < rows; row++) {
                var cy = row * cellH + cellH * 0.5;
                // Find the two spans bracketing this screen Y
                var spanL = -1, spanR = -1;
                for (var i = 0; i < headSpans.length - 1; i++) {
                    var a = headSpans[i], b = headSpans[i + 1];
                    // headSpans Y may not be monotonic due to rotation, so check if cy is between
                    var minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
                    if (cy >= minY - padY && cy <= maxY + padY) {
                        var f = (maxY === minY) ? 0.5 : (cy - a.y) / (b.y - a.y);
                        f = Math.max(0, Math.min(1, f));
                        var iL = a.l + (b.l - a.l) * f;
                        var iR = a.r + (b.r - a.r) * f;
                        if (spanL < 0 || iL < spanL) spanL = iL;
                        if (spanR < 0 || iR > spanR) spanR = iR;
                    }
                }
                if (spanL >= 0 && spanR >= 0) {
                    var colStart = Math.max(0, Math.floor(spanL / cellW));
                    var colEnd   = Math.min(cols - 1, Math.ceil(spanR / cellW));
                    for (var c = colStart; c <= colEnd; c++) {
                        mask[row * cols + c] = 1;
                    }
                }
            }
        } else if (box) {
            // Box head: project 8 corners, find screen bounding box
            var bw = box.w * pulse, bh = box.h * pulse, bd = (box.d || 0.28) * pulse;
            var corners = [
                [-bw, 0, -bd], [bw, 0, -bd], [-bw, 0, bd], [bw, 0, bd],
                [-bw, -bh, -bd], [bw, -bh, -bd], [-bw, -bh, bd], [bw, -bh, bd]
            ];
            var minSX = Infinity, maxSX = -Infinity, minSY = Infinity, maxSY = -Infinity;
            for (var i = 0; i < 8; i++) {
                var pt = _projectPt(ps, corners[i][0], corners[i][1], corners[i][2]);
                if (pt.x < minSX) minSX = pt.x;
                if (pt.x > maxSX) maxSX = pt.x;
                if (pt.y < minSY) minSY = pt.y;
                if (pt.y > maxSY) maxSY = pt.y;
            }
            minSX -= padX; maxSX += padX;
            minSY -= padY; maxSY += padY;
            var rowStart = Math.max(0, Math.floor(minSY / cellH));
            var rowEnd   = Math.min(rows - 1, Math.ceil(maxSY / cellH));
            var colStart = Math.max(0, Math.floor(minSX / cellW));
            var colEnd   = Math.min(cols - 1, Math.ceil(maxSX / cellW));
            for (var row = rowStart; row <= rowEnd; row++) {
                for (var c = colStart; c <= colEnd; c++) {
                    mask[row * cols + c] = 1;
                }
            }
        }

        // ---- HAT SILHOUETTE ----
        if (char.hat && profile && profile.length >= 2) {
            var topY = profile[profile.length - 1][1];
            var hatExtra = 0, hatRadMul = 1.0;
            if (char.hat.type === 'cowboy') {
                hatExtra = 0.30; hatRadMul = 1.8;
            } else if (char.hat.type === 'baseballcap') {
                hatExtra = 0.20; hatRadMul = 1.3;
            } else if (char.hat.type === 'afro') {
                hatExtra = (char.hat.height || 0.50) + 0.10;
                hatRadMul = (char.hat.radiusX || 0.68) / 0.50 + 0.15;
            } else {
                hatExtra = 0.25; hatRadMul = 1.2;
            }
            // Extend mask upward from head top through hat region
            var hatTopY = (topY + hatExtra) * pulse;
            var hatBotY = (topY - 0.05) * pulse;  // overlap with head top
            var topR = _getProfileRadius(profile, topY) * pulse;
            var HAT_STEPS = 12;
            var hatSpans = [];
            for (var hs = 0; hs <= HAT_STEPS; hs++) {
                var localY = hatBotY + (hatTopY - hatBotY) * (hs / HAT_STEPS);
                // Hat radius: starts at head top radius, widens by hatRadMul
                var t01 = hs / HAT_STEPS;
                var hatR = topR * (1.0 + (hatRadMul - 1.0) * Math.min(1, t01 * 2));
                var minSX = Infinity, maxSX = -Infinity, screenY = 0;
                for (var rs = 0; rs < 8; rs++) {
                    var a = (rs / 8) * 6.2831853;
                    var pt = _projectPt(ps, hatR * Math.cos(a), localY, hatR * Math.sin(a));
                    if (pt.x < minSX) minSX = pt.x;
                    if (pt.x > maxSX) maxSX = pt.x;
                    screenY = pt.y;
                }
                hatSpans.push({ y: screenY, l: minSX - padX, r: maxSX + padX });
            }
            for (var row = 0; row < rows; row++) {
                var cy = row * cellH + cellH * 0.5;
                var spanL = -1, spanR = -1;
                for (var i = 0; i < hatSpans.length - 1; i++) {
                    var a = hatSpans[i], b = hatSpans[i + 1];
                    var minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
                    if (cy >= minY - padY && cy <= maxY + padY) {
                        var f = (maxY === minY) ? 0.5 : (cy - a.y) / (b.y - a.y);
                        f = Math.max(0, Math.min(1, f));
                        var iL = a.l + (b.l - a.l) * f;
                        var iR = a.r + (b.r - a.r) * f;
                        if (spanL < 0 || iL < spanL) spanL = iL;
                        if (spanR < 0 || iR > spanR) spanR = iR;
                    }
                }
                if (spanL >= 0 && spanR >= 0) {
                    var colStart = Math.max(0, Math.floor(spanL / cellW));
                    var colEnd = Math.min(cols - 1, Math.ceil(spanR / cellW));
                    for (var c = colStart; c <= colEnd; c++) {
                        mask[row * cols + c] = 1;
                    }
                }
            }
        }

        // ---- BODY SILHOUETTE ----
        var body = char.body;
        if (body && body.skeleton) {
            var skel = body.skeleton;
            var chinY = box ? -(box.h * pulse + 0.06) : -0.80;
            var neckPt = _projectPt(ps, 0, chinY, 0);
            var bOriginX = neckPt.x;
            var bOriginY = neckPt.y;
            var bScale = ps.scale * pulse * 0.52;

            // Project all skeleton joints to screen space
            var jScreen = {};
            for (var jn in skel) {
                var j = skel[jn];
                jScreen[jn] = {
                    x: bOriginX + j.x * bScale,
                    y: bOriginY + j.y * bScale
                };
            }

            // Build body outline polygon from key joints
            // Left side down, right side up — forms a closed polygon
            var outline = [];
            var jointOrder = [
                'neck', 'shoulderL', 'elbowL', 'handL',
                'hipL', 'kneeL', 'footL',
                'footR', 'kneeR', 'hipR',
                'handR', 'elbowR', 'shoulderR'
            ];
            for (var ji = 0; ji < jointOrder.length; ji++) {
                var jp = jScreen[jointOrder[ji]];
                if (jp) outline.push(jp);
            }

            if (outline.length >= 3) {
                // Find bounding box of body polygon for efficient row scanning
                var bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
                for (var i = 0; i < outline.length; i++) {
                    if (outline[i].x < bMinX) bMinX = outline[i].x;
                    if (outline[i].x > bMaxX) bMaxX = outline[i].x;
                    if (outline[i].y < bMinY) bMinY = outline[i].y;
                    if (outline[i].y > bMaxY) bMaxY = outline[i].y;
                }
                bMinX -= padX; bMaxX += padX;
                bMinY -= padY; bMaxY += padY;

                var rStart = Math.max(0, Math.floor(bMinY / cellH));
                var rEnd   = Math.min(rows - 1, Math.ceil(bMaxY / cellH));

                for (var row = rStart; row <= rEnd; row++) {
                    var cy = row * cellH + cellH * 0.5;
                    // Ray-cast to find x-intersections at this screen Y (with padding)
                    var xHits = [];
                    var n = outline.length;
                    for (var i = 0; i < n; i++) {
                        var a = outline[i], b = outline[(i + 1) % n];
                        var ay = a.y, by = b.y;
                        if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) {
                            var f = (cy - ay) / (by - ay);
                            xHits.push(a.x + (b.x - a.x) * f);
                        }
                    }
                    xHits.sort(function(a, b) { return a - b; });
                    // Fill pairs
                    for (var h = 0; h + 1 < xHits.length; h += 2) {
                        var colStart = Math.max(0, Math.floor((xHits[h] - padX) / cellW));
                        var colEnd   = Math.min(cols - 1, Math.ceil((xHits[h + 1] + padX) / cellW));
                        for (var c = colStart; c <= colEnd; c++) {
                            mask[row * cols + c] = 1;
                        }
                    }
                }
            }
        }

        return mask;
    }

    /* ================================================================
     *  COMPOSITE  →  ASCII CHARACTERS  (solid head + wireframe body)
     * ================================================================ */

    function compositeToAscii(bass, wireRGB, silhouetteMask) {
        if (!solidCtx || !asciiCtx || cols < 2 || rows < 2) return;

        // Source A: the volumetric solid render (head)
        var solidData;
        try { solidData = solidCtx.getImageData(0, 0, SOLID_W, SOLID_H); }
        catch (e) { return; }
        var sPx = solidData.data;

        // Source B: the wireframe canvas (body, hair, accessories, etc.)
        var wireData = captureWireframeGrid();
        var wPx = wireData ? wireData.data : null;

        var W = asciiCanvas.width, H = asciiCanvas.height;
        asciiCtx.clearRect(0, 0, W, H);
        asciiCtx.font = cellH + 'px monospace';
        asciiCtx.textBaseline = 'top';

        // Parse wire colour
        var rgb = wireRGB ? wireRGB.split(',') : ['51','255','51'];
        var bR  = parseInt(rgb[0]) || 51;
        var bG  = parseInt(rgb[1]) || 255;
        var bB  = parseInt(rgb[2]) || 51;

        // Audio-reactive tweaks
        var bassBoost = clamp01(bass * 1.5);
        var jitter    = bass > 0.65 ? (bass - 0.65) * 7 : 0;

        for (var row = 0; row < rows; row++) {
            var scanMul = (row & 1) ? SCANLINE_DIM : 1.0;

            for (var col = 0; col < cols; col++) {

                // --- Geometric mask: skip cells outside character silhouette ---
                if (silhouetteMask && !silhouetteMask[row * cols + col]) continue;

                // --- Source A: solid head luminance ---
                var solidLum = 0;
                var hsx = Math.floor(((col + 0.5) / cols) * SOLID_W);
                var hsy = Math.floor(((row + 0.5) / rows) * SOLID_H);
                if (hsx >= SOLID_W) hsx = SOLID_W - 1;
                if (hsy >= SOLID_H) hsy = SOLID_H - 1;
                var sPxIdx = (hsy * SOLID_W + hsx) * 4;
                // Use alpha to confirm renderer actually painted this pixel;
                // unpainted pixels are transparent after clearRect.
                solidLum = sPx[sPxIdx + 3] > 0 ? sPx[sPxIdx] : 0;

                // --- Source B: wireframe luminance (body / accessories) ---
                var wireLum = 0;
                var wireR = 0, wireG = 0, wireB = 0;
                if (wPx) {
                    var wi = (row * cols + col) * 4;
                    wireR = wPx[wi]; wireG = wPx[wi+1]; wireB = wPx[wi+2];
                    var wireA = wPx[wi+3];
                    wireLum = (0.299 * wireR + 0.587 * wireG + 0.114 * wireB) * (wireA / 255);
                }

                // --- Composite: blend solid head and wireframe ---
                // Wireframe wins when brighter (hair, eyelashes, visor, hats
                // are drawn ON TOP of the head and should keep their color)
                var lum, isHead;
                if (wireLum > 30 && wireLum > solidLum * 0.8) {
                    // Bright wireframe feature (hair, visor, hat, accessories)
                    lum = wireLum;
                    isHead = false;
                } else if (solidLum > 2) {
                    lum = solidLum;
                    isHead = true;
                } else if (wireLum > 8) {
                    lum = wireLum;
                    isHead = false;
                } else {
                    continue;   // empty cell
                }

                // Brightness 0-1
                var br = (lum / 255) * scanMul;

                // ASCII char
                var ci = Math.min(Math.floor(br * rampLen), rampLen - 1);
                var ch = ramp[ci];

                // Colour: head uses wireRGB × brightness; body preserves its wireframe colour
                var cr, cg, cb;
                if (isHead) {
                    cr = Math.min(255, Math.round(bR * br + bassBoost * 35 * br));
                    cg = Math.min(255, Math.round(bG * br + bassBoost * 18 * br));
                    cb = Math.min(255, Math.round(bB * br + bassBoost * 25 * br));
                } else {
                    // Use original wireframe pixel colour, amplified for ASCII density
                    var amp2 = Math.min(2.2, 0.8 + br * 1.4);
                    cr = Math.min(255, Math.round(wireR * amp2 + bassBoost * 20));
                    cg = Math.min(255, Math.round(wireG * amp2 + bassBoost * 12));
                    cb = Math.min(255, Math.round(wireB * amp2 + bassBoost * 15));
                }

                var alpha = mixValue * clamp01(br + 0.08);
                asciiCtx.fillStyle = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + alpha.toFixed(3) + ')';

                var dx = col * cellW + (jitter ? (Math.random() - 0.5) * jitter : 0);
                var dy = row * cellH + (jitter ? (Math.random() - 0.5) * jitter : 0);
                asciiCtx.fillText(ch, dx, dy);
            }
        }

        // Phosphor glow removed — strobe should only light actual surface
    }

    /* ================================================================
     *  PER-FRAME TICK
     * ================================================================ */

    function tick(bass, amp, beatDetector, activeChar, projState, mOpen) {
        if (!enabled || !asciiCanvas) return;

        // Beat-edge detection — triggers a strobe flash on top of the base
        if (beatDetector && beatDetector.beatCount !== lastBeatCount) {
            lastBeatCount = beatDetector.beatCount;
            triggerStrobe();
            // Alternate between base ramp and CP437 shader blocks each beat
            _useAltRamp = !_useAltRamp;
            ramp    = _useAltRamp ? _altRamp : _baseRamp;
            rampLen = ramp.length;
        }

        updateEnvelope();

        // Base mix: always show ASCII at BASE_MIX when enabled,
        // strobe envelope adds extra intensity on beats
        var BASE_MIX = 0.62;
        var strobeMix = mixValue;           // 0-1 from envelope
        mixValue = BASE_MIX + (1.0 - BASE_MIX) * strobeMix;

        // Guard: need character data
        if (!activeChar) return;

        // Clippy looks wrong in ASCII — skip
        if (activeChar.headShape === 'paperclip') {
            asciiCanvas.style.opacity = 0;
            if (wireCanvasRef) wireCanvasRef.style.opacity = 1;
            return;
        }

        // Build solid head faces for lathe/box head shapes;
        // wireframe-only shapes (metatronscube, paperclip) skip the solid pass
        // and get a pure wireframe→ASCII conversion instead.
        var hasSolid = false;
        if (activeChar.headShape === 'box' && activeChar.boxDims) {
            var faces = buildBoxFaces(activeChar.boxDims, projState);
            if (faces.length) {
                renderSolid(faces, projState);
                renderCavities(activeChar, projState, mOpen);
                hasSolid = true;
            }
        } else if (activeChar.profile && activeChar.ringN && projState) {
            var faces = buildLatheFaces(activeChar.profile, activeChar.ringN, projState);
            if (faces.length) {
                renderSolid(faces, projState);
                renderCavities(activeChar, projState, mOpen);
                hasSolid = true;

            }
        }

        if (!hasSolid) {
            // Clear solid buffer so composite only uses wireframe source
            solidCtx.clearRect(0, 0, SOLID_W, SOLID_H);
        }

        // Convert to ASCII (volumetric head where available + wireframe everywhere else)
        var silMask = buildSilhouetteMask(activeChar, projState);
        compositeToAscii(bass, activeChar.wireRGB, silMask);

        // Cross-fade: show ASCII, dim wireframe
        asciiCanvas.style.opacity = mixValue;
        if (wireCanvasRef) wireCanvasRef.style.opacity = 1 - mixValue * 0.35;
    }

    /* ================================================================
     *  PUBLIC API  (same interface as predecessor)
     * ================================================================ */

    function toggle() {
        enabled = !enabled;
        if (!enabled && asciiCanvas) {
            asciiCanvas.style.opacity = 0;
            if (wireCanvasRef) wireCanvasRef.style.opacity = 1;
            strobePhase = 'idle';
        }
        console.log('[ascii-strobe] ' + (enabled ? 'ON' : 'OFF') +
                    ' (' + PROFILE_NAMES[profileIdx] + ')');
        return enabled;
    }

    function setProfile(name) {
        var i = PROFILE_NAMES.indexOf(name);
        if (i >= 0) { profileIdx = i; profile = PROFILES[PROFILE_NAMES[i]]; }
    }

    function cycleProfile() {
        profileIdx = (profileIdx + 1) % PROFILE_NAMES.length;
        profile = PROFILES[PROFILE_NAMES[profileIdx]];
        console.log('[ascii-strobe] profile:', PROFILE_NAMES[profileIdx]);
        return PROFILE_NAMES[profileIdx];
    }

    function getProfile()  { return PROFILE_NAMES[profileIdx]; }
    function isEnabled()   { return enabled; }
    function getMix()      { return mixValue; }

    function setRamp(name) {
        if (name === 'clean')      { _baseRamp = RAMP_CLEAN; }
        else if (name === 'full')  { _baseRamp = RAMP_FULL; }
        else if (name === 'block') { _baseRamp = RAMP_BLOCK; }
        ramp    = _baseRamp;
        rampLen = ramp.length;
        _useAltRamp = false;
    }

    /* ── Export ──────────────────────────────────────────────── */
    window.asciiStrobe = {
        init:          init,
        destroy:       destroy,
        tick:          tick,
        toggle:        toggle,
        resize:        resize,
        isEnabled:     isEnabled,
        setProfile:    setProfile,
        cycleProfile:  cycleProfile,
        getProfile:    getProfile,
        getMix:        getMix,
        triggerStrobe: triggerStrobe,
        setRamp:       setRamp
    };

})();
