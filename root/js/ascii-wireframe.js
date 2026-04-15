/**
 * ascii-strobe.js — Beat-triggered ASCII 3D effect overlay for the Vectrex visualizer
 *
 * Reads the wireframe canvas, downsamples to a character grid, maps luminance
 * to an ASCII ramp, and renders with pseudo-3D depth displacement.
 * Strobe envelope (attack → hold → decay) is triggered by the beat detector.
 *
 * Usage:
 *   window.asciiStrobe.init(wireframeCanvas, containerElement);
 *   // then each frame:
 *   window.asciiStrobe.tick(bass, amp, beatDetector);
 *
 * Keyboard:  A = toggle on/off,  Shift+A = cycle strobe profile
 */
(function () {
    'use strict';

    // ── ASCII luminance ramp (dark → bright) ──────────────────────────
    var RAMP = ' .\u00b7:;!=+*#%@\u2588';   // 13 chars  ( · and █ )
    var RAMP_LEN = RAMP.length;

    // ── Grid cell size (pixels per character) ─────────────────────────
    var CELL_W = 6;
    var CELL_H = 10;

    // ── Strobe profiles ───────────────────────────────────────────────
    var PROFILES = {
        flash:   { attack: 30,  hold: 60,  decay: 220, glitch: false, glitchProb: 0 },
        pulse:   { attack: 80,  hold: 100, decay: 450, glitch: false, glitchProb: 0 },
        sustain: { attack: 50,  hold: 350, decay: 600, glitch: false, glitchProb: 0 },
        glitch:  { attack: 20,  hold: 40,  decay: 180, glitch: true,  glitchProb: 0.35 }
    };
    var PROFILE_NAMES = Object.keys(PROFILES);

    // ── State ─────────────────────────────────────────────────────────
    var enabled = false;
    var profileIdx = 0;
    var profile = PROFILES[PROFILE_NAMES[0]];

    var wireCanvasRef = null;
    var asciiCanvas   = null;
    var asciiCtx      = null;
    var offscreen     = null;
    var offCtx        = null;

    // Strobe envelope
    var strobePhase   = 'idle';   // idle | attack | hold | decay
    var phaseStart    = 0;
    var mixValue      = 0;        // 0 = wireframe only, 1 = full ASCII

    // Beat edge detection
    var lastBeatCount = 0;

    // ── Helpers ───────────────────────────────────────────────────────
    function now() { return performance.now(); }

    function easeOut(t) { return 1 - (1 - t) * (1 - t); }

    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

    // ── Core ──────────────────────────────────────────────────────────

    function init(wireCanvas, container) {
        wireCanvasRef = wireCanvas;

        // Tear down previous if reinitialised (e.g. canvas resize)
        if (asciiCanvas && asciiCanvas.parentNode) {
            asciiCanvas.parentNode.removeChild(asciiCanvas);
        }

        asciiCanvas = document.createElement('canvas');
        asciiCanvas.id = 'viz-ascii';
        asciiCanvas.style.cssText =
            'position:absolute;top:0;left:0;width:100%;height:100%;' +
            'pointer-events:none;opacity:0;z-index:2;image-rendering:pixelated;';

        // Insert between wireframe (z-index 1) and karaoke (z-index 3)
        if (container) container.appendChild(asciiCanvas);

        resize(wireCanvas.width, wireCanvas.height);

        // Offscreen for downsampling
        offscreen = document.createElement('canvas');
        offCtx = offscreen.getContext('2d');
    }

    function destroy() {
        if (asciiCanvas && asciiCanvas.parentNode) {
            asciiCanvas.parentNode.removeChild(asciiCanvas);
        }
        asciiCanvas = null;
        asciiCtx = null;
        offscreen = null;
        offCtx = null;
        wireCanvasRef = null;
    }

    function resize(w, h) {
        if (!asciiCanvas) return;
        asciiCanvas.width = w;
        asciiCanvas.height = h;
        asciiCtx = asciiCanvas.getContext('2d');
    }

    // ── Strobe envelope ───────────────────────────────────────────────

    function triggerStrobe() {
        strobePhase = 'attack';
        phaseStart = now();
    }

    function updateEnvelope() {
        var t = now();
        var elapsed = t - phaseStart;

        switch (strobePhase) {
            case 'attack':
                mixValue = clamp01(elapsed / profile.attack);
                if (elapsed >= profile.attack) {
                    strobePhase = 'hold';
                    phaseStart = t;
                    mixValue = 1;
                }
                break;
            case 'hold':
                mixValue = 1;
                if (elapsed >= profile.hold) {
                    strobePhase = 'decay';
                    phaseStart = t;
                }
                break;
            case 'decay':
                mixValue = 1 - easeOut(clamp01(elapsed / profile.decay));
                if (elapsed >= profile.decay) {
                    strobePhase = 'idle';
                    mixValue = 0;
                }
                break;
            default:
                mixValue = 0;
        }

        // Glitch profile: random flicker
        if (profile.glitch && strobePhase !== 'idle') {
            if (Math.random() < profile.glitchProb) {
                mixValue = mixValue * (0.3 + Math.random() * 0.7);
            }
        }
    }

    // ── ASCII render ──────────────────────────────────────────────────

    function renderAscii(bass, amp) {
        if (!wireCanvasRef || !asciiCanvas || !asciiCtx) return;

        var W = asciiCanvas.width;
        var H = asciiCanvas.height;

        // Downsample wireframe to grid-sized offscreen
        var cols = Math.floor(W / CELL_W);
        var rows = Math.floor(H / CELL_H);
        if (cols < 2 || rows < 2) return;

        offscreen.width = cols;
        offscreen.height = rows;
        offCtx.drawImage(wireCanvasRef, 0, 0, cols, rows);

        var imgData;
        try {
            imgData = offCtx.getImageData(0, 0, cols, rows);
        } catch (e) {
            return;  // tainted canvas safety
        }
        var px = imgData.data;

        // Clear ASCII canvas
        asciiCtx.clearRect(0, 0, W, H);

        // Font setup
        var fontSize = CELL_H;
        asciiCtx.font = fontSize + 'px monospace';
        asciiCtx.textBaseline = 'top';

        // Bass-reactive colour boost
        var bassBoost = clamp01(bass * 1.8);
        var hueShift = Math.floor(bassBoost * 30);  // slight hue shift on bass

        // Jitter on high bass
        var jitterAmt = bass > 0.7 ? (bass - 0.7) * 8 : 0;

        for (var row = 0; row < rows; row++) {
            for (var col = 0; col < cols; col++) {
                var i = (row * cols + col) * 4;
                var r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];

                // Luminance
                var lum = (0.299 * r + 0.587 * g + 0.114 * b) * (a / 255);
                if (lum < 8) continue;  // skip near-black

                // Map to ASCII ramp
                var charIdx = Math.min(Math.floor((lum / 255) * RAMP_LEN), RAMP_LEN - 1);
                var ch = RAMP[charIdx];

                // Pseudo-3D depth: brighter pixels move "forward" (slight Y offset)
                var depthOffset = -(lum / 255) * 3;

                // Phosphor green with bass hue shift
                var cr = Math.min(255, r + hueShift);
                var cg = Math.min(255, g + Math.floor(bassBoost * 40));
                var cb = Math.min(255, b + hueShift);

                // Colour string
                var colStr = 'rgba(' + cr + ',' + cg + ',' + cb + ',' + (a / 255 * mixValue).toFixed(2) + ')';
                asciiCtx.fillStyle = colStr;

                var dx = col * CELL_W + (jitterAmt ? (Math.random() - 0.5) * jitterAmt : 0);
                var dy = row * CELL_H + depthOffset + (jitterAmt ? (Math.random() - 0.5) * jitterAmt : 0);

                asciiCtx.fillText(ch, dx, dy);
            }
        }

        // Phosphor glow: redraw at low opacity with slight blur
        asciiCtx.save();
        asciiCtx.globalAlpha = 0.15 * mixValue;
        asciiCtx.filter = 'blur(2px)';
        asciiCtx.drawImage(asciiCanvas, 0, 0);
        asciiCtx.restore();
    }

    // ── Per-frame tick ────────────────────────────────────────────────

    function tick(bass, amp, beatDetector) {
        if (!enabled || !asciiCanvas) return;

        // Detect beat edge
        if (beatDetector && beatDetector.beatCount !== lastBeatCount) {
            lastBeatCount = beatDetector.beatCount;
            triggerStrobe();
        }

        updateEnvelope();

        if (mixValue > 0.01) {
            asciiCanvas.style.opacity = mixValue;
            // Dim wireframe proportionally
            if (wireCanvasRef) {
                wireCanvasRef.style.opacity = 1 - mixValue * 0.7;
            }
            renderAscii(bass, amp);
        } else {
            asciiCanvas.style.opacity = 0;
            if (wireCanvasRef) wireCanvasRef.style.opacity = 1;
        }
    }

    // ── Public API ────────────────────────────────────────────────────

    function toggle() {
        enabled = !enabled;
        if (!enabled && asciiCanvas) {
            asciiCanvas.style.opacity = 0;
            if (wireCanvasRef) wireCanvasRef.style.opacity = 1;
            mixValue = 0;
            strobePhase = 'idle';
        }
        console.log('[ascii-strobe] ' + (enabled ? 'ON' : 'OFF') + ' (' + PROFILE_NAMES[profileIdx] + ')');
        return enabled;
    }

    function setProfile(name) {
        var idx = PROFILE_NAMES.indexOf(name);
        if (idx >= 0) {
            profileIdx = idx;
            profile = PROFILES[PROFILE_NAMES[idx]];
        }
    }

    function cycleProfile() {
        profileIdx = (profileIdx + 1) % PROFILE_NAMES.length;
        profile = PROFILES[PROFILE_NAMES[profileIdx]];
        console.log('[ascii-strobe] profile:', PROFILE_NAMES[profileIdx]);
        return PROFILE_NAMES[profileIdx];
    }

    function getProfile() {
        return PROFILE_NAMES[profileIdx];
    }

    function isEnabled() {
        return enabled;
    }

    function getMix() {
        return mixValue;
    }

    // ── Export ─────────────────────────────────────────────────────────
    window.asciiStrobe = {
        init: init,
        destroy: destroy,
        tick: tick,
        toggle: toggle,
        resize: resize,
        isEnabled: isEnabled,
        setProfile: setProfile,
        cycleProfile: cycleProfile,
        getProfile: getProfile,
        getMix: getMix,
        triggerStrobe: triggerStrobe
    };

})();
