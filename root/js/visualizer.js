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

    // Shifty eye state — animated pupil offset for 'shifty' eyeBehavior
    var shiftyState = {
        targetX: 0, targetY: 0,    // where the pupils want to go
        currentX: 0, currentY: 0,  // smoothed current position
        timer: 0,                   // countdown to next shift
        dartTimer: 0,               // quick dart cooldown
        sideEyeBias: 0.65,         // probability of looking sideways vs random
        holdTime: 0                 // how long to hold current position
    };
    var headAmp       = 0;      // module-level amp for sub-renderers
    var headBass      = 0;      // module-level bass for sub-renderers
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
            name: 'Vektrax',   // The green skull — default / fallback character
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
            facialHair: null,
            // Chibi wireframe body — Vectrex laser-scan neon glow
            body: {
                color: '#33FF33',
                rgb: '51,255,51',
                // Skeleton keypoints in body-local coords (x, y)
                // y=0 is the neck (connects to chin), positive = downward
                // Body is roughly 0.7 head-heights tall (chibi proportions)
                skeleton: {
                    neck:       { x:  0.00, y: 0.00 },
                    shoulderL:  { x: -0.18, y: 0.06 },
                    shoulderR:  { x:  0.18, y: 0.06 },
                    elbowL:     { x: -0.24, y: 0.20 },
                    elbowR:     { x:  0.24, y: 0.20 },
                    handL:      { x: -0.20, y: 0.32 },
                    handR:      { x:  0.20, y: 0.32 },
                    hip:        { x:  0.00, y: 0.32 },
                    hipL:       { x: -0.10, y: 0.32 },
                    hipR:       { x:  0.10, y: 0.32 },
                    kneeL:      { x: -0.12, y: 0.46 },
                    kneeR:      { x:  0.12, y: 0.46 },
                    footL:      { x: -0.14, y: 0.58 },
                    footR:      { x:  0.14, y: 0.58 }
                },
                // Which joints connect via bone segments
                bones: [
                    ['neck', 'shoulderL'], ['neck', 'shoulderR'],
                    ['shoulderL', 'shoulderR'],
                    ['shoulderL', 'elbowL'], ['shoulderR', 'elbowR'],
                    ['elbowL', 'handL'], ['elbowR', 'handR'],
                    ['neck', 'hip'],
                    ['hip', 'hipL'], ['hip', 'hipR'],
                    ['hipL', 'kneeL'], ['hipR', 'kneeR'],
                    ['kneeL', 'footL'], ['kneeR', 'footR']
                ],
                lineWidth: 1.8,
                glowWidth: 6,
                scanSpeed: 0.003,    // beam scan speed for phosphor trail
                moves: ['idle_sway', 'two_step', 'running_man', 'cabbage_patch',
                         'robot', 'raise_the_roof', 'shuffle', 'disco_point']
            }
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
            eyeShape: 'square',  // 'round' (default) or 'square'
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
                { rx: -0.48, ry: 0.20, rz:    0.00, len: 1.10, color: '#FF55FF', width: 1.8, freq: 0.05 },
                { rx: -0.50, ry: 0.10, rz:    0.05, len: 1.25, color: '#55FFFF', width: 1.5, freq: 0.10 },
                { rx: -0.48, ry: 0.16, rz:    0.10, len: 1.15, color: '#AA55FF', width: 1.6, freq: 0.18 },
                { rx: -0.28, ry: 0.28, rz:    0.40, len: 1.00, color: '#55FF55', width: 1.4, freq: 0.25 },
                { rx: -0.22, ry: 0.30, rz:    0.42, len: 0.90, color: '#FF55AA', width: 1.3, freq: 0.35 },
                { rx: -0.50, ry: 0.04, rz: -0.08, len: 1.30, color: '#FFFF55', width: 1.5, freq: 0.07 },
                { rx: -0.18, ry: 0.30, rz:    0.42, len: 0.85, color: '#55AAFF', width: 1.4, freq: 0.42 },
                // Right side — mirror (mid→high freq)
                { rx:    0.48, ry: 0.20, rz:    0.00, len: 1.10, color: '#FF55FF', width: 1.8, freq: 0.50 },
                { rx:    0.50, ry: 0.10, rz:    0.05, len: 1.25, color: '#55FFFF', width: 1.5, freq: 0.58 },
                { rx:    0.48, ry: 0.16, rz:    0.10, len: 1.15, color: '#AA55FF', width: 1.6, freq: 0.65 },
                { rx:    0.28, ry: 0.28, rz:    0.40, len: 1.00, color: '#55FF55', width: 1.4, freq: 0.72 },
                { rx:    0.22, ry: 0.30, rz:    0.42, len: 0.90, color: '#FF55AA', width: 1.3, freq: 0.80 },
                { rx:    0.50, ry: 0.04, rz: -0.08, len: 1.30, color: '#FFFF55', width: 1.5, freq: 0.55 },
                { rx:    0.18, ry: 0.30, rz:    0.42, len: 0.85, color: '#55AAFF', width: 1.4, freq: 0.88 },
                // Top / crown — tighter coverage
                { rx: -0.08, ry: 0.50, rz:  0.05, len: 0.65, color: '#FF55FF', width: 1.3, freq: 0.30 },
                { rx:  0.08, ry: 0.50, rz:  0.05, len: 0.65, color: '#55FFFF', width: 1.3, freq: 0.38 },
                { rx:  0.00, ry: 0.52, rz:  0.02, len: 0.55, color: '#AA55FF', width: 1.4, freq: 0.45 },
                { rx: -0.15, ry: 0.46, rz:  0.00, len: 0.75, color: '#FFFF55', width: 1.2, freq: 0.22 },
                { rx:  0.15, ry: 0.46, rz:  0.00, len: 0.75, color: '#55FF55', width: 1.2, freq: 0.68 },
                { rx: -0.05, ry: 0.52, rz: -0.05, len: 0.50, color: '#FF55AA', width: 1.3, freq: 0.15 },
                { rx:  0.05, ry: 0.52, rz: -0.05, len: 0.50, color: '#55AAFF', width: 1.3, freq: 0.75 },
                // Back — draping down behind
                { rx: -0.12, ry: 0.36, rz: -0.38, len: 0.80, color: '#FF55FF', width: 1.2, freq: 0.12 },
                { rx:  0.12, ry: 0.36, rz: -0.38, len: 0.80, color: '#55FFFF', width: 1.2, freq: 0.62 },
                { rx:  0.00, ry: 0.40, rz: -0.42, len: 0.70, color: '#AA55FF', width: 1.3, freq: 0.40 },
                { rx: -0.20, ry: 0.28, rz: -0.36, len: 0.90, color: '#FFFF55', width: 1.3, freq: 0.08 },
                { rx:  0.20, ry: 0.28, rz: -0.36, len: 0.90, color: '#55FF55', width: 1.3, freq: 0.85 }
            ],
            hat: null,
            facialHair: null
        },

        crosswire: {
            name: 'Crosswire',
            // Blocky, slightly squarish head — yellow Vectrex vibe
            profile: [
                [0.00, -0.78], [0.24, -0.68], [0.40, -0.56],
                [0.50, -0.40], [0.53, -0.22], [0.52, -0.05],
                [0.50,  0.10], [0.48,  0.24], [0.46,  0.36],
                [0.43,  0.46], [0.38,  0.54], [0.28,  0.60],
                [0.00,  0.63]
            ],
            ringN: 16,
            eyes: {
                left:  { x: -0.17, y: -0.04, z: 0.46, r: 0.07 },
                right: { x:  0.17, y: -0.04, z: 0.46, r: 0.07 }
            },
            eyeColor: { hex: '#AA8833', rgb: '170,136,51' },
            eyeShape: 'round',
            mouth: { y: -0.50, hw: 0.22, z: 0.46, segs: 8, teeth: false },
            nose: {
                bridge: [[0, -0.14, 0.54], [0, -0.28, 0.57], [0, -0.32, 0.58]],
                base:   [[-0.05, -0.34, 0.52], [0, -0.32, 0.58], [0.05, -0.34, 0.52]]
            },
            wireColor: '#FFDD33',
            wireRGB:   '255,221,51',
            accentColor: '#FFAA00',
            accentRGB:   '255,170,0',
            eyebrows: {
                color: '#996633',
                rgb:   '153,102,51',
                width: 2.0,
                // Brow anchor points relative to each eye center
                // inner = toward nose, outer = toward temple
                innerOff: { dx:  0.00, dy: 0.06, dz: 0.02 },
                outerOff: { dx:  0.12, dy: 0.08, dz: 0.00 },
                thickness: 0.018   // vertical thickness of brow stroke
            },
            hair: null,
            hat: null,
            facialHair: null,
            // Chibi body: blue t-shirt, gray shorts, white tennis shoes
            body: {
                color: '#FFDD33',
                rgb: '255,221,51',
                skeleton: {
                    neck:       { x:  0.00, y: 0.00 },
                    shoulderL:  { x: -0.18, y: 0.06 },
                    shoulderR:  { x:  0.18, y: 0.06 },
                    elbowL:     { x: -0.24, y: 0.20 },
                    elbowR:     { x:  0.24, y: 0.20 },
                    handL:      { x: -0.20, y: 0.32 },
                    handR:      { x:  0.20, y: 0.32 },
                    hip:        { x:  0.00, y: 0.32 },
                    hipL:       { x: -0.10, y: 0.32 },
                    hipR:       { x:  0.10, y: 0.32 },
                    kneeL:      { x: -0.12, y: 0.46 },
                    kneeR:      { x:  0.12, y: 0.46 },
                    footL:      { x: -0.14, y: 0.58 },
                    footR:      { x:  0.14, y: 0.58 }
                },
                bones: [
                    ['neck', 'shoulderL'], ['neck', 'shoulderR'],
                    ['shoulderL', 'shoulderR'],
                    ['shoulderL', 'elbowL'], ['shoulderR', 'elbowR'],
                    ['elbowL', 'handL'], ['elbowR', 'handR'],
                    ['neck', 'hip'],
                    ['hip', 'hipL'], ['hip', 'hipR'],
                    ['hipL', 'kneeL'], ['hipR', 'kneeR'],
                    ['kneeL', 'footL'], ['kneeR', 'footR']
                ],
                lineWidth: 1.8,
                glowWidth: 6,
                scanSpeed: 0.003,
                moves: ['idle_sway', 'two_step', 'running_man', 'cabbage_patch', 'robot', 'raise_the_roof', 'shuffle', 'disco_point'],
                clothing: {
                    upper: { color: '#4499FF', rgb: '68,153,255' },
                    skin : { color: '#FFCC88', rgb: '255,204,136' },
                    torso: { color: '#4499FF', rgb: '68,153,255' },
                    lower: { color: '#8899AA', rgb: '136,153,170' },
                    feet : { color: '#CCDDFF', rgb: '204,221,255' }
                },
            }
        },

        cowboy: {
            name: 'Cowboy',
            // Similar to Crosswire but slightly rounder jaw
            profile: [
                [0.00, -0.78], [0.23, -0.69], [0.39, -0.56],
                [0.49, -0.40], [0.52, -0.22], [0.51, -0.05],
                [0.49,  0.10], [0.47,  0.24], [0.45,  0.36],
                [0.41,  0.47], [0.34,  0.55], [0.24,  0.61],
                [0.00,  0.64]
            ],
            ringN: 16,
            eyes: {
                left:  { x: -0.16, y: -0.03, z: 0.46, r: 0.065 },
                right: { x:  0.16, y: -0.03, z: 0.46, r: 0.065 }
            },
            eyeColor: { hex: '#332211', rgb: '51,34,17' },
            eyeOutlineColor: { hex: '#FFFFFF', rgb: '255,255,255' },
            eyeShape: 'round',
            mouth: { y: -0.52, hw: 0.20, z: 0.46, segs: 8,
                     teeth: false, bucktooth: true, bucktoothColor: '255,255,255' },
            nose: {
                bridge: [[0, -0.14, 0.54], [0, -0.28, 0.57], [0, -0.32, 0.58]],
                base:   [[-0.05, -0.34, 0.52], [0, -0.32, 0.58], [0.05, -0.34, 0.52]]
            },
            wireColor: '#FFDD33',
            wireRGB:   '255,221,51',
            accentColor: '#FFAA00',
            accentRGB:   '255,170,0',
            eyebrows: {
                color: '#FFFF55',
                rgb:   '255,255,85',
                width: 2.2,
                innerOff: { dx:  0.00, dy: 0.06, dz: 0.02 },
                outerOff: { dx:  0.11, dy: 0.07, dz: 0.00 },
                thickness: 0.020
            },
            hair: null,
            hat: {
                type: 'cowboy',
                color: '#AA6622',
                rgb:   '170,102,34',
                bandColor: '#664411',
                bandRGB:   '102,68,17'
            },
            facialHair: {
                type: 'moustache',
                color: '#FFFF55',
                rgb:   '255,255,85',
                width: 1.8,
                // Moustache spans from nose base down toward mouth corners
                spread: 0.22,   // how far out from center the ends reach
                droop:  0.06,   // how far below nose the ends hang
                curl:   0.02    // upward curl at tips (0 = straight down)
            },
            // Chibi body: plaid long-sleeve shirt, blue jeans, cowboy boots
            body: {
                color: '#FFDD33',
                rgb: '255,221,51',
                skeleton: {
                    neck:       { x:  0.00, y: 0.00 },
                    shoulderL:  { x: -0.18, y: 0.06 },
                    shoulderR:  { x:  0.18, y: 0.06 },
                    elbowL:     { x: -0.24, y: 0.20 },
                    elbowR:     { x:  0.24, y: 0.20 },
                    handL:      { x: -0.20, y: 0.32 },
                    handR:      { x:  0.20, y: 0.32 },
                    hip:        { x:  0.00, y: 0.32 },
                    hipL:       { x: -0.10, y: 0.32 },
                    hipR:       { x:  0.10, y: 0.32 },
                    kneeL:      { x: -0.12, y: 0.46 },
                    kneeR:      { x:  0.12, y: 0.46 },
                    footL:      { x: -0.14, y: 0.58 },
                    footR:      { x:  0.14, y: 0.58 }
                },
                bones: [
                    ['neck', 'shoulderL'], ['neck', 'shoulderR'],
                    ['shoulderL', 'shoulderR'],
                    ['shoulderL', 'elbowL'], ['shoulderR', 'elbowR'],
                    ['elbowL', 'handL'], ['elbowR', 'handR'],
                    ['neck', 'hip'],
                    ['hip', 'hipL'], ['hip', 'hipR'],
                    ['hipL', 'kneeL'], ['hipR', 'kneeR'],
                    ['kneeL', 'footL'], ['kneeR', 'footR']
                ],
                lineWidth: 1.8,
                glowWidth: 6,
                scanSpeed: 0.003,
                moves: ['idle_sway', 'two_step', 'running_man', 'cabbage_patch', 'robot', 'raise_the_roof', 'shuffle', 'disco_point'],
                clothing: {
                    upper: { color: '#CC6633', rgb: '204,102,51' },
                    skin:  { color: '#CC6633', rgb: '204,102,51' },
                    torso: { color: '#CC6633', rgb: '204,102,51' },
                    lower: { color: '#4477BB', rgb: '68,119,187' },
                    feet:  { color: '#AA7733', rgb: '170,119,51' }
                },
            }
        },

        floppydriveprincess: {
            name: 'Floppy Drive Princess',
            headShape: 'box',
            boxDims: { w: 0.48, h: 0.52, d: 0.28 },
            profile: null,
            ringN: 0,
            eyes: {
                left:  { x: -0.15, y: 0.12, z: 0.28, r: 0.075 },
                right: { x:  0.15, y: 0.12, z: 0.28, r: 0.075 }
            },
            mascara: true,
            eyeColor: { hex: '#55FF55', rgb: '85,255,85' },
            eyeOutlineColor: { hex: '#FF55FF', rgb: '255,85,255' },
            eyeShape: 'round',
            eyelashes: {
                count: 6,
                length: 0.055,
                color: '#FFFF55',
                rgb: '255,255,85',
                width: 1.0,
                reactive: true,
                bottom: true
            },
            // Drive slot mouth — wide rectangular opening
            mouth: { y: -0.12, hw: 0.36, z: 0.28, segs: 2,
                     teeth: false, slot: true },
            nose: null,
            wireColor: '#AAAAAA',
            wireRGB:   '170,170,170',
            accentColor: '#FF55FF',
            accentRGB:   '255,85,255',
            eyebrows: null,
            hair: null,
            hat: null,
            facialHair: null,
            ledIndicators: [
                { x: 0.34, y: 0.38, color: '#55FF55', rgb: '85,255,85',
                  mode: 'activity' },
                { x: 0.34, y: 0.30, color: '#FFAA00', rgb: '255,170,0',
                  mode: 'power' }
            ]
        },

        diskmchardy: {
            name: 'Disk McHardy',
            headShape: 'box',
            boxDims: { w: 0.46, h: 0.52, d: 0.06 },  // thin like a 3.5" disk
            boxStyle: 'floppy',  // triggers floppy-specific details
            profile: null,
            ringN: 0,
            eyes: {
                // Eyes sit on the label area of the front face
                left:  { x: -0.10, y: -0.02, z: 0.06, r: 0.055 },
                right: { x:  0.10, y: -0.02, z: 0.06, r: 0.055 }
            },
            eyeColor: { hex: '#000000', rgb: '0,0,0' },
            eyeOutlineColor: { hex: '#111155', rgb: '17,17,85' },
            eyeShape: 'round',
            mascara: false,
            eyelashes: null,
            // Smiley mouth — small happy curve on the label
            mouth: { y: -0.16, hw: 0.12, z: 0.06, segs: 8,
                     teeth: false, smiley: true },
            nose: null,
            wireColor: '#5555FF',
            wireRGB:   '85,85,255',
            accentColor: '#7777FF',
            accentRGB:   '119,119,255',
            eyebrows: null,
            hair: null,
            hat: null,
            facialHair: null,
            ledIndicators: null,
            shutter: {
                color: '#AAAAAA',
                rgb: '170,170,170',
                width: 0.28,      // width of the metal shutter
                yTop: 0.52,       // top of disk = top of shutter
                yBot: 0.30,       // bottom of shutter area
                holeRadius: 0.04  // read/write hole behind shutter
            },
            label: {
                color: '#FFFFFF',
                rgb: '255,255,255',
                top: 0.25,
                bot: -0.30,
                hw: 0.38
            }
        },
        clippy: {
            name: 'Clippy',
            headShape: 'paperclip',
            profile: null,
            ringN: 0,
            // Wire path: series of [x, y, z] control points defining the paperclip shape
            // Y is up (positive = up). Clippy stands vertically.
            wirePath: [
                // Classic paperclip silhouette — single continuous wire path.
                // Outer wire at z ≈ +0.015, inner wire at z ≈ -0.015
                // for 3D depth when the head rotates.
                //
                // Outer edges ±0.12, inner edges ±0.05
                [ 0.12, -0.60, 0.015], // 0: bottom-right tip (outer start)
                [ 0.12,  0.20, 0.015], // 1: right outer going up
                [ 0.12,  0.50, 0.015], // 2: right outer approaching top
                [ 0.08,  0.62, 0.015], // 3: outer top-right curve
                [ 0.00,  0.66, 0.015], // 4: outer top apex
                [-0.08,  0.62, 0.015], // 5: outer top-left curve
                [-0.12,  0.50, 0.015], // 6: left outer from top
                [-0.12,  0.00, 0.015], // 7: left outer mid
                [-0.12, -0.40, 0.015], // 8: left outer approaching bottom
                [-0.08, -0.54, 0.01],  // 9: outer bottom-left curve (transitioning)
                [ 0.00, -0.58, 0.00],  // 10: outer bottom apex (z crossing)
                [ 0.05, -0.50,-0.015], // 11: inner bottom-right (now behind)
                [ 0.05, -0.20,-0.015], // 12: inner left going up
                [ 0.05,  0.20,-0.015], // 13: inner left mid
                [ 0.05,  0.46,-0.015], // 14: inner left approaching top
                [ 0.03,  0.54,-0.01],  // 15: inner top-left curve (transitioning)
                [ 0.00,  0.56, 0.00],  // 16: inner top apex (z crossing)
                [-0.03,  0.54,-0.01],  // 17: inner top-right curve
                [-0.05,  0.46,-0.015], // 18: inner right from top
                [-0.05,  0.10,-0.015], // 19: inner right going down
                [-0.05, -0.30,-0.015], // 20: inner right lower
                [-0.05, -0.55,-0.015], // 21: bottom-left tip (inner end)
            ],
            wireThickness: 4.0,
            wireColor: '#AAAAAA',
            wireRGB: '170,170,170',
            accentColor: '#CCCCCC',
            accentRGB: '204,204,204',
            // Eyes sit on the top bend of the paperclip
            eyes: {
                left:  { x: -0.035, y: 0.58, z: 0.06, r: 0.042 },
                right: { x:  0.035, y: 0.58, z: 0.06, r: 0.042 }
            },
            eyeColor: { hex: '#000000', rgb: '0,0,0' },
            eyeOutlineColor: { hex: '#222222', rgb: '34,34,34' },
            eyeShape: 'clippy',  // special googly eyes
            mascara: false,
            eyelashes: null,
            // Clippy's eyebrows are very expressive
            eyebrows: {
                color: '#888888',
                rgb: '136,136,136',
                width: 2.0,
                innerOff: { dx: 0.00, dy: 0.035, dz: 0.03 },
                outerOff: { dx: 0.05, dy: 0.045, dz: 0.00 },
                thickness: 0.010
            },
            // Small mouth between/below eyes
            mouth: { y: 0.50, hw: 0.030, z: 0.06, segs: 6,
                     teeth: false, smiley: true },
            nose: null,
            hair: null,
            hat: null,
            facialHair: null,
            ledIndicators: null,
            shutter: null
        },
        gavinnewsom: {
            name: 'Gavin Newsom',
            // Strong jaw, chiseled face, high forehead, prominent chin
            profile: [
                [0.00, -0.82], [0.18, -0.74], [0.34, -0.64],
                [0.47, -0.50], [0.52, -0.36], [0.53, -0.22],
                [0.51, -0.08], [0.48,  0.06], [0.46,  0.18],
                [0.44,  0.30], [0.42,  0.40], [0.38,  0.50],
                [0.30,  0.58], [0.18,  0.64],
                [0.00,  0.67]
            ],
            ringN: 18,
            eyes: {
                left:  { x: -0.17, y: -0.04, z: 0.46, r: 0.065 },
                right: { x:  0.17, y: -0.04, z: 0.46, r: 0.065 }
            },
            eyeColor: { hex: '#332222', rgb: '51,34,34' },
            eyeOutlineColor: { hex: '#BB66CC', rgb: '187,102,204' },
            eyeShape: 'round',
            mascara: false,
            eyelashes: null,
            // Dark, prominent, well-groomed brows
            eyebrows: {
                color: '#442244',
                rgb:   '68,34,68',
                width: 2.4,
                innerOff: { dx:  0.00, dy: 0.055, dz: 0.02 },
                outerOff: { dx:  0.12, dy: 0.07, dz: 0.00 },
                thickness: 0.020
            },
            // Big toothy white smile — his signature
            mouth: { y: -0.52, hw: 0.25, z: 0.46, segs: 10,
                     teeth: true, teethColor: '255,255,255' },
            nose: {
                bridge: [[0, -0.14, 0.54], [0, -0.29, 0.58], [0, -0.34, 0.60]],
                base:   [[-0.06, -0.36, 0.53], [0, -0.34, 0.60], [0.06, -0.36, 0.53]]
            },
            wireColor: '#BB55CC',
            wireRGB:   '187,85,204',
            accentColor: '#DD88EE',
            accentRGB:   '221,136,238',
            // Slicked-back hair — swept backward from forehead, silver/gray
            // Short-to-medium strands originating at top/front, flowing toward -z
            hair: [
                // Front hairline — swept back from the forehead
                // dir flows strongly backward (-z) with slight lift then settling
                { rx: -0.16, ry: 0.28, rz:  0.44, len: 0.45, color: '#999999', width: 1.5, freq: 0.08, dir: { dx: -0.10, dy: -0.10, dz: -0.95 } },
                { rx: -0.08, ry: 0.32, rz:  0.46, len: 0.50, color: '#AAAAAA', width: 1.6, freq: 0.15, dir: { dx: -0.05, dy: -0.08, dz: -0.95 } },
                { rx:  0.00, ry: 0.34, rz:  0.46, len: 0.52, color: '#888888', width: 1.7, freq: 0.22, dir: { dx:  0.00, dy: -0.08, dz: -0.97 } },
                { rx:  0.08, ry: 0.32, rz:  0.46, len: 0.50, color: '#AAAAAA', width: 1.6, freq: 0.30, dir: { dx:  0.05, dy: -0.08, dz: -0.95 } },
                { rx:  0.16, ry: 0.28, rz:  0.44, len: 0.45, color: '#999999', width: 1.5, freq: 0.38, dir: { dx:  0.10, dy: -0.10, dz: -0.95 } },
                // Mid-crown — slightly longer, flowing back over the top
                { rx: -0.12, ry: 0.48, rz:  0.02, len: 0.55, color: '#777777', width: 1.4, freq: 0.20, dir: { dx: -0.06, dy: -0.08, dz: -0.95 } },
                { rx:  0.00, ry: 0.52, rz:  0.00, len: 0.58, color: '#888888', width: 1.5, freq: 0.28, dir: { dx:  0.00, dy: -0.10, dz: -0.95 } },
                { rx:  0.12, ry: 0.48, rz:  0.02, len: 0.55, color: '#777777', width: 1.4, freq: 0.35, dir: { dx:  0.06, dy: -0.08, dz: -0.95 } },
                // Side sweeps — temples, flowing back and slightly down
                { rx: -0.46, ry: 0.18, rz:  0.06, len: 0.35, color: '#666666', width: 1.3, freq: 0.42, dir: { dx: -0.25, dy: -0.40, dz: -0.70 } },
                { rx:  0.46, ry: 0.18, rz:  0.06, len: 0.35, color: '#666666', width: 1.3, freq: 0.50, dir: { dx:  0.25, dy: -0.40, dz: -0.70 } },
                { rx: -0.48, ry: 0.10, rz:  0.00, len: 0.30, color: '#555555', width: 1.2, freq: 0.55, dir: { dx: -0.35, dy: -0.55, dz: -0.50 } },
                { rx:  0.48, ry: 0.10, rz:  0.00, len: 0.30, color: '#555555', width: 1.2, freq: 0.60, dir: { dx:  0.35, dy: -0.55, dz: -0.50 } },
                // Back strands — drape down behind the skull
                { rx: -0.10, ry: 0.36, rz: -0.40, len: 0.40, color: '#777777', width: 1.3, freq: 0.65, dir: { dx: -0.05, dy: -0.55, dz: -0.75 } },
                { rx:  0.00, ry: 0.40, rz: -0.42, len: 0.42, color: '#888888', width: 1.4, freq: 0.70, dir: { dx:  0.00, dy: -0.60, dz: -0.65 } },
                { rx:  0.10, ry: 0.36, rz: -0.40, len: 0.40, color: '#777777', width: 1.3, freq: 0.75, dir: { dx:  0.05, dy: -0.55, dz: -0.75 } },
                { rx: -0.18, ry: 0.28, rz: -0.36, len: 0.38, color: '#666666', width: 1.2, freq: 0.80, dir: { dx: -0.12, dy: -0.65, dz: -0.55 } },
                { rx:  0.18, ry: 0.28, rz: -0.36, len: 0.38, color: '#666666', width: 1.2, freq: 0.85, dir: { dx:  0.12, dy: -0.65, dz: -0.55 } }
            ],
            hat: null,
            facialHair: null,
            ledIndicators: null,
            shutter: null,
            // Chibi body: slim build, dark gray suit, white shirt, dark gray tie
            body: {
                color: '#BB55CC',
                rgb: '187,85,204',
                skeleton: {
                    neck:       { x:  0.00, y: 0.00 },
                    shoulderL:  { x: -0.16, y: 0.06 },
                    shoulderR:  { x:  0.16, y: 0.06 },
                    elbowL:     { x: -0.22, y: 0.21 },
                    elbowR:     { x:  0.22, y: 0.21 },
                    handL:      { x: -0.18, y: 0.34 },
                    handR:      { x:  0.18, y: 0.34 },
                    hip:        { x:  0.00, y: 0.33 },
                    hipL:       { x: -0.08, y: 0.33 },
                    hipR:       { x:  0.08, y: 0.33 },
                    kneeL:      { x: -0.10, y: 0.48 },
                    kneeR:      { x:  0.10, y: 0.48 },
                    footL:      { x: -0.11, y: 0.60 },
                    footR:      { x:  0.11, y: 0.60 }
                },
                bones: [
                    ['neck', 'shoulderL'], ['neck', 'shoulderR'],
                    ['shoulderL', 'shoulderR'],
                    ['shoulderL', 'elbowL'], ['shoulderR', 'elbowR'],
                    ['elbowL', 'handL'], ['elbowR', 'handR'],
                    ['neck', 'hip'],
                    ['hip', 'hipL'], ['hip', 'hipR'],
                    ['hipL', 'kneeL'], ['hipR', 'kneeR'],
                    ['kneeL', 'footL'], ['kneeR', 'footR']
                ],
                lineWidth: 1.6,
                glowWidth: 5,
                scanSpeed: 0.003,
                moves: ['idle_sway', 'two_step', 'running_man', 'cabbage_patch', 'robot', 'raise_the_roof', 'shuffle', 'disco_point'],
                clothing: {
                    upper: { color: '#556677', rgb: '85,102,119' },
                    skin : { color: '#DDBB99', rgb: '221,187,153' },
                    torso: { color: '#BBCCDD', rgb: '187,204,221' },
                    lower: { color: '#556677', rgb: '85,102,119' },
                    feet : { color: '#334455', rgb: '51,68,85' }
                },
            }
        },
        donaldtrump: {
            name: 'Donald Trump',
            // Wider face, heavier jaw, broad forehead
            profile: [
                [0.00, -0.80], [0.20, -0.72], [0.36, -0.62],
                [0.48, -0.48], [0.54, -0.34], [0.56, -0.20],
                [0.54, -0.06], [0.52,  0.06], [0.50,  0.18],
                [0.48,  0.28], [0.46,  0.38], [0.42,  0.46],
                [0.36,  0.54], [0.25,  0.60],
                [0.00,  0.63]
            ],
            ringN: 18,
            eyes: {
                left:  { x: -0.18, y: -0.02, z: 0.48, r: 0.055 },
                right: { x:  0.18, y: -0.02, z: 0.48, r: 0.055 }
            },
            // Small squinty eyes
            eyeColor: { hex: '#445566', rgb: '68,85,102' },
            eyeOutlineColor: { hex: '#FF8833', rgb: '255,136,51' },
            eyeShape: 'round',
            mascara: false,
            eyelashes: null,
            // Prominent brows, often furrowed
            eyebrows: {
                color: '#CC9944',
                rgb:   '204,153,68',
                width: 2.6,
                innerOff: { dx:  0.00, dy: 0.05, dz: 0.02 },
                outerOff: { dx:  0.13, dy: 0.06, dz: 0.00 },
                thickness: 0.022
            },
            // Pucker mouth: ranges from tight pursed O to wide screaming oval
            mouth: { y: -0.54, hw: 0.22, z: 0.48, segs: 12,
                     teeth: false, pucker: true },
            nose: {
                bridge: [[0, -0.12, 0.56], [0, -0.26, 0.60], [0, -0.32, 0.62]],
                base:   [[-0.07, -0.35, 0.54], [0, -0.32, 0.62], [0.07, -0.35, 0.54]]
            },
            // ORANGE — the signature look
            wireColor: '#FF8833',
            wireRGB:   '255,136,51',
            accentColor: '#FFAA44',
            accentRGB:   '255,170,68',
            // Combover hair — wispy blonde/golden strands swept from left to right
            hair: [
                // Combover: originates from left temple/forehead, sweeps across to right
                // Hair peeks out from under the MAGA cap at the forehead and sides
                { rx: -0.44, ry: 0.18, rz:  0.05, len: 0.60, color: '#DDBB55', width: 1.5, freq: 0.05 },
                { rx: -0.28, ry: 0.26, rz:  0.44, len: 0.65, color: '#CCAA44', width: 1.6, freq: 0.10 },
                { rx: -0.24, ry: 0.28, rz:  0.46, len: 0.70, color: '#DDCC66', width: 1.7, freq: 0.15 },
                { rx: -0.18, ry: 0.30, rz:  0.48, len: 0.72, color: '#EEDD77', width: 1.8, freq: 0.20 },
                { rx: -0.12, ry: 0.32, rz:  0.48, len: 0.68, color: '#DDBB55', width: 1.7, freq: 0.25 },
                { rx: -0.06, ry: 0.34, rz:  0.48, len: 0.65, color: '#CCAA44', width: 1.6, freq: 0.30 },
                // Over the top and right — the swept part
                { rx:  0.00, ry: 0.36, rz:  0.46, len: 0.60, color: '#DDCC66', width: 1.5, freq: 0.35 },
                { rx:  0.08, ry: 0.34, rz:  0.46, len: 0.55, color: '#EEDD77', width: 1.4, freq: 0.40 },
                { rx:  0.14, ry: 0.30, rz:  0.44, len: 0.50, color: '#DDBB55', width: 1.3, freq: 0.45 },
                { rx:  0.20, ry: 0.26, rz:  0.42, len: 0.45, color: '#CCAA44', width: 1.2, freq: 0.50 },
                // Wispy flyaways that stick out from under the cap
                { rx: -0.48, ry: 0.12, rz:  0.02, len: 0.50, color: '#BBAA55', width: 1.1, freq: 0.55 },
                { rx:  0.44, ry: 0.18, rz:  0.04, len: 0.40, color: '#CCBB66', width: 1.0, freq: 0.60 },
                { rx: -0.08, ry: 0.50, rz: -0.04, len: 0.45, color: '#AA9944', width: 1.1, freq: 0.65 },
                { rx:  0.04, ry: 0.52, rz: -0.06, len: 0.42, color: '#BB9944', width: 1.0, freq: 0.70 },
                // Back strands peeking out from under the cap
                { rx: -0.20, ry: 0.28, rz: -0.36, len: 0.35, color: '#AA8833', width: 1.2, freq: 0.75 },
                { rx:  0.20, ry: 0.28, rz: -0.36, len: 0.35, color: '#AA8833', width: 1.2, freq: 0.80 },
                { rx: -0.10, ry: 0.34, rz: -0.40, len: 0.30, color: '#998833', width: 1.1, freq: 0.85 },
                { rx:  0.10, ry: 0.34, rz: -0.40, len: 0.30, color: '#998833', width: 1.1, freq: 0.90 }
            ],
            hat: {
                type: 'baseballcap',
                color: '#CC2222',
                rgb:   '204,34,34',
                // Brim color can differ from crown
                brimColor: '#CC2222',
                brimRGB:   '204,34,34',
                text: 'MAGA'
            },
            facialHair: null,
            ledIndicators: null,
            shutter: null,
            // Chibi body: stocky build, blue suit, white shirt, red tie, brown shoes
            body: {
                color: '#FF8833',
                rgb: '255,136,51',
                skeleton: {
                    neck:       { x:  0.00, y: 0.00 },
                    shoulderL:  { x: -0.22, y: 0.06 },
                    shoulderR:  { x:  0.22, y: 0.06 },
                    elbowL:     { x: -0.28, y: 0.20 },
                    elbowR:     { x:  0.28, y: 0.20 },
                    handL:      { x: -0.24, y: 0.33 },
                    handR:      { x:  0.24, y: 0.33 },
                    hip:        { x:  0.00, y: 0.34 },
                    hipL:       { x: -0.14, y: 0.34 },
                    hipR:       { x:  0.14, y: 0.34 },
                    kneeL:      { x: -0.14, y: 0.48 },
                    kneeR:      { x:  0.14, y: 0.48 },
                    footL:      { x: -0.15, y: 0.60 },
                    footR:      { x:  0.15, y: 0.60 }
                },
                bones: [
                    ['neck', 'shoulderL'], ['neck', 'shoulderR'],
                    ['shoulderL', 'shoulderR'],
                    ['shoulderL', 'elbowL'], ['shoulderR', 'elbowR'],
                    ['elbowL', 'handL'], ['elbowR', 'handR'],
                    ['neck', 'hip'],
                    ['hip', 'hipL'], ['hip', 'hipR'],
                    ['hipL', 'kneeL'], ['hipR', 'kneeR'],
                    ['kneeL', 'footL'], ['kneeR', 'footR']
                ],
                lineWidth: 2.0,
                glowWidth: 7,
                scanSpeed: 0.003,
                moves: ['idle_sway', 'two_step', 'running_man', 'cabbage_patch', 'robot', 'raise_the_roof', 'shuffle', 'disco_point'],
                clothing: {
                    upper: { color: '#3355AA', rgb: '51,85,170' },
                    skin : { color: '#FFBB88', rgb: '255,187,136' },
                    torso: { color: '#CC2222', rgb: '204,34,34' },
                    lower: { color: '#3355AA', rgb: '51,85,170' },
                    feet : { color: '#886633', rgb: '136,102,51' }
                },
            }
        },
        robocop: {
            name: 'RoboCop',
            // Smooth helmet dome — more spherical/uniform than a human skull
            // Slightly wider to convey the armored look
            profile: [
                [0.00, -0.78], [0.22, -0.70], [0.38, -0.60],
                [0.50, -0.46], [0.55, -0.30], [0.56, -0.14],
                [0.55,  0.02], [0.53,  0.16], [0.50,  0.30],
                [0.46,  0.42], [0.40,  0.52], [0.30,  0.58],
                [0.00,  0.62]
            ],
            ringN: 20,
            // "Eyes" define the visor band endpoints
            eyes: {
                left:  { x: -0.42, y: 0.04, z: 0.30, r: 0.04 },
                right: { x:  0.42, y: 0.04, z: 0.30, r: 0.04 }
            },
            eyeColor: { hex: '#FF3333', rgb: '255,51,51' },
            eyeOutlineColor: { hex: '#666666', rgb: '102,102,102' },
            eyeShape: 'visor',
            mascara: false,
            eyelashes: null,
            eyebrows: null,
            // Small stern human mouth — the exposed flesh below the helmet
            mouth: { y: -0.54, hw: 0.16, z: 0.52, segs: 8,
                     teeth: false },
            // Nose guard — the vertical center piece of the helmet
            nose: {
                bridge: [[0, 0.10, 0.57], [0, -0.10, 0.60], [0, -0.28, 0.58]],
                base:   [[-0.04, -0.32, 0.54], [0, -0.28, 0.58], [0.04, -0.32, 0.54]]
            },
            // Gunmetal steel with purple pixel-art tint
            wireColor: '#8866AA',
            wireRGB:   '136,102,170',
            accentColor: '#AA88CC',
            accentRGB:   '170,136,204',
            hair: null,
            hat: null,
            facialHair: null,
            // Helmet edge line (where armor meets exposed face)
            // Drawn as a special feature via chinGuard
            chinGuard: {
                y: -0.38,
                hw: 0.42,
                z: 0.46,
                color: '#666677',
                rgb: '102,102,119'
            },
            ledIndicators: null,
            shutter: null,
            // Chibi body: metallic armor plating, bulky mechanical build
            body: {
                color: '#8866AA',
                rgb: '136,102,170',
                skeleton: {
                    neck:       { x:  0.00, y: 0.00 },
                    shoulderL:  { x: -0.22, y: 0.05 },
                    shoulderR:  { x:  0.22, y: 0.05 },
                    elbowL:     { x: -0.28, y: 0.18 },
                    elbowR:     { x:  0.28, y: 0.18 },
                    handL:      { x: -0.24, y: 0.30 },
                    handR:      { x:  0.24, y: 0.30 },
                    hip:        { x:  0.00, y: 0.30 },
                    hipL:       { x: -0.12, y: 0.30 },
                    hipR:       { x:  0.12, y: 0.30 },
                    kneeL:      { x: -0.13, y: 0.44 },
                    kneeR:      { x:  0.13, y: 0.44 },
                    footL:      { x: -0.14, y: 0.56 },
                    footR:      { x:  0.14, y: 0.56 }
                },
                bones: [
                    ['neck', 'shoulderL'], ['neck', 'shoulderR'],
                    ['shoulderL', 'shoulderR'],
                    ['shoulderL', 'elbowL'], ['shoulderR', 'elbowR'],
                    ['elbowL', 'handL'], ['elbowR', 'handR'],
                    ['neck', 'hip'],
                    ['hip', 'hipL'], ['hip', 'hipR'],
                    ['hipL', 'kneeL'], ['hipR', 'kneeR'],
                    ['kneeL', 'footL'], ['kneeR', 'footR']
                ],
                lineWidth: 2.2,
                glowWidth: 8,
                scanSpeed: 0.002,
                moves: ['robot', 'two_step', 'shuffle', 'raise_the_roof'],
                clothing: {
                    upper: { color: '#99AACC', rgb: '153,170,204' },
                    skin : { color: '#99AACC', rgb: '153,170,204' },
                    torso: { color: '#7788BB', rgb: '119,136,187' },
                    lower: { color: '#7788AA', rgb: '119,136,170' },
                    feet : { color: '#667799', rgb: '102,119,153' }
                },
            }
        },
        data: {
            name: 'Data',
            // Clean, symmetrical android face — slightly narrower than average
            profile: [
                [0.00, -0.80], [0.20, -0.72], [0.36, -0.62],
                [0.46, -0.48], [0.50, -0.34], [0.52, -0.20],
                [0.50, -0.06], [0.48,  0.08], [0.46,  0.20],
                [0.43,  0.32], [0.40,  0.42], [0.35,  0.52],
                [0.26,  0.60], [0.14,  0.64],
                [0.00,  0.66]
            ],
            ringN: 18,
            // Android eyes — slightly larger, unblinking stare
            eyes: {
                left:  { x: -0.17, y: -0.03, z: 0.46, r: 0.075 },
                right: { x:  0.17, y: -0.03, z: 0.46, r: 0.075 }
            },
            // Distinctive bright green android eyes
            eyeColor: { hex: '#33DD33', rgb: '51,221,51' },
            eyeOutlineColor: { hex: '#55FF55', rgb: '85,255,85' },
            eyeShape: 'round',
            mascara: false,
            eyelashes: null,
            // Neat dark eyebrows — precise, slightly arched
            eyebrows: {
                color: '#333333',
                rgb:   '51,51,51',
                width: 2.0,
                innerOff: { dx:  0.00, dy: 0.055, dz: 0.02 },
                outerOff: { dx:  0.11, dy: 0.07, dz: 0.00 },
                thickness: 0.016
            },
            // Neutral mouth — Data rarely smiles
            mouth: { y: -0.52, hw: 0.18, z: 0.46, segs: 8,
                     teeth: false },
            nose: {
                bridge: [[0, -0.14, 0.54], [0, -0.28, 0.57], [0, -0.32, 0.58]],
                base:   [[-0.05, -0.34, 0.52], [0, -0.32, 0.58], [0.05, -0.34, 0.52]]
            },
            // Pale white with a hint of yellow — unnatural Soong-type complexion
            wireColor: '#E8E0C8',
            wireRGB:   '232,224,200',
            accentColor: '#F0E8D0',
            accentRGB:   '240,232,208',
            // Slicked-back dark hair — perfectly in place, never moves
            hairRigid: true,
            hair: [
                // Front hairline — swept straight back from the forehead
                // dir flows backward (-z) with slight downward (-y)
                { rx: -0.18, ry: 0.26, rz:  0.42, len: 0.38, color: '#222222', width: 1.7, freq: 0.10, dir: { dx: -0.10, dy: -0.20, dz: -0.90 } },
                { rx: -0.10, ry: 0.30, rz:  0.44, len: 0.40, color: '#1A1A1A', width: 1.8, freq: 0.18, dir: { dx: -0.05, dy: -0.15, dz: -0.95 } },
                { rx: -0.02, ry: 0.34, rz:  0.44, len: 0.42, color: '#222222', width: 1.9, freq: 0.25, dir: { dx:  0.00, dy: -0.15, dz: -0.95 } },
                { rx:  0.06, ry: 0.34, rz:  0.44, len: 0.42, color: '#1A1A1A', width: 1.9, freq: 0.32, dir: { dx:  0.02, dy: -0.15, dz: -0.95 } },
                { rx:  0.14, ry: 0.30, rz:  0.44, len: 0.40, color: '#222222', width: 1.8, freq: 0.40, dir: { dx:  0.08, dy: -0.15, dz: -0.95 } },
                { rx:  0.22, ry: 0.26, rz:  0.42, len: 0.36, color: '#1A1A1A', width: 1.7, freq: 0.48, dir: { dx:  0.12, dy: -0.20, dz: -0.85 } },
                // Crown — flowing backward over the top
                { rx: -0.14, ry: 0.48, rz:  0.04, len: 0.32, color: '#222222', width: 1.6, freq: 0.22, dir: { dx: -0.08, dy: -0.10, dz: -0.90 } },
                { rx: -0.04, ry: 0.52, rz:  0.02, len: 0.34, color: '#1A1A1A', width: 1.7, freq: 0.30, dir: { dx:  0.00, dy: -0.10, dz: -0.95 } },
                { rx:  0.08, ry: 0.52, rz:  0.02, len: 0.34, color: '#222222', width: 1.7, freq: 0.38, dir: { dx:  0.03, dy: -0.10, dz: -0.95 } },
                { rx:  0.18, ry: 0.46, rz:  0.04, len: 0.30, color: '#1A1A1A', width: 1.6, freq: 0.45, dir: { dx:  0.10, dy: -0.12, dz: -0.88 } },
                // Sides — flowing back and down from temples
                { rx: -0.44, ry: 0.16, rz:  0.08, len: 0.30, color: '#222222', width: 1.5, freq: 0.12, dir: { dx: -0.30, dy: -0.50, dz: -0.60 } },
                { rx:  0.44, ry: 0.16, rz:  0.08, len: 0.30, color: '#222222', width: 1.5, freq: 0.52, dir: { dx:  0.30, dy: -0.50, dz: -0.60 } },
                { rx: -0.46, ry: 0.08, rz:  0.02, len: 0.26, color: '#1A1A1A', width: 1.4, freq: 0.08, dir: { dx: -0.40, dy: -0.65, dz: -0.40 } },
                { rx:  0.46, ry: 0.08, rz:  0.02, len: 0.26, color: '#1A1A1A', width: 1.4, freq: 0.55, dir: { dx:  0.40, dy: -0.65, dz: -0.40 } },
                // Back of head — draping straight down
                { rx: -0.12, ry: 0.34, rz: -0.38, len: 0.28, color: '#222222', width: 1.5, freq: 0.60, dir: { dx: -0.05, dy: -0.60, dz: -0.70 } },
                { rx:  0.00, ry: 0.38, rz: -0.42, len: 0.30, color: '#1A1A1A', width: 1.6, freq: 0.65, dir: { dx:  0.00, dy: -0.65, dz: -0.60 } },
                { rx:  0.12, ry: 0.34, rz: -0.38, len: 0.28, color: '#222222', width: 1.5, freq: 0.70, dir: { dx:  0.05, dy: -0.60, dz: -0.70 } },
                { rx: -0.34, ry: 0.24, rz: -0.30, len: 0.26, color: '#1A1A1A', width: 1.4, freq: 0.75, dir: { dx: -0.15, dy: -0.70, dz: -0.50 } },
                { rx:  0.34, ry: 0.24, rz: -0.30, len: 0.26, color: '#1A1A1A', width: 1.4, freq: 0.80, dir: { dx:  0.15, dy: -0.70, dz: -0.50 } }
            ],
            hat: null,
            facialHair: null,
            ledIndicators: null,
            shutter: null,
            // Chibi body: TNG-era Starfleet uniform (gold/black ops division)
            body: {
                color: '#E8E0C8',
                rgb: '232,224,200',
                skeleton: {
                    neck:       { x:  0.00, y: 0.00 },
                    shoulderL:  { x: -0.18, y: 0.06 },
                    shoulderR:  { x:  0.18, y: 0.06 },
                    elbowL:     { x: -0.24, y: 0.20 },
                    elbowR:     { x:  0.24, y: 0.20 },
                    handL:      { x: -0.20, y: 0.32 },
                    handR:      { x:  0.20, y: 0.32 },
                    hip:        { x:  0.00, y: 0.32 },
                    hipL:       { x: -0.10, y: 0.32 },
                    hipR:       { x:  0.10, y: 0.32 },
                    kneeL:      { x: -0.12, y: 0.46 },
                    kneeR:      { x:  0.12, y: 0.46 },
                    footL:      { x: -0.14, y: 0.58 },
                    footR:      { x:  0.14, y: 0.58 }
                },
                bones: [
                    ['neck', 'shoulderL'], ['neck', 'shoulderR'],
                    ['shoulderL', 'shoulderR'],
                    ['shoulderL', 'elbowL'], ['shoulderR', 'elbowR'],
                    ['elbowL', 'handL'], ['elbowR', 'handR'],
                    ['neck', 'hip'],
                    ['hip', 'hipL'], ['hip', 'hipR'],
                    ['hipL', 'kneeL'], ['hipR', 'kneeR'],
                    ['kneeL', 'footL'], ['kneeR', 'footR']
                ],
                lineWidth: 1.8,
                glowWidth: 6,
                scanSpeed: 0.003,
                moves: ['idle_sway', 'two_step', 'running_man', 'cabbage_patch', 'robot', 'raise_the_roof', 'shuffle', 'disco_point'],
                clothing: {
                    upper: { color: '#FFCC33', rgb: '255,204,51' },
                    skin : { color: '#E8DDB8', rgb: '232,221,184' },
                    torso: { color: '#FFCC33', rgb: '255,204,51' },
                    lower: { color: '#2A2A3A', rgb: '42,42,58' },
                    feet : { color: '#2A2A3A', rgb: '42,42,58' }
                },
            }
        },
        cinder: {
            name: 'Cinder',
            // Feminine face: softer jawline, high cheekbones, delicate chin
            profile: [
                [0.00, -0.80], [0.14, -0.74], [0.28, -0.64],
                [0.40, -0.52], [0.46, -0.38], [0.48, -0.24],
                [0.47, -0.10], [0.45,  0.02], [0.44,  0.14],
                [0.42,  0.26], [0.38,  0.36], [0.32,  0.46],
                [0.24,  0.56], [0.14,  0.62],
                [0.00,  0.65]
            ],
            ringN: 20,
            eyes: {
                left:  { x: -0.16, y: -0.02, z: 0.46, r: 0.072 },
                right: { x:  0.16, y: -0.02, z: 0.46, r: 0.072 }
            },
            // Virtual Boy LIGHTRED — deep red pupils
            eyeColor: { hex: '#FF3333', rgb: '255,51,51' },
            eyeOutlineColor: { hex: '#FF6655', rgb: '255,102,85' },
            eyeShape: 'round',
            eyeBehavior: 'shifty',   // animated shifty/side-eye pupils
            mascara: true,           // cat-eye winged liner
            eyelashes: {
                count: 5,
                length: 0.05,
                color: '#FF4444',
                rgb: '255,68,68',
                width: 1.0,
                reactive: true,
                bottom: false
            },
            // Arched, expressive feminine brows
            eyebrows: {
                color: '#CC2222',
                rgb:   '204,34,34',
                width: 2.0,
                innerOff: { dx:  0.00, dy: 0.06, dz: 0.02 },
                outerOff: { dx:  0.12, dy: 0.075, dz: 0.00 },
                thickness: 0.016
            },
            // Soft mouth, slightly pouty, no teeth
            mouth: { y: -0.50, hw: 0.18, z: 0.46, segs: 10,
                     teeth: false },
            nose: {
                bridge: [[0, -0.14, 0.52], [0, -0.28, 0.56], [0, -0.33, 0.58]],
                base:   [[-0.05, -0.35, 0.52], [0, -0.33, 0.58], [0.05, -0.35, 0.52]]
            },
            // Virtual Boy LIGHTRED monochrome aesthetic
            wireColor: '#FF4444',
            wireRGB:   '255,68,68',
            accentColor: '#FF6655',
            accentRGB:   '255,102,85',
            // Full wavy yellow hair — longer strands with flowing directions
            hair: [
                // Front hairline — parted slightly left, rooted at forehead
                { rx: -0.20, ry: 0.28, rz:  0.42, len: 0.55, color: '#DDCC22', width: 1.8, freq: 0.05, dir: { dx: -0.40, dy: -0.30, dz: -0.70 } },
                { rx: -0.12, ry: 0.32, rz:  0.44, len: 0.60, color: '#EEDD33', width: 1.9, freq: 0.12, dir: { dx: -0.25, dy: -0.20, dz: -0.85 } },
                { rx: -0.04, ry: 0.34, rz:  0.44, len: 0.62, color: '#FFEE44', width: 2.0, freq: 0.20, dir: { dx: -0.10, dy: -0.15, dz: -0.90 } },
                { rx:  0.04, ry: 0.34, rz:  0.44, len: 0.60, color: '#EEDD33', width: 2.0, freq: 0.28, dir: { dx:  0.15, dy: -0.15, dz: -0.88 } },
                { rx:  0.12, ry: 0.32, rz:  0.44, len: 0.55, color: '#DDCC22', width: 1.9, freq: 0.35, dir: { dx:  0.30, dy: -0.20, dz: -0.80 } },
                { rx:  0.20, ry: 0.28, rz:  0.42, len: 0.50, color: '#CCBB11', width: 1.8, freq: 0.42, dir: { dx:  0.45, dy: -0.30, dz: -0.65 } },
                // Crown volume — flowing back with body
                { rx: -0.14, ry: 0.48, rz:  0.04, len: 0.65, color: '#FFEE44', width: 1.7, freq: 0.18, dir: { dx: -0.15, dy: -0.15, dz: -0.90 } },
                { rx:  0.00, ry: 0.52, rz:  0.02, len: 0.70, color: '#EEDD33', width: 1.8, freq: 0.25, dir: { dx:  0.00, dy: -0.12, dz: -0.95 } },
                { rx:  0.14, ry: 0.48, rz:  0.04, len: 0.65, color: '#DDCC22', width: 1.7, freq: 0.33, dir: { dx:  0.15, dy: -0.15, dz: -0.90 } },
                // Long side-flowing strands — rooted at temples, cascading down
                { rx: -0.44, ry: 0.20, rz:  0.10, len: 0.75, color: '#EEDD33', width: 1.6, freq: 0.08, dir: { dx: -0.50, dy: -0.70, dz: -0.20 } },
                { rx: -0.46, ry: 0.12, rz:  0.06, len: 0.80, color: '#CCBB11', width: 1.5, freq: 0.15, dir: { dx: -0.55, dy: -0.75, dz: -0.10 } },
                { rx: -0.46, ry: 0.04, rz:  0.00, len: 0.70, color: '#DDCC22', width: 1.4, freq: 0.22, dir: { dx: -0.45, dy: -0.80, dz: -0.05 } },
                { rx:  0.44, ry: 0.20, rz:  0.10, len: 0.75, color: '#EEDD33', width: 1.6, freq: 0.50, dir: { dx:  0.50, dy: -0.70, dz: -0.20 } },
                { rx:  0.46, ry: 0.12, rz:  0.06, len: 0.80, color: '#CCBB11', width: 1.5, freq: 0.58, dir: { dx:  0.55, dy: -0.75, dz: -0.10 } },
                { rx:  0.46, ry: 0.04, rz:  0.00, len: 0.70, color: '#DDCC22', width: 1.4, freq: 0.65, dir: { dx:  0.45, dy: -0.80, dz: -0.05 } },
                // Back cascade — rooted behind the skull
                { rx: -0.14, ry: 0.34, rz: -0.38, len: 0.70, color: '#EEDD33', width: 1.5, freq: 0.60, dir: { dx: -0.08, dy: -0.60, dz: -0.65 } },
                { rx:  0.00, ry: 0.38, rz: -0.42, len: 0.75, color: '#FFEE44', width: 1.6, freq: 0.68, dir: { dx:  0.00, dy: -0.65, dz: -0.55 } },
                { rx:  0.14, ry: 0.34, rz: -0.38, len: 0.70, color: '#EEDD33', width: 1.5, freq: 0.75, dir: { dx:  0.08, dy: -0.60, dz: -0.65 } },
                { rx: -0.34, ry: 0.24, rz: -0.32, len: 0.65, color: '#DDCC22', width: 1.4, freq: 0.80, dir: { dx: -0.20, dy: -0.65, dz: -0.50 } },
                { rx:  0.34, ry: 0.24, rz: -0.32, len: 0.65, color: '#DDCC22', width: 1.4, freq: 0.85, dir: { dx:  0.20, dy: -0.65, dz: -0.50 } }
            ],
            hairRigid: false,
            hat: null,
            facialHair: null,
            ledIndicators: null,
            shutter: null,
            chinGuard: null,
            label: 'CINDER'
        },
        metatron: {
            name: 'Metatron',
            headShape: 'metatronscube',
            // No face — pure sacred geometry symbol
            profile: null,
            ringN: 0,
            eyes: null,
            eyeColor: null,
            eyeOutlineColor: null,
            eyeShape: null,
            eyeBehavior: null,
            mascara: false,
            eyelashes: null,
            eyebrows: null,
            mouth: null,
            nose: null,
            // Vectrex CYAN / LIGHT CYAN palette
            wireColor: '#00CCCC',
            wireRGB:   '0,204,204',
            accentColor: '#55FFFF',
            accentRGB:   '85,255,255',
            hair: [],
            hairRigid: false,
            hat: null,
            facialHair: null,
            ledIndicators: null,
            shutter: null,
            chinGuard: null,
            label: 'METATRON'
        },

        inktain: {
            name: 'iNK\$tAiN',
            // Standard rotational head (human skull shape) — trapped inside a cage
            profile: [
                [0.00, -0.78], [0.20, -0.69], [0.35, -0.56],
                [0.46, -0.40], [0.51, -0.24], [0.50, -0.06],
                [0.47,  0.10], [0.45,  0.24], [0.43,  0.36],
                [0.38,  0.47], [0.30,  0.56], [0.18,  0.63],
                [0.00,  0.66]
            ],
            ringN: 16,
            eyes: {
                left:  { x: -0.17, y: -0.04, z: 0.44, r: 0.075 },
                right: { x:  0.17, y: -0.04, z: 0.44, r: 0.075 }
            },
            eyeColor: { hex: '#55FFFF', rgb: '85,255,255' },
            eyeOutlineColor: { hex: '#FFFFFF', rgb: '255,255,255' },
            eyeShape: 'round',
            eyeBehavior: null,
            mascara: false,
            eyelashes: null,
            eyebrows: null,
            mouth: { y: -0.50, hw: 0.22, z: 0.46, segs: 8, teeth: true },
            nose: {
                bridge: [[0, -0.14, 0.52], [0, -0.28, 0.56], [0, -0.32, 0.57]],
                base:   [[-0.05, -0.34, 0.50], [0, -0.32, 0.57], [0.05, -0.34, 0.50]]
            },
            // wireColor/RGB are fallbacks but CGA mode overrides per-line
            wireColor: '#AAAAAA',
            wireRGB:   '170,170,170',
            accentColor: '#FFFFFF',
            accentRGB:   '255,255,255',
            // CGA multicolor mode: every wireframe line draws in a cycling CGA color
            cgaWireframe: true,
            // Gray cage cube enclosure
            cage: { w: 0.62, h: 0.82, d: 0.48 },
            hair: null,
            hairRigid: false,
            hat: null,
            facialHair: null,
            ledIndicators: null,
            shutter: null,
            chinGuard: null,
            label: 'iNK$tAiN'
        },

        karen: {
            name: 'Karen',
            profile: [
                [0.00, -0.79], [0.16, -0.73], [0.30, -0.63],
                [0.42, -0.50], [0.48, -0.36], [0.50, -0.22],
                [0.49, -0.08], [0.47,  0.06], [0.45,  0.18],
                [0.43,  0.30], [0.39,  0.40], [0.33,  0.48],
                [0.25,  0.55], [0.15,  0.61],
                [0.00,  0.64]
            ],
            ringN: 20,
            eyes: {
                left:  { x: -0.16, y: -0.02, z: 0.46, r: 0.074 },
                right: { x:  0.16, y: -0.02, z: 0.46, r: 0.074 }
            },
            eyeColor: { hex: '#3388FF', rgb: '51,136,255' },
            eyeOutlineColor: { hex: '#88BBFF', rgb: '136,187,255' },
            eyeShape: 'round',
            eyeBehavior: null,
            mascara: true,
            eyelashes: {
                count: 6,
                length: 0.055,
                color: '#111111',
                rgb: '17,17,17',
                width: 1.1,
                reactive: true,
                bottom: true
            },
            eyebrows: {
                color: '#AA8833',
                rgb:   '170,136,51',
                width: 2.2,
                innerOff: { dx:  0.00, dy: 0.065, dz: 0.02 },
                outerOff: { dx:  0.13, dy: 0.08, dz: 0.00 },
                thickness: 0.018
            },
            mouth: { y: -0.50, hw: 0.19, z: 0.46, segs: 10,
                     teeth: false },
            nose: {
                bridge: [[0, -0.13, 0.52], [0, -0.27, 0.56], [0, -0.32, 0.57]],
                base:   [[-0.05, -0.34, 0.51], [0, -0.32, 0.57], [0.05, -0.34, 0.51]]
            },
            wireColor: '#DDAA88',
            wireRGB:   '221,170,136',
            accentColor: '#FF7799',
            accentRGB:   '255,119,153',
            hair: [
                { rx: -0.22, ry: 0.28, rz:    0.44, len: 0.40, color: '#EEDD55', width: 2.2, freq: 0.05, dir: { dx: -0.50, dy: -0.20, dz: -0.60 } },
                { rx: -0.14, ry: 0.32, rz:    0.46, len: 0.38, color: '#FFEE66', width: 2.4, freq: 0.10, dir: { dx: -0.30, dy: -0.15, dz: -0.75 } },
                { rx: -0.06, ry: 0.34, rz:    0.46, len: 0.36, color: '#FFEE77', width: 2.5, freq: 0.18, dir: { dx: -0.10, dy: -0.10, dz: -0.85 } },
                { rx:  0.02, ry: 0.34, rz:    0.46, len: 0.36, color: '#FFEE66', width: 2.5, freq: 0.24, dir: { dx:  0.05, dy: -0.10, dz: -0.88 } },
                { rx:  0.10, ry: 0.32, rz:    0.45, len: 0.38, color: '#EEDD55', width: 2.3, freq: 0.30, dir: { dx:  0.20, dy: -0.12, dz: -0.80 } },
                { rx:  0.18, ry: 0.28, rz:    0.44, len: 0.42, color: '#DDCC44', width: 2.2, freq: 0.36, dir: { dx:  0.40, dy: -0.18, dz: -0.65 } },
                { rx: -0.16, ry: 0.50, rz:  0.04, len: 0.55, color: '#FFEE66', width: 2.3, freq: 0.14, dir: { dx: -0.12, dy: -0.10, dz: -0.92 } },
                { rx:  0.00, ry: 0.54, rz:  0.02, len: 0.58, color: '#FFEE77', width: 2.4, freq: 0.22, dir: { dx:  0.00, dy: -0.08, dz: -0.95 } },
                { rx:  0.16, ry: 0.50, rz:  0.04, len: 0.55, color: '#EEDD55', width: 2.3, freq: 0.32, dir: { dx:  0.12, dy: -0.10, dz: -0.92 } },
                { rx: -0.46, ry: 0.22, rz:  0.10, len: 0.80, color: '#EEDD55', width: 2.0, freq: 0.08, dir: { dx: -0.52, dy: -0.72, dz: -0.15 } },
                { rx: -0.48, ry: 0.14, rz:  0.06, len: 0.90, color: '#DDCC44', width: 1.9, freq: 0.15, dir: { dx: -0.58, dy: -0.76, dz: -0.08 } },
                { rx: -0.48, ry: 0.06, rz:  0.00, len: 0.85, color: '#CCBB33', width: 1.8, freq: 0.22, dir: { dx: -0.50, dy: -0.80, dz: -0.02 } },
                { rx: -0.46, ry: -0.02, rz: -0.04, len: 0.78, color: '#EEDD55', width: 1.7, freq: 0.28, dir: { dx: -0.42, dy: -0.85, dz:  0.05 } },
                { rx:    0.46, ry: 0.22, rz:  0.10, len: 0.80, color: '#EEDD55', width: 2.0, freq: 0.48, dir: { dx:  0.52, dy: -0.72, dz: -0.15 } },
                { rx:    0.48, ry: 0.14, rz:  0.06, len: 0.90, color: '#DDCC44', width: 1.9, freq: 0.55, dir: { dx:  0.58, dy: -0.76, dz: -0.08 } },
                { rx:    0.48, ry: 0.06, rz:  0.00, len: 0.85, color: '#CCBB33', width: 1.8, freq: 0.62, dir: { dx:  0.50, dy: -0.80, dz: -0.02 } },
                { rx:    0.46, ry: -0.02, rz: -0.04, len: 0.78, color: '#EEDD55', width: 1.7, freq: 0.68, dir: { dx:  0.42, dy: -0.85, dz:  0.05 } },
                { rx: -0.18, ry: 0.34, rz: -0.40, len: 0.75, color: '#EEDD55', width: 2.0, freq: 0.58, dir: { dx: -0.10, dy: -0.58, dz: -0.68 } },
                { rx:  0.00, ry: 0.40, rz: -0.42, len: 0.80, color: '#FFEE66', width: 2.1, freq: 0.64, dir: { dx:  0.00, dy: -0.60, dz: -0.60 } },
                { rx:  0.18, ry: 0.34, rz: -0.40, len: 0.75, color: '#EEDD55', width: 2.0, freq: 0.72, dir: { dx:  0.10, dy: -0.58, dz: -0.68 } },
                { rx: -0.36, ry: 0.26, rz: -0.34, len: 0.72, color: '#DDCC44', width: 1.8, freq: 0.78, dir: { dx: -0.22, dy: -0.62, dz: -0.55 } },
                { rx:    0.36, ry: 0.26, rz: -0.34, len: 0.72, color: '#DDCC44', width: 1.8, freq: 0.84, dir: { dx:  0.22, dy: -0.62, dz: -0.55 } }
            ],
            hairRigid: false,
            hat: null,
            facialHair: null,
            ledIndicators: null,
            shutter: null,
            chinGuard: null,
            label: 'KAREN'
        },

        rally: {
            name: 'Rally',
            // Strong face — broad forehead, defined cheekbones, squared jaw
            profile: [
                [0.00, -0.78], [0.18, -0.71], [0.32, -0.60],
                [0.44, -0.46], [0.50, -0.32], [0.52, -0.16],
                [0.51, -0.02], [0.49,  0.10], [0.47,  0.22],
                [0.44,  0.34], [0.40,  0.44], [0.34,  0.52],
                [0.24,  0.58], [0.14,  0.63],
                [0.00,  0.66]
            ],
            ringN: 18,
            eyes: {
                left:  { x: -0.17, y: -0.03, z: 0.45, r: 0.072 },
                right: { x:  0.17, y: -0.03, z: 0.45, r: 0.072 }
            },
            // Deep brown eyes
            eyeColor: { hex: '#553311', rgb: '85,51,17' },
            eyeOutlineColor: { hex: '#AA8855', rgb: '170,136,85' },
            eyeShape: 'round',
            eyeBehavior: 'shifty',
            mascara: false,
            eyelashes: null,
            eyebrows: {
                color: '#332211',
                rgb:   '51,34,17',
                width: 2.4,
                innerOff: { dx:  0.00, dy: 0.06, dz: 0.02 },
                outerOff: { dx:  0.12, dy: 0.07, dz: 0.00 },
                thickness: 0.020
            },
            mouth: { y: -0.50, hw: 0.22, z: 0.46, segs: 8,
                     teeth: true },
            nose: {
                bridge: [[0, -0.12, 0.52], [0, -0.24, 0.55], [0, -0.30, 0.56]],
                base:   [[-0.07, -0.33, 0.50], [0, -0.30, 0.56], [0.07, -0.33, 0.50]]
            },
            // Rich dark skin tone wireframe
            wireColor: '#886644',
            wireRGB:   '136,102,68',
            accentColor: '#CC8866',
            accentRGB:   '204,136,102',
            // Afro hairstyle — rendered as a dome hat with honeycomb ribbing
            hair: null,
            hairRigid: false,
            hat: {
                type: 'afro',
                color: '#222222',
                rgb:   '34,34,34',
                // Afro dome parameters
                height: 0.62,       // dome height above hairline base
                radiusX: 0.68,      // side-to-side radius (wider than skull)
                radiusZ: 0.56,      // front-to-back radius
                rings: 8,           // horizontal ring count
                honeycombSegs: 14,  // segments per ring for honeycomb
                fluffiness: 0.05    // per-vertex random displacement for texture
            },
            facialHair: null,
            ledIndicators: null,
            shutter: null,
            chinGuard: null,
            label: 'RALLY',
            // Chibi body: African style shirt (red/green/yellow), baggy tan shorts, sandals
            body: {
                color: '#886644',
                rgb: '136,102,68',
                skeleton: {
                    neck:       { x:  0.00, y: 0.00 },
                    shoulderL:  { x: -0.18, y: 0.06 },
                    shoulderR:  { x:  0.18, y: 0.06 },
                    elbowL:     { x: -0.24, y: 0.20 },
                    elbowR:     { x:  0.24, y: 0.20 },
                    handL:      { x: -0.20, y: 0.32 },
                    handR:      { x:  0.20, y: 0.32 },
                    hip:        { x:  0.00, y: 0.32 },
                    hipL:       { x: -0.10, y: 0.32 },
                    hipR:       { x:  0.10, y: 0.32 },
                    kneeL:      { x: -0.12, y: 0.46 },
                    kneeR:      { x:  0.12, y: 0.46 },
                    footL:      { x: -0.14, y: 0.58 },
                    footR:      { x:  0.14, y: 0.58 }
                },
                bones: [
                    ['neck', 'shoulderL'], ['neck', 'shoulderR'],
                    ['shoulderL', 'shoulderR'],
                    ['shoulderL', 'elbowL'], ['shoulderR', 'elbowR'],
                    ['elbowL', 'handL'], ['elbowR', 'handR'],
                    ['neck', 'hip'],
                    ['hip', 'hipL'], ['hip', 'hipR'],
                    ['hipL', 'kneeL'], ['hipR', 'kneeR'],
                    ['kneeL', 'footL'], ['kneeR', 'footR']
                ],
                lineWidth: 1.8,
                glowWidth: 6,
                scanSpeed: 0.003,
                moves: ['idle_sway', 'two_step', 'running_man', 'cabbage_patch', 'robot', 'raise_the_roof', 'shuffle', 'disco_point'],
                clothing: {
                    upper: { color: '#CC3322', rgb: '204,51,34' },
                    skin : { color: '#AA7744', rgb: '170,119,68' },
                    torso: { color: '#33AA44', rgb: '51,170,68' },
                    lower: { color: '#CCAA66', rgb: '204,170,102' },
                    feet : { color: '#AA8844', rgb: '170,136,68' }
                },
            }
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

    // DEBUG: expose character switching for testing
    window._setChar = setActiveCharacter;
    window._CHARS = CHARACTERS;

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
        headAmp  = amp;
        headBass = bass;

        var pulse = 1 + bass * 0.06 + Math.sin(breathPhase) * 0.01;
        var projState = buildProjectionState(W, H);
        projState.pulse = pulse;
        headProjectionState = projState;

        function proj(x, y, z) {
            return projectHeadPoint(projState, x, y, z, pulse);
        }

        if (activeChar.eyes && activeChar.mouth) {
            eyeScreenPoints.left = projectHeadPoint(projState, activeChar.eyes.left.x, activeChar.eyes.left.y, activeChar.eyes.left.z, pulse);
            eyeScreenPoints.right = projectHeadPoint(projState, activeChar.eyes.right.x, activeChar.eyes.right.y, activeChar.eyes.right.z, pulse);
            eyeScreenPoints.mouth = projectHeadPoint(projState, 0, activeChar.mouth.y, activeChar.mouth.z, pulse);
        }

        wireCtx.lineCap = wireCtx.lineJoin = 'round';

        if (activeChar.headShape === 'box') {
            // --- Box wireframe (floppy drive etc.) ---
            drawBoxHead(activeChar, proj, amp, bass);
        } else if (activeChar.headShape === 'paperclip') {
            // --- Paperclip wireframe (Clippy) ---
            drawPaperclipBody(activeChar, proj, amp, bass);
        } else if (activeChar.headShape === 'metatronscube') {
            // --- Metatron's Cube sacred geometry ---
            drawMetatronsCube(activeChar, proj, amp, bass);
        } else {
            // --- Cage cube back layer (drawn behind head) ---
            if (activeChar.cage) drawCageCube(activeChar, proj, amp, bass);

            // --- Rotational profile rings ---
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

            // --- Horizontal rings ---
            wireCtx.shadowBlur  = 8 + bass * 14 + (waveHeadEnabled ? 8 : 0);
            if (activeChar.cgaWireframe) cgaLineIndex = 0;  // reset per frame

            for (var r = 0; r < rings.length; r++) {
                if (activeChar.cgaWireframe) {
                    var cc = getCgaColor();
                    wireCtx.shadowColor = cc.hex;
                    wireCtx.strokeStyle = 'rgba(' + cc.rgb + ',0.70)';
                    wireCtx.lineWidth   = 1.5;
                } else {
                    wireCtx.shadowColor = activeChar.wireColor;
                    wireCtx.strokeStyle = 'rgba(' + activeChar.wireRGB + ',0.55)';
                    wireCtx.lineWidth   = waveHeadEnabled ? 1.4 : 1.2;
                }
                wireCtx.beginPath();
                for (var i = 0; i < rings[r].length; i++) {
                    var pt = rings[r][i];
                    i === 0 ? wireCtx.moveTo(pt.x, pt.y) : wireCtx.lineTo(pt.x, pt.y);
                }
                wireCtx.closePath();
                wireCtx.stroke();
            }

            // --- Vertical ribs ---
            for (var s = 0; s < activeChar.ringN; s += 2) {
                if (activeChar.cgaWireframe) {
                    var cc = getCgaColor();
                    wireCtx.shadowColor = cc.hex;
                    wireCtx.strokeStyle = 'rgba(' + cc.rgb + ',0.50)';
                    wireCtx.lineWidth   = 1.1;
                } else {
                    wireCtx.strokeStyle = 'rgba(' + activeChar.wireRGB + ',0.30)';
                    wireCtx.lineWidth   = waveHeadEnabled ? 0.95 : 0.8;
                }
                wireCtx.beginPath();
                for (var r = 0; r < rings.length; r++) {
                    var pt = rings[r][s];
                    r === 0 ? wireCtx.moveTo(pt.x, pt.y) : wireCtx.lineTo(pt.x, pt.y);
                }
                wireCtx.stroke();
            }
        }

        // --- Face features (skip for symbol-based headShapes) ---
        if (activeChar.headShape !== 'metatronscube') {

        // --- Hair (behind/around skull) ---
        drawHair(activeChar, proj, amp, bass);

        // --- Hat ---
        drawHat(activeChar, proj, amp, bass);

        // --- Update shifty eyes (if character has that behavior) ---
        if (activeChar.eyeBehavior === 'shifty') {
            updateShiftyEyes(0.016);  // ~60fps dt
        } else {
            // Reset to center when not shifty
            shiftyState.currentX *= 0.85;
            shiftyState.currentY *= 0.85;
        }

        // --- Eyes ---
        drawEye(activeChar.eyes.left, proj, 'left', activeChar);
        drawEye(activeChar.eyes.right, proj, 'right', activeChar);

        // --- Eyebrows ---
        drawEyebrows(activeChar, proj, amp, bass);

        // --- Eyelashes ---
        drawEyelashes(activeChar, proj, amp, bass);

        // --- Nose ---
        drawNose(proj, activeChar);

        // --- Mouth ---
        drawMouth(proj, activeChar);

        // --- LEDs ---
        drawLEDs(activeChar, proj, amp, bass);

        // --- Shutter ---
        drawShutter(activeChar, proj, amp, bass);

        // --- Facial hair ---
        drawFacialHair(activeChar, proj, amp, bass);

        // --- Chin guard / helmet edge (RoboCop etc.) ---
        drawChinGuard(activeChar, proj, amp, bass);

        } // end face features

        // --- Cage cube front overlay (bars in front of face) ---
        if (activeChar.cage) {
            var cage = activeChar.cage;
            var pu = 1 + bass * 0.008;
            var cw2 = cage.w * pu, ch2 = cage.h * pu, cd2 = cage.d * pu;
            var barRGB = '150,150,150';
            var barAlpha = 0.38;
            wireCtx.lineWidth = 1.0;
            wireCtx.shadowBlur = 3;
            wireCtx.shadowColor = '#888888';
            // Front vertical bars overlay (drawn over face)
            var vBars = 5;
            for (var b = 1; b < vBars; b++) {
                var frac = b / vBars;
                var xOff = -cw2 + 2 * cw2 * frac;
                var ft = proj(xOff, ch2, cd2);
                var fb = proj(xOff, -ch2, cd2);
                wireCtx.strokeStyle = 'rgba(' + barRGB + ',' + barAlpha + ')';
                wireCtx.beginPath();
                wireCtx.moveTo(ft.x, ft.y);
                wireCtx.lineTo(fb.x, fb.y);
                wireCtx.stroke();
            }
            // Front horizontal bars overlay
            var hBars = 4;
            for (var b = 1; b < hBars; b++) {
                var frac = b / hBars;
                var yOff = -ch2 + 2 * ch2 * frac;
                var fl = proj(-cw2, yOff, cd2);
                var fr = proj(cw2, yOff, cd2);
                wireCtx.strokeStyle = 'rgba(' + barRGB + ',' + barAlpha + ')';
                wireCtx.beginPath();
                wireCtx.moveTo(fl.x, fl.y);
                wireCtx.lineTo(fr.x, fr.y);
                wireCtx.stroke();
            }
            wireCtx.shadowBlur = 0;
        }

        // --- Body (Vectrex laser-scan wireframe below head) ---
        if (activeChar.body) {
            drawBody(activeChar, projState, amp, bass);
        }
    }

    // Update shifty eye animation state
    function updateShiftyEyes(dt) {
        var s = shiftyState;
        s.timer -= dt;
        s.dartTimer -= dt;

        if (s.timer <= 0) {
            // Pick a new target gaze direction
            var r = Math.random();
            if (r < s.sideEyeBias) {
                // Side-eye: strong horizontal bias, slight vertical
                s.targetX = (Math.random() < 0.5 ? -1 : 1) * (0.55 + Math.random() * 0.40);
                s.targetY = (Math.random() - 0.5) * 0.25;
            } else if (r < s.sideEyeBias + 0.15) {
                // Look down (suspicious)
                s.targetX = (Math.random() - 0.5) * 0.3;
                s.targetY = -(0.3 + Math.random() * 0.4);
            } else {
                // Random wander
                s.targetX = (Math.random() - 0.5) * 0.7;
                s.targetY = (Math.random() - 0.5) * 0.5;
            }
            // Hold for a random duration, then shift again
            s.holdTime = 0.4 + Math.random() * 1.8;
            s.timer = s.holdTime;

            // Occasional very quick dart (nervous glance)
            if (s.dartTimer <= 0 && Math.random() < 0.3) {
                s.dartTimer = 2.5 + Math.random() * 4.0;  // cooldown before next dart
                s.holdTime = 0.08 + Math.random() * 0.12;  // very brief
                s.timer = s.holdTime;
            }
        }

        // Smooth interpolation — fast dart vs slow drift
        var isDarting = s.holdTime < 0.2;
        var lerpSpeed = isDarting ? 0.45 : 0.08;
        s.currentX += (s.targetX - s.currentX) * lerpSpeed;
        s.currentY += (s.targetY - s.currentY) * lerpSpeed;
    }

    // Get the pupil offset for shifty eyes (in eye-radius units)
    function getShiftyOffset(eyeName) {
        var s = shiftyState;
        // Both eyes shift together but the "far" eye leads for side-eye effect
        var xOff = s.currentX;
        var yOff = s.currentY;
        // Slight asymmetry: if looking left, left eye shifts more
        if (eyeName === 'left' && xOff < 0) xOff *= 1.12;
        if (eyeName === 'right' && xOff > 0) xOff *= 1.12;
        return { x: xOff, y: yOff };
    }

    function drawEye(eye, proj, eyeName, char) {
        char = char || activeChar;
        var blinkAmount = getEyeBlinkAmount(eyeName);
        var shape = char.eyeShape || 'round';

        if (shape === 'square') {
            drawSquareEye(eye, proj, eyeName, char, blinkAmount);
        } else if (shape === 'clippy') {
            drawGooglyEye(eye, proj, eyeName, char, blinkAmount);
        } else if (shape === 'visor') {
            // Visor is drawn once spanning both eyes — only draw on 'left' call
            if (eyeName === 'left') drawVisor(char, proj);
        } else {
            drawRoundEye(eye, proj, eyeName, char, blinkAmount);
        }
    }

    function drawRoundEye(eye, proj, eyeName, char, blinkAmount) {
        var segs = 12, pts = [];
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
        // Use separate outline color when defined (e.g. white outline + dark pupil)
        var oHex = (char.eyeOutlineColor ? char.eyeOutlineColor.hex : eHex);
        var oRGB = (char.eyeOutlineColor ? char.eyeOutlineColor.rgb : eRGB);
        if (char.cgaWireframe) {
            var ec = getCgaColor();
            oHex = ec.hex; oRGB = ec.rgb;
            eHex = ec.hex; eRGB = ec.rgb;
        }
        wireCtx.shadowBlur  = 10 + eyeGlow * 16;
        wireCtx.shadowColor = oHex;
        wireCtx.strokeStyle = 'rgba(' + oRGB + ',' + (0.7 + eyeGlow * 0.3) + ')';

        // Mascara effect: draw upper lid thicker, with winged outer corners
        if (char.mascara) {
            // Thicker upper lid arc (top half of the eye outline)
            wireCtx.lineWidth = 2.8 + eyeGlow * 1.2;
            wireCtx.beginPath();
            for (var i = 0; i < pts.length; i++) {
                // Upper half roughly: indices in top arc
                var angle01 = i / (pts.length - 1);  // 0..1 around circle
                if (angle01 <= 0.5) {
                    // Top half
                    i === 0 ? wireCtx.moveTo(pts[i].x, pts[i].y) : wireCtx.lineTo(pts[i].x, pts[i].y);
                }
            }
            wireCtx.stroke();

            // Thinner lower lid
            wireCtx.lineWidth = 1.2 + eyeGlow * 0.4;
            wireCtx.beginPath();
            for (var i = 0; i < pts.length; i++) {
                var angle01b = i / (pts.length - 1);
                if (angle01b >= 0.45) {
                    angle01b === 0.45 || (i > 0 && (i-1)/(pts.length-1) < 0.45)
                        ? wireCtx.moveTo(pts[i].x, pts[i].y)
                        : wireCtx.lineTo(pts[i].x, pts[i].y);
                }
            }
            wireCtx.lineTo(pts[0].x, pts[0].y);
            wireCtx.stroke();

            // Wing flick at outer corners (cat-eye)
            var isLeft = (eyeName === 'left');
            var outerSign = isLeft ? -1 : 1;
            var wingStart = proj(
                eye.x + outerSign * eye.r * 0.95,
                eye.y + eye.r * eyeScaleY * 0.25,
                eye.z
            );
            var wingEnd = proj(
                eye.x + outerSign * (eye.r * 1.35),
                eye.y + eye.r * eyeScaleY * 0.65,
                eye.z
            );
            wireCtx.lineWidth = 2.0 + eyeGlow * 0.6;
            wireCtx.beginPath();
            wireCtx.moveTo(wingStart.x, wingStart.y);
            wireCtx.lineTo(wingEnd.x, wingEnd.y);
            wireCtx.stroke();
        } else {
            wireCtx.lineWidth = 1.5 + eyeGlow;
            wireCtx.beginPath();
            for (var i = 0; i < pts.length; i++) {
                i === 0 ? wireCtx.moveTo(pts[i].x, pts[i].y) : wireCtx.lineTo(pts[i].x, pts[i].y);
            }
            wireCtx.stroke();
        }

        // Pupil dot — with optional shifty offset
        var shiftyOff = (char.eyeBehavior === 'shifty') ? getShiftyOffset(eyeName) : { x: 0, y: 0 };
        var pupilOffX = shiftyOff.x * eye.r * 0.55;  // max offset = 55% of eye radius
        var pupilOffY = shiftyOff.y * eye.r * 0.40;
        var c = proj(eye.x + pupilOffX, eye.y + pupilOffY, eye.z);
        if (blinkAmount < 0.72) {
            // Larger pupil for shifty eyes (more visible, more expressive)
            var pupilR = (char.eyeBehavior === 'shifty') ? (3.0 + eyeGlow * 3.5) : (2 + eyeGlow * 3);
            wireCtx.beginPath();
            wireCtx.arc(c.x, c.y, pupilR, 0, Math.PI * 2);
            wireCtx.fillStyle = 'rgba(' + eRGB + ',' + (0.5 + eyeGlow * 0.5) + ')';
            wireCtx.fill();
            // Shifty eyes: add a tiny bright highlight dot for life
            if (char.eyeBehavior === 'shifty') {
                wireCtx.beginPath();
                wireCtx.arc(c.x + pupilR * 0.3, c.y - pupilR * 0.3, pupilR * 0.25, 0, Math.PI * 2);
                wireCtx.fillStyle = 'rgba(255,255,255,0.6)';
                wireCtx.fill();
            }
        } else {
            wireCtx.beginPath();
            wireCtx.moveTo(c.x - eye.r * 30 * c.d * 0.22, c.y);
            wireCtx.lineTo(c.x + eye.r * 30 * c.d * 0.22, c.y);
            wireCtx.strokeStyle = 'rgba(' + eRGB + ',0.85)';
            wireCtx.lineWidth = 1.1 + eyeGlow * 0.5;
            wireCtx.stroke();
        }
    }

    function drawSquareEye(eye, proj, eyeName, char, blinkAmount) {
        var eHex = (char.eyeColor ? char.eyeColor.hex : char.wireColor);
        var eRGB = (char.eyeColor ? char.eyeColor.rgb : char.wireRGB);
        var r = eye.r;
        var hw = r * 1.15;   // half-width (slightly wider than tall)
        var hh = r * 0.9;    // half-height
        var squish = Math.max(0.06, 1 - blinkAmount * 0.92);  // blink squish

        // Outer box — white outline
        var tl = proj(eye.x - hw, eye.y + hh * squish, eye.z);
        var tr = proj(eye.x + hw, eye.y + hh * squish, eye.z);
        var br = proj(eye.x + hw, eye.y - hh * squish, eye.z);
        var bl = proj(eye.x - hw, eye.y - hh * squish, eye.z);

        wireCtx.shadowBlur  = 8 + eyeGlow * 12;
        wireCtx.shadowColor = '#FFFFFF';
        wireCtx.strokeStyle = 'rgba(255,255,255,' + (0.75 + eyeGlow * 0.25) + ')';
        wireCtx.lineWidth   = 1.4 + eyeGlow * 0.5;

        wireCtx.beginPath();
        wireCtx.moveTo(tl.x, tl.y);
        wireCtx.lineTo(tr.x, tr.y);
        wireCtx.lineTo(br.x, br.y);
        wireCtx.lineTo(bl.x, bl.y);
        wireCtx.closePath();
        wireCtx.stroke();

        if (blinkAmount >= 0.72) {
            // Blink: just a horizontal slit
            var c = proj(eye.x, eye.y, eye.z);
            wireCtx.beginPath();
            wireCtx.moveTo(tl.x, c.y);
            wireCtx.lineTo(tr.x, c.y);
            wireCtx.strokeStyle = 'rgba(255,255,255,0.85)';
            wireCtx.lineWidth = 1.2;
            wireCtx.stroke();
            return;
        }

        // Iris — smaller square, colored
        var irisScale = 0.55;
        var iw = hw * irisScale;
        var ih = hh * irisScale * squish;
        var itl = proj(eye.x - iw, eye.y + ih, eye.z);
        var itr = proj(eye.x + iw, eye.y + ih, eye.z);
        var ibr = proj(eye.x + iw, eye.y - ih, eye.z);
        var ibl = proj(eye.x - iw, eye.y - ih, eye.z);

        wireCtx.shadowBlur  = 10 + eyeGlow * 14;
        wireCtx.shadowColor = eHex;
        wireCtx.strokeStyle = 'rgba(' + eRGB + ',' + (0.7 + eyeGlow * 0.3) + ')';
        wireCtx.lineWidth   = 1.3 + eyeGlow * 0.4;

        wireCtx.beginPath();
        wireCtx.moveTo(itl.x, itl.y);
        wireCtx.lineTo(itr.x, itr.y);
        wireCtx.lineTo(ibr.x, ibr.y);
        wireCtx.lineTo(ibl.x, ibl.y);
        wireCtx.closePath();
        wireCtx.stroke();

        // Pupil — smallest square, filled
        var pupilScale = 0.25;
        var pw = hw * pupilScale;
        var ph = hh * pupilScale * squish;
        var ptl = proj(eye.x - pw, eye.y + ph, eye.z);
        var ptr = proj(eye.x + pw, eye.y + ph, eye.z);
        var pbr = proj(eye.x + pw, eye.y - ph, eye.z);
        var pbl = proj(eye.x - pw, eye.y - ph, eye.z);

        wireCtx.shadowBlur  = 6 + eyeGlow * 8;
        wireCtx.shadowColor = eHex;
        wireCtx.fillStyle = 'rgba(' + eRGB + ',' + (0.45 + eyeGlow * 0.55) + ')';

        wireCtx.beginPath();
        wireCtx.moveTo(ptl.x, ptl.y);
        wireCtx.lineTo(ptr.x, ptr.y);
        wireCtx.lineTo(pbr.x, pbr.y);
        wireCtx.lineTo(pbl.x, pbl.y);
        wireCtx.closePath();
        wireCtx.fill();
    }

    function drawNose(proj, char) {
        char = char || activeChar;
        if (!char.nose) return;
        wireCtx.shadowBlur  = 5;
        if (char.cgaWireframe) {
            var nc = getCgaColor();
            wireCtx.shadowColor = nc.hex;
            wireCtx.strokeStyle = 'rgba(' + nc.rgb + ',0.55)';
        } else {
            wireCtx.shadowColor = char.wireColor;
            wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.35)';
        }
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

        // Drive slot variant (floppy drive mouth)
        if (mth.slot) {
            drawDriveSlot(proj, char, mth);
            return;
        }

        // Smiley mouth variant (simple curved smile on label)
        if (mth.smiley) {
            drawSmileyMouth(proj, char, mth);
            return;
        }

        // Pucker mouth variant (pursed O → screaming oval)
        if (mth.pucker) {
            drawPuckerMouth(proj, char, mth);
            return;
        }

        var upper = [], lower = [];

        for (var i = 0; i <= mth.segs; i++) {
            var t    = (i / mth.segs) * 2 - 1;  // -1…1
            var curv = 1 - t * t;                 // parabola
            var xp   = t * mth.hw;
            upper.push(proj(xp, mth.y + open * curv + 0.01 * curv, mth.z));
            lower.push(proj(xp, mth.y - open * curv - 0.01 * curv, mth.z));
        }

        wireCtx.shadowBlur  = 6 + mouthOpen * 16;
        if (char.cgaWireframe) {
            var mc1 = getCgaColor();
            wireCtx.shadowColor = mc1.hex;
            wireCtx.strokeStyle = 'rgba(' + mc1.rgb + ',' + (0.7 + mouthOpen * 0.3) + ')';
        } else {
            wireCtx.shadowColor = char.accentColor;
            wireCtx.strokeStyle = 'rgba(' + char.accentRGB + ',' + (0.6 + mouthOpen * 0.4) + ')';
        }
        wireCtx.lineWidth   = 1.5 + mouthOpen;

        stroke(upper);
        if (char.cgaWireframe) {
            var mc2 = getCgaColor();
            wireCtx.shadowColor = mc2.hex;
            wireCtx.strokeStyle = 'rgba(' + mc2.rgb + ',' + (0.7 + mouthOpen * 0.3) + ')';
        }
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

        // Bucktooth (two big front teeth hanging from upper lip)
        if (mth.bucktooth && open > 0.008) {
            var btRGB = mth.bucktoothColor || '255,255,255';
            var btAlpha = Math.min(0.95, open * 6);
            var btHang = open * 0.65 + 0.012;  // how far they hang down
            var btWidth = mth.hw * 0.18;        // width of each tooth
            var btGap   = mth.hw * 0.04;        // gap between teeth

            wireCtx.shadowColor = 'rgba(' + btRGB + ',1)';
            wireCtx.shadowBlur  = 6 + mouthOpen * 8;

            // Left buck tooth
            var ltl = proj(-btGap - btWidth, mth.y + 0.005, mth.z);
            var ltr = proj(-btGap,           mth.y + 0.005, mth.z);
            var lbr = proj(-btGap,           mth.y - btHang, mth.z);
            var lbl = proj(-btGap - btWidth, mth.y - btHang, mth.z);

            wireCtx.strokeStyle = 'rgba(' + btRGB + ',' + btAlpha + ')';
            wireCtx.lineWidth = 1.2;
            wireCtx.beginPath();
            wireCtx.moveTo(ltl.x, ltl.y);
            wireCtx.lineTo(ltr.x, ltr.y);
            wireCtx.lineTo(lbr.x, lbr.y);
            wireCtx.lineTo(lbl.x, lbl.y);
            wireCtx.closePath();
            wireCtx.stroke();
            wireCtx.fillStyle = 'rgba(' + btRGB + ',' + (btAlpha * 0.3) + ')';
            wireCtx.fill();

            // Right buck tooth
            var rtl = proj(btGap,           mth.y + 0.005, mth.z);
            var rtr = proj(btGap + btWidth, mth.y + 0.005, mth.z);
            var rbr = proj(btGap + btWidth, mth.y - btHang, mth.z);
            var rbl = proj(btGap,           mth.y - btHang, mth.z);

            wireCtx.beginPath();
            wireCtx.moveTo(rtl.x, rtl.y);
            wireCtx.lineTo(rtr.x, rtr.y);
            wireCtx.lineTo(rbr.x, rbr.y);
            wireCtx.lineTo(rbl.x, rbl.y);
            wireCtx.closePath();
            wireCtx.stroke();
            wireCtx.fillStyle = 'rgba(' + btRGB + ',' + (btAlpha * 0.3) + ')';
            wireCtx.fill();
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

            // Flow direction: if strand has dir {dx,dy,dz}, follow that vector.
            // Otherwise default to hanging down with slight outward drift.
            var outward = (h.rx >= 0) ? 1 : -1;
            var dirX, dirY, dirZ;
            if (h.dir) {
                dirX = h.dir.dx;
                dirY = h.dir.dy;
                dirZ = h.dir.dz;
            } else {
                // Legacy: hang down, drift outward
                dirX = h.rx * 0.15;   // outward drift per unit length
                dirY = -1.0;          // straight down
                dirZ = 0;
            }
            // Normalize direction so len means actual strand length
            var dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
            var ndx = dirX / dirLen;
            var ndy = dirY / dirLen;
            var ndz = dirZ / dirLen;

            var phase = t * 1.5 + i * 0.9;
            var breathSway = Math.sin(breathPhase + i * 0.3) * 0.012;

            // Build segmented strand following the flow direction
            var pts = [root];
            for (var s = 1; s <= HAIR_SEGS; s++) {
                var frac = s / HAIR_SEGS;  // 0..1 along strand length

                // Base position: follow direction vector from root
                var travel = h.len * frac;
                // Add gravity pull that increases along the strand
                var gravityPull = h.dir ? frac * frac * 0.15 : 0;  // directed strands get gentle gravity droop
                var baseX = h.rx + ndx * travel;
                var baseY = h.ry + ndy * travel - gravityPull;
                var baseZ = h.rz + ndz * travel + (char.hairRigid ? 0 : Math.sin(phase * 0.3 + frac) * 0.02);

                // Frequency-driven waveform displacement
                var waveSpeed = 2.0 + freqPos * 6.0;
                var waveAmp = freqVal * (0.06 + (1 - freqPos) * 0.10);
                var wavePropagation = frac * 3.0;
                var wave = Math.sin(t * waveSpeed + wavePropagation + i * 1.1) * waveAmp;

                // Bass thump: sharp displacement that decays along length
                var bassKick = bass * 0.08 * Math.sin(phase * 0.7) * (0.3 + frac * 0.7);

                // Rigid hair: suppress all music-reactive motion
                if (char.hairRigid) {
                    wave = 0; bassKick = 0; breathSway = 0;
                }

                // Perpendicular displacement (wave mostly sideways relative to strand)
                var perpX = wave * outward + bassKick + breathSway * frac;
                var perpZ = char.hairRigid ? 0 : Math.cos(t * waveSpeed * 0.7 + wavePropagation) * waveAmp * 0.4;

                pts.push(proj(baseX + perpX, baseY, baseZ + perpZ));
            }

            // Glow intensity scales with frequency energy
            var glowBoost = char.hairRigid ? 0 : freqVal * 12;
            wireCtx.strokeStyle = h.color;
            wireCtx.shadowColor = h.color;
            wireCtx.shadowBlur  = 4 + (char.hairRigid ? 2 : bass * 8 + glowBoost);
            wireCtx.lineWidth   = (h.width || 1.2) + (char.hairRigid ? 0 : freqVal * 0.6);
            wireCtx.globalAlpha = char.hairRigid ? 0.80 : 0.65 + freqVal * 0.35;

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

    function drawEyebrows(char, proj, amp, bass) {
        if (!char.eyebrows) return;
        var brow = char.eyebrows;
        var eyes = char.eyes;
        var t = performance.now() * 0.001;

        // Expressiveness drivers
        // Bass → brows raise (surprise).  Amp → inner brows dip (intensity).
        // Vocal presence drives asymmetry for "skeptical" look.
        var bassLift  = bass * 0.045;            // raise both brows on bass hits
        var ampFurrow = amp * 0.025;             // inner ends dip with loudness
        var breathBob = Math.sin(breathPhase) * 0.004;  // subtle idle motion

        // Slow emotional drift — brows cycle through moods over ~8 seconds
        var mood = Math.sin(t * 0.8) * 0.5 + 0.5;  // 0..1
        var moodLift  = mood * 0.015;                 // calm → raised
        var moodInner = (1 - mood) * 0.012;           // intense → furrowed

        // Frequency reactivity: map left brow to low freq, right to mid
        var freqL = getFreqSample(0.12);  // sub-bass
        var freqR = getFreqSample(0.45);  // mid
        var freqLiftL = freqL * 0.02;
        var freqLiftR = freqR * 0.02;

        // Draw each brow
        var sides = [
            { eye: eyes.left,  sign: -1, freqLift: freqLiftL },
            { eye: eyes.right, sign:  1, freqLift: freqLiftR }
        ];

        wireCtx.lineCap = 'round';

        for (var si = 0; si < sides.length; si++) {
            var s = sides[si];
            var ex = s.eye.x;
            var ey = s.eye.y;
            var ez = s.eye.z;

            // Inner anchor (toward nose) — dips with intensity
            var innerX = ex + brow.innerOff.dx * s.sign;
            var innerY = ey + brow.innerOff.dy + bassLift + breathBob
                         + moodLift - ampFurrow - moodInner + s.freqLift;
            var innerZ = ez + brow.innerOff.dz;

            // Outer anchor (toward temple) — lifts with surprise
            var outerX = ex + brow.outerOff.dx * s.sign;
            var outerY = ey + brow.outerOff.dy + bassLift * 1.3 + breathBob
                         + moodLift * 1.2 + s.freqLift * 1.1;
            var outerZ = ez + brow.outerOff.dz;

            // Mid control point — arches upward between inner/outer
            var midX = (innerX + outerX) * 0.5;
            var midY = Math.max(innerY, outerY) + 0.018 + bass * 0.015;
            var midZ = (innerZ + outerZ) * 0.5 + 0.01;

            var pInner = proj(innerX, innerY, innerZ);
            var pMid   = proj(midX,   midY,   midZ);
            var pOuter = proj(outerX, outerY, outerZ);

            // Main brow stroke
            wireCtx.shadowBlur  = 5 + bass * 10;
            wireCtx.shadowColor = brow.color;
            wireCtx.strokeStyle = 'rgba(' + brow.rgb + ',' + (0.8 + amp * 0.2) + ')';
            wireCtx.lineWidth   = brow.width || 1.8;

            wireCtx.beginPath();
            wireCtx.moveTo(pInner.x, pInner.y);
            wireCtx.quadraticCurveTo(pMid.x, pMid.y, pOuter.x, pOuter.y);
            wireCtx.stroke();

            // Slight thickness: draw a parallel stroke offset downward
            if (brow.thickness) {
                var pInner2 = proj(innerX, innerY - brow.thickness, innerZ);
                var pMid2   = proj(midX,   midY   - brow.thickness, midZ);
                var pOuter2 = proj(outerX, outerY - brow.thickness, outerZ);

                wireCtx.globalAlpha = 0.5;
                wireCtx.lineWidth   = (brow.width || 1.8) * 0.7;
                wireCtx.beginPath();
                wireCtx.moveTo(pInner2.x, pInner2.y);
                wireCtx.quadraticCurveTo(pMid2.x, pMid2.y, pOuter2.x, pOuter2.y);
                wireCtx.stroke();
                wireCtx.globalAlpha = 1;
            }
        }
    }

    // =========================================================
    //  Paperclip Body Renderer (Clippy)
    // =========================================================
    // ===== Metatron's Cube — Sacred Geometry Renderer =====

    function drawMetatronsCube(char, proj, amp, bass) {
        var t = performance.now() * 0.001;

        // === Color cycling: slow hue rotation ===
        var hue = (t * 0.035) % 1.0;
        function hsl2rgb(h, s, l) {
            var c = (1 - Math.abs(2 * l - 1)) * s;
            var x = c * (1 - Math.abs((h * 6) % 2 - 1));
            var m = l - c / 2;
            var r, g, b;
            if      (h < 1/6) { r=c; g=x; b=0; }
            else if (h < 2/6) { r=x; g=c; b=0; }
            else if (h < 3/6) { r=0; g=c; b=x; }
            else if (h < 4/6) { r=0; g=x; b=c; }
            else if (h < 5/6) { r=x; g=0; b=c; }
            else               { r=c; g=0; b=x; }
            return {
                r: Math.round((r + m) * 255),
                g: Math.round((g + m) * 255),
                b: Math.round((b + m) * 255)
            };
        }
        var pri = hsl2rgb(hue, 0.88, 0.48);
        var acc = hsl2rgb(hue, 0.78, 0.68);
        var cRGB = pri.r + ',' + pri.g + ',' + pri.b;
        var aRGB = acc.r + ',' + acc.g + ',' + acc.b;
        var cHex = 'rgb(' + cRGB + ')';
        var aHex = 'rgb(' + aRGB + ')';

        // === Full 3D Metatron's Cube: mirrored front + back ===
        // 26 nodes total on a sphere surface:
        //   [0] = front pole, [1-6] = inner front, [7-12] = outer front
        //   [13] = back pole, [14-19] = inner back, [20-25] = outer back
        // Front and back are mirror images -> looks the same from any angle.

        var S = 0.40;  // sphere radius
        var colatInner = 38 * Math.PI / 180;  // inner ring ~38° from poles
        var colatOuter = 64 * Math.PI / 180;  // outer ring ~64° from poles

        var nodes = [];
        // Front pole
        nodes.push({x: 0, y: 0, z: S});
        // Inner front ring
        for (var i = 0; i < 6; i++) {
            var phi = (i * 60 + 90) * Math.PI / 180;
            nodes.push({
                x: S * Math.sin(colatInner) * Math.cos(phi),
                y: S * Math.sin(colatInner) * Math.sin(phi),
                z: S * Math.cos(colatInner)
            });
        }
        // Outer front ring
        for (var i = 0; i < 6; i++) {
            var phi = (i * 60 + 90) * Math.PI / 180;
            nodes.push({
                x: S * Math.sin(colatOuter) * Math.cos(phi),
                y: S * Math.sin(colatOuter) * Math.sin(phi),
                z: S * Math.cos(colatOuter)
            });
        }
        // Back pole (mirror)
        nodes.push({x: 0, y: 0, z: -S});
        // Inner back ring (mirror z)
        for (var i = 0; i < 6; i++) {
            var phi = (i * 60 + 90) * Math.PI / 180;
            nodes.push({
                x: S * Math.sin(colatInner) * Math.cos(phi),
                y: S * Math.sin(colatInner) * Math.sin(phi),
                z: -S * Math.cos(colatInner)
            });
        }
        // Outer back ring (mirror z)
        for (var i = 0; i < 6; i++) {
            var phi = (i * 60 + 90) * Math.PI / 180;
            nodes.push({
                x: S * Math.sin(colatOuter) * Math.cos(phi),
                y: S * Math.sin(colatOuter) * Math.sin(phi),
                z: -S * Math.cos(colatOuter)
            });
        }

        // 3D rotation: steady Y spin + gentle X wobble
        var rotY = t * 0.15;
        var rotX = Math.sin(t * 0.07) * 0.25 + 0.12;
        var cosRY = Math.cos(rotY), sinRY = Math.sin(rotY);
        var cosRX = Math.cos(rotX), sinRX = Math.sin(rotX);

        function rot3d(px, py, pz) {
            var x1 = px * cosRY + pz * sinRY;
            var z1 = -px * sinRY + pz * cosRY;
            var y2 = py * cosRX - z1 * sinRX;
            var z2 = py * sinRX + z1 * cosRX;
            return { x: x1, y: y2, z: z2 };
        }

        var breathe = 1 + bass * 0.05;

        // Project all 26 nodes
        var pts = [];
        for (var p = 0; p < nodes.length; p++) {
            var nd = nodes[p];
            var px = nd.x, py = nd.y, pz = nd.z;

            // Per-node freq wiggle
            var fpos = (p % 13) / 13;
            var fval = getFreqSample(fpos);
            var wa = t * 1.8 + p * 1.1;
            px += Math.sin(wa) * fval * 0.005;
            py += Math.cos(wa * 0.7) * fval * 0.005;

            px *= breathe; py *= breathe; pz *= breathe;

            var r = rot3d(px, py, pz);
            pts.push(proj(r.x, r.y - 0.06, r.z + 0.10));
        }

        wireCtx.lineCap = 'round';
        wireCtx.lineJoin = 'round';

        // === Build connection list ===
        // Front face: all 78 pairs among [0..12]
        // Back face: all 78 pairs among [13..25]
        // Cross connections: pole-pole + corresponding ring nodes
        // We batch by visual category for performance.

        // Helper: classify a pair within a 13-node face
        function classifyFacePair(a, b) {
            // a, b are local indices 0-12 within one face
            if (a > b) { var tmp = a; a = b; b = tmp; }
            var isOuterEdge = (a >= 7 && b >= 7 && (Math.abs(a - b) === 1 || Math.abs(a - b) === 5));
            var isInnerEdge = (a >= 1 && a <= 6 && b >= 1 && b <= 6 && (Math.abs(a - b) === 1 || Math.abs(a - b) === 5));
            var isSpoke = (a === 0);
            var isStarEdge = (
                (a===7&&b===9)||(a===7&&b===11)||(a===9&&b===11)||
                (a===8&&b===10)||(a===8&&b===12)||(a===10&&b===12)
            );
            if (isStarEdge) return 'star';
            if (isOuterEdge) return 'outer';
            if (isInnerEdge) return 'inner';
            if (isSpoke) return 'spoke';
            return 'web';
        }

        function drawLine(ai, bi, cls) {
            var shimmer = getFreqSample(((ai * 7 + bi * 3) % 13) / 13);
            var alpha, lw;

            if (cls === 'star') {
                var treble = getFreqSample(0.82);
                alpha = 0.32 + treble * 0.32;
                lw = 1.3 + treble * 0.5;
                wireCtx.shadowBlur = 7 + treble * 12;
                wireCtx.shadowColor = aHex;
                wireCtx.strokeStyle = 'rgba(' + aRGB + ',' + Math.min(1, alpha).toFixed(3) + ')';
            } else if (cls === 'outer') {
                alpha = 0.28 + bass * 0.28;
                lw = 1.1 + bass * 0.4;
                wireCtx.shadowBlur = 5 + bass * 9;
                wireCtx.shadowColor = aHex;
                wireCtx.strokeStyle = 'rgba(' + aRGB + ',' + Math.min(1, alpha).toFixed(3) + ')';
            } else if (cls === 'inner') {
                var midF = getFreqSample(0.45);
                alpha = 0.22 + midF * 0.28;
                lw = 0.9 + midF * 0.35;
                wireCtx.shadowBlur = 4 + midF * 7;
                wireCtx.shadowColor = cHex;
                wireCtx.strokeStyle = 'rgba(' + cRGB + ',' + Math.min(1, alpha).toFixed(3) + ')';
            } else if (cls === 'spoke') {
                alpha = 0.10 + amp * 0.12 + shimmer * 0.06;
                lw = 0.5 + amp * 0.25;
                wireCtx.shadowBlur = 2 + amp * 5;
                wireCtx.shadowColor = cHex;
                wireCtx.strokeStyle = 'rgba(' + cRGB + ',' + Math.min(1, alpha).toFixed(3) + ')';
            } else if (cls === 'cross') {
                alpha = 0.08 + shimmer * 0.12;
                lw = 0.4 + shimmer * 0.2;
                wireCtx.shadowBlur = 2 + shimmer * 4;
                wireCtx.shadowColor = cHex;
                wireCtx.strokeStyle = 'rgba(' + cRGB + ',' + Math.min(1, alpha).toFixed(3) + ')';
            } else {
                alpha = 0.03 + shimmer * 0.08;
                lw = 0.3 + shimmer * 0.2;
                wireCtx.shadowBlur = 1 + shimmer * 3;
                wireCtx.shadowColor = cHex;
                wireCtx.strokeStyle = 'rgba(' + cRGB + ',' + Math.min(1, alpha).toFixed(3) + ')';
            }
            wireCtx.lineWidth = lw;
            wireCtx.beginPath();
            wireCtx.moveTo(pts[ai].x, pts[ai].y);
            wireCtx.lineTo(pts[bi].x, pts[bi].y);
            wireCtx.stroke();
        }

        // Front face: all 78 pairs among indices 0-12
        for (var a = 0; a < 13; a++) {
            for (var b = a + 1; b < 13; b++) {
                drawLine(a, b, classifyFacePair(a, b));
            }
        }

        // Back face: all 78 pairs among indices 13-25
        for (var a = 0; a < 13; a++) {
            for (var b = a + 1; b < 13; b++) {
                drawLine(13 + a, 13 + b, classifyFacePair(a, b));
            }
        }

        // Cross connections: corresponding front↔back nodes
        for (var i = 0; i < 13; i++) {
            drawLine(i, 13 + i, 'cross');
        }

        // === Circles: draw on all 26 nodes ===
        // Sacred circle radius (chord length) = inner ring chord
        var circleR = 2 * S * Math.sin(colatInner / 2);
        var CSEGS = 36;

        for (var ni = 0; ni < nodes.length; ni++) {
            var nd = nodes[ni];
            var fval = getFreqSample((ni % 13) / 13);
            var isPole = (ni === 0 || ni === 13);

            // Compute tangent frame at this node on the sphere
            var nx = nd.x, ny = nd.y, nz = nd.z;
            var nl = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
            nx /= nl; ny /= nl; nz /= nl;
            var upx = 0, upy = 1, upz = 0;
            if (Math.abs(ny) > 0.95) { upx = 1; upy = 0; }
            var ux = upy*nz - upz*ny;
            var uy = upz*nx - upx*nz;
            var uz = upx*ny - upy*nx;
            var ul = Math.sqrt(ux*ux + uy*uy + uz*uz) || 1;
            ux /= ul; uy /= ul; uz /= ul;
            var vx = ny*uz - nz*uy;
            var vy = nz*ux - nx*uz;
            var vz = nx*uy - ny*ux;

            var cpts = [];
            for (var s = 0; s <= CSEGS; s++) {
                var ca = (s / CSEGS) * Math.PI * 2;
                var cosA = Math.cos(ca), sinA = Math.sin(ca);
                var cpx = (nd.x + circleR * (cosA * ux + sinA * vx)) * breathe;
                var cpy = (nd.y + circleR * (cosA * uy + sinA * vy)) * breathe;
                var cpz = (nd.z + circleR * (cosA * uz + sinA * vz)) * breathe;

                // Same per-node wiggle
                var wa2 = t * 1.8 + ni * 1.1;
                cpx += Math.sin(wa2) * fval * 0.005;
                cpy += Math.cos(wa2 * 0.7) * fval * 0.005;

                var r = rot3d(cpx, cpy, cpz);
                cpts.push(proj(r.x, r.y - 0.06, r.z + 0.10));
            }

            var cAlpha = isPole ? (0.32 + bass * 0.22 + fval * 0.12)
                                : (0.12 + fval * 0.22 + bass * 0.06);
            var cLw = isPole ? (1.3 + bass * 0.4) : (0.7 + fval * 0.3);

            wireCtx.strokeStyle = 'rgba(' + (isPole ? aRGB : cRGB) + ',' + Math.min(1, cAlpha).toFixed(3) + ')';
            wireCtx.lineWidth = cLw;
            wireCtx.shadowBlur = isPole ? (8 + bass * 12) : (2 + fval * 6);
            wireCtx.shadowColor = isPole ? aHex : cHex;

            wireCtx.beginPath();
            for (var s = 0; s < cpts.length; s++) {
                s === 0 ? wireCtx.moveTo(cpts[s].x, cpts[s].y) : wireCtx.lineTo(cpts[s].x, cpts[s].y);
            }
            wireCtx.stroke();
        }

        // --- Center glow ---
        var cx = (pts[0].x + pts[13].x) / 2;
        var cy = (pts[0].y + pts[13].y) / 2;
        var glowR = 10 + bass * 8 + amp * 4;
        wireCtx.shadowBlur = 18 + bass * 22;
        wireCtx.shadowColor = aHex;
        var gradient = wireCtx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
        gradient.addColorStop(0, 'rgba(' + aRGB + ',' + (0.18 + bass * 0.14).toFixed(3) + ')');
        gradient.addColorStop(0.5, 'rgba(' + cRGB + ',' + (0.06 + bass * 0.05).toFixed(3) + ')');
        gradient.addColorStop(1, 'rgba(' + cRGB + ',0)');
        wireCtx.fillStyle = gradient;
        wireCtx.beginPath();
        wireCtx.arc(cx, cy, glowR, 0, Math.PI * 2);
        wireCtx.fill();

        // === Set eyeScreenPoints for lyrics + lasers ===
        // Words emit from the geometric center (between front and back poles)
        // Lasers fire from two outer nodes on opposite sides
        // Use the rightmost and leftmost outer nodes as "eyes"
        var rightmostIdx = 7, leftmostIdx = 7;
        for (var i = 7; i < 13; i++) {
            if (pts[i].x > pts[rightmostIdx].x) rightmostIdx = i;
            if (pts[i].x < pts[leftmostIdx].x) leftmostIdx = i;
        }
        // Also check back outer ring
        for (var i = 20; i < 26; i++) {
            if (pts[i].x > pts[rightmostIdx].x) rightmostIdx = i;
            if (pts[i].x < pts[leftmostIdx].x) leftmostIdx = i;
        }
        eyeScreenPoints.left = pts[leftmostIdx];
        eyeScreenPoints.right = pts[rightmostIdx];
        eyeScreenPoints.mouth = { x: cx, y: cy, d: pts[0].d || 1 };
    }


    function drawPaperclipBody(char, proj, amp, bass) {
        if (!char.wirePath) return;
        var path = char.wirePath;
        var t = performance.now() * 0.001;

        // === Music-reactive wobble ===
        // Clippy bounces and sways — his whole wire body is springy
        var bounce = bass * 0.015 * Math.sin(t * 6);
        var sway   = amp * 0.02 * Math.sin(t * 3.5);
        var breathBob = Math.sin(breathPhase) * 0.005;

        // Project all wire points with wobble applied
        var pts = [];
        for (var i = 0; i < path.length; i++) {
            var px = path[i][0];
            var py = path[i][1];
            var pz = path[i][2];

            // Wobble increases toward extremities (top and bottom)
            // Center of mass is roughly at y=0
            var distFromCenter = Math.abs(py) * 0.8 + 0.2;

            // Sway: horizontal displacement, more at top
            var wobX = sway * (0.3 + py * 0.7);
            // Bounce: vertical displacement
            var wobY = bounce * distFromCenter + breathBob;
            // Springy oscillation on the tip
            var spring = Math.sin(t * 8 + i * 0.4) * amp * 0.004 * distFromCenter;

            pts.push(proj(px + wobX + spring, py + wobY, pz));
        }

        // === Draw the paperclip wire ===
        var thickness = char.wireThickness || 3.0;
        wireCtx.shadowBlur = 6 + bass * 12;
        wireCtx.shadowColor = char.wireColor;
        wireCtx.lineCap = 'round';
        wireCtx.lineJoin = 'round';

        // Main wire stroke — thick silver
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',' + (0.75 + bass * 0.15) + ')';
        wireCtx.lineWidth = thickness;
        wireCtx.beginPath();
        // Use quadratic curves for smooth bends
        wireCtx.moveTo(pts[0].x, pts[0].y);
        for (var i = 1; i < pts.length; i++) {
            // Smooth curve through control points
            if (i < pts.length - 1) {
                var midX = (pts[i].x + pts[i+1].x) * 0.5;
                var midY = (pts[i].y + pts[i+1].y) * 0.5;
                wireCtx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
            } else {
                wireCtx.lineTo(pts[i].x, pts[i].y);
            }
        }
        wireCtx.stroke();

        // Highlight stroke — thinner, brighter, gives metallic sheen
        wireCtx.strokeStyle = 'rgba(255,255,255,' + (0.15 + bass * 0.08) + ')';
        wireCtx.lineWidth = thickness * 0.35;
        wireCtx.beginPath();
        wireCtx.moveTo(pts[0].x, pts[0].y);
        for (var i = 1; i < pts.length; i++) {
            if (i < pts.length - 1) {
                var midX = (pts[i].x + pts[i+1].x) * 0.5;
                var midY = (pts[i].y + pts[i+1].y) * 0.5;
                wireCtx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
            } else {
                wireCtx.lineTo(pts[i].x, pts[i].y);
            }
        }
        wireCtx.stroke();

        // Wire end caps — small circles at the two free ends
        var endRadius = thickness * 0.6;
        wireCtx.fillStyle = 'rgba(' + char.wireRGB + ',0.6)';
        wireCtx.beginPath();
        wireCtx.arc(pts[0].x, pts[0].y, endRadius, 0, Math.PI * 2);
        wireCtx.fill();
        wireCtx.beginPath();
        wireCtx.arc(pts[pts.length-1].x, pts[pts.length-1].y, endRadius, 0, Math.PI * 2);
        wireCtx.fill();
    }

    // =========================================================
    //  Googly Eye Renderer (Clippy-style big white circles with rolling pupil)
    // =========================================================
    function drawGooglyEye(eye, proj, eyeName, char, blinkAmount) {
        var t = performance.now() * 0.001;

        // Eye scale — Clippy has BIG eyes relative to his wire body
        var r = eye.r;
        var squish = Math.max(0.06, 1 - blinkAmount * 0.92);
        var c = proj(eye.x, eye.y, eye.z);

        // Scale factor from projection
        var edgeP = proj(eye.x + r, eye.y, eye.z);
        var screenR = Math.abs(edgeP.x - c.x);
        var screenRY = screenR * squish;

        if (blinkAmount > 0.85) {
            // Fully blinked — just a line
            wireCtx.strokeStyle = 'rgba(80,80,80,0.7)';
            wireCtx.lineWidth = 1.5;
            wireCtx.beginPath();
            wireCtx.moveTo(c.x - screenR * 0.8, c.y);
            wireCtx.lineTo(c.x + screenR * 0.8, c.y);
            wireCtx.stroke();
            return;
        }

        // White sclera (big white circle)
        wireCtx.shadowBlur = 4;
        wireCtx.shadowColor = '#FFFFFF';
        wireCtx.fillStyle = 'rgba(255,255,255,' + (0.85 + eyeGlow * 0.15) + ')';
        wireCtx.beginPath();
        wireCtx.ellipse(c.x, c.y, screenR, screenRY, 0, 0, Math.PI * 2);
        wireCtx.fill();

        // Sclera outline
        wireCtx.strokeStyle = 'rgba(80,80,80,' + (0.5 + eyeGlow * 0.3) + ')';
        wireCtx.lineWidth = 1.2;
        wireCtx.beginPath();
        wireCtx.ellipse(c.x, c.y, screenR, screenRY, 0, 0, Math.PI * 2);
        wireCtx.stroke();

        // Pupil — rolls around based on music + head rotation
        // Pupils look toward the viewer, with slight music drift
        var lookX = Math.sin(headRotY) * 0.25;  // follow head rotation
        var lookY = Math.sin(t * 0.7) * 0.08 + headBass * 0.12;  // gentle vertical drift
        // Music makes pupils jitter slightly
        var jitterX = Math.sin(t * 11 + (eyeName === 'left' ? 0 : 2)) * headAmp * 0.08;
        var jitterY = Math.cos(t * 9 + (eyeName === 'left' ? 1 : 3)) * headAmp * 0.06;

        var pupilOffX = (lookX + jitterX) * screenR * 0.45;
        var pupilOffY = (lookY + jitterY) * screenRY * 0.45;
        var pupilR = screenR * 0.48;
        var pupilRY = screenRY * 0.48;

        // Constrain pupil inside sclera
        var maxOff = screenR * 0.35;
        var dist = Math.sqrt(pupilOffX * pupilOffX + pupilOffY * pupilOffY);
        if (dist > maxOff) {
            pupilOffX *= maxOff / dist;
            pupilOffY *= maxOff / dist;
        }

        // Black pupil
        wireCtx.shadowBlur = 0;
        wireCtx.fillStyle = 'rgba(0,0,0,' + (0.85 + eyeGlow * 0.15) + ')';
        wireCtx.beginPath();
        wireCtx.ellipse(c.x + pupilOffX, c.y - pupilOffY, pupilR, pupilRY, 0, 0, Math.PI * 2);
        wireCtx.fill();

        // Pupil highlight (small white dot for that googly shine)
        var hlR = pupilR * 0.25;
        wireCtx.fillStyle = 'rgba(255,255,255,0.8)';
        wireCtx.beginPath();
        wireCtx.arc(c.x + pupilOffX - pupilR * 0.25, c.y - pupilOffY - pupilRY * 0.25, hlR, 0, Math.PI * 2);
        wireCtx.fill();
    }

    // =========================================================
    //  Visor Renderer (RoboCop-style horizontal slit)
    // =========================================================
    function drawVisor(char, proj) {
        var eyes = char.eyes;
        var t = performance.now() * 0.001;
        var eCol = char.eyeColor || { hex: '#FF3333', rgb: '255,51,51' };
        var oCol = char.eyeOutlineColor || { hex: '#666666', rgb: '102,102,102' };

        // Visor spans from left eye x to right eye x at the eye y-level
        // It wraps around the head following the surface curvature
        var visorY  = eyes.left.y;
        var visorHW = Math.abs(eyes.right.x - eyes.left.x) * 0.5;
        var visorH  = 0.045;  // half-height of the slit

        // The visor is a narrow horizontal band curving around the helmet
        var segs = 16;

        // Upper edge of visor
        var upperPts = [];
        var lowerPts = [];
        for (var i = 0; i <= segs; i++) {
            var frac = i / segs;  // 0..1 left to right
            var x = -visorHW + frac * visorHW * 2;

            // Z follows the head surface curvature (wider at center, recedes at edges)
            // Use a circular-ish curve
            var normX = Math.abs(x) / visorHW;  // 0 at center, 1 at edges
            var zCurve = Math.sqrt(Math.max(0, 1 - normX * normX * 0.6));
            var z = 0.52 * zCurve;

            upperPts.push(proj(x, visorY + visorH, z));
            lowerPts.push(proj(x, visorY - visorH, z));
        }

        // === Visor housing (dark outline around the slit) ===
        wireCtx.shadowBlur = 4;
        wireCtx.shadowColor = oCol.hex;
        wireCtx.strokeStyle = 'rgba(' + oCol.rgb + ',0.7)';
        wireCtx.lineWidth = 2.5;
        wireCtx.lineCap = 'round';

        // Upper edge
        wireCtx.beginPath();
        for (var i = 0; i < upperPts.length; i++) {
            i === 0 ? wireCtx.moveTo(upperPts[i].x, upperPts[i].y) : wireCtx.lineTo(upperPts[i].x, upperPts[i].y);
        }
        wireCtx.stroke();

        // Lower edge
        wireCtx.beginPath();
        for (var i = 0; i < lowerPts.length; i++) {
            i === 0 ? wireCtx.moveTo(lowerPts[i].x, lowerPts[i].y) : wireCtx.lineTo(lowerPts[i].x, lowerPts[i].y);
        }
        wireCtx.stroke();

        // Side caps (close the slit at the edges)
        wireCtx.beginPath();
        wireCtx.moveTo(upperPts[0].x, upperPts[0].y);
        wireCtx.lineTo(lowerPts[0].x, lowerPts[0].y);
        wireCtx.stroke();
        wireCtx.beginPath();
        wireCtx.moveTo(upperPts[upperPts.length-1].x, upperPts[upperPts.length-1].y);
        wireCtx.lineTo(lowerPts[lowerPts.length-1].x, lowerPts[lowerPts.length-1].y);
        wireCtx.stroke();

        // === Red/amber glow inside the visor ===
        // Intensity pulses with bass and vocal
        var glowIntensity = 0.25 + eyeGlow * 0.55 + Math.sin(t * 2) * 0.08;

        // Fill the visor slit with color glow
        wireCtx.shadowBlur = 8 + eyeGlow * 18;
        wireCtx.shadowColor = eCol.hex;
        wireCtx.fillStyle = 'rgba(' + eCol.rgb + ',' + glowIntensity + ')';
        wireCtx.beginPath();
        for (var i = 0; i < upperPts.length; i++) {
            i === 0 ? wireCtx.moveTo(upperPts[i].x, upperPts[i].y) : wireCtx.lineTo(upperPts[i].x, upperPts[i].y);
        }
        for (var i = lowerPts.length - 1; i >= 0; i--) {
            wireCtx.lineTo(lowerPts[i].x, lowerPts[i].y);
        }
        wireCtx.closePath();
        wireCtx.fill();

        // Scanline effect — horizontal lines sweeping through the visor
        var scanY = visorY - visorH + ((t * 0.3) % 1) * visorH * 2;
        var scanPts = [];
        for (var i = 0; i <= segs; i++) {
            var frac = i / segs;
            var x = -visorHW + frac * visorHW * 2;
            var normX = Math.abs(x) / visorHW;
            var zCurve = Math.sqrt(Math.max(0, 1 - normX * normX * 0.6));
            var z = 0.52 * zCurve;
            scanPts.push(proj(x, scanY, z));
        }
        wireCtx.strokeStyle = 'rgba(' + eCol.rgb + ',' + (0.15 + eyeGlow * 0.2) + ')';
        wireCtx.lineWidth = 0.6;
        wireCtx.shadowBlur = 3;
        wireCtx.beginPath();
        for (var i = 0; i < scanPts.length; i++) {
            i === 0 ? wireCtx.moveTo(scanPts[i].x, scanPts[i].y) : wireCtx.lineTo(scanPts[i].x, scanPts[i].y);
        }
        wireCtx.stroke();

        // Reflection highlight (narrow bright line near the top of visor)
        wireCtx.strokeStyle = 'rgba(255,255,255,' + (0.06 + eyeGlow * 0.08) + ')';
        wireCtx.lineWidth = 0.8;
        wireCtx.shadowBlur = 0;
        wireCtx.beginPath();
        for (var i = 0; i < upperPts.length; i++) {
            var ux = upperPts[i].x;
            var uy = upperPts[i].y + (lowerPts[i].y - upperPts[i].y) * 0.2;
            i === 0 ? wireCtx.moveTo(ux, uy) : wireCtx.lineTo(ux, uy);
        }
        wireCtx.stroke();
    }

    // =========================================================
    //  Chin Guard / Helmet Edge Renderer (RoboCop jawline armor)
    // =========================================================
    function drawChinGuard(char, proj, amp, bass) {
        if (!char.chinGuard) return;
        var cg = char.chinGuard;
        var t = performance.now() * 0.001;

        // Horizontal edge where helmet meets exposed lower face
        // Curves around the head at cg.y
        var segs = 14;
        var edgePts = [];
        for (var i = 0; i <= segs; i++) {
            var frac = i / segs;
            var x = -cg.hw + frac * cg.hw * 2;
            var normX = Math.abs(x) / cg.hw;
            var zCurve = Math.sqrt(Math.max(0, 1 - normX * normX * 0.5));
            var z = cg.z * zCurve;
            edgePts.push(proj(x, cg.y, z));
        }

        wireCtx.shadowBlur = 4 + bass * 6;
        wireCtx.shadowColor = cg.color;
        wireCtx.strokeStyle = 'rgba(' + cg.rgb + ',0.6)';
        wireCtx.lineWidth = 2.2;
        wireCtx.lineCap = 'round';
        wireCtx.beginPath();
        for (var i = 0; i < edgePts.length; i++) {
            i === 0 ? wireCtx.moveTo(edgePts[i].x, edgePts[i].y) : wireCtx.lineTo(edgePts[i].x, edgePts[i].y);
        }
        wireCtx.stroke();

        // Cheek guards — vertical lines from helmet edge down the sides
        var cheekL = proj(-cg.hw * 0.75, cg.y, cg.z * 0.65);
        var cheekLBot = proj(-cg.hw * 0.70, cg.y - 0.14, cg.z * 0.60);
        var cheekR = proj(cg.hw * 0.75, cg.y, cg.z * 0.65);
        var cheekRBot = proj(cg.hw * 0.70, cg.y - 0.14, cg.z * 0.60);

        wireCtx.strokeStyle = 'rgba(' + cg.rgb + ',0.4)';
        wireCtx.lineWidth = 1.8;
        wireCtx.beginPath();
        wireCtx.moveTo(cheekL.x, cheekL.y);
        wireCtx.lineTo(cheekLBot.x, cheekLBot.y);
        wireCtx.stroke();
        wireCtx.beginPath();
        wireCtx.moveTo(cheekR.x, cheekR.y);
        wireCtx.lineTo(cheekRBot.x, cheekRBot.y);
        wireCtx.stroke();
    }

    // =========================================================
    //  Box Head Renderer (rectangular characters like floppy drive)
    // =========================================================
    // === 16-color CGA palette for iNK$tAiN ===
    var CGA_PALETTE_16 = [
        { hex: '#000000', rgb: '0,0,0' },         // 0: black
        { hex: '#0000AA', rgb: '0,0,170' },        // 1: blue
        { hex: '#00AA00', rgb: '0,170,0' },         // 2: green
        { hex: '#00AAAA', rgb: '0,170,170' },       // 3: cyan
        { hex: '#AA0000', rgb: '170,0,0' },         // 4: red
        { hex: '#AA00AA', rgb: '170,0,170' },       // 5: magenta
        { hex: '#AA5500', rgb: '170,85,0' },        // 6: brown
        { hex: '#AAAAAA', rgb: '170,170,170' },     // 7: light gray
        { hex: '#555555', rgb: '85,85,85' },        // 8: dark gray
        { hex: '#5555FF', rgb: '85,85,255' },       // 9: light blue
        { hex: '#55FF55', rgb: '85,255,85' },       // 10: light green
        { hex: '#55FFFF', rgb: '85,255,255' },      // 11: light cyan
        { hex: '#FF5555', rgb: '255,85,85' },       // 12: light red
        { hex: '#FF55FF', rgb: '255,85,255' },      // 13: light magenta
        { hex: '#FFFF55', rgb: '255,255,85' },      // 14: yellow
        { hex: '#FFFFFF', rgb: '255,255,255' }      // 15: white
    ];

    // Counter for cycling CGA colors per line drawn
    var cgaLineIndex = 0;

    function getCgaColor() {
        // Skip black (index 0) — invisible on dark background
        var idx = 1 + (cgaLineIndex % 15);
        cgaLineIndex++;
        return CGA_PALETTE_16[idx];
    }

    // === Cage Cube: gray wireframe enclosure for iNK$tAiN ===
    function drawCageCube(char, proj, amp, bass) {
        var cage = char.cage;
        if (!cage) return;
        var cw = cage.w, ch = cage.h, cd = cage.d;

        // Bass pulse on cage
        var pulse = 1 + bass * 0.008;
        cw *= pulse; ch *= pulse; cd *= pulse;

        // 8 corners
        var ftl = proj(-cw, ch, cd);
        var ftr = proj(cw, ch, cd);
        var fbl = proj(-cw, -ch, cd);
        var fbr = proj(cw, -ch, cd);
        var btl = proj(-cw, ch, -cd);
        var btr = proj(cw, ch, -cd);
        var bbl = proj(-cw, -ch, -cd);
        var bbr = proj(cw, -ch, -cd);

        // Gray cage style — medium gray, defined edges
        var cageRGB = '140,140,140';
        var cageHex = '#8C8C8C';
        var edgeLw = 1.8;

        wireCtx.shadowBlur = 4 + bass * 6;
        wireCtx.shadowColor = cageHex;

        // Front face
        wireCtx.strokeStyle = 'rgba(' + cageRGB + ',0.65)';
        wireCtx.lineWidth = edgeLw;
        wireCtx.beginPath();
        wireCtx.moveTo(ftl.x, ftl.y);
        wireCtx.lineTo(ftr.x, ftr.y);
        wireCtx.lineTo(fbr.x, fbr.y);
        wireCtx.lineTo(fbl.x, fbl.y);
        wireCtx.closePath();
        wireCtx.stroke();

        // Back face
        wireCtx.strokeStyle = 'rgba(' + cageRGB + ',0.35)';
        wireCtx.lineWidth = edgeLw;
        wireCtx.beginPath();
        wireCtx.moveTo(btl.x, btl.y);
        wireCtx.lineTo(btr.x, btr.y);
        wireCtx.lineTo(bbr.x, bbr.y);
        wireCtx.lineTo(bbl.x, bbl.y);
        wireCtx.closePath();
        wireCtx.stroke();

        // Side edges (connect front to back)
        wireCtx.strokeStyle = 'rgba(' + cageRGB + ',0.50)';
        wireCtx.lineWidth = edgeLw;
        var fc = [ftl, ftr, fbr, fbl];
        var bc = [btl, btr, bbr, bbl];
        for (var i = 0; i < 4; i++) {
            wireCtx.beginPath();
            wireCtx.moveTo(fc[i].x, fc[i].y);
            wireCtx.lineTo(bc[i].x, bc[i].y);
            wireCtx.stroke();
        }

        // Internal bars — horizontal and vertical for prison-like effect
        var barRGB = '120,120,120';
        var barAlpha = 0.25;
        var barLw = 0.9;
        wireCtx.lineWidth = barLw;

        // Vertical bars on front face
        var vBars = 5;
        for (var b = 1; b < vBars; b++) {
            var frac = b / vBars;
            var xOff = -cw + 2 * cw * frac;
            var ft = proj(xOff, ch, cd);
            var fb = proj(xOff, -ch, cd);
            wireCtx.strokeStyle = 'rgba(' + barRGB + ',' + barAlpha + ')';
            wireCtx.beginPath();
            wireCtx.moveTo(ft.x, ft.y);
            wireCtx.lineTo(fb.x, fb.y);
            wireCtx.stroke();
        }

        // Horizontal bars on front face
        var hBars = 4;
        for (var b = 1; b < hBars; b++) {
            var frac = b / hBars;
            var yOff = -ch + 2 * ch * frac;
            var fl = proj(-cw, yOff, cd);
            var fr = proj(cw, yOff, cd);
            wireCtx.strokeStyle = 'rgba(' + barRGB + ',' + barAlpha + ')';
            wireCtx.beginPath();
            wireCtx.moveTo(fl.x, fl.y);
            wireCtx.lineTo(fr.x, fr.y);
            wireCtx.stroke();
        }

        // Vertical bars on side faces
        var sBars = 3;
        for (var b = 1; b < sBars; b++) {
            var frac = b / sBars;
            var zOff = -cd + 2 * cd * frac;
            // Left side
            var lt = proj(-cw, ch, zOff);
            var lb = proj(-cw, -ch, zOff);
            wireCtx.strokeStyle = 'rgba(' + barRGB + ',' + (barAlpha * 0.7) + ')';
            wireCtx.beginPath();
            wireCtx.moveTo(lt.x, lt.y);
            wireCtx.lineTo(lb.x, lb.y);
            wireCtx.stroke();
            // Right side
            var rt = proj(cw, ch, zOff);
            var rb = proj(cw, -ch, zOff);
            wireCtx.beginPath();
            wireCtx.moveTo(rt.x, rt.y);
            wireCtx.lineTo(rb.x, rb.y);
            wireCtx.stroke();
        }

        wireCtx.shadowBlur = 0;
    }

        function drawBoxHead(char, proj, amp, bass) {
        var box = char.boxDims;
        var w = box.w, h = box.h, d = box.d;

        // Subtle bass pulse on the enclosure
        var vibrate = bass * 0.006;

        // 8 corners of the box
        var ftl = proj(-w, h, d);
        var ftr = proj(w, h, d);
        var fbl = proj(-w, -h, d);
        var fbr = proj(w, -h, d);
        var btl = proj(-w, h, -d);
        var btr = proj(w, h, -d);
        var bbl = proj(-w, -h, -d);
        var bbr = proj(w, -h, -d);

        wireCtx.shadowBlur = 6 + bass * 10;
        wireCtx.shadowColor = char.wireColor;

        // All structural edges at uniform thickness
        var edgeWidth = 1.6;

        // --- Front face (main face) ---
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.65)';
        wireCtx.lineWidth = edgeWidth;
        wireCtx.beginPath();
        wireCtx.moveTo(ftl.x, ftl.y);
        wireCtx.lineTo(ftr.x, ftr.y);
        wireCtx.lineTo(fbr.x, fbr.y);
        wireCtx.lineTo(fbl.x, fbl.y);
        wireCtx.closePath();
        wireCtx.stroke();

        // --- Back face ---
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.30)';
        wireCtx.lineWidth = edgeWidth;
        wireCtx.beginPath();
        wireCtx.moveTo(btl.x, btl.y);
        wireCtx.lineTo(btr.x, btr.y);
        wireCtx.lineTo(bbr.x, bbr.y);
        wireCtx.lineTo(bbl.x, bbl.y);
        wireCtx.closePath();
        wireCtx.stroke();

        // --- Side edges (connect front to back) ---
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.45)';
        wireCtx.lineWidth = edgeWidth;
        var frontCorners = [ftl, ftr, fbr, fbl];
        var backCorners  = [btl, btr, bbr, bbl];
        for (var i = 0; i < 4; i++) {
            wireCtx.beginPath();
            wireCtx.moveTo(frontCorners[i].x, frontCorners[i].y);
            wireCtx.lineTo(backCorners[i].x, backCorners[i].y);
            wireCtx.stroke();
        }

        // --- Internal ribbing (horizontal + vertical) ---
        var ribAlpha = 0.18;
        var ribWidth = 0.7;
        var sections = 6;

        // Horizontal ribs
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',' + ribAlpha + ')';
        wireCtx.lineWidth = ribWidth;
        for (var si = 1; si < sections; si++) {
            var frac = si / sections;
            var yy = -h + 2 * h * frac;
            var fl = proj(-w, yy, d);
            var fr = proj(w, yy, d);
            var bl = proj(-w, yy, -d);
            var br = proj(w, yy, -d);
            // Front horizontal
            wireCtx.beginPath();
            wireCtx.moveTo(fl.x, fl.y); wireCtx.lineTo(fr.x, fr.y);
            wireCtx.stroke();
            // Left side
            wireCtx.beginPath();
            wireCtx.moveTo(fl.x, fl.y); wireCtx.lineTo(bl.x, bl.y);
            wireCtx.stroke();
            // Right side
            wireCtx.beginPath();
            wireCtx.moveTo(fr.x, fr.y); wireCtx.lineTo(br.x, br.y);
            wireCtx.stroke();
            // Back horizontal
            wireCtx.beginPath();
            wireCtx.moveTo(bl.x, bl.y); wireCtx.lineTo(br.x, br.y);
            wireCtx.stroke();
        }

        // Vertical ribs (front, sides, back)
        var vSections = 4;
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',' + ribAlpha + ')';
        wireCtx.lineWidth = ribWidth;
        for (var vi = 1; vi < vSections; vi++) {
            var vfrac = vi / vSections;
            var xx = -w + 2 * w * vfrac;
            // Front vertical
            var fTop = proj(xx, h, d);
            var fBot = proj(xx, -h, d);
            wireCtx.beginPath();
            wireCtx.moveTo(fTop.x, fTop.y); wireCtx.lineTo(fBot.x, fBot.y);
            wireCtx.stroke();
            // Back vertical
            var bTop = proj(xx, h, -d);
            var bBot = proj(xx, -h, -d);
            wireCtx.beginPath();
            wireCtx.moveTo(bTop.x, bTop.y); wireCtx.lineTo(bBot.x, bBot.y);
            wireCtx.stroke();
        }
        // Side vertical ribs (along depth)
        var dSections = 3;
        for (var di = 1; di < dSections; di++) {
            var dfrac = di / dSections;
            var zz = -d + 2 * d * dfrac;
            // Left side vertical
            var lTop = proj(-w, h, zz);
            var lBot = proj(-w, -h, zz);
            wireCtx.beginPath();
            wireCtx.moveTo(lTop.x, lTop.y); wireCtx.lineTo(lBot.x, lBot.y);
            wireCtx.stroke();
            // Right side vertical
            var rTop = proj(w, h, zz);
            var rBot = proj(w, -h, zz);
            wireCtx.beginPath();
            wireCtx.moveTo(rTop.x, rTop.y); wireCtx.lineTo(rBot.x, rBot.y);
            wireCtx.stroke();
        }

        // --- Character-specific front panel details ---
        if (char.boxStyle === 'floppy') {
            drawFloppyDiskDetails(char, proj, amp, bass, w, h, d);
        } else {
            // Default drive enclosure details (FDP etc.)
            // "SCSI GAL" tramp stamp on the back, near the bottom
            wireCtx.save();
            var stampY = -h * 0.75;
            var stampZ = -d - 0.001;
            var stampC = proj(0, stampY, stampZ);
            var stampScale = Math.abs(proj(0.1, stampY, stampZ).x - stampC.x);
            wireCtx.font = (stampScale * 0.9) + 'px monospace';
            wireCtx.textAlign = 'center';
            wireCtx.textBaseline = 'middle';
            wireCtx.fillStyle = 'rgba(' + char.wireRGB + ',0.12)';
            wireCtx.shadowBlur = 0;
            wireCtx.fillText('SCSI GAL', stampC.x, stampC.y);
            wireCtx.restore();

            // Front panel detail: label area
            var labelW = w * 0.65, labelTop = h * 0.80, labelBot = h * 0.45;
            wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.22)';
            wireCtx.lineWidth = 0.8;
            var ltl = proj(-labelW, labelTop, d + 0.005);
            var ltr = proj(labelW, labelTop, d + 0.005);
            var lbr = proj(labelW, labelBot, d + 0.005);
            var lbl = proj(-labelW, labelBot, d + 0.005);
            wireCtx.beginPath();
            wireCtx.moveTo(ltl.x, ltl.y); wireCtx.lineTo(ltr.x, ltr.y);
            wireCtx.lineTo(lbr.x, lbr.y); wireCtx.lineTo(lbl.x, lbl.y);
            wireCtx.closePath();
            wireCtx.stroke();

            // Tiny horizontal lines inside label (text lines)
            wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.12)';
            wireCtx.lineWidth = 0.5;
            for (var li = 0; li < 3; li++) {
                var ly = labelBot + (labelTop - labelBot) * (0.25 + li * 0.25);
                var ll = proj(-labelW * 0.85, ly, d + 0.005);
                var lr = proj(labelW * 0.85, ly, d + 0.005);
                wireCtx.beginPath();
                wireCtx.moveTo(ll.x, ll.y); wireCtx.lineTo(lr.x, lr.y);
                wireCtx.stroke();
            }

            // Eject button
            var ejW = w * 0.12, ejH = h * 0.06;
            var ejY = -h * 0.65;
            wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.30)';
            wireCtx.lineWidth = 0.8;
            var etl = proj(-ejW, ejY + ejH, d + 0.005);
            var etr = proj(ejW, ejY + ejH, d + 0.005);
            var ebr = proj(ejW, ejY - ejH, d + 0.005);
            var ebl = proj(-ejW, ejY - ejH, d + 0.005);
            wireCtx.beginPath();
            wireCtx.moveTo(etl.x, etl.y); wireCtx.lineTo(etr.x, etr.y);
            wireCtx.lineTo(ebr.x, ebr.y); wireCtx.lineTo(ebl.x, ebl.y);
            wireCtx.closePath();
            wireCtx.stroke();
            if (bass > 0.4) {
                wireCtx.fillStyle = 'rgba(' + char.wireRGB + ',' + (bass * 0.15) + ')';
                wireCtx.fill();
            }
        }
    }

    // =========================================================
    //  Floppy Disk Details (3.5" disk face — label, notches, write-protect)
    // =========================================================
    function drawFloppyDiskDetails(char, proj, amp, bass, w, h, d) {
        var t = performance.now() * 0.001;
        var lbl = char.label;

        // --- Label sticker (lower portion of front face) ---
        if (lbl) {
            wireCtx.strokeStyle = 'rgba(' + lbl.rgb + ',0.25)';
            wireCtx.lineWidth = 0.9;
            var ltl = proj(-lbl.hw, lbl.top, d + 0.003);
            var ltr = proj(lbl.hw, lbl.top, d + 0.003);
            var lbr = proj(lbl.hw, lbl.bot, d + 0.003);
            var lbl2 = proj(-lbl.hw, lbl.bot, d + 0.003);
            wireCtx.beginPath();
            wireCtx.moveTo(ltl.x, ltl.y); wireCtx.lineTo(ltr.x, ltr.y);
            wireCtx.lineTo(lbr.x, lbr.y); wireCtx.lineTo(lbl2.x, lbl2.y);
            wireCtx.closePath();
            wireCtx.stroke();

            // Faint fill for the label area
            wireCtx.fillStyle = 'rgba(' + lbl.rgb + ',0.04)';
            wireCtx.fill();
        }

        // --- Metal shutter area at top ---
        // (The actual shutter animation is in drawShutter, this just draws
        //  the shutter housing/frame on the disk body)
        if (char.shutter) {
            var sh = char.shutter;
            wireCtx.strokeStyle = 'rgba(' + sh.rgb + ',0.20)';
            wireCtx.lineWidth = 0.7;
            // Shutter housing outline
            var stl = proj(-sh.width, sh.yTop, d + 0.004);
            var str = proj(sh.width, sh.yTop, d + 0.004);
            var sbr = proj(sh.width, sh.yBot, d + 0.004);
            var sbl = proj(-sh.width, sh.yBot, d + 0.004);
            wireCtx.beginPath();
            wireCtx.moveTo(stl.x, stl.y); wireCtx.lineTo(str.x, str.y);
            wireCtx.lineTo(sbr.x, sbr.y); wireCtx.lineTo(sbl.x, sbl.y);
            wireCtx.closePath();
            wireCtx.stroke();
        }

        // --- HD indicator notch (top-right corner, front) ---
        var notchW = w * 0.08, notchH = h * 0.08;
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.18)';
        wireCtx.lineWidth = 0.6;
        var ntl = proj(w - notchW * 3, h - notchH * 0.5, d + 0.003);
        var ntr = proj(w - notchW * 0.5, h - notchH * 0.5, d + 0.003);
        var nbr = proj(w - notchW * 0.5, h - notchH * 2.5, d + 0.003);
        var nbl = proj(w - notchW * 3, h - notchH * 2.5, d + 0.003);
        wireCtx.beginPath();
        wireCtx.moveTo(ntl.x, ntl.y); wireCtx.lineTo(ntr.x, ntr.y);
        wireCtx.lineTo(nbr.x, nbr.y); wireCtx.lineTo(nbl.x, nbl.y);
        wireCtx.closePath();
        wireCtx.stroke();
        // "HD" text
        wireCtx.save();
        var hdC = proj(w - notchW * 1.75, h - notchH * 1.5, d + 0.004);
        var hdScale = Math.abs(proj(0.05, 0, d).x - proj(0, 0, d).x);
        wireCtx.font = Math.max(4, hdScale * 0.7) + 'px monospace';
        wireCtx.textAlign = 'center';
        wireCtx.textBaseline = 'middle';
        wireCtx.fillStyle = 'rgba(' + char.wireRGB + ',0.18)';
        wireCtx.shadowBlur = 0;
        wireCtx.fillText('HD', hdC.x, hdC.y);
        wireCtx.restore();

        // --- Write-protect tab (bottom-left, small square notch) ---
        var wpW = w * 0.06, wpH = h * 0.10;
        var wpX = -w + wpW * 1.5;
        var wpY = -h + wpH * 1.5;
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.15)';
        wireCtx.lineWidth = 0.5;
        var wptl = proj(wpX - wpW, wpY + wpH, d + 0.003);
        var wptr = proj(wpX + wpW, wpY + wpH, d + 0.003);
        var wpbr = proj(wpX + wpW, wpY - wpH, d + 0.003);
        var wpbl = proj(wpX - wpW, wpY - wpH, d + 0.003);
        wireCtx.beginPath();
        wireCtx.moveTo(wptl.x, wptl.y); wireCtx.lineTo(wptr.x, wptr.y);
        wireCtx.lineTo(wpbr.x, wpbr.y); wireCtx.lineTo(wpbl.x, wpbl.y);
        wireCtx.closePath();
        wireCtx.stroke();

        // --- Center hub ring (visible through back, faint on front) ---
        var hubY = -h * 0.15;
        var hubR = w * 0.16;
        var hubC = proj(0, hubY, d + 0.002);
        var hubScale = Math.abs(proj(hubR, hubY, d).x - proj(0, hubY, d).x);
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.10)';
        wireCtx.lineWidth = 0.5;
        wireCtx.beginPath();
        wireCtx.arc(hubC.x, hubC.y, hubScale, 0, Math.PI * 2);
        wireCtx.stroke();
        // Hub center dot
        wireCtx.fillStyle = 'rgba(' + char.wireRGB + ',0.08)';
        wireCtx.beginPath();
        wireCtx.arc(hubC.x, hubC.y, hubScale * 0.15, 0, Math.PI * 2);
        wireCtx.fill();
    }

    // =========================================================
    //  Smiley Mouth (simple curved smile for disk label faces)
        // =========================================================
    //  Pucker Mouth Renderer (pursed lips → screaming oval)
    // =========================================================
    function drawPuckerMouth(proj, char, mth) {
        var open = mouthOpen;
        var t = performance.now() * 0.001;

        // === Shape interpolation ===
        // When closed (open ≈ 0): small tight pursed circle
        // When open (open → 1): wide screaming oval
        //
        // Pucker radius (closed): very small circle
        // Scream dimensions (open): wide horizontally, tall vertically

        var puckerR  = 0.03;              // base pucker radius
        var maxW     = mth.hw * 1.2;      // max scream width
        var maxH     = 0.12;              // max scream height

        // Interpolate between pucker (circle) and scream (oval)
        // Use a curve that stays puckered longer then opens fast
        var openCurve = open * open;  // quadratic: stays small longer, then snaps open
        var mouthW = puckerR + (maxW - puckerR) * openCurve;
        var mouthH = puckerR + (maxH - puckerR) * openCurve;

        var cx = 0;
        var cy = mth.y;
        var cz = mth.z;

        // Draw the mouth as an ellipse
        var segs = mth.segs || 12;
        var outerPts = [];
        for (var i = 0; i <= segs; i++) {
            var a = (i / segs) * Math.PI * 2;
            var px = cx + mouthW * Math.cos(a);
            var py = cy + mouthH * Math.sin(a);
            outerPts.push(proj(px, py, cz));
        }

        // Lip color — more visible when puckered
        var lipAlpha = 0.5 + open * 0.4 + (1 - open) * 0.3;
        wireCtx.shadowBlur = 6 + mouthOpen * 14;
        wireCtx.shadowColor = char.accentColor;
        wireCtx.strokeStyle = 'rgba(' + char.accentRGB + ',' + lipAlpha + ')';
        wireCtx.lineWidth = 1.8 + (1 - openCurve) * 1.2;  // thicker lips when pursed
        wireCtx.lineCap = 'round';
        wireCtx.beginPath();
        for (var i = 0; i < outerPts.length; i++) {
            i === 0 ? wireCtx.moveTo(outerPts[i].x, outerPts[i].y) : wireCtx.lineTo(outerPts[i].x, outerPts[i].y);
        }
        wireCtx.closePath();
        wireCtx.stroke();

        // Inner lip line for depth (slightly smaller)
        if (openCurve > 0.02) {
            var innerPts = [];
            var shrink = 0.7;
            for (var i = 0; i <= segs; i++) {
                var a = (i / segs) * Math.PI * 2;
                var px = cx + mouthW * shrink * Math.cos(a);
                var py = cy + mouthH * shrink * Math.sin(a);
                innerPts.push(proj(px, py, cz));
            }
            wireCtx.strokeStyle = 'rgba(' + char.accentRGB + ',' + (lipAlpha * 0.4) + ')';
            wireCtx.lineWidth = 1.0;
            wireCtx.beginPath();
            for (var i = 0; i < innerPts.length; i++) {
                i === 0 ? wireCtx.moveTo(innerPts[i].x, innerPts[i].y) : wireCtx.lineTo(innerPts[i].x, innerPts[i].y);
            }
            wireCtx.closePath();
            wireCtx.stroke();
        }

        // Dark interior when mouth is open enough
        if (openCurve > 0.08) {
            wireCtx.fillStyle = 'rgba(0,0,0,' + Math.min(0.5, openCurve * 0.6) + ')';
            wireCtx.beginPath();
            for (var i = 0; i < outerPts.length; i++) {
                i === 0 ? wireCtx.moveTo(outerPts[i].x, outerPts[i].y) : wireCtx.lineTo(outerPts[i].x, outerPts[i].y);
            }
            wireCtx.closePath();
            wireCtx.fill();
        }

        // Teeth visible when screaming (open > 0.3)
        if (openCurve > 0.15) {
            var teethAlpha = Math.min(0.9, (openCurve - 0.15) * 2.5);
            wireCtx.strokeStyle = 'rgba(255,255,255,' + teethAlpha + ')';
            wireCtx.shadowColor = 'rgba(255,255,255,1)';
            wireCtx.shadowBlur  = 4 + mouthOpen * 8;
            wireCtx.lineWidth   = 0.8;

            // Upper teeth: short vertical lines hanging from top of mouth
            var teethN = 6;
            for (var ti = 0; ti < teethN; ti++) {
                var tt = ((ti + 0.5) / teethN) * 2 - 1;  // -1..1
                var tWidth = mouthW * 0.85;
                var tx = cx + tt * tWidth;
                // Only draw where the ellipse has room
                var ellipseTop = cy + mouthH * Math.sqrt(Math.max(0, 1 - (tt * tt)));
                var toothBot = cy + mouthH * 0.3;  // teeth hang 30% into mouth
                var topP = proj(tx, ellipseTop, cz);
                var botP = proj(tx, toothBot, cz);
                wireCtx.beginPath();
                wireCtx.moveTo(topP.x, topP.y);
                wireCtx.lineTo(botP.x, botP.y);
                wireCtx.stroke();
            }
        }

        // Pucker lines radiating out when mouth is closed/pursed
        if (openCurve < 0.25) {
            var puckerIntensity = 1 - openCurve * 4;  // fades as mouth opens
            wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',' + (puckerIntensity * 0.25) + ')';
            wireCtx.lineWidth = 0.6;
            wireCtx.shadowBlur = 0;
            var lineCount = 8;
            for (var li = 0; li < lineCount; li++) {
                var la = (li / lineCount) * Math.PI * 2;
                var innerR = mouthW * 1.3;
                var outerR = mouthW * 2.2;
                var lx1 = cx + innerR * Math.cos(la);
                var ly1 = cy + innerR * Math.sin(la) * (mouthH / mouthW);
                var lx2 = cx + outerR * Math.cos(la);
                var ly2 = cy + outerR * Math.sin(la) * (mouthH / mouthW);
                var p1 = proj(lx1, ly1, cz);
                var p2 = proj(lx2, ly2, cz);
                wireCtx.beginPath();
                wireCtx.moveTo(p1.x, p1.y);
                wireCtx.lineTo(p2.x, p2.y);
                wireCtx.stroke();
            }
        }
    }

// =========================================================
    function drawSmileyMouth(proj, char, mth) {
        var open = mouthOpen * 0.07;

        // Simple arc smile — curves down (frown when closed, smile when singing)
        wireCtx.shadowBlur = 4 + mouthOpen * 12;
        wireCtx.shadowColor = char.wireColor;

        // Upper lip (static gentle smile curve)
        var pts = [];
        for (var i = 0; i <= mth.segs; i++) {
            var t = (i / mth.segs) * 2 - 1;  // -1..1
            var curv = (1 - t * t);
            var xp = t * mth.hw;
            // Smile shape: ends up, center down — reversed parabola
            var yBase = mth.y - curv * 0.025;
            pts.push(proj(xp, yBase + open * curv * 0.5, mth.z));
        }

        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',' + (0.50 + mouthOpen * 0.4) + ')';
        wireCtx.lineWidth = 1.3 + mouthOpen * 0.8;
        wireCtx.beginPath();
        for (var i = 0; i < pts.length; i++) {
            i === 0 ? wireCtx.moveTo(pts[i].x, pts[i].y) : wireCtx.lineTo(pts[i].x, pts[i].y);
        }
        wireCtx.stroke();

        // When singing, open up a gap below (lower lip drops)
        if (open > 0.003) {
            var lower = [];
            for (var i = 0; i <= mth.segs; i++) {
                var t = (i / mth.segs) * 2 - 1;
                var curv = (1 - t * t);
                var xp = t * mth.hw * 0.9;
                lower.push(proj(xp, mth.y - open * curv * 2.5 - 0.015, mth.z));
            }
            wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',' + (0.3 + mouthOpen * 0.35) + ')';
            wireCtx.lineWidth = 1.0 + mouthOpen * 0.5;
            wireCtx.beginPath();
            for (var i = 0; i < lower.length; i++) {
                i === 0 ? wireCtx.moveTo(lower[i].x, lower[i].y) : wireCtx.lineTo(lower[i].x, lower[i].y);
            }
            wireCtx.stroke();

            // Inner glow when wide open
            if (mouthOpen > 0.25) {
                var gc = proj(0, mth.y - open * 1.2, mth.z - 0.01);
                var glowR = Math.abs(pts[0].x - pts[pts.length-1].x) * 0.35;
                var grad = wireCtx.createRadialGradient(gc.x, gc.y, 0, gc.x, gc.y, glowR);
                grad.addColorStop(0, 'rgba(' + char.accentRGB + ',' + Math.min(0.10, mouthOpen * 0.12) + ')');
                grad.addColorStop(1, 'rgba(' + char.accentRGB + ',0)');
                wireCtx.fillStyle = grad;
                wireCtx.beginPath();
                wireCtx.arc(gc.x, gc.y, glowR, 0, Math.PI * 2);
                wireCtx.fill();
            }
        }
    }

    // =========================================================
    //  Metal Shutter (3.5" floppy disk shutter that slides with music)
    // =========================================================
    function drawShutter(char, proj, amp, bass) {
        if (!char.shutter) return;
        var sh = char.shutter;
        var box = char.boxDims;
        var d = box.d;
        var t = performance.now() * 0.001;

        // Shutter slides open/closed with vocal/amplitude
        // More open = more singing energy
        var slideAmount = Math.min(1, mouthOpen * 1.8 + bass * 0.3);
        var slideOffset = slideAmount * sh.width * 0.7;  // slides to the right

        var shutL = -sh.width + slideOffset;
        var shutR =  sh.width + slideOffset;
        var shutT =  sh.yTop;
        var shutB =  sh.yBot;
        var shutZ =  d + 0.006;  // slightly in front of disk body

        wireCtx.shadowBlur = 3 + bass * 5;
        wireCtx.shadowColor = sh.color;

        // Shutter body (metal rectangle)
        wireCtx.strokeStyle = 'rgba(' + sh.rgb + ',' + (0.45 + bass * 0.15) + ')';
        wireCtx.lineWidth = 1.2;
        var stl = proj(shutL, shutT, shutZ);
        var str2 = proj(shutR, shutT, shutZ);
        var sbr = proj(shutR, shutB, shutZ);
        var sbl = proj(shutL, shutB, shutZ);
        wireCtx.beginPath();
        wireCtx.moveTo(stl.x, stl.y); wireCtx.lineTo(str2.x, str2.y);
        wireCtx.lineTo(sbr.x, sbr.y); wireCtx.lineTo(sbl.x, sbl.y);
        wireCtx.closePath();
        wireCtx.stroke();

        // Shutter center groove (the ridge you grab)
        var grooveX = (shutL + shutR) * 0.5;
        var grooveT = proj(grooveX, shutT * 0.95, shutZ + 0.002);
        var grooveB = proj(grooveX, shutB * 1.05, shutZ + 0.002);
        wireCtx.strokeStyle = 'rgba(' + sh.rgb + ',0.25)';
        wireCtx.lineWidth = 0.8;
        wireCtx.beginPath();
        wireCtx.moveTo(grooveT.x, grooveT.y);
        wireCtx.lineTo(grooveB.x, grooveB.y);
        wireCtx.stroke();

        // When shutter is open, show the read/write hole underneath
        if (slideAmount > 0.15) {
            var holeAlpha = Math.min(0.4, (slideAmount - 0.15) * 0.6);
            var holeX = -sh.width * 0.3;  // hole is left-of-center
            var holeY = (shutT + shutB) * 0.5;
            var holeC = proj(holeX, holeY, d + 0.001);
            var holeScale = Math.abs(proj(sh.holeRadius, holeY, d).x - proj(0, holeY, d).x);

            // Oval read/write window
            wireCtx.strokeStyle = 'rgba(40,40,40,' + holeAlpha + ')';
            wireCtx.lineWidth = 0.8;
            wireCtx.beginPath();
            wireCtx.ellipse(holeC.x, holeC.y, holeScale * 1.5, holeScale * 0.8,
                            0, 0, Math.PI * 2);
            wireCtx.stroke();

            // Dark fill inside
            wireCtx.fillStyle = 'rgba(0,0,0,' + (holeAlpha * 0.5) + ')';
            wireCtx.fill();

            // Spinning disk media visible through the hole (subtle)
            if (slideAmount > 0.3) {
                var spinAngle = t * 6;  // steady spin
                wireCtx.strokeStyle = 'rgba(60,60,60,' + (holeAlpha * 0.4) + ')';
                wireCtx.lineWidth = 0.4;
                for (var ri = 0; ri < 3; ri++) {
                    var ra = spinAngle + ri * (Math.PI * 2 / 3);
                    var rx = holeC.x + Math.cos(ra) * holeScale * 1.2;
                    var ry = holeC.y + Math.sin(ra) * holeScale * 0.6;
                    wireCtx.beginPath();
                    wireCtx.moveTo(holeC.x, holeC.y);
                    wireCtx.lineTo(rx, ry);
                    wireCtx.stroke();
                }
            }
        }
    }

    // =========================================================
    //  Drive Slot Mouth (for floppy drive characters)
    // =========================================================
    function drawDriveSlot(proj, char, mth) {
        var slotOpen = mouthOpen * 0.16;  // wider range than lip mouth
        var slotHW = mth.hw;
        var slotY = mth.y;
        var slotZ = mth.z;

        // Slot rail thickness
        var railH = 0.018;

        // Top rail (stays mostly in place)
        var tl = proj(-slotHW, slotY + railH, slotZ);
        var tr = proj(slotHW, slotY + railH, slotZ);
        var tl2 = proj(-slotHW, slotY + railH + 0.008, slotZ);
        var tr2 = proj(slotHW, slotY + railH + 0.008, slotZ);

        // Bottom rail (drops when opening)
        var drop = slotOpen * 1.8;
        var bl = proj(-slotHW, slotY - railH - drop, slotZ);
        var br = proj(slotHW, slotY - railH - drop, slotZ);
        var bl2 = proj(-slotHW, slotY - railH - drop - 0.008, slotZ);
        var br2 = proj(slotHW, slotY - railH - drop - 0.008, slotZ);

        // Slot opening glow
        wireCtx.shadowBlur = 4 + mouthOpen * 18;
        wireCtx.shadowColor = char.accentColor;

        // Top rail (double line for thickness)
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',' + (0.6 + mouthOpen * 0.3) + ')';
        wireCtx.lineWidth = 1.5;
        wireCtx.beginPath();
        wireCtx.moveTo(tl.x, tl.y); wireCtx.lineTo(tr.x, tr.y);
        wireCtx.stroke();
        wireCtx.lineWidth = 0.8;
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.3)';
        wireCtx.beginPath();
        wireCtx.moveTo(tl2.x, tl2.y); wireCtx.lineTo(tr2.x, tr2.y);
        wireCtx.stroke();

        // Bottom rail
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',' + (0.6 + mouthOpen * 0.3) + ')';
        wireCtx.lineWidth = 1.5;
        wireCtx.beginPath();
        wireCtx.moveTo(bl.x, bl.y); wireCtx.lineTo(br.x, br.y);
        wireCtx.stroke();
        wireCtx.lineWidth = 0.8;
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.3)';
        wireCtx.beginPath();
        wireCtx.moveTo(bl2.x, bl2.y); wireCtx.lineTo(br2.x, br2.y);
        wireCtx.stroke();

        // Side rails connecting top to bottom
        wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',0.30)';
        wireCtx.lineWidth = 0.8;
        wireCtx.beginPath();
        wireCtx.moveTo(tl.x, tl.y); wireCtx.lineTo(bl.x, bl.y);
        wireCtx.stroke();
        wireCtx.beginPath();
        wireCtx.moveTo(tr.x, tr.y); wireCtx.lineTo(br.x, br.y);
        wireCtx.stroke();

        // Internal mechanism visible when slot opens
        if (slotOpen > 0.006) {
            var mechAlpha = Math.min(0.55, slotOpen * 4);
            var mechInnerZ = slotZ - 0.04;

            // Guide rails (two horizontal tracks inside)
            wireCtx.strokeStyle = 'rgba(' + char.wireRGB + ',' + (mechAlpha * 0.5) + ')';
            wireCtx.lineWidth = 0.6;
            var railY1 = slotY + railH * 0.3;
            var railY2 = slotY - railH - drop * 0.4;
            var gl1l = proj(-slotHW * 0.9, railY1, mechInnerZ);
            var gl1r = proj(slotHW * 0.9, railY1, mechInnerZ);
            var gl2l = proj(-slotHW * 0.9, railY2, mechInnerZ);
            var gl2r = proj(slotHW * 0.9, railY2, mechInnerZ);
            wireCtx.beginPath();
            wireCtx.moveTo(gl1l.x, gl1l.y); wireCtx.lineTo(gl1r.x, gl1r.y);
            wireCtx.stroke();
            wireCtx.beginPath();
            wireCtx.moveTo(gl2l.x, gl2l.y); wireCtx.lineTo(gl2r.x, gl2r.y);
            wireCtx.stroke();

            // Read head carriage — slides back and forth with audio
            var headT = performance.now() * 0.002;
            var headX = Math.sin(headT) * slotHW * 0.5;
            var headY = (railY1 + railY2) * 0.5;
            var headW = 0.06;
            wireCtx.strokeStyle = 'rgba(' + char.accentRGB + ',' + mechAlpha + ')';
            wireCtx.shadowColor = char.accentColor;
            wireCtx.shadowBlur = 6 + mouthOpen * 12;
            wireCtx.lineWidth = 1.2;
            var hl = proj(headX - headW, headY, mechInnerZ);
            var hr = proj(headX + headW, headY, mechInnerZ);
            wireCtx.beginPath();
            wireCtx.moveTo(hl.x, hl.y); wireCtx.lineTo(hr.x, hr.y);
            wireCtx.stroke();

            // Read head vertical arm
            wireCtx.lineWidth = 0.6;
            wireCtx.strokeStyle = 'rgba(' + char.accentRGB + ',' + (mechAlpha * 0.6) + ')';
            var hc = proj(headX, railY1, mechInnerZ);
            var hb = proj(headX, railY2, mechInnerZ);
            wireCtx.beginPath();
            wireCtx.moveTo(hc.x, hc.y); wireCtx.lineTo(hb.x, hb.y);
            wireCtx.stroke();
        }

        // Inner glow when open (the princess pink glow)
        if (mouthOpen > 0.15) {
            var glowAlpha = Math.min(0.12, (mouthOpen - 0.15) * 0.3);
            var gc = proj(0, slotY - drop * 0.4, slotZ - 0.01);
            var grad = wireCtx.createRadialGradient(
                gc.x, gc.y, 0,
                gc.x, gc.y, Math.abs(tr.x - tl.x) * 0.5
            );
            grad.addColorStop(0, 'rgba(' + char.accentRGB + ',' + glowAlpha + ')');
            grad.addColorStop(1, 'rgba(' + char.accentRGB + ',0)');
            wireCtx.fillStyle = grad;
            wireCtx.fillRect(tl.x, tl.y, tr.x - tl.x, bl.y - tl.y);
        }
    }

    // =========================================================
    //  Eyelashes (feminine detail with music-reactive flutter)
    // =========================================================
    function drawEyelashes(char, proj, amp, bass) {
        if (!char.eyelashes) return;
        var lash = char.eyelashes;
        var eyes = [char.eyes.left, char.eyes.right];
        var t = performance.now() * 0.001;

        wireCtx.shadowBlur = 3 + bass * 5;
        wireCtx.shadowColor = lash.color;
        wireCtx.lineCap = 'round';

        // Which sets to draw: top always, bottom if flagged
        var sets = ['top'];
        if (lash.bottom) sets.push('bottom');

        for (var ei = 0; ei < 2; ei++) {
            var eye = eyes[ei];
            var blinkAmt = getEyeBlinkAmount(ei === 0 ? 'left' : 'right');
            if (blinkAmt > 0.8) continue;

            var eyeScaleY = Math.max(0.08, 0.7 - blinkAmt * 0.62);
            var count = lash.count;

            for (var si = 0; si < sets.length; si++) {
                var isBottom = (sets[si] === 'bottom');
                // Bottom lashes: shorter, fewer
                var setCount = isBottom ? Math.max(3, count - 1) : count;
                var setLen   = isBottom ? lash.length * 0.55 : lash.length;

                for (var i = 0; i < setCount; i++) {
                    var frac = setCount > 1 ? (i / (setCount - 1)) : 0.5;

                    // Arc range: top ~50-130deg, bottom ~230-310deg (mirrored)
                    var baseAngle;
                    if (isBottom) {
                        baseAngle = Math.PI + (0.28 + frac * 0.44) * Math.PI;
                    } else {
                        baseAngle = (0.28 + frac * 0.44) * Math.PI;
                    }

                    // Music-reactive wiggle — oscillating wave per lash
                    var wiggle = 0;
                    if (lash.reactive && headFreqData.length > 60) {
                        var fi = Math.min(headFreqData.length - 1,
                                          50 + Math.floor(i * 4) + ei * 20);
                        var freq = headFreqData[fi] || 0;
                        // Continuous sinusoidal wiggle driven by freq energy
                        wiggle = freq * 0.22 * Math.sin(t * 8 + i * 1.8 + ei * 3.5);
                    }

                    // Breath sway + bass pulse
                    var sway = Math.sin(breathPhase * 1.5 + i * 0.7 + si * 2) * 0.035;
                    var bassPulse = bass * 0.06 * Math.sin(t * 12 + i * 2);
                    var angle = baseAngle + wiggle + sway + bassPulse;

                    // Length: longest in center
                    var centerBoost = 1 - Math.abs(frac - 0.5) * 1.2;
                    var len = setLen * (0.7 + centerBoost * 0.6);

                    // Blink effect
                    if (!isBottom) {
                        angle = angle * (1 - blinkAmt * 0.7) + (Math.PI * 0.5) * blinkAmt * 0.7;
                    } else {
                        angle = angle * (1 - blinkAmt * 0.7) + (Math.PI * 1.5) * blinkAmt * 0.7;
                    }

                    // Start at eye edge
                    var sx = eye.x + eye.r * Math.cos(angle);
                    var sy = eye.y + eye.r * Math.sin(angle) * eyeScaleY;

                    // End with curl
                    var ex = eye.x + (eye.r + len) * Math.cos(angle);
                    var ey = eye.y + (eye.r + len) * Math.sin(angle) * eyeScaleY;
                    // Curl: top curls up, bottom curls down
                    ey += len * (isBottom ? -0.12 : 0.15);

                    var p1 = proj(sx, sy, eye.z);
                    var p2 = proj(ex, ey, eye.z + 0.01);

                    var alpha = (isBottom ? 0.35 : 0.5) + Math.abs(wiggle) * 1.5 + bass * 0.2;
                    wireCtx.strokeStyle = 'rgba(' + lash.rgb + ',' + Math.min(0.9, alpha) + ')';
                    wireCtx.lineWidth = lash.width * (0.8 + centerBoost * 0.4) * (isBottom ? 0.7 : 1.0);
                    wireCtx.beginPath();
                    wireCtx.moveTo(p1.x, p1.y);
                    wireCtx.lineTo(p2.x, p2.y);
                    wireCtx.stroke();
                }
            }
        }
    }

    // =========================================================
    //  LED Indicators (activity/power lights)
    // =========================================================
    function drawLEDs(char, proj, amp, bass) {
        if (!char.ledIndicators) return;
        var leds = char.ledIndicators;
        var t = performance.now() * 0.001;

        for (var i = 0; i < leds.length; i++) {
            var led = leds[i];
            var z = char.boxDims ? char.boxDims.d + 0.01 : 0.50;
            var pt = proj(led.x, led.y, z);

            var brightness = 0;
            if (led.mode === 'power') {
                // Steady on with subtle pulse
                brightness = 0.6 + Math.sin(t * 0.5) * 0.08;
            } else if (led.mode === 'activity') {
                // Flickers with audio amplitude — like disk access
                var flicker = amp * 2.5 + bass * 1.5;
                // Rapid on/off simulation
                var rapid = Math.sin(t * 18 + amp * 40) > 0 ? 1 : 0.1;
                brightness = Math.min(1, flicker) * rapid;
                // Idle: occasional blink
                if (amp < 0.05) {
                    brightness = Math.sin(t * 0.3) > 0.95 ? 0.4 : 0.05;
                }
            }

            if (brightness < 0.02) continue;

            // LED glow (outer)
            wireCtx.shadowColor = led.color;
            wireCtx.shadowBlur = 8 + brightness * 14;
            wireCtx.fillStyle = 'rgba(' + led.rgb + ',' + (brightness * 0.6) + ')';
            wireCtx.beginPath();
            wireCtx.arc(pt.x, pt.y, 3.5 + brightness * 2, 0, Math.PI * 2);
            wireCtx.fill();

            // LED core (bright center)
            wireCtx.fillStyle = 'rgba(' + led.rgb + ',' + brightness + ')';
            wireCtx.beginPath();
            wireCtx.arc(pt.x, pt.y, 1.5 + brightness, 0, Math.PI * 2);
            wireCtx.fill();

            // LED outline ring
            wireCtx.strokeStyle = 'rgba(' + led.rgb + ',' + (brightness * 0.4) + ')';
            wireCtx.lineWidth = 0.6;
            wireCtx.beginPath();
            wireCtx.arc(pt.x, pt.y, 4.5 + brightness * 2, 0, Math.PI * 2);
            wireCtx.stroke();
        }
    }

    function drawHat(char, proj, amp, bass) {
        if (!char.hat) return;
        if (char.hat.type === 'cowboy') {
            drawCowboyHat(char, proj, amp, bass);
        } else if (char.hat.type === 'baseballcap') {
            drawBaseballCap(char, proj, amp, bass);
        } else if (char.hat.type === 'afro') {
            drawAfro(char, proj, amp, bass);
        }
    }

    // === Afro hairstyle: dome with honeycomb ribbing ===
    function drawAfro(char, proj, amp, bass) {
        var hat = char.hat;
        var t = performance.now() * 0.001;

        // Find head top from profile
        var topY = 0.62;
        if (char.profile) {
            for (var i = 0; i < char.profile.length; i++) {
                if (char.profile[i][1] > topY) topY = char.profile[i][1];
            }
        }

        var bob = bass * 0.010 + Math.sin(breathPhase) * 0.003;
        var afroBase = 0.16 + bob;  // start at hairline level (forehead), dome grows UP from here

        var afroH   = hat.height || 0.50;
        var afroRX  = hat.radiusX || 0.60;
        var afroRZ  = hat.radiusZ || 0.48;
        var rings   = hat.rings || 7;
        var hSegs   = hat.honeycombSegs || 12;
        var fluff   = hat.fluffiness || 0.04;

        // Seeded pseudo-random for consistent fluffiness per vertex
        function hashRand(a, b) {
            var h = (a * 2654435761 + b * 340573321) & 0x7FFFFFFF;
            return ((h % 1000) / 1000) - 0.5;  // -0.5..0.5
        }

        // Build dome grid: rings from base to top
        // Each ring is a horizontal circle that tapers toward the top
        // to form a rounded dome (hemisphere-ish)
        var grid = [];  // grid[ring][seg] = {x,y,z}
        for (var r = 0; r <= rings; r++) {
            var frac = r / rings;  // 0 = base, 1 = top

            // Dome curve: use sine for hemisphere shape
            var angle = frac * Math.PI * 0.5;  // 0..90 degrees
            var cy = afroBase + afroH * Math.sin(angle);
            var taper = Math.cos(angle);  // 1 at base, 0 at top
            // Don't let taper go to zero — keep small circle at top
            taper = Math.max(0.08, taper);

            // Slight bass breathing on radius
            var breathR = 1 + bass * 0.015;

            var row = [];
            for (var s = 0; s < hSegs; s++) {
                var a = (s / hSegs) * Math.PI * 2;
                // Honeycomb offset: odd rows shift by half a segment
                var offset = (r % 2 === 1) ? (Math.PI / hSegs) : 0;
                var ax = a + offset;

                // Fluffiness: per-vertex displacement for textured look
                var fx = hashRand(r, s) * fluff * (1 + bass * 0.5);
                var fy = hashRand(r + 100, s) * fluff * 0.6;
                var fz = hashRand(r, s + 100) * fluff * (1 + bass * 0.5);

                // Audio-reactive pulsing — different freq bands per ring
                var freqSample = getFreqSample(frac);
                var pulse = freqSample * 0.012;

                row.push({
                    x: (afroRX * taper * breathR + fx + pulse) * Math.cos(ax),
                    y: cy + fy,
                    z: (afroRZ * taper * breathR + fz + pulse) * Math.sin(ax)
                });
            }
            grid.push(row);
        }

        // Project all points
        var pts = [];  // pts[ring][seg] = projected point
        for (var r = 0; r <= rings; r++) {
            var row = [];
            for (var s = 0; s < hSegs; s++) {
                row.push(proj(grid[r][s].x, grid[r][s].y, grid[r][s].z));
            }
            pts.push(row);
        }

        var rgb = hat.rgb;
        var hex = hat.color;

        // --- Horizontal rings (each ring of the dome) ---
        wireCtx.shadowBlur = 5 + bass * 8;
        wireCtx.shadowColor = hex;
        for (var r = 0; r <= rings; r++) {
            var frac = r / rings;
            var alpha = 0.35 + frac * 0.20 + bass * 0.10;
            var lw = 1.3 + (1 - frac) * 0.5;
            wireCtx.strokeStyle = 'rgba(' + rgb + ',' + Math.min(1, alpha).toFixed(3) + ')';
            wireCtx.lineWidth = lw;
            wireCtx.beginPath();
            for (var s = 0; s < hSegs; s++) {
                s === 0 ? wireCtx.moveTo(pts[r][s].x, pts[r][s].y)
                        : wireCtx.lineTo(pts[r][s].x, pts[r][s].y);
            }
            wireCtx.closePath();
            wireCtx.stroke();
        }

        // --- Honeycomb diagonal connections ---
        // Connect each vertex to the two nearest vertices on adjacent rows
        // Since odd rows are offset by half a segment, this creates hexagonal cells
        wireCtx.shadowBlur = 3 + bass * 5;
        for (var r = 0; r < rings; r++) {
            var frac = r / rings;
            var freqV = getFreqSample(frac);
            var alpha = 0.18 + freqV * 0.22 + bass * 0.08;
            var lw = 0.7 + freqV * 0.4;
            wireCtx.strokeStyle = 'rgba(' + rgb + ',' + Math.min(1, alpha).toFixed(3) + ')';
            wireCtx.lineWidth = lw;

            for (var s = 0; s < hSegs; s++) {
                var p1 = pts[r][s];

                // Connect to next row — two diagonal neighbors
                // When r is even: connect to s and (s-1) on next row (which is offset)
                // When r is odd: connect to s and (s+1) on next row
                if (r % 2 === 0) {
                    // Even row -> odd row (offset right by half seg)
                    var s2a = s;
                    var s2b = (s - 1 + hSegs) % hSegs;
                    wireCtx.beginPath();
                    wireCtx.moveTo(p1.x, p1.y);
                    wireCtx.lineTo(pts[r+1][s2a].x, pts[r+1][s2a].y);
                    wireCtx.stroke();
                    wireCtx.beginPath();
                    wireCtx.moveTo(p1.x, p1.y);
                    wireCtx.lineTo(pts[r+1][s2b].x, pts[r+1][s2b].y);
                    wireCtx.stroke();
                } else {
                    // Odd row -> even row (no offset)
                    var s2a = s;
                    var s2b = (s + 1) % hSegs;
                    wireCtx.beginPath();
                    wireCtx.moveTo(p1.x, p1.y);
                    wireCtx.lineTo(pts[r+1][s2a].x, pts[r+1][s2a].y);
                    wireCtx.stroke();
                    wireCtx.beginPath();
                    wireCtx.moveTo(p1.x, p1.y);
                    wireCtx.lineTo(pts[r+1][s2b].x, pts[r+1][s2b].y);
                    wireCtx.stroke();
                }
            }
        }

        // --- Subtle sheen highlight at crown ---
        var topRow = pts[rings];
        var cx = 0, cy = 0;
        for (var s = 0; s < topRow.length; s++) {
            cx += topRow[s].x; cy += topRow[s].y;
        }
        cx /= topRow.length; cy /= topRow.length;
        var glowR = 8 + bass * 6;
        wireCtx.shadowBlur = 10 + bass * 12;
        wireCtx.shadowColor = hex;
        var grad = wireCtx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
        grad.addColorStop(0, 'rgba(' + rgb + ',' + (0.12 + bass * 0.08).toFixed(3) + ')');
        grad.addColorStop(1, 'rgba(' + rgb + ',0)');
        wireCtx.fillStyle = grad;
        wireCtx.beginPath();
        wireCtx.arc(cx, cy, glowR, 0, Math.PI * 2);
        wireCtx.fill();

        wireCtx.shadowBlur = 0;
    }

    function drawCowboyHat(char, proj, amp, bass) {
        var hat = char.hat;
        var t = performance.now() * 0.001;

        // Hat sits on top of the head — find the crown top from profile
        var topY = 0.64;  // approximate top of skull
        for (var i = 0; i < char.profile.length; i++) {
            if (char.profile[i][1] > topY) topY = char.profile[i][1];
        }

        // Subtle bob with music
        var bob = bass * 0.012 + Math.sin(breathPhase) * 0.003;
        var hatBase = topY - 0.08 + bob;  // sit lower, hug the head

        // === Brim ===
        // Wide oval below the crown — cowboy hat brim extends far out
        var brimY = hatBase + 0.02;
        var brimSegs = 20;
        var brimPts = [];
        for (var i = 0; i <= brimSegs; i++) {
            var a = (i / brimSegs) * Math.PI * 2;
            var brimRadX = 0.88;  // wide
            var brimRadZ = 0.55;  // front-to-back
            // Curve the brim: front and back tilt down, sides stay up
            var brimDip = -Math.abs(Math.cos(a)) * 0.06 + Math.abs(Math.sin(a)) * 0.05;
            brimPts.push(proj(
                brimRadX * Math.cos(a),
                brimY + brimDip,
                brimRadZ * Math.sin(a)
            ));
        }

        wireCtx.shadowBlur  = 6 + bass * 8;
        wireCtx.shadowColor = hat.color;
        wireCtx.strokeStyle = 'rgba(' + hat.rgb + ',0.7)';
        wireCtx.lineWidth   = 2.2;
        wireCtx.lineCap = 'round';
        stroke(brimPts);

        // Inner brim edge (gives thickness)
        var innerBrimPts = [];
        for (var i = 0; i <= brimSegs; i++) {
            var a = (i / brimSegs) * Math.PI * 2;
            var iRadX = 0.44;
            var iRadZ = 0.34;
            innerBrimPts.push(proj(
                iRadX * Math.cos(a),
                brimY + 0.01,
                iRadZ * Math.sin(a)
            ));
        }
        wireCtx.strokeStyle = 'rgba(' + hat.rgb + ',0.4)';
        wireCtx.lineWidth   = 1.0;
        stroke(innerBrimPts);

        // === Crown (the tall part) ===
        var crownBase = hatBase + 0.03;
        var crownTop  = crownBase + 0.36;
        var crownRadX = 0.36;
        var crownRadZ = 0.28;

        // Crown rings (horizontal bands)
        var crownRings = 5;
        wireCtx.strokeStyle = 'rgba(' + hat.rgb + ',0.55)';
        wireCtx.lineWidth   = 1.2;
        for (var r = 0; r <= crownRings; r++) {
            var frac = r / crownRings;
            var cy = crownBase + (crownTop - crownBase) * frac;
            // Slight taper toward top, pinch at very top for dent
            var taper = 1.0 - frac * 0.15;
            var dent = (frac > 0.85) ? (1.0 - (frac - 0.85) * 3.0) : 1.0;
            var rpts = [];
            for (var i = 0; i <= 16; i++) {
                var a = (i / 16) * Math.PI * 2;
                rpts.push(proj(
                    crownRadX * taper * dent * Math.cos(a),
                    cy,
                    crownRadZ * taper * dent * Math.sin(a)
                ));
            }
            stroke(rpts);
        }

        // Crown vertical ribs
        wireCtx.strokeStyle = 'rgba(' + hat.rgb + ',0.3)';
        wireCtx.lineWidth   = 0.8;
        for (var s = 0; s < 8; s++) {
            var a = (s / 8) * Math.PI * 2;
            wireCtx.beginPath();
            for (var r = 0; r <= crownRings; r++) {
                var frac = r / crownRings;
                var cy = crownBase + (crownTop - crownBase) * frac;
                var taper = 1.0 - frac * 0.15;
                var dent = (frac > 0.85) ? (1.0 - (frac - 0.85) * 3.0) : 1.0;
                var pt = proj(
                    crownRadX * taper * dent * Math.cos(a),
                    cy,
                    crownRadZ * taper * dent * Math.sin(a)
                );
                r === 0 ? wireCtx.moveTo(pt.x, pt.y) : wireCtx.lineTo(pt.x, pt.y);
            }
            wireCtx.stroke();
        }

        // === Hat band ===
        var bandY = crownBase + 0.04;
        var bandPts = [];
        for (var i = 0; i <= 16; i++) {
            var a = (i / 16) * Math.PI * 2;
            bandPts.push(proj(
                crownRadX * 1.02 * Math.cos(a),
                bandY,
                crownRadZ * 1.02 * Math.sin(a)
            ));
        }
        wireCtx.shadowColor = hat.bandColor;
        wireCtx.strokeStyle = 'rgba(' + hat.bandRGB + ',0.8)';
        wireCtx.lineWidth   = 2.5;
        stroke(bandPts);
    }

    // =========================================================
    //  Baseball Cap Renderer
    // =========================================================
    function drawBaseballCap(char, proj, amp, bass) {
        var hat = char.hat;
        var t = performance.now() * 0.001;

        // Find the top of the head from profile
        var topY = 0.62;
        if (char.profile) {
            for (var i = 0; i < char.profile.length; i++) {
                if (char.profile[i][1] > topY) topY = char.profile[i][1];
            }
        }

        // Bob with music
        var bob = bass * 0.010 + Math.sin(breathPhase) * 0.003;
        var capBase = topY - 0.10 + bob;

        // === Curved front brim ===
        // Baseball cap brim extends forward and slightly down
        var brimSegs = 14;
        var brimPts = [];
        for (var i = 0; i <= brimSegs; i++) {
            var frac = i / brimSegs;  // 0..1 across the brim arc
            var a = -Math.PI * 0.45 + frac * Math.PI * 0.90;  // front 90° arc
            var brimRadX = 0.50;  // side extent
            var brimRadZ = 0.50;  // forward extent
            // Brim slopes down at the front
            var brimDip = -0.04 * Math.cos(a);  // lower in front
            brimPts.push(proj(
                brimRadX * Math.sin(a),
                capBase + 0.02 + brimDip,
                brimRadZ * Math.cos(a)
            ));
        }

        var brimC = hat.brimColor || hat.color;
        var brimR = hat.brimRGB || hat.rgb;
        wireCtx.shadowBlur  = 6 + bass * 8;
        wireCtx.shadowColor = brimC;
        wireCtx.strokeStyle = 'rgba(' + brimR + ',0.8)';
        wireCtx.lineWidth   = 2.8;
        wireCtx.lineCap = 'round';
        wireCtx.lineJoin = 'round';
        stroke(brimPts);

        // Brim underside shadow line
        var underPts = [];
        for (var i = 0; i <= brimSegs; i++) {
            var frac = i / brimSegs;
            var a = -Math.PI * 0.45 + frac * Math.PI * 0.90;
            var brimRadX = 0.48;
            var brimRadZ = 0.48;
            var brimDip = -0.04 * Math.cos(a) - 0.02;
            underPts.push(proj(
                brimRadX * Math.sin(a),
                capBase + 0.02 + brimDip,
                brimRadZ * Math.cos(a)
            ));
        }
        wireCtx.strokeStyle = 'rgba(' + brimR + ',0.35)';
        wireCtx.lineWidth   = 1.2;
        stroke(underPts);

        // === Crown (dome) ===
        var crownTop = capBase + 0.30;
        var crownRadX = 0.38;
        var crownRadZ = 0.34;

        // Crown rings (horizontal bands)
        var crownRings = 4;
        wireCtx.strokeStyle = 'rgba(' + hat.rgb + ',0.55)';
        wireCtx.lineWidth   = 1.4;
        for (var r = 0; r <= crownRings; r++) {
            var frac = r / crownRings;
            var cy = capBase + (crownTop - capBase) * frac;
            // Dome taper — narrower at top
            var taper = 1.0 - frac * frac * 0.45;
            var rpts = [];
            for (var i = 0; i <= 16; i++) {
                var a = (i / 16) * Math.PI * 2;
                rpts.push(proj(
                    crownRadX * taper * Math.cos(a),
                    cy,
                    crownRadZ * taper * Math.sin(a)
                ));
            }
            stroke(rpts);
        }

        // Crown vertical ribs (panels — baseball caps have 6 panels)
        wireCtx.strokeStyle = 'rgba(' + hat.rgb + ',0.3)';
        wireCtx.lineWidth   = 0.8;
        var panels = 6;
        for (var s = 0; s < panels; s++) {
            var a = (s / panels) * Math.PI * 2;
            wireCtx.beginPath();
            for (var r = 0; r <= crownRings; r++) {
                var frac = r / crownRings;
                var cy = capBase + (crownTop - capBase) * frac;
                var taper = 1.0 - frac * frac * 0.45;
                var pt = proj(
                    crownRadX * taper * Math.cos(a),
                    cy,
                    crownRadZ * taper * Math.sin(a)
                );
                r === 0 ? wireCtx.moveTo(pt.x, pt.y) : wireCtx.lineTo(pt.x, pt.y);
            }
            wireCtx.stroke();
        }

        // Button on top
        var buttonPt = proj(0, crownTop + 0.01, 0);
        wireCtx.fillStyle = 'rgba(' + hat.rgb + ',0.7)';
        wireCtx.beginPath();
        wireCtx.arc(buttonPt.x, buttonPt.y, 2.5, 0, Math.PI * 2);
        wireCtx.fill();

        // === Band where crown meets brim ===
        var bandPts = [];
        for (var i = 0; i <= 16; i++) {
            var a = (i / 16) * Math.PI * 2;
            bandPts.push(proj(
                crownRadX * 1.02 * Math.cos(a),
                capBase + 0.02,
                crownRadZ * 1.02 * Math.sin(a)
            ));
        }
        wireCtx.strokeStyle = 'rgba(' + hat.rgb + ',0.7)';
        wireCtx.lineWidth   = 2.0;
        stroke(bandPts);
    }

    function drawFacialHair(char, proj, amp, bass) {
        if (!char.facialHair) return;
        if (char.facialHair.type === 'moustache') {
            drawMoustache(char, proj, amp, bass);
        }
    }

    function drawMoustache(char, proj, amp, bass) {
        var stache = char.facialHair;
        var t = performance.now() * 0.001;
        var mth = char.mouth;

        // Moustache sits between nose base and upper lip
        var stacheY = (char.nose.base[0][1] + mth.y) * 0.5 + 0.01;
        var stacheZ = mth.z + 0.02;  // slightly in front of mouth

        // Center point (under nose)
        var center = proj(0, stacheY, stacheZ);

        // Subtle droop/sway with music
        var breathSway = Math.sin(breathPhase + 1.5) * 0.004;
        var bassBounce = bass * 0.008;

        wireCtx.shadowBlur  = 4 + bass * 6;
        wireCtx.shadowColor = stache.color;
        wireCtx.strokeStyle = 'rgba(' + stache.rgb + ',0.85)';
        wireCtx.lineWidth   = stache.width || 1.5;
        wireCtx.lineCap = 'round';

        // Each side: bezier from center outward and down
        var sides = [-1, 1];
        for (var si = 0; si < sides.length; si++) {
            var sign = sides[si];
            var spread = stache.spread || 0.20;
            var droop  = stache.droop  || 0.05;
            var curl   = stache.curl   || 0.01;

            // Endpoint: out to the side and drooping down
            var endX = sign * spread;
            var endY = stacheY - droop - bassBounce + breathSway;
            var endZ = stacheZ - 0.04;  // recede slightly at tips

            // Curl: tip lifts back up a bit
            endY += curl;

            // Control point: gives the classic handlebar curve
            var cpX = sign * spread * 0.55;
            var cpY = stacheY + 0.005 - droop * 0.3;  // sag in middle
            var cpZ = stacheZ;

            var pEnd = proj(endX, endY, endZ);
            var pCP  = proj(cpX, cpY, cpZ);

            wireCtx.beginPath();
            wireCtx.moveTo(center.x, center.y);
            wireCtx.quadraticCurveTo(pCP.x, pCP.y, pEnd.x, pEnd.y);
            wireCtx.stroke();

            // Thickness: parallel stroke slightly below
            wireCtx.globalAlpha = 0.45;
            wireCtx.lineWidth   = (stache.width || 1.5) * 0.6;
            var pEnd2 = proj(endX, endY - 0.012, endZ);
            var pCP2  = proj(cpX,  cpY  - 0.012, cpZ);
            wireCtx.beginPath();
            wireCtx.moveTo(center.x, center.y + 1);
            wireCtx.quadraticCurveTo(pCP2.x, pCP2.y, pEnd2.x, pEnd2.y);
            wireCtx.stroke();
            wireCtx.globalAlpha = 1;
            wireCtx.lineWidth   = stache.width || 1.5;
        }
    }

    // =========================================================
    //  Body Renderer — Vectrex / laser-scan neon wireframe
    //  Beat-synced dance system with move library
    // =========================================================

    // ---------------------------------------------------------
    //  Beat Detector — bass-onset BPM estimation
    // ---------------------------------------------------------
    var beatDetector = {
        history:      [],       // recent bass values (ring buffer)
        histLen:      12,       // frames of history to keep
        histIdx:      0,
        prevBass:     0,
        threshold:    0.12,     // minimum bass delta to count as onset
        lastOnsetT:   0,        // timestamp of last detected onset
        onsetTimes:   [],       // recent onset timestamps for BPM calc
        maxOnsets:    16,       // keep last N onsets for averaging
        bpm:          120,      // estimated BPM (fallback default)
        beatPhase:    0,        // 0..1 = position within current beat
        beatCount:    0,        // total beats counted
        lastBeatInt:  0,        // integer beat count last frame (for edge detect)
        confidence:   0,        // 0..1 how confident in BPM estimate
        lastT:        0         // last update timestamp
    };

    function updateBeatDetector(bass, nowSec) {
        var bd = beatDetector;
        var dt = bd.lastT > 0 ? (nowSec - bd.lastT) : (1/60);
        bd.lastT = nowSec;
        if (dt <= 0 || dt > 0.5) dt = 1/60;
        var delta = bass - bd.prevBass;
        bd.prevBass = bass;
        bd.history[bd.histIdx % bd.histLen] = Math.abs(delta);
        bd.histIdx++;
        var avgDelta = 0;
        var hCount = Math.min(bd.histIdx, bd.histLen);
        for (var i = 0; i < hCount; i++) avgDelta += bd.history[i];
        avgDelta = hCount > 0 ? avgDelta / hCount : 0;
        var adaptiveThresh = Math.max(bd.threshold, avgDelta * 1.3);
        var minOnsetGap = 0.18;
        if (delta > adaptiveThresh && bass > 0.08 &&
            (nowSec - bd.lastOnsetT) > minOnsetGap) {
            bd.lastOnsetT = nowSec;
            bd.onsetTimes.push(nowSec);
            if (bd.onsetTimes.length > bd.maxOnsets)
                bd.onsetTimes.shift();
            if (bd.onsetTimes.length >= 3) {
                var intervals = [];
                for (var j = 1; j < bd.onsetTimes.length; j++) {
                    var iv = bd.onsetTimes[j] - bd.onsetTimes[j-1];
                    if (iv > 0.2 && iv < 2.0) intervals.push(iv);
                }
                if (intervals.length >= 2) {
                    intervals.sort(function(a,b) { return a - b; });
                    var medianIv = intervals[Math.floor(intervals.length / 2)];
                    var rawBPM = 60 / medianIv;
                    var snapped = rawBPM;
                    var common = [80,85,90,95,100,105,110,115,120,125,128,130,135,140,145,150,155,160,170,180];
                    for (var c = 0; c < common.length; c++) {
                        if (Math.abs(rawBPM - common[c]) / common[c] < 0.05) {
                            snapped = common[c]; break;
                        }
                    }
                    bd.bpm = bd.bpm * 0.7 + snapped * 0.3;
                    bd.confidence = Math.min(1, intervals.length / 8);
                }
            }
        }
        var beatsPerSec = bd.bpm / 60;
        bd.beatPhase += beatsPerSec * dt;
        var newBeatInt = Math.floor(bd.beatPhase);
        if (newBeatInt !== bd.lastBeatInt) {
            bd.beatCount += (newBeatInt - bd.lastBeatInt);
        }
        bd.lastBeatInt = newBeatInt;
        if (bd.beatPhase > 1000) bd.beatPhase -= 1000;
    }

    // ---------------------------------------------------------
    //  Dance Move Library — keyframe-based poses
    //  Keyframe joints are OFFSETS from rest skeleton position
    // ---------------------------------------------------------
    var DANCE_MOVES = {
        idle_sway: {
            name: 'Idle Sway', beatsPerCycle: 2, interp: 'smooth',
            keyframes: [
                { beat: 0.0, joints: {
                    hip: {dx: -0.04, dy: 0}, hipL: {dx: -0.04, dy: 0}, hipR: {dx: -0.04, dy: 0},
                    shoulderL: {dx: 0.02, dy: 0}, shoulderR: {dx: 0.02, dy: 0},
                    kneeL: {dx: -0.02, dy: 0}, kneeR: {dx: -0.02, dy: 0},
                    footL: {dx: -0.01, dy: 0}, footR: {dx: -0.01, dy: 0},
                    elbowL: {dx: 0.02, dy: 0.01}, elbowR: {dx: 0.03, dy: -0.01},
                    handL: {dx: 0.03, dy: 0.02}, handR: {dx: 0.04, dy: -0.02}
                }},
                { beat: 1.0, joints: {
                    hip: {dx: 0.04, dy: 0}, hipL: {dx: 0.04, dy: 0}, hipR: {dx: 0.04, dy: 0},
                    shoulderL: {dx: -0.02, dy: 0}, shoulderR: {dx: -0.02, dy: 0},
                    kneeL: {dx: 0.02, dy: 0}, kneeR: {dx: 0.02, dy: 0},
                    footL: {dx: 0.01, dy: 0}, footR: {dx: 0.01, dy: 0},
                    elbowL: {dx: -0.03, dy: -0.01}, elbowR: {dx: -0.02, dy: 0.01},
                    handL: {dx: -0.04, dy: -0.02}, handR: {dx: -0.03, dy: 0.02}
                }}
            ]
        },
        two_step: {
            name: 'Two-Step', beatsPerCycle: 2, interp: 'smooth',
            keyframes: [
                { beat: 0.0, joints: {
                    hip: {dx: -0.03, dy: -0.02}, hipL: {dx: -0.03, dy: -0.02}, hipR: {dx: -0.03, dy: -0.02},
                    kneeL: {dx: -0.05, dy: -0.04}, kneeR: {dx: 0, dy: 0.01},
                    footL: {dx: -0.08, dy: -0.02}, footR: {dx: 0.02, dy: 0},
                    shoulderL: {dx: -0.01, dy: -0.01}, shoulderR: {dx: 0.01, dy: -0.01},
                    elbowL: {dx: -0.03, dy: -0.02}, elbowR: {dx: 0.02, dy: 0.02},
                    handL: {dx: -0.04, dy: -0.04}, handR: {dx: 0.03, dy: 0.03}
                }},
                { beat: 0.5, joints: {
                    hip: {dx: 0, dy: -0.04}, hipL: {dx: 0, dy: -0.04}, hipR: {dx: 0, dy: -0.04},
                    kneeL: {dx: 0, dy: -0.03}, kneeR: {dx: 0, dy: -0.03},
                    footL: {dx: 0.01, dy: -0.01}, footR: {dx: -0.01, dy: -0.01},
                    neck: {dx: 0, dy: -0.02}
                }},
                { beat: 1.0, joints: {
                    hip: {dx: 0.03, dy: -0.02}, hipL: {dx: 0.03, dy: -0.02}, hipR: {dx: 0.03, dy: -0.02},
                    kneeL: {dx: 0, dy: 0.01}, kneeR: {dx: 0.05, dy: -0.04},
                    footL: {dx: -0.02, dy: 0}, footR: {dx: 0.08, dy: -0.02},
                    shoulderL: {dx: 0.01, dy: -0.01}, shoulderR: {dx: -0.01, dy: -0.01},
                    elbowL: {dx: 0.02, dy: 0.02}, elbowR: {dx: -0.03, dy: -0.02},
                    handL: {dx: 0.03, dy: 0.03}, handR: {dx: -0.04, dy: -0.04}
                }},
                { beat: 1.5, joints: {
                    hip: {dx: 0, dy: -0.04}, hipL: {dx: 0, dy: -0.04}, hipR: {dx: 0, dy: -0.04},
                    kneeL: {dx: 0, dy: -0.03}, kneeR: {dx: 0, dy: -0.03},
                    footL: {dx: -0.01, dy: -0.01}, footR: {dx: 0.01, dy: -0.01},
                    neck: {dx: 0, dy: -0.02}
                }}
            ]
        },
        running_man: {
            name: 'Running Man', beatsPerCycle: 2, interp: 'smooth',
            keyframes: [
                { beat: 0.0, joints: {
                    hip: {dx: 0, dy: -0.03}, hipL: {dx: 0.02, dy: -0.03}, hipR: {dx: -0.01, dy: -0.03},
                    kneeL: {dx: 0.04, dy: -0.12}, kneeR: {dx: -0.03, dy: 0.03},
                    footL: {dx: 0.03, dy: -0.10}, footR: {dx: -0.06, dy: 0.04},
                    shoulderL: {dx: 0.02, dy: -0.01}, shoulderR: {dx: -0.02, dy: -0.01},
                    elbowL: {dx: 0.06, dy: -0.05}, elbowR: {dx: -0.04, dy: 0.04},
                    handL: {dx: 0.08, dy: -0.10}, handR: {dx: -0.05, dy: 0.06},
                    neck: {dx: 0, dy: -0.02}
                }},
                { beat: 0.5, joints: {
                    hip: {dx: 0, dy: -0.05}, hipL: {dx: 0, dy: -0.05}, hipR: {dx: 0, dy: -0.05},
                    kneeL: {dx: 0, dy: -0.03}, kneeR: {dx: 0, dy: -0.03},
                    footL: {dx: 0, dy: 0}, footR: {dx: 0, dy: 0}, neck: {dx: 0, dy: -0.03}
                }},
                { beat: 1.0, joints: {
                    hip: {dx: 0, dy: -0.03}, hipL: {dx: -0.01, dy: -0.03}, hipR: {dx: 0.02, dy: -0.03},
                    kneeL: {dx: -0.03, dy: 0.03}, kneeR: {dx: 0.04, dy: -0.12},
                    footL: {dx: -0.06, dy: 0.04}, footR: {dx: 0.03, dy: -0.10},
                    shoulderL: {dx: -0.02, dy: -0.01}, shoulderR: {dx: 0.02, dy: -0.01},
                    elbowL: {dx: -0.04, dy: 0.04}, elbowR: {dx: 0.06, dy: -0.05},
                    handL: {dx: -0.05, dy: 0.06}, handR: {dx: 0.08, dy: -0.10},
                    neck: {dx: 0, dy: -0.02}
                }},
                { beat: 1.5, joints: {
                    hip: {dx: 0, dy: -0.05}, hipL: {dx: 0, dy: -0.05}, hipR: {dx: 0, dy: -0.05},
                    kneeL: {dx: 0, dy: -0.03}, kneeR: {dx: 0, dy: -0.03},
                    footL: {dx: 0, dy: 0}, footR: {dx: 0, dy: 0}, neck: {dx: 0, dy: -0.03}
                }}
            ]
        },
        cabbage_patch: {
            name: 'Cabbage Patch', beatsPerCycle: 4, interp: 'smooth',
            keyframes: [
                { beat: 0.0, joints: {
                    hip: {dx: 0.04, dy: 0}, hipL: {dx: 0.04, dy: 0}, hipR: {dx: 0.04, dy: 0},
                    elbowL: {dx: 0.06, dy: -0.04}, elbowR: {dx: 0.08, dy: -0.03},
                    handL: {dx: 0.10, dy: -0.08}, handR: {dx: 0.12, dy: -0.06},
                    shoulderL: {dx: 0.02, dy: 0}, shoulderR: {dx: 0.02, dy: 0},
                    kneeL: {dx: 0.02, dy: -0.01}, kneeR: {dx: 0.02, dy: 0}
                }},
                { beat: 1.0, joints: {
                    hip: {dx: 0, dy: -0.03}, hipL: {dx: 0, dy: -0.03}, hipR: {dx: 0, dy: -0.03},
                    elbowL: {dx: 0.03, dy: -0.09}, elbowR: {dx: -0.03, dy: -0.09},
                    handL: {dx: 0.05, dy: -0.15}, handR: {dx: -0.05, dy: -0.15},
                    shoulderL: {dx: 0, dy: -0.02}, shoulderR: {dx: 0, dy: -0.02},
                    kneeL: {dx: 0, dy: -0.02}, kneeR: {dx: 0, dy: -0.02}, neck: {dx: 0, dy: -0.01}
                }},
                { beat: 2.0, joints: {
                    hip: {dx: -0.04, dy: 0}, hipL: {dx: -0.04, dy: 0}, hipR: {dx: -0.04, dy: 0},
                    elbowL: {dx: -0.08, dy: -0.03}, elbowR: {dx: -0.06, dy: -0.04},
                    handL: {dx: -0.12, dy: -0.06}, handR: {dx: -0.10, dy: -0.08},
                    shoulderL: {dx: -0.02, dy: 0}, shoulderR: {dx: -0.02, dy: 0},
                    kneeL: {dx: -0.02, dy: 0}, kneeR: {dx: -0.02, dy: -0.01}
                }},
                { beat: 3.0, joints: {
                    hip: {dx: 0, dy: 0.01}, hipL: {dx: 0, dy: 0.01}, hipR: {dx: 0, dy: 0.01},
                    elbowL: {dx: -0.03, dy: 0.03}, elbowR: {dx: 0.03, dy: 0.03},
                    handL: {dx: -0.04, dy: 0.05}, handR: {dx: 0.04, dy: 0.05},
                    shoulderL: {dx: 0, dy: 0.01}, shoulderR: {dx: 0, dy: 0.01},
                    kneeL: {dx: 0, dy: 0.01}, kneeR: {dx: 0, dy: 0.01}
                }}
            ]
        },
        robot: {
            name: 'Robot', beatsPerCycle: 4, interp: 'stepped',
            keyframes: [
                { beat: 0.0, joints: {
                    hip: {dx: 0, dy: 0}, elbowL: {dx: 0, dy: 0}, elbowR: {dx: 0, dy: 0},
                    handL: {dx: 0, dy: 0}, handR: {dx: 0, dy: 0}
                }},
                { beat: 1.0, joints: {
                    elbowR: {dx: 0.06, dy: -0.12}, handR: {dx: 0.12, dy: -0.12},
                    elbowL: {dx: -0.02, dy: 0.02}, handL: {dx: -0.02, dy: 0.04},
                    neck: {dx: 0.02, dy: 0}, hip: {dx: -0.02, dy: 0}
                }},
                { beat: 2.0, joints: {
                    elbowR: {dx: 0.08, dy: -0.06}, handR: {dx: 0.14, dy: -0.02},
                    elbowL: {dx: -0.08, dy: -0.06}, handL: {dx: -0.14, dy: -0.02},
                    hip: {dx: 0, dy: -0.02}, hipL: {dx: 0, dy: -0.02}, hipR: {dx: 0, dy: -0.02},
                    neck: {dx: -0.02, dy: -0.01}
                }},
                { beat: 3.0, joints: {
                    elbowL: {dx: -0.06, dy: -0.12}, handL: {dx: -0.12, dy: -0.12},
                    elbowR: {dx: 0.02, dy: 0.02}, handR: {dx: 0.02, dy: 0.04},
                    neck: {dx: -0.02, dy: 0}, hip: {dx: 0.02, dy: 0}
                }}
            ]
        },
        raise_the_roof: {
            name: 'Raise the Roof', beatsPerCycle: 2, interp: 'smooth',
            keyframes: [
                { beat: 0.0, joints: {
                    elbowL: {dx: -0.06, dy: -0.14}, elbowR: {dx: 0.06, dy: -0.14},
                    handL: {dx: -0.08, dy: -0.22}, handR: {dx: 0.08, dy: -0.22},
                    shoulderL: {dx: -0.01, dy: -0.02}, shoulderR: {dx: 0.01, dy: -0.02},
                    hip: {dx: 0, dy: 0.02}, hipL: {dx: 0, dy: 0.02}, hipR: {dx: 0, dy: 0.02},
                    kneeL: {dx: 0, dy: 0.03}, kneeR: {dx: 0, dy: 0.03}, neck: {dx: 0, dy: 0.01}
                }},
                { beat: 0.5, joints: {
                    elbowL: {dx: -0.07, dy: -0.18}, elbowR: {dx: 0.07, dy: -0.18},
                    handL: {dx: -0.09, dy: -0.28}, handR: {dx: 0.09, dy: -0.28},
                    shoulderL: {dx: -0.02, dy: -0.04}, shoulderR: {dx: 0.02, dy: -0.04},
                    hip: {dx: 0, dy: -0.04}, hipL: {dx: 0, dy: -0.04}, hipR: {dx: 0, dy: -0.04},
                    kneeL: {dx: 0, dy: -0.02}, kneeR: {dx: 0, dy: -0.02}, neck: {dx: 0, dy: -0.03}
                }},
                { beat: 1.0, joints: {
                    elbowL: {dx: -0.06, dy: -0.14}, elbowR: {dx: 0.06, dy: -0.14},
                    handL: {dx: -0.08, dy: -0.22}, handR: {dx: 0.08, dy: -0.22},
                    shoulderL: {dx: -0.01, dy: -0.02}, shoulderR: {dx: 0.01, dy: -0.02},
                    hip: {dx: 0, dy: 0.02}, hipL: {dx: 0, dy: 0.02}, hipR: {dx: 0, dy: 0.02},
                    kneeL: {dx: 0, dy: 0.03}, kneeR: {dx: 0, dy: 0.03}, neck: {dx: 0, dy: 0.01}
                }},
                { beat: 1.5, joints: {
                    elbowL: {dx: -0.07, dy: -0.18}, elbowR: {dx: 0.07, dy: -0.18},
                    handL: {dx: -0.09, dy: -0.28}, handR: {dx: 0.09, dy: -0.28},
                    shoulderL: {dx: -0.02, dy: -0.04}, shoulderR: {dx: 0.02, dy: -0.04},
                    hip: {dx: 0, dy: -0.04}, hipL: {dx: 0, dy: -0.04}, hipR: {dx: 0, dy: -0.04},
                    kneeL: {dx: 0, dy: -0.02}, kneeR: {dx: 0, dy: -0.02}, neck: {dx: 0, dy: -0.03}
                }}
            ]
        },
        shuffle: {
            name: 'Shuffle', beatsPerCycle: 2, interp: 'smooth',
            keyframes: [
                { beat: 0.0, joints: {
                    hip: {dx: -0.05, dy: 0.02}, hipL: {dx: -0.05, dy: 0.02}, hipR: {dx: -0.05, dy: 0.02},
                    kneeL: {dx: -0.07, dy: 0.01}, kneeR: {dx: -0.03, dy: 0.02},
                    footL: {dx: -0.10, dy: 0}, footR: {dx: -0.02, dy: 0.01},
                    shoulderL: {dx: -0.02, dy: 0}, shoulderR: {dx: -0.02, dy: 0},
                    elbowL: {dx: -0.04, dy: 0.02}, elbowR: {dx: 0, dy: 0.02},
                    handL: {dx: -0.05, dy: 0.03}, handR: {dx: 0.01, dy: 0.03}, neck: {dx: -0.01, dy: 0.01}
                }},
                { beat: 0.5, joints: {
                    hip: {dx: 0, dy: -0.03}, hipL: {dx: 0, dy: -0.03}, hipR: {dx: 0, dy: -0.03},
                    kneeL: {dx: 0, dy: -0.01}, kneeR: {dx: 0, dy: -0.01},
                    footL: {dx: 0, dy: 0}, footR: {dx: 0, dy: 0}, neck: {dx: 0, dy: -0.02}
                }},
                { beat: 1.0, joints: {
                    hip: {dx: 0.05, dy: 0.02}, hipL: {dx: 0.05, dy: 0.02}, hipR: {dx: 0.05, dy: 0.02},
                    kneeL: {dx: 0.03, dy: 0.02}, kneeR: {dx: 0.07, dy: 0.01},
                    footL: {dx: 0.02, dy: 0.01}, footR: {dx: 0.10, dy: 0},
                    shoulderL: {dx: 0.02, dy: 0}, shoulderR: {dx: 0.02, dy: 0},
                    elbowL: {dx: 0, dy: 0.02}, elbowR: {dx: 0.04, dy: 0.02},
                    handL: {dx: -0.01, dy: 0.03}, handR: {dx: 0.05, dy: 0.03}, neck: {dx: 0.01, dy: 0.01}
                }},
                { beat: 1.5, joints: {
                    hip: {dx: 0, dy: -0.03}, hipL: {dx: 0, dy: -0.03}, hipR: {dx: 0, dy: -0.03},
                    kneeL: {dx: 0, dy: -0.01}, kneeR: {dx: 0, dy: -0.01},
                    footL: {dx: 0, dy: 0}, footR: {dx: 0, dy: 0}, neck: {dx: 0, dy: -0.02}
                }}
            ]
        },
        disco_point: {
            name: 'Disco Point', beatsPerCycle: 4, interp: 'smooth',
            keyframes: [
                { beat: 0.0, joints: {
                    elbowR: {dx: -0.04, dy: -0.14}, handR: {dx: -0.08, dy: -0.24},
                    elbowL: {dx: -0.02, dy: 0.03}, handL: {dx: -0.01, dy: 0.05},
                    hip: {dx: 0.03, dy: -0.02}, hipL: {dx: 0.03, dy: -0.02}, hipR: {dx: 0.03, dy: -0.02},
                    kneeL: {dx: 0.02, dy: -0.01}, kneeR: {dx: 0.02, dy: 0}, neck: {dx: -0.01, dy: -0.01}
                }},
                { beat: 1.0, joints: {
                    elbowL: {dx: 0.04, dy: -0.14}, handL: {dx: 0.08, dy: -0.24},
                    elbowR: {dx: 0.02, dy: 0.03}, handR: {dx: 0.01, dy: 0.05},
                    hip: {dx: -0.03, dy: -0.02}, hipL: {dx: -0.03, dy: -0.02}, hipR: {dx: -0.03, dy: -0.02},
                    kneeL: {dx: -0.02, dy: 0}, kneeR: {dx: -0.02, dy: -0.01}, neck: {dx: 0.01, dy: -0.01}
                }},
                { beat: 2.0, joints: {
                    elbowR: {dx: 0.08, dy: 0.02}, handR: {dx: 0.14, dy: 0.06},
                    elbowL: {dx: -0.02, dy: 0.01}, handL: {dx: -0.02, dy: 0.02},
                    hip: {dx: -0.02, dy: 0}, hipL: {dx: -0.02, dy: 0}, hipR: {dx: -0.02, dy: 0},
                    kneeL: {dx: -0.01, dy: 0.01}, kneeR: {dx: 0.01, dy: 0}, neck: {dx: 0.02, dy: 0}
                }},
                { beat: 3.0, joints: {
                    elbowL: {dx: -0.06, dy: -0.12}, handL: {dx: -0.10, dy: -0.20},
                    elbowR: {dx: 0.06, dy: -0.12}, handR: {dx: 0.10, dy: -0.20},
                    hip: {dx: 0, dy: -0.03}, hipL: {dx: 0, dy: -0.03}, hipR: {dx: 0, dy: -0.03},
                    kneeL: {dx: 0, dy: -0.02}, kneeR: {dx: 0, dy: -0.02}, neck: {dx: 0, dy: -0.02}
                }}
            ]
        }
    };

    // ---------------------------------------------------------
    //  Pose Evaluator — interpolate between keyframes
    // ---------------------------------------------------------
    function evaluatePose(move, phase) {
        var kf = move.keyframes;
        var n = kf.length;
        if (n === 0) return {};
        var cyc = move.beatsPerCycle;
        phase = ((phase % cyc) + cyc) % cyc;
        var idxA = 0, idxB = 0;
        for (var i = 0; i < n; i++) {
            if (kf[i].beat <= phase) idxA = i;
        }
        idxB = (idxA + 1) % n;
        var beatA = kf[idxA].beat;
        var beatB = kf[idxB].beat;
        if (idxB <= idxA) beatB += cyc;
        var span = beatB - beatA;
        if (span <= 0) span = 1;
        var localPhase = phase - beatA;
        if (localPhase < 0) localPhase += cyc;
        var t;
        if (move.interp === 'stepped') {
            t = 0;
        } else {
            var raw = localPhase / span;
            raw = Math.max(0, Math.min(1, raw));
            t = 0.5 - 0.5 * Math.cos(raw * Math.PI);
        }
        var jointsA = kf[idxA].joints;
        var jointsB = kf[idxB].joints;
        var result = {};
        var allJoints = {};
        var jn;
        for (jn in jointsA) allJoints[jn] = true;
        for (jn in jointsB) allJoints[jn] = true;
        for (jn in allJoints) {
            var a = jointsA[jn] || { dx: 0, dy: 0 };
            var b = jointsB[jn] || { dx: 0, dy: 0 };
            result[jn] = {
                dx: a.dx + (b.dx - a.dx) * t,
                dy: a.dy + (b.dy - a.dy) * t
            };
        }
        return result;
    }

    // ---------------------------------------------------------
    //  Dance Sequencer — manages move rotation & transitions
    // ---------------------------------------------------------
    var danceState = {
        currentMove:    'idle_sway',
        nextMove:       null,
        movePhase:      0,
        beatsInMove:    0,
        beatsUntilSwitch: 16,
        crossfade:      0,
        crossfadeDur:   1.0,
        crossfading:    false,
        lastLrcIdx:     -1,
        lastSpitIdx:    -1,
        movePool:       null
    };

    function updateDanceSequencer(bass, amp) {
        var ds = danceState;
        var bd = beatDetector;
        var shouldSwitch = false;
        var lyricChanged = false;
        if (typeof lyricMode !== 'undefined') {
            if (lyricMode === LYRIC_MODE_SPITTING) {
                if (spitLineIdx !== ds.lastSpitIdx && spitLineIdx >= 0) {
                    lyricChanged = true;
                    ds.lastSpitIdx = spitLineIdx;
                }
            } else {
                if (lrcIndex !== ds.lastLrcIdx && lrcIndex >= 0) {
                    lyricChanged = true;
                    ds.lastLrcIdx = lrcIndex;
                }
            }
        }
        ds.beatsInMove = bd.beatCount - (ds._beatStart || 0);
        if (ds.beatsInMove >= ds.beatsUntilSwitch) {
            shouldSwitch = true;
        } else if (lyricChanged && ds.beatsInMove >= 4) {
            shouldSwitch = true;
        }
        if (shouldSwitch && !ds.crossfading && ds.movePool && ds.movePool.length > 1) {
            var candidates = [];
            for (var i = 0; i < ds.movePool.length; i++) {
                if (ds.movePool[i] !== ds.currentMove) candidates.push(ds.movePool[i]);
            }
            ds.nextMove = candidates[Math.floor(Math.random() * candidates.length)];
            ds.crossfading = true;
            ds.crossfade = 0;
            ds.beatsUntilSwitch = 8 + Math.floor(Math.random() * 9);
            var nextMoveObj = DANCE_MOVES[ds.nextMove];
            var currMoveObj = DANCE_MOVES[ds.currentMove];
            if ((nextMoveObj && nextMoveObj.interp === 'stepped') ||
                (currMoveObj && currMoveObj.interp === 'stepped')) {
                ds.crossfadeDur = 0.08;
            } else {
                ds.crossfadeDur = 1.0;
            }
        }
        if (ds.crossfading) {
            var beatsPerSec = bd.bpm / 60;
            var fadeRate = beatsPerSec > 0 ? (1 / (ds.crossfadeDur * beatsPerSec)) : 0.02;
            ds.crossfade += fadeRate;
            if (ds.crossfade >= 1) {
                ds.crossfade = 0;
                ds.crossfading = false;
                ds.currentMove = ds.nextMove;
                ds.nextMove = null;
                ds._beatStart = bd.beatCount;
            }
        }
        var beatsPerSec2 = bd.bpm / 60;
        ds.movePhase += beatsPerSec2 * (1/60);
    }

    // ---------------------------------------------------------
    //  drawBody — Vectrex wireframe with dance moves
    // ---------------------------------------------------------
    var bodyBeamPhase = 0;

    function drawBody(char, projState, amp, bass) {
        var body = char.body;
        if (!body || !body.skeleton || !body.bones) return;

        var t = performance.now() * 0.001;
        bodyBeamPhase += body.scanSpeed || 0.003;

        // --- Update beat detector ---
        updateBeatDetector(bass, t);

        // --- Set up move pool from character config ---
        var ds = danceState;
        var charMoves = body.moves || ['idle_sway'];
        if (ds.movePool !== charMoves) {
            ds.movePool = charMoves;
            var inPool = false;
            for (var mi = 0; mi < charMoves.length; mi++) {
                if (charMoves[mi] === ds.currentMove) { inPool = true; break; }
            }
            if (!inPool) {
                ds.currentMove = charMoves[0];
                ds._beatStart = beatDetector.beatCount;
            }
        }

        // --- Update dance sequencer ---
        updateDanceSequencer(bass, amp);

        // --- Evaluate current pose ---
        var currentMoveObj = DANCE_MOVES[ds.currentMove];
        if (!currentMoveObj) currentMoveObj = DANCE_MOVES.idle_sway;
        var pose = evaluatePose(currentMoveObj, ds.movePhase);

        // If crossfading, blend with next move's pose
        if (ds.crossfading && ds.nextMove) {
            var nextMoveObj = DANCE_MOVES[ds.nextMove];
            if (nextMoveObj) {
                var poseB = evaluatePose(nextMoveObj, ds.movePhase);
                var cf = ds.crossfade;
                var allJ = {};
                var jj;
                for (jj in pose) allJ[jj] = true;
                for (jj in poseB) allJ[jj] = true;
                var blended = {};
                for (jj in allJ) {
                    var pa = pose[jj] || { dx: 0, dy: 0 };
                    var pb = poseB[jj] || { dx: 0, dy: 0 };
                    blended[jj] = {
                        dx: pa.dx + (pb.dx - pa.dx) * cf,
                        dy: pa.dy + (pb.dy - pa.dy) * cf
                    };
                }
                pose = blended;
            }
        }

        // --- Audio intensity scaling ---
        var energy = Math.max(0.3, Math.min(1.2, 0.5 + amp * 0.5 + bass * 0.5));

        var skel = body.skeleton;
        var color = body.color || char.wireColor || '#33FF33';
        var rgb   = body.rgb   || char.wireRGB   || '51,255,51';
        var baseLineW = body.lineWidth || 1.8;
        var glowW     = body.glowWidth || 6;

        // Body origin: directly below the chin
        var chinY = -0.80;
        var neckScreen = projectHeadPoint(projState, 0, chinY, 0, projState.pulse || 1);
        var bodyOriginX = neckScreen.x;
        var bodyOriginY = neckScreen.y;
        var bodyScale = projState.scale * (projState.pulse || 1) * 0.52;

        // --- Apply pose offsets to skeleton ---
        var joints = {};
        for (var name in skel) {
            var j = skel[name];
            var x = j.x;
            var y = j.y;
            var off = pose[name];
            if (off) {
                x += off.dx * energy;
                y += off.dy * energy;
            }
            var zWobble = Math.sin(t * 1.5 + y * 4.0) * 0.06;
            var screenX = bodyOriginX + x * bodyScale;
            var screenY = bodyOriginY + y * bodyScale;
            screenX += zWobble * bodyScale * 0.4;
            joints[name] = { x: screenX, y: screenY, localY: j.y };
        }

        // --- Clothing zone map ---
        // Maps each bone index to a clothing zone for per-segment coloring.
        // Bones: 0-1 neck-shoulders, 2 chest, 3-4 upper arms, 5-6 forearms,
        //        7 torso center, 8-9 waist, 10-11 thighs, 12-13 shins/feet
        var BONE_ZONES = ['upper','upper','upper','upper','upper','skin','skin',
                          'torso','lower','lower','lower','lower','feet','feet'];
        // Joint-to-zone map for vertex flares
        var JOINT_ZONES = {
            neck: 'upper', shoulderL: 'upper', shoulderR: 'upper',
            elbowL: 'upper', elbowR: 'upper',
            handL: 'skin', handR: 'skin',
            hip: 'lower', hipL: 'lower', hipR: 'lower',
            kneeL: 'lower', kneeR: 'lower',
            footL: 'feet', footR: 'feet'
        };

        var clothing = body.clothing || null;

        // Resolve zone color: returns {c: hexColor, r: rgbString}
        function zoneColor(zoneName) {
            if (clothing && clothing[zoneName]) {
                return { c: clothing[zoneName].color, r: clothing[zoneName].rgb };
            }
            // 'torso' falls back to 'upper' if not defined
            if (zoneName === 'torso' && clothing && clothing.upper) {
                return { c: clothing.upper.color, r: clothing.upper.rgb };
            }
            return { c: color, r: rgb };
        }

        // --- Vectrex phosphor beam rendering ---
        var bones = body.bones;
        var totalBones = bones.length;
        wireCtx.lineCap = 'round';
        wireCtx.lineJoin = 'round';

        for (var b = 0; b < totalBones; b++) {
            var j0 = joints[bones[b][0]];
            var j1 = joints[bones[b][1]];
            if (!j0 || !j1) continue;

            // Per-bone clothing zone color
            var zone = BONE_ZONES[b] || 'upper';
            var zc = zoneColor(zone);
            var boneColor = zc.c;
            var boneRgb   = zc.r;

            var bonePhase = (bodyBeamPhase + b / totalBones) % 1.0;
            var timeSinceScan = bonePhase;
            var brightness = Math.max(0.15, 1.0 - timeSinceScan * 0.85);
            var glowBrightness = Math.max(0, 1.0 - timeSinceScan * 1.5);
            brightness = Math.min(1, brightness + bass * 0.15);
            glowBrightness = Math.min(1, glowBrightness + bass * 0.2);

            if (glowBrightness > 0.05) {
                wireCtx.strokeStyle = 'rgba(' + boneRgb + ',' + (glowBrightness * 0.25).toFixed(3) + ')';
                wireCtx.lineWidth = glowW + bass * 3;
                wireCtx.shadowBlur = 12 + bass * 8;
                wireCtx.shadowColor = boneColor;
                wireCtx.beginPath();
                wireCtx.moveTo(j0.x, j0.y);
                wireCtx.lineTo(j1.x, j1.y);
                wireCtx.stroke();
            }
            wireCtx.strokeStyle = 'rgba(' + boneRgb + ',' + brightness.toFixed(3) + ')';
            wireCtx.lineWidth = baseLineW;
            wireCtx.shadowBlur = 4 + glowBrightness * 6;
            wireCtx.shadowColor = boneColor;
            wireCtx.beginPath();
            wireCtx.moveTo(j0.x, j0.y);
            wireCtx.lineTo(j1.x, j1.y);
            wireCtx.stroke();
        }

        // Joint vertex flares (colored by zone)
        for (var name in joints) {
            var jt = joints[name];
            var jZone = JOINT_ZONES[name] || 'upper';
            var jzc = zoneColor(jZone);
            var jBright = 0.3 + bass * 0.2;
            wireCtx.fillStyle = 'rgba(' + jzc.r + ',' + jBright.toFixed(3) + ')';
            wireCtx.shadowBlur = 6;
            wireCtx.shadowColor = jzc.c;
            wireCtx.beginPath();
            wireCtx.arc(jt.x, jt.y, 1.5 + bass * 1.0, 0, Math.PI * 2);
            wireCtx.fill();
        }
        wireCtx.shadowBlur = 0;
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

    function copyTrackTags(tags) {
        var copy = {};
        var key;
        if (!tags || typeof tags !== 'object') return copy;
        for (key in tags) {
            if (!Object.prototype.hasOwnProperty.call(tags, key)) continue;
            copy[key] = tags[key];
        }
        return copy;
    }

    function mergeTrackTags(base, override) {
        var merged = copyTrackTags(base);
        var key;
        if (!override || typeof override !== 'object') return merged;
        for (key in override) {
            if (!Object.prototype.hasOwnProperty.call(override, key)) continue;
            if (override[key] === undefined || override[key] === null || override[key] === '') continue;
            merged[key] = override[key];
        }
        return merged;
    }

    function getRadioTrackTags(filename) {
        var radio = window.sbbsRadio;
        if (!radio) return {};
        if (filename && typeof radio.getTrackTagsByFile === 'function') {
            return copyTrackTags(radio.getTrackTagsByFile(filename) || {});
        }
        return copyTrackTags(radio.currentTrackTags || {});
    }

    function hasUsefulTrackMetadata(tags) {
        return !!(
            tags &&
            (tags.title || tags.artist || tags.composer || tags.album || tags.genre || tags.year || tags.picture)
        );
    }

    function applyFetchedMetadata(tags) {
        var merged = mergeTrackTags(tags, getRadioTrackTags(trackFile));

        trackMeta = merged;
        setActiveCharacter(getCharacterForArtist(merged.artist));
        console.log('[viz] metadata ready:', merged.artist || '(none)',
                    '| genre:', merged.genre || '(none)',
                    '| SYLT lines:', merged.sylt && merged.sylt.length ? merged.sylt.length : 0,
                    '| art:', merged.picture ? 'yes' : 'no');

        fetchLyrics()
            .then(function (loadedExternalLyrics) {
                if (!loadedExternalLyrics && merged.sylt && merged.sylt.length > 0) {
                    lrcLines = merged.sylt;
                    lrcIndex = -1;
                    console.log('[viz] using SYLT lyrics (' + lrcLines.length + ' lines)');
                }
                if (hasUsefulTrackMetadata(merged) && isOpen) {
                    updateMetaHud(merged);
                }
            });
    }

    function fetchMetadata() {
        var radioTags;
        var url;

        if (!trackFile) {
            var r = window.sbbsRadio;
            if (r && r.currentTrackFile) trackFile = r.currentTrackFile;
        }
        radioTags = getRadioTrackTags(trackFile);

        if (hasUsefulTrackMetadata(radioTags) || (radioTags.sylt && radioTags.sylt.length)) {
            applyFetchedMetadata(radioTags);
            return;
        }
        if (!trackFile || typeof window.parseID3v2 !== 'function') {
            // No parser available or no track — fall back to LRC
            fetchLyrics();
            return;
        }

        url = './radio-stream/' + encodeURIComponent(trackFile);
        console.log('[viz] fetching ID3 metadata from', trackFile);

        // Range request: only need the first chunk for ID3 header
        fetch(url, { headers: { 'Range': 'bytes=0-' + (META_FETCH_BYTES - 1) } })
            .then(function (r) {
                if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
                return r.arrayBuffer();
            })
            .then(function (buf) {
                applyFetchedMetadata(window.parseID3v2(buf) || {});
            })
            .catch(function (err) {
                console.warn('[viz] ID3 fetch failed:', err);
                if (hasUsefulTrackMetadata(radioTags) || (radioTags.sylt && radioTags.sylt.length)) {
                    applyFetchedMetadata(radioTags);
                    return;
                }
                trackMeta = null;
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
        if (!trackFile) return Promise.resolve(false);

        var lrcName = trackFile.replace(/\.mp3$/i, '.lrc');
        return fetch('./radio-stream/' + encodeURIComponent(lrcName))
            .then(function (r) { if (!r.ok) throw 0; return r.text(); })
            .then(function (txt) {
                lrcLines = parseLRC(txt);
                lrcIndex = -1;
                if (lrcLines.length) {
                    console.log('[viz] loaded ' + lrcLines.length + ' lyric lines');
                }
                return lrcLines.length > 0;
            })
            .catch(function () {
                lrcLines = [];
                lrcIndex = -1;
                return false;
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
        if (!result.length) {
            var plainLines = text.split('\n').map(function (line) {
                return String(line || '').replace(/\r/g, '').trim();
            }).filter(function (line) {
                return line.length && !/^\[[a-z]+:.*\]$/i.test(line);
            });
            result = plainLines.map(function (line, index) {
                return { time: index * 4, text: line };
            });
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
        var mouthPoint = eyeScreenPoints.mouth || (activeChar.mouth ? projectHeadPoint(projState, 0, activeChar.mouth.y, activeChar.mouth.z, projState.pulse || 1) : { x: w / 2, y: h / 2, d: 1 });
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
