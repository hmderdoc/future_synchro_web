/* terminal.js - fTelnet lifecycle manager for SPA
 *
 * Connection architecture:
 *   HTTP  -> ws://hostname:1123/?Port=<service_port>
 *   HTTPS -> wss://hostname/ws?Port=<service_port>  (Caddy proxies /ws to WS:1123)
 *
 * websocketservice.js reads ?Port= from the query string to route to the
 * correct backend (telnet:23 or rlogin:1513).
 *
 * Responsive terminal:
 *   Columns and rows are calculated from viewport size at init + on resize.
 *   fTelnet._Crt.SetScreenSize() + SetFont() update live without reconnect.
 */
(function () {
    'use strict';

    var cfg = window.sbbsConfig;
    if (!cfg.ftelnet) return;

    var panel = document.getElementById('terminal-panel');
    var btnToggle = document.getElementById('btn-terminal');
    var statusDot = document.getElementById('terminal-status');

    var client = null;
    var isConnected = false;
    var isVisible = false;
    var initialized = false;
    var isSecure = location.protocol === 'https:';
    var currentColumns = 0;
    var currentRows = 0;
    var resizeTimer = null;

    /* ============================================================
     *  Responsive screen size calculation
     * ============================================================ */

    var BREAKPOINTS = [
        { minWidth: 1400, columns: 132, minRows: 25, maxRows: 50 },
        { minWidth: 0,    columns: 80,  minRows: 25, maxRows: 50 }
    ];


    var NAVBAR_HEIGHT = 58;
    var CP437_ASPECT = 2; // CP437 font height:width ratio (8px wide, 16px tall)

    function getScreenSize() {
        var w = window.innerWidth;
        var h = window.innerHeight - NAVBAR_HEIGHT;

        // Width determines columns (from breakpoint)
        var bp = BREAKPOINTS[BREAKPOINTS.length - 1];
        for (var i = 0; i < BREAKPOINTS.length; i++) {
            if (w >= BREAKPOINTS[i].minWidth) {
                bp = BREAKPOINTS[i];
                break;
            }
        }
        var cols = bp.columns;

        // Columns + width determine font size
        var fontW = Math.floor(w / cols);
        if (fontW < 1) fontW = 1;
        var fontH = fontW * CP437_ASPECT;

        // Font height + available height determine rows
        var rows = Math.floor(h / fontH);
        if (rows < 24) rows = 24;
        if (rows > 60) rows = 60;

        return { columns: cols, rows: rows };
    }

    /* ============================================================
     *  Resize handler — live-updates fTelnet dimensions
     * ============================================================ */

    function handleResize() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            if (!client || !client._Crt) return;

            // Clear fTelnet's inline dimensions so our CSS drives sizing
            var cc = document.querySelector('.fTelnetClientContainer');
            if (cc) {
                cc.style.width = '';
                cc.style.height = '';
                cc.style.overflow = 'hidden';
            }

            // Re-fit font to current container size (always safe)
            if (typeof client._Crt.SetFont === 'function') {
                client._Crt.SetFont(client._Crt.Font ? client._Crt.Font.Name : 'CP437');
            }

            scrollToBottom();

            // Only change screen dimensions if connected — avoids NAWS during handshake
            if (!isConnected) return;

            var size = getScreenSize();
            if (size.columns !== currentColumns || size.rows !== currentRows) {
                currentColumns = size.columns;
                currentRows = size.rows;
                if (typeof client._Crt.SetScreenSize === 'function') {
                    client._Crt.SetScreenSize(size.columns, size.rows);
                }
                // Re-fit font after size change
                if (typeof client._Crt.SetFont === 'function') {
                    client._Crt.SetFont(client._Crt.Font ? client._Crt.Font.Name : 'CP437');
                }
            }
            scrollToBottom();
        }, 250);
    }

    function attachResizeHandler() {
        window.addEventListener('resize', handleResize);
        window.addEventListener('orientationchange', handleResize);
        // Initial font fit is handled by forceFontRecalc() — don't
        // trigger handleResize here or it switches to 132 cols mid-login.
    }

    function detachResizeHandler() {
        clearTimeout(resizeTimer);
        window.removeEventListener('resize', handleResize);
        window.removeEventListener('orientationchange', handleResize);
    }



    /* ============================================================
     *  Input handlers — wheel → arrows, touch → tap/swipe
     *  Safari-safe: only preventDefault when actually consuming the event
     * ============================================================ */

    function sendArrowKey(direction) {
        var key = direction === 'up' ? 'ArrowUp' : 'ArrowDown';
        var keyCode = direction === 'up' ? 38 : 40;
        var evt = new KeyboardEvent('keydown', {
            key: key,
            code: key,
            keyCode: keyCode,
            which: keyCode,
            bubbles: true
        });
        window.dispatchEvent(evt);
    }

    function attachInputHandlers(container) {
        /* -- Wheel -> arrow keys (passive — no preventDefault needed) -- */
        var wheelHandler = function (e) {
            if (e.deltaY > 0) sendArrowKey('down');
            else if (e.deltaY < 0) sendArrowKey('up');
        };
        container.addEventListener('wheel', wheelHandler, { passive: true });

        /* -- Touch -> tap / swipe -- */
        var startX = 0, startY = 0, startTime = 0, tapActive = false;
        var TAP_MOVE = 10, SWIPE_THRESH = 40, MAX_TAP = 300;

        var touchStart = function (e) {
            if (e.touches.length !== 1) { tapActive = false; return; }
            var t = e.touches[0];
            startX = t.clientX; startY = t.clientY;
            startTime = Date.now();
            tapActive = true;
            // Don't preventDefault here — let Safari compositor proceed
        };

        var touchMove = function (e) {
            if (!tapActive || e.touches.length !== 1) return;
            var t = e.touches[0];
            if (Math.abs(t.clientX - startX) > TAP_MOVE || Math.abs(t.clientY - startY) > TAP_MOVE) {
                tapActive = false;
            }
        };

        var touchEnd = function (e) {
            if (!tapActive || e.changedTouches.length !== 1) return;
            var t = e.changedTouches[0];
            var dx = t.clientX - startX;
            var dy = t.clientY - startY;
            var absDx = Math.abs(dx), absDy = Math.abs(dy);
            var duration = Date.now() - startTime;
            tapActive = false;

            // Tap -> synthesize mouse click for fTelnet focus/hotspots
            if (absDx < TAP_MOVE && absDy < TAP_MOVE && duration < MAX_TAP) {
                var target = document.elementFromPoint(t.clientX, t.clientY);
                if (target) {
                    var init = { bubbles: true, cancelable: true, clientX: t.clientX, clientY: t.clientY, button: 0, buttons: 1, view: window };
                    if (window.PointerEvent) {
                        target.dispatchEvent(new PointerEvent('pointerdown', init));
                        target.dispatchEvent(new PointerEvent('pointerup', init));
                    }
                    target.dispatchEvent(new MouseEvent('mousedown', init));
                    target.dispatchEvent(new MouseEvent('mouseup', init));
                    target.dispatchEvent(new MouseEvent('click', init));
                }
                return;
            }

            // Vertical swipe -> arrow keys
            if (absDy > SWIPE_THRESH && absDy > absDx) {
                sendArrowKey(dy > 0 ? 'down' : 'up');
            }
        };

        var touchCancel = function () { tapActive = false; };

        // Touch listeners are passive — no preventDefault, no compositor blocking
        container.addEventListener('touchstart', touchStart, { passive: true });
        container.addEventListener('touchmove', touchMove, { passive: true });
        container.addEventListener('touchend', touchEnd, { passive: true });
        container.addEventListener('touchcancel', touchCancel, { passive: true });

        return function () {
            container.removeEventListener('wheel', wheelHandler);
            container.removeEventListener('touchstart', touchStart);
            container.removeEventListener('touchmove', touchMove);
            container.removeEventListener('touchend', touchEnd);
            container.removeEventListener('touchcancel', touchCancel);
        };
    }

    /* ============================================================
     *  Scroll container to bottom — fTelnet canvas includes scrollback
     *  above the active area.  Chrome auto-scrolls; Safari does not.
     * ============================================================ */

    function scrollToBottom() {
        var cc = document.querySelector('.fTelnetClientContainer');
        if (cc) cc.scrollTop = cc.scrollHeight;
    }

    /* ============================================================
     *  Force font recalculation after layout settles
     * ============================================================ */

    function forceFontRecalc() {
        // Clear fTelnet's inline dimensions so our CSS (100% !important) takes
        // effect, then re-fit the font.  Force a reflow read before SetFont so
        // fTelnet measures the real, settled container size.
        var delays = [100, 500, 1200];
        delays.forEach(function (ms) {
            setTimeout(function () {
                if (!client || !client._Crt) return;
                var cc = document.querySelector('.fTelnetClientContainer');
                if (cc) {
                    cc.style.width = '';
                    cc.style.height = '';
                    cc.style.overflow = 'hidden';
                    // Force synchronous reflow so SetFont reads settled layout
                    void cc.offsetHeight;
                }
                if (typeof client._Crt.SetFont === 'function') {
                    client._Crt.SetFont(client._Crt.Font ? client._Crt.Font.Name : 'CP437');
                }
                scrollToBottom();
            }, ms);
        });
    }

    /* ============================================================
     *  fTelnet initialisation
     * ============================================================ */

    function initTerminal() {
        if (initialized) return;
        if (typeof fTelnetOptions === 'undefined' || typeof fTelnetClient === 'undefined') {
            setTimeout(initTerminal, 500);
            return;
        }
        initialized = true;

        var servicePort = cfg.isLoggedIn ? cfg.rloginPort : cfg.telnetPort;

        // Bootstrap at the responsive breakpoint size — the BBS negotiates
        // column count via NAWS at connect time, so start at the right size.
        var initSize = getScreenSize();
        currentColumns = initSize.columns;
        currentRows = initSize.rows;

        var options = new fTelnetOptions();
        options.BareLFtoCRLF = false;
        options.BitsPerSecond = 921600;
        options.Emulation = 'ansi-bbs';
        options.Enter = '\r';
        options.Font = 'CP437';
        options.ForceWss = false;
        options.Hostname = location.hostname;
        options.LocalEcho = false;
        options.ScreenColumns = currentColumns;
        options.ScreenRows = currentRows;
        options.SplashScreen = cfg.ftelnetSplash;

        if (isSecure) {
            options.Port = 443;
            options.ForceWss = true;
            options.WebSocketUrlPath = '/ws?Port=' + servicePort;
        } else {
            options.Port = cfg.wsp;
            options.WebSocketUrlPath = '?Port=' + servicePort;
        }

        if (cfg.isLoggedIn) {
            options.ConnectionType = 'rlogin';
            options.RLoginClientUsername = cfg.userPassword;
            options.RLoginServerUsername = cfg.userAlias;
        } else {
            options.ConnectionType = 'telnet';
        }

        client = new fTelnetClient('fTelnetContainer', options);

        // Patch connection callbacks
        if (client.OnConnectionConnect) {
            var origConnect = client.OnConnectionConnect;
            client.OnConnectionConnect = function () {
                isConnected = true;
                updateStatus();
                if (origConnect) origConnect.apply(this, arguments);
                // Safari needs explicit scroll to bottom of canvas
                scrollToBottom();
                setTimeout(scrollToBottom, 200);
                setTimeout(scrollToBottom, 1000);
            };
        }
        if (client.OnConnectionClose) {
            var origClose = client.OnConnectionClose;
            client.OnConnectionClose = function () {
                isConnected = false;
                updateStatus();
                if (origClose) origClose.apply(this, arguments);
            };
        }

        // Auto-connect
        client.Connect();

        // Attach input & resize handlers
        var container = document.getElementById('fTelnetContainer');
        if (container) attachInputHandlers(container);
        attachResizeHandler();

        // Force font recalculation after layout settles.
        // fTelnet sizes the canvas from the container dimensions; if those
        // aren't ready yet the canvas ends up tiny.  Hit it a few times.
        forceFontRecalc();
    }

    /* ============================================================
     *  RLogin auto-connect on login
     * ============================================================ */

    function connectRLogin(username, password) {
        if (!client || !initialized || !client.Options) return;
        if (isConnected) {
            try { client.Disconnect(); } catch (e) {}
        }
        client.Options.ConnectionType = 'rlogin';
        client.Options.RLoginClientUsername = password;
        client.Options.RLoginServerUsername = username;
        if (isSecure) {
            client.Options.WebSocketUrlPath = '/ws?Port=' + cfg.rloginPort;
        } else {
            client.Options.WebSocketUrlPath = '?Port=' + cfg.rloginPort;
        }
        client.Connect();
    }

    /* ============================================================
     *  UI — status dot, CRT animation, panel show/hide
     * ============================================================ */

    function updateStatus() {
        if (statusDot) {
            statusDot.className = 'badge rounded-pill ' + (isConnected ? 'bg-success' : 'bg-secondary');
            statusDot.style.width = '8px';
            statusDot.style.height = '8px';
            statusDot.style.display = 'inline-block';
        }
    }

    /* ---------- CRT power-on animation ---------- */

    function playCrtAnimation(callback) {
        var overlay = document.createElement('div');
        overlay.className = 'crt-overlay';
        overlay.innerHTML =
            '<div class="crt-scanline"></div>' +
            '<div class="crt-bloom"></div>' +
            '<div class="crt-band" style="top:0;height:33%"></div>' +
            '<div class="crt-band" style="top:33%;height:34%"></div>' +
            '<div class="crt-band" style="top:67%;height:33%"></div>' +
            '<div class="crt-roll-band"></div>' +
            '<div class="crt-brightness"></div>';
        document.body.appendChild(overlay);

        var t = { black: 100, scanline: 40, bloom: 130, unstable: 220, lock: 40, settle: 90 };

        setTimeout(function () {
            overlay.classList.add('crt-phase-scanline');
            setTimeout(function () {
                overlay.classList.remove('crt-phase-scanline');
                overlay.classList.add('crt-phase-bloom');
                overlay.style.background = 'transparent';
                if (callback) callback();
                setTimeout(function () {
                    overlay.classList.remove('crt-phase-bloom');
                    overlay.classList.add('crt-phase-unstable');
                    setTimeout(function () {
                        overlay.classList.remove('crt-phase-unstable');
                        overlay.classList.add('crt-phase-lock');
                        setTimeout(function () {
                            overlay.classList.remove('crt-phase-lock');
                            overlay.classList.add('crt-phase-settle');
                            setTimeout(function () {
                                overlay.remove();
                            }, t.settle);
                        }, t.lock);
                    }, t.unstable);
                }, t.bloom);
            }, t.scanline);
        }, t.black);
    }

    /* ---------- panel show / hide ---------- */

    function showPanel(skipAnimation) {
        if (!panel) return;
        document.body.classList.add('terminal-open');

        if (skipAnimation) {
            panel.classList.remove('d-none');
            isVisible = true;
            if (!initialized) initTerminal();
            else forceFontRecalc();
            return;
        }

        playCrtAnimation(function () {
            panel.classList.remove('d-none');
            isVisible = true;
            if (!initialized) initTerminal();
            else forceFontRecalc();
        });
    }

    function hidePanel() {
        if (!panel) return;
        panel.classList.add('d-none');
        document.body.classList.remove('terminal-open');
        isVisible = false;
    }

    function togglePanel() {
        if (isVisible) hidePanel();
        else showPanel();
    }

    /* ============================================================
     *  Event bindings
     * ============================================================ */

    if (btnToggle) btnToggle.addEventListener('click', togglePanel);

    document.addEventListener('spa:login', function (e) {
        if (e.detail && e.detail.username && e.detail.password) {
            if (!isVisible) showPanel();
            connectRLogin(e.detail.username, e.detail.password);
        }
    });

    document.addEventListener('spa:logout', function () {
        if (client && isConnected) {
            try { client.Disconnect(); } catch (e) {}
        }
        if (client && client.Options) {
            client.Options.ConnectionType = 'telnet';
            if (isSecure) {
                client.Options.WebSocketUrlPath = '/ws?Port=' + cfg.telnetPort;
            } else {
                client.Options.WebSocketUrlPath = '?Port=' + cfg.telnetPort;
            }
        }
        isConnected = false;
        updateStatus();
    });

    function launchXtrn(code) {
        if (!code) return Promise.resolve();
        return v4_get('./api/system.ssjs?call=set-xtrn-intent&code=' + encodeURIComponent(code)).then(function () {
            showPanel(isVisible);
            if (!initialized) initTerminal();
            if (isConnected) {
                try { client.Disconnect(false); } catch (e) {}
            }
            client._Options.RLoginTerminalType = 'xtrn=' + code;
            client.Connect();
        });
    }

    /* ============================================================
     *  Public API
     * ============================================================ */

    window.sbbsTerminal = {
        show: showPanel,
        hide: hidePanel,
        toggle: togglePanel,
        connectRLogin: connectRLogin,
        launchXtrn: launchXtrn,
        isConnected: function () { return isConnected; }
    };
})();
