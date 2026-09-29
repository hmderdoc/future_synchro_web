/* ansi-render.js - upgrade the forum's ANSI grid markup to a canvas image
 *
 * lib/forum.js formatMessage() wraps an ANSI post in
 *   <div class="ansi-render" data-ansi-w data-ansi-h data-ansi-cells>
 * around a <pre class="ansi"> fallback. The forum page turns that into a
 * pixel-exact image through GraphicsConverter (the same drawing the chat and
 * the file previews use); any other page that shows forum HTML (the profile's
 * Forum Activity) loads this file and calls renderAnsiCanvases(root) after
 * injecting it. The forum keeps its own copy in xjs-forum.js; this one steps
 * aside when that is already defined.
 */
(function () {
    'use strict';
    if (typeof window.renderAnsiCanvases === 'function') return;
    var cache = {};
    function replaceWithImg(el, dataURL, w, h) {
        var img = document.createElement('img');
        img.src = dataURL;
        img.alt = 'ANSI art (' + w + '×' + h + ')';
        img.className = 'ansi-canvas-img';
        img.style.maxWidth = '100%';
        img.style.height = 'auto';
        img.style.imageRendering = 'pixelated';
        img.style.display = 'block';
        el.innerHTML = '';
        el.appendChild(img);
    }
    function renderAnsiCanvases(root) {
        var elems = (root || document).querySelectorAll('.ansi-render[data-ansi-cells]');
        if (!elems.length) return;
        if (typeof GraphicsConverter === 'undefined' || !GraphicsConverter.shared) return;
        var gc = GraphicsConverter.shared();
        if (!gc.from_bitmap_cells) return;
        Array.prototype.forEach.call(elems, function (el) {
            var b64 = el.getAttribute('data-ansi-cells');
            var w = parseInt(el.getAttribute('data-ansi-w'), 10) || 80;
            var h = parseInt(el.getAttribute('data-ansi-h'), 10) || 25;
            if (!b64) return;
            var key = w + 'x' + h + ':' + b64.substr(0, 64);
            if (cache[key]) { replaceWithImg(el, cache[key], w, h); return; }
            var raw;
            try { raw = atob(b64); } catch (e) { return; }
            var total = w * h;
            if (raw.length < total * 2) return;
            var cells = [];
            for (var i = 0; i < total; i++) {
                var attr = raw.charCodeAt(i * 2 + 1) & 0xFF;
                cells.push({ charCode: raw.charCodeAt(i * 2) & 0xFF, fg: attr & 0xF, bg: (attr >> 4) & 0xF });
            }
            gc.from_bitmap_cells(cells, w, h, function (dataURL) {
                if (!dataURL) return;
                cache[key] = dataURL;
                replaceWithImg(el, dataURL, w, h);
            }, true);
        });
    }
    window.renderAnsiCanvases = renderAnsiCanvases;
})();
