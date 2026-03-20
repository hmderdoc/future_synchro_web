/* oneliners.js - One-Liners web client
 * Renders CTRL-A / pipe color codes to HTML, shows cross-BBS avatars,
 * and provides a color-picker toolbar for posting.
 */

(function () {
    'use strict';

    /* CGA palette (matches Synchronet standard 16 colours) */
    var CGA = [
        '#000000', '#0000aa', '#00aa00', '#00aaaa',
        '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
        '#555555', '#5555ff', '#55ff55', '#55ffff',
        '#ff5555', '#ff55ff', '#ffff55', '#ffffff'
    ];

    /* CTRL-A letter -> foreground index */
    var CTRLA_FG = {
        'K': 0, 'B': 1, 'G': 2, 'C': 3, 'R': 4, 'M': 5, 'Y': 6, 'W': 7
    };
    /* CTRL-A digit -> background index */
    var CTRLA_BG = {
        '0': 0, '1': 4, '2': 2, '3': 6, '4': 1, '5': 5, '6': 3, '7': 7
    };

    /* Convert oneliner text (with CTRL-A / pipe codes) to HTML */
    function colorize(text) {
        var fg = 7, bg = -1, bold = false;
        var out = '', spanOpen = false, i = 0;

        function openSpan() {
            var fgIdx = bold ? (fg | 8) : fg;
            var style = 'color:' + CGA[fgIdx];
            if (bg >= 0) style += ';background:' + CGA[bg];
            out += '<span style="' + style + '">';
            spanOpen = true;
        }
        function closeSpan() {
            if (spanOpen) { out += '</span>'; spanOpen = false; }
        }
        function resetAttr() {
            closeSpan(); fg = 7; bg = -1; bold = false;
        }

        while (i < text.length) {
            var ch = text.charCodeAt(i);

            // CTRL-A code: \x01 followed by a letter/digit
            if (ch === 1 && i + 1 < text.length) {
                var code = text.charAt(i + 1);
                var upper = code.toUpperCase();
                i += 2;
                if (upper === 'N' || upper === '-' || upper === '_') {
                    resetAttr();
                } else if (upper === 'H') {
                    closeSpan(); bold = true;
                } else if (upper === 'I') {
                    // blink - ignore for HTML
                } else if (CTRLA_FG.hasOwnProperty(upper)) {
                    closeSpan();
                    fg = CTRLA_FG[upper];
                    if (code >= 'a' && code <= 'z') bold = true;
                    openSpan();
                } else if (CTRLA_BG.hasOwnProperty(code)) {
                    closeSpan(); bg = CTRLA_BG[code]; openSpan();
                }
                continue;
            }

            // Pipe code: | followed by two digits (00-31)
            if (text.charAt(i) === '|' && i + 2 < text.length &&
                text.charAt(i+1) >= '0' && text.charAt(i+1) <= '9' &&
                text.charAt(i+2) >= '0' && text.charAt(i+2) <= '9') {
                var pipeVal = parseInt(text.substring(i+1, i+3), 10);
                i += 3;
                if (pipeVal <= 15) {
                    closeSpan(); fg = pipeVal & 7; bold = !!(pipeVal & 8); openSpan();
                } else if (pipeVal >= 16 && pipeVal <= 23) {
                    closeSpan(); bg = pipeVal - 16; openSpan();
                }
                continue;
            }

            // Normal character
            if (!spanOpen && (fg !== 7 || bg >= 0 || bold)) openSpan();
            if (ch === 60) out += '&lt;';
            else if (ch === 62) out += '&gt;';
            else if (ch === 38) out += '&amp;';
            else if (ch === 34) out += '&quot;';
            else out += text.charAt(i);
            i++;
        }
        closeSpan();
        return out;
    }

    /* Escape HTML */
    function esc(str) {
        var d = document.createElement('div');
        d.appendChild(document.createTextNode(str));
        return d.innerHTML;
    }

    /* Time formatting */
    function fmtTime(unix) {
        if (!unix) return '';
        var d = new Date(unix * 1000);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
            ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    function avatarLookupKey(ol, localQwk) {
        var qwkid = ol.qwkid || '';
        var isLocal = qwkid && qwkid.toLowerCase() === (localQwk || '').toLowerCase();
        return isLocal ? ol.alias : (ol.alias + '@' + qwkid.toUpperCase());
    }

    /* Strip CTRL-A codes, pipe codes, and control chars; return only visible text */
    function visibleText(text) {
        var i = 0, out = '';
        while (i < text.length) {
            var ch = text.charCodeAt(i);
            if (ch === 1 && i + 1 < text.length) { i += 2; continue; }
            if (text.charAt(i) === '|' && i + 2 < text.length &&
                text.charAt(i+1) >= '0' && text.charAt(i+1) <= '9' &&
                text.charAt(i+2) >= '0' && text.charAt(i+2) <= '9') { i += 3; continue; }
            if (ch >= 32) out += text.charAt(i);
            i++;
        }
        return out.trim();
    }

    /* Render a single oneliner row */
    function renderOneliner(ol, localQwk) {
        var avatarKey = avatarLookupKey(ol, localQwk);

        var html = '<div class="ol-row">';
        html += '<div class="ol-avatar" data-avatar="' + esc(avatarKey) + '"></div>';
        html += '<div class="ol-body">';
        html += '<div class="ol-meta">';
        html += '<strong class="ol-alias">' + esc(ol.alias) + '</strong>';
        html += '<span class="ol-system">@' + esc(ol.qwkid) + '</span>';
        html += '<span class="ol-time">' + fmtTime(ol.time) + '</span>';
        html += '</div>';
        html += '<div class="ol-text">' + colorize(ol.oneliner) + '</div>';
        html += '</div></div>';
        return html;
    }

    /* Load and render all oneliners */
    var _localQwk = '';

    function loadOneliners() {
        v4_get('./api/oneliners.ssjs?call=get-oneliners&count=50').then(function (data) {
            if (!data || data.error) {
                var el = document.getElementById('ol-list');
                if (el) el.innerHTML = '<div class="text-danger p-3">Error loading oneliners: ' + (data && data.error || 'unknown') + '</div>';
                return;
            }
            _localQwk = data.qwkid || '';
            var list = data.oneliners || [];
            var el = document.getElementById('ol-list');
            if (!el) return;

            if (!list.length) {
                el.innerHTML = '<div class="text-muted p-3">No oneliners yet. Be the first!</div>';
                return;
            }

            var html = '';
            for (var i = list.length - 1; i >= 0; i--) {
                if (!visibleText(list[i].oneliner || '')) continue;
                html += renderOneliner(list[i], _localQwk);
            }
            el.innerHTML = html;
            el.scrollTop = 0;
            drawAvatars(el, list);
        });
    }

    function drawAvatars(container, list) {
        if (typeof Avatars === 'undefined' || !Avatars.draw) return;
        var keys = [];
        for (var i = 0; i < list.length; i++) {
            var ol = list[i];
            var key = avatarLookupKey(ol, _localQwk);
            if (keys.indexOf(key) < 0) keys.push(key);
        }
        if (keys.length) Avatars.draw(keys);
    }

    /* Post a new oneliner */
    function postOneliner(text) {
        return v4_post('./api/oneliners.ssjs?call=post-oneliner', { oneliner: text });
    }

    /* Preview the input with colour rendering */
    function updatePreview() {
        var input = document.getElementById('ol-input');
        var preview = document.getElementById('ol-preview');
        var previewText = document.getElementById('ol-preview-text');
        if (!input || !preview || !previewText) return;
        var val = input.value;
        if (!val) { preview.style.display = 'none'; return; }
        previewText.innerHTML = colorize(val);
        preview.style.display = '';
    }

    /* Insert color code at cursor in the input */
    function insertColorCode(code) {
        var input = document.getElementById('ol-input');
        if (!input) return;
        var start = input.selectionStart;
        var end = input.selectionEnd;
        var val = input.value;
        var insert = '\x01' + code;
        input.value = val.substring(0, start) + insert + val.substring(end);
        input.selectionStart = input.selectionEnd = start + insert.length;
        input.focus();
        updatePreview();
    }

    /* Init */
    window.initOneliners = function () {
        var cfg = window.sbbsConfig || {};
        var postCard = document.getElementById('ol-post-card');
        if (postCard && cfg.isLoggedIn) {
            postCard.style.display = '';
        }

        loadOneliners();

        var refreshBtn = document.getElementById('ol-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function () {
                var el = document.getElementById('ol-list');
                if (el) el.innerHTML = '<div class="text-muted p-3">Loading...</div>';
                loadOneliners();
            });
        }

        // Color toolbar
        var colorBtns = document.querySelectorAll('.ol-color-btn');
        for (var i = 0; i < colorBtns.length; i++) {
            colorBtns[i].addEventListener('click', function () {
                var code = this.getAttribute('data-code');
                if (!code) return;
                if (code.length === 2 && code.charAt(0) === 'H') {
                    insertColorCode('H');
                    insertColorCode(code.charAt(1));
                } else {
                    insertColorCode(code);
                }
            });
        }

        var input = document.getElementById('ol-input');
        if (input) input.addEventListener('input', updatePreview);

        var form = document.getElementById('ol-post-form');
        if (form) {
            form.addEventListener('submit', function (e) {
                e.preventDefault();
                var inp = document.getElementById('ol-input');
                if (!inp || !inp.value.trim()) return;
                var text = inp.value;
                inp.disabled = true;
                postOneliner(text).then(function (res) {
                    inp.disabled = false;
                    if (res && res.ok) {
                        inp.value = '';
                        updatePreview();
                        loadOneliners();
                    } else {
                        alert('Error posting: ' + (res && res.error || 'unknown'));
                    }
                });
            });
        }


    };
})();
