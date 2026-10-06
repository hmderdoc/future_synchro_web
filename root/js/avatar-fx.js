/* avatar-fx.js - hover spectacle for every drawn avatar on the site.
 *
 * Hovering an avatar (any [data-avatar] slot or chat avatar holding its
 * rendered <img>) plays one effect drawn from a shuffle bag, so a visitor
 * sees the whole catalog before anything repeats. Two kinds:
 *   css    - classes on the <img> plus overlay layers, css/avatar-fx.css
 *   canvas - a pixel overlay redrawn every frame from the avatar's own
 *            pixels: palette cycling and the terminal glow wave, demoscene
 *            fire / plasma / copper bars / starfield / rotozoom, Wolf3D
 *            fizzle, Doom melt, datamosh, pixel sort, ASCII, halftone, ...
 * Canvas effects sometimes ride on a CSS motion (tilt, jelly, punch...).
 * Overlays never take pointer events, so clicks still reach the person
 * menu. Every so often a random visible avatar twitches on its own.
 *
 * Effects that follow the pointer (flagged `pointer`, plus anything riding
 * the tilt motion) get a ghost cursor when no mouse drives them: a random
 * effect started by script (the landing title, TDF headings) or a touch tap.
 * It springs between random spots with the odd pause, so a spotlight sweeps
 * and a lens glides instead of sitting dead center. A real mouse moving over
 * the art takes over; the ghost resumes a moment after it goes still.
 *
 * Console: AvatarFx.list() names every effect; AvatarFx.only('fire') pins
 * one for testing, AvatarFx.only() goes back to random; AvatarFx.play(el,
 * 'fire') / AvatarFx.stop(el) drive one avatar directly.
 */
(function () {
    'use strict';

    var HOSTS = '[data-avatar], [data-avatar-bin], [data-message-avatar], .chat-web-avatar, .chat-web-user-avatar, .chat-web-thread-avatar, .chat-avatar, .avatar-inline, .ol-avatar, .ib-avatar';
    var SKIP = '.person-picker, .bin-avatar-upload, [data-no-avatar-fx]';
    var AMBIENT_MS = [8000, 15000];
    var TWITCH_MS = 320;
    var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    /* The 16-colour text palette the avatars are drawn in. */
    var VGA = [
        [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170],
        [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
        [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255],
        [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255]
    ];
    /* Same wave the terminal's Friends badge glows with (friends_tile.ts):
       1 = brighten, 2 = light cyan, 3 = white. */
    var GLOW_WAVE = [0, 1, 2, 3, 2, 1];
    var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    var NEON = ['#ff55ff', '#55ffff', '#ffff55', '#55ff55', '#ff5555', '#5555ff'];

    var PALETTES = [
        [[15, 56, 15], [48, 98, 48], [139, 172, 15], [155, 188, 15]],                 // Game Boy
        [[0, 0, 0], [85, 255, 255], [255, 85, 255], [255, 255, 255]],                 // CGA mode 4, palette 1
        [[0, 0, 0], [85, 255, 85], [255, 85, 85], [255, 255, 85]],                    // CGA mode 4, palette 0
        [[0, 0, 0], [90, 40, 0], [200, 110, 0], [255, 176, 0], [255, 230, 150]],      // amber monitor
        [[0, 8, 0], [0, 70, 20], [20, 160, 60], [60, 255, 120], [200, 255, 210]],     // green phosphor
        [[0, 0, 0], [53, 40, 121], [104, 55, 43], [67, 57, 0], [111, 79, 37], [88, 141, 67],
            [149, 149, 149], [154, 103, 89], [112, 164, 178], [184, 199, 111], [255, 255, 255]], // C64
        [[20, 0, 40], [90, 0, 120], [255, 0, 170], [0, 200, 255], [255, 240, 255]],   // vaporwave
        [[0, 0, 0], [29, 43, 83], [126, 37, 83], [0, 135, 81], [171, 82, 54], [95, 87, 79],
            [255, 0, 77], [41, 173, 255], [255, 119, 168], [0, 228, 54], [255, 163, 0],
            [194, 195, 199], [255, 204, 170], [255, 236, 39], [255, 241, 232]],      // PICO-8
        [[0, 0, 0], [0, 0, 170], [0, 170, 170], [85, 255, 255], [255, 255, 255]],     // ice
        [[0, 0, 0], [80, 0, 0], [170, 0, 0], [255, 85, 85], [255, 220, 200]]          // blood
    ];
    PALETTES.forEach(function (p) { p.sort(function (a, b) { return lum(a[0], a[1], a[2]) - lum(b[0], b[1], b[2]); }); });

    var IRON = [[0, 0, 0], [30, 0, 90], [120, 0, 150], [200, 30, 90], [240, 100, 0], [255, 200, 0], [255, 255, 220]];

    var FIRE = [];
    (function () {
        for (var k = 0; k < 37; k++) {
            var t = k / 36;
            FIRE.push([clamp(t * 3.2 * 255, 0, 255), clamp((t - 0.3) * 2.4 * 255, 0, 255), clamp((t - 0.75) * 4 * 255, 0, 255)]);
        }
    })();

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function rnd(a, b) { return a + Math.random() * (b - a); }
    function irnd(a, b) { return Math.floor(rnd(a, b + 1)); }
    function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
    function lum(r, g, b) { return 0.299 * r + 0.587 * g + 0.114 * b; }
    function shuffle(a) {
        for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
        return a;
    }
    function nearestVga(r, g, b) {
        var best = 0, bd = 1e9;
        for (var k = 0; k < 16; k++) {
            var c = VGA[k], dr = r - c[0], dg = g - c[1], db = b - c[2], dd = dr * dr + dg * dg + db * db;
            if (dd < bd) { bd = dd; best = k; }
        }
        return best;
    }
    function hsl(h, s, l) {
        h = (((h % 360) + 360) % 360) / 360; s /= 100; l /= 100;
        if (!s) return [l * 255, l * 255, l * 255];
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        function f(t) {
            if (t < 0) t += 1; if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        }
        return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
    }
    function ramp(stops, v) {
        v = clamp(v, 0, 0.9999) * (stops.length - 1);
        var k = Math.floor(v), f = v - k, a = stops[k], b = stops[k + 1];
        return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    }
    function boost(r, g, b) {
        var m = Math.max(r, g, b, 1), k = 255 / m;
        return 'rgb(' + Math.round(r * k) + ',' + Math.round(g * k) + ',' + Math.round(b * k) + ')';
    }

    /* Pixel writers over the frame env (see makeEnv). */
    function put(e, o, c) { var d = e.d; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
    function copy(e, o, s4) { var d = e.d, s = e.src; d[o] = s[s4]; d[o + 1] = s[s4 + 1]; d[o + 2] = s[s4 + 2]; d[o + 3] = 255; }
    function at(e, x, y) { return (clamp(y | 0, 0, e.H - 1) * e.W + clamp(x | 0, 0, e.W - 1)) * 4; }
    function atWrap(e, x, y) {
        x = Math.floor(x) % e.W; y = Math.floor(y) % e.H;
        if (x < 0) x += e.W; if (y < 0) y += e.H;
        return (y * e.W + x) * 4;
    }
    function blockAvg(e, x0, y0, bw, bh) {
        var r = 0, g = 0, b = 0, n = 0, fg = 0;
        for (var y = y0; y < Math.min(y0 + bh, e.H); y++) {
            for (var x = x0; x < Math.min(x0 + bw, e.W); x++) {
                var i = y * e.W + x, o = i * 4;
                r += e.src[o]; g += e.src[o + 1]; b += e.src[o + 2]; n++;
                if (!e.bg[i]) fg++;
            }
        }
        n = n || 1;
        return { r: r / n, g: g / n, b: b / n, l: lum(r / n, g / n, b / n), fg: fg };
    }

    /* ------------------------------------------------------------------
       Canvas effects: frame(e) fills e.d (W x H RGBA, or padded) unless
       draws:true, in which case it paints e.ctx itself at e.scale.
       ------------------------------------------------------------------ */
    var CANVAS_FX = [
        { name: 'palette-cycle', frame: function (e) {
            var shift = Math.floor(e.t * 9);
            for (var i = 0; i < e.N; i++) {
                var o = i * 4, k = e.idx[i];
                if (e.bg[i] || !k) copy(e, o, o); else put(e, o, VGA[1 + (k - 1 + shift) % 15]);
            }
        } },
        { name: 'terminal-glow', frame: function (e) {
            var beat = Math.floor(e.t * 8);
            for (var y = 0; y < e.H; y++) for (var x = 0; x < e.W; x++) {
                var i = y * e.W + x, o = i * 4;
                var step = GLOW_WAVE[(((beat - Math.floor((x + y) / 9)) % 6) + 6) % 6];
                if (e.bg[i] || !step) copy(e, o, o);
                else put(e, o, step === 1 ? VGA[e.idx[i] | 8] : (step === 2 ? VGA[11] : VGA[15]));
            }
        } },
        { name: 'palette-swap', init: function (e) { e.s.order = shuffle(PALETTES.map(function (p, k) { return k; })); },
          frame: function (e) {
            var p = PALETTES[e.s.order[Math.floor(e.t / 0.85) % e.s.order.length]], n = p.length;
            for (var y = 0; y < e.H; y++) for (var x = 0; x < e.W; x++) {
                var i = y * e.W + x, l = e.L[i] / 255 + (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5) / n;
                put(e, i * 4, p[clamp(Math.floor(l * n), 0, n - 1)]);
            }
        } },
        { name: 'plasma', frame: function (e) {
            var t = e.t, cx = e.W / 2, cy = e.H / 2, d = e.d;
            for (var y = 0; y < e.H; y++) for (var x = 0; x < e.W; x++) {
                var i = y * e.W + x, o = i * 4;
                if (!e.bg[i]) { copy(e, o, o); continue; }
                var dx = x - cx, dy = y - cy;
                var v = Math.sin(x * 0.13 + t * 2.1) + Math.sin(y * 0.11 - t * 1.6) +
                    Math.sin((x + y) * 0.07 + t * 1.3) + Math.sin(Math.sqrt(dx * dx + dy * dy) * 0.17 - t * 2.8);
                d[o] = (128 + 127 * Math.sin(v * Math.PI)) * 0.85;
                d[o + 1] = (128 + 127 * Math.sin(v * Math.PI + 2.1 + t)) * 0.85;
                d[o + 2] = (128 + 127 * Math.sin(v * Math.PI + 4.2)) * 0.85;
                d[o + 3] = 255;
            }
        } },
        { name: 'demo-fire', init: function (e) {
            e.s.F = new Uint8Array(e.N);
            for (var x = 0; x < e.W; x++) e.s.F[(e.H - 1) * e.W + x] = 36;
            e.s.acc = 0;
          },
          frame: function (e) {
            var F = e.s.F, W = e.W;
            e.s.acc += e.dt;
            while (e.s.acc > 1 / 45) {
                e.s.acc -= 1 / 45;
                for (var x = 0; x < W; x++) for (var y = 1; y < e.H; y++) {
                    var src = y * W + x, p = F[src];
                    if (!p) { F[src - W] = 0; continue; }
                    var r = (Math.random() * 3) | 0, dst = src - r + 1 - W;
                    if (dst >= 0) F[dst] = p - (r & 1);
                }
            }
            for (var i = 0; i < e.N; i++) { if (e.bg[i]) put(e, i * 4, FIRE[F[i]]); else copy(e, i * 4, i * 4); }
        } },
        { name: 'copper-bars', init: function (e) {
            var base = rnd(0, 360);
            e.s.bars = [];
            for (var k = 0; k < 6; k++) e.s.bars.push({ ph: k * 0.55, hue: base + k * 60 });
            e.s.rows = [];
          },
          frame: function (e) {
            var rows = e.s.rows, t = e.t, H = e.H;
            for (var y = 0; y < H; y++) rows[y] = null;
            e.s.bars.map(function (b) {
                return { y: H / 2 + Math.sin(t * 1.7 + b.ph) * H * 0.42, z: Math.cos(t * 1.7 + b.ph), hue: b.hue };
            }).sort(function (a, b) { return a.z - b.z; }).forEach(function (b) {
                for (var dy = -6; dy <= 6; dy++) {
                    var y = Math.round(b.y + dy);
                    if (y >= 0 && y < H) rows[y] = hsl(b.hue, 100, 12 + (1 - Math.abs(dy) / 7) * 58);
                }
            });
            for (var y2 = 0; y2 < H; y2++) for (var x = 0; x < e.W; x++) {
                var i = y2 * e.W + x, o = i * 4;
                if (e.bg[i] && rows[y2]) put(e, o, rows[y2]); else copy(e, o, o);
            }
        } },
        { name: 'starfield', init: function (e) {
            e.s.stars = [];
            for (var k = 0; k < 80; k++) e.s.stars.push({ x: rnd(-1, 1), y: rnd(-1, 1), z: rnd(0.05, 1) });
          },
          frame: function (e) {
            e.d.set(e.src);
            var cx = e.W / 2, cy = e.H / 2;
            e.s.stars.forEach(function (s) {
                s.z -= e.dt * 0.6;
                var sx = cx + s.x / s.z * e.W * 0.3, sy = cy + s.y / s.z * e.H * 0.3;
                if (s.z <= 0.03 || sx < 0 || sx >= e.W || sy < 0 || sy >= e.H) {
                    s.x = rnd(-1, 1); s.y = rnd(-1, 1); s.z = 1; return;
                }
                var tx = cx + s.x / (s.z + 0.06) * e.W * 0.3, ty = cy + s.y / (s.z + 0.06) * e.H * 0.3;
                var b = (1 - s.z) * 255;
                [[sx, sy, b], [tx, ty, b * 0.45]].forEach(function (p) {
                    var x = p[0] | 0, y = p[1] | 0;
                    if (x < 0 || y < 0 || x >= e.W || y >= e.H || !e.bg[y * e.W + x]) return;
                    put(e, (y * e.W + x) * 4, [p[2], p[2], Math.min(255, p[2] * 1.2)]);
                });
            });
        } },
        { name: 'matrix-rain', init: function (e) {
            var s = e.s;
            s.cols = Math.ceil(e.W / 4); s.rows = Math.ceil(e.H / 4);
            s.T = new Float32Array(s.cols * s.rows);
            s.G = new Uint16Array(s.cols * s.rows);
            for (var k = 0; k < s.G.length; k++) s.G[k] = (Math.random() * 65536) | 0;
            s.heads = [];
            for (var c = 0; c < s.cols; c++) s.heads.push({ y: rnd(-s.rows * 0.4, s.rows * 0.6), v: rnd(9, 18) });
          },
          frame: function (e) {
            var s = e.s, k;
            for (k = 0; k < s.T.length; k++) s.T[k] = Math.max(0, s.T[k] - e.dt * 1.1);
            for (k = 0; k < s.G.length * 0.03; k++) s.G[(Math.random() * s.G.length) | 0] = (Math.random() * 65536) | 0;
            s.heads.forEach(function (h, c) {
                h.y += h.v * e.dt;
                var hy = Math.floor(h.y);
                if (hy >= 0 && hy < s.rows) s.T[hy * s.cols + c] = 1;
                if (h.y > s.rows + 8) { h.y = rnd(-6, 0); h.v = rnd(9, 18); }
            });
            for (var y = 0; y < e.H; y++) for (var x = 0; x < e.W; x++) {
                var i = y * e.W + x, o = i * 4;
                if (!e.bg[i]) { copy(e, o, o); continue; }
                var ci = (y >> 2) * s.cols + (x >> 2), v = s.T[ci];
                var bit = (s.G[ci] >> ((y & 3) * 4 + (x & 3))) & 1;
                if (v > 0 && bit && (x & 3) !== 3) put(e, o, v > 0.92 ? [190, 255, 190] : [0, 255 * v, 70 * v]);
                else put(e, o, [0, 0, 0]);
            }
        } },
        { name: 'sine-wobble', frame: function (e) {
            var A = Math.min(1, e.t * 2.5) * 3.2;
            for (var y = 0; y < e.H; y++) {
                var dx = Math.round(A * Math.sin(y * 0.21 + e.t * 7));
                for (var x = 0; x < e.W; x++) {
                    var dy = Math.round(A * 0.6 * Math.sin(x * 0.17 + e.t * 5.3));
                    copy(e, (y * e.W + x) * 4, at(e, x + dx, y + dy));
                }
            }
        } },
        { name: 'rgb-split', frame: function (e) {
            var s = e.s;
            s.acc = (s.acc === undefined ? 1 : s.acc) + e.dt;
            if (s.acc > 0.07) {
                s.acc = 0; s.rx = irnd(-4, 4); s.bx = irnd(-4, 4); s.by = irnd(-1, 1);
                s.band = Math.random() < 0.35 ? { y: irnd(0, e.H - 1), h: irnd(2, 10), dx: irnd(-8, 8) } : null;
            }
            var d = e.d, src = e.src;
            for (var y = 0; y < e.H; y++) {
                var shift = s.band && y >= s.band.y && y < s.band.y + s.band.h ? s.band.dx : 0;
                for (var x = 0; x < e.W; x++) {
                    var o = (y * e.W + x) * 4, bx = x + shift;
                    d[o] = src[at(e, bx + s.rx, y)];
                    d[o + 1] = src[at(e, bx, y) + 1];
                    d[o + 2] = src[at(e, bx + s.bx, y + s.by) + 2];
                    d[o + 3] = 255;
                }
            }
        } },
        { name: 'datamosh', frame: function (e) {
            var s = e.s, W = e.W, H = e.H, d = e.d, src = e.src;
            s.acc = (s.acc === undefined ? 1 : s.acc) + e.dt;
            if (s.acc > 0.09) {
                s.acc = 0; s.bands = []; s.blocks = [];
                if (Math.random() > 0.2) {
                    for (var b = irnd(1, 4); b > 0; b--) s.bands.push({ y: irnd(0, H - 1), h: irnd(1, 12), dx: irnd(-W / 3, W / 3), swap: Math.random() < 0.4 });
                    for (var k = irnd(0, 3); k > 0; k--) {
                        var bw = irnd(6, W / 2), bh = irnd(4, H / 4);
                        s.blocks.push({ sx: irnd(0, W - bw), sy: irnd(0, H - bh), w: bw, h: bh, tx: irnd(0, W - bw), ty: irnd(0, H - bh) });
                    }
                }
            }
            d.set(src);
            s.bands.forEach(function (bd) {
                for (var y = bd.y; y < Math.min(H, bd.y + bd.h); y++) for (var x = 0; x < W; x++) {
                    var o = (y * W + x) * 4, so = atWrap(e, x - bd.dx, y);
                    if (bd.swap) { d[o] = src[so + 1]; d[o + 1] = src[so + 2]; d[o + 2] = src[so]; }
                    else { d[o] = src[so]; d[o + 1] = src[so + 1]; d[o + 2] = src[so + 2]; }
                }
            });
            s.blocks.forEach(function (bk) {
                for (var y = 0; y < bk.h; y++) for (var x = 0; x < bk.w; x++) {
                    copy(e, ((bk.ty + y) * W + bk.tx + x) * 4, ((bk.sy + y) * W + bk.sx + x) * 4);
                }
            });
        } },
        { name: 'pixel-sort', frame: function (e) {
            var thr = 230 - (0.5 - 0.5 * Math.cos(e.t * 2.4)) * 200, W = e.W, run = [];
            e.d.set(e.src);
            function flush() {
                if (run.length > 1) {
                    var cols = run.map(function (i) { return { l: e.L[i], o: i * 4 }; }).sort(function (a, b) { return a.l - b.l; });
                    run.forEach(function (i, k) { copy(e, i * 4, cols[k].o); });
                }
                run = [];
            }
            for (var x = 0; x < W; x++) {
                for (var y = 0; y < e.H; y++) {
                    var i = y * W + x;
                    if (!e.bg[i] && e.L[i] > thr) run.push(i); else flush();
                }
                flush();
            }
        } },
        { name: 'fizzlefade', init: function (e) {
            e.s.perm = shuffle(Array.from({ length: e.N }, function (v, k) { return k; }));
            e.s.mask = new Uint8Array(e.N);
            e.s.cycle = -1;
          },
          frame: function (e) {
            var s = e.s, P = 2.2, p = e.t % P, cyc = Math.floor(e.t / P), k;
            if (cyc !== s.cycle) { s.cycle = cyc; s.color = cyc === 0 ? VGA[4] : VGA[irnd(9, 14)]; }
            if (p < 0.65) k = p / 0.65; else if (p < 0.85) k = 1; else if (p < 1.5) k = 1 - (p - 0.85) / 0.65; else k = 0;
            k = Math.floor(k * e.N);
            s.mask.fill(0);
            for (var j = 0; j < k; j++) s.mask[s.perm[j]] = 1;
            for (var i = 0; i < e.N; i++) { if (s.mask[i]) put(e, i * 4, s.color); else copy(e, i * 4, i * 4); }
        } },
        { name: 'doom-melt', init: function (e) {
            var off = e.s.off = new Int16Array(e.W), prev = -irnd(0, 15);
            for (var x = 0; x < e.W; x += 2) {
                prev = clamp(prev + irnd(-1, 1), -15, 0);
                off[x] = prev; if (x + 1 < e.W) off[x + 1] = prev;
            }
            var alt = e.s.alt = new Uint8ClampedArray(e.src.length);
            for (var i = 0; i < e.N; i++) {
                var c = e.bg[i] || !e.idx[i] ? [0, 0, 0] : VGA[1 + (e.idx[i] - 1 + 5) % 15];
                alt[i * 4] = c[0]; alt[i * 4 + 1] = c[1]; alt[i * 4 + 2] = c[2]; alt[i * 4 + 3] = 255;
            }
          },
          frame: function (e) {
            var P = 2.6, p = e.t % P, flip = Math.floor(e.t / P) % 2;
            var top = flip ? e.s.alt : e.src, bot = flip ? e.src : e.s.alt, d = e.d;
            var m = p < 1.6 ? Math.pow(p / 1.6, 1.5) : 1, Y = m * (e.H + 32);
            for (var x = 0; x < e.W; x++) {
                var shift = Math.round(clamp(Y + e.s.off[x] * 2, 0, e.H));
                for (var y = 0; y < e.H; y++) {
                    var o = (y * e.W + x) * 4, from = y < shift ? bot : top, so = y < shift ? o : ((y - shift) * e.W + x) * 4;
                    d[o] = from[so]; d[o + 1] = from[so + 1]; d[o + 2] = from[so + 2]; d[o + 3] = 255;
                }
            }
        } },
        { name: 'mosaic', frame: function (e) {
            var SIZES = [1, 2, 3, 4, 6, 8, 10, 8, 6, 4, 3, 2], b = SIZES[Math.floor(e.t / 0.11) % SIZES.length];
            for (var by = 0; by < e.H; by += b) for (var bx = 0; bx < e.W; bx += b) {
                var a = blockAvg(e, bx, by, b, b), c = [a.r, a.g, a.b];
                for (var y = by; y < Math.min(by + b, e.H); y++) for (var x = bx; x < Math.min(bx + b, e.W); x++) put(e, (y * e.W + x) * 4, c);
            }
        } },
        { name: 'vertical-hold', frame: function (e) {
            var span = e.H + 10, off = Math.floor(e.t * 55) % span, flick = 0.85 + Math.random() * 0.25, d = e.d, src = e.src;
            for (var y = 0; y < e.H; y++) {
                var sy = (y + off) % span, dx = Math.random() < 0.06 ? irnd(-2, 2) : 0;
                for (var x = 0; x < e.W; x++) {
                    var o = (y * e.W + x) * 4;
                    if (sy >= e.H) { var n = rnd(10, 55); put(e, o, [n, n, n]); continue; }
                    var so = at(e, x + dx, sy);
                    d[o] = src[so] * flick; d[o + 1] = src[so + 1] * flick; d[o + 2] = src[so + 2] * flick; d[o + 3] = 255;
                }
            }
        } },
        { name: 'kaleidoscope', frame: function (e) {
            var mode = (Math.floor(e.t / 0.4) + 1) % 6, W = e.W, H = e.H;
            for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
                var sx = x, sy = y;
                if (mode === 1 || mode === 4) sx = x < W / 2 ? x : W - 1 - x;
                if (mode === 2) sx = x >= W / 2 ? x : W - 1 - x;
                if (mode === 3 || mode === 4) sy = y < H / 2 ? y : H - 1 - y;
                if (mode === 5) sx = W - 1 - x;
                copy(e, (y * W + x) * 4, (sy * W + sx) * 4);
            }
        } },
        { name: 'rotozoom', frame: function (e) {
            var ease = Math.min(1, e.t * 2), a = Math.sin(e.t * 1.3) * 1.4 * ease, z = 1 + 0.55 * Math.sin(e.t * 2.1) * ease;
            var ca = Math.cos(a) / z, sa = Math.sin(a) / z, cx = e.W / 2, cy = e.H / 2;
            for (var y = 0; y < e.H; y++) for (var x = 0; x < e.W; x++) {
                var dx = x - cx, dy = y - cy;
                copy(e, (y * e.W + x) * 4, atWrap(e, ca * dx - sa * dy + cx, sa * dx + ca * dy + cy));
            }
        } },
        { name: 'raster-beam', frame: function (e) {
            var p = Math.min(1, (e.t % 1.2) / 1.0), beam = p * (e.H + 6) - 3, d = e.d, src = e.src;
            for (var y = 0; y < e.H; y++) {
                var dyb = y - beam;
                for (var x = 0; x < e.W; x++) {
                    var o = (y * e.W + x) * 4;
                    if (dyb > 0) { d[o] = src[o] * 0.12; d[o + 1] = src[o + 1] * 0.12; d[o + 2] = src[o + 2] * 0.12; }
                    else if (dyb > -3) {
                        var k = (3 + dyb) / 3 * 0.8 * (0.8 + Math.random() * 0.2);
                        d[o] = src[o] + (255 - src[o]) * k; d[o + 1] = src[o + 1] + (255 - src[o + 1]) * k; d[o + 2] = src[o + 2] + (255 - src[o + 2]) * k;
                    } else { d[o] = src[o]; d[o + 1] = src[o + 1]; d[o + 2] = src[o + 2]; }
                    d[o + 3] = 255;
                }
            }
        } },
        { name: 'explode', pad: 14, init: function (e) {
            var parts = e.s.parts = [];
            for (var y = 0; y < e.H; y++) for (var x = 0; x < e.W; x++) {
                var i = y * e.W + x;
                if (e.bg[i]) continue;
                parts.push({ hx: x + e.pad, hy: y + e.pad, x: x + e.pad, y: y + e.pad, vx: 0, vy: 0, c: [e.src[i * 4], e.src[i * 4 + 1], e.src[i * 4 + 2]] });
            }
            e.s.next = 0.05;
          },
          frame: function (e) {
            var s = e.s, cx = e.OW / 2, cy = e.OH / 2, d = e.d, dt = e.dt;
            if (e.t >= s.next) {
                s.next = e.t + 2;
                s.parts.forEach(function (p) {
                    var ang = Math.atan2(p.hy - cy, p.hx - cx) + rnd(-0.6, 0.6), sp = rnd(30, 150);
                    p.vx += Math.cos(ang) * sp; p.vy += Math.sin(ang) * sp - rnd(0, 40);
                });
            }
            d.fill(0);
            for (var y = 0; y < e.H; y++) for (var x = 0; x < e.W; x++) {
                var o = ((y + e.pad) * e.OW + x + e.pad) * 4;
                d[o + 3] = 255;
            }
            s.parts.forEach(function (p) {
                p.vx += (-38 * (p.x - p.hx) - 7 * p.vx) * dt;
                p.vy += (-38 * (p.y - p.hy) - 7 * p.vy) * dt;
                p.x += p.vx * dt; p.y += p.vy * dt;
                var x = Math.round(p.x), y = Math.round(p.y);
                if (x < 0 || y < 0 || x >= e.OW || y >= e.OH) return;
                put(e, (y * e.OW + x) * 4, p.c);
            });
        } },
        { name: 'ripple', pointer: true, frame: function (e) {
            var amp0 = 2.6 * Math.min(1, e.t * 3), d = e.d, src = e.src;
            for (var y = 0; y < e.H; y++) for (var x = 0; x < e.W; x++) {
                var dx = x - e.px, dy = y - e.py, dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
                var fall = Math.exp(-dist / 28), w = Math.sin(dist * 0.6 - e.t * 9), a = amp0 * fall * w;
                var so = at(e, Math.round(x + dx / dist * a), Math.round(y + dy / dist * a)), o = (y * e.W + x) * 4, k = 1 + 0.35 * w * fall;
                d[o] = src[so] * k; d[o + 1] = src[so + 1] * k; d[o + 2] = src[so + 2] * k; d[o + 3] = 255;
            }
        } },
        { name: 'lens', pointer: true, frame: function (e) {
            var R = Math.max(10, Math.min(e.W, e.H) * 0.27), d = e.d;
            e.d.set(e.src);
            for (var y = Math.floor(e.py - R); y <= e.py + R; y++) for (var x = Math.floor(e.px - R); x <= e.px + R; x++) {
                if (x < 0 || y < 0 || x >= e.W || y >= e.H) continue;
                var dx = x - e.px, dy = y - e.py, dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > R) continue;
                var t = dist / R, f = t ? Math.pow(t, 1.7) / t : 0, o = (y * e.W + x) * 4;
                copy(e, o, at(e, e.px + dx * f, e.py + dy * f));
                if (t > 0.9) { d[o] = d[o] * 0.4 + 85 * 0.6; d[o + 1] = d[o + 1] * 0.4 + 255 * 0.6; d[o + 2] = d[o + 2] * 0.4 + 255 * 0.6; }
            }
        } },
        { name: 'halftone', scale: 4, draws: true, frame: function (e) {
            var ctx = e.ctx, B = 4, C = B * e.scale;
            ctx.fillStyle = '#000'; ctx.fillRect(0, 0, e.cv.width, e.cv.height);
            for (var by = 0; by * B < e.H; by++) for (var bx = 0; bx * B < e.W; bx++) {
                var a = blockAvg(e, bx * B, by * B, B, B);
                if (!a.fg) continue;
                var rad = (C / 2) * 1.15 * Math.sqrt(a.l / 255) * (0.7 + 0.3 * Math.sin(e.t * 5 - (bx + by) * 0.5));
                if (rad < 0.6) continue;
                ctx.fillStyle = boost(a.r, a.g, a.b);
                ctx.beginPath(); ctx.arc(bx * C + C / 2, by * C + C / 2, rad, 0, Math.PI * 2); ctx.fill();
            }
        } },
        { name: 'ascii', scale: 4, draws: true, frame: function (e) {
            var RAMP = ' .:-=+*%#@', NOISE = '01#$%&@*+=<>/\\|', ctx = e.ctx, BW = 5, BH = 8;
            var CW = BW * e.scale, CH = BH * e.scale, cols = Math.ceil(e.W / BW), rows = Math.ceil(e.H / BH);
            var total = cols * rows, shown = Math.min(total, Math.floor(e.t / 0.35 * total));
            ctx.fillStyle = '#000'; ctx.fillRect(0, 0, e.cv.width, e.cv.height);
            ctx.font = 'bold ' + Math.round(CW * 1.5) + 'px monospace';
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            for (var j = 0; j < shown; j++) {
                var cx = (j % cols) * CW, cy = Math.floor(j / cols) * CH, a = blockAvg(e, (j % cols) * BW, Math.floor(j / cols) * BH, BW, BH);
                var li = Math.round(a.l / 255 * (RAMP.length - 1));
                if (!a.fg || !li) continue;
                ctx.fillStyle = boost(a.r, a.g, a.b);
                ctx.fillText(Math.random() < 0.04 ? pick(NOISE) : RAMP[li], cx + CW / 2, cy + CH * 0.1);
            }
            if (shown < total) { ctx.fillStyle = '#55ff55'; ctx.fillRect((shown % cols) * CW, Math.floor(shown / cols) * CH, CW, CH); }
        } },
        { name: 'bitplanes', frame: function (e) {
            var MASKS = [1, 2, 4, 8, 3, 5, 6, 9, 12, 7, 14, 15], mask = MASKS[Math.floor(e.t / 0.28) % MASKS.length];
            for (var i = 0; i < e.N; i++) { if (e.bg[i]) copy(e, i * 4, i * 4); else put(e, i * 4, VGA[e.idx[i] & mask]); }
        } },
        { name: 'thermal', pointer: true, frame: function (e) {
            var heat = 0.55 * Math.min(1, e.t * 2);
            for (var y = 0; y < e.H; y++) for (var x = 0; x < e.W; x++) {
                var i = y * e.W + x, dx = x - e.px, dy = y - e.py, dist = Math.sqrt(dx * dx + dy * dy);
                var v = e.L[i] / 255 * 0.7 + heat * Math.exp(-dist / 16) + 0.06 * Math.sin(e.t * 4 + y * 0.3 + x * 0.1) - (e.bg[i] ? 0.05 : 0);
                put(e, i * 4, ramp(IRON, v));
            }
        } },
        { name: 'tv-static', frame: function (e) {
            var a = Math.random() < 0.06 ? 0.9 : 0.25 + 0.2 * Math.sin(e.t * 6), band = (e.t * 40) % (e.H + 10) - 5, d = e.d, src = e.src;
            for (var y = 0; y < e.H; y++) {
                var aa = Math.min(1, a + (Math.abs(y - band) < 3 ? 0.4 : 0));
                for (var x = 0; x < e.W; x++) {
                    var o = (y * e.W + x) * 4, n = Math.random() * 255 * aa, k = 1 - aa;
                    d[o] = src[o] * k + n; d[o + 1] = src[o + 1] * k + n; d[o + 2] = src[o + 2] * k + n; d[o + 3] = 255;
                }
            }
        } },
        { name: 'venetian', frame: function (e) {
            var p = e.t % 1.5, k = p < 1 ? Math.sin(p * Math.PI) : 0, s = Math.round(k * e.W * 0.6);
            for (var y = 0; y < e.H; y++) {
                var dx = (Math.floor(y / 3) & 1) ? s : -s;
                for (var x = 0; x < e.W; x++) {
                    var sx = x - dx, o = (y * e.W + x) * 4;
                    if (sx < 0 || sx >= e.W) put(e, o, [0, 0, 0]); else copy(e, o, (y * e.W + sx) * 4);
                }
            }
        } },
        { name: 'tron', init: function (e) {
            var edge = e.s.edge = new Uint8Array(e.N), W = e.W, H = e.H;
            for (var y = 0; y < H; y++) for (var x = 0; x < W; x++) {
                var i = y * W + x, k = e.idx[i];
                [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (n) {
                    var nx = x + n[0], ny = y + n[1];
                    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return;
                    var j = ny * W + nx;
                    if (e.idx[j] !== k && (!e.bg[i] || !e.bg[j])) edge[i] = 1;
                });
            }
          },
          frame: function (e) {
            var d = e.d, src = e.src, scan = (e.t * 60) % (e.H + 20) - 10;
            for (var y = 0; y < e.H; y++) for (var x = 0; x < e.W; x++) {
                var i = y * e.W + x, o = i * 4;
                if (e.s.edge[i]) {
                    var c = hsl(e.t * 160 + (x + y) * 5, 100, Math.abs(y - scan) < 4 ? 85 : 60);
                    put(e, o, c);
                } else if (!e.bg[i]) { d[o] = src[o] * 0.18; d[o + 1] = src[o + 1] * 0.18; d[o + 2] = src[o + 2] * 0.18; d[o + 3] = 255; }
                else put(e, o, [0, 0, 0]);
            }
        } }
    ];

    /* CSS effects: classes on the <img> and overlay layers (avatar-fx.css). */
    var CSS_FX = [
        { name: 'hue-cycle', media: ['afx-hue'] },
        { name: 'neon', media: ['afx-neon'] },
        { name: 'crt-power-on', media: ['afx-crt'] },
        { name: 'jelly', media: ['afx-jelly'] },
        { name: 'coin-flip', media: ['afx-coin'] },
        { name: 'tilt', pointer: true, media: ['afx-tilt'], layers: ['afx-l-shine afx-tilt'] },
        { name: 'holo-foil', pointer: true, media: ['afx-holo', 'afx-tilt'], layers: ['afx-l-holo afx-tilt'] },
        { name: 'scanlines', media: ['afx-scan'], layers: ['afx-l-scan'] },
        { name: 'vhs', media: ['afx-vhs'], layers: ['afx-l-vhs'] },
        { name: 'strobe', media: ['afx-strobe'] },
        { name: 'retro-shadow', media: ['afx-retro'] },
        { name: 'glitch-clip', media: ['afx-clip'] },
        { name: 'spotlight', pointer: true, media: ['afx-spot'], layers: ['afx-l-spot'] },
        { name: 'punch', media: ['afx-punch'] }
    ];
    /* CSS motions a canvas effect can ride on. */
    var MOTION = ['afx-jelly', 'afx-tilt', 'afx-neon', 'afx-punch', 'afx-retro', 'afx-coin'];
    var TWITCHES = ['rgb-split', 'datamosh', 'glitch-clip', 'hue-cycle', 'bitplanes'];

    var ALL = CANVAS_FX.map(function (f) { f.kind = 'canvas'; return f; })
        .concat(CSS_FX.map(function (f) { f.kind = 'css'; return f; }));
    var BY_NAME = {};
    ALL.forEach(function (f) { BY_NAME[f.name] = f; });

    var bag = [], forced = null, hover = null, ghosts = [];
    var GHOST_IDLE_MS = 1200;   /* a real pointer keeps the ghost off this long */
    function nextFx() {
        if (forced && BY_NAME[forced]) return BY_NAME[forced];
        if (!bag.length) bag = shuffle(ALL.slice());
        return bag.pop();
    }

    /* ------------------------------------------------------------------ */

    function mediaOf(host) {
        var m = host.querySelector('img, canvas:not(.afx-canvas)');
        if (!m) return null;
        if (m.tagName === 'IMG' && !(m.complete && m.naturalWidth)) return null;
        if (m.tagName === 'CANVAS' && !(m.width && m.height)) return null;
        return m;
    }

    /* The drawn art's box: an object-fit:contain img (Who's Online, Callers
       on the Net) letterboxes 80x96 art inside a square element. */
    function artRect(media) {
        var r = media.getBoundingClientRect();
        var nw = media.naturalWidth || media.width, nh = media.naturalHeight || media.height;
        if (media.tagName !== 'IMG' || !nw || !nh || getComputedStyle(media).objectFit !== 'contain') return r;
        var k = Math.min(r.width / nw, r.height / nh), w = nw * k, h = nh * k;
        return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
    }

    function place(el, st, pad, srcW) {
        var hr = st.host.getBoundingClientRect(), mr = artRect(st.media);
        var ppx = pad ? mr.width / srcW : 0;
        el.style.left = (mr.left - hr.left - st.host.clientLeft - pad * ppx) + 'px';
        el.style.top = (mr.top - hr.top - st.host.clientTop - pad * ppx) + 'px';
        el.style.width = (mr.width + 2 * pad * ppx) + 'px';
        el.style.height = (mr.height + 2 * pad * ppx) + 'px';
    }

    function makeEnv(media, scale, pad) {
        var W = media.naturalWidth || media.width, H = media.naturalHeight || media.height;
        var off = document.createElement('canvas');
        off.width = W; off.height = H;
        var octx = off.getContext('2d');
        octx.drawImage(media, 0, 0, W, H);
        var src = octx.getImageData(0, 0, W, H).data;      // throws if tainted
        var N = W * H, bg = new Uint8Array(N), idx = new Uint8Array(N), L = new Float32Array(N);
        for (var i = 0; i < N; i++) {
            var o = i * 4;
            L[i] = lum(src[o], src[o + 1], src[o + 2]);
            bg[i] = L[i] < 20 ? 1 : 0;
            idx[i] = nearestVga(src[o], src[o + 1], src[o + 2]);
        }
        var OW = W + 2 * pad, OH = H + 2 * pad;
        var cv = document.createElement('canvas');
        cv.width = scale > 1 ? W * scale : OW;
        cv.height = scale > 1 ? H * scale : OH;
        cv.className = 'afx-canvas';
        var ctx = cv.getContext('2d');
        var out = ctx.createImageData(OW, OH);
        return { W: W, H: H, N: N, OW: OW, OH: OH, pad: pad, scale: scale, src: src, bg: bg, idx: idx, L: L,
            cv: cv, ctx: ctx, out: out, d: out.data, t: 0, dt: 0, px: W / 2, py: H / 2, s: {} };
    }

    function stop(st) {
        if (!st || st.dead) return;
        st.dead = true;
        if (st.raf) cancelAnimationFrame(st.raf);
        if (st.ghostRaf) cancelAnimationFrame(st.ghostRaf);
        if (st.ghost) ghosts.splice(ghosts.indexOf(st), 1);
        if (st.timer) clearTimeout(st.timer);
        st.nodes.forEach(function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
        st.mediaClasses.forEach(function (c) { st.media.classList.remove(c); });
        if (st.restorePosition) st.host.style.position = '';
        ['--afx-c', '--afx-px', '--afx-py'].forEach(function (v) { st.host.style.removeProperty(v); });
        if (st.host.__afx === st) st.host.__afx = null;
        if (hover === st) hover = null;
    }

    /* Pointer position as fractions of the art box (0..1). */
    function setPointer(st, px, py) {
        st.host.style.setProperty('--afx-px', px.toFixed(3));
        st.host.style.setProperty('--afx-py', py.toFixed(3));
        if (st.env) { st.env.px = px * st.env.W; st.env.py = py * st.env.H; }
        if (st.ghost) { st.ghost.x = px; st.ghost.y = py; }
    }

    function track(st, ev) {
        if (!st || st.dead) return;
        var r = artRect(st.media);
        if (!r.width || !r.height) return;
        setPointer(st, clamp((ev.clientX - r.left) / r.width, 0, 1), clamp((ev.clientY - r.top) / r.height, 0, 1));
        if (st.ghost) { st.ghost.vx = st.ghost.vy = 0; st.ghost.realUntil = performance.now() + GHOST_IDLE_MS; }
    }

    function usesPointer(st) {
        return !!(st.fx.pointer || (st.env && st.env.cv.classList.contains('afx-tilt')));
    }

    /* The ghost cursor: a damped spring toward a waypoint that moves every
       half second or so, sometimes holding still for a beat. Waypoints stay
       off the very edges so the effect keeps something to light up. */
    function ghost(st) {
        var g = st.ghost = { x: 0.5, y: 0.5, vx: 0, vy: 0, tx: 0.5, ty: 0.5, next: 0, realUntil: 0, last: performance.now() };
        var cur = st.host.style.getPropertyValue('--afx-px');
        if (cur) { g.x = parseFloat(cur); g.y = parseFloat(st.host.style.getPropertyValue('--afx-py')); }
        ghosts.push(st);
        function step(now) {
            if (st.dead) return;
            var dt = clamp((now - g.last) / 1000, 0, 0.05);
            g.last = now;
            if (now >= g.realUntil) {
                if (now >= g.next) {
                    if (Math.random() < 0.2) { g.tx = g.x; g.ty = g.y; }
                    else { g.tx = 0.1 + Math.random() * 0.8; g.ty = 0.15 + Math.random() * 0.7; }
                    g.next = now + rnd(450, 1300);
                }
                g.vx += ((g.tx - g.x) * 32 - g.vx * 8) * dt;
                g.vy += ((g.ty - g.y) * 32 - g.vy * 8) * dt;
                setPointer(st, clamp(g.x + g.vx * dt, 0, 1), clamp(g.y + g.vy * dt, 0, 1));
            }
            st.ghostRaf = requestAnimationFrame(step);
        }
        st.ghostRaf = requestAnimationFrame(step);
    }

    function play(host, fx, ev, ms) {
        if (host.__afx) stop(host.__afx);
        var media = mediaOf(host);
        if (!media) return null;
        var st = { host: host, media: media, fx: fx, nodes: [], mediaClasses: [], dead: false, twitch: !!ms };
        host.__afx = st;
        if (getComputedStyle(host).position === 'static') { host.style.position = 'relative'; st.restorePosition = true; }
        host.style.setProperty('--afx-c', pick(NEON));
        if (ev) track(st, ev);

        if (reduceMotion) {
            st.media.classList.add('afx-calm'); st.mediaClasses.push('afx-calm');
        } else if (fx.kind === 'canvas') {
            if (!runCanvas(st, fx)) return play(host, BY_NAME['hue-cycle'], ev, ms);
        } else {
            (fx.media || []).forEach(function (c) { media.classList.add(c); st.mediaClasses.push(c); });
            (fx.layers || []).forEach(function (cls) {
                var l = document.createElement('span');
                l.className = 'afx-layer ' + cls;
                host.appendChild(l);
                place(l, st, 0, 0);
                st.nodes.push(l);
            });
        }
        if (!reduceMotion && (!ev || ev.pointerType !== 'mouse') && usesPointer(st)) ghost(st);
        if (ms) st.timer = setTimeout(function () { stop(st); }, ms);
        return st;
    }

    function runCanvas(st, fx) {
        var e;
        try { e = makeEnv(st.media, fx.scale || 1, fx.pad || 0); } catch (err) { return false; }
        if (st.env === undefined && st.host.style.getPropertyValue('--afx-px')) {
            e.px = parseFloat(st.host.style.getPropertyValue('--afx-px')) * e.W;
            e.py = parseFloat(st.host.style.getPropertyValue('--afx-py')) * e.H;
        }
        st.env = e;
        if (Math.random() < 0.3 && !st.twitch) e.cv.classList.add(pick(MOTION));
        st.host.appendChild(e.cv);
        place(e.cv, st, e.pad, e.W);
        st.nodes.push(e.cv);
        if (fx.init) fx.init(e);
        var start = performance.now(), last = start;
        function tick(now) {
            if (st.dead) return;
            if (!st.host.isConnected || !st.media.isConnected) { stop(st); return; }
            /* rAF stamps the frame start, which can predate start. */
            e.dt = clamp((now - last) / 1000, 0, 0.05); last = Math.max(last, now);
            e.t = Math.max(0, (now - start) / 1000);
            fx.frame(e);
            if (!fx.draws) e.ctx.putImageData(e.out, 0, 0);
            st.raf = requestAnimationFrame(tick);
        }
        tick(start);
        return true;
    }

    function hostFrom(target) {
        var host = target && target.closest ? target.closest(HOSTS) : null;
        return host && !host.closest(SKIP) ? host : null;
    }

    document.addEventListener('pointerover', function (ev) {
        var host = hostFrom(ev.target);
        if (!host || (hover && hover.host === host)) return;
        if (hover) stop(hover);
        hover = play(host, nextFx(), ev, ev.pointerType === 'mouse' ? 0 : 900);
    });
    document.addEventListener('pointerout', function (ev) {
        if (!hover || ev.pointerType !== 'mouse') return;
        if (ev.relatedTarget && hover.host.contains(ev.relatedTarget)) return;
        if (!hover.host.contains(ev.target)) return;
        stop(hover);
    });
    document.addEventListener('pointermove', function (ev) {
        if (hover) track(hover, ev);
        /* A mouse over ghost-driven art takes the wheel. */
        if (ev.pointerType !== 'mouse') return;
        ghosts.forEach(function (st) {
            if (st === hover) return;
            var r = artRect(st.media);
            if (ev.clientX >= r.left && ev.clientX <= r.left + r.width && ev.clientY >= r.top && ev.clientY <= r.top + r.height) track(st, ev);
        });
    }, { passive: true });

    /* The tease: now and then one visible avatar glitches for a blink. */
    function ambient() {
        setTimeout(ambient, rnd(AMBIENT_MS[0], AMBIENT_MS[1]));
        if (document.hidden || reduceMotion) return;
        var hosts = Array.prototype.filter.call(document.querySelectorAll(HOSTS), function (h) {
            if (h.__afx || h.closest(SKIP) || !mediaOf(h)) return false;
            var r = h.getBoundingClientRect();
            return r.width > 8 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
        });
        if (hosts.length) play(pick(hosts), BY_NAME[pick(TWITCHES)], null, TWITCH_MS);
    }
    setTimeout(ambient, rnd(AMBIENT_MS[0], AMBIENT_MS[1]));

    window.AvatarFx = {
        list: function () { return ALL.map(function (f) { return f.kind + ':' + f.name; }); },
        only: function (name) { forced = name || null; return forced; },
        play: function (host, name) { return BY_NAME[name] ? play(host, BY_NAME[name], null, 0) : null; },
        stop: function (host) { if (host && host.__afx) stop(host.__afx); }
    };
})();
