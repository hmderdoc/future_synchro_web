/* Chat handle settings card: per-letter colours + tag over api/chat-style.ssjs.
   Mirrors the helpers in mods/load/chat_style_lib.js (presets, nearest CGA)
   so the previews show what each place will paint. */
(function () {
    'use strict';
    var CGA = [
        [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170],
        [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
        [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255],
        [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255]
    ];

    function hex(v) {
        var s = String(v || '').trim().toLowerCase();
        if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
        return /^#[0-9a-f]{6}$/.test(s) ? s : '';
    }
    function rgb(h) { h = hex(h); return h ? { r: parseInt(h.substr(1, 2), 16), g: parseInt(h.substr(3, 2), 16), b: parseInt(h.substr(5, 2), 16) } : null; }
    function toHex(r, g, b) {
        function two(v) { var s = Math.max(0, Math.min(255, Math.round(v))).toString(16); return s.length < 2 ? '0' + s : s; }
        return '#' + two(r) + two(g) + two(b);
    }
    function nearestCga(h) {
        var c = rgb(h), best = -1, bestD = -1, i, d;
        if (!c) return -1;
        for (i = 0; i < 16; i++) {
            d = Math.pow(c.r - CGA[i][0], 2) + Math.pow(c.g - CGA[i][1], 2) + Math.pow(c.b - CGA[i][2], 2);
            if (bestD < 0 || d < bestD) { bestD = d; best = i; }
        }
        return best;
    }
    function cgaHex(i) { if (i === 0) i = 8; return toHex(CGA[i][0], CGA[i][1], CGA[i][2]); }
    function hsv(h, s, v) {
        var c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c, r = 0, g = 0, b = 0;
        if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; } else if (h < 180) { g = c; b = x; }
        else if (h < 240) { g = x; b = c; } else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
        return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
    }
    function preset(kind, n, a, b) {
        var out = [], i, t, ca, cb;
        if (kind === 'solid') { for (i = 0; i < n; i++) out.push(hex(a)); return out; }
        if (kind === 'gradient') {
            ca = rgb(a); cb = rgb(b);
            if (!ca || !cb) return preset('solid', n, a || b);
            for (i = 0; i < n; i++) { t = n > 1 ? i / (n - 1) : 0; out.push(toHex(ca.r + (cb.r - ca.r) * t, ca.g + (cb.g - ca.g) * t, ca.b + (cb.b - ca.b) * t)); }
            return out;
        }
        if (kind === 'rainbow') { for (i = 0; i < n; i++) out.push(hsv((i / Math.max(1, n)) * 360, 0.85, 1)); return out; }
        for (i = 0; i < n; i++) out.push('');
        return out;
    }
    function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
    function csrf() { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.getAttribute('content') || '' : ''; }

    function init(root) {
        var alias = root.getAttribute('data-alias') || '';
        var letters = root.querySelector('[data-letters]');
        var status = root.querySelector('[data-status]');
        var tagText = root.querySelector('[data-tag-text]');
        var tagFg = root.querySelector('[data-tag-fg]');
        var tagBg = root.querySelector('[data-tag-bg]');
        var state = { colors: [], tag: { text: '', fg: '', bg: '' } };
        var tagBgOn = false;
        var active = -1;

        function colorsAligned() {
            var out = [], i;
            for (i = 0; i < alias.length; i++) out.push(state.colors[i] || '');
            return out;
        }
        function renderLetters() {
            var colors = colorsAligned();
            var html = '', i, ch;
            for (i = 0; i < alias.length; i++) {
                ch = alias.charAt(i);
                html += '<button type="button" class="chat-style-letter' + (ch === ' ' ? ' is-space' : '') + (i === active ? ' is-active' : '') + '" data-index="' + i + '"'
                    + (colors[i] ? ' style="color:' + colors[i] + '"' : '') + ' title="' + (colors[i] || 'default') + '">'
                    + (ch === ' ' ? '&middot;' : esc(ch))
                    + '<input type="color" value="' + (colors[i] || '#ffffff') + '" aria-label="colour of letter ' + (i + 1) + '"></button>';
            }
            letters.innerHTML = html;
        }
        function tagHtml(quantise) {
            if (!state.tag.text) return '';
            var fg = state.tag.fg, bg = state.tag.bg;
            if (quantise) { fg = fg ? cgaHex(nearestCga(fg)) : ''; bg = bg ? cgaHex(nearestCga(bg) & 7) : ''; }
            return '<span class="cs-tag" style="' + (fg ? 'color:' + fg + ';border-color:' + fg + ';' : '') + (bg ? 'background:' + bg + ';' : '') + '">' + esc(state.tag.text) + '</span>';
        }
        function nameHtml(quantise, fallback) {
            var colors = colorsAligned(), html = '', i, c;
            for (i = 0; i < alias.length; i++) {
                c = colors[i];
                if (quantise && c) c = cgaHex(nearestCga(c));
                html += '<span style="color:' + (c || fallback) + '">' + esc(alias.charAt(i)) + '</span>';
            }
            return html;
        }
        function renderPreviews() {
            root.querySelector('[data-preview="true"]').innerHTML = '<span class="cs-name">' + nameHtml(false, '#55ffff') + '</span>' + tagHtml(false) + ' <span style="color:#aaa">hello there</span>';
            root.querySelector('[data-preview="cga"]').innerHTML = '<span style="color:#00aaaa">&lt;</span><span class="cs-name">' + nameHtml(true, '#ffffff') + '</span><span style="color:#ff5555">[</span><span style="color:#fff">FL</span><span style="color:#ff5555">]</span>' + tagHtml(true) + '<span style="color:#00aaaa">&gt;</span> <span style="color:#aaa">hello there</span>';
            root.querySelector('[data-preview="profile"]').innerHTML = '<span class="cs-name" style="font-size:1.3em">' + nameHtml(false, '#ffffff') + '</span>' + tagHtml(false);
        }
        function render() { renderLetters(); renderPreviews(); }
        function setStatus(text, ok) { status.textContent = text; status.style.color = ok === false ? '#ff5555' : '#55ff55'; }
        function readTag() {
            state.tag.text = (tagText.value || '').replace(/[^\x20-\x7e]/g, '').replace(/\|/g, '').trim().substr(0, 12);
            state.tag.fg = state.tag.text ? hex(tagFg.value) : '';
            state.tag.bg = state.tag.text && tagBgOn ? hex(tagBg.value) : '';
        }

        letters.addEventListener('click', function (e) {
            var btn = e.target.closest('.chat-style-letter');
            if (!btn) return;
            active = parseInt(btn.getAttribute('data-index'), 10);
            renderLetters();
        });
        letters.addEventListener('input', function (e) {
            var input = e.target.closest('input[type=color]');
            var btn = input ? input.closest('.chat-style-letter') : null;
            if (!btn) return;
            var i = parseInt(btn.getAttribute('data-index'), 10);
            var colors = colorsAligned();
            colors[i] = hex(input.value);
            state.colors = colors;
            active = i;
            btn.style.color = colors[i];
            renderPreviews();
        });
        letters.addEventListener('contextmenu', function (e) {
            var btn = e.target.closest('.chat-style-letter');
            if (!btn) return;
            e.preventDefault();
            var colors = colorsAligned();
            colors[parseInt(btn.getAttribute('data-index'), 10)] = '';
            state.colors = colors;
            render();
        });
        Array.prototype.forEach.call(root.querySelectorAll('[data-preset]'), function (b) {
            b.addEventListener('click', function () {
                var kind = b.getAttribute('data-preset');
                state.colors = preset(kind, alias.length, root.querySelector('[data-solid]').value, '');
                if (kind === 'gradient') state.colors = preset('gradient', alias.length, root.querySelector('[data-grad-a]').value, root.querySelector('[data-grad-b]').value);
                render();
            });
        });
        tagText.addEventListener('input', function () { readTag(); renderPreviews(); });
        tagFg.addEventListener('input', function () { readTag(); renderPreviews(); });
        tagBg.addEventListener('input', function () { tagBgOn = true; readTag(); renderPreviews(); });
        root.querySelector('[data-tag-clear]').addEventListener('click', function () { tagText.value = ''; tagBgOn = false; readTag(); renderPreviews(); });
        root.querySelector('[data-save]').addEventListener('click', function () {
            readTag();
            var colors = colorsAligned();
            while (colors.length && !colors[colors.length - 1]) colors.pop();
            setStatus('Saving...');
            fetch('./api/chat-style.ssjs?call=save', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrf() },
                body: JSON.stringify({ colors: colors, tag: state.tag })
            }).then(function (r) { return r.json(); }).then(function (res) {
                if (!res.ok) { setStatus(res.error || 'Could not save', false); return; }
                setStatus('Saved. Your name now shows this way in chat, on DDial, in your MRC alias and on your profile.');
            }).catch(function () { setStatus('Could not save', false); });
        });

        fetch('./api/chat-style.ssjs?call=get', { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (res) {
                if (!res.ok) { setStatus(res.error || 'Could not load', false); render(); return; }
                state.colors = res.style.colors || [];
                state.tag = res.style.tag || { text: '', fg: '', bg: '' };
                tagText.value = state.tag.text || '';
                if (state.tag.fg) tagFg.value = state.tag.fg;
                if (state.tag.bg) { tagBg.value = state.tag.bg; tagBgOn = true; }
                render();
            })
            .catch(function () { setStatus('Could not load', false); render(); });
    }

    function boot() {
        Array.prototype.forEach.call(document.querySelectorAll('[data-chat-style-settings]'), function (root) {
            if (root.getAttribute('data-chat-style-ready')) return;
            root.setAttribute('data-chat-style-ready', '1');
            init(root);
        });
    }
    window.initChatStyleSettings = boot;
    boot();
})();
