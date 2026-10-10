// Terminal iframe page loaded standalone (no parent SPA), rlogin into the
// shell as the test user, with a sampling allocation profile to attribute
// retained memory to functions.
'use strict';
const { chromium } = require('playwright');
const BASE = process.env.PW_BASE || 'http://127.0.0.1:4080';
const USER = process.env.PW_USER, PASS = process.env.PW_PASS;
const PHASE_MS = parseInt(process.env.PHASE_MS || '100000', 10);
const SAMPLE_MS = 20000;

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 } });
    const resp = await context.request.post(BASE + '/api/auth.ssjs', { form: { username: USER, password: PASS } });
    const json = await resp.json(); if (!json || !json.authenticated) throw new Error('login failed');
    const html = await (await context.request.get(BASE + '/')).text();
    const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };
    const cfg = { ftelnetUrl: pick(/ftelnetUrl:\s*'([^']*)'/), ftelnetSplash: '', hostname: '127.0.0.1',
        wsp: +pick(/wsp:\s*(\d+)/), wssp: +pick(/wssp:\s*(\d+)/), telnetPort: +pick(/telnetPort:\s*(\d+)/), rloginPort: +pick(/rloginPort:\s*(\d+)/),
        isLoggedIn: true, userAlias: USER, userPassword: PASS, isSecure: false };
    console.log('cfg', JSON.stringify({ ...cfg, userPassword: cfg.userPassword ? '<set>' : null }));

    const page = await context.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable'); await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768 });
    await page.goto(BASE + '/terminal-iframe.html', { waitUntil: 'load' });
    await page.evaluate(() => {
        window.__created = {}; const orig = document.createElement;
        document.createElement = function (t) { t = String(t).toLowerCase(); window.__created[t] = (window.__created[t] || 0) + 1; return orig.apply(this, arguments); };
    });
    await page.evaluate((cfg) => window.postMessage({ cmd: 'init', config: cfg }, location.origin), cfg);
    await page.waitForFunction(() => window._ftClient && window._ftClient.Connected, null, { timeout: 40000 });
    await page.evaluate(() => { window.__rx = 0; window._ftClient.ondata.on(function (d) { window.__rx += d.length; }); });
    console.log('connected (rlogin)');
    await page.waitForTimeout(4000);
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(1500); }

    let lastRx = 0, lastT = Date.now();
    async function sample(label) {
        await cdp.send('HeapProfiler.collectGarbage'); await new Promise(r => setTimeout(r, 300));
        const m = (await cdp.send('Performance.getMetrics')).metrics; const g = n => { const x = m.find(e => e.name === n); return x ? x.value : NaN; };
        const i = await page.evaluate(() => {
            const c = window._ftClient, conn = c && c._Connection, crt = c && c._Crt, font = crt && crt._Font;
            return { connected: !!(c && c.Connected), bytesAvailable: conn ? conn.bytesAvailable : -1, charsMap: font ? font._CharsMapLru.length : -1,
                soundQueue: crt ? crt._PlaySoundQueue.length : -1, ariaDivs: document.querySelectorAll('canvas > div').length,
                attached: document.getElementsByTagName('*').length, canvases: window.__created.canvas || 0, rx: window.__rx };
        });
        const now = Date.now(); const rate = ((i.rx - lastRx) / ((now - lastT) / 1000)).toFixed(0); lastRx = i.rx; lastT = now;
        const row = { t: new Date().toISOString().slice(11, 19), phase: label, heapUsedMB: +(g('JSHeapUsedSize') / 1048576).toFixed(1), nodes: g('Nodes'), listeners: g('JSEventListeners'), rxBps: +rate, ...i };
        console.log(JSON.stringify(row)); return row;
    }
    const rows = [];
    async function phase(label, before) { if (before) { await before(); await page.waitForTimeout(1000); } const end = Date.now() + PHASE_MS; rows.push(await sample(label)); while (Date.now() < end) { await new Promise(r => setTimeout(r, SAMPLE_MS)); rows.push(await sample(label)); } }
    await phase('visible');
    await phase('hidden', () => page.evaluate(() => window.postMessage({ cmd: 'blur' }, location.origin)));
    await phase('restored', () => page.evaluate(() => window.postMessage({ cmd: 'focus' }, location.origin)));

    // Sampling profile: flatten to top self-size frames.
    await cdp.send('HeapProfiler.collectGarbage');
    const prof = (await cdp.send('HeapProfiler.getSamplingProfile')).profile;
    const flat = new Map();
    (function walk(n) { const f = n.callFrame; const key = (f.functionName || '(anon)') + ' @ ' + (f.url || '').split('/').pop().split('?')[0] + ':' + f.lineNumber + ':' + f.columnNumber; flat.set(key, (flat.get(key) || 0) + n.selfSize); (n.children || []).forEach(walk); })(prof.head);
    const top = [...flat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
    console.log('TOP RETAINED ALLOCATION SITES (sampled, post-GC):');
    for (const [k, v] of top) console.log('  ' + (v / 1048576).toFixed(1).padStart(6) + ' MB  ' + k);
    console.log('SUMMARY');
    for (const ph of ['visible', 'hidden', 'restored']) { const r = rows.filter(x => x.phase === ph); if (r.length < 2) continue; const a = r[0], b = r[r.length - 1];
        console.log(ph.padEnd(9), 'heap', a.heapUsedMB, '->', b.heapUsedMB, 'MB; nodes', a.nodes, '->', b.nodes, '; ariaDivs', a.ariaDivs, '->', b.ariaDivs, '; canvases', a.canvases, '->', b.canvases, '; rxBps', b.rxBps); }
    try { await page.evaluate(() => window._ftClient.Disconnect(false)); } catch (_) {}
    await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
