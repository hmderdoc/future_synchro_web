/* common.js - SPA-compatible utilities for Synchronet webv4
 * Vanilla JS (no jQuery) + Bootstrap 5
 */

var updateInterval = 60000;
var _sbbs_events = {};
var _sbbs_event_payloads = {};
var _sbbs_event_scopes = [];

function _sbbsBuildEventQuery() {
    var entries = Object.entries(_sbbs_events);
    if (!entries.length) return '';
    return entries.reduce(function (a, c, i) {
        return a + (i === 0 ? '?' : '&') + c[1].qs;
    }, '');
}

function _sbbsStartEventSource() {
    var entries = Object.entries(_sbbs_events);
    if (!entries.length) return;

    if (window._sbbsEventSource && typeof window._sbbsEventSource.close === 'function') {
        window._sbbsEventSource.close();
    }

    var es = new EventSource('./api/events.ssjs' + _sbbsBuildEventQuery());
    window._sbbsEventSource = es;
    _sbbs_event_scopes = entries.map(function (entry) { return entry[0]; });

    es.onopen = function () {
        window.dispatchEvent(new CustomEvent('sbbs:sseOpen'));
    };
    es.onerror = function () {
        window.dispatchEvent(new CustomEvent('sbbs:sseError'));
    };

    _sbbs_event_scopes.forEach(function (scope) {
        es.addEventListener(scope, function (evt) {
            _sbbs_event_payloads[scope] = evt.data;
            if (_sbbs_events[scope] && typeof _sbbs_events[scope].callback === 'function') {
                _sbbs_events[scope].callback(evt);
            }
        });
    });
}

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
        return [];
    }
}

/* ---------- Auth ---------- */

async function maybeStoreCredential(username, password) {
    if (!username || !password) return false;
    if (!window.isSecureContext) return false;
    if (!navigator.credentials || typeof navigator.credentials.store !== 'function') return false;
    if (typeof window.PasswordCredential === 'undefined') return false;
    try {
        await navigator.credentials.store(new PasswordCredential({
            id: username,
            password: password,
            name: username
        }));
        return true;
    } catch (err) {
        console.debug('Credential store unavailable:', err);
        return false;
    }
}

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
        await maybeStoreCredential(username, password);
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
    var previous = _sbbs_events[scope];
    params = Object.keys(params || {}).reduce(function (a, c) {
        return a + '&' + c + '=' + params[c];
    }, '');
    _sbbs_events[scope] = {
        qs: 'subscribe=' + scope + params,
        callback: callback
    };

    if (document.readyState !== 'loading') {
        if (!window._sbbsEventSource
            || _sbbs_event_scopes.indexOf(scope) < 0
            || !previous
            || previous.qs !== _sbbs_events[scope].qs
        ) {
            _sbbsStartEventSource();
        } else if (typeof _sbbs_event_payloads[scope] !== 'undefined' && typeof callback === 'function') {
            callback({ data: _sbbs_event_payloads[scope] });
        }
    }
}

/* ---------- Theme: CGA on, dark off (hardcoded) ---------- */

function resetTheme() {
    document.body.classList.remove('dark');
    document.documentElement.removeAttribute('data-bs-theme');
    document.documentElement.setAttribute('data-theme', 'cga');
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
    // Apply hardcoded theme (CGA on, dark off)
    resetTheme();

    // Login / Logout
    var logoutBtn = document.getElementById('button-logout');
    var loginBtn = document.getElementById('button-login');
    var loginForm = document.getElementById('form-login');
    if (logoutBtn) logoutBtn.addEventListener('click', function (e) { e.preventDefault(); logout(); });
    if (loginBtn) loginBtn.addEventListener('click', login);
    if (loginForm) loginForm.addEventListener('submit', login);
    initForgotPassword();

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

    }

    // Start SSE
    _sbbsStartEventSource();
});

/* ---------- Forgot Password inline flow ---------- */

function initForgotPassword() {
    var toggle   = document.getElementById('forgot-pw-toggle');
    var form     = document.getElementById('forgot-pw-form');
    var emailIn  = document.getElementById('forgot-pw-email');
    var submit   = document.getElementById('forgot-pw-submit');
    var result   = document.getElementById('forgot-pw-result');

    if (!toggle || !form) return;

    toggle.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();           // keep the dropdown open
        if (result.style.display !== 'none') {
            // Already submitted – toggle resets the whole thing
            result.style.display = 'none';
            result.textContent = '';
            form.style.display = 'none';
            toggle.textContent = 'Forgot password?';
            return;
        }
        var showing = form.style.display !== 'none';
        form.style.display = showing ? 'none' : 'block';
        if (!showing && emailIn) emailIn.focus();
    });

    submit.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var email = (emailIn.value || '').trim();
        if (!email || email.indexOf('@') < 1) {
            emailIn.classList.add('is-invalid');
            return;
        }
        emailIn.classList.remove('is-invalid');
        submit.disabled = true;
        submit.textContent = 'Sending\u2026';

        v4_post('./api/forgot-password.ssjs', { email: email })
            .then(function () {
                form.style.display = 'none';
                result.style.display = 'block';
                result.innerHTML =
                    'If an account matching <strong>' +
                    email.replace(/</g, '&lt;') +
                    '</strong> was found, a recovery email has been sent. ' +
                    'Check your spam or junk folder if you don\u2019t see it.';
                toggle.textContent = 'Done \u2013 tap to reset';
            })
            .catch(function () {
                result.style.display = 'block';
                result.textContent = 'Something went wrong. Please try again later.';
            })
            .finally(function () {
                submit.disabled = false;
                submit.textContent = 'Send Recovery Email';
            });
    });

    // Allow Enter key in the email field
    emailIn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit.click(); }
    });

    // Prevent the dropdown from closing when interacting with the forgot-pw area
    var section = document.getElementById('forgot-password-section');
    if (section) {
        section.addEventListener('click', function (e) { e.stopPropagation(); });
    }
}
