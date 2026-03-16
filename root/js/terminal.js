/* terminal.js - fTelnet lifecycle manager for SPA
 *
 * Connection architecture:
 *   HTTP  -> ws://hostname:1123/?Port=<service_port>
 *   HTTPS -> wss://hostname/ws?Port=<service_port>  (Caddy proxies /ws to WS:1123)
 *
 * websocketservice.js reads ?Port= from the query string to route to the
 * correct backend (telnet:23 or rlogin:1513).
 */
(function () {
    'use strict';

    var cfg = window.sbbsConfig;
    if (!cfg.ftelnet) return;

    var panel = document.getElementById('terminal-panel');
    var btnToggle = document.getElementById('btn-terminal');
    var btnClose = document.getElementById('btn-terminal-close');
    var btnConnect = document.getElementById('ftelnet-connect');
    var statusDot = document.getElementById('terminal-status');
    var infoEl = document.getElementById('terminal-info');
    var controlsEl = document.getElementById('terminal-controls');

    var client = null;
    var isConnected = false;
    var isVisible = false;
    var initialized = false;
    var isSecure = location.protocol === 'https:';

    /* ---------- init fTelnet ---------- */

    function initTerminal() {
        if (initialized) return;
        if (typeof fTelnetOptions === 'undefined' || typeof fTelnetClient === 'undefined') {
            setTimeout(initTerminal, 500);
            return;
        }
        initialized = true;

        var servicePort = cfg.isLoggedIn ? cfg.rloginPort : cfg.telnetPort;

        var options = new fTelnetOptions();
        options.BareLFtoCRLF = false;
        options.BitsPerSecond = 57600;
        options.Emulation = 'ansi-bbs';
        options.Enter = '\r';
        options.Font = 'CP437';
        options.ForceWss = false;
        options.Hostname = location.hostname;
        options.LocalEcho = false;
        options.ScreenColumns = 80;
        options.ScreenRows = 25;
        options.SplashScreen = cfg.ftelnetSplash;

        if (isSecure) {
            /* HTTPS: Connect to wss://hostname/ws?Port=<service>
             * Caddy on :443 handles /ws, proxies to localhost:1123 */
            options.Port = 443;
            options.ForceWss = true;
            options.WebSocketUrlPath = '/ws?Port=' + servicePort;
        } else {
            /* HTTP: Direct WS to port 1123 */
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

        if (controlsEl) controlsEl.classList.remove('d-none');

        if (client.OnConnectionConnect) {
            var origConnect = client.OnConnectionConnect;
            client.OnConnectionConnect = function () {
                isConnected = true;
                updateStatus();
                if (origConnect) origConnect.apply(this, arguments);
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
    }

    /* ---------- RLogin auto-connect on login ---------- */

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

    /* ---------- UI ---------- */

    function updateStatus() {
        if (statusDot) {
            statusDot.className = 'badge rounded-pill ' + (isConnected ? 'bg-success' : 'bg-secondary');
            statusDot.style.width = '8px';
            statusDot.style.height = '8px';
            statusDot.style.display = 'inline-block';
        }
        if (infoEl) {
            infoEl.textContent = isConnected ? 'Connected' : 'Terminal';
        }
    }

    function showPanel() {
        if (!panel) return;
        panel.classList.remove('d-none');
        isVisible = true;
        if (!initialized) initTerminal();
    }

    function hidePanel() {
        if (!panel) return;
        panel.classList.add('d-none');
        isVisible = false;
    }

    function togglePanel() {
        if (isVisible) hidePanel();
        else showPanel();
    }

    /* ---------- event bindings ---------- */

    if (btnToggle) btnToggle.addEventListener('click', togglePanel);
    if (btnClose) btnClose.addEventListener('click', hidePanel);
    if (btnConnect) {
        btnConnect.addEventListener('click', function () {
            if (client && !isConnected) client.Connect();
        });
    }

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
            showPanel();
            if (!initialized) initTerminal();
            if (isConnected) {
                try { client.Disconnect(false); } catch (e) {}
            }
            client._Options.RLoginTerminalType = 'xtrn=' + code;
            client.Connect();
        });
    }

    window.sbbsTerminal = {
        show: showPanel,
        hide: hidePanel,
        toggle: togglePanel,
        connectRLogin: connectRLogin,
        launchXtrn: launchXtrn,
        isConnected: function () { return isConnected; }
    };
})();
