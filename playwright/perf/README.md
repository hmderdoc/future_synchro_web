# Visualizer per-layer profiler

Opens the radio visualizer headless, feeds a deterministic synthetic analyser
signal, pins the lyric clock to song seconds 20-25, and measures rAF frame rate
and main-thread ms per tick under kill-switch scenarios (shadowBlur neutralised,
ASCII strobe off, player-bar EQ loop off, fillText stubbed, Butterchurn render
stubbed, lyric mode).

    cd /sbbs/webv4_custom
    PW_PASS=... SYNTH=1 REPEAT=3 PW_BROWSER=firefox  node playwright/perf/viz_profile.js
    SYNTH=1 REPEAT=3 CHROME_SW=1 PW_BROWSER=chromium node playwright/perf/viz_profile.js

Env: ONLY=scenario,list  SAMPLE_MS  SETTLE_MS  PW_TRACK  PW_USER (defaults to Beta Tester) and PW_PASS (required).
Needs `npx playwright install firefox` once. Headless Firefox has no WebGL2 here,
so Butterchurn's Firefox cost is not measured; the 2D layers are. In Firefox the
tick ms column only attributes cost when something forces a synchronous canvas
flush (the strobe readback does); fps is the ground truth.

Baseline before any fixes: viz_profile_baseline_2026-10-09.txt

## Results 2026-10-09

Firefox headless, synthetic audio, medians of 3:

| scenario         | before fps / tick ms | after fps / tick ms |
|------------------|----------------------|---------------------|
| baseline         | 15 / 50              | 52 / 7.6            |
| lyrics-bouncing  | 13 / 69              | 55 / 7.5            |
| no-strobe        |  6 / 3 (paint-bound) | 63 / 6.5            |

What changed: root/js/glow-layer.js (new: shadowBlur intercepted per context,
one blurred downscale per frame into a CSS-scaled sibling canvas), visualizer.js
(wire + karaoke canvases go through GlowLayer; FIGlet grids cached as sprites;
Butterchurn pixelRatio capped at 1; negative-age explosion guard; moustache
without nose guard), ascii-strobe.js (no per-frame offscreen reallocation).
Bloom buffer sizes were measured: wire 0.25, karaoke 0.125. 0.5 was 6x slower
(Firefox's filtered drawImage cost scales with destination pixels) and 0.125 on
the wire layer over-brightened the head. NOFILTER=1 exercises the fallback
blur path for browsers without CanvasRenderingContext2D.filter.
Not done: stopping the navbar EQ loop while the panel is open (the navbar is
visible above the panel, cost ~1 ms); Butterchurn's own Firefox cost is still
unmeasured headless.
