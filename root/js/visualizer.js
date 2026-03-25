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

    // Karaoke system state
    var karaokeCanvas = null;
    var karaokeCtx    = null;
    var songColorIdx  = 0;
    var songFontIdx   = 0;
    var ballX         = 0;
    var ballTrail     = [];     // [{x, y, alpha}, ...] phosphor trail
    var wordPositions = [];     // [{x, width, word}, ...] for current line

    // CGA-inspired color schemes (fg, highlight, glow)
    var LYRIC_SCHEMES = [
        { fg: '#55FFFF', hi: '#FFFFFF', glow: '#00AAAA' }, // cyan
        { fg: '#FFFF55', hi: '#FFFFFF', glow: '#AA5500' }, // yellow
        { fg: '#FF55FF', hi: '#FFFFFF', glow: '#AA00AA' }, // magenta
        { fg: '#55FF55', hi: '#FFFFFF', glow: '#00AA00' }, // green
        { fg: '#FFAA00', hi: '#FFFF55', glow: '#AA5500' }, // amber
        { fg: '#FF5555', hi: '#FFFFFF', glow: '#AA0000' }, // red
    ];

    // Retro fonts (Spleen is local, others via Google Fonts)
    var LYRIC_FONTS = [
        '"Spleen", "Courier New", monospace',
        '"VT323", "Courier New", monospace',
        '"Press Start 2P", "Courier New", monospace',
    ];

    // Karaoke system state
    var karaokeCanvas = null;
    var karaokeCtx    = null;
    var songColorIdx  = 0;
    var songFontIdx   = 0;
    var ballX         = 0;
    var ballTrail     = [];     // [{x, y, alpha}, ...] phosphor trail
    var wordPositions = [];     // [{x, width, word}, ...] for current line

    // CGA-inspired color schemes (fg, highlight, glow)
    var LYRIC_SCHEMES = [
        { fg: '#55FFFF', hi: '#FFFFFF', glow: '#00AAAA' }, // cyan
        { fg: '#FFFF55', hi: '#FFFFFF', glow: '#AA5500' }, // yellow
        { fg: '#FF55FF', hi: '#FFFFFF', glow: '#AA00AA' }, // magenta
        { fg: '#55FF55', hi: '#FFFFFF', glow: '#00AA00' }, // green
        { fg: '#FFAA00', hi: '#FFFF55', glow: '#AA5500' }, // amber
        { fg: '#FF5555', hi: '#FFFFFF', glow: '#AA0000' }, // red
    ];

    // Retro fonts (Spleen is local, others via Google Fonts)
    var LYRIC_FONTS = [
        '"Spleen", "Courier New", monospace',
        '"VT323", "Courier New", monospace',
        '"Press Start 2P", "Courier New", monospace',
    ];

    // Head animation
    var headRotY      = 0;
    var headRotX      = 0.18;   // slight downward tilt
    var mouthOpen     = 0;      // 0-1 smoothed
    var eyeGlow       = 0;      // 0-1 smoothed
    var breathPhase   = 0;      // slow breathing cycle

    // Lyric display modes
    var LYRIC_MODE_BOUNCING = 0;
    var LYRIC_MODE_SPITTING = 1;
    var lyricMode = LYRIC_MODE_SPITTING;  // default mode

    // Spitting lyrics particle system
    var spitParticles = [];  // [{text, x, y, z, vx, vy, vz, spawnTime, alpha, scale}]
    var lastSpitWord = -1;   // index of last word spit out
    var spitLineIdx = -1;    // current line being spit

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

        // Mobile visualizer toggle button
        var btnVizMobile = document.getElementById('btn-viz-mobile');
        if (btnVizMobile) {
            btnVizMobile.addEventListener('click', function(e) {
                e.stopPropagation();
                toggle();
            });
        }

        // Listen for track changes from radio.js
        document.addEventListener('radio:trackchange', onTrackChange);

        // Keyboard shortcut: 'L' to toggle lyric mode when viz is open
        document.addEventListener('keydown', function(e) {
            if (!isOpen) return;
            if (e.key === 'l' || e.key === 'L') {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                e.preventDefault();
                toggleLyricMode();
            }
        });

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
        // Retry Butterchurn init if audioCtx not ready yet
        if (!initButterchurn()) { scheduleButterchurnRetry(); }
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

    function showWebGLWarning() {
        // Show a subtle warning about WebGL being disabled
        var existing = elPanel.querySelector('.viz-webgl-notice');
        if (existing) return;

        var notice = document.createElement('div');
        notice.className = 'viz-webgl-notice';
        notice.innerHTML = 
            '<div class="viz-notice-content">' +
            '<span class="viz-notice-icon">⚡</span>' +
            '<span class="viz-notice-text">MilkDrop effects require WebGL</span>' +
            '<a href="https://enable-webgl.com/" target="_blank" rel="noopener" class="viz-notice-link">Enable WebGL →</a>' +
            '<button class="viz-notice-close" title="Dismiss">×</button>' +
            '</div>';
        
        notice.querySelector('.viz-notice-close').addEventListener('click', function() {
            notice.remove();
        });

        // Auto-dismiss after 8 seconds
        setTimeout(function() {
            if (notice.parentNode) {
                notice.style.opacity = '0';
                setTimeout(function() { notice.remove(); }, 300);
            }
        }, 8000);

        elPanel.appendChild(notice);
    }

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

        // Always create fresh canvas to ensure clean WebGL context
        var oldMilk = box.querySelector('#viz-milkdrop');
        if (oldMilk) oldMilk.remove();
        milkCanvas = document.createElement('canvas');
        milkCanvas.id = 'viz-milkdrop';
        milkCanvas.className = 'viz-layer';
        box.appendChild(milkCanvas);

        wireCanvas = box.querySelector('#viz-wireframe');
        if (!wireCanvas) {
            wireCanvas = document.createElement('canvas');
            wireCanvas.id = 'viz-wireframe';
            wireCanvas.className = 'viz-layer';
            box.appendChild(wireCanvas);
        }
        wireCtx = wireCanvas.getContext('2d');

        // Karaoke lyrics canvas (topmost layer)
        var oldKaraoke = box.querySelector('#viz-karaoke');
        if (oldKaraoke) oldKaraoke.remove();
        karaokeCanvas = document.createElement('canvas');
        karaokeCanvas.id = 'viz-karaoke';
        karaokeCanvas.className = 'viz-layer';
        box.appendChild(karaokeCanvas);
        karaokeCtx = karaokeCanvas.getContext('2d');

        // Karaoke lyrics canvas (topmost layer)
        var oldKaraoke = box.querySelector('#viz-karaoke');
        if (oldKaraoke) oldKaraoke.remove();
        karaokeCanvas = document.createElement('canvas');
        karaokeCanvas.id = 'viz-karaoke';
        karaokeCanvas.className = 'viz-layer';
        box.appendChild(karaokeCanvas);
        karaokeCtx = karaokeCanvas.getContext('2d');

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

        [milkCanvas, wireCanvas, karaokeCanvas].forEach(function (c) {
            if (c) { c.width = w; c.height = h; }
        });

        if (bcViz) bcViz.setRendererSize(w, h);
    }

    // =========================================================
    //  Butterchurn (MilkDrop)
    // =========================================================
    var bcRetryTimer = null;

    function scheduleButterchurnRetry() {
        if (bcRetryTimer) return;
        bcRetryTimer = setInterval(function() {
            if (!isOpen) { clearInterval(bcRetryTimer); bcRetryTimer = null; return; }
            if (initButterchurn()) { clearInterval(bcRetryTimer); bcRetryTimer = null; }
        }, 250);
    }

    function initButterchurn() {
        if (!window.butterchurn || !milkCanvas) return false;

        var radio = window.sbbsRadio;
        if (!radio || !radio.audioCtx) {
            console.warn('[viz] no audio context yet - will retry');
            return false;
        }

        // Check WebGL availability
        var testCtx = milkCanvas.getContext("webgl2");
        if (!testCtx) {
            console.warn("[viz] WebGL2 not available");
            showWebGLWarning();
            return false;
        }
        try {
            // v3 UMD: createVisualizer is on window.butterchurn directly
            // v2 UMD: createVisualizer is on window.butterchurn.default
            var BC = (typeof window.butterchurn.createVisualizer === 'function')
                   ? window.butterchurn
                   : window.butterchurn.default;
            if (!BC || !BC.createVisualizer) {
                console.error('[viz] butterchurn.createVisualizer not found'); return false;
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
            return true;
        } catch (e) {
            console.error('[viz] butterchurn init failed:', e);
            return false;
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
        if (lyricMode === LYRIC_MODE_SPITTING) {
            syncLyricsSpitting();
        } else {
            syncLyrics();
        }
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
        // Bouncing ball karaoke system
        if (!karaokeCtx || !karaokeCanvas) return;
        var r = window.sbbsRadio;
        if (!r || !r.audioEl) return;

        var w = karaokeCanvas.width;
        var h = karaokeCanvas.height;
        var now = r.audioEl.currentTime;

        // Clear with transparency
        karaokeCtx.clearRect(0, 0, w, h);

        if (!lrcLines.length) return;

        // Find current and next line
        var ni = -1;
        var nextLineTime = Infinity;
        for (var i = lrcLines.length - 1; i >= 0; i--) {
            if (now >= lrcLines[i].time) {
                ni = i;
                if (i + 1 < lrcLines.length) nextLineTime = lrcLines[i + 1].time;
                break;
            }
        }

        // Track changes trigger new color/font for song
        if (ni !== lrcIndex) {
            lrcIndex = ni;
            // Pick new color and font for EACH line
            songColorIdx = Math.floor(Math.random() * LYRIC_SCHEMES.length);
            songFontIdx = Math.floor(Math.random() * LYRIC_FONTS.length);
            if (ni === 0) {
                // New song started - pick new color and font
                songColorIdx = Math.floor(Math.random() * LYRIC_SCHEMES.length);
                songFontIdx = Math.floor(Math.random() * LYRIC_FONTS.length);
            }
            // Reset word positions for new line
            wordPositions = [];
            ballTrail = [];
        }

        if (ni < 0) return;

        var line = lrcLines[ni];
        var scheme = LYRIC_SCHEMES[songColorIdx % LYRIC_SCHEMES.length];
        var fontFamily = LYRIC_FONTS[songFontIdx % LYRIC_FONTS.length];

        // Responsive font sizing
        var baseFontSize = Math.min(48, Math.max(24, h * 0.06));
        var testFont = baseFontSize + 'px ' + fontFamily;
        karaokeCtx.font = testFont;
        var textWidth = karaokeCtx.measureText(line.text).width;
        var maxWidth = w * 0.85;
        if (textWidth > maxWidth) {
            baseFontSize = baseFontSize * (maxWidth / textWidth);
        }
        baseFontSize = Math.max(16, baseFontSize);

        var font = Math.round(baseFontSize) + 'px ' + fontFamily;
        karaokeCtx.font = font;
        karaokeCtx.textAlign = 'left';
        karaokeCtx.textBaseline = 'middle';

        // Calculate word positions if not done
        var words = line.text.split(/\s+/);
        if (wordPositions.length !== words.length) {
            wordPositions = [];
            var totalWidth = karaokeCtx.measureText(line.text).width;
            var startX = (w - totalWidth) / 2;
            var currentX = startX;
            for (var j = 0; j < words.length; j++) {
                var wordW = karaokeCtx.measureText(words[j]).width;
                var spaceW = karaokeCtx.measureText(' ').width;
                wordPositions.push({ x: currentX, width: wordW, word: words[j] });
                currentX += wordW + spaceW;
            }
        }

        // Calculate progress through current line (0-1)
        var lineStart = line.time;
        var lineDuration = nextLineTime - lineStart;
        if (lineDuration > 30) lineDuration = 4; // cap for last line
        var progress = Math.min(1, (now - lineStart) / lineDuration);

        // Find which word we're on
        var wordIdx = Math.floor(progress * words.length);
        wordIdx = Math.min(wordIdx, words.length - 1);

        // Ball position (bouncing arc over current word)
        var ly = h * 0.92;  // lyrics Y position
        var ballBaseY = ly - baseFontSize * 0.8;
        var currentWord = wordPositions[wordIdx];
        if (currentWord) {
            // Progress within this word
            var wordProgress = (progress * words.length) - wordIdx;
            var targetX = currentWord.x + currentWord.width * wordProgress;
            
            // Smooth ball movement
            ballX += (targetX - ballX) * 0.15;
            
            // Bouncing motion
            var bouncePhase = wordProgress * Math.PI;
            var bounceHeight = Math.sin(bouncePhase) * baseFontSize * 0.6;
            var ballY = ballBaseY - bounceHeight;

            // Add to trail
            ballTrail.push({ x: ballX, y: ballY, alpha: 1.0 });
            if (ballTrail.length > 12) ballTrail.shift();

            // Draw phosphor trail
            for (var t = 0; t < ballTrail.length; t++) {
                var trail = ballTrail[t];
                trail.alpha *= 0.75;  // fade
                if (trail.alpha > 0.05) {
                    karaokeCtx.beginPath();
                    karaokeCtx.arc(trail.x, trail.y, 6 * trail.alpha, 0, Math.PI * 2);
                    karaokeCtx.fillStyle = scheme.glow;
                    karaokeCtx.globalAlpha = trail.alpha * 0.5;
                    karaokeCtx.fill();
                }
            }
            karaokeCtx.globalAlpha = 1;

            // Draw main ball with glow
            karaokeCtx.shadowColor = scheme.hi;
            karaokeCtx.shadowBlur = 15;
            karaokeCtx.beginPath();
            karaokeCtx.arc(ballX, ballY, 8, 0, Math.PI * 2);
            karaokeCtx.fillStyle = scheme.hi;
            karaokeCtx.fill();
            karaokeCtx.shadowBlur = 0;
        }

        // Draw lyrics with highlighting
        karaokeCtx.shadowColor = scheme.glow;
        karaokeCtx.shadowBlur = 12;
        
        for (var k = 0; k < wordPositions.length; k++) {
            var wp = wordPositions[k];
            // Highlight words up to and including current
            if (k <= wordIdx) {
                karaokeCtx.fillStyle = scheme.hi;
            } else {
                karaokeCtx.fillStyle = scheme.fg;
            }
            karaokeCtx.fillText(wp.word, wp.x, ly);
        }
        karaokeCtx.shadowBlur = 0;
    }


    // =========================================================
    //  Spitting Lyrics Mode - Words fly from mouth in 3D
    // =========================================================
    function syncLyricsSpitting() {
        if (!karaokeCtx || !karaokeCanvas) return;
        var r = window.sbbsRadio;
        if (!r || !r.audioEl) return;

        var w = karaokeCanvas.width;
        var h = karaokeCanvas.height;
        var now = r.audioEl.currentTime;

        karaokeCtx.clearRect(0, 0, w, h);

        if (!lrcLines.length) return;

        // Find current line
        var ni = -1;
        var nextLineTime = Infinity;
        for (var i = lrcLines.length - 1; i >= 0; i--) {
            if (now >= lrcLines[i].time) {
                ni = i;
                if (i + 1 < lrcLines.length) nextLineTime = lrcLines[i + 1].time;
                break;
            }
        }

        // New line or song?
        if (ni !== spitLineIdx) {
            spitLineIdx = ni;
            lastSpitWord = -1;
            // Pick new color and font for EACH line
            songColorIdx = Math.floor(Math.random() * LYRIC_SCHEMES.length);
            songFontIdx = Math.floor(Math.random() * LYRIC_FONTS.length);
            if (ni === 0) {
                spitParticles = [];
            }
        }

        if (ni < 0) return;

        var line = lrcLines[ni];
        var scheme = LYRIC_SCHEMES[songColorIdx % LYRIC_SCHEMES.length];
        var fontFamily = LYRIC_FONTS[songFontIdx % LYRIC_FONTS.length];
        var words = line.text.split(/\s+/);

        // Calculate line progress
        var lineStart = line.time;
        var lineDuration = nextLineTime - lineStart;
        if (lineDuration > 30) lineDuration = 4;
        var progress = Math.min(1, (now - lineStart) / lineDuration);

        // Which word should be spawned?
        var wordIdx = Math.floor(progress * words.length);
        wordIdx = Math.min(wordIdx, words.length - 1);

        // Spawn new words when we reach them
        while (lastSpitWord < wordIdx && lastSpitWord < words.length - 1) {
            lastSpitWord++;
            spawnSpitWord(words[lastSpitWord], scheme, fontFamily, now, w, h);
        }

        // Render all particles
        renderSpitParticles(now, w, h, fontFamily, scheme);
    }

    function spawnSpitWord(text, scheme, fontFamily, time, w, h) {
        // Calculate mouth position in screen space
        var cx = w / 2;
        var cy = h * 0.42;
        var scale = Math.min(w, h) * 0.3;

        var cosY = Math.cos(headRotY), sinY = Math.sin(headRotY);
        var cosX = Math.cos(headRotX), sinX = Math.sin(headRotX);
        var FL = 4.0;

        // Mouth center in 3D
        var mx = 0, my = MOUTH_Y, mz = MOUTH_Z;
        
        // Transform to screen space for spawn position
        var rx  = mx * cosY - mz * sinY;
        var rz  = mx * sinY + mz * cosY;
        var ry2 = my * cosX - rz * sinX;
        var rz2 = my * sinX + rz * cosX;
        var d   = FL / (FL + rz2);
        
        var spawnX = cx + rx * scale * d;
        var spawnY = cy - ry2 * scale * d;

        // Calculate ejection direction based on head rotation
        // Words fly OUT from the face direction
        var dirX = Math.sin(headRotY);     // left-right based on head turn
        var dirZ = Math.cos(headRotY);     // forward based on head facing
        
        // Add some randomness and spread
        var spread = 0.3;
        var vx = dirX * 2 + (Math.random() - 0.5) * spread;
        var vy = -0.5 - Math.random() * 0.5;  // upward arc
        var vz = dirZ * 2 + (Math.random() - 0.5) * spread;

        spitParticles.push({
            text: text,
            x: spawnX,
            y: spawnY,
            z: 0,  // start at screen plane
            vx: vx * 80,   // velocity scaled for pixels/sec
            vy: vy * 80,
            vz: vz * 0.5,  // depth velocity (for scaling effect)
            spawnTime: time,
            alpha: 1.0,
            headRotY: headRotY,  // capture rotation at spawn time
            scheme: scheme,
            fontFamily: fontFamily
        });
    }


    function renderSpitParticles(now, w, h, defaultFontFamily, defaultScheme) {
        var PARTICLE_LIFETIME = 3.0;  // seconds
        var GRAVITY = 120;  // pixels/sec^2
        var TURN_RATE = 2.5;  // radians/sec - how fast words curve toward viewer

        // Update and render particles
        var activeParticles = [];
        
        for (var i = 0; i < spitParticles.length; i++) {
            var p = spitParticles[i];
            var age = now - p.spawnTime;
            
            if (age > PARTICLE_LIFETIME) continue;  // expired

            // Physics update
            var dt = 1/60;  // assume 60fps for consistent physics
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += GRAVITY * dt;  // gravity pulls down
            p.z += p.vz * dt;

            // Curve the word's rotation toward facing the viewer (0 radians)
            // This makes backwards words gradually turn to face the camera
            if (p.headRotY > 0) {
                p.headRotY = Math.max(0, p.headRotY - TURN_RATE * dt);
            } else if (p.headRotY < 0) {
                p.headRotY = Math.min(0, p.headRotY + TURN_RATE * dt);
            }

            // Perspective scale based on z-depth - BIGGER effect
            var depthScale = 1 + p.z * 0.6;  // was 0.3
            depthScale = Math.max(0.4, Math.min(2.5, depthScale));  // wider range

            // Horizontal squash based on viewing angle
            // With 30° tolerance: only squash when more than 60° from center
            var TOLERANCE = Math.PI / 6;  // 30 degrees
            var absRot = Math.abs(p.headRotY);
            var horizScale = 1.0;
            if (absRot > TOLERANCE) {
                // Start squashing after tolerance zone
                horizScale = Math.cos(absRot - TOLERANCE);
            }
            horizScale = Math.max(0.15, horizScale);

            // Alpha fade over lifetime
            p.alpha = 1 - (age / PARTICLE_LIFETIME);
            p.alpha = Math.pow(p.alpha, 0.7);  // ease out

            // Skip if off screen
            if (p.x < -100 || p.x > w + 100 || p.y < -100 || p.y > h + 100) {
                continue;
            }

            activeParticles.push(p);

            // Calculate font size with perspective - BIGGER base
            var baseSize = Math.min(56, Math.max(28, h * 0.07));  // was 36/20/0.045
            var fontSize = baseSize * depthScale;

            // Render the word with 3D perspective transform
            karaokeCtx.save();
            karaokeCtx.translate(p.x, p.y);
            
            // Apply perspective skew - horizontal compression when sideways
            karaokeCtx.scale(horizScale, 1);
            
            // Mirror text only when VERY far turned (> 150 degrees with tolerance)
            // This prevents most backwards rendering due to our 30° tolerance
            var normalizedRot = ((p.headRotY % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            var isFacingAway = normalizedRot > (Math.PI * 0.5 + TOLERANCE) && 
                               normalizedRot < (Math.PI * 1.5 - TOLERANCE);
            if (isFacingAway) {
                karaokeCtx.scale(-1, 1);  // mirror horizontally
            }

            // Set up text rendering - use particle's own font
            var scheme = p.scheme || defaultScheme;
            var pFont = p.fontFamily || defaultFontFamily;
            karaokeCtx.font = Math.round(fontSize) + 'px ' + pFont;
            karaokeCtx.textAlign = 'center';
            karaokeCtx.textBaseline = 'middle';
            
            // Glow effect - bigger glow for bigger text
            karaokeCtx.shadowColor = scheme.glow;
            karaokeCtx.shadowBlur = 12 + (1 - p.alpha) * 16;
            
            // Text color with alpha
            karaokeCtx.globalAlpha = p.alpha;
            karaokeCtx.fillStyle = scheme.hi;
            karaokeCtx.fillText(p.text, 0, 0);
            
            // Second pass with main color for depth
            karaokeCtx.shadowBlur = 0;
            karaokeCtx.globalAlpha = p.alpha * 0.6;
            karaokeCtx.fillStyle = scheme.fg;
            karaokeCtx.fillText(p.text, 1, 1);
            
            karaokeCtx.restore();
        }

        spitParticles = activeParticles;
    }

    // Toggle lyric mode (can be called externally)
    function toggleLyricMode() {
        lyricMode = (lyricMode + 1) % 2;
        // Reset state when switching
        spitParticles = [];
        lastSpitWord = -1;
        spitLineIdx = -1;
        wordPositions = [];
        ballTrail = [];
        console.log('[viz] lyric mode:', lyricMode === LYRIC_MODE_BOUNCING ? 'bouncing ball' : 'spitting');
        return lyricMode;
    }

    function setLyricMode(mode) {
        if (mode === 'bouncing' || mode === LYRIC_MODE_BOUNCING) {
            lyricMode = LYRIC_MODE_BOUNCING;
        } else if (mode === 'spitting' || mode === LYRIC_MODE_SPITTING) {
            lyricMode = LYRIC_MODE_SPITTING;
        }
        // Reset state
        spitParticles = [];
        lastSpitWord = -1;
        spitLineIdx = -1;
        wordPositions = [];
        ballTrail = [];
        console.log('[viz] lyric mode set to:', lyricMode === LYRIC_MODE_BOUNCING ? 'bouncing ball' : 'spitting');
    }

    // =========================================================
    //  Public API
    // =========================================================
    window.sbbsVisualizer = {
        show: show,
        hide: hide,
        toggle: toggle,
        toggleLyricMode: toggleLyricMode,
        setLyricMode: setLyricMode
    };

    // =========================================================
    //  Boot
    // =========================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
