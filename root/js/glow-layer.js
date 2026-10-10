/* glow-layer.js - compositor-side bloom for Canvas2D layers
 *
 * Replaces per-draw `shadowBlur` (which Firefox rasterises in software for
 * every stroke, measured at 10x the whole frame budget) with one cheap pass:
 *
 *   1. Callers keep drawing into the visible canvas exactly as before.
 *      `shadowBlur` on that context is intercepted: never applied, the
 *      largest radius requested during the frame is remembered.
 *   2. end() downsamples the visible canvas once into a small sibling
 *      <canvas> placed directly beneath it, blurring during that single
 *      small draw. The sibling is scaled back up with a CSS transform, so
 *      the upscale and the blend run in the compositor. (A CSS filter blur
 *      was tried first: Firefox rasterises it at device resolution every
 *      frame, which was slower than the shadows it replaced.)
 *
 * Per-frame JS cost: one small blurred drawImage, whatever the stroke count.
 *
 * `under` is a context on the small canvas pre-transformed to full-size
 * coordinates, for things that must sit beneath the strokes without
 * contributing bloom (the dark backdrop halo).
 *
 * Usage:
 *   var glow = window.GlowLayer.attach(canvas, { scale: 0.5 });
 *   glow.begin();              // clears visible + bloom canvases
 *   glow.under.fillRect(...);  // optional, full-size coords
 *   glow.ctx.stroke();         // as before; shadowBlur requests are recorded
 *   glow.end();                // sample into the bloom canvas
 *   glow.resize(w, h);         // when the visible canvas is resized
 */
(function () {
    'use strict';

    var instances = [];

    function attach(visibleCanvas, opts) {
        opts = opts || {};
        var scale     = opts.scale || 0.5;        // bloom canvas size relative to visible
        var radiusMul = (opts.radiusMul != null) ? opts.radiusMul : 0.5; // shadowBlur B -> sigma B/2
        var minBlur   = opts.minBlur || 2;        // CSS px at display size
        var maxBlur   = opts.maxBlur || 28;       // CSS px at display size
        var intensity = (opts.intensity != null) ? opts.intensity : 1.0;
        var passes    = opts.passes || 1;         // additive samples (brightens bloom)

        var ctx = visibleCanvas.getContext('2d');

        // Remove a bloom canvas left over from a previous attach to this element.
        if (visibleCanvas.__glowEl && visibleCanvas.__glowEl.parentNode) {
            visibleCanvas.__glowEl.parentNode.removeChild(visibleCanvas.__glowEl);
        }
        var bloom = document.createElement('canvas');
        bloom.className = (visibleCanvas.className || '') + ' viz-glow';
        bloom.setAttribute('aria-hidden', 'true');
        var bctx = bloom.getContext('2d');
        visibleCanvas.__glowEl = bloom;
        if (visibleCanvas.parentNode) {
            visibleCanvas.parentNode.insertBefore(bloom, visibleCanvas); // earlier sibling = painted beneath
        }

        var wanted = 0;
        var stats = { frames: 0, ms: 0 };

        Object.defineProperty(ctx, 'shadowBlur', {
            configurable: true,
            get: function () { return 0; },
            set: function (v) { v = +v; if (v > wanted) wanted = v; }
        });

        function applyStyle() {
            var w = visibleCanvas.width, h = visibleCanvas.height;
            var bw = Math.max(1, Math.round(w * scale)), bh = Math.max(1, Math.round(h * scale));
            if (bloom.width !== bw || bloom.height !== bh) { bloom.width = bw; bloom.height = bh; }
            var cs = visibleCanvas.style;
            var zi = cs.zIndex || (window.getComputedStyle ? window.getComputedStyle(visibleCanvas).zIndex : '');
            var s = bloom.style;
            s.position = 'absolute';
            s.left = '0'; s.top = '0';
            s.width = bw + 'px'; s.height = bh + 'px';
            s.transformOrigin = '0 0';
            s.transform = 'scale(' + (w / bw) + ', ' + (h / bh) + ')';
            s.pointerEvents = 'none';
            s.display = 'block';
            if (zi && zi !== 'auto') s.zIndex = zi;
            s.willChange = 'transform';
        }

        function resize(w, h) { applyStyle(); }

        function syncSize() {
            var bw = Math.max(1, Math.round(visibleCanvas.width * scale));
            var bh = Math.max(1, Math.round(visibleCanvas.height * scale));
            if (bloom.width !== bw || bloom.height !== bh) applyStyle();
        }

        function begin() {
            syncSize();
            wanted = 0;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, visibleCanvas.width, visibleCanvas.height);
            bctx.setTransform(1, 0, 0, 1, 0, 0);
            bctx.globalCompositeOperation = 'source-over';
            bctx.globalAlpha = 1;
            bctx.clearRect(0, 0, bloom.width, bloom.height);
            // `under` draws in full-size coordinates onto the small canvas.
            bctx.setTransform(bloom.width / visibleCanvas.width, 0, 0, bloom.height / visibleCanvas.height, 0, 0);
        }

        var filterOk = null;
        function filterSupported() {
            if (filterOk !== null) return filterOk;
            try {
                if (typeof bctx.filter !== 'string') { filterOk = false; return false; }
                bctx.filter = 'blur(1px)'; filterOk = (bctx.filter === 'blur(1px)'); bctx.filter = 'none';
            } catch (e) { filterOk = false; }
            return filterOk;
        }
        var tiny = null, tctx = null;

        // Blur happens here, in canvas, on the small buffer (cheap: a few
        // percent of the visible pixel count). The compositor only scales.
        function end() {
            var t0 = performance.now();
            bctx.setTransform(1, 0, 0, 1, 0, 0);
            if (wanted > 0 && intensity > 0) {
                var sigma = Math.min(maxBlur, Math.max(minBlur, wanted * radiusMul)) * scale; // small-canvas px
                bctx.imageSmoothingEnabled = true;
                bctx.globalAlpha = Math.min(1, intensity);
                if (filterSupported()) {
                    // Blur during the downscale draw. (Blurring the small canvas
                    // in place with a self-drawImage afterwards measured 5-7x
                    // slower in Firefox, so keep it as one filtered draw.)
                    bctx.filter = 'blur(' + sigma.toFixed(1) + 'px)';
                    bctx.globalCompositeOperation = 'source-over';
                    bctx.drawImage(visibleCanvas, 0, 0, bloom.width, bloom.height);
                    bctx.filter = 'none';
                    if (passes > 1) {
                        bctx.globalCompositeOperation = 'lighter';
                        for (var p = 1; p < passes; p++) bctx.drawImage(bloom, 0, 0);
                    }
                } else {
                    // No ctx.filter (older Safari): bounce through a half-size
                    // buffer with bilinear smoothing to approximate the blur.
                    if (!tiny) { tiny = document.createElement('canvas'); tctx = tiny.getContext('2d'); }
                    var tw = Math.max(1, bloom.width >> 1), th = Math.max(1, bloom.height >> 1);
                    if (tiny.width !== tw || tiny.height !== th) { tiny.width = tw; tiny.height = th; }
                    bctx.globalCompositeOperation = 'source-over';
                    bctx.drawImage(visibleCanvas, 0, 0, bloom.width, bloom.height);
                    var bounces = Math.max(1, Math.round(sigma / 1.5));
                    for (var i = 0; i < bounces; i++) {
                        tctx.clearRect(0, 0, tw, th);
                        tctx.drawImage(bloom, 0, 0, tw, th);
                        bctx.globalCompositeOperation = 'copy';
                        bctx.drawImage(tiny, 0, 0, bloom.width, bloom.height);
                    }
                }
                bctx.globalAlpha = 1;
                bctx.globalCompositeOperation = 'source-over';
                if (bloom.style.opacity !== '') bloom.style.opacity = '';
            } else if (bloom.style.opacity !== '0') {
                bloom.style.opacity = '0';
            }
            stats.frames++; stats.ms += performance.now() - t0;
        }

        function destroy() {
            if (bloom.parentNode) bloom.parentNode.removeChild(bloom);
            if (visibleCanvas.__glowEl === bloom) visibleCanvas.__glowEl = null;
            var i = instances.indexOf(api); if (i >= 0) instances.splice(i, 1);
        }

        applyStyle();

        var api = {
            ctx: ctx,
            under: bctx,
            bloom: bloom,
            begin: begin,
            end: end,
            resize: resize,
            destroy: destroy,
            stats: stats,
            lastRadius: function () { return wanted; },
            setIntensity: function (v) { intensity = v; },
            setPasses: function (n) { passes = n; }
        };
        instances.push(api);
        return api;
    }

    window.GlowLayer = { attach: attach, instances: instances };
})();
