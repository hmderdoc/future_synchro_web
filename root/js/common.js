/* common.js - SPA-compatible utilities for Synchronet webv4
 * Vanilla JS (no jQuery) + Bootstrap 5
 */

var updateInterval = 60000;
var _sbbs_events = {};

/* ---------- Fetch helpers ---------- */

async function v4_fetch(url, method, body) {
    var init = { method: method || 'GET', headers: {} };
    if (method === 'POST' && body) {
        init.body = body;
        if (body instanceof URLSearchParams) {
            init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
    }
    try {
        var response = await fetch(url, init);
        var data = await response.json();
        return data;
    } catch (err) {
        console.error('Error on fetch', url, init);
    }
}

function v4_get(url) {
    return v4_fetch(url);
}

function v4_post(url, data) {
    var fd = new URLSearchParams();
    for (var e in data) {
        if (Array.isArray(data[e])) {
            data[e].forEach(function (ee) { fd.append(e, ee); });
        } else {
            fd.append(e, data[e]);
        }
    }
    return v4_fetch(url, 'POST', fd);
}

async function v4_fetch_jsonl(url) {
    try {
        var response = await fetch(url);
        var text = await response.text();
        return text.split(/\r\n/).reduce(function (a, c) {
            if (c !== '') a.push(JSON.parse(c));
            return a;
        }, []);
    } catch (err) {
        console.error('Error on fetch_jsonl', url, err);
    }
}

/* ---------- Auth ---------- */

async function login(evt) {
    if (evt) evt.preventDefault();
    var usernameEl = document.getElementById('input-username');
    var passwordEl = document.getElementById('input-password');
    if (!usernameEl || !passwordEl) return;
    var username = usernameEl.value.trim();
    var password = passwordEl.value;
    if (!username || !password) return;

    var res = await v4_post('./api/auth.ssjs', {
        username: username,
        password: password
    });
    if (res && res.authenticated) {
        // Dispatch event for terminal auto-connect
        document.dispatchEvent(new CustomEvent('spa:login', {
            detail: { username: username, password: password }
        }));
        // Reload to get new session shell
        window.location.reload(true);
    } else {
        var form = document.getElementById('login-form') || document.getElementById('form-login');
        if (form) {
            var existing = form.querySelector('.login-error');
            if (existing) existing.remove();
            var p = document.createElement('p');
            p.className = 'text-danger login-error mt-2';
            p.textContent = 'Login failed';
            form.appendChild(p);
        }
    }
}

async function logout() {
    document.dispatchEvent(new CustomEvent('spa:logout'));
    var res = await v4_post('./api/auth.ssjs', { logout: true });
    if (!res || !res.authenticated) window.location.href = '/';
}

/* ---------- URL helpers ---------- */

function insertParam(key, value) {
    key = encodeURIComponent(key);
    value = encodeURIComponent(value);
    var kvp = window.location.search.substr(1).split('&');
    var i = kvp.length, x;
    while (i--) {
        x = kvp[i].split('=');
        if (x[0] !== key) continue;
        x[1] = value;
        kvp[i] = x.join('=');
        break;
    }
    if (i < 0) kvp[kvp.length] = [key, value].join('=');
    window.location.search = kvp.join('&');
}

/* ---------- Telegram ---------- */

function sendTelegram(alias) {
    var modalEl = document.getElementById('popUpModal');
    var titleEl = document.getElementById('popUpModalTitle');
    var bodyEl = document.getElementById('popUpModalBody');
    var actionBtn = document.getElementById('popUpModalActionButton');
    if (!modalEl || !titleEl || !bodyEl) return;

    titleEl.textContent = 'Send a telegram to ' + alias;
    bodyEl.innerHTML =
        '<form id="send-telegram-form">' +
        '<input type="text" class="form-control" placeholder="My message" name="telegram" id="telegram">' +
        '<input type="submit" value="submit" class="d-none">' +
        '</form>';

    var sendFn = function (evt) {
        if (evt) evt.preventDefault();
        var tgEl = document.getElementById('telegram');
        if (tgEl) {
            v4_post('./api/system.ssjs', {
                call: 'send-telegram',
                user: alias,
                telegram: tgEl.value
            });
        }
        bootstrap.Modal.getInstance(modalEl).hide();
    };

    var form = document.getElementById('send-telegram-form');
    if (form) form.addEventListener('submit', sendFn);
    if (actionBtn) {
        actionBtn.hidden = false;
        actionBtn.onclick = sendFn;
    }

    var modal = bootstrap.Modal.getOrCreateInstance(modalEl);
    modal.show();
}

/* ---------- EventSource / SSE ---------- */

function registerEventListener(scope, callback, params) {
    params = Object.keys(params || {}).reduce(function (a, c) {
        return a + '&' + c + '=' + params[c];
    }, '');
    _sbbs_events[scope] = {
        qs: 'subscribe=' + scope + params,
        callback: callback
    };
}

/* ---------- Dark mode ---------- */

function darkmodeRequested() {
    var ls = localStorage.getItem('darkSwitch');
    if (ls === 'true') return true;
    if (ls === 'false') return false;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) return true;
    var sw = document.getElementById('darkSwitch');
    return sw ? sw.checked : false;
}

function resetTheme() {
    var sw = document.getElementById('darkSwitch');
    if (!sw) return;
    if (sw.checked) {
        document.body.classList.add('dark');
        document.documentElement.setAttribute('data-bs-theme', 'dark');
        localStorage.setItem('darkSwitch', 'true');
    } else {
        document.body.classList.remove('dark');
        document.documentElement.removeAttribute('data-bs-theme');
        localStorage.setItem('darkSwitch', 'false');
    }
}

/* ---------- Avatar cache (client-side) ---------- */

var sbbs = window.sbbs || {};
sbbs.avatars = sbbs.avatars || (function () {
    var store = {};
    return {
        get: function (key) { return store[key] || null; },
        set: function (obj) { if (obj && obj.user) store[obj.user] = obj; }
    };
})();
window.sbbs = sbbs;

/* ---------- Init ---------- */

document.addEventListener('DOMContentLoaded', function () {
    // Dark mode
    var darkSwitch = document.getElementById('darkSwitch');
    if (darkSwitch) {
        darkSwitch.checked = darkmodeRequested();
        darkSwitch.addEventListener('change', resetTheme);
        resetTheme();
    }

    // CGA theme toggle
    var cgaSwitch = document.getElementById('cgaSwitch');
    if (cgaSwitch) {
        cgaSwitch.checked = localStorage.getItem('cgaTheme') === 'true';
        function applyCgaTheme() {
            if (cgaSwitch.checked) {
                document.documentElement.setAttribute('data-theme', 'cga');
                localStorage.setItem('cgaTheme', 'true');
            } else {
                document.documentElement.removeAttribute('data-theme');
                localStorage.setItem('cgaTheme', 'false');
            }
        }
        cgaSwitch.addEventListener('change', applyCgaTheme);
        applyCgaTheme();
    }

    // Login / Logout
    var logoutBtn = document.getElementById('button-logout');
    var loginBtn = document.getElementById('button-login');
    var loginForm = document.getElementById('form-login');
    if (logoutBtn) logoutBtn.addEventListener('click', function (e) { e.preventDefault(); logout(); });
    if (loginBtn) loginBtn.addEventListener('click', login);
    if (loginForm) loginForm.addEventListener('submit', login);

    // Modal cleanup on hide
    var modalEl = document.getElementById('popUpModal');
    if (modalEl) {
        modalEl.addEventListener('hidden.bs.modal', function () {
            var actionBtn = document.getElementById('popUpModalActionButton');
            if (actionBtn) { actionBtn.onclick = null; actionBtn.hidden = true; }
            var title = document.getElementById('popUpModalTitle');
            var body = document.getElementById('popUpModalBody');
            if (title) title.textContent = '';
            if (body) body.innerHTML = '';
        });
    }

    // SSE event listeners
    var isLoggedIn = window.sbbsConfig && window.sbbsConfig.isLoggedIn;
    if (isLoggedIn) {
        registerEventListener('mail', function (e) {
            var data = JSON.parse(e.data);
            if (typeof data.count !== 'number') return;
            var badge1 = document.getElementById('badge-unread-mail');
            var badge2 = document.getElementById('badge-unread-mail-inner');
            var text = data.count < 1 ? '' : String(data.count);
            if (badge1) { badge1.textContent = text; badge1.style.display = text ? '' : 'none'; }
            if (badge2) { badge2.textContent = text; }
        });

        registerEventListener('telegram', function (e) {
            var tg = JSON.parse(e.data).replace(/\x01./g, '').replace(/\r?\n/g, '<br>');
            var titleEl = document.getElementById('popUpModalTitle');
            var bodyEl = document.getElementById('popUpModalBody');
            var actionBtn = document.getElementById('popUpModalActionButton');
            var modalEl = document.getElementById('popUpModal');
            if (titleEl) titleEl.innerHTML = 'New telegram(s) received';
            if (bodyEl) bodyEl.innerHTML += tg;
            if (actionBtn) actionBtn.hidden = true;
            if (modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).show();
        });

        registerEventListener('chat', function (e) {
            try {
                var data = JSON.parse(e.data);
                window.dispatchEvent(new CustomEvent('chat:message', { detail: data }));
            } catch (err) {
                console.error('chat SSE parse error', err);
            }
        }, { channel: 'main' });
    }

    // Start SSE
    var entries = Object.entries(_sbbs_events);
    if (entries.length) {
        var qs = entries.reduce(function (a, c, i) {
            return a + (i === 0 ? '?' : '&') + c[1].qs;
        }, '');
        var es = new EventSource('./api/events.ssjs' + qs);
        window._sbbsEventSource = es;
        Object.keys(_sbbs_events).forEach(function (e) {
            es.addEventListener(e, _sbbs_events[e].callback);
        });
    }
});
