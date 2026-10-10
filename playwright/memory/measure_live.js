// Logs into the real web UI, opens the terminal (rlogin into the shell) and
// samples memory through visible / hidden / restored / toggle phases.
'use strict';
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const BASE = process.env.PW_BASE || 'http://127.0.0.1:4080';
const USER = process.env.PW_USER, PASS = process.env.PW_PASS;
const PHASE_MS = parseInt(process.env.PHASE_MS || '100000', 10);
const SAMPLE_MS = 20000;

function rendererRss(browserPid) {
    const rows = execSync("ps -eo pid,ppid,rss,args").toString().split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(r => r.length > 3)
        .map(r => ({ pid: +r[0], ppid: +r[1], rss: +r[2], args: r.slice(3).join(' ') }));
    const byPid = new Map(rows.map(r => [r.pid, r]));
    function descends(r) { let p = r; for (let i = 0; i < 6 && p; i++) { if (p.pid === browserPid) return true; p = byPid.get(p.ppid); } return false; }
    let renderer = 0, gpu = 0;
    for (const r of rows) { if (!descends(r)) continue; if (r.args.includes('--type=renderer')) renderer += r.rss; else if (r.args.includes('--type=gpu-process')) gpu += r.rss; }
    return { rendererKB: renderer, gpuKB: gpu };
}

(async () => {
    const before = new Set(execSync("pgrep -f chrom || true").toString().split(/\s+/).filter(Boolean).map(Number));
    const browser = await chromium.launch({ headless: true });
    const after = execSync("ps -eo pid,args").toString().split('\n').slice(1).map(l => l.trim().split(/\s+/))
        .filter(r => r.length > 1 && /chrom/.test(r[1]) && !before.has(+r[0]) && !r.slice(1).join(' ').includes('--type='));
    const browserPid = after.length ? +after[0][0] : -1;
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 } });
    const resp = await context.request.post(BASE + '/api/auth.ssjs', { form: { username: USER, password: PASS } });
    const json = await resp.json();
    if (!json || !json.authenticated) throw new Error('login failed: ' + JSON.stringify(json));
    console.log('logged in as', USER);

    const page = await context.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForSelector('#btn-terminal', { timeout: 30000 });
    await page.click('#btn-terminal');
    const frameHandle = await page.waitForSelector('#terminal-iframe', { timeout: 30000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => window._ftClient && window._ftClient.Connected, null, { timeout: 40000 });
    await frame.evaluate(() => {
        window.__created = {}; const orig = document.createElement;
        document.createElement = function (t) { t = String(t).toLowerCase(); window.__created[t] = (window.__created[t] || 0) + 1; return orig.apply(this, arguments); };
        window.__rx = 0; window._ftClient.ondata.on(function (d) { window.__rx += d.length; });
    });
    console.log('terminal connected');
    // Get past any press-a-key logon screens.
    await page.waitForTimeout(4000);
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(1500); }

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable'); await cdp.send('HeapProfiler.enable');

    let lastRx = 0, lastT = Date.now();
    async function sample(label) {
        await cdp.send('HeapProfiler.collectGarbage'); await new Promise(r => setTimeout(r, 300));
        const m = (await cdp.send('Performance.getMetrics')).metrics;
        const g = n => { const x = m.find(e => e.name === n); return x ? x.value : NaN; };
        const i = await frame.evaluate(() => {
            const c = window._ftClient; const conn = c && c._Connection; const crt = c && c._Crt; const font = crt && crt._Font;
            return {
                connected: !!(c && c.Connected), termType: c && c._Options ? c._Options.RLoginTerminalType : '',
                bytesAvailable: conn ? conn.bytesAvailable : -1, bufBacking: conn && conn._InputBuffer ? conn._InputBuffer._Bytes.length : -1,
                charsMap: font ? font._CharsMapLru.length : -1, charMap: font ? font._CharMapLru.length : -1,
                soundQueue: crt ? crt._PlaySoundQueue.length : -1, audio: crt && crt._AudioContext ? crt._AudioContext.state : 'none',
                canvas: crt && crt._Canvas ? crt._Canvas.width + 'x' + crt._Canvas.height : '',
                ariaDivs: document.querySelectorAll('canvas > div').length, attached: document.getElementsByTagName('*').length,
                created: window.__created, rx: window.__rx
            };
        });
        const now = Date.now(); const rate = ((i.rx - lastRx) / ((now - lastT) / 1000)).toFixed(0); lastRx = i.rx; lastT = now;
        const rss = rendererRss(browserPid);
        const row = { t: new Date().toISOString().slice(11, 19), phase: label, heapUsedMB: +(g('JSHeapUsedSize') / 1048576).toFixed(1), nodes: g('Nodes'), listeners: g('JSEventListeners'),
            rendererMB: +(rss.rendererKB / 1024).toFixed(0), gpuMB: +(rss.gpuKB / 1024).toFixed(0), rxBps: +rate, ...i, created: JSON.stringify({ canvas: i.created.canvas || 0, div: i.created.div || 0 }) };
        console.log(JSON.stringify(row)); return row;
    }
    const rows = [];
    async function phase(label, before) {
        if (before) { await before(); await page.waitForTimeout(1500); }
        const end = Date.now() + PHASE_MS; rows.push(await sample(label));
        while (Date.now() < end) { await new Promise(r => setTimeout(r, SAMPLE_MS)); rows.push(await sample(label)); }
    }
    await phase('visible');
    await phase('hidden', () => page.evaluate(() => window.sbbsTerminal.hide()));
    await phase('restored', () => page.evaluate(() => window.sbbsTerminal.show()));
    await phase('toggle-churn', async () => {
        for (let k = 0; k < 12; k++) {
            await page.evaluate(() => window.sbbsTerminal.hide()); await page.waitForTimeout(900);
            await page.evaluate(() => window.sbbsTerminal.show()); await page.waitForTimeout(900);
        }
    });
    console.log('SUMMARY');
    for (const ph of ['visible', 'hidden', 'restored', 'toggle-churn']) {
        const r = rows.filter(x => x.phase === ph); if (r.length < 2) continue; const a = r[0], b = r[r.length - 1];
        console.log(ph.padEnd(13), 'heap', a.heapUsedMB, '->', b.heapUsedMB, 'MB; renderer', a.rendererMB, '->', b.rendererMB, 'MB; gpu', a.gpuMB, '->', b.gpuMB, 'MB; nodes', a.nodes, '->', b.nodes, '; ariaDivs', a.ariaDivs, '->', b.ariaDivs, '; canvasesCreated', JSON.parse(a.created).canvas, '->', JSON.parse(b.created).canvas, '; soundQ', a.soundQueue, '->', b.soundQueue, '; rxBps', b.rxBps);
    }
    try { await frame.evaluate(() => window._ftClient.Disconnect(false)); } catch (_) {}
    await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
