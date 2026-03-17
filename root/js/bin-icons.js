/* bin-icons.js — Reusable ANSI art BIN icon renderer for the SPA
 *
 * Reads base64-encoded 12x6 BIN data from window.sbbsBinIcons (embedded
 * server-side in index.xjs) and renders them as tiny pixel-art <img> tags
 * via GraphicsConverter.
 *
 * Usage:
 *   <span class="bin-icon" data-icon="forum"></span>
 *
 * The data-icon value maps to a key in window.sbbsBinIcons.
 * Rendered icons are cached by name so each BIN is decoded only once.
 */
(function () {
    'use strict';

    var gc = null;
    var cache = {};   // name -> dataURL

    function getGc() {
        if (!gc) gc = new GraphicsConverter();
        return gc;
    }

    /**
     * Render a single BIN icon into an element.
     * @param {string}      name  Key in window.sbbsBinIcons
     * @param {HTMLElement}  el    Target container (usually a <span class="bin-icon">)
     * @param {number}      [cols] BIN columns (default 12)
     * @param {number}      [rows] BIN rows (default 6)
     */
    function renderBinIcon(name, el, cols, rows) {
        if (!el) return;
        cols = cols || 12;
        rows = rows || 6;

        var icons = window.sbbsBinIcons || {};
        var b64 = icons[name];
        if (!b64) return;

        // Already cached — reuse dataURL
        if (cache[name]) {
            _insertImg(el, cache[name]);
            return;
        }

        try {
            getGc().from_bin(atob(b64), cols, rows, function (dataUrl) {
                cache[name] = dataUrl;
                _insertImg(el, dataUrl);
            }, true);  // dataOnly=true -> callback receives dataURL string
        } catch (ex) {
            // Silently skip broken icons
        }
    }

    function _insertImg(el, src) {
        el.innerHTML = '';
        var img = document.createElement('img');
        img.src = src;
        img.className = 'bin-icon-img';
        el.appendChild(img);
    }

    /**
     * Scan a DOM subtree for .bin-icon[data-icon] elements and render them.
     * @param {HTMLElement} [root] Defaults to document.body
     */
    function renderAll(root) {
        root = root || document.body;
        if (!root) return;
        var els = root.querySelectorAll('.bin-icon[data-icon]');
        for (var i = 0; i < els.length; i++) {
            var el = els[i];
            // Skip already-rendered
            if (el.querySelector('.bin-icon-img')) continue;
            renderBinIcon(el.getAttribute('data-icon'), el);
        }
    }

    // Auto-render on initial load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { renderAll(); });
    } else {
        // DOM already ready (script loaded late)
        setTimeout(function () { renderAll(); }, 0);
    }

    // Re-render after SPA page transitions
    document.addEventListener('spa:pageLoaded', function () {
        renderAll();
    });

    // Public API
    window.renderBinIcon = renderBinIcon;
    window.renderAllBinIcons = renderAll;
})();
