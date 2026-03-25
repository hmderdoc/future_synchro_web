/* visualizer.js - Advanced Radio Visualizer
 *
 * Layered architecture:
 *   Layer 0: Butterchurn MilkDrop (WebGL canvas) - audio-reactive background
 *   Layer 1: Wireframe head (2D canvas overlay) - Vectrex-style phosphor glow
 *   Layer 2: Lyrics display (DOM overlay) - synced to .lrc or amplitude fallback
 *
 * Dependencies: butterchurn.min.js, butterchurnPresets.min.js (vendored in /lib/)
 * Communicates with radio.js via window.sbbsRadio + custom events.
 */
(function () {
    'use strict';

    // --- State ---
    var isOpen        = false;
    var animRAF       = null;
    var bcViz         = null;   // Butterchurn visualizer instance
    var presetKeys    = [];
    var presetIndex   = 0;
    var presetTimer   = null;
    var presetMap     = null;   // cached preset map from getPresets()

    // Canvas refs
    var milkCanvas    = null;   // Butterchurn WebGL
    var wireCanvas    = null;   // Wireframe overlay (2D)
    var wireCtx       = null;

    // Lyrics state
    var lrcLines      = [];     // [{time: seconds, text: ''}, ...]
    var lrcIndex      = -1;
    var trackFile     = '';

    // Head animation
    var headRotY      = 0;
    var headRotX      = 0.18;   // slight downward tilt
    var mouthOpen     = 0;      // 0-1 smoothed
    var eyeGlow       = 0;      // 0-1 smoothed
    var breathPhase   = 0;      // slow breathing cycle

    // DOM refs
    var elPanel, elLyrics, elClose;

    // --- Head geometry ------------------------------------------------
    // Skull profile: [radius, y] (unit scale, y+ = up)
    var PROFILE = [
        [0.00, -0.80], [0.22, -0.70], [0.38, -0.58],
        [0.48, -0.42], [0.52, -0.25], [0.50, -0.08],
        [0.46,  0.08], [0.44,  0.22], [0.42,  0.36],
        [0.37,  0.48], [0.28,  0.58], [0.15,  0.65],
        [0.00,  0.68]
    ];
    var RING_N = 16;  // segments per horizontal ring

    // Eyes: center (x,y,z) + radius
    var L_EYE = { x: -0.18, y: -0.05, z: 0.45, r: 0.08 };
    var R_EYE = { x:  0.18, y: -0.05, z: 0.45, r: 0.08 };

    // Mouth
    var MOUTH_Y = -0.52;
    var MOUTH_HW = 0.25;   // half-width
    var MOUTH_Z  = 0.48;
    var MOUTH_SEGS = 8;

    // Colors
    var GREEN     = '#33FF33';
    var AMBER     = '#FFAA00';
    var GREEN_RGB = '51,255,51';
    var AMBER_RGB = '255,170,0';

    // =========================================================
    //  Init
    // =========================================================
    function init() {
        elPanel = document.getElementById('viz-panel');
        if (!elPanel) return;

        elClose = elPanel.querySelector('.viz-close');
        if (elClose) {
            elClose.addEventListener('click', function (e) {
                e.stopPropagation();
                hide();
            });
        }

        elLyrics = elPanel.querySelector('.viz-lyrics');

        // Wire #radio-viz click to toggle
        var radioViz = document.getElementById('radio-viz');
        if (radioViz) {
            radioViz.addEventListener('click', function (e) {
                e.stopPropagation();
                toggle();
            });
            radioViz.style.cursor = 'pointer';
            radioViz.title = 'Click to open visualizer';
        }

        // Listen for track changes from radio.js
        document.addEventListener('radio:trackchange', onTrackChange);

        console.log('[viz] initialized');
    }

    // =========================================================
    //  Panel lifecycle
    // =========================================================
    function show() {
        if (isOpen) return;
        isOpen = true;

        // Close terminal if open
        if (window.sbbsTerminal && window.sbbsTerminal.hide) {
            window.sbbsTerminal.hide();
        }

        var h = getNavH();
        elPanel.style.paddingTop = h + 'px';
        elPanel.classList.remove('is-hidden');
        elPanel.setAttribute('aria-hidden', 'false');
        document.body.classList.add('viz-open');

        setupCanvases();
        initButterchurn();
        startAnim();
        fetchLyrics();

        console.log('[viz] opened');
    }

    function hide() {
        if (!isOpen) return;
        isOpen = false;

        stopAnim();
        elPanel.classList.add('is-hidden');
        elPanel.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('viz-open');

        bcViz = null;
        if (presetTimer) { clearInterval(presetTimer); presetTimer = null; }

        console.log('[viz] closed');
    }

    function toggle() { isOpen ? hide() : show(); }

    function getNavH() {
        var n = document.querySelector('.navbar.fixed-top');
        return n ? n.offsetHeight : 56;
    }

    // =========================================================
    //  Canvas setup
    // =========================================================
    function setupCanvases() {
        var box = elPanel.querySelector('.viz-canvas-container');
        if (!box) return;

        milkCanvas = box.querySelector('#viz-milkdrop');
        if (!milkCanvas) {
            milkCanvas = document.createElement('canvas');
            milkCanvas.id = 'viz-milkdrop';
            milkCanvas.className = 'viz-layer';
            box.appendChild(milkCanvas);
        }

        wireCanvas = box.querySelector('#viz-wireframe');
        if (!wireCanvas) {
            wireCanvas = document.createElement('canvas');
            wireCanvas.id = 'viz-wireframe';
            wireCanvas.className = 'viz-layer';
            box.appendChild(wireCanvas);
        }
        wireCtx = wireCanvas.getContext('2d');

        sizeCanvases();

        if (window.ResizeObserver) {
            new ResizeObserver(sizeCanvases).observe(box);
        }
    }

    function sizeCanvases() {
        var box = elPanel.querySelector('.viz-canvas-container');
        if (!box) return;
        var w = box.clientWidth, h = box.clientHeight;
        if (w < 1 || h < 1) return;

        [milkCanvas, wireCanvas].forEach(function (c) {
            if (c) { c.width = w; c.height = h; }
        });

        if (bcViz) bcViz.setRendererSize(w, h);
    }

    // =========================================================
    //  Butterchurn (MilkDrop)
    // =========================================================
    function initButterchurn() {
        if (!window.butterchurn || !milkCanvas) return;

        var radio = window.sbbsRadio;
        if (!radio || !radio.audioCtx) {
            console.warn('[viz] no audio context yet');
            return;
        }

        try {
            // v3 UMD: createVisualizer is on window.butterchurn directly
            // v2 UMD: createVisualizer is on window.butterchurn.default
            var BC = (typeof window.butterchurn.createVisualizer === 'function')
                   ? window.butterchurn
                   : window.butterchurn.default;
            if (!BC || !BC.createVisualizer) {
                console.error('[viz] butterchurn.createVisualizer not found');
                return;
            }

            bcViz = BC.createVisualizer(
                radio.audioCtx, milkCanvas,
                {
                    width: milkCanvas.width,
                    height: milkCanvas.height,
                    meshWidth: 32,
                    meshHeight: 24,
                    pixelRatio: window.devicePixelRatio || 1
                }
            );

            bcViz.connectAudio(radio.analyserNode || radio.gainNode);

            // Load presets (handle both v2 and v3 export styles)
            if (window.butterchurnPresets) {
                var BP = window.butterchurnPresets;
                if (typeof BP.getPresets !== 'function' && BP.default) {
                    BP = BP.default;
                }
                if (typeof BP.getPresets === 'function') {
                    presetMap = BP.getPresets();
                    presetKeys = Object.keys(presetMap);
                }
                if (presetKeys.length) {
                    presetIndex = Math.floor(Math.random() * presetKeys.length);
                    bcViz.loadPreset(presetMap[presetKeys[presetIndex]], 0);
                    console.log('[viz] butterchurn loaded ' + presetKeys.length + ' presets');
                    console.log('[viz] preset:', presetKeys[presetIndex]);
                    presetTimer = setInterval(cyclePreset,
                        25000 + Math.random() * 15000);
                }
            }
            console.log('[viz] butterchurn ready (v' + (BC === window.butterchurn ? '3' : '2') + ')');
        } catch (e) {
            console.error('[viz] butterchurn init failed:', e);
        }
    }

    function cyclePreset() {
        if (!bcViz || !presetKeys.length || !presetMap) return;
        presetIndex = Math.floor(Math.random() * presetKeys.length);
        bcViz.loadPreset(presetMap[presetKeys[presetIndex]], 2.0);
    }

    // =========================================================
    //  Animation loop
    // =========================================================
    function startAnim() { if (!animRAF) tick(); }
    function stopAnim()  {
        if (animRAF) { cancelAnimationFrame(animRAF); animRAF = null; }
    }

    function tick() {
        animRAF = requestAnimationFrame(tick);

        var radio = window.sbbsRadio;
        var amp = 0, bass = 0;

        if (radio && radio.analyserNode) {
            var bins = radio.analyserNode.frequencyBinCount;
            var data = new Uint8Array(bins);
            radio.analyserNode.getByteFrequencyData(data);

            var sum = 0;
            for (var i = 0; i < bins; i++) sum += data[i];
            amp = sum / (bins * 255);

            var bc = Math.max(1, bins >> 2);
            var bs = 0;
            for (var j = 0; j < bc; j++) bs += data[j];
            bass = bs / (bc * 255);
        }

        if (bcViz) bcViz.render();
        drawHead(amp, bass);
        syncLyrics();
    }

    // =========================================================
    //  Wireframe Head Renderer
    // =========================================================
    function drawHead(amp, bass) {
        if (!wireCtx || !wireCanvas) return;
        var W = wireCanvas.width, H = wireCanvas.height;
        wireCtx.clearRect(0, 0, W, H);

        var cx = W / 2;
        var cy = H * 0.42;                          // above center for lyrics
        var scale = Math.min(W, H) * 0.3;

        headRotY += 0.007;
        breathPhase += 0.02;

        // Smooth mouth & eye glow
        mouthOpen += (Math.min(amp * 1.8, 1) - mouthOpen) * 0.25;
        eyeGlow   += (Math.min(bass * 2, 1) - eyeGlow) * 0.2;

        var pulse = 1 + bass * 0.06 + Math.sin(breathPhase) * 0.01;
        var S = scale * pulse;

        var cosY = Math.cos(headRotY), sinY = Math.sin(headRotY);
        var cosX = Math.cos(headRotX), sinX = Math.sin(headRotX);
        var FL   = 4.0;

        function proj(x, y, z) {
            var rx  = x * cosY - z * sinY;
            var rz  = x * sinY + z * cosY;
            var ry2 = y * cosX - rz * sinX;
            var rz2 = y * sinX + rz * cosX;
            var d   = FL / (FL + rz2);
            return { x: cx + rx * S * d, y: cy - ry2 * S * d, d: d };
        }

        // Generate rings
        var rings = [];
        for (var p = 0; p < PROFILE.length; p++) {
            var ring = [];
            var rad = PROFILE[p][0], yy = PROFILE[p][1];
            for (var s = 0; s < RING_N; s++) {
                var a = (s / RING_N) * Math.PI * 2;
                ring.push(proj(rad * Math.cos(a), yy, rad * Math.sin(a)));
            }
            rings.push(ring);
        }

        wireCtx.lineCap = wireCtx.lineJoin = 'round';

        // --- Horizontal rings ---
        wireCtx.shadowBlur  = 8 + bass * 14;
        wireCtx.shadowColor = GREEN;
        wireCtx.strokeStyle = 'rgba(' + GREEN_RGB + ',0.55)';
        wireCtx.lineWidth   = 1.2;

        for (var r = 0; r < rings.length; r++) {
            wireCtx.beginPath();
            for (var i = 0; i < rings[r].length; i++) {
                var pt = rings[r][i];
                i === 0 ? wireCtx.moveTo(pt.x, pt.y) : wireCtx.lineTo(pt.x, pt.y);
            }
            wireCtx.closePath();
            wireCtx.stroke();
        }

        // --- Vertical ribs ---
        wireCtx.strokeStyle = 'rgba(' + GREEN_RGB + ',0.30)';
        wireCtx.lineWidth   = 0.8;
        for (var s = 0; s < RING_N; s += 2) {
            wireCtx.beginPath();
            for (var r = 0; r < rings.length; r++) {
                var pt = rings[r][s];
                r === 0 ? wireCtx.moveTo(pt.x, pt.y) : wireCtx.lineTo(pt.x, pt.y);
            }
            wireCtx.stroke();
        }

        // --- Eyes ---
        drawEye(L_EYE, proj);
        drawEye(R_EYE, proj);

        // --- Nose ---
        drawNose(proj);

        // --- Mouth ---
        drawMouth(proj);
    }

    function drawEye(eye, proj) {
        var segs = 12, pts = [];
        for (var i = 0; i <= segs; i++) {
            var a  = (i / segs) * Math.PI * 2;
            pts.push(proj(
                eye.x + eye.r * Math.cos(a),
                eye.y + eye.r * Math.sin(a) * 0.7,
                eye.z
            ));
        }

        var gl = Math.floor(180 + eyeGlow * 75);
        wireCtx.shadowBlur  = 10 + eyeGlow * 16;
        wireCtx.shadowColor = GREEN;
        wireCtx.strokeStyle = 'rgba(' + gl + ',255,' + gl + ',' + (0.7 + eyeGlow * 0.3) + ')';
        wireCtx.lineWidth   = 1.5 + eyeGlow;

        wireCtx.beginPath();
        for (var i = 0; i < pts.length; i++) {
            i === 0 ? wireCtx.moveTo(pts[i].x, pts[i].y) : wireCtx.lineTo(pts[i].x, pts[i].y);
        }
        wireCtx.stroke();

        // Pupil dot
        var c = proj(eye.x, eye.y, eye.z);
        wireCtx.beginPath();
        wireCtx.arc(c.x, c.y, 2 + eyeGlow * 3, 0, Math.PI * 2);
        wireCtx.fillStyle = 'rgba(' + gl + ',255,' + gl + ',' + (0.5 + eyeGlow * 0.5) + ')';
        wireCtx.fill();
    }

    function drawNose(proj) {
        wireCtx.shadowBlur  = 5;
        wireCtx.shadowColor = GREEN;
        wireCtx.strokeStyle = 'rgba(' + GREEN_RGB + ',0.35)';
        wireCtx.lineWidth   = 1;

        var a = proj(0, -0.15, 0.53);
        var b = proj(0, -0.30, 0.57);
        var c = proj(0, -0.34, 0.58);
        var d = proj(-0.06, -0.36, 0.52);
        var e = proj( 0.06, -0.36, 0.52);

        wireCtx.beginPath(); wireCtx.moveTo(a.x,a.y); wireCtx.lineTo(b.x,b.y); wireCtx.lineTo(c.x,c.y); wireCtx.stroke();
        wireCtx.beginPath(); wireCtx.moveTo(d.x,d.y); wireCtx.lineTo(c.x,c.y); wireCtx.lineTo(e.x,e.y); wireCtx.stroke();
    }

    function drawMouth(proj) {
        var open = mouthOpen * 0.09;
        var upper = [], lower = [];

        for (var i = 0; i <= MOUTH_SEGS; i++) {
            var t    = (i / MOUTH_SEGS) * 2 - 1;  // -1…1
            var curv = 1 - t * t;                   // parabola
            var xp   = t * MOUTH_HW;
            upper.push(proj(xp, MOUTH_Y + open * curv + 0.01 * curv, MOUTH_Z));
            lower.push(proj(xp, MOUTH_Y - open * curv - 0.01 * curv, MOUTH_Z));
        }

        wireCtx.shadowBlur  = 6 + mouthOpen * 16;
        wireCtx.shadowColor = AMBER;
        wireCtx.strokeStyle = 'rgba(' + AMBER_RGB + ',' + (0.6 + mouthOpen * 0.4) + ')';
        wireCtx.lineWidth   = 1.5 + mouthOpen;

        stroke(upper);
        stroke(lower);

        // Inner glow when wide open
        if (mouthOpen > 0.3) {
            wireCtx.strokeStyle = 'rgba(255,200,50,' + ((mouthOpen - 0.3) * 0.6) + ')';
            wireCtx.lineWidth = 0.5;
            for (var row = 1; row <= 2; row++) {
                var frac = row / 3;
                var inner = [];
                for (var i = 0; i <= MOUTH_SEGS; i++) {
                    var t    = (i / MOUTH_SEGS) * 2 - 1;
                    var curv = 1 - t * t;
                    inner.push(proj(t * MOUTH_HW * 0.85,
                        MOUTH_Y + open * curv * frac, MOUTH_Z));
                }
                stroke(inner);
            }
        }
    }

    function stroke(pts) {
        wireCtx.beginPath();
        for (var i = 0; i < pts.length; i++) {
            i === 0 ? wireCtx.moveTo(pts[i].x, pts[i].y) : wireCtx.lineTo(pts[i].x, pts[i].y);
        }
        wireCtx.stroke();
    }

    // =========================================================
    //  LRC Lyrics
    // =========================================================
    function onTrackChange(e) {
        var d = e.detail || {};
        trackFile = d.filename || '';
        lrcLines  = [];
        lrcIndex  = -1;
        if (elLyrics) elLyrics.textContent = '';
        if (isOpen) fetchLyrics();
    }

    function fetchLyrics() {
        if (!trackFile) {
            var r = window.sbbsRadio;
            if (r && r.currentTrackFile) trackFile = r.currentTrackFile;
        }
        if (!trackFile) return;

        var lrcName = trackFile.replace(/\.mp3$/i, '.lrc');
        fetch('./radio-stream/' + encodeURIComponent(lrcName))
            .then(function (r) { if (!r.ok) throw 0; return r.text(); })
            .then(function (txt) {
                lrcLines = parseLRC(txt);
                lrcIndex = -1;
                console.log('[viz] loaded ' + lrcLines.length + ' lyric lines');
            })
            .catch(function () {
                lrcLines = [];
                lrcIndex = -1;
            });
    }

    function parseLRC(text) {
        var result = [];
        var re = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/;
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var m = re.exec(lines[i]);
            if (m) {
                var t = parseInt(m[1],10) * 60 + parseInt(m[2],10)
                      + (m[3] ? parseInt(m[3].padEnd(3,'0'),10) / 1000 : 0);
                var txt = lines[i].replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g,'').trim();
                if (txt) result.push({ time: t, text: txt });
            }
        }
        return result.sort(function (a, b) { return a.time - b.time; });
    }

    function syncLyrics() {
        if (!elLyrics) return;
        var r = window.sbbsRadio;
        if (!r || !r.audioEl) return;
        if (!lrcLines.length) return;

        var now = r.audioEl.currentTime;
        var ni  = -1;
        for (var i = lrcLines.length - 1; i >= 0; i--) {
            if (now >= lrcLines[i].time) { ni = i; break; }
        }
        if (ni !== lrcIndex) {
            lrcIndex = ni;
            if (ni >= 0) {
                elLyrics.textContent = lrcLines[ni].text;
                elLyrics.classList.remove('viz-lyric-flash');
                void elLyrics.offsetWidth;              // reflow trigger
                elLyrics.classList.add('viz-lyric-flash');
            } else {
                elLyrics.textContent = '';
            }
        }
    }

    // =========================================================
    //  Public API
    // =========================================================
    window.sbbsVisualizer = { show: show, hide: hide, toggle: toggle };

    // =========================================================
    //  Boot
    // =========================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
