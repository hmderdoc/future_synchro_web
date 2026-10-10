# Web terminal memory harness

Plain Node scripts (not Playwright specs). Run from /sbbs/webv4_custom with
PLAYWRIGHT_BROWSERS_PATH pointing at the chromium cache, e.g.

    PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright PW_USER='<alias>' PW_PASS='<pw>' \
        node playwright/memory/measure_live.js          # full SPA + terminal, 4 phases
    ... node playwright/memory/measure_iframe_only.js   # terminal iframe alone, rlogin, with allocation profile
    ... node playwright/memory/measure_spa_only.js      # SPA with the terminal never opened
    node playwright/memory/ws_ansi_server.js &          # synthetic truecolor stream on :18777
    ... node playwright/memory/measure_terminal.js      # iframe alone against the synthetic stream

Each sample forces a GC first, then reports JS heap, DOM node count, listener
count, renderer/GPU process RSS and fTelnet internals (receive buffer, glyph
cache sizes, bell queue, accessibility divs under the canvas).
PW_BASE defaults to http://127.0.0.1:4080; PHASE_MS / TOTAL_MS set phase length.

NEW_BUNDLE=/path/to/ftelnet.norip.noxfer.min.js serves that bundle to the test browser in place of the live one (measure_terminal.js), so a fork build can be verified before deploy.sh.
measure_idle_shell.js walks the logon screens and idles 15 min; its shell detection trips on the last-callers screen, so drive the node to the shell by hand if needed.
