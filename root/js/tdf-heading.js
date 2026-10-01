/* tdf-heading.js - draws the TDF art for headings built by lib/tdf-heading.js.
 * The cells are rendered with the site's VGA renderer (GraphicsConverter) into
 * an <img alt=""> so the heading's accessible text stays the plain string. */
(function () {
    'use strict';

    function renderTdfHeadings(root) {
        if (typeof GraphicsConverter === 'undefined' || !GraphicsConverter.shared) return;
        var gc = GraphicsConverter.shared();
        if (!gc.from_bin) return;
        var elems = (root || document).querySelectorAll('.tdf-art-cells[data-tdf-cells]');
        Array.prototype.forEach.call(elems, function (el) {
            if (el.getAttribute('data-tdf-done')) return;
            el.setAttribute('data-tdf-done', '1');
            var w = parseInt(el.getAttribute('data-tdf-w'), 10);
            var h = parseInt(el.getAttribute('data-tdf-h'), 10);
            var raw;
            try { raw = atob(el.getAttribute('data-tdf-cells')); } catch (e) { return; }
            if (!w || !h || raw.length < w * h * 2) return;
            gc.from_bin(raw, w, h, function (dataURL) {
                if (!dataURL) return;
                var img = document.createElement('img');
                img.alt = '';
                img.src = dataURL;
                el.appendChild(img);
            }, true, { ice: true });
        });
    }

    window.renderTdfHeadings = renderTdfHeadings;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { renderTdfHeadings(document); });
    } else {
        renderTdfHeadings(document);
    }
    window.addEventListener('spa:afterNavigate', function () { renderTdfHeadings(document); });
})();
