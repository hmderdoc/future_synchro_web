/**
 * mobile-input.js — Mobile keyboard & gamepad overlay for fTelnet iframe
 *
 * Four input modes:
 *   1. Keyboard  — native soft keyboard via hidden input + extra-keys bar
 *   2. Fn Keys   — extra-keys bar without raising the native keyboard
 *   3. D-Pad     — touch directional pad + action buttons (configurable mapping)
 *   4. Touch Pad — swipe pad beneath the terminal for arrow-key gestures
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
    function keyCodeForPrintable(key) {
        var ch;
        var codePoint;
        if (!key || key.length !== 1) return 0;
        ch = key;
        codePoint = ch.charCodeAt(0);
        if (codePoint >= 97 && codePoint <= 122) return codePoint - 32;
        if (codePoint >= 65 && codePoint <= 90) return codePoint;
        if (codePoint >= 48 && codePoint <= 57) return codePoint;
        if (codePoint === 32) return 32;
        return 0;
    }

    function sendKey(key, code, keyCode, opts) {
        var o = opts || {};
        var isPrintable = key && key.length === 1;
        var dispatchKeyCode = keyCode || 0;
        var init = {
            key: key,
            code: code || key,
            keyCode: 0,
            which: 0,
            bubbles: true,
            cancelable: true,
            ctrlKey: !!o.ctrl,
            altKey: !!o.alt,
            shiftKey: !!o.shift,
            metaKey: false
        };

        // Prevent printable text from colliding with DOM virtual-key codes
        // like F5 (116) when mobile IME text is replayed into the terminal,
        // while still preserving standard keydown codes for letters/digits/space.
        if (!dispatchKeyCode && isPrintable) {
            dispatchKeyCode = keyCodeForPrintable(key);
        }
        if (dispatchKeyCode || !isPrintable || o.ctrl || o.alt) {
            init.keyCode = dispatchKeyCode;
            init.which = dispatchKeyCode;
        }

        window.dispatchEvent(new KeyboardEvent('keydown', init));
        // Fire keypress for printable chars AND control characters
        // (Enter=13, Backspace=8, Tab=9). fTelnet's CRT relies on
        // keypress + charCode to transmit bytes to the server —
        // without it, Enter/BS/Tab are seen in keydown but never
        // sent as actual characters over the connection.
        if (isPrintable && !o.ctrl && !o.alt) {
            init.charCode = key.charCodeAt(0);
            window.dispatchEvent(new KeyboardEvent('keypress', init));
        } else if (dispatchKeyCode === 13 || dispatchKeyCode === 8 || dispatchKeyCode === 9) {
            init.charCode = dispatchKeyCode;
            window.dispatchEvent(new KeyboardEvent('keypress', init));
        }
        window.dispatchEvent(new KeyboardEvent('keyup', init));
    }

    function sendString(str, opts) {
        for (var i = 0; i < str.length; i++) {
            var ch = str[i];
            sendKey(ch, '', 0, opts);
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
    var MODE_KEYBOARD = 0, MODE_DPAD = 1, MODE_OFF = 2, MODE_FN = 3;
    var TOOLBAR_HEIGHT = 46;
    var CONTROL_GAP = 6;
    var TOUCHBOX_MIN_HEIGHT = 86;
    var currentMode = MODE_OFF;
    var currentMapping = 'arrows-4way';
    var stickyCtrl = false, stickyAlt = false;
    var keyboardHeight = 0;

    // =========================================================
    //  Styles (injected once)
    // =========================================================
    var style = document.createElement('style');
    style.textContent = [
        ':root { --mi-toolbar-h:' + TOOLBAR_HEIGHT + 'px; }',
        /* Bottom control dock */
        '#mi-toolbar {',
        '  position:fixed; left:0; right:0; top:0; bottom:auto; z-index:10000;',
        '  height:var(--mi-toolbar-h); box-sizing:border-box;',
        '  display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:8px;',
        '  padding:6px 10px;',
        '  background:rgba(10,10,12,0.95); border-top:1px solid rgba(0,255,255,0.2);',
        '}',
        '.mi-toolbar-btn {',
        '  position:relative;',
        '  min-width:0; height:32px; border-radius:7px;',
        '  background:rgba(0,255,255,0.15); border:2px solid rgba(0,255,255,0.5);',
        '  color:#d6ffff;',
        '  display:flex; align-items:center; justify-content:center;',
        '  padding:0;',
        '  cursor:pointer; touch-action:manipulation;',
        '  box-shadow:0 0 8px rgba(0,255,255,0.3);',
        '  -webkit-tap-highlight-color:transparent;',
        '}',
        '.mi-toolbar-btn:active, .mi-toolbar-btn.active { background:rgba(0,255,255,0.3); }',
        '.mi-toolbar-btn svg {',
        '  width:20px; height:20px; display:block; pointer-events:none;',
        '  stroke:currentColor; fill:none; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round;',
        '}',
        'html, body, #fTelnetContainer, #mi-toolbar, #mi-extrakeys, #mi-fn-panel, #mi-dpad-overlay, #mi-mapping-bar, #mi-touchbox {',
        '  -webkit-user-select:none; user-select:none;',
        '  -webkit-touch-callout:none;',
        '  -webkit-tap-highlight-color:transparent;',
        '}',

        /* Hidden input for native keyboard.
           Must be IN the viewport for iOS to open the soft keyboard.
           opacity:0.01 (not 0) — iOS ignores truly invisible elements.
           caret-color:transparent hides the blinking cursor. */
        '#mi-input {',
        '  position:fixed; left:0; top:0; width:1px; height:1px;',
        '  opacity:0.01; font-size:16px; /* >=16px prevents iOS zoom */',
        '  caret-color:transparent; color:transparent;',
        '  border:none; outline:none; background:transparent;',
        '  z-index:1; pointer-events:none;',
        '}',

        /* Extra-keys bar */
        '#mi-extrakeys {',
        '  position:fixed; left:0; right:0; top:0; bottom:auto; z-index:9999;',
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

        /* Function-key panel */
        '#mi-fn-panel {',
        '  position:fixed; left:0; right:0; top:0; bottom:auto; z-index:9999;',
        '  display:none; box-sizing:border-box; overflow-x:hidden; overflow-y:auto;',
        '  background:rgba(10,10,12,0.96); border-top:1px solid rgba(0,255,255,0.2);',
        '  padding:8px;',
        '  -webkit-overflow-scrolling:touch;',
        '}',
        '#mi-fn-panel.show { display:block; }',
        '.mi-fn-shell {',
        '  display:grid; grid-template-columns:minmax(0, 1.7fr) minmax(118px, 0.95fr);',
        '  gap:10px; align-items:start;',
        '}',
        '.mi-fn-main, .mi-fn-side {',
        '  min-width:0; display:flex; flex-direction:column; gap:8px;',
        '}',
        '.mi-fn-side { justify-content:flex-start; }',
        '.mi-fn-group {',
        '  border:1px solid rgba(0,255,255,0.18); border-radius:8px;',
        '  background:rgba(0,255,255,0.04); padding:8px;',
        '  box-shadow:inset 0 0 0 1px rgba(255,255,255,0.02);',
        '}',
        '.mi-fn-label {',
        '  margin:0 0 6px; color:rgba(195,255,255,0.7);',
        '  font:10px/1.2 monospace; letter-spacing:0.08em; text-transform:uppercase;',
        '}',
        '.mi-fn-grid {',
        '  display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:6px;',
        '}',
        '.mi-fn-grid.nav { grid-template-columns:repeat(2, minmax(0, 1fr)); }',
        '.mi-fn-key {',
        '  min-height:36px; display:flex; align-items:center; justify-content:center;',
        '  background:rgba(0,255,255,0.08); border:1px solid rgba(0,255,255,0.25);',
        '  border-radius:6px; color:#0ff; font:12px/1 monospace; text-align:center;',
        '  padding:0 8px; box-sizing:border-box; touch-action:manipulation;',
        '  -webkit-tap-highlight-color:transparent;',
        '}',
        '.mi-fn-key:active, .mi-fn-key.active { background:rgba(0,255,255,0.3); }',
        '.mi-fn-key.sticky { background:rgba(255,170,0,0.3); border-color:rgba(255,170,0,0.6); color:#fa0; }',
        '.mi-fn-arrow-box {',
        '  flex:0 0 auto; min-height:0; display:flex; flex-direction:column; justify-content:flex-start;',
        '  border:1px solid rgba(0,255,255,0.18); border-radius:8px;',
        '  background:rgba(0,255,255,0.04); padding:8px;',
        '}',
        '.mi-fn-arrows {',
        '  align-self:center; display:grid; grid-template-columns:repeat(3, 40px);',
        '  grid-template-rows:repeat(2, 40px); gap:6px;',
        '}',
        '.mi-fn-arrow-spacer { visibility:hidden; }',
        '.mi-fn-arrow-up { grid-column:2; grid-row:1; }',
        '.mi-fn-arrow-left { grid-column:1; grid-row:2; }',
        '.mi-fn-arrow-down { grid-column:2; grid-row:2; }',
        '.mi-fn-arrow-right { grid-column:3; grid-row:2; }',

        /* D-Pad overlay */
        '#mi-dpad-overlay {',
        '  position:fixed; left:0; right:0; top:0; bottom:auto; z-index:9998;',
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
        '  position:fixed; left:0; right:0; top:0; bottom:auto; z-index:9999;',
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
        '.mi-map-btn:active { background:rgba(255,170,0,0.25); }',

        /* Touch pad */
        '#mi-touchbox {',
        '  position:fixed; left:10px; right:10px; top:0; bottom:auto; z-index:9997;',
        '  display:none; box-sizing:border-box; overflow:hidden;',
        '  border:1px solid rgba(0,255,255,0.28); border-radius:10px;',
        '  background:linear-gradient(180deg, rgba(10,20,24,0.95), rgba(6,10,14,0.92));',
        '  box-shadow:inset 0 0 0 1px rgba(255,255,255,0.03), 0 0 14px rgba(0,255,255,0.08);',
        '  touch-action:none;',
        '}',
        '#mi-touchbox.show { display:block; }',
        '#mi-touchbox.active {',
        '  border-color:rgba(0,255,255,0.55);',
        '  box-shadow:inset 0 0 0 1px rgba(255,255,255,0.05), 0 0 18px rgba(0,255,255,0.18);',
        '}',
        '.mi-touchbox-axis-x, .mi-touchbox-axis-y {',
        '  position:absolute; background:rgba(0,255,255,0.1); pointer-events:none;',
        '}',
        '.mi-touchbox-axis-x { left:16px; right:16px; top:50%; height:1px; margin-top:-0.5px; }',
        '.mi-touchbox-axis-y { top:16px; bottom:16px; left:50%; width:1px; margin-left:-0.5px; }',
        '.mi-touchbox-corner {',
        '  position:absolute; color:rgba(0,255,255,0.4); font:12px/1 monospace; pointer-events:none;',
        '}',
        '.mi-touchbox-corner.tl { left:10px; top:10px; }',
        '.mi-touchbox-corner.tr { right:10px; top:10px; }',
        '.mi-touchbox-corner.bl { left:10px; bottom:10px; }',
        '.mi-touchbox-corner.br { right:10px; bottom:10px; }',
        '.mi-touchbox-hint {',
        '  position:absolute; left:50%; top:50%; transform:translate(-50%, -50%);',
        '  color:rgba(230,255,255,0.78); font:11px/1.35 monospace; text-align:center;',
        '  text-shadow:0 0 10px rgba(0,255,255,0.2); pointer-events:none; white-space:nowrap;',
        '}',
        '.mi-touchbox-subhint {',
        '  display:block; margin-top:6px; color:rgba(0,255,255,0.55); font-size:10px;',
        '}',
        '@media (max-width: 420px) {',
        '  #mi-fn-panel { padding:6px; }',
        '  .mi-fn-shell { grid-template-columns:minmax(0, 1.38fr) minmax(116px, 0.92fr); gap:8px; }',
        '  .mi-fn-group, .mi-fn-arrow-box { padding:7px; }',
        '  .mi-fn-grid { gap:5px; }',
        '  .mi-fn-arrows { grid-template-columns:repeat(3, 34px); grid-template-rows:repeat(2, 34px); gap:5px; }',
        '  .mi-fn-key { min-height:32px; font-size:11px; padding:0 6px; }',
        '}'
    ].join('\n');
    document.head.appendChild(style);

    // =========================================================
    //  DOM construction
    // =========================================================

    // The controls are anchored beneath the rendered terminal area, not the
    // viewport bottom, so they should not shrink the terminal container.
    document.documentElement.style.setProperty('--mi-bottom-reserved', '0px');

    // 1. Bottom dock and explicit mode buttons
    var toolbar = document.createElement('div');
    toolbar.id = 'mi-toolbar';
    document.body.appendChild(toolbar);

    function makeToolbarButton(id, title, iconMarkup) {
        var btn = document.createElement('div');
        btn.id = id;
        btn.className = 'mi-toolbar-btn';
        btn.title = title;
        btn.setAttribute('role', 'button');
        btn.setAttribute('aria-label', title);
        btn.innerHTML = iconMarkup;
        toolbar.appendChild(btn);
        return btn;
    }

    var touchpadBtn = makeToolbarButton(
        'mi-btn-touchpad',
        'Show Touch Pad Controls',
        [
            '<svg viewBox="0 0 24 24" aria-hidden="true">',
            '<rect x="4" y="5" width="16" height="14" rx="2"></rect>',
            '<path d="M12 9v6"></path>',
            '<path d="M9 12h6"></path>',
            '</svg>'
        ].join('')
    );

    var keyboardBtn = makeToolbarButton(
        'mi-btn-keyboard',
        'Show Keyboard Controls',
        [
            '<svg viewBox="0 0 24 24" aria-hidden="true">',
            '<rect x="3.5" y="6" width="17" height="12" rx="2"></rect>',
            '<path d="M7 10.5h.01"></path>',
            '<path d="M11 10.5h.01"></path>',
            '<path d="M15 10.5h.01"></path>',
            '<path d="M7 14h10"></path>',
            '</svg>'
        ].join('')
    );

    var fnBtn = makeToolbarButton(
        'mi-btn-fn',
        'Show Function Keys',
        [
            '<svg viewBox="0 0 24 24" aria-hidden="true">',
            '<rect x="4" y="6" width="3.5" height="4" rx="0.8"></rect>',
            '<rect x="8.5" y="6" width="3.5" height="4" rx="0.8"></rect>',
            '<rect x="13" y="6" width="3.5" height="4" rx="0.8"></rect>',
            '<rect x="17.5" y="6" width="2.5" height="4" rx="0.8"></rect>',
            '<path d="M4.5 15.5h15"></path>',
            '<path d="M7.5 13.5v4"></path>',
            '<path d="M12 13.5v4"></path>',
            '<path d="M16.5 13.5v4"></path>',
            '</svg>'
        ].join('')
    );

    var dpadBtn = makeToolbarButton(
        'mi-btn-dpad',
        'Show D-Pad Controls',
        [
            '<svg viewBox="0 0 24 24" aria-hidden="true">',
            '<path d="M12 4v16"></path>',
            '<path d="M4 12h16"></path>',
            '<path d="M10 6l2-2 2 2"></path>',
            '<path d="M10 18l2 2 2-2"></path>',
            '<path d="M6 10l-2 2 2 2"></path>',
            '<path d="M18 10l2 2-2 2"></path>',
            '</svg>'
        ].join('')
    );

    // 2. Hidden input
    var input = document.createElement('input');
    input.id = 'mi-input';
    input.type = 'text';
    input.autocomplete = 'off';
    input.autocapitalize = 'none';
    input.autocorrect = 'off';
    input.spellcheck = false;
    input.setAttribute('inputmode', 'text');
    input.setAttribute('enterkeyhint', 'enter');
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
    var EXTRA_BAR_KEYS = ['Esc', 'Tab', 'Ctrl', 'Alt', '↑', '↓', '←', '→'];

    EXTRA_KEYS.forEach(function (def) {
        if (EXTRA_BAR_KEYS.indexOf(def.label) === -1) return;
        var btn = document.createElement('div');
        btn.className = 'mi-xkey';
        btn.textContent = def.label;
        btn.setAttribute('data-mi-key', JSON.stringify(def));
        extraBar.appendChild(btn);
    });
    document.body.appendChild(extraBar);

    function findExtraKey(label) {
        var i;
        for (i = 0; i < EXTRA_KEYS.length; i++) {
            if (EXTRA_KEYS[i].label === label) return EXTRA_KEYS[i];
        }
        return null;
    }

    function createFnKeyButton(label, className) {
        var btn = document.createElement('div');
        var def = findExtraKey(label);
        btn.className = className || 'mi-fn-key';
        btn.textContent = label;
        if (def) {
            btn.setAttribute('data-mi-key', JSON.stringify(def));
        }
        return btn;
    }

    function createFnGroup(title, labels, extraClass) {
        var group = document.createElement('div');
        var label = document.createElement('div');
        var grid = document.createElement('div');
        var i;

        group.className = 'mi-fn-group' + (extraClass ? ' ' + extraClass : '');
        label.className = 'mi-fn-label';
        label.textContent = title;
        group.appendChild(label);

        grid.className = 'mi-fn-grid' + (extraClass ? ' ' + extraClass : '');
        for (i = 0; i < labels.length; i++) {
            grid.appendChild(createFnKeyButton(labels[i], 'mi-fn-key'));
        }
        group.appendChild(grid);
        return group;
    }

    // 4. Function-key panel
    var fnPanel = document.createElement('div');
    fnPanel.id = 'mi-fn-panel';

    var fnShell = document.createElement('div');
    fnShell.className = 'mi-fn-shell';
    fnPanel.appendChild(fnShell);

    var fnMain = document.createElement('div');
    fnMain.className = 'mi-fn-main';
    fnMain.appendChild(createFnGroup('System', ['Esc', 'Tab', 'Ctrl', 'Alt']));
    fnMain.appendChild(createFnGroup('Function Keys', ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10']));
    fnShell.appendChild(fnMain);

    var fnSide = document.createElement('div');
    fnSide.className = 'mi-fn-side';
    fnSide.appendChild(createFnGroup('Navigation', ['Home', 'End', 'PgUp', 'PgDn', 'Ins', 'Del'], 'nav'));
    var fnArrowBox = document.createElement('div');
    fnArrowBox.className = 'mi-fn-arrow-box';
    var fnArrowLabel = document.createElement('div');
    fnArrowLabel.className = 'mi-fn-label';
    fnArrowLabel.textContent = 'Arrows';
    fnArrowBox.appendChild(fnArrowLabel);
    var fnArrows = document.createElement('div');
    fnArrows.className = 'mi-fn-arrows';
    fnArrows.appendChild(createFnKeyButton('↑', 'mi-fn-key mi-fn-arrow-up'));
    fnArrows.appendChild(createFnKeyButton('←', 'mi-fn-key mi-fn-arrow-left'));
    fnArrows.appendChild(createFnKeyButton('↓', 'mi-fn-key mi-fn-arrow-down'));
    fnArrows.appendChild(createFnKeyButton('→', 'mi-fn-key mi-fn-arrow-right'));
    fnArrowBox.appendChild(fnArrows);
    fnSide.appendChild(fnArrowBox);
    fnShell.appendChild(fnSide);
    document.body.appendChild(fnPanel);

    // 5. D-Pad overlay
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

    // 6. Mapping picker bar (above d-pad)
    var mappingBar = document.createElement('div');
    mappingBar.id = 'mi-mapping-bar';
    document.body.appendChild(mappingBar);

    // 7. Touch pad for swipe gestures when controls are otherwise hidden
    var touchBox = document.createElement('div');
    touchBox.id = 'mi-touchbox';
    touchBox.innerHTML = [
        '<div class="mi-touchbox-axis-x"></div>',
        '<div class="mi-touchbox-axis-y"></div>',
        '<div class="mi-touchbox-corner tl">&#8600;</div>',
        '<div class="mi-touchbox-corner tr">&#8601;</div>',
        '<div class="mi-touchbox-corner bl">&#8599;</div>',
        '<div class="mi-touchbox-corner br">&#8598;</div>',
        '<div class="mi-touchbox-hint">Swipe for arrows<span class="mi-touchbox-subhint">Double tap = Enter · 2-finger swipe = Esc</span></div>'
    ].join('');
    document.body.appendChild(touchBox);

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
            // Restore modes that do not require raising the native keyboard.
            if (sm === MODE_DPAD || sm === MODE_FN) savedMode = sm;
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

    function clamp(value, min, max) {
        if (value < min) return min;
        if (value > max) return max;
        return value;
    }

    function getVisibleBottom() {
        var viewport = window.visualViewport;
        if (viewport) {
            return Math.max(
                TOOLBAR_HEIGHT,
                Math.floor(viewport.offsetTop + viewport.height) - 4
            );
        }
        return Math.max(TOOLBAR_HEIGHT, window.innerHeight - keyboardHeight - 4);
    }

    function getTerminalAnchorTop() {
        var canvas = document.querySelector('#fTelnetContainer canvas');
        var container = document.getElementById('fTelnetContainer');
        var rect;
        var visibleBottom = getVisibleBottom();

        if (canvas) {
            rect = canvas.getBoundingClientRect();
            if (rect && rect.height > 0 && rect.width > 0) {
                return clamp(
                    Math.floor(rect.bottom) + CONTROL_GAP,
                    0,
                    Math.max(0, visibleBottom - TOOLBAR_HEIGHT)
                );
            }
        }

        if (container) {
            rect = container.getBoundingClientRect();
            if (rect && rect.height > 0) {
                return clamp(
                    Math.floor(rect.bottom) - TOOLBAR_HEIGHT - CONTROL_GAP,
                    0,
                    Math.max(0, visibleBottom - TOOLBAR_HEIGHT)
                );
            }
        }

        return Math.max(0, visibleBottom - TOOLBAR_HEIGHT);
    }

    function positionExtras() {
        var visibleBottom = getVisibleBottom();
        var toolbarTop = getTerminalAnchorTop();
        var extraHeight = extraBar.offsetHeight || 42;
        var fnPanelTop = toolbarTop + TOOLBAR_HEIGHT + CONTROL_GAP;
        var fnPanelMaxHeight = Math.max(0, visibleBottom - fnPanelTop - 8);
        var mappingHeight = mappingBar.offsetHeight || 38;
        var dpadHeight = dpadOverlay.offsetHeight || 220;
        var dpadStackHeight = TOOLBAR_HEIGHT + CONTROL_GAP + mappingHeight + CONTROL_GAP + dpadHeight;
        var touchBoxTop = toolbarTop + TOOLBAR_HEIGHT + CONTROL_GAP;
        var touchBoxAvailable = Math.max(0, visibleBottom - touchBoxTop - 8);
        var touchBoxHeight = touchBoxAvailable;
        var dpadTop = clamp(
            toolbarTop,
            0,
            Math.max(0, visibleBottom - dpadStackHeight)
        );

        if (toolbar) {
            toolbar.style.bottom = 'auto';
            toolbar.style.top = (currentMode === MODE_DPAD ? dpadTop : toolbarTop) + 'px';
        }
        if (currentMode === MODE_KEYBOARD) {
            extraBar.style.bottom = 'auto';
            extraBar.style.top = clamp(
                toolbarTop + TOOLBAR_HEIGHT + CONTROL_GAP,
                0,
                Math.max(0, visibleBottom - extraHeight)
            ) + 'px';
        } else if (currentMode === MODE_DPAD) {
            mappingBar.style.bottom = 'auto';
            mappingBar.style.top = (dpadTop + TOOLBAR_HEIGHT + CONTROL_GAP) + 'px';
            dpadOverlay.style.bottom = 'auto';
            dpadOverlay.style.top = (dpadTop + TOOLBAR_HEIGHT + CONTROL_GAP + mappingHeight + CONTROL_GAP) + 'px';
        } else {
            extraBar.style.bottom = 'auto';
            extraBar.style.top = clamp(
                toolbarTop + TOOLBAR_HEIGHT + CONTROL_GAP,
                0,
                Math.max(0, visibleBottom - extraHeight)
            ) + 'px';
            mappingBar.style.bottom = 'auto';
            mappingBar.style.top = (toolbarTop + TOOLBAR_HEIGHT + CONTROL_GAP) + 'px';
            dpadOverlay.style.bottom = 'auto';
            dpadOverlay.style.top = (toolbarTop + TOOLBAR_HEIGHT + CONTROL_GAP + mappingHeight + CONTROL_GAP) + 'px';
        }
        if (fnPanel) {
            fnPanel.style.bottom = 'auto';
            fnPanel.style.top = fnPanelTop + 'px';
            fnPanel.style.maxHeight = fnPanelMaxHeight + 'px';
            fnPanel.style.display = currentMode === MODE_FN ? 'block' : 'none';
        }
        if (touchBox) {
            touchBox.style.bottom = 'auto';
            touchBox.style.top = touchBoxTop + 'px';
            touchBox.style.height = Math.max(0, touchBoxHeight) + 'px';
            touchBox.style.display = (currentMode === MODE_OFF && touchBoxHeight >= TOUCHBOX_MIN_HEIGHT)
                ? 'block'
                : 'none';
        }
    }

    function updateModeButtons() {
        touchpadBtn.classList.toggle('active', currentMode === MODE_OFF);
        keyboardBtn.classList.toggle('active', currentMode === MODE_KEYBOARD);
        fnBtn.classList.toggle('active', currentMode === MODE_FN);
        dpadBtn.classList.toggle('active', currentMode === MODE_DPAD);
        touchpadBtn.title = currentMode === MODE_OFF
            ? 'Touch Pad Active'
            : 'Show Touch Pad Controls';
        keyboardBtn.title = currentMode === MODE_KEYBOARD
            ? 'Hide Keyboard Controls'
            : 'Show Keyboard Controls';
        fnBtn.title = currentMode === MODE_FN
            ? 'Hide Function Keys'
            : 'Show Function Keys';
        dpadBtn.title = currentMode === MODE_DPAD
            ? 'Hide D-Pad Controls'
            : 'Show D-Pad Controls';
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', updateKeyboardHeight);
    }
    window.addEventListener('resize', positionExtras);
    window.addEventListener('mi:reposition', positionExtras);

    // =========================================================
    //  Hidden input → fTelnet keystroke relay
    // =========================================================
    var composing = false;
    var lastSpecialKey = '';
    var lastSpecialKeyAt = 0;

    function shouldSendSpecial(name) {
        var now = Date.now();

        if (lastSpecialKey === name && (now - lastSpecialKeyAt) < 80) {
            return false;
        }
        lastSpecialKey = name;
        lastSpecialKeyAt = now;
        return true;
    }

    input.addEventListener('compositionstart', function () { composing = true; });
    input.addEventListener('compositionend', function () {
        composing = false;
        flushInput();
    });

    input.addEventListener('input', function () {
        if (composing) return;
        flushInput();
    });

    input.addEventListener('beforeinput', function (e) {
        var opts;

        if (composing) return;

        opts = { ctrl: stickyCtrl, alt: stickyAlt, shift: false };
        if (e.inputType === 'deleteContentBackward' && !input.value.length) {
            if (shouldSendSpecial('Backspace')) {
                sendKey('Backspace', 'Backspace', 8, opts);
            }
            e.preventDefault();
            e.stopPropagation();
            consumeSticky();
        }
    });

    function flushInput() {
        var val = input.value;
        var clean = '';
        var hadLineBreak = false;
        var opts = { ctrl: stickyCtrl, alt: stickyAlt, shift: false };

        if (!val) return;
        input.value = '';
        hadLineBreak = /[\r\n]/.test(String(val));
        clean = String(val).replace(/[\r\n]+/g, '');
        if (clean.length) {
            sendString(clean, opts);
        }
        if (hadLineBreak && shouldSendSpecial('Enter')) {
            sendKey('Enter', 'Enter', 13, opts);
        }
        if (!clean.length && !hadLineBreak) return;
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
            if (shouldSendSpecial('Backspace')) {
                sendKey('Backspace', 'Backspace', 8, opts);
            }
            handled = true;
        }
        // Enter
        else if (e.key === 'Enter') {
            if (shouldSendSpecial('Enter')) {
                sendKey('Enter', 'Enter', 13, opts);
            }
            handled = true;
        }
        // Tab
        else if (e.key === 'Tab') {
            if (shouldSendSpecial('Tab')) {
                sendKey('Tab', 'Tab', 9, opts);
            }
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
        var keys = document.querySelectorAll('.mi-xkey, .mi-fn-key');
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
    extraBar.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    extraBar.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    fnPanel.addEventListener('touchstart', function (e) {
        var btn = e.target.closest('.mi-fn-key');
        var def;

        if (!btn) return;
        e.preventDefault();
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
        if (navigator.vibrate) navigator.vibrate(15);
    }, { passive: false });
    fnPanel.addEventListener('contextmenu', function (e) { e.preventDefault(); });

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
    dpadOverlay.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    dpadOverlay.addEventListener('touchend', function () { stopRepeat(); });
    dpadOverlay.addEventListener('touchcancel', function () { stopRepeat(); });
    dpadOverlay.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // Mapping bar click
    mappingBar.addEventListener('touchstart', function (e) {
        var btn = e.target.closest('.mi-map-btn');
        if (!btn) return;
        e.preventDefault();
        var id = btn.getAttribute('data-mi-mapping');
        selectMapping(id);
        if (navigator.vibrate) navigator.vibrate(10);
    }, { passive: false });
    mappingBar.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    mappingBar.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // =========================================================
    //  Touch pad swipe gestures
    // =========================================================
    var touchBoxStartX = 0;
    var touchBoxStartY = 0;
    var touchBoxCurrentX = 0;
    var touchBoxCurrentY = 0;
    var touchBoxStartAt = 0;
    var touchBoxTracking = false;
    var touchBoxTrackingMode = '';
    var touchBoxLastTapAt = 0;
    var touchBoxLastTapX = 0;
    var touchBoxLastTapY = 0;
    var TOUCHBOX_TAP_MOVE = 16;
    var TOUCHBOX_MAX_TAP = 260;
    var TOUCHBOX_DOUBLE_TAP = 330;
    var TOUCHBOX_DOUBLE_TAP_SLOP = 28;
    var TOUCHBOX_SWIPE_THRESHOLD = 26;
    var TOUCHBOX_ESCAPE_SWIPE_THRESHOLD = 34;

    function flashTouchBox() {
        touchBox.classList.add('active');
        setTimeout(function () {
            touchBox.classList.remove('active');
        }, 110);
    }

    function sendTouchBoxArrow(direction) {
        var def;

        if (direction === 'up') def = { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 };
        else if (direction === 'down') def = { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 };
        else if (direction === 'left') def = { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 };
        else def = { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 };

        sendKey(def.key, def.code, def.keyCode);
        flashTouchBox();
        if (navigator.vibrate) navigator.vibrate(10);
    }

    function sendTouchBoxEscape() {
        sendKey('Escape', 'Escape', 27);
        flashTouchBox();
        if (navigator.vibrate) navigator.vibrate([10, 20, 10]);
    }

    function getTouchBoxCentroid(touches) {
        var i;
        var totalX = 0;
        var totalY = 0;
        var count = touches ? touches.length : 0;

        if (!count) return null;
        for (i = 0; i < count; i++) {
            totalX += touches[i].clientX;
            totalY += touches[i].clientY;
        }
        return {
            x: totalX / count,
            y: totalY / count
        };
    }

    function handleTouchBoxTap(clientX, clientY) {
        var now = Date.now();
        var withinWindow = (now - touchBoxLastTapAt) <= TOUCHBOX_DOUBLE_TAP;
        var withinSlop = Math.abs(clientX - touchBoxLastTapX) <= TOUCHBOX_DOUBLE_TAP_SLOP &&
            Math.abs(clientY - touchBoxLastTapY) <= TOUCHBOX_DOUBLE_TAP_SLOP;

        if (withinWindow && withinSlop) {
            sendKey('Enter', 'Enter', 13);
            touchBoxLastTapAt = 0;
            touchBoxLastTapX = 0;
            touchBoxLastTapY = 0;
            flashTouchBox();
            if (navigator.vibrate) navigator.vibrate(14);
            return;
        }

        touchBoxLastTapAt = now;
        touchBoxLastTapX = clientX;
        touchBoxLastTapY = clientY;
        flashTouchBox();
        if (navigator.vibrate) navigator.vibrate(6);
    }

    touchBox.addEventListener('touchstart', function (e) {
        var touch;
        var center;

        if (currentMode !== MODE_OFF) return;

        if (e.touches.length === 2) {
            center = getTouchBoxCentroid(e.touches);
            if (!center) return;
            touchBoxStartX = center.x;
            touchBoxStartY = center.y;
            touchBoxCurrentX = center.x;
            touchBoxCurrentY = center.y;
            touchBoxStartAt = Date.now();
            touchBoxTracking = true;
            touchBoxTrackingMode = 'escape';
            e.preventDefault();
            return;
        }

        if (e.touches.length !== 1) {
            touchBoxTracking = false;
            touchBoxTrackingMode = '';
            return;
        }

        touch = e.touches[0];
        touchBoxStartX = touch.clientX;
        touchBoxStartY = touch.clientY;
        touchBoxCurrentX = touch.clientX;
        touchBoxCurrentY = touch.clientY;
        touchBoxStartAt = Date.now();
        touchBoxTracking = true;
        touchBoxTrackingMode = 'arrow';
        e.preventDefault();
    }, { passive: false });

    touchBox.addEventListener('touchmove', function (e) {
        var center;

        if (!touchBoxTracking) return;
        if (touchBoxTrackingMode === 'escape' && e.touches.length >= 2) {
            center = getTouchBoxCentroid(e.touches);
            if (center) {
                touchBoxCurrentX = center.x;
                touchBoxCurrentY = center.y;
            }
        } else if (touchBoxTrackingMode === 'arrow' && e.touches.length >= 1) {
            touchBoxCurrentX = e.touches[0].clientX;
            touchBoxCurrentY = e.touches[0].clientY;
        }
        e.preventDefault();
    }, { passive: false });

    touchBox.addEventListener('touchend', function (e) {
        var trackingMode;
        var touch;
        var dx;
        var dy;
        var absDx;
        var absDy;
        var duration;

        if (!touchBoxTracking) return;

        touch = e.changedTouches[0];
        if (touchBoxTrackingMode === 'escape') {
            dx = touchBoxCurrentX - touchBoxStartX;
            dy = touchBoxCurrentY - touchBoxStartY;
        } else {
            dx = touch.clientX - touchBoxStartX;
            dy = touch.clientY - touchBoxStartY;
        }
        absDx = Math.abs(dx);
        absDy = Math.abs(dy);
        duration = Date.now() - touchBoxStartAt;
        trackingMode = touchBoxTrackingMode;
        touchBoxTracking = false;
        touchBoxTrackingMode = '';
        e.preventDefault();

        if (duration > 900) return;

        if (trackingMode === 'escape' &&
            absDx >= TOUCHBOX_ESCAPE_SWIPE_THRESHOLD &&
            absDx >= absDy * 1.15) {
            sendTouchBoxEscape();
            return;
        }

        if (trackingMode === 'escape') return;

        if (absDx <= TOUCHBOX_TAP_MOVE && absDy <= TOUCHBOX_TAP_MOVE && duration <= TOUCHBOX_MAX_TAP) {
            handleTouchBoxTap(touch.clientX, touch.clientY);
            return;
        }

        if (Math.max(absDx, absDy) < TOUCHBOX_SWIPE_THRESHOLD) return;

        if (absDx >= absDy) {
            sendTouchBoxArrow(dx >= 0 ? 'right' : 'left');
        } else {
            sendTouchBoxArrow(dy >= 0 ? 'down' : 'up');
        }
    }, { passive: false });

    touchBox.addEventListener('touchcancel', function () {
        touchBoxTracking = false;
        touchBoxTrackingMode = '';
    });
    touchBox.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // =========================================================
    //  Mode switching
    // =========================================================
    function setMode(mode) {
        currentMode = mode;
        try { localStorage.setItem('mi-mode', mode); } catch (_) {}

        // Hide all overlays first
        extraBar.classList.remove('show');
        fnPanel.classList.remove('show');
        dpadOverlay.classList.remove('show');
        mappingBar.classList.remove('show');
        touchBox.classList.remove('show');
        input.blur();

        if (mode === MODE_KEYBOARD) {
            extraBar.classList.add('show');
            // Focus the hidden input to raise the native keyboard.
            // MUST be synchronous — iOS kills the user-gesture privilege
            // if focus() is inside setTimeout/Promise/rAF.
            input.focus({ preventScroll: true });
        } else if (mode === MODE_FN) {
            fnPanel.classList.add('show');
        } else if (mode === MODE_DPAD) {
            dpadOverlay.classList.add('show');
            mappingBar.classList.add('show');
        } else {
            touchBox.classList.add('show');
        }

        updateModeButtons();
        positionExtras();

        // Tell the iframe container we changed size
        setTimeout(function () {
            window.dispatchEvent(new Event('resize'));
        }, 350);
    }

    function handleModeButtonTouch(e) {
        e.stopPropagation();
        if (navigator.vibrate) navigator.vibrate(15);
    }

    keyboardBtn.addEventListener('touchstart', handleModeButtonTouch, { passive: true });
    fnBtn.addEventListener('touchstart', handleModeButtonTouch, { passive: true });
    dpadBtn.addEventListener('touchstart', handleModeButtonTouch, { passive: true });
    touchpadBtn.addEventListener('touchstart', handleModeButtonTouch, { passive: true });

    touchpadBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        setMode(MODE_OFF);
    });

    keyboardBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        setMode(currentMode === MODE_KEYBOARD ? MODE_OFF : MODE_KEYBOARD);
    });

    fnBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        setMode(currentMode === MODE_FN ? MODE_OFF : MODE_FN);
    });

    dpadBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        setMode(currentMode === MODE_DPAD ? MODE_OFF : MODE_DPAD);
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
            else if (msg.action === 'showFn') setMode(MODE_FN);
            else if (msg.action === 'showDpad') setMode(MODE_DPAD);
            else if (msg.action === 'dismiss') setMode(MODE_OFF);
            else if (msg.action === 'setMapping') selectMapping(msg.mapping);
        }
    });

    // Restore saved mode (deferred so DOM is ready)
    if (savedMode !== MODE_OFF) {
        setTimeout(function () { setMode(savedMode); }, 500);
    } else {
        setMode(MODE_OFF);
    }

    console.log('[mobile-input] loaded — touch box ready');
})();
