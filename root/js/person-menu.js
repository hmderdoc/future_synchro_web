/* person-menu.js - the context menu behind an avatar or name in web chat
 *
 * Mirrors the terminal chat's person menu:
 *   View profile          when the handle resolves to a local account (through
 *                         the sysop link map, so a DDial nick can qualify)
 *   Private message
 *   Ignore / Stop ignoring   (confirmed; shared with the terminal's ignore list)
 *   Sysop: set / change / clear placeholder avatar (never over a real one),
 *          link to a main name / unlink, mark as not a local user / allow
 *
 * Usage: PersonMenu.open({ name, network, system, avatar, x, y, onPrivate })
 * Data comes from ./api/social.ssjs?call=person; writes go through the same
 * API with the session's CSRF token. `window.PersonMenu.ignored` holds the
 * current ignore list so the chat page can hide those senders.
 */
(function () {
    'use strict';

    var API = './api/social.ssjs';
    var SYSTEM_API = './api/system.ssjs';
    var menuEl = null;
    var pickerEl = null;
    var ignored = [];
    var ignoredLoaded = false;

    function csrf() {
        var meta = document.querySelector('meta[name="csrf-token"]');
        return (window.sbbsConfig && window.sbbsConfig.csrfToken) || (meta ? meta.getAttribute('content') : '') || '';
    }
    function esc(s) {
        return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function get(url) { return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); }); }
    function post(call, body) {
        return fetch(API + '?call=' + call, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() },
            body: JSON.stringify(body || {})
        }).then(function (r) { return r.json(); });
    }
    function injectStyle() {
        if (document.getElementById('person-menu-style')) return;
        var style = document.createElement('style');
        style.id = 'person-menu-style';
        style.textContent =
            '.person-menu{position:fixed;z-index:2100;min-width:220px;max-width:300px;background:#0d1117;color:#ddd;border:1px solid #5555ff;box-shadow:0 8px 24px #000;font-size:13px;font-family:inherit}' +
            '.person-menu-head{padding:7px 10px;border-bottom:1px solid #333;display:flex;align-items:center;gap:8px}' +
            '.person-menu-head .person-menu-avatar{width:40px;height:24px;flex-shrink:0;background:#000}.person-menu-head .person-menu-avatar img{width:40px;height:24px;image-rendering:pixelated;display:block}' +
            '.person-menu-name{font-weight:bold;color:#55ffff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.person-menu-sub{font-size:11px;color:#888}' +
            '.person-menu-item{display:block;width:100%;text-align:left;background:none;border:none;color:#ddd;padding:7px 10px;cursor:pointer;font:inherit}' +
            '.person-menu-item:hover{background:#1a1a3a;color:#fff}.person-menu-item.is-danger{color:#ff5555}.person-menu-item.is-sysop{color:#ffff55}' +
            '.person-menu-sep{border-top:1px solid #333;margin:2px 0}.person-menu-note{padding:5px 10px;font-size:11px;color:#888}' +
            '.person-picker{position:fixed;inset:0;z-index:2200;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center}' +
            '.person-picker-card{background:#0d1117;border:1px solid #5555ff;color:#ddd;width:min(720px,95vw);max-height:90vh;display:flex;flex-direction:column}' +
            '.person-picker-head{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid #333}' +
            '.person-picker-head select{font:inherit;background:#000;color:#ddd;border:1px solid #555}' +
            '.person-picker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;padding:12px;overflow:auto}' +
            '.person-picker-item{background:#000;border:1px solid #333;cursor:pointer;text-align:center;padding:4px;font-size:10px;color:#aaa}' +
            '.person-picker-item:hover{border-color:#ffff55}.person-picker-item img{width:80px;height:48px;image-rendering:pixelated;display:block;margin:0 auto 3px}' +
            '.person-picker-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer}';
        document.head.appendChild(style);
    }

    function close() {
        if (menuEl) { menuEl.remove(); menuEl = null; }
        document.removeEventListener('click', onDocClick, true);
        document.removeEventListener('keydown', onKey);
    }
    function onDocClick(e) { if (menuEl && !menuEl.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') { close(); closePicker(); } }
    function closePicker() { if (pickerEl) { pickerEl.remove(); pickerEl = null; } }

    function place(el, x, y) {
        el.style.left = '0px'; el.style.top = '0px';
        document.body.appendChild(el);
        var w = el.offsetWidth, h = el.offsetHeight;
        var left = Math.min(x, window.innerWidth - w - 8), top = Math.min(y, window.innerHeight - h - 8);
        el.style.left = Math.max(4, left) + 'px';
        el.style.top = Math.max(4, top) + 'px';
    }

    function drawAvatar(container, opts, info) {
        if (opts.avatar && window.GraphicsConverter) {
            try { GraphicsConverter.shared().from_bin(atob(opts.avatar), 10, 6, function (url) { var img = new Image(); img.src = url; container.appendChild(img); }, true); return; } catch (_e) { /* fall through */ }
        }
        if (info.userNumber > 0) {
            var d = document.createElement('div');
            d.setAttribute('data-avatar', String(info.userNumber));
            container.appendChild(d);
            if (window.Avatars && Avatars.draw) Avatars.draw([String(info.userNumber)]);
        }
    }

    /* Rebuild the menu body from fresh server state (after any write). */
    function render(opts, info) {
        var isSelf = info.self;
        var html = '<div class="person-menu-head"><div class="person-menu-avatar"></div><div style="min-width:0">' +
            '<div class="person-menu-name">' + esc(opts.name) + '</div>' +
            '<div class="person-menu-sub">' + esc(opts.network === 'local' ? (opts.system || 'this BBS') : opts.network.toUpperCase() + (opts.system ? ' @ ' + opts.system : '')) +
            (info.alias && info.alias.toLowerCase() !== String(opts.name).toLowerCase() ? ' &middot; ' + esc(info.alias) + ' here' : '') + '</div></div></div>';
        if (info.userNumber > 0) html += '<button type="button" class="person-menu-item" data-act="profile">View ' + (isSelf ? 'my' : esc(info.alias) + "'s") + ' profile</button>';
        if (!isSelf) {
            html += '<button type="button" class="person-menu-item" data-act="pm">Private message</button>';
            // Telegrams are a BBS thing: local accounts only (delivered at their next keypress / logon).
            if (info.userNumber > 0 && window.sbbsConfig && window.sbbsConfig.isLoggedIn && typeof window.sendTelegram === 'function') {
                html += '<button type="button" class="person-menu-item" data-act="telegram">Send telegram</button>';
            }
            if (info.userNumber > 0 && window.sbbsConfig && window.sbbsConfig.isLoggedIn) {
                var rel = info.relation;
                html += '<button type="button" class="person-menu-item" data-act="friend">' +
                    (rel === 'friends' ? 'Remove from Friends' : rel === 'incoming' ? 'Accept friend request' : rel === 'outgoing' ? 'Withdraw friend request' : 'Add to Friends') + '</button>';
            }
            if (window.sbbsConfig && window.sbbsConfig.isLoggedIn) {
                html += '<button type="button" class="person-menu-item is-danger" data-act="ignore">' + (info.ignored ? 'Stop ignoring ' + esc(opts.name) : 'Ignore ' + esc(opts.name)) + '</button>';
            }
        }
        if (info.sysop) {
            html += '<div class="person-menu-sep"></div>';
            if (info.avatarKind === 'real') html += '<div class="person-menu-note">Has their own avatar: no override offered.</div>';
            else html += '<button type="button" class="person-menu-item is-sysop" data-act="avatar">' + (info.avatarKind === 'placeholder' ? 'Change' : 'Set') + ' placeholder avatar (sysop)</button>';
            if (info.avatarKind === 'placeholder') html += '<button type="button" class="person-menu-item is-sysop" data-act="avatar-clear">Clear placeholder avatar (sysop)</button>';
            html += info.linkedTo
                ? '<button type="button" class="person-menu-item is-sysop" data-act="unlink">Unlink from "' + esc(info.linkedTo) + '" (sysop)</button>'
                : '<button type="button" class="person-menu-item is-sysop" data-act="link">Link to their main name... (sysop)</button>';
            html += '<button type="button" class="person-menu-item is-sysop" data-act="' + (info.notLocal ? 'unnotlocal' : 'notlocal') + '">' +
                (info.notLocal ? 'Allow auto-match to a local user again (sysop)' : 'Mark as NOT a local user (sysop)') + '</button>';
        }
        menuEl.innerHTML = html;
        drawAvatar(menuEl.querySelector('.person-menu-avatar'), opts, info);
    }

    function open(opts) {
        injectStyle();
        close();
        opts = opts || {};
        opts.network = String(opts.network || 'local').toLowerCase() || 'local';
        if (!opts.name) return;
        menuEl = document.createElement('div');
        menuEl.className = 'person-menu';
        menuEl.innerHTML = '<div class="person-menu-note">Looking up ' + esc(opts.name) + '...</div>';
        place(menuEl, opts.x || 20, opts.y || 20);
        document.addEventListener('click', onDocClick, true);
        document.addEventListener('keydown', onKey);
        var state = null;
        function refresh() {
            return get(API + '?call=person&name=' + encodeURIComponent(opts.name) + '&network=' + encodeURIComponent(opts.network))
                .then(function (info) {
                    if (!menuEl || !info.ok) { close(); return; }
                    state = info;
                    render(opts, info);
                    place(menuEl, opts.x || 20, opts.y || 20);
                }).catch(close);
        }
        menuEl.addEventListener('click', function (e) {
            var b = e.target.closest('[data-act]');
            if (!b || !state) return;
            e.preventDefault();
            var act = b.getAttribute('data-act');
            if (act === 'profile') { close(); navigate('./?page=013-profile.xjs&user=' + encodeURIComponent(state.alias)); return; }
            if (act === 'pm') { close(); (typeof opts.onPrivate === 'function' ? opts.onPrivate : defaultPrivate)(opts); return; }
            if (act === 'telegram') { close(); window.sendTelegram(state.alias); return; }
            if (act === 'friend') {
                var action = state.relation === 'friends' ? 'unfriend' : state.relation === 'incoming' ? 'accept' : state.relation === 'outgoing' ? 'cancel' : 'request';
                post('friend', { user: state.alias, action: action }).then(refresh);
                return;
            }
            if (act === 'ignore') {
                var on = !state.ignored;
                if (on && !window.confirm('Ignore ' + opts.name + ' on ' + (opts.network === 'local' ? 'this BBS' : opts.network.toUpperCase()) + '? Their messages will be hidden here and on the terminal.')) return;
                post('ignore', { name: opts.name, network: opts.network, on: on }).then(function () { loadIgnored(true); refresh(); });
                return;
            }
            if (act === 'avatar') { openPicker(opts, refresh); return; }
            if (act === 'avatar-clear') { post('placeholder', { name: opts.name, action: 'clear' }).then(function () { refresh(); redrawAvatars(); }); return; }
            if (act === 'link') {
                var main = window.prompt('Main name for ' + opts.name + ' (the name they use here or elsewhere):', state.linkedTo || '');
                if (!main) return;
                post('placeholder', { name: opts.name, action: 'link', main: main }).then(function () { refresh(); redrawAvatars(); });
                return;
            }
            if (act === 'unlink' || act === 'notlocal' || act === 'unnotlocal') {
                post('placeholder', { name: opts.name, action: act }).then(function () { refresh(); redrawAvatars(); });
            }
        });
        refresh();
    }

    function navigate(href) {
        var link = document.createElement('a');
        link.href = href;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    /* After an override changes, avatars drawn from the old resolution are stale. */
    function redrawAvatars() {
        document.dispatchEvent(new CustomEvent('person-menu:avatars-changed'));
    }

    /* Sysop: pick a placeholder from the stock collections (text/avatars/*.bin). */
    function openPicker(opts, done) {
        closePicker();
        injectStyle();
        pickerEl = document.createElement('div');
        pickerEl.className = 'person-picker';
        pickerEl.innerHTML = '<div class="person-picker-card"><div class="person-picker-head"><strong>Placeholder avatar for ' + esc(opts.name) + '</strong>' +
            '<span><select class="person-picker-collection"></select> <button type="button" class="person-picker-close">&times;</button></span></div>' +
            '<div class="person-picker-grid"><div style="padding:12px;color:#888">Loading collections...</div></div></div>';
        document.body.appendChild(pickerEl);
        pickerEl.addEventListener('click', function (e) { if (e.target === pickerEl || e.target.closest('.person-picker-close')) closePicker(); });
        var select = pickerEl.querySelector('.person-picker-collection');
        var grid = pickerEl.querySelector('.person-picker-grid');
        function showCollection(id) {
            grid.innerHTML = '<div style="padding:12px;color:#888">Loading...</div>';
            get(SYSTEM_API + '?call=avatar-collection&collection=' + encodeURIComponent(id)).then(function (coll) {
                if (!coll || !coll.avatars) { grid.innerHTML = '<div style="padding:12px;color:#f55">Could not read that collection.</div>'; return; }
                grid.innerHTML = '';
                var gc = window.GraphicsConverter ? GraphicsConverter.shared() : null;
                coll.avatars.forEach(function (av) {
                    var item = document.createElement('div');
                    item.className = 'person-picker-item';
                    item.title = av.label || '';
                    item.innerHTML = '<div class="person-picker-art"></div>' + esc(av.label || ('#' + (av.index + 1)));
                    if (gc) gc.from_bin(atob(av.data), 10, 6, function (url) { var img = new Image(); img.src = url; item.querySelector('.person-picker-art').appendChild(img); }, true);
                    item.addEventListener('click', function () {
                        post('placeholder', { name: opts.name, action: 'set', collection: id, index: av.index }).then(function (res) {
                            closePicker();
                            if (res && res.ok) { redrawAvatars(); if (done) done(); }
                            else window.alert('Could not set that placeholder' + (res && res.error ? ': ' + res.error : ''));
                        });
                    });
                    grid.appendChild(item);
                });
            });
        }
        get(SYSTEM_API + '?call=avatar-settings-init').then(function (init) {
            var list = (init && init.collections) || [];
            if (!list.length) { grid.innerHTML = '<div style="padding:12px;color:#888">No avatar collections in text/avatars.</div>'; return; }
            list.forEach(function (c) {
                var opt = document.createElement('option');
                opt.value = c.id || c.file || c.name;
                opt.textContent = (c.title || c.name || c.id) + (c.count ? ' (' + c.count + ')' : '');
                select.appendChild(opt);
            });
            select.onchange = function () { showCollection(select.value); };
            showCollection(select.value);
        });
    }

    /* Ignore list (mine), cached; `force` re-reads after a change. */
    function loadIgnored(force) {
        if (ignoredLoaded && !force) return Promise.resolve(ignored);
        if (!(window.sbbsConfig && window.sbbsConfig.isLoggedIn)) { ignoredLoaded = true; ignored = []; return Promise.resolve(ignored); }
        return get(API + '?call=ignored').then(function (res) {
            ignored = (res && res.ignored) || [];
            ignoredLoaded = true;
            window.PersonMenu.ignored = ignored;
            document.dispatchEvent(new CustomEvent('person-menu:ignored-changed'));
            return ignored;
        }).catch(function () { ignoredLoaded = true; return ignored; });
    }
    function isIgnored(name, network) {
        var key = String(name || '').toLowerCase().replace(/^\s+|\s+$/g, '');
        var net = String(network || 'local').toLowerCase() || 'local';
        for (var i = 0; i < ignored.length; i++) {
            if (ignored[i].handle === key && (!ignored[i].network || ignored[i].network === net)) return true;
        }
        return false;
    }

    /* Outside chat, "Private message" lands in the chat page's private thread. */
    function defaultPrivate(opts) {
        var href = './?page=001-chat.xjs&private=' + encodeURIComponent(opts.name);
        if (opts.system) href += '&system=' + encodeURIComponent(opts.system);
        if (opts.network && opts.network !== 'local') href += '&bridge=' + encodeURIComponent(opts.network);
        navigate(href);
    }

    /* Site-wide: any drawn avatar (div[data-avatar="<alias|number>"], as
       Avatars.draw fills them) opens the menu. Chat's own actor buttons stop
       propagation before this runs, so its richer wiring still wins there.
       Oneliners key remote people as "alias@QWKID"; the QWK id rides along as
       the system name and the alias is what gets resolved. */
    document.addEventListener('click', function (e) {
        var el = e.target.closest('[data-avatar]');
        if (!el) return;
        var raw = String(el.getAttribute('data-avatar') || '').replace(/^\s+|\s+$/g, '');
        if (!raw.length || el.closest('.person-menu, .person-picker')) return;
        var name = raw, system = '';
        var at = raw.indexOf('@');
        if (at > 0) { name = raw.substring(0, at); system = raw.substring(at + 1); }
        e.preventDefault();
        e.stopPropagation();
        open({ name: name, system: system, network: 'local', x: e.clientX, y: e.clientY, onPrivate: defaultPrivate });
    });
    (function () {
        var style = document.createElement('style');
        style.textContent = '[data-avatar]:not(:empty){cursor:pointer}';
        document.head.appendChild(style);
    })();

    window.PersonMenu = { open: open, close: close, loadIgnored: loadIgnored, isIgnored: isIgnored, ignored: ignored };
})();
