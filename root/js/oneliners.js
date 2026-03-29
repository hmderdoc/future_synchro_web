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

    function visibleLength(text) {
        var i = 0, length = 0;
        while (i < text.length) {
            var ch = text.charCodeAt(i);
            if (ch === 1 && i + 1 < text.length) { i += 2; continue; }
            if (text.charAt(i) === '|' && i + 2 < text.length &&
                text.charAt(i+1) >= '0' && text.charAt(i+1) <= '9' &&
                text.charAt(i+2) >= '0' && text.charAt(i+2) <= '9') { i += 3; continue; }
            if (ch >= 32) length++;
            i++;
        }
        return length;
    }

    function getVisibleLimit() {
        var input = document.getElementById('ol-input');
        if (!input) return 70;
        var limit = parseInt(input.getAttribute('data-visible-limit'), 10);
        return isNaN(limit) || limit < 1 ? 70 : limit;
    }

    /* Render a single oneliner card */
    function renderOneliner(ol, localQwk) {
        var avatarKey = avatarLookupKey(ol, localQwk);

        var html = '<article class="ol-card">';
        html += '<div class="ol-avatar-wrap"><div class="ol-avatar" data-avatar="' + esc(avatarKey) + '"></div></div>';
        html += '<div class="ol-body">';
        html += '<div class="ol-meta">';
        html += '<div class="ol-byline">';
        html += '<strong class="ol-alias">' + esc(ol.alias) + '</strong>';
        if (ol.qwkid) html += '<span class="ol-system">@' + esc(ol.qwkid) + '</span>';
        html += '</div>';
        html += '<time class="ol-time">' + esc(fmtTime(ol.time)) + '</time>';
        html += '</div>';
        html += '<div class="ol-text">' + colorize(ol.oneliner) + '</div>';
        html += '</div></article>';
        return html;
    }

    var _localQwk = '';
    var _feedState = {
        offset: 0,
        batchSize: 20,
        hasMore: true,
        loading: false
    };
    var _scrollBound = false;

    function renderStatusCard(text, tone) {
        var toneClass = tone ? (' ol-card-status-' + tone) : '';
        return '<article class="ol-card ol-card-status' + toneClass + '"><div class="ol-status-text">' + esc(text) + '</div></article>';
    }

    function setFeedStatus(text, tone) {
        var status = document.getElementById('ol-list-status');
        if (!status) return;
        if (!text) {
            status.className = 'ol-feed-status';
            status.textContent = '';
            return;
        }
        status.className = 'ol-feed-status' + (tone ? (' is-' + tone) : '');
        status.textContent = text;
    }

    function getFeedViewport() {
        return document.getElementById('ol-feed-viewport');
    }

    function maybeLoadMoreOneliners() {
        if (_feedState.loading || !_feedState.hasMore) return;
        var viewport = getFeedViewport();
        var sentinel = document.getElementById('ol-feed-sentinel');
        if (!viewport || !sentinel) return;
        var viewportRect = viewport.getBoundingClientRect();
        var sentinelRect = sentinel.getBoundingClientRect();
        if (sentinelRect.top <= viewportRect.bottom + 180) {
            loadOneliners(false);
        }
    }

    function bindInfiniteScroll() {
        if (_scrollBound) return;
        _scrollBound = true;
        var viewport = getFeedViewport();
        if (viewport) {
            viewport.addEventListener('scroll', maybeLoadMoreOneliners, { passive: true });
        }
        window.addEventListener('resize', maybeLoadMoreOneliners);
    }

    /* Load and render batched oneliners */
    function loadOneliners(reset) {
        if (typeof reset === 'undefined') reset = false;
        if (_feedState.loading) return;
        if (!reset && !_feedState.hasMore) return;

        var el = document.getElementById('ol-list');
        if (!el) return;

        if (reset) {
            _feedState.offset = 0;
            _feedState.hasMore = true;
            var viewport = getFeedViewport();
            if (viewport) viewport.scrollTop = 0;
            el.innerHTML = renderStatusCard('Loading one-liners...', 'loading');
            setFeedStatus('', '');
        } else {
            setFeedStatus('Loading more one-liners...', 'loading');
        }

        _feedState.loading = true;

        v4_get('./api/oneliners.ssjs?call=get-oneliners&count=' + _feedState.batchSize + '&offset=' + _feedState.offset).then(function (data) {
            if (!data || data.error) {
                if (reset) {
                    el.innerHTML = renderStatusCard('Error loading oneliners: ' + ((data && data.error) || 'unknown'), 'error');
                }
                setFeedStatus('Error loading oneliners.', 'error');
                return;
            }

            _localQwk = data.qwkid || '';
            var rawList = data.oneliners || [];
            var list = [];
            var html = '';
            var requestOffset = _feedState.offset;

            for (var i = rawList.length - 1; i >= 0; i--) {
                if (!visibleText(rawList[i].oneliner || '')) continue;
                list.push(rawList[i]);
                html += renderOneliner(rawList[i], _localQwk);
            }

            if (reset) {
                el.innerHTML = '';
            }

            if (html) {
                el.insertAdjacentHTML('beforeend', html);
                drawAvatars(el, list);
            }

            var advancedOffset = (typeof data.nextOffset === 'number') ? data.nextOffset : (requestOffset + rawList.length);
            if (advancedOffset <= requestOffset) {
                advancedOffset = requestOffset;
                _feedState.hasMore = false;
            } else {
                _feedState.hasMore = !!data.hasMore;
            }
            _feedState.offset = advancedOffset;

            if (!el.children.length) {
                if (_feedState.hasMore) {
                    setFeedStatus('Loading more one-liners...', 'loading');
                    setTimeout(function () {
                        loadOneliners(false);
                    }, 0);
                    return;
                }
                el.innerHTML = renderStatusCard('No oneliners yet. Be the first!', 'empty');
                setFeedStatus('', '');
                return;
            }

            if (_feedState.hasMore) setFeedStatus('', '');
            else setFeedStatus('You have reached the oldest one-liners.', 'end');

            setTimeout(maybeLoadMoreOneliners, 0);
        }).catch(function () {
            if (reset) {
                el.innerHTML = renderStatusCard('Error loading oneliners.', 'error');
            }
            setFeedStatus('Error loading oneliners.', 'error');
        }).finally(function () {
            _feedState.loading = false;
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

    function updateComposerState() {
        var input = document.getElementById('ol-input');
        var counter = document.getElementById('ol-char-count');
        var limit = getVisibleLimit();
        var visible = 0;
        var hasVisibleText = false;
        var isOver = false;

        updatePreview();

        if (!input) {
            return {
                limit: limit,
                visible: visible,
                hasVisibleText: hasVisibleText,
                isOver: isOver
            };
        }

        visible = visibleLength(input.value || '');
        hasVisibleText = visibleText(input.value || '').length > 0;
        isOver = visible > limit;

        if (counter) {
            counter.textContent = visible + '/' + limit + ' visible';
            counter.classList.toggle('is-over', isOver);
        }

        input.classList.toggle('is-invalid', isOver);

        return {
            limit: limit,
            visible: visible,
            hasVisibleText: hasVisibleText,
            isOver: isOver
        };
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
        updateComposerState();
    }

    /* Init */
    window.initOneliners = function () {
        bindInfiniteScroll();
        loadOneliners(true);

        var refreshBtn = document.getElementById('ol-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', function () {
                loadOneliners(true);
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
        if (input) {
            input.addEventListener('input', updateComposerState);
            updateComposerState();
        }

        var form = document.getElementById('ol-post-form');
        if (form) {
            form.addEventListener('submit', function (e) {
                e.preventDefault();
                var inp = document.getElementById('ol-input');
                var sendBtn = form.querySelector('button[type="submit"]');
                var state = updateComposerState();
                if (!inp || !state.hasVisibleText) return;
                if (state.isOver) {
                    alert('One-liners are limited to ' + state.limit + ' visible characters. Color codes do not count.');
                    return;
                }
                var text = inp.value;
                inp.disabled = true;
                if (sendBtn) sendBtn.disabled = true;
                postOneliner(text).then(function (res) {
                    inp.disabled = false;
                    if (sendBtn) sendBtn.disabled = false;
                    if (res && res.ok) {
                        inp.value = '';
                        updateComposerState();
                        loadOneliners(true);
                    } else {
                        updateComposerState();
                        alert('Error posting: ' + (res && res.error || 'unknown'));
                    }
                }).catch(function () {
                    inp.disabled = false;
                    if (sendBtn) sendBtn.disabled = false;
                    updateComposerState();
                    alert('Error posting: unknown');
                });
            });
        }
    };
})();
