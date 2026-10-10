// Visualizer per-layer cost profile. Plain Node + Playwright.
// Usage: PW_BROWSER=firefox|chromium node viz_profile.js
const pw = require('/sbbs/webv4_custom/node_modules/playwright');

const BROWSER   = process.env.PW_BROWSER || 'firefox';
const BASE      = process.env.PW_BASE || 'http://127.0.0.1:4080';
const USER      = process.env.PW_USER || 'Beta Tester';
const PASS      = process.env.PW_PASS;   // required: never commit a password default
if (!PASS) { console.error('PW_PASS is required (password for PW_USER, default "Beta Tester")'); process.exit(2); }
const TRACK     = process.env.PW_TRACK || 'CyberTribe_Ascension_hm_derdoc.mp3';
const SAMPLE_MS = +(process.env.SAMPLE_MS || 6000);
const SETTLE_MS = +(process.env.SETTLE_MS || 2500);
const ONLY      = process.env.ONLY ? process.env.ONLY.split(',') : null;
const REPEAT    = +(process.env.REPEAT || 1);
const median = a => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[(b.length - 1) >> 1] : 0; };

// Each scenario: which kill-switches to apply before the visualizer opens.
const SYNTH = !!process.env.SYNTH;
const SCENARIOS = [
    { name: 'baseline',            },
    { name: 'no-shadowblur',       noShadow: true },
    { name: 'no-strobe',           noStrobe: true },
    { name: 'no-minieq',           noMiniEq: true },
    { name: 'no-butterchurn',      noBC: true },
    { name: 'lyrics-bouncing',     lyricMode: 'bouncing' },
    { name: 'no-filltext',         noText: true },
    { name: 'no-shadow+no-text',   noShadow: true, noText: true },
    { name: 'no-shadow+strobe+eq', noShadow: true, noStrobe: true, noMiniEq: true },
    { name: 'everything-off',      noShadow: true, noStrobe: true, noMiniEq: true, noBC: true, lyricMode: 'bouncing' },
];

async function launch() {
    if (BROWSER === 'firefox') {
        return pw.firefox.launch({
            headless: true,
            firefoxUserPrefs: {
                'media.autoplay.default': 0,
                'media.autoplay.blocking_policy': 0,
                'webgl.force-enabled': true,
                'webgl.disabled': false,
                'webgl.forbid-software': false,
                'webgl.disable-fail-if-major-performance-caveat': true,
                'webgl.out-of-process': false,
                'webgl.enable-debug-renderer-info': true,
                'dom.min_background_timeout_value': 4,
            },
        });
    }
    return pw.chromium.launch({
        headless: true,
        channel: 'chromium',
        args: (process.env.CHROME_SW ? ['--disable-gpu', '--disable-accelerated-2d-canvas'] : []).concat([
            '--autoplay-policy=no-user-gesture-required',
            '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
            '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        ]),
    });
}

async function runScenario(context, sc) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => { if (errors.length < 2) errors.push(String(e) + ' @ ' + String(e.stack || '').split('\n').slice(0, 3).join(' | ')); });
    const decoded = (async () => { await page.waitForFunction(() => window.__trackChanged === true, null, { timeout: 15000 }).catch(() => {}); })();
    if (process.env.NOFILTER) {
        // Simulate a browser without CanvasRenderingContext2D.filter (Safari < 18) to exercise GlowLayer's fallback.
        await page.addInitScript(() => { Object.defineProperty(CanvasRenderingContext2D.prototype, 'filter', { get() { return undefined; }, set() {}, configurable: true }); });
    }
    await page.goto(BASE + '/?page=000-home.xjs&_pw=' + Date.now(), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.sbbsVisualizer && window.sbbsRadio && window.asciiStrobe, null, { timeout: 30000 });

    // Pre-init patches + instrumentation.
    await page.evaluate((sc) => {
        const _de = document.dispatchEvent.bind(document);
        document.dispatchEvent = function (ev) { if (ev && /^radio:track/.test(ev.type)) window.__trackChanged = true; return _de(ev); };
        const P = window.__prof = { byName: {}, bc: { n: 0, ms: 0 }, strobe: { n: 0, ms: 0 }, inst: null };
        const origRAF = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = function (cb) {
            if (sc.noMiniEq && cb.name === 'drawViz') return 0;
            return origRAF(function (ts) {
                const t0 = performance.now();
                cb(ts);
                const d = performance.now() - t0;
                const k = cb.name || 'anon';
                const s = P.byName[k] || (P.byName[k] = { n: 0, ms: 0, max: 0, over16: 0 });
                s.n++; s.ms += d; if (d > s.max) s.max = d; if (d > 16.7) s.over16++;
            });
        };
        if (sc.noText) {
            CanvasRenderingContext2D.prototype.fillText = function () {};
            CanvasRenderingContext2D.prototype.strokeText = function () {};
        }
        if (sc.noShadow) {
            Object.defineProperty(CanvasRenderingContext2D.prototype, 'shadowBlur',
                { get() { return 0; }, set() {}, configurable: true });
        }
        // Capture the Butterchurn instance so we can time or disable render().
        const BC = (typeof window.butterchurn.createVisualizer === 'function') ? window.butterchurn : window.butterchurn.default;
        const origCreate = BC.createVisualizer.bind(BC);
        BC.createVisualizer = function () {
            const inst = origCreate.apply(null, arguments);
            P.inst = inst;
            const origRender = inst.render.bind(inst);
            inst.render = sc.noBC ? function () {} : function () {
                const t0 = performance.now(); const r = origRender.apply(null, arguments);
                P.bc.n++; P.bc.ms += performance.now() - t0; return r;
            };
            return inst;
        };
        if (sc.synth) {
            const T0 = performance.now();
            const beat = () => { const t = (performance.now() - T0) / 1000; const b = (t * 2) % 1; return Math.exp(-b * 6); }; // 120 bpm kick
            AnalyserNode.prototype.getByteFrequencyData = function (arr) {
                const n = arr.length, k = beat(), t = (performance.now() - T0) / 1000;
                for (let i = 0; i < n; i++) {
                    const f = i / n;
                    const bass = f < 0.25 ? 200 * k : 0;
                    const mid  = (f >= 0.12 && f < 0.5) ? 90 + 60 * Math.sin(t * 7 + i) : 0;
                    const hi   = f >= 0.5 ? 40 + 50 * ((t * 4) % 1 < 0.1 ? 1 : 0) : 0;
                    arr[i] = Math.max(0, Math.min(255, (bass + mid + hi) * (1 - f * 0.4) + 20));
                }
            };
            AnalyserNode.prototype.getByteTimeDomainData = function (arr) {
                const t = (performance.now() - T0) / 1000, k = beat();
                for (let i = 0; i < arr.length; i++) arr[i] = 128 + 100 * k * Math.sin(i * 0.4 + t * 50) | 0;
            };
            window.__clockBase = T0; window.__clockOffset = 0;
            window.__synthClock = () => (performance.now() - window.__clockBase) / 1000 + window.__clockOffset;
        }
        const origTick = window.asciiStrobe.tick;
        window.asciiStrobe.tick = function () {
            const t0 = performance.now(); const r = origTick.apply(this, arguments);
            P.strobe.n++; P.strobe.ms += performance.now() - t0; return r;
        };
    }, sc);

    // User gesture, then play the chosen track and open the panel.
    await page.mouse.click(10, 10);
    await page.evaluate((t) => window.sbbsRadio.playByFile(t), TRACK);
    await page.waitForFunction(() => {
        const r = window.sbbsRadio; return r.audioCtx && isFinite(r.currentTime) && r.currentTime > 0.3;
    }, null, { timeout: 30000 }).catch(() => {});
    if (sc.synth) {
        // Wait for the track to decode so the .lrc is loaded, then drive the clock ourselves.
        await decoded.catch(() => {});
        await page.evaluate(() => {
            const r = window.sbbsRadio;
            try { Object.defineProperty(r, 'currentTime', { get: () => window.__synthClock(), configurable: true }); } catch (e) {}
            if (!r.analyserNode && r.audioCtx) { /* leave as is */ }
        });
    }
    await page.evaluate(() => window.sbbsVisualizer.show());
    await page.waitForTimeout(1500);
    await page.evaluate((sc) => {
        if (sc.noStrobe && window.asciiStrobe.isEnabled()) window.asciiStrobe.toggle();
        if (sc.lyricMode) window.sbbsVisualizer.setLyricMode(sc.lyricMode);
    }, sc);

    // Pin the lyric window by jumping the song clock FORWARD only (a backward jump gives effects a negative age).
    if (sc.synth) await page.evaluate((settle) => { const target = 20 - settle / 1000; const cur = window.__synthClock(); const base = performance.now(); window.__clockBase = base; window.__clockOffset = Math.max(cur, target); }, SETTLE_MS);
    await page.waitForTimeout(SETTLE_MS);
    if (process.env.SHOT) {
        const el = await page.$('.viz-canvas-container');
        await el.screenshot({ path: process.env.SHOT.replace('{s}', sc.name) });
    }
    // Reset counters, then sample.
    await page.evaluate(() => { const P = window.__prof; P.byName = {}; P.bc = { n: 0, ms: 0 }; P.strobe = { n: 0, ms: 0 }; P.t0 = performance.now(); if (window.GlowLayer && window.GlowLayer.instances) window.GlowLayer.instances.forEach(g => { g.stats.frames = 0; g.stats.ms = 0; }); });
    await page.waitForTimeout(SAMPLE_MS);
    const out = await page.evaluate(() => {
        const P = window.__prof; const el = performance.now() - P.t0;
        const r = window.sbbsRadio;
        let amp = 0;
        if (r.analyserNode) { const d = new Uint8Array(r.analyserNode.frequencyBinCount); r.analyserNode.getByteFrequencyData(d); amp = d.reduce((a, b) => a + b, 0) / (d.length * 255); }
        const tick = P.byName.tick || { n: 0, ms: 0, max: 0, over16: 0 };
        const dv = P.byName.drawViz || { n: 0, ms: 0, max: 0 };
        const wc = document.getElementById('viz-wireframe');
        return {
            elapsedMs: Math.round(el),
            fps: +(tick.n / (el / 1000)).toFixed(1),
            tickAvgMs: tick.n ? +(tick.ms / tick.n).toFixed(2) : 0,
            tickMaxMs: +tick.max.toFixed(1),
            tickOver16: tick.over16,
            bcAvgMs: P.bc.n ? +(P.bc.ms / P.bc.n).toFixed(2) : 0,
            strobeAvgMs: P.strobe.n ? +(P.strobe.ms / P.strobe.n).toFixed(2) : 0,
            miniEqFps: +(dv.n / (el / 1000)).toFixed(1),
            miniEqAvgMs: dv.n ? +(dv.ms / dv.n).toFixed(2) : 0,
            bcReady: !!P.inst,
            audioState: r.audioCtx ? r.audioCtx.state : 'none',
            amp: +amp.toFixed(3),
            strobeOn: window.asciiStrobe.isEnabled(),
            canvas: wc ? wc.width + 'x' + wc.height : 'none',
            dpr: window.devicePixelRatio,
            clock: +(r.currentTime || 0).toFixed(1),
            glowMs: (window.GlowLayer && window.GlowLayer.instances) ? window.GlowLayer.instances.map(g => g.stats.frames ? +(g.stats.ms / g.stats.frames).toFixed(2) : 0).join('/') : 'n/a',
        };
    });
    out.errors = errors.slice(0, 3);
    await page.close();
    return out;
}

(async () => {
    const browser = await launch();
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
    const resp = await context.request.post(BASE + '/api/auth.ssjs', { form: { username: USER, password: PASS } });
    if (!resp.ok()) throw new Error('login failed: ' + resp.status());

    // Environment report.
    const env = await (async () => {
        const p = await context.newPage();
        await p.goto(BASE + '/?page=000-home.xjs', { waitUntil: 'domcontentloaded' });
        const e = await p.evaluate(() => {
            const c = document.createElement('canvas'); const gl = c.getContext('webgl2');
            let renderer = 'no webgl2';
            if (gl) { const ext = gl.getExtension('WEBGL_debug_renderer_info'); renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); }
            return { ua: navigator.userAgent, renderer, dpr: window.devicePixelRatio, cores: navigator.hardwareConcurrency };
        });
        await p.close(); return e;
    })();
    console.log(JSON.stringify({ browser: BROWSER, env }, null, 1));

    const rows = [];
    for (const sc of SCENARIOS) {
        if (ONLY && !ONLY.includes(sc.name)) continue;
        try {
            if (SYNTH) sc.synth = true;
            const runs = [];
            for (let i = 0; i < REPEAT; i++) { const r = await runScenario(context, sc); runs.push(r); console.log(JSON.stringify(Object.assign({ scenario: sc.name, run: i }, r))); }
            const r = Object.assign({}, runs[0]);
            for (const k of ['fps', 'tickAvgMs', 'tickMaxMs', 'tickOver16', 'bcAvgMs', 'strobeAvgMs', 'miniEqFps', 'miniEqAvgMs']) r[k] = median(runs.map(x => x[k]));
            r.tickRange = Math.min(...runs.map(x => x.tickAvgMs)) + '-' + Math.max(...runs.map(x => x.tickAvgMs));
            rows.push(Object.assign({ scenario: sc.name }, r));
        } catch (e) {
            console.log(JSON.stringify({ scenario: sc.name, error: String(e).slice(0, 300) }));
        }
    }
    console.log('\nSUMMARY ' + BROWSER);
    console.log('scenario'.padEnd(22) + 'fps'.padStart(6) + 'tick ms'.padStart(9) + 'max'.padStart(7) + '>16ms'.padStart(7) + 'bc ms'.padStart(7) + 'strobe'.padStart(8) + 'eq fps'.padStart(8) + 'eq ms'.padStart(7) + '  glow ms  tick range (ms)');
    for (const r of rows) {
        console.log(r.scenario.padEnd(22) + String(r.fps).padStart(6) + String(r.tickAvgMs).padStart(9) + String(r.tickMaxMs).padStart(7) + String(r.tickOver16).padStart(7)
            + String(r.bcAvgMs).padStart(7) + String(r.strobeAvgMs).padStart(8) + String(r.miniEqFps).padStart(8) + String(r.miniEqAvgMs).padStart(7) + '  ' + String(r.glowMs).padEnd(8) + ' ' + r.tickRange + (r.bcReady ? '' : '  (no butterchurn)'));
    }
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
