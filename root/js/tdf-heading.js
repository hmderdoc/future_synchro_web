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
                img.draggable = false;
                img.onload = function () { setupFx(el.closest('.tdf-heading'), el); };
                img.src = dataURL;
                el.appendChild(img);
            }, true, { ice: true });
        });
    }

    /* ── optional effects (data-tdf-fx, set by lib/tdf-heading.js) ──────
       Reuses the avatar effects engine (js/avatar-fx.js): the art's <img>
       is a host like any avatar. */
    var LOOP_MS = 7000;
    var NOT_OURS = 'a, button, input, select, textarea, label, summary, [role="button"], [data-no-tdf-click]';

    function fxNames() {
        return window.AvatarFx ? AvatarFx.list().map(function (s) { return s.split(':')[1]; }) : [];
    }

    function pickFx(spec, avoid) {
        var names = fxNames();
        if (spec && spec !== 'random' && names.indexOf(spec) !== -1) return spec;
        var pool = names.filter(function (n) { return n !== avoid; });
        return pool[Math.floor(Math.random() * pool.length)];
    }

    function setupFx(head, host) {
        if (!head || !host || head.__tdfFx || !window.AvatarFx) return;
        var spec = head.getAttribute('data-tdf-fx');
        if (!spec) return;
        head.__tdfFx = true;
        var loop = head.getAttribute('data-tdf-fx-play') === 'loop';
        var current = pickFx(spec);
        var visible = true, timer = null, touchTimer = null;

        function start() { if (host.isConnected && current) AvatarFx.play(host, current); }
        function halt() { AvatarFx.stop(host); }

        function cycle() {
            clearTimeout(timer);
            if (!host.isConnected) return;
            if (visible && !document.hidden) start();
            timer = setTimeout(cycle, LOOP_MS);
        }

        if (loop) {
            if ('IntersectionObserver' in window) {
                new IntersectionObserver(function (entries) {
                    visible = entries[entries.length - 1].isIntersecting;
                    if (visible) cycle(); else { clearTimeout(timer); halt(); }
                }).observe(host);
            } else {
                cycle();
            }
        } else {
            host.addEventListener('pointerenter', start);
            host.addEventListener('pointerleave', function (ev) { if (ev.pointerType === 'mouse') halt(); });
        }

        if (head.getAttribute('data-tdf-fx-click') === '1' && !head.closest(NOT_OURS)) {
            head.addEventListener('click', function (ev) {
                if (ev.target.closest(NOT_OURS) !== null && head.contains(ev.target.closest(NOT_OURS))) return;
                current = pickFx('random', current);
                if (loop) { cycle(); return; }
                start();
                /* No hover on touch: let the new effect run for a moment. */
                if (ev.pointerType && ev.pointerType !== 'mouse') {
                    clearTimeout(touchTimer);
                    touchTimer = setTimeout(halt, 2500);
                }
            });
            head.style.cursor = 'pointer';
        }
    }

    window.renderTdfHeadings = renderTdfHeadings;
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { renderTdfHeadings(document); });
    } else {
        renderTdfHeadings(document);
    }
    window.addEventListener('spa:afterNavigate', function () { renderTdfHeadings(document); });
})();
