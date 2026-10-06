/* notifications.js - the Notifications page (pages/015-notifications.xjs).
 * Lists api/notifications.ssjs entries newest first; opening one marks it
 * read and goes to the message. Read entries stay under History.
 */
(function () {
    'use strict';

    var PAGE = 30;
    var state = { filter: 'all', offset: 0, total: 0, loading: false };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function ago(t) {
        var s = Math.max(0, Math.floor(Date.now() / 1000) - t);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
        return new Date(t * 1000).toLocaleDateString();
    }

    var VERBS = {
        reply: 'replied to your message',
        to_you: 'posted to you in',
        mail: 'sent you mail'
    };
    var CYCLE_MS = 2600;
    var cycleTimer = 0;

    function rowHtml(e) {
        var subject = e.subject.replace(/^(re:\s*)+/i, '');
        var what = e.type === 'to_you'
            ? VERBS.to_you + ' <span class="nf-subject">&ldquo;' + esc(subject) + '&rdquo;</span>'
            : (VERBS[e.type] || 'notified you about') + ' <span class="nf-subject">&ldquo;' + esc(subject) + '&rdquo;</span>';
        /* The thumbnail cycles through what the entry is about: network and
           board icons and the poster's avatar (forum), the mailbox and the
           sender (mail). Drawn after insert (drawThumbs). */
        var images = Array.isArray(e.images) ? e.images : [];
        var avatar = images.length
            ? '<div class="nf-avatar nf-thumb" data-thumbs="' + esc(JSON.stringify(images)) + '"></div>'
            : '<div class="nf-avatar nf-avatar-net" title="Network user"><span class="bin-icon" data-icon="comment"></span></div>';
        var tag = e.href ? 'a' : 'div';
        return '<' + tag + ' class="nf-row' + (e.read ? '' : ' nf-unread') + (e.href ? '' : ' nf-gone') + '"'
            + (e.href ? ' href="' + esc(e.href) + '"' : ' title="This message is no longer available"')
            + ' data-id="' + esc(e.id) + '">'
            + avatar
            + '<div class="nf-body">'
            + '<div class="nf-line"><span class="nf-actor">' + esc(e.actor) + '</span> ' + what + '</div>'
            + (e.snippet ? '<div class="nf-snippet">' + esc(e.snippet) + '</div>' : '')
            + '<div class="nf-meta">' + (e.grp ? esc(e.grp) + ' &middot; ' : '') + esc(e.area) + ' &middot; '
            + '<time title="' + esc(new Date(e.t * 1000).toLocaleString()) + '">' + ago(e.t) + '</time></div>'
            + '</div>'
            + (e.read ? '' : '<span class="nf-dot" aria-label="unread"></span>')
            + '</' + tag + '>';
    }

    /* Draw each thumbnail's images (CP437 .bin -> PNG) stacked in its box. */
    function drawThumbs(root) {
        if (typeof GraphicsConverter === 'undefined') return;
        Array.prototype.forEach.call(root.querySelectorAll('.nf-thumb[data-thumbs]'), function (box) {
            var images;
            try { images = JSON.parse(box.getAttribute('data-thumbs')); } catch (_e) { images = []; }
            box.removeAttribute('data-thumbs');
            images.forEach(function (im, i) {
                var img = document.createElement('img');
                img.alt = '';
                img.className = 'nf-thumb-' + im.kind + (i === 0 ? ' is-on' : '');
                img.title = im.kind === 'network' ? 'Network' : im.kind === 'board' ? 'Forum' : im.kind === 'type' ? 'Email' : 'Sender';
                box.appendChild(img);
                try {
                    GraphicsConverter.shared().from_bin(atob(im.bin), im.cols || 10, im.rows || 6, function (url) {
                        if (url) img.src = url; else img.remove();
                    }, true);
                } catch (_err) { img.remove(); }
            });
        });
    }

    /* Step every multi-image thumbnail to its next image, staggered down the list. */
    function cycleThumbs() {
        var list = document.getElementById('nf-list');
        if (!list || !list.isConnected) { clearInterval(cycleTimer); cycleTimer = 0; return; }
        if (document.hidden) return;
        Array.prototype.forEach.call(list.querySelectorAll('.nf-thumb'), function (box, row) {
            var imgs = box.querySelectorAll('img');
            if (imgs.length < 2) return;
            setTimeout(function () {
                var at = 0;
                for (var i = 0; i < imgs.length; i++) if (imgs[i].classList.contains('is-on')) at = i;
                imgs[at].classList.remove('is-on');
                imgs[(at + 1) % imgs.length].classList.add('is-on');
            }, (row % 8) * 150);
        });
    }

    function setStatus(list, text) {
        list.innerHTML = '<div class="nf-status">' + esc(text) + '</div>';
    }

    function load(reset) {
        var list = document.getElementById('nf-list');
        var more = document.getElementById('nf-more');
        if (!list || state.loading) return;
        if (reset) { state.offset = 0; setStatus(list, 'Loading...'); }
        state.loading = true;
        fetch('./api/notifications.ssjs?call=list&filter=' + state.filter + '&offset=' + state.offset + '&limit=' + PAGE,
            { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res || !res.ok) throw new Error(res && res.error || 'failed');
                if (reset) list.innerHTML = '';
                if (!res.entries.length && reset) {
                    setStatus(list, state.filter === 'unread' ? 'You’re all caught up.'
                        : state.filter === 'read' ? 'Nothing read yet.' : 'No notifications yet.');
                }
                list.insertAdjacentHTML('beforeend', res.entries.map(rowHtml).join(''));
                state.offset += res.entries.length;
                state.total = res.total;
                if (more) more.hidden = state.offset >= res.total;
                if (window.setNotificationBadge) window.setNotificationBadge(res.unread);
                drawThumbs(list);
                if (!cycleTimer) cycleTimer = setInterval(cycleThumbs, CYCLE_MS);
                if (window.renderAllBinIcons) window.renderAllBinIcons(list);
            })
            .catch(function () { if (reset) setStatus(list, 'Couldn’t load notifications.'); })
            .then(function () { state.loading = false; });
    }

    function markRead(body) {
        return fetch('./api/notifications.ssjs?call=mark-read', {
            method: 'POST',
            credentials: 'same-origin',
            keepalive: true,
            headers: { 'Content-Type': 'application/json', 'x-csrf-token': (window.sbbsConfig && sbbsConfig.csrfToken) || '' },
            body: JSON.stringify(body)
        }).then(function (r) { return r.json(); }).then(function (res) {
            if (res && res.ok && window.setNotificationBadge) window.setNotificationBadge(res.unread);
            return res;
        });
    }

    window.initNotifications = function () {
        var list = document.getElementById('nf-list');
        if (!list || list.getAttribute('data-ready')) return;
        list.setAttribute('data-ready', '1');
        state.filter = 'all';

        document.getElementById('nf-tabs').addEventListener('click', function (ev) {
            var btn = ev.target.closest('[data-filter]');
            if (!btn) return;
            this.querySelectorAll('[data-filter]').forEach(function (b) { b.classList.toggle('active', b === btn); });
            state.filter = btn.getAttribute('data-filter');
            load(true);
        });

        document.getElementById('nf-mark-all').addEventListener('click', function () {
            markRead({ all: true }).then(function () { load(true); });
        });

        document.getElementById('nf-more').addEventListener('click', function () { load(false); });

        /* Opening an entry marks it read; the link itself navigates. */
        list.addEventListener('click', function (ev) {
            var row = ev.target.closest('.nf-row');
            if (!row || !row.classList.contains('nf-unread')) return;
            row.classList.remove('nf-unread');
            var dot = row.querySelector('.nf-dot');
            if (dot) dot.remove();
            markRead({ ids: [row.getAttribute('data-id')] }).catch(function () { });
        });

        /* A new notification while the page is open: refresh the first page. */
        var onPush = function () { if (state.offset <= PAGE) load(true); };
        window.addEventListener('fl:notifications', onPush);
        window.addEventListener('spa:beforeNavigate', function off() {
            window.removeEventListener('fl:notifications', onPush);
            window.removeEventListener('spa:beforeNavigate', off);
        });

        load(true);
    };
})();
