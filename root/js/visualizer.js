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
    var resizeObserver = null; // stored to disconnect on close
    var observedResizeBox = null;
    var resizeRAF     = 0;
    var resizeSettleTimer = null;
    var lastCanvasW   = 0;
    var lastCanvasH   = 0;

    // Canvas refs
    var milkCanvas    = null;   // Butterchurn WebGL
    var wireCanvas    = null;   // Wireframe overlay (2D)
    var wireCtx       = null;

    // Lyrics state
    var lrcLines      = [];     // [{time: seconds, text: ''}, ...]
    var lrcIndex      = -1;
    var trackFile     = '';
    var trackMeta     = null;  // parsed ID3 tags or null
    var metaArtUrl    = '';    // object URL for album art (revoked on change)
    var metaIsMinimized = false;
    var metaAltTimer  = null;  // alternation timer for mini bar text
    var metaAltState  = 0;     // 0 = artist, 1 = title
    var metaToggleAt  = 0;

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
    var headWaveform  = [];     // normalized analyser time-domain samples
    var headFreqData  = [];     // normalized frequency bin data (0-1)
    var headProjectionState = null;
    var eyeScreenPoints = { left: null, right: null, mouth: null };
    var vizTime       = 0;

    // Experimental FX toggles
    var laserEyesEnabled = true;
    var waveHeadEnabled  = true;
    var eyeLasers        = [];  // [{originX, originY, target, spawnTime, duration}]
    var wordExplosions   = [];  // explosion fragments and flashes
    var spitParticleSeq  = 0;
    var laserEyeTurn     = 'left';
    var eyeBlinkState    = {
        left:  { start: -1, fire: -1, end: -1 },
        right: { start: -1, fire: -1, end: -1 }
    };

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
    var elFxLyrics, elFxLasers, elFxWave;
    var elMetaHud, elMetaArt, elMetaTitle;
    var elMetaArtist, elMetaComposer, elMetaAlbum, elMetaYear, elMetaGenre;

    // --- Character system ------------------------------------------------
    // Each character defines head geometry, colors, and optional features
    // (hair, hat, facial hair).  Active character selected by artist tag.
    var CHARACTERS = {
        _default: {
            name: 'Skull',
            profile: [
                [0.00, -0.80], [0.22, -0.70], [0.38, -0.58],
                [0.48, -0.42], [0.52, -0.25], [0.50, -0.08],
                [0.46,  0.08], [0.44,  0.22], [0.42,  0.36],
                [0.37,  0.48], [0.28,  0.58], [0.15,  0.65],
                [0.00,  0.68]
            ],
            ringN: 16,
            eyes: {
                left:  { x: -0.18, y: -0.05, z: 0.45, r: 0.08 },
                right: { x:  0.18, y: -0.05, z: 0.45, r: 0.08 }
            },
            eyeColor: null,   // null = derive from wireColor
            mouth: { y: -0.52, hw: 0.25, z: 0.48, segs: 8, teeth: false },
            nose: {
                bridge: [[0, -0.15, 0.53], [0, -0.30, 0.57], [0, -0.34, 0.58]],
                base:   [[-0.06, -0.36, 0.52], [0, -0.34, 0.58], [0.06, -0.36, 0.52]]
            },
            wireColor: '#33FF33',
            wireRGB:   '51,255,51',
            accentColor: '#FFAA00',
            accentRGB:   '255,170,0',
            hair: null,
            hat: null,
            facialHair: null
        },

        quantumacidface: {
            name: 'QuantumAcidFace',
            // Rounder, fuller face than the skeletal default
            profile: [
                [0.00, -0.76], [0.25, -0.67], [0.41, -0.54],
                [0.50, -0.38], [0.53, -0.20], [0.52, -0.03],
                [0.50,  0.12], [0.48,  0.26], [0.45,  0.38],
                [0.40,  0.48], [0.33,  0.56], [0.22,  0.62],
                [0.00,  0.65]
            ],
            ringN: 16,
            eyes: {
                left:  { x: -0.19, y: -0.03, z: 0.46, r: 0.09 },
                right: { x:  0.19, y: -0.03, z: 0.46, r: 0.09 }
            },
            eyeColor: { hex: '#5599FF', rgb: '85,153,255' },
            mouth: { y: -0.50, hw: 0.27, z: 0.45, segs: 10,
                     teeth: true, teethColor: '255,255,255' },
            nose: {
                bridge: [[0, -0.13, 0.54], [0, -0.27, 0.58], [0, -0.31, 0.59]],
                base:   [[-0.07, -0.33, 0.53], [0, -0.31, 0.59], [0.07, -0.33, 0.53]]
            },
            wireColor: '#9999BB',
            wireRGB:   '153,153,187',
            accentColor: '#CC55FF',
            accentRGB:   '204,85,255',
            hair: [
                // Left side — long flowing strands (low→mid freq)
                { rx: -0.33, ry: 0.56, rz:  0.00, len: 1.10, color: '#FF55FF', width: 1.8, freq: 0.05 },
                { rx: -0.40, ry: 0.48, rz:  0.05, len: 1.25, color: '#55FFFF', width: 1.5, freq: 0.10 },
                { rx: -0.35, ry: 0.52, rz:  0.10, len: 1.15, color: '#AA55FF', width: 1.6, freq: 0.18 },
                { rx: -0.28, ry: 0.58, rz:  0.15, len: 1.00, color: '#55FF55', width: 1.4, freq: 0.25 },
                { rx: -0.22, ry: 0.60, rz:  0.20, len: 0.90, color: '#FF55AA', width: 1.3, freq: 0.35 },
                { rx: -0.42, ry: 0.40, rz: -0.08, len: 1.30, color: '#FFFF55', width: 1.5, freq: 0.07 },
                { rx: -0.18, ry: 0.61, rz:  0.08, len: 0.85, color: '#55AAFF', width: 1.4, freq: 0.42 },
                // Right side — mirror (mid→high freq)
                { rx:  0.33, ry: 0.56, rz:  0.00, len: 1.10, color: '#FF55FF', width: 1.8, freq: 0.50 },
                { rx:  0.40, ry: 0.48, rz:  0.05, len: 1.25, color: '#55FFFF', width: 1.5, freq: 0.58 },
                { rx:  0.35, ry: 0.52, rz:  0.10, len: 1.15, color: '#AA55FF', width: 1.6, freq: 0.65 },
                { rx:  0.28, ry: 0.58, rz:  0.15, len: 1.00, color: '#55FF55', width: 1.4, freq: 0.72 },
                { rx:  0.22, ry: 0.60, rz:  0.20, len: 0.90, color: '#FF55AA', width: 1.3, freq: 0.80 },
                { rx:  0.42, ry: 0.40, rz: -0.08, len: 1.30, color: '#FFFF55', width: 1.5, freq: 0.55 },
                { rx:  0.18, ry: 0.61, rz:  0.08, len: 0.85, color: '#55AAFF', width: 1.4, freq: 0.88 },
                // Top / crown — tighter coverage
                { rx: -0.08, ry: 0.64, rz:  0.05, len: 0.65, color: '#FF55FF', width: 1.3, freq: 0.30 },
                { rx:  0.08, ry: 0.64, rz:  0.05, len: 0.65, color: '#55FFFF', width: 1.3, freq: 0.38 },
                { rx:  0.00, ry: 0.65, rz:  0.02, len: 0.55, color: '#AA55FF', width: 1.4, freq: 0.45 },
                { rx: -0.15, ry: 0.62, rz:  0.00, len: 0.75, color: '#FFFF55', width: 1.2, freq: 0.22 },
                { rx:  0.15, ry: 0.62, rz:  0.00, len: 0.75, color: '#55FF55', width: 1.2, freq: 0.68 },
                { rx: -0.05, ry: 0.65, rz: -0.05, len: 0.50, color: '#FF55AA', width: 1.3, freq: 0.15 },
                { rx:  0.05, ry: 0.65, rz: -0.05, len: 0.50, color: '#55AAFF', width: 1.3, freq: 0.75 },
                // Back — draping down behind
                { rx: -0.12, ry: 0.63, rz: -0.12, len: 0.80, color: '#FF55FF', width: 1.2, freq: 0.12 },
                { rx:  0.12, ry: 0.63, rz: -0.12, len: 0.80, color: '#55FFFF', width: 1.2, freq: 0.62 },
                { rx:  0.00, ry: 0.65, rz: -0.15, len: 0.70, color: '#AA55FF', width: 1.3, freq: 0.40 },
                { rx: -0.20, ry: 0.58, rz: -0.18, len: 0.90, color: '#FFFF55', width: 1.3, freq: 0.08 },
                { rx:  0.20, ry: 0.58, rz: -0.18, len: 0.90, color: '#55FF55', width: 1.3, freq: 0.85 }
            ],
            hat: null,
            facialHair: null
        }
    };

    var activeChar = CHARACTERS._default;

    function setActiveCharacter(key) {
        var ch = CHARACTERS[key] || CHARACTERS._default;
        if (ch === activeChar) return;
        activeChar = ch;
        console.log('[visualizer] character: ' + ch.name);
    }

    function getCharacterForArtist(artist) {
        if (!artist) return '_default';
        // Strip "feat." / "ft." and everything after
        var primary = artist.split(/\s+feat\.?\s+|\s+ft\.?\s+/i)[0].trim();
        // Normalize: lowercase, strip non-alphanumeric
        var key = primary.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (CHARACTERS[key]) return key;
        return '_default';
    }

    var LASER_RED = '#FF5555';

    function isEditableTarget(target) {
        return !!(target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]'));
    }

    function setFxValue(el, text, modeClass) {
        if (!el) return;
        el.textContent = text;
        el.className = 'viz-fx-value' + (modeClass ? ' ' + modeClass : '');
    }

    function updateFxHud() {
        setFxValue(
            elFxLyrics,
            lyricMode === LYRIC_MODE_SPITTING ? 'Spitting' : 'Ball',
            'is-on'
        );
        setFxValue(
            elFxLasers,
            laserEyesEnabled ? 'On' : 'Off',
            laserEyesEnabled ? 'is-on is-laser' : ''
        );
        setFxValue(
            elFxWave,
            waveHeadEnabled ? 'On' : 'Off',
            waveHeadEnabled ? 'is-on is-wave' : ''
        );
    }

    function resetLyricFxState() {
        spitParticles = [];
        lastSpitWord = -1;
        spitLineIdx = -1;
        wordPositions = [];
        ballTrail = [];
        eyeLasers = [];
        wordExplosions = [];
        laserEyeTurn = 'left';
        eyeBlinkState.left.start = eyeBlinkState.left.fire = eyeBlinkState.left.end = -1;
        eyeBlinkState.right.start = eyeBlinkState.right.fire = eyeBlinkState.right.end = -1;
    }

    function getEyeBlinkAmount(name) {
        var state = eyeBlinkState[name];
        if (!state || state.start < 0 || state.end <= state.start) return 0;
        if (vizTime < state.start || vizTime > state.end) return 0;
        if (vizTime <= state.fire) {
            return Math.min(1, (vizTime - state.start) / Math.max(0.0001, state.fire - state.start));
        }
        return Math.max(0, 1 - ((vizTime - state.fire) / Math.max(0.0001, state.end - state.fire)));
    }

    function buildProjectionState(w, h) {
        var scale = Math.min(w, h) * 0.3;
        if (window.innerWidth < 768) scale *= 1.5;
        return {
            cx: w / 2,
            cy: h * 0.42,
            scale: scale,
            cosY: Math.cos(headRotY),
            sinY: Math.sin(headRotY),
            cosX: Math.cos(headRotX),
            sinX: Math.sin(headRotX),
            fl: 4.0,
            pulse: 1
        };
    }

    function projectHeadPoint(state, x, y, z, scaleMultiplier) {
        if (!state) return { x: 0, y: 0, d: 1 };
        var rx  = x * state.cosY - z * state.sinY;
        var rz  = x * state.sinY + z * state.cosY;
        var ry2 = y * state.cosX - rz * state.sinX;
        var rz2 = y * state.sinX + rz * state.cosX;
        var d   = state.fl / (state.fl + rz2);
        var S   = state.scale * (typeof scaleMultiplier === 'number' ? scaleMultiplier : state.pulse || 1);
        return { x: state.cx + rx * S * d, y: state.cy - ry2 * S * d, d: d };
    }

    function updateWaveformSamples(timeData) {
        headWaveform = [];
        if (!timeData || !timeData.length) return;
        var sampleCount = Math.max(32, activeChar.ringN * 2);
        var step = timeData.length / sampleCount;
        for (var i = 0; i < sampleCount; i++) {
            var idx = Math.min(timeData.length - 1, Math.floor(i * step));
            headWaveform.push((timeData[idx] - 128) / 128);
        }
    }

    function getWaveformSample(index) {
        if (!headWaveform.length) return 0;
        var len = headWaveform.length;
        var idx = ((index % len) + len) % len;
        return headWaveform[idx];
    }

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
        elFxLyrics = document.getElementById('viz-fx-lyrics');

        // Metadata HUD refs
        elMetaHud      = document.getElementById('viz-meta-hud');
        elMetaArt      = document.getElementById('viz-meta-art');
        elMetaTitle    = document.getElementById('viz-meta-title');
        elMetaArtist   = document.getElementById('viz-meta-artist-val');
        elMetaComposer = document.getElementById('viz-meta-composer-val');
        elMetaAlbum    = document.getElementById('viz-meta-album-val');
        elMetaYear     = document.getElementById('viz-meta-year-val');
        elMetaGenre    = document.getElementById('viz-meta-genre-val');

        // Click/tap HUD to toggle minimize/expand
        if (elMetaHud) {
            elMetaHud.addEventListener('pointerup', onMetaHudActivate);
            elMetaHud.addEventListener('click', onMetaHudActivate);
        }
        elFxLasers = document.getElementById('viz-fx-lasers');
        elFxWave = document.getElementById('viz-fx-wave');
        updateFxHud();

        // Tap/click canvas area to toggle lyric mode (spit <-> bouncing ball)
        var vizBox = elPanel.querySelector('.viz-canvas-container');
        if (vizBox) {
            vizBox.addEventListener('click', function (e) {
                if (!isOpen) return;
                // Ignore clicks on buttons or interactive elements
                if (e.target.closest('button, a, input, select')) return;
                toggleLyricMode();
            });
            vizBox.style.cursor = 'pointer';
        }

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

        // Mobile visualizer toggle button - opens viz AND starts playing if not already
        var btnVizMobile = document.getElementById('btn-viz-mobile');
        if (btnVizMobile) {
            btnVizMobile.addEventListener('click', function(e) {
                e.stopPropagation();
                showAndPlay();
            });
        }

        // Listen for track changes from radio.js
        document.addEventListener('radio:trackchange', onTrackChange);

        // Allow external components to request opening the visualizer
        document.addEventListener('viz:open', function () { show(); });

        // Keyboard shortcuts for visualizer FX when open
        document.addEventListener('keydown', function(e) {
            if (!isOpen) return;
            if (isEditableTarget(e.target)) return;
            if (e.key === 'l' || e.key === 'L') {
                e.preventDefault();
                toggleLyricMode();
            } else if (e.key === 'e' || e.key === 'E') {
                e.preventDefault();
                toggleLaserEyes();
            } else if (e.key === 'w' || e.key === 'W') {
                e.preventDefault();
                toggleWaveHead();
            }
        });

        // Close visualizer on SPA navigation
        window.addEventListener('spa:beforeNavigate', function() {
            if (isOpen) hide();
        });
        // Wire up mobile transport controls
        wireTransportControls();
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

        bindViewportResize();
        setupCanvases();
        handleViewportResize();
        // Retry Butterchurn init if audioCtx not ready yet
        if (!initButterchurn()) { scheduleButterchurnRetry(); }
        resetLyricFxState();
        updateFxHud();
        startAnim();
        fetchMetadata();

        // Auto-play radio if not already playing
        var radio = window.sbbsRadio;
        if (radio && !radio.isPlaying) {
            var playBtn = document.getElementById('radio-play');
            if (playBtn) playBtn.click();
        }

        console.log('[viz] opened');
    }

    function hide() {
        if (!isOpen) return;
        isOpen = false;

        stopAnim();
        resetLyricFxState();
        elPanel.classList.add('is-hidden');
        elPanel.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('viz-open');

        // Cleanup Butterchurn (try dispose if available)
        if (bcViz) {
            if (typeof bcViz.dispose === 'function') bcViz.dispose();
            else if (typeof bcViz.destroy === 'function') bcViz.destroy();
        }
        bcViz = null;

        // Disconnect ResizeObserver to prevent leaks
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
        observedResizeBox = null;
        unbindViewportResize();
        if (resizeRAF) {
            cancelAnimationFrame(resizeRAF);
            resizeRAF = 0;
        }
        if (resizeSettleTimer) {
            clearTimeout(resizeSettleTimer);
            resizeSettleTimer = null;
        }
        lastCanvasW = 0;
        lastCanvasH = 0;
        if (presetTimer) { clearInterval(presetTimer); presetTimer = null; }

        hideMetaHud();
        console.log('[viz] closed');
    }

    function toggle() { isOpen ? hide() : show(); }

    // Open visualizer and start playback if not playing (for mobile button)
    function showAndPlay() {
        show();
        // Start playback if not already playing
        var radio = window.sbbsRadio;
        if (radio && !radio.isPlaying) {
            var playBtn = document.getElementById('radio-play');
            if (playBtn) playBtn.click();
        }
        updateTransportUI();
    }

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

        lastCanvasW = 0;
        lastCanvasH = 0;
        scheduleCanvasResize();

        // Only create ResizeObserver once, store reference for cleanup
        if (window.ResizeObserver) {
            if (!resizeObserver) {
                resizeObserver = new ResizeObserver(scheduleCanvasResize);
            }
            if (observedResizeBox && observedResizeBox !== box) {
                resizeObserver.unobserve(observedResizeBox);
            }
            observedResizeBox = box;
            resizeObserver.observe(box);
        }
    }

    function scheduleCanvasResize() {
        if (resizeRAF) return;
        resizeRAF = requestAnimationFrame(function () {
            resizeRAF = 0;
            sizeCanvases();
        });
    }

    function handleViewportResize() {
        if (!isOpen || !elPanel) return;
        elPanel.style.paddingTop = getNavH() + 'px';
        scheduleCanvasResize();
        if (resizeSettleTimer) clearTimeout(resizeSettleTimer);
        resizeSettleTimer = setTimeout(function () {
            resizeSettleTimer = null;
            scheduleCanvasResize();
        }, 140);
    }

    function bindViewportResize() {
        window.addEventListener('resize', handleViewportResize, { passive: true });
        window.addEventListener('orientationchange', handleViewportResize, { passive: true });
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', handleViewportResize, { passive: true });
        }
    }

    function unbindViewportResize() {
        window.removeEventListener('resize', handleViewportResize, { passive: true });
        window.removeEventListener('orientationchange', handleViewportResize, { passive: true });
        if (window.visualViewport) {
            window.visualViewport.removeEventListener('resize', handleViewportResize, { passive: true });
        }
    }

    function sizeCanvases() {
        var box = elPanel.querySelector('.viz-canvas-container');
        if (!box) return;
        var rect = box.getBoundingClientRect();
        var w = Math.round(rect.width || box.clientWidth);
        var h = Math.round(rect.height || box.clientHeight);
        if (w < 1 || h < 1) return;
        if (w === lastCanvasW && h === lastCanvasH) return;
        lastCanvasW = w;
        lastCanvasH = h;

        [milkCanvas, wireCanvas, karaokeCanvas].forEach(function (c) {
            if (c) {
                c.width = w;
                c.height = h;
                c.style.width = w + 'px';
                c.style.height = h + 'px';
            }
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
        var amp = 0, bass = 0, vocalPresence = 0;
        vizTime = performance.now() / 1000;

        if (radio && radio.analyserNode) {
            var bins = radio.analyserNode.frequencyBinCount;
            var data = new Uint8Array(bins);
            radio.analyserNode.getByteFrequencyData(data);

            // Store normalized frequency data for hair animation
            headFreqData = new Array(bins);
            for (var fi = 0; fi < bins; fi++) headFreqData[fi] = data[fi] / 255;

            var sum = 0;
            for (var i = 0; i < bins; i++) sum += data[i];
            amp = sum / (bins * 255);

            var bc = Math.max(1, bins >> 2);
            var bs = 0;
            for (var j = 0; j < bc; j++) bs += data[j];
            bass = bs / (bc * 255);

            var midStart = Math.max(1, bins >> 3);
            var midEnd = Math.max(midStart + 1, bins >> 1);
            var ms = 0;
            for (var m = midStart; m < midEnd; m++) ms += data[m];
            var mids = ms / ((midEnd - midStart) * 255);
            vocalPresence = Math.max(0, Math.min(1, mids * 1.35 - bass * 0.35));

            var timeData = new Uint8Array(bins);
            radio.analyserNode.getByteTimeDomainData(timeData);
            updateWaveformSamples(timeData);
            if (radio && isFinite(radio.currentTime)) {
                vizTime = radio.currentTime;
            }
        } else {
            headWaveform = [];
            headFreqData = [];
        }

        // Skip rendering when tab is hidden or panel is not visible
        if (bcViz && !document.hidden) bcViz.render();
        drawHead(amp, bass, vocalPresence, getLyricMouthState(vizTime));
        if (lyricMode === LYRIC_MODE_SPITTING) {
            syncLyricsSpitting();
        } else {
            syncLyrics();
        }
    }

    // =========================================================
    //  Wireframe Head Renderer
    // =========================================================
    function drawHead(amp, bass, vocalPresence, lyricMouth) {
        if (!wireCtx || !wireCanvas) return;
        var W = wireCanvas.width, H = wireCanvas.height;
        wireCtx.clearRect(0, 0, W, H);

        headRotY += 0.007;
        breathPhase += 0.02;

        // Mouth motion should mainly respond during lyric-active windows,
        // with audio shaping the size of the motion inside those windows.
        lyricMouth = lyricMouth || { active: false, gate: 0, pulse: 0, wordRate: 0 };
        var ambientMouth = Math.max(0, amp * 0.35 - bass * 0.18);
        var vocalDriven = Math.max(0, vocalPresence || 0);
        var idleAudio = Math.max(ambientMouth * 0.6, vocalDriven * 0.45);
        var mouthTarget;
        if (lyricMouth.active) {
            var lyricFloor = lyricMouth.gate * (0.13 + Math.min(0.08, lyricMouth.wordRate * 0.018));
            var gatedAudio = idleAudio * 0.65 + vocalDriven * (0.25 + lyricMouth.gate * 0.65);
            var lyricBoost = lyricMouth.pulse * (0.22 + lyricMouth.gate * 0.12 + vocalDriven * 0.32);
            mouthTarget = Math.min(1, Math.max(lyricFloor, gatedAudio * 1.05 + lyricBoost));
        } else if (lrcLines.length) {
            mouthTarget = Math.min(0.18, idleAudio * 0.75);
        } else {
            mouthTarget = Math.min(0.42, Math.max(idleAudio, vocalDriven * 1.05));
        }
        var mouthLerp = mouthTarget > mouthOpen
            ? (lyricMouth.active ? 0.38 : 0.24)
            : (lyricMouth.active ? 0.18 : 0.10);
        mouthOpen += (mouthTarget - mouthOpen) * mouthLerp;
        eyeGlow   += (Math.min(bass * 2, 1) - eyeGlow) * 0.2;

        var pulse = 1 + bass * 0.06 + Math.sin(breathPhase) * 0.01;
        var projState = buildProjectionState(W, H);
        projState.pulse = pulse;
        headProjectionState = projState;

        function proj(x, y, z) {
            return projectHeadPoint(projState, x, y, z, pulse);
        }

        eyeScreenPoints.left = projectHeadPoint(projState, activeChar.eyes.left.x, activeChar.eyes.left.y, activeChar.eyes.left.z, pulse);
        eyeScreenPoints.right = projectHeadPoint(projState, activeChar.eyes.right.x, activeChar.eyes.right.y, activeChar.eyes.right.z, pulse);
        eyeScreenPoints.mouth = projectHeadPoint(projState, 0, activeChar.mouth.y, activeChar.mouth.z, pulse);

        // Generate rings
        var rings = [];
        var waveformTime = performance.now() * 0.0065;
        var waveStrength = waveHeadEnabled ? (0.016 + amp * 0.055 + bass * 0.035) : 0;
        for (var p = 0; p < activeChar.profile.length; p++) {
            var ring = [];
            var baseRad = activeChar.profile[p][0];
            var baseY = activeChar.profile[p][1];
            for (var s = 0; s < activeChar.ringN; s++) {
                var a = (s / activeChar.ringN) * Math.PI * 2;
                var rad = baseRad;
                var yy = baseY;
                if (waveHeadEnabled && headWaveform.length) {
                    var sample = getWaveformSample((s * 2) + p);
                    var shimmer = Math.sin(waveformTime + p * 0.55 + s * 0.42);
                    var wave = sample * 0.78 + shimmer * 0.22;
                    rad += wave * waveStrength * (0.55 + baseRad);
                    yy += wave * waveStrength * 0.38;
                }
                ring.push(proj(rad * Math.cos(a), yy, rad * Math.sin(a)));
            }
            rings.push(ring);
        }

        wireCtx.lineCap = wireCtx.lineJoin = 'round';

        // --- Horizontal rings ---
        wireCtx.shadowBlur  = 8 + bass * 14 + (waveHeadEnabled ? 8 : 0);
        wireCtx.shadowColor = activeChar.wireColor;
        wireCtx.strokeStyle = 'rgba(' + activeChar.wireRGB + ',0.55)';
        wireCtx.lineWidth   = waveHeadEnabled ? 1.4 : 1.2;

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
        wireCtx.strokeStyle = 'rgba(' + activeChar.wireRGB + ',0.30)';
        wireCtx.lineWidth   = waveHeadEnabled ? 0.95 : 0.8;
        for (var s = 0; s < activeChar.ringN; s += 2) {
            wireCtx.beginPath();
            for (var r = 0; r < rings.length; r++) {
                var pt = rings[r][s];
                r === 0 ? wireCtx.moveTo(pt.x, pt.y) : wireCtx.lineTo(pt.x, pt.y);
            }
            wireCtx.stroke();
        }

        // --- Hair (behind/around skull) ---
        drawHair(activeChar, proj, amp, bass);

        // --- Hat ---
        drawHat(activeChar, proj, amp, bass);

        // --- Eyes ---
        drawEye(activeChar.eyes.left, proj, 'left', activeChar);
        drawEye(activeChar.eyes.right, proj, 'right', activeChar);

        // --- Nose ---
        drawNose(proj, activeChar);

        // --- Mouth ---
        drawMouth(proj, activeChar);

        // --- Facial hair ---
        drawFacialHair(activeChar, proj, amp, bass);
    }

    function drawEye(eye, proj, eyeName, char) {
        char = char || activeChar;
        var segs = 12, pts = [];
        var blinkAmount = getEyeBlinkAmount(eyeName);
        var eyeScaleY = Math.max(0.08, 0.7 - blinkAmount * 0.62);
        for (var i = 0; i <= segs; i++) {
            var a  = (i / segs) * Math.PI * 2;
            pts.push(proj(
                eye.x + eye.r * Math.cos(a),
                eye.y + eye.r * Math.sin(a) * eyeScaleY,
                eye.z
            ));
        }

        var eHex = (char.eyeColor ? char.eyeColor.hex : char.wireColor);
        var eRGB = (char.eyeColor ? char.eyeColor.rgb : char.wireRGB);
        wireCtx.shadowBlur  = 10 + eyeGlow * 16;
        wireCtx.shadowColor = eHex;
        wireCtx.strokeStyle = 'rgba(' + eRGB + ',' + (0.7 + eyeGlow * 0.3) + ')';
        wireCtx.lineWidth   = 1.5 + eyeGlow;

        wireCtx.beginPath();
        for (var i = 0; i < pts.length; i++) {
            i === 0 ? wireCtx.moveTo(pts[i].x, pts[i].y) : wireCtx.lineTo(pts[i].x, pts[i].y);
        }
        wireCtx.stroke();

        // Pupil dot
        var c = proj(eye.x, eye.y, eye.z);
        if (blinkAmount < 0.72) {
            wireCtx.beginPath();
            wireCtx.arc(c.x, c.y, 2 + eyeGlow * 3, 0, Math.PI * 2);
            wireCtx.fillStyle = 'rgba(' + eRGB + ',' + (0.5 + eyeGlow * 0.5) + ')';
            wireCtx.fill();
        } else {
            wireCtx.beginPath();
            wireCtx.moveTo(c.x - eye.r * 30 * c.d * 0.22, c.y);
            wireCtx.lineTo(c.x + eye.r * 30 * c.d * 0.22, c.y);
            wireCtx.strokeStyle = 'rgba(' + eRGB + ',0.85)';
            wireCtx.lineWidth = 1.1 + eyeGlow * 0.5;
            wireCtx.stroke();
        }
    }

    function drawNose(proj, char) {
        char = char || activeChar;
        wireCtx.shadowBlur  = 5;
        wireCtx.shadowColor = char.wireColor;
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.35)';
        wireCtx.lineWidth   = 1;

        var nose = char.nose;
        var br = [];
        for (var i = 0; i < nose.bridge.length; i++) {
            br.push(proj(nose.bridge[i][0], nose.bridge[i][1], nose.bridge[i][2]));
        }
        var ba = [];
        for (var j = 0; j < nose.base.length; j++) {
            ba.push(proj(nose.base[j][0], nose.base[j][1], nose.base[j][2]));
        }

        wireCtx.beginPath();
        for (var k = 0; k < br.length; k++) {
            k === 0 ? wireCtx.moveTo(br[k].x, br[k].y) : wireCtx.lineTo(br[k].x, br[k].y);
        }
        wireCtx.stroke();
        wireCtx.beginPath();
        for (var m = 0; m < ba.length; m++) {
            m === 0 ? wireCtx.moveTo(ba[m].x, ba[m].y) : wireCtx.lineTo(ba[m].x, ba[m].y);
        }
        wireCtx.stroke();
    }

    function drawMouth(proj, char) {
        char = char || activeChar;
        var mth = char.mouth;
        var open = mouthOpen * 0.09;
        var upper = [], lower = [];

        for (var i = 0; i <= mth.segs; i++) {
            var t    = (i / mth.segs) * 2 - 1;  // -1…1
            var curv = 1 - t * t;                 // parabola
            var xp   = t * mth.hw;
            upper.push(proj(xp, mth.y + open * curv + 0.01 * curv, mth.z));
            lower.push(proj(xp, mth.y - open * curv - 0.01 * curv, mth.z));
        }

        wireCtx.shadowBlur  = 6 + mouthOpen * 16;
        wireCtx.shadowColor = char.accentColor;
        wireCtx.strokeStyle = 'rgba(' + char.accentRGB + ',' + (0.6 + mouthOpen * 0.4) + ')';
        wireCtx.lineWidth   = 1.5 + mouthOpen;

        stroke(upper);
        stroke(lower);

        // Teeth (optional per character)
        if (mth.teeth && open > 0.015) {
            var teethN = Math.max(3, Math.floor(mth.segs * 0.7));
            var tRGB = mth.teethColor || '255,255,255';
            var tAlpha = Math.min(0.95, open * 5);
            wireCtx.strokeStyle = 'rgba(' + tRGB + ',' + tAlpha + ')';
            wireCtx.shadowColor = 'rgba(' + tRGB + ',1)';
            wireCtx.shadowBlur  = 6 + mouthOpen * 10;
            wireCtx.lineWidth   = 1.0;
            for (var ti = 1; ti < teethN; ti++) {
                var tt = (ti / teethN) * 2 - 1;
                var tcurv = 1 - tt * tt;
                var tx = tt * mth.hw * 0.88;
                var topP = proj(tx, mth.y + open * tcurv * 0.75, mth.z);
                var botP = proj(tx, mth.y - open * tcurv * 0.75, mth.z);
                wireCtx.beginPath();
                wireCtx.moveTo(topP.x, topP.y);
                wireCtx.lineTo(botP.x, botP.y);
                wireCtx.stroke();
            }
        }

        // Inner glow when wide open
        if (mouthOpen > 0.3) {
            wireCtx.strokeStyle = 'rgba(255,200,50,' + ((mouthOpen - 0.3) * 0.6) + ')';
            wireCtx.lineWidth = 0.5;
            for (var row = 1; row <= 2; row++) {
                var frac = row / 3;
                var inner = [];
                for (var i = 0; i <= mth.segs; i++) {
                    var t    = (i / mth.segs) * 2 - 1;
                    var curv = 1 - t * t;
                    inner.push(proj(t * mth.hw * 0.85,
                        mth.y + open * curv * frac, mth.z));
                }
                stroke(inner);
            }
        }
    }

    // =========================================================
    //  Character feature renderers
    // =========================================================

    var HAIR_SEGS = 8;  // subdivision points per strand

    function getFreqSample(freqPos) {
        // freqPos: 0-1 maps across the frequency spectrum
        if (!headFreqData.length) return 0;
        var idx = Math.min(headFreqData.length - 1,
                           Math.floor(freqPos * headFreqData.length));
        return headFreqData[idx] || 0;
    }

    function drawHair(char, proj, amp, bass) {
        if (!char.hair || !char.hair.length) return;
        var t = performance.now() * 0.001;
        wireCtx.lineCap = 'round';

        for (var i = 0; i < char.hair.length; i++) {
            var h = char.hair[i];
            var root = proj(h.rx, h.ry, h.rz);

            // Each strand maps to a frequency band (or defaults to spread)
            var freqPos = (typeof h.freq === 'number') ? h.freq : (i / char.hair.length);
            var freqVal = getFreqSample(freqPos);

            // Gravity direction: hair hangs down (negative Y) and outward
            var outward = (h.rx >= 0) ? 1 : -1;
            var phase = t * 1.5 + i * 0.9;
            var breathSway = Math.sin(breathPhase + i * 0.3) * 0.012;

            // Build segmented strand with frequency-driven waveform displacement
            var pts = [root];
            for (var s = 1; s <= HAIR_SEGS; s++) {
                var frac = s / HAIR_SEGS;  // 0..1 along strand length

                // Base position: hang downward with slight outward drift
                var baseY = h.ry - h.len * frac;
                var baseX = h.rx + (h.rx * 0.15 * frac);  // drift outward
                var baseZ = h.rz + Math.sin(phase * 0.3 + frac) * 0.02;

                // Frequency-driven waveform displacement
                // Higher freq strands oscillate faster, lower ones sway bigger
                var waveSpeed = 2.0 + freqPos * 6.0;  // high freq = fast wave
                var waveAmp = freqVal * (0.06 + (1 - freqPos) * 0.10);  // low freq = bigger
                var wavePropagation = frac * 3.0;  // wave travels down the strand
                var wave = Math.sin(t * waveSpeed + wavePropagation + i * 1.1) * waveAmp;

                // Add bass thump: sharp displacement that decays along length
                var bassKick = bass * 0.08 * Math.sin(phase * 0.7) * (0.3 + frac * 0.7);

                // Combine displacements
                var dx = wave * outward + bassKick + breathSway * frac;
                var dz = Math.cos(t * waveSpeed * 0.7 + wavePropagation) * waveAmp * 0.4;

                pts.push(proj(baseX + dx, baseY, baseZ + dz));
            }

            // Glow intensity scales with frequency energy
            var glowBoost = freqVal * 12;
            wireCtx.strokeStyle = h.color;
            wireCtx.shadowColor = h.color;
            wireCtx.shadowBlur  = 4 + bass * 8 + glowBoost;
            wireCtx.lineWidth   = (h.width || 1.2) + freqVal * 0.6;
            wireCtx.globalAlpha = 0.65 + freqVal * 0.35;

            // Draw smooth curve through all segment points
            wireCtx.beginPath();
            wireCtx.moveTo(pts[0].x, pts[0].y);
            if (pts.length === 2) {
                wireCtx.lineTo(pts[1].x, pts[1].y);
            } else {
                // Catmull-Rom-ish smooth curve via quadratic segments
                for (var s = 1; s < pts.length - 1; s++) {
                    var cpx = (pts[s].x + pts[s + 1].x) * 0.5;
                    var cpy = (pts[s].y + pts[s + 1].y) * 0.5;
                    wireCtx.quadraticCurveTo(pts[s].x, pts[s].y, cpx, cpy);
                }
                // Final segment to last point
                var last = pts[pts.length - 1];
                wireCtx.lineTo(last.x, last.y);
            }
            wireCtx.stroke();
        }
        wireCtx.globalAlpha = 1;
    }

    function drawHat(char, proj, amp, bass) {
        if (!char.hat) return;
        // TODO: implement hat rendering
    }

    function drawFacialHair(char, proj, amp, bass) {
        if (!char.facialHair) return;
        // TODO: implement facial hair rendering
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
        trackMeta = null;
        setActiveCharacter('_default');
        resetLyricFxState();
        if (elLyrics) elLyrics.textContent = '';
        hideMetaHud(true);
        if (isOpen) fetchMetadata();
    }

    // =========================================================
    //  ID3 Metadata + SYLT synchronized lyrics
    // =========================================================
    var META_FETCH_BYTES = 256 * 1024; // read first 256KB for ID3 header

    function fetchMetadata() {
        if (!trackFile) {
            var r = window.sbbsRadio;
            if (r && r.currentTrackFile) trackFile = r.currentTrackFile;
        }
        if (!trackFile || typeof window.parseID3v2 !== 'function') {
            // No parser available or no track — fall back to LRC
            fetchLyrics();
            return;
        }

        var url = './radio-stream/' + encodeURIComponent(trackFile);
        console.log('[viz] fetching ID3 metadata from', trackFile);

        // Range request: only need the first chunk for ID3 header
        fetch(url, { headers: { 'Range': 'bytes=0-' + (META_FETCH_BYTES - 1) } })
            .then(function (r) {
                if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
                return r.arrayBuffer();
            })
            .then(function (buf) {
                var tags = window.parseID3v2(buf);
                trackMeta = tags;
                setActiveCharacter(getCharacterForArtist(tags.artist));
                console.log('[viz] ID3 parsed:', tags.artist || '(none)',
                            '| genre:', tags.genre || '(none)',
                            '| SYLT lines:', tags.sylt.length,
                            '| art:', tags.picture ? 'yes' : 'no');

                // Use SYLT synced lyrics if present, otherwise fall back to LRC
                if (tags.sylt && tags.sylt.length > 0) {
                    lrcLines = tags.sylt;
                    lrcIndex = -1;
                    console.log('[viz] using SYLT lyrics (' + lrcLines.length + ' lines)');
                } else {
                    // No embedded lyrics — try external .lrc file
                    fetchLyrics();
                }

                // Show metadata HUD if we have any useful data
                var hasData = tags.artist || tags.composer || tags.genre || tags.year || tags.picture;
                if (hasData && isOpen) {
                    updateMetaHud(tags);
                }
            })
            .catch(function (err) {
                console.warn('[viz] ID3 fetch failed:', err);
                trackMeta = null;
                // Fallback to LRC lyrics
                fetchLyrics();
            });
    }

    function updateMetaHud(tags) {
        if (!elMetaHud) return;

        // Revoke previous art blob URL
        if (metaArtUrl) {
            URL.revokeObjectURL(metaArtUrl);
            metaArtUrl = '';
        }

        // Album art
        if (tags.picture && tags.picture.blob) {
            metaArtUrl = URL.createObjectURL(tags.picture.blob);
            elMetaArt.src = metaArtUrl;
            elMetaArt.parentElement.style.display = '';
        } else {
            elMetaArt.src = '';
            elMetaArt.parentElement.style.display = 'none';
        }

        // Title (use ID3 title or fall back to display name from radio)
        var title = tags.title || '';
        if (!title) {
            var radio = window.sbbsRadio;
            if (radio && radio.currentTrackFile) {
                title = radio.currentTrackFile.replace(/\.mp3$/i, '');
            }
        }
        if (elMetaTitle) elMetaTitle.textContent = title;

        // Populate or hide each row
        setMetaRow(elMetaArtist,   tags.artist);
        setMetaRow(elMetaComposer, tags.composer);
        setMetaRow(elMetaAlbum,    tags.album);
        setMetaRow(elMetaYear,     tags.year);
        setMetaRow(elMetaGenre,    tags.genre);

        // Restore the current expanded/minimized state
        elMetaHud.classList.toggle('is-mini', metaIsMinimized);
        var miniEl = document.getElementById('viz-meta-mini');
        if (miniEl) miniEl.hidden = !metaIsMinimized;
        elMetaHud.hidden = false;

        // Start alternation timer for the mini bar text
        startMetaAltTimer(tags);
        if (metaIsMinimized) updateMiniText();
    }

    function setMetaRow(valEl, text) {
        if (!valEl) return;
        var row = valEl.closest('.viz-meta-row');
        if (text) {
            valEl.textContent = text;
            if (row) row.hidden = false;
        } else {
            valEl.textContent = '';
            if (row) row.hidden = true;
        }
    }

    /* Toggle between expanded card and minimized single-line bar */
    function onMetaHudActivate(e) {
        if (!elMetaHud || elMetaHud.hidden) return;
        if (e.target.closest('button, a, input, select, label')) return;

        if (e.type === 'pointerup') {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
        } else if (e.type === 'click') {
            // Touch/pointer activation often emits a follow-up click; ignore the duplicate.
            if (Date.now() - metaToggleAt < 400) return;
        }

        metaToggleAt = Date.now();
        toggleMetaMini();
    }

    function toggleMetaMini() {
        if (!elMetaHud || elMetaHud.hidden) return;
        metaIsMinimized = !metaIsMinimized;
        var miniEl = document.getElementById('viz-meta-mini');
        if (metaIsMinimized) {
            elMetaHud.classList.add('is-mini');
            if (miniEl) miniEl.hidden = false;
            // Immediately set mini text
            updateMiniText();
        } else {
            elMetaHud.classList.remove('is-mini');
            if (miniEl) miniEl.hidden = true;
        }
    }

    /* Alternating mini-bar text: cycles artist / title every 4s */
    function startMetaAltTimer(tags) {
        if (metaAltTimer) clearInterval(metaAltTimer);
        metaAltState = 0;
        metaAltTimer = setInterval(function () {
            metaAltState = (metaAltState + 1) % 2;
            updateMiniText();
        }, 4000);
    }

    function updateMiniText() {
        var miniText = document.getElementById('viz-meta-mini-text');
        if (!miniText || !trackMeta) return;
        var artist = trackMeta.artist || '';
        var title  = trackMeta.title || '';
        if (!title) {
            var radio = window.sbbsRadio;
            if (radio && radio.currentTrackFile) {
                title = radio.currentTrackFile.replace(/\.mp3$/i, '');
            }
        }
        if (metaAltState === 0 && artist) {
            miniText.textContent = '\u266B ' + artist;  // ♫ Artist
        } else {
            miniText.textContent = '\u266A ' + title;   // ♪ Title
        }
    }

    function hideMetaHud(preserveMiniState) {
        if (!elMetaHud) return;
        elMetaHud.hidden = true;
        if (!preserveMiniState) metaIsMinimized = false;
        elMetaHud.classList.remove('is-mini');
        var miniEl = document.getElementById('viz-meta-mini');
        if (miniEl) miniEl.hidden = true;
        if (metaAltTimer) { clearInterval(metaAltTimer); metaAltTimer = null; }
        if (metaArtUrl) { URL.revokeObjectURL(metaArtUrl); metaArtUrl = ''; }
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

    function getLyricMouthState(now) {
        if (!lrcLines.length) {
            return {
                active: false,
                gate: 0,
                pulse: 0,
                wordRate: 0
            };
        }

        var ni = -1;
        var nextLineTime = Infinity;
        for (var i = lrcLines.length - 1; i >= 0; i--) {
            if (now >= lrcLines[i].time) {
                ni = i;
                if (i + 1 < lrcLines.length) nextLineTime = lrcLines[i + 1].time;
                break;
            }
        }

        if (ni < 0) {
            return {
                active: false,
                gate: 0,
                pulse: 0,
                wordRate: 0
            };
        }

        var line = lrcLines[ni];
        var words = line.text.split(/\s+/).filter(Boolean);
        var rawDuration = nextLineTime - line.time;
        if (!isFinite(rawDuration) || rawDuration <= 0) {
            rawDuration = Math.max(1.2, words.length * 0.42);
        }

        var activeDuration = Math.min(rawDuration, Math.max(1.15, words.length * 0.58));
        var elapsed = now - line.time;
        var release = 0.24;

        if (elapsed < -0.04 || elapsed > activeDuration + release) {
            return {
                active: false,
                gate: 0,
                pulse: 0,
                wordRate: 0
            };
        }

        var gate = 1;
        if (elapsed < 0.08) {
            gate = Math.max(0, elapsed / 0.08);
        } else if (elapsed > activeDuration - 0.18) {
            gate = Math.max(0, (activeDuration + release - elapsed) / (0.18 + release));
        }

        var wordRate = words.length ? (words.length / Math.max(0.45, activeDuration)) : 0;
        var wordPhase = Math.max(0, elapsed) * Math.max(1, wordRate);
        var pulse = Math.pow(Math.max(0, Math.sin(wordPhase * Math.PI)), 0.9);

        return {
            active: gate > 0,
            gate: Math.min(1, gate),
            pulse: pulse,
            wordRate: wordRate
        };
    }

    function syncLyrics() {
        // Bouncing ball karaoke system
        if (!karaokeCtx || !karaokeCanvas) return;
        var r = window.sbbsRadio;
        if (!r) return;

        var w = karaokeCanvas.width;
        var h = karaokeCanvas.height;
        var now = r.currentTime;

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
        if (!r) return;

        var w = karaokeCanvas.width;
        var h = karaokeCanvas.height;
        var now = r.currentTime;

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
        var secondsPerWord = words.length ? (lineDuration / words.length) : lineDuration;

        // Which word should be spawned?
        var wordIdx = Math.floor(progress * words.length);
        wordIdx = Math.min(wordIdx, words.length - 1);

        // Spawn new words when we reach them
        while (lastSpitWord < wordIdx && lastSpitWord < words.length - 1) {
            lastSpitWord++;
            spawnSpitWord(words[lastSpitWord], scheme, fontFamily, now, w, h, secondsPerWord);
        }

        // Render all particles
        renderSpitParticles(now, w, h, fontFamily, scheme);
        renderEyeLasers(now);
        renderWordExplosions(now);
    }

    function spawnSpitWord(text, scheme, fontFamily, time, w, h, secondsPerWord) {
        var projState = headProjectionState || buildProjectionState(w, h);
        var mouthPoint = eyeScreenPoints.mouth || projectHeadPoint(projState, 0, activeChar.mouth.y, activeChar.mouth.z, projState.pulse || 1);
        var spawnX = mouthPoint.x;
        var spawnY = mouthPoint.y;

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
            id: ++spitParticleSeq,
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
            fontFamily: fontFamily,
            secondsPerWord: secondsPerWord,
            laserTriggered: false,
            laserHitTime: 0
        });
    }

    function getSpitParticleRenderState(p, h, defaultFontFamily, defaultScheme) {
        var PARTICLE_LIFETIME = 3.0;
        var age = vizTime - p.spawnTime;
        var depthScale = 1 + p.z * 0.6;
        depthScale = Math.max(0.4, Math.min(2.5, depthScale));

        var TOLERANCE = Math.PI / 6;
        var absRot = Math.abs(p.headRotY);
        var horizScale = 1.0;
        if (absRot > TOLERANCE) {
            horizScale = Math.cos(absRot - TOLERANCE);
        }
        horizScale = Math.max(0.15, horizScale);

        var alpha = 1 - (age / PARTICLE_LIFETIME);
        alpha = Math.pow(Math.max(0, alpha), 0.7);
        var baseSize = Math.min(56, Math.max(28, h * 0.07));
        return {
            scheme: p.scheme || defaultScheme,
            fontFamily: p.fontFamily || defaultFontFamily,
            depthScale: depthScale,
            horizScale: horizScale,
            fontSize: baseSize * depthScale,
            alpha: alpha
        };
    }

    function spawnEyeLaser(target, now) {
        if (!laserEyesEnabled || !target || target.laserTriggered) return;

        var origins = [];
        var blinkLead = 0.05;
        var beamDuration = 0.12;
        var blinkTail = 0.09;
        var slowCadence = (target.secondsPerWord || 0) >= 0.42;

        if (slowCadence) {
            origins = ['left', 'right'];
        } else {
            origins = [laserEyeTurn];
            laserEyeTurn = laserEyeTurn === 'left' ? 'right' : 'left';
        }

        for (var i = 0; i < origins.length; i++) {
            var eyeName = origins[i];
            var origin = eyeScreenPoints[eyeName];
            if (!origin) continue;

            eyeBlinkState[eyeName].start = now;
            eyeBlinkState[eyeName].fire = now + blinkLead;
            eyeBlinkState[eyeName].end = now + blinkLead + blinkTail;

            eyeLasers.push({
                eyeName: eyeName,
                originX: origin.x,
                originY: origin.y,
                target: target,
                spawnTime: now,
                fireTime: now + blinkLead,
                duration: beamDuration
            });
        }

        target.laserTriggered = true;
        target.laserHitTime = now + blinkLead + beamDuration;
    }

    function spawnWordExplosion(target, now, renderState) {
        if (!karaokeCtx) return;

        var fontSize = (renderState && renderState.fontSize) ? renderState.fontSize : 36;
        var fontFamily = (renderState && renderState.fontFamily) ? renderState.fontFamily : LYRIC_FONTS[0];
        var scheme = (renderState && renderState.scheme) ? renderState.scheme : LYRIC_SCHEMES[0];
        var horizScale = (renderState && renderState.horizScale) ? renderState.horizScale : 1;
        var text = target.text || '';
        var chars = text.split('');
        var metrics = [];
        var totalWidth = 0;

        karaokeCtx.save();
        karaokeCtx.font = Math.round(fontSize) + 'px ' + fontFamily;
        for (var i = 0; i < chars.length; i++) {
            var char = chars[i];
            var width = karaokeCtx.measureText(char).width;
            metrics.push({ char: char, width: width });
            totalWidth += width;
        }
        karaokeCtx.restore();

        var cursor = -totalWidth / 2;
        for (var j = 0; j < metrics.length; j++) {
            var glyph = metrics[j];
            var centerOffset = cursor + glyph.width / 2;
            cursor += glyph.width;

            if (!glyph.char.trim()) continue;

            var spread = 0.65 + (Math.abs(centerOffset) / Math.max(20, totalWidth * 0.5));
            var glyphX = target.x + centerOffset * horizScale;
            var glyphY = target.y + (Math.random() - 0.5) * fontSize * 0.08;
            wordExplosions.push({
                kind: 'glyph',
                char: glyph.char,
                x: glyphX,
                y: glyphY,
                vx: centerOffset * 1.4 + (Math.random() - 0.5) * 110 * spread,
                vy: -120 - Math.random() * 160,
                rotation: (Math.random() - 0.5) * 0.5,
                vr: (Math.random() - 0.5) * 9,
                spawnTime: now,
                life: 0.65 + Math.random() * 0.3,
                fontSize: fontSize * (0.82 + Math.random() * 0.22),
                fontFamily: fontFamily,
                scheme: scheme
            });

            var crumbCount = 2 + Math.floor(Math.random() * 3);
            for (var c = 0; c < crumbCount; c++) {
                var angle = Math.random() * Math.PI * 2;
                var speed = 70 + Math.random() * 180;
                wordExplosions.push({
                    kind: 'crumb',
                    x: glyphX,
                    y: glyphY,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed - 40,
                    spawnTime: now,
                    life: 0.32 + Math.random() * 0.22,
                    size: 1.8 + Math.random() * 2.8,
                    color: c % 2 === 0 ? scheme.hi : scheme.glow
                });
            }
        }

        wordExplosions.push({
            kind: 'flash',
            x: target.x,
            y: target.y,
            spawnTime: now,
            life: 0.22,
            radius: Math.max(28, fontSize * 0.9),
            color: LASER_RED
        });
    }

    function renderEyeLasers(now) {
        if (!karaokeCtx || !eyeLasers.length) return;

        var activeLasers = [];
        for (var i = 0; i < eyeLasers.length; i++) {
            var laser = eyeLasers[i];
            if (now < laser.fireTime) {
                activeLasers.push(laser);
                continue;
            }
            var progress = (now - laser.fireTime) / laser.duration;
            if (progress >= 1) continue;
            progress = Math.max(0, progress);

            var targetX = laser.target ? laser.target.x : laser.originX;
            var targetY = laser.target ? laser.target.y : laser.originY;
            var endX = laser.originX + (targetX - laser.originX) * progress;
            var endY = laser.originY + (targetY - laser.originY) * progress;

            karaokeCtx.save();
            karaokeCtx.globalAlpha = 0.92 - progress * 0.25;
            karaokeCtx.lineCap = 'round';
            karaokeCtx.shadowColor = LASER_RED;
            karaokeCtx.shadowBlur = 16;

            karaokeCtx.strokeStyle = 'rgba(255,85,85,0.95)';
            karaokeCtx.lineWidth = 3.2;
            karaokeCtx.beginPath();
            karaokeCtx.moveTo(laser.originX, laser.originY);
            karaokeCtx.lineTo(endX, endY);
            karaokeCtx.stroke();

            karaokeCtx.shadowBlur = 8;
            karaokeCtx.strokeStyle = 'rgba(255,255,255,0.9)';
            karaokeCtx.lineWidth = 1.1;
            karaokeCtx.beginPath();
            karaokeCtx.moveTo(laser.originX, laser.originY);
            karaokeCtx.lineTo(endX, endY);
            karaokeCtx.stroke();

            karaokeCtx.beginPath();
            karaokeCtx.fillStyle = 'rgba(255,170,170,0.8)';
            karaokeCtx.arc(laser.originX, laser.originY, 3, 0, Math.PI * 2);
            karaokeCtx.fill();
            karaokeCtx.restore();

            activeLasers.push(laser);
        }

        eyeLasers = activeLasers;
    }

    function renderWordExplosions(now) {
        if (!karaokeCtx || !wordExplosions.length) return;

        var activeExplosions = [];
        for (var i = 0; i < wordExplosions.length; i++) {
            var fragment = wordExplosions[i];
            var age = now - fragment.spawnTime;
            if (age >= fragment.life) continue;

            var t = age / fragment.life;

            if (fragment.kind === 'flash') {
                karaokeCtx.save();
                karaokeCtx.globalAlpha = 0.8 * (1 - t);
                karaokeCtx.lineWidth = 2 + t * 2;
                karaokeCtx.strokeStyle = fragment.color;
                karaokeCtx.shadowColor = fragment.color;
                karaokeCtx.shadowBlur = 18;
                karaokeCtx.beginPath();
                karaokeCtx.arc(fragment.x, fragment.y, fragment.radius * (0.3 + t), 0, Math.PI * 2);
                karaokeCtx.stroke();
                karaokeCtx.restore();
                activeExplosions.push(fragment);
                continue;
            }

            var px = fragment.x + fragment.vx * age;
            var py = fragment.y + fragment.vy * age + 180 * t * t;
            var alpha = 1 - t;

            karaokeCtx.save();
            karaokeCtx.globalAlpha = alpha;

            if (fragment.kind === 'glyph') {
                karaokeCtx.translate(px, py);
                karaokeCtx.rotate(fragment.rotation + fragment.vr * age);
                karaokeCtx.font = Math.round(fragment.fontSize * (1 - t * 0.18)) + 'px ' + fragment.fontFamily;
                karaokeCtx.textAlign = 'center';
                karaokeCtx.textBaseline = 'middle';
                karaokeCtx.shadowColor = fragment.scheme.glow;
                karaokeCtx.shadowBlur = 14;
                karaokeCtx.fillStyle = fragment.scheme.hi;
                karaokeCtx.fillText(fragment.char, 0, 0);
                karaokeCtx.shadowBlur = 0;
                karaokeCtx.fillStyle = fragment.scheme.fg;
                karaokeCtx.globalAlpha = alpha * 0.65;
                karaokeCtx.fillText(fragment.char, 1, 1);
            } else {
                var size = fragment.size * (1 - t * 0.35);
                karaokeCtx.shadowColor = fragment.color;
                karaokeCtx.shadowBlur = 10;
                karaokeCtx.fillStyle = fragment.color;
                karaokeCtx.fillRect(px - size * 0.5, py - size * 0.5, size, size);
            }

            karaokeCtx.restore();
            activeExplosions.push(fragment);
        }

        wordExplosions = activeExplosions;
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
            var renderState = getSpitParticleRenderState(p, h, defaultFontFamily, defaultScheme);

            if (laserEyesEnabled && !p.laserTriggered && age >= PARTICLE_LIFETIME * 0.72) {
                spawnEyeLaser(p, now);
            }
            if (p.laserTriggered && now >= p.laserHitTime) {
                spawnWordExplosion(p, now, renderState);
                continue;
            }
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
            var depthScale = renderState.depthScale;
            var horizScale = renderState.horizScale;
            p.alpha = renderState.alpha;

            // Skip if off screen
            if (p.x < -100 || p.x > w + 100 || p.y < -100 || p.y > h + 100) {
                continue;
            }

            activeParticles.push(p);

            // Calculate font size with perspective - BIGGER base
            var fontSize = renderState.fontSize;

            // Render the word with 3D perspective transform
            karaokeCtx.save();
            karaokeCtx.translate(p.x, p.y);
            
            // Apply perspective skew - horizontal compression when sideways
            karaokeCtx.scale(horizScale, 1);
            
            // Mirror text only when VERY far turned (> 150 degrees with tolerance)
            // This prevents most backwards rendering due to our 30° tolerance
            var TOLERANCE = Math.PI / 6;
            var normalizedRot = ((p.headRotY % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
            var isFacingAway = normalizedRot > (Math.PI * 0.5 + TOLERANCE) && 
                               normalizedRot < (Math.PI * 1.5 - TOLERANCE);
            if (isFacingAway) {
                karaokeCtx.scale(-1, 1);  // mirror horizontally
            }

            // Set up text rendering - use particle's own font
            var scheme = renderState.scheme;
            var pFont = renderState.fontFamily;
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
        resetLyricFxState();
        updateFxHud();
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
        resetLyricFxState();
        updateFxHud();
        console.log('[viz] lyric mode set to:', lyricMode === LYRIC_MODE_BOUNCING ? 'bouncing ball' : 'spitting');
    }

    function toggleLaserEyes() {
        laserEyesEnabled = !laserEyesEnabled;
        eyeLasers = [];
        if (!laserEyesEnabled) {
            for (var i = 0; i < spitParticles.length; i++) {
                spitParticles[i].laserTriggered = false;
                spitParticles[i].laserHitTime = 0;
            }
        }
        updateFxHud();
        console.log('[viz] laser eyes:', laserEyesEnabled ? 'on' : 'off');
        return laserEyesEnabled;
    }

    function toggleWaveHead() {
        waveHeadEnabled = !waveHeadEnabled;
        updateFxHud();
        console.log('[viz] wave head:', waveHeadEnabled ? 'on' : 'off');
        return waveHeadEnabled;
    }

    // =========================================================
    // =========================================================
    //  Mobile Transport Controls
    // =========================================================
    // =========================================================
    //  Viz-local track picker (cannot reuse #radio-playlist-panel
    //  because on mobile it lives inside the collapsed navbar)
    // =========================================================
    var vizPlaylistEl = null;

    function toggleVizPlaylist() {
        var radio = window.sbbsRadio;
        if (radio && typeof radio.toggleLibraryPanel === 'function') {
            radio.toggleLibraryPanel();
        }
    }

    function pickTrackByName(filename) {
        // Dispatch event for radio.js to pick this track
        document.dispatchEvent(new CustomEvent('viz:picktrack', { detail: { name: filename } }));
    }

    function escHtml(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function wireTransportControls() {
        var vizPlay = document.getElementById('viz-play');
        var vizPrev = document.getElementById('viz-prev');
        var vizNext = document.getElementById('viz-next');
        var vizVol  = document.getElementById('viz-volume');
        var vizTrack = document.getElementById('viz-track-name');

        if (vizPlay) {
            vizPlay.addEventListener('click', function() {
                var radioPlay = document.getElementById('radio-play');
                if (radioPlay) radioPlay.click();
                setTimeout(updateTransportUI, 100);
            });
        }
        if (vizPrev) {
            vizPrev.addEventListener('click', function() {
                var radioPrev = document.getElementById('radio-prev');
                if (radioPrev) radioPrev.click();
            });
        }
        if (vizNext) {
            vizNext.addEventListener('click', function() {
                var radioNext = document.getElementById('radio-next');
                if (radioNext) radioNext.click();
            });
        }
        if (vizVol) {
            // Sync initial volume from radio
            var radioVol = document.getElementById('radio-volume');
            if (radioVol) vizVol.value = radioVol.value;
            vizVol.addEventListener('input', function() {
                if (radioVol) {
                    radioVol.value = vizVol.value;
                    radioVol.dispatchEvent(new Event('input'));
                }
            });
        }
        if (vizTrack) {
            vizTrack.addEventListener('click', function(e) {
                e.stopPropagation();
                toggleVizPlaylist();
            });
        }

        // Listen for play state changes
        document.addEventListener('radio:statechange', updateTransportUI);
    }

    function updateTransportUI() {
        var vizPlay = document.getElementById('viz-play');
        var vizTrack = document.getElementById('viz-track-name');
        var mobileIcon = document.getElementById('mobile-player-icon');
        var miniEq = document.getElementById('mobile-mini-eq');
        var radio = window.sbbsRadio;

        if (vizPlay) {
            vizPlay.textContent = (radio && radio.isPlaying) ? '❚❚' : '▶';
        }
        if (vizTrack && radio) {
            var name = radio.currentTrackTitle || radio.currentTrackFile || 'Select Track';
            name = name.substring(0, 35);
            vizTrack.textContent = '♫ ' + name;
        }

        // Toggle mobile icon: show mini-EQ when playing, musical note when stopped
        if (radio && radio.isPlaying) {
            if (mobileIcon) mobileIcon.style.display = 'none';
            if (miniEq) miniEq.style.display = 'inline-block';
        } else {
            if (mobileIcon) mobileIcon.style.display = 'inline-flex';
            if (miniEq) miniEq.style.display = 'none';
        }
    }

    //  Public API
    // =========================================================
    window.sbbsVisualizer = {
        show: show,
        hide: hide,
        toggle: toggle,
        toggleLyricMode: toggleLyricMode,
        setLyricMode: setLyricMode,
        toggleLaserEyes: toggleLaserEyes,
        toggleWaveHead: toggleWaveHead
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
