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

    var ramp    = RAMP_CLEAN;
    var rampLen = ramp.length;

    // Target ASCII grid size (cell px derived from canvas size)
    var TARGET_COLS = 110;

    // Offscreen solid-render resolution
    var SOLID_W = 480;
    var SOLID_H = 360;

    // Lighting (in camera / eye space)
    var LIGHT = (function () {
        var x = 0.30, y = -0.50, z = -0.90;
        var l = Math.sqrt(x * x + y * y + z * z);
        return { x: x / l, y: y / l, z: z / l };
    })();
    var AMBIENT          = 0.06;
    var DIFFUSE          = 0.68;
    var SPECULAR         = 0.38;
    var SPEC_POWER       = 5;
    var FRESNEL_STRENGTH = 0.30;
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
        bodyOffCtx = bodyOffscreen.getContext('2d');
        solidCanvas.width  = SOLID_W;
        solidCanvas.height = SOLID_H;
        solidCtx = solidCanvas.getContext('2d');

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
     *  COMPOSITE  →  ASCII CHARACTERS  (solid head + wireframe body)
     * ================================================================ */

    function compositeToAscii(bass, wireRGB) {
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

                // --- Source A: solid head luminance ---
                var solidLum = 0;
                var hsx = Math.floor(((col + 0.5) / cols) * SOLID_W);
                var hsy = Math.floor(((row + 0.5) / rows) * SOLID_H);
                if (hsx >= SOLID_W) hsx = SOLID_W - 1;
                if (hsy >= SOLID_H) hsy = SOLID_H - 1;
                solidLum = sPx[(hsy * SOLID_W + hsx) * 4]; // R channel (grayscale)

                // --- Source B: wireframe luminance (body / accessories) ---
                var wireLum = 0;
                var wireR = 0, wireG = 0, wireB = 0;
                if (wPx) {
                    var wi = (row * cols + col) * 4;
                    wireR = wPx[wi]; wireG = wPx[wi+1]; wireB = wPx[wi+2];
                    var wireA = wPx[wi+3];
                    wireLum = (0.299 * wireR + 0.587 * wireG + 0.114 * wireB) * (wireA / 255);
                }

                // --- Composite: solid head takes priority, wireframe fills the rest ---
                var lum, isHead;
                if (solidLum > 5) {
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

        // Phosphor glow
        if (mixValue > 0.25) {
            asciiCtx.save();
            asciiCtx.globalAlpha = 0.14 * mixValue;
            asciiCtx.filter = 'blur(3px)';
            asciiCtx.drawImage(asciiCanvas, 0, 0);
            asciiCtx.restore();
        }
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
        }

        updateEnvelope();

        // Base mix: always show ASCII at BASE_MIX when enabled,
        // strobe envelope adds extra intensity on beats
        var BASE_MIX = 0.92;
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
        compositeToAscii(bass, activeChar.wireRGB);

        // Cross-fade: show ASCII, dim wireframe
        asciiCanvas.style.opacity = mixValue;
        if (wireCanvasRef) wireCanvasRef.style.opacity = 1 - mixValue * 0.75;
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
        if (name === 'clean')      { ramp = RAMP_CLEAN; }
        else if (name === 'full')  { ramp = RAMP_FULL; }
        else if (name === 'block') { ramp = RAMP_BLOCK; }
        rampLen = ramp.length;
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
