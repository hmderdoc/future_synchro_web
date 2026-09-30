/* ansi-render.js - upgrade ANSI grid markup to a canvas image
 *
 * lib/forum.js formatMessage() and lib/ansi-viewer.js render_file_wrapper()
 * wrap an ANSI piece in
 *   <div class="ansi-render" data-ansi-w data-ansi-h data-ansi-cells
 *        [data-ansi-ice="1"] [data-ansi-spacing="9"] [data-ansi-aspect="1.35"]>
 * around a <pre class="ansi"> fallback. This turns that into a pixel-exact
 * image through GraphicsConverter (the VGA font the chat, avatars and the
 * gallery draw with), honouring the SAUCE facts: iCE colours (bright
 * backgrounds, not blink), 9-pixel cells, and rectangular pixels as a
 * 1.35 height. Pages that inject such HTML call renderAnsiCanvases(root)
 * afterwards. The forum keeps its own older copy in xjs-forum.js; this one
 * steps aside when that is already defined.
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
        return img;
    }
    function renderAnsiCanvases(root) {
        var elems = (root || document).querySelectorAll('.ansi-render[data-ansi-cells]');
        if (!elems.length) return;
        if (typeof GraphicsConverter === 'undefined' || !GraphicsConverter.shared) return;
        var gc = GraphicsConverter.shared();
        if (!gc.from_bin) return;
        Array.prototype.forEach.call(elems, function (el) {
            var b64 = el.getAttribute('data-ansi-cells');
            var w = parseInt(el.getAttribute('data-ansi-w'), 10) || 80;
            var h = parseInt(el.getAttribute('data-ansi-h'), 10) || 25;
            if (!b64) return;
            var ice = el.getAttribute('data-ansi-ice') === '1';
            var spacing9 = el.getAttribute('data-ansi-spacing') === '9';
            var aspect = parseFloat(el.getAttribute('data-ansi-aspect')) || 1;
            var key = w + 'x' + h + ':' + (ice ? 'i' : '') + (spacing9 ? '9' : '') + ':' + b64.substr(0, 64);
            function finish(dataURL) {
                var img = replaceWithImg(el, dataURL, w, h);
                if (aspect !== 1) {
                    /* Rectangular pixels: the art was drawn for a 1.35 tall cell. */
                    img.style.width = (w * (spacing9 ? 9 : 8)) + 'px';
                    img.style.height = Math.round(h * 16 * aspect) + 'px';
                }
            }
            if (cache[key]) { finish(cache[key]); return; }
            var raw;
            try { raw = atob(b64); } catch (e) { return; }
            if (raw.length < w * h * 2) return;
            gc.from_bin(raw, w, h, function (dataURL) {
                if (!dataURL) return;
                cache[key] = dataURL;
                finish(dataURL);
            }, true, { ice: ice, spacing9: spacing9 });
        });
    }
    window.renderAnsiCanvases = renderAnsiCanvases;
})();
