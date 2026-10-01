/* wiki-tdf.js - TDF art for wiki headings (site feature; xtrn/wiki stays generic).
 *
 * Page view: the title and .wiki-body h1-h4 (wiki #..### render as h2-h4) get one random font per heading
 * level per document view, so all h2s match but differ from the h1.
 * Editor preview: same treatment, but the per-level fonts are kept for the
 * whole editing session and rendered headings are cached, so typing only
 * fetches headings that changed. A color tag in a heading recolors its art
 * toward that color. Headings come from api/tdf-heading.ssjs. */
(function () {
    'use strict';

    var SELECTOR = ':is(h1, h2, h3, h4):not(.tdf-heading)';
    var previewFonts = {};
    var cache = {};

    function key(tag, font, text, color) { return tag + '|' + font + '|' + color + '|' + text; }

    /* A heading's first color tag ({r}, {h}{c}, {#f80} render as a colored
       span) becomes the color the art is shifted toward. */
    function headingColor(h) {
        var span = h.querySelector('[class*="ca-fg-"], [style*="color"]');
        if (!span) return '';
        var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(span).color);
        if (!m) return '';
        return '#' + [m[1], m[2], m[3]].map(function (n) { return ('0' + (+n).toString(16)).slice(-2); }).join('');
    }

    function place(h, html) {
        if (!html || !h.isConnected) return;
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        var el = tmp.firstElementChild;
        if (!el) return;
        if (h.id) el.id = h.id;
        h.replaceWith(el);
    }

    function request(heads, fonts, done) {
        var req = heads.map(function (h) {
            return { tag: h.tagName.toLowerCase(), text: h.textContent.trim(), color: headingColor(h) };
        });
        var url = './api/tdf-heading.ssjs?h=' + encodeURIComponent(JSON.stringify(req));
        if (fonts) url += '&fonts=' + encodeURIComponent(JSON.stringify(fonts));
        fetch(url, { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (data) { done(req, data); })
            .catch(function () { /* plain headings stay */ });
    }

    function collect(list) {
        return list.filter(function (h) { return !h.__tdfQueued && h.textContent.trim(); });
    }

    function convertPage(host) {
        var heads = [];
        var title = host.querySelector(':scope > h1:not(.tdf-heading)');
        if (title) heads.push(title);
        heads = collect(heads.concat(Array.prototype.slice.call(
            host.querySelectorAll('.wiki-body:not(.wiki-preview) ' + SELECTOR))));
        if (!heads.length) return;
        heads.forEach(function (h) { h.__tdfQueued = true; });
        request(heads, null, function (req, data) {
            heads.forEach(function (h, i) { place(h, data.html && data.html[i]); });
            if (window.renderTdfHeadings) renderTdfHeadings(host);
        });
    }

    function convertPreview(preview) {
        var heads = collect(Array.prototype.slice.call(preview.querySelectorAll(SELECTOR)));
        if (!heads.length) return;
        var missing = [];
        heads.forEach(function (h) {
            var tag = h.tagName.toLowerCase();
            var hit = previewFonts[tag] && cache[key(tag, previewFonts[tag], h.textContent.trim(), headingColor(h))];
            if (hit) place(h, hit);
            else { h.__tdfQueued = true; missing.push(h); }
        });
        if (missing.length) {
            request(missing, previewFonts, function (req, data) {
                for (var t in (data.fonts || {})) if (!previewFonts[t]) previewFonts[t] = data.fonts[t];
                missing.forEach(function (h, i) {
                    var html = data.html && data.html[i];
                    if (html) cache[key(req[i].tag, data.fonts[req[i].tag], req[i].text, req[i].color)] = html;
                    place(h, html);
                });
                if (window.renderTdfHeadings) renderTdfHeadings(preview);
            });
        }
        if (window.renderTdfHeadings) renderTdfHeadings(preview);
    }

    function convert(host) {
        var preview = host.querySelector('.wiki-preview');
        if (preview) { convertPreview(preview); return; }
        previewFonts = {};   /* left the editor: next edit session rolls new fonts */
        if (host.querySelector(':scope > .wiki-meta')) convertPage(host);
    }

    function attach() {
        var host = document.getElementById('wiki-content');
        if (!host || host.__tdfWatch || !('MutationObserver' in window)) return;
        host.__tdfWatch = true;
        var pending = 0;
        new MutationObserver(function () {
            if (pending) return;
            pending = setTimeout(function () { pending = 0; convert(host); }, 30);
        }).observe(host, { childList: true, subtree: true });
        convert(host);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
    else attach();
    window.addEventListener('spa:afterNavigate', attach);
})();
