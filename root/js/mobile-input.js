/**
 * mobile-input.js — Mobile keyboard & gamepad overlay for fTelnet iframe
 *
 * Three input modes, cycled via a floating mode button:
 *   1. Keyboard  — native soft keyboard via hidden textarea + extra-keys bar
 *   2. D-Pad     — touch directional pad + action buttons (configurable mapping)
 *   3. Dismissed — overlays hidden, swipe/tap only
 *
 * Loaded inside terminal-iframe.html. Communicates with fTelnet via
 * dispatchEvent(KeyboardEvent) on the window.
 *
 * Key mappings for D-Pad modes are plain objects — swap them to retarget
 * the same physical layout to different keys (arrow vs numpad vs WASD, etc).
 */
(function () {
    'use strict';

    // =========================================================
    //  Detect mobile/touch — bail out on desktop
    // =========================================================
    // iPadOS 13+ reports a Mac desktop UA (no "iPad" in the string),
    // and the iframe's innerWidth doesn't reflect device width.
    // Use maxTouchPoints as the primary reliable signal.
    var hasTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    var isMobileUA = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(navigator.userAgent);
    // Also detect iPadOS masquerading as Mac desktop
    var isIPad = /Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
    var isMobile = isMobileUA || isIPad || hasTouch;
    if (!isMobile) return;

    // =========================================================
    //  Key dispatch helper
    // =========================================================
    function sendKey(key, code, keyCode, opts) {
        var o = opts || {};
        var init = {
            key: key,
            code: code || key,
            keyCode: keyCode || 0,
            which: keyCode || 0,
            bubbles: true,
            cancelable: true,
            ctrlKey: !!o.ctrl,
            altKey: !!o.alt,
            shiftKey: !!o.shift,
            metaKey: false
        };
        window.dispatchEvent(new KeyboardEvent('keydown', init));
        // Fire keypress for printable chars AND control characters
        // (Enter=13, Backspace=8, Tab=9). fTelnet's CRT relies on
        // keypress + charCode to transmit bytes to the server —
        // without it, Enter/BS/Tab are seen in keydown but never
        // sent as actual characters over the connection.
        if (key.length === 1) {
            init.charCode = key.charCodeAt(0);
            window.dispatchEvent(new KeyboardEvent('keypress', init));
        } else if (keyCode === 13 || keyCode === 8 || keyCode === 9) {
            init.charCode = keyCode;
            window.dispatchEvent(new KeyboardEvent('keypress', init));
        }
        window.dispatchEvent(new KeyboardEvent('keyup', init));
    }

    function sendString(str) {
        for (var i = 0; i < str.length; i++) {
            var ch = str[i];
            sendKey(ch, '', ch.charCodeAt(0));
        }
    }

    // =========================================================
    //  Mapping definitions
    // =========================================================
    // Each mapping has a name, description, and key configs for
    // each D-Pad direction + action buttons.
    // Directions: up, upRight, right, downRight, down, downLeft, left, upLeft, center
    // Actions: a, b, c, start

    var MAPPINGS = {
        'arrows-4way': {
            name: 'Arrow Keys',
            desc: '4-way arrows + Enter/Esc',
            directions: {
                up:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
                right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
                down:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
                left:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 }
            },
            actions: {
                a: { label: 'Enter', key: 'Enter', code: 'Enter', keyCode: 13 },
                b: { label: 'Esc',   key: 'Escape', code: 'Escape', keyCode: 27 },
                c: { label: 'Space', key: ' ', code: 'Space', keyCode: 32 }
            }
        },
        'numpad-8way': {
            name: 'Numpad 8-way',
            desc: '8-way numpad for door games',
            directions: {
                up:        { key: '8', code: 'Numpad8', keyCode: 56 },
                upRight:   { key: '9', code: 'Numpad9', keyCode: 57 },
                right:     { key: '6', code: 'Numpad6', keyCode: 54 },
                downRight: { key: '3', code: 'Numpad3', keyCode: 51 },
                down:      { key: '2', code: 'Numpad2', keyCode: 50 },
                downLeft:  { key: '1', code: 'Numpad1', keyCode: 49 },
                left:      { key: '4', code: 'Numpad4', keyCode: 52 },
                upLeft:    { key: '7', code: 'Numpad7', keyCode: 55 },
                center:    { key: '5', code: 'Numpad5', keyCode: 53 }
            },
            actions: {
                a: { label: 'Fire',  key: 'Enter', code: 'Enter', keyCode: 13 },
                b: { label: 'Esc',   key: 'Escape', code: 'Escape', keyCode: 27 },
                c: { label: 'Space', key: ' ', code: 'Space', keyCode: 32 }
            }
        },
        'wasd': {
            name: 'WASD',
            desc: 'WASD movement + common actions',
            directions: {
                up:    { key: 'w', code: 'KeyW', keyCode: 87 },
                right: { key: 'd', code: 'KeyD', keyCode: 68 },
                down:  { key: 's', code: 'KeyS', keyCode: 83 },
                left:  { key: 'a', code: 'KeyA', keyCode: 65 }
            },
            actions: {
                a: { label: 'Enter', key: 'Enter', code: 'Enter', keyCode: 13 },
                b: { label: 'Esc',   key: 'Escape', code: 'Escape', keyCode: 27 },
                c: { label: 'Y',     key: 'y', code: 'KeyY', keyCode: 89 }
            }
        },
        'tradewars': {
            name: 'TradeWars',
            desc: 'TradeWars 2002 navigation',
            directions: {
                up:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
                right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
                down:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
                left:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 }
            },
            actions: {
                a: { label: 'Enter', key: 'Enter', code: 'Enter', keyCode: 13 },
                b: { label: 'Q',     key: 'q', code: 'KeyQ', keyCode: 81 },
                c: { label: 'T',     key: 't', code: 'KeyT', keyCode: 84 }
            }
        }
    };

    // =========================================================
    //  State
    // =========================================================
    var MODE_KEYBOARD = 0, MODE_DPAD = 1, MODE_OFF = 2;
    var currentMode = MODE_OFF;
    var currentMapping = 'arrows-4way';
    var stickyCtrl = false, stickyAlt = false;
    var keyboardHeight = 0;

    // =========================================================
    //  Styles (injected once)
    // =========================================================
    var style = document.createElement('style');
    style.textContent = [
        /* Mode toggle FAB */
        '#mi-fab {',
        '  position:fixed; bottom:12px; right:12px; z-index:10000;',
        '  width:44px; height:44px; border-radius:50%;',
        '  background:rgba(0,255,255,0.15); border:2px solid rgba(0,255,255,0.5);',
        '  color:#0ff; font-size:20px; line-height:40px; text-align:center;',
        '  cursor:pointer; touch-action:manipulation;',
        '  box-shadow:0 0 8px rgba(0,255,255,0.3);',
        '  -webkit-tap-highlight-color:transparent;',
        '}',
        '#mi-fab:active { background:rgba(0,255,255,0.3); }',

        /* Hidden textarea for native keyboard.
           Must be IN the viewport for iOS to open the soft keyboard.
           opacity:0.01 (not 0) — iOS ignores truly invisible elements.
           caret-color:transparent hides the blinking cursor. */
        '#mi-input {',
        '  position:fixed; left:0; bottom:0; width:1px; height:1px;',
        '  opacity:0.01; font-size:16px; /* >=16px prevents iOS zoom */',
        '  caret-color:transparent; color:transparent;',
        '  border:none; outline:none; background:transparent;',
        '  z-index:1; pointer-events:none;',
        '}',

        /* Extra-keys bar */
        '#mi-extrakeys {',
        '  position:fixed; left:0; right:0; z-index:9999;',
        '  display:none; flex-wrap:nowrap; overflow-x:auto;',
        '  background:rgba(10,10,12,0.95); border-top:1px solid rgba(0,255,255,0.2);',
        '  padding:4px 2px; gap:3px;',
        '  -webkit-overflow-scrolling:touch;',
        '}',
        '#mi-extrakeys.show { display:flex; }',
        '.mi-xkey {',
        '  flex:0 0 auto; min-width:36px; height:34px;',
        '  background:rgba(0,255,255,0.08); border:1px solid rgba(0,255,255,0.25);',
        '  border-radius:5px; color:#0ff; font-size:11px; font-family:monospace;',
        '  text-align:center; line-height:34px; padding:0 6px;',
        '  cursor:pointer; touch-action:manipulation;',
        '  -webkit-tap-highlight-color:transparent; user-select:none;',
        '}',
        '.mi-xkey:active, .mi-xkey.active { background:rgba(0,255,255,0.3); }',
        '.mi-xkey.sticky { background:rgba(255,170,0,0.3); border-color:rgba(255,170,0,0.6); color:#fa0; }',

        /* D-Pad overlay */
        '#mi-dpad-overlay {',
        '  position:fixed; left:0; right:0; bottom:0; z-index:9998;',
        '  display:none; height:220px;',
        '  background:rgba(5,5,8,0.92); border-top:1px solid rgba(0,255,255,0.15);',
        '}',
        '#mi-dpad-overlay.show { display:flex; align-items:center; justify-content:space-between; padding:0 16px; }',

        /* D-Pad container */
        '.mi-dpad {',
        '  position:relative; width:150px; height:150px; flex-shrink:0;',
        '}',
        '.mi-dpad-zone {',
        '  position:absolute; display:flex; align-items:center; justify-content:center;',
        '  color:rgba(0,255,255,0.5); font-size:20px; border-radius:8px;',
        '  touch-action:manipulation; user-select:none;',
        '  -webkit-tap-highlight-color:transparent;',
        '}',
        '.mi-dpad-zone:active { background:rgba(0,255,255,0.15); color:#0ff; }',
        /* 3x3 grid zones */
        '.mi-dz-ul { left:0;   top:0;    width:50px; height:50px; }',
        '.mi-dz-u  { left:50px; top:0;    width:50px; height:50px; }',
        '.mi-dz-ur { left:100px;top:0;    width:50px; height:50px; }',
        '.mi-dz-l  { left:0;   top:50px;  width:50px; height:50px; }',
        '.mi-dz-c  { left:50px; top:50px;  width:50px; height:50px; border:1px solid rgba(0,255,255,0.15); }',
        '.mi-dz-r  { left:100px;top:50px;  width:50px; height:50px; }',
        '.mi-dz-dl { left:0;   top:100px; width:50px; height:50px; }',
        '.mi-dz-d  { left:50px; top:100px; width:50px; height:50px; }',
        '.mi-dz-dr { left:100px;top:100px; width:50px; height:50px; }',

        /* Action buttons */
        '.mi-actions { display:flex; flex-direction:column; gap:10px; flex-shrink:0; }',
        '.mi-action-btn {',
        '  width:56px; height:56px; border-radius:50%;',
        '  background:rgba(0,255,255,0.1); border:2px solid rgba(0,255,255,0.4);',
        '  color:#0ff; font-size:13px; font-weight:bold; font-family:monospace;',
        '  text-align:center; line-height:52px;',
        '  touch-action:manipulation; user-select:none;',
        '  -webkit-tap-highlight-color:transparent;',
        '}',
        '.mi-action-btn:active { background:rgba(0,255,255,0.3); }',

        /* Mapping picker bar */
        '#mi-mapping-bar {',
        '  position:fixed; left:0; right:0; z-index:9999;',
        '  display:none; overflow-x:auto; gap:3px; padding:4px 2px;',
        '  background:rgba(10,10,12,0.95); border-top:1px solid rgba(255,170,0,0.3);',
        '  -webkit-overflow-scrolling:touch;',
        '}',
        '#mi-mapping-bar.show { display:flex; }',
        '.mi-map-btn {',
        '  flex:0 0 auto; height:30px; padding:0 10px;',
        '  background:rgba(255,170,0,0.1); border:1px solid rgba(255,170,0,0.3);',
        '  border-radius:4px; color:#fa0; font-size:11px; font-family:monospace;',
        '  line-height:30px; white-space:nowrap;',
        '  touch-action:manipulation; user-select:none;',
        '  -webkit-tap-highlight-color:transparent;',
        '}',
        '.mi-map-btn.active { background:rgba(255,170,0,0.3); border-color:#fa0; }',
        '.mi-map-btn:active { background:rgba(255,170,0,0.25); }'
    ].join('\n');
    document.head.appendChild(style);

    // =========================================================
    //  DOM construction
    // =========================================================

    // 1. Mode FAB
    var fab = document.createElement('div');
    fab.id = 'mi-fab';
    fab.textContent = '⌨';
    fab.title = 'Toggle Input Mode';
    document.body.appendChild(fab);

    // 2. Hidden textarea
    var input = document.createElement('textarea');
    input.id = 'mi-input';
    input.autocomplete = 'off';
    input.autocapitalize = 'none';
    input.autocorrect = 'off';
    input.spellcheck = false;
    input.setAttribute('inputmode', 'text');
    document.body.appendChild(input);

    // 3. Extra-keys bar
    var extraBar = document.createElement('div');
    extraBar.id = 'mi-extrakeys';

    var EXTRA_KEYS = [
        { label: 'Esc',  key: 'Escape',     code: 'Escape',     keyCode: 27 },
        { label: 'Tab',  key: 'Tab',        code: 'Tab',        keyCode: 9 },
        { label: 'Ctrl', sticky: 'ctrl' },
        { label: 'Alt',  sticky: 'alt' },
        { label: '↑',    key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
        { label: '↓',    key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 },
        { label: '←',    key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
        { label: '→',    key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
        { label: 'PgUp', key: 'PageUp',     code: 'PageUp',     keyCode: 33 },
        { label: 'PgDn', key: 'PageDown',   code: 'PageDown',   keyCode: 34 },
        { label: 'Home', key: 'Home',       code: 'Home',       keyCode: 36 },
        { label: 'End',  key: 'End',        code: 'End',        keyCode: 35 },
        { label: 'Del',  key: 'Delete',     code: 'Delete',     keyCode: 46 },
        { label: 'Ins',  key: 'Insert',     code: 'Insert',     keyCode: 45 },
        { label: 'F1',   key: 'F1',  code: 'F1',  keyCode: 112 },
        { label: 'F2',   key: 'F2',  code: 'F2',  keyCode: 113 },
        { label: 'F3',   key: 'F3',  code: 'F3',  keyCode: 114 },
        { label: 'F4',   key: 'F4',  code: 'F4',  keyCode: 115 },
        { label: 'F5',   key: 'F5',  code: 'F5',  keyCode: 116 },
        { label: 'F6',   key: 'F6',  code: 'F6',  keyCode: 117 },
        { label: 'F7',   key: 'F7',  code: 'F7',  keyCode: 118 },
        { label: 'F8',   key: 'F8',  code: 'F8',  keyCode: 119 },
        { label: 'F9',   key: 'F9',  code: 'F9',  keyCode: 120 },
        { label: 'F10',  key: 'F10', code: 'F10', keyCode: 121 }
    ];

    EXTRA_KEYS.forEach(function (def) {
        var btn = document.createElement('div');
        btn.className = 'mi-xkey';
        btn.textContent = def.label;
        btn.setAttribute('data-mi-key', JSON.stringify(def));
        extraBar.appendChild(btn);
    });
    document.body.appendChild(extraBar);

    // 4. D-Pad overlay
    var dpadOverlay = document.createElement('div');
    dpadOverlay.id = 'mi-dpad-overlay';

    // D-Pad 3x3 grid
    var dpad = document.createElement('div');
    dpad.className = 'mi-dpad';
    var DIR_ZONES = [
        { cls: 'mi-dz-ul', dir: 'upLeft',    sym: '↖' },
        { cls: 'mi-dz-u',  dir: 'up',        sym: '▲' },
        { cls: 'mi-dz-ur', dir: 'upRight',   sym: '↗' },
        { cls: 'mi-dz-l',  dir: 'left',      sym: '◄' },
        { cls: 'mi-dz-c',  dir: 'center',    sym: '●' },
        { cls: 'mi-dz-r',  dir: 'right',     sym: '►' },
        { cls: 'mi-dz-dl', dir: 'downLeft',  sym: '↙' },
        { cls: 'mi-dz-d',  dir: 'down',      sym: '▼' },
        { cls: 'mi-dz-dr', dir: 'downRight', sym: '↘' }
    ];
    DIR_ZONES.forEach(function (z) {
        var zone = document.createElement('div');
        zone.className = 'mi-dpad-zone ' + z.cls;
        zone.textContent = z.sym;
        zone.setAttribute('data-mi-dir', z.dir);
        dpad.appendChild(zone);
    });
    dpadOverlay.appendChild(dpad);

    // Action buttons
    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'mi-actions';
    actionsDiv.id = 'mi-actions';
    dpadOverlay.appendChild(actionsDiv);

    document.body.appendChild(dpadOverlay);

    // 5. Mapping picker bar (above d-pad)
    var mappingBar = document.createElement('div');
    mappingBar.id = 'mi-mapping-bar';
    document.body.appendChild(mappingBar);

    // =========================================================
    //  Mapping management
    // =========================================================
    function getMapping() {
        return MAPPINGS[currentMapping] || MAPPINGS['arrows-4way'];
    }

    function is8Way() {
        var m = getMapping();
        return !!(m.directions.upLeft || m.directions.upRight ||
                  m.directions.downLeft || m.directions.downRight);
    }

    function rebuildActions() {
        var m = getMapping();
        actionsDiv.innerHTML = '';
        ['a', 'b', 'c'].forEach(function (id) {
            var act = m.actions[id];
            if (!act) return;
            var btn = document.createElement('div');
            btn.className = 'mi-action-btn';
            btn.textContent = act.label;
            btn.setAttribute('data-mi-action', id);
            actionsDiv.appendChild(btn);
        });
    }

    function rebuildMappingBar() {
        mappingBar.innerHTML = '';
        Object.keys(MAPPINGS).forEach(function (id) {
            var m = MAPPINGS[id];
            var btn = document.createElement('div');
            btn.className = 'mi-map-btn' + (id === currentMapping ? ' active' : '');
            btn.textContent = m.name;
            btn.setAttribute('data-mi-mapping', id);
            mappingBar.appendChild(btn);
        });
    }

    function selectMapping(id) {
        if (!MAPPINGS[id]) return;
        currentMapping = id;
        try { localStorage.setItem('mi-mapping', id); } catch (_) {}
        rebuildActions();
        rebuildMappingBar();
        updateDpadVisibility();
    }

    function updateDpadVisibility() {
        var eightWay = is8Way();
        var zones = dpad.querySelectorAll('.mi-dpad-zone');
        zones.forEach(function (z) {
            var dir = z.getAttribute('data-mi-dir');
            var isDiag = dir === 'upLeft' || dir === 'upRight' ||
                         dir === 'downLeft' || dir === 'downRight';
            var isCenter = dir === 'center';
            if (isDiag) z.style.display = eightWay ? '' : 'none';
            if (isCenter) z.style.display = eightWay ? '' : 'none';
        });
    }

    // Load saved mapping
    try {
        var saved = localStorage.getItem('mi-mapping');
        if (saved && MAPPINGS[saved]) currentMapping = saved;
    } catch (_) {}

    // Load saved mode (default OFF)
    var savedMode = MODE_OFF;
    try {
        var sm = localStorage.getItem('mi-mode');
        if (sm !== null) {
            sm = parseInt(sm, 10);
            // Only restore D-Pad mode (not keyboard, since it needs gesture)
            if (sm === MODE_DPAD) savedMode = MODE_DPAD;
        }
    } catch (_) {}

    rebuildActions();
    rebuildMappingBar();
    updateDpadVisibility();

    // =========================================================
    //  Public API for custom mappings
    // =========================================================
    window.mobileInputMappings = MAPPINGS;
    window.mobileInputSelectMapping = selectMapping;

    // =========================================================
    //  Keyboard height detection via VisualViewport
    // =========================================================
    function updateKeyboardHeight() {
        if (!window.visualViewport) return;
        var kbH = window.innerHeight - window.visualViewport.height;
        if (kbH > 50) {
            keyboardHeight = kbH;
        } else if (kbH < 20) {
            keyboardHeight = 0;
        }
        positionExtras();
    }

    function positionExtras() {
        if (currentMode === MODE_KEYBOARD) {
            // Extra-keys bar sits right above the keyboard
            extraBar.style.bottom = keyboardHeight + 'px';
        } else if (currentMode === MODE_DPAD) {
            mappingBar.style.bottom = (220) + 'px'; // above d-pad overlay
            dpadOverlay.style.bottom = '0';
        }
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', updateKeyboardHeight);
    }

    // =========================================================
    //  Hidden textarea → fTelnet keystroke relay
    // =========================================================
    var composing = false;

    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () {
        composing = false;
        flushInput();
    });

    input.addEventListener('input', function () {
        if (composing) return;
        flushInput();
    });

    function flushInput() {
        var val = input.value;
        if (!val) return;
        input.value = '';
        sendString(val);
        consumeSticky();
    }

    // Intercept special keys on the textarea
    input.addEventListener('keydown', function (e) {
        // Let composition go through
        if (composing) return;

        var handled = false;
        var opts = { ctrl: stickyCtrl, alt: stickyAlt, shift: e.shiftKey };

        // Backspace
        if (e.key === 'Backspace') {
            sendKey('Backspace', 'Backspace', 8, opts);
            handled = true;
        }
        // Enter
        else if (e.key === 'Enter') {
            sendKey('Enter', 'Enter', 13, opts);
            handled = true;
        }
        // Tab
        else if (e.key === 'Tab') {
            sendKey('Tab', 'Tab', 9, opts);
            handled = true;
        }

        if (handled) {
            e.preventDefault();
            e.stopPropagation();
            consumeSticky();
        }
    });

    function consumeSticky() {
        if (stickyCtrl) { stickyCtrl = false; updateStickyUI(); }
        if (stickyAlt) { stickyAlt = false; updateStickyUI(); }
    }

    function updateStickyUI() {
        var keys = extraBar.querySelectorAll('.mi-xkey');
        keys.forEach(function (btn) {
            var def;
            try { def = JSON.parse(btn.getAttribute('data-mi-key')); } catch (_) { return; }
            if (def.sticky === 'ctrl') {
                btn.classList.toggle('sticky', stickyCtrl);
            } else if (def.sticky === 'alt') {
                btn.classList.toggle('sticky', stickyAlt);
            }
        });
    }

    // =========================================================
    //  Extra-keys bar click handler
    // =========================================================
    extraBar.addEventListener('touchstart', function (e) {
        var btn = e.target.closest('.mi-xkey');
        if (!btn) return;
        e.preventDefault();
        var def;
        try { def = JSON.parse(btn.getAttribute('data-mi-key')); } catch (_) { return; }

        if (def.sticky === 'ctrl') {
            stickyCtrl = !stickyCtrl;
            updateStickyUI();
            return;
        }
        if (def.sticky === 'alt') {
            stickyAlt = !stickyAlt;
            updateStickyUI();
            return;
        }

        btn.classList.add('active');
        setTimeout(function () { btn.classList.remove('active'); }, 120);
        sendKey(def.key, def.code, def.keyCode, { ctrl: stickyCtrl, alt: stickyAlt });
        consumeSticky();

        // Haptic feedback
        if (navigator.vibrate) navigator.vibrate(15);
    }, { passive: false });

    // =========================================================
    //  D-Pad touch handlers — hold-to-repeat for directions
    // =========================================================
    var repeatTimer = null, repeatInterval = null;
    var REPEAT_DELAY = 350, REPEAT_RATE = 100;  // ms

    function stopRepeat() {
        clearTimeout(repeatTimer);
        clearInterval(repeatInterval);
        repeatTimer = null;
        repeatInterval = null;
        // Clear all highlights
        var zones = dpad.querySelectorAll('.mi-dpad-zone');
        zones.forEach(function (z) { z.style.background = ''; });
    }

    function fireDirection(def, zone) {
        sendKey(def.key, def.code, def.keyCode);
        if (zone) {
            zone.style.background = 'rgba(0,255,255,0.2)';
            setTimeout(function () { zone.style.background = ''; }, 60);
        }
    }

    dpadOverlay.addEventListener('touchstart', function (e) {
        var zone = e.target.closest('.mi-dpad-zone');
        var action = e.target.closest('.mi-action-btn');

        if (zone) {
            e.preventDefault();
            stopRepeat();
            var dir = zone.getAttribute('data-mi-dir');
            var m = getMapping();
            var def = m.directions[dir];
            if (def) {
                fireDirection(def, zone);
                if (navigator.vibrate) navigator.vibrate(10);
                // Start hold-to-repeat after delay
                repeatTimer = setTimeout(function () {
                    repeatInterval = setInterval(function () {
                        fireDirection(def, zone);
                    }, REPEAT_RATE);
                }, REPEAT_DELAY);
            }
        }

        if (action) {
            e.preventDefault();
            var actId = action.getAttribute('data-mi-action');
            var m2 = getMapping();
            var actDef = m2.actions[actId];
            if (actDef) {
                sendKey(actDef.key, actDef.code, actDef.keyCode);
                action.style.background = 'rgba(0,255,255,0.25)';
                setTimeout(function () { action.style.background = ''; }, 100);
                if (navigator.vibrate) navigator.vibrate(15);
            }
        }
    }, { passive: false });

    dpadOverlay.addEventListener('touchend', function () { stopRepeat(); });
    dpadOverlay.addEventListener('touchcancel', function () { stopRepeat(); });

    // Mapping bar click
    mappingBar.addEventListener('touchstart', function (e) {
        var btn = e.target.closest('.mi-map-btn');
        if (!btn) return;
        e.preventDefault();
        var id = btn.getAttribute('data-mi-mapping');
        selectMapping(id);
        if (navigator.vibrate) navigator.vibrate(10);
    }, { passive: false });

    // =========================================================
    //  Mode switching
    // =========================================================
    function setMode(mode) {
        currentMode = mode;
        try { localStorage.setItem('mi-mode', mode); } catch (_) {}

        // Hide all overlays first
        extraBar.classList.remove('show');
        dpadOverlay.classList.remove('show');
        mappingBar.classList.remove('show');
        input.blur();

        if (mode === MODE_KEYBOARD) {
            fab.textContent = '🎮';
            fab.title = 'Switch to D-Pad';
            extraBar.classList.add('show');
            // Focus the hidden input to raise the native keyboard.
            // MUST be synchronous — iOS kills the user-gesture privilege
            // if focus() is inside setTimeout/Promise/rAF.
            input.focus({ preventScroll: true });
        } else if (mode === MODE_DPAD) {
            fab.textContent = '✕';
            fab.title = 'Dismiss Controls';
            dpadOverlay.classList.add('show');
            mappingBar.classList.add('show');
        } else {
            fab.textContent = '⌨';
            fab.title = 'Open Keyboard';
        }

        positionExtras();

        // Tell the iframe container we changed size
        setTimeout(function () {
            window.dispatchEvent(new Event('resize'));
        }, 350);
    }

    // Cycle: OFF → Keyboard → D-Pad → OFF
    // Use 'click' (not touchstart) as the primary trigger — iOS Safari
    // only grants "user activation" for keyboard focus on click/touchend.
    // touchstart with preventDefault() kills the activation.
    var fabTouched = false;
    fab.addEventListener('touchstart', function (e) {
        e.stopPropagation();
        fabTouched = true;
        // Visual feedback immediately, but do NOT preventDefault —
        // that would suppress the subsequent click event on iOS.
        if (navigator.vibrate) navigator.vibrate(15);
    }, { passive: true });

    fab.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        setMode((currentMode + 1) % 3);
        fabTouched = false;
    });

    // =========================================================
    //  Handle keyboard dismiss (user swipes keyboard down)
    // =========================================================
    input.addEventListener('blur', function () {
        if (currentMode === MODE_KEYBOARD) {
            // Keyboard was dismissed — go to OFF
            setTimeout(function () {
                if (document.activeElement !== input && currentMode === MODE_KEYBOARD) {
                    setMode(MODE_OFF);
                }
            }, 200);
        }
    });

    // =========================================================
    //  Listen for parent commands
    // =========================================================
    window.addEventListener('message', function (e) {
        if (e.origin !== location.origin) return;
        var msg = e.data;
        if (!msg) return;

        if (msg.cmd === 'mobileInput') {
            if (msg.action === 'showKeyboard') setMode(MODE_KEYBOARD);
            else if (msg.action === 'showDpad') setMode(MODE_DPAD);
            else if (msg.action === 'dismiss') setMode(MODE_OFF);
            else if (msg.action === 'setMapping') selectMapping(msg.mapping);
        }
    });

    // Restore saved mode (deferred so DOM is ready)
    if (savedMode !== MODE_OFF) {
        setTimeout(function () { setMode(savedMode); }, 500);
    }

    console.log('[mobile-input] loaded — tap ⌨ to begin');
})();
