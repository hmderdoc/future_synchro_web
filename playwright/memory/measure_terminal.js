// Drives the real terminal-iframe.html against the local ANSI WebSocket
// server and samples memory through three phases: visible, panel-hidden
// (host sends 'blur'), restored (host sends 'focus' -> FastForward).
'use strict';
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const BASE = process.env.PW_BASE || 'http://127.0.0.1:4080';
const WS_PORT = parseInt(process.env.WS_PORT || '18777', 10);
const PHASE_MS = parseInt(process.env.PHASE_MS || '120000', 10);
const SAMPLE_MS = 15000;

function rendererRss(browserPid) {
    // Sum RSS of chromium renderer + gpu processes descended from the browser pid.
    const out = execSync("ps -eo pid,ppid,rss,args").toString().split('\n').slice(1);
    const rows = out.map(l => l.trim().split(/\s+/)).filter(r => r.length > 3)
        .map(r => ({ pid: +r[0], ppid: +r[1], rss: +r[2], args: r.slice(3).join(' ') }));
    const byPid = new Map(rows.map(r => [r.pid, r]));
    function descends(r) { let p = r; for (let i = 0; i < 6 && p; i++) { if (p.pid === browserPid) return true; p = byPid.get(p.ppid); } return false; }
    let renderer = 0, gpu = 0, browser = 0;
    for (const r of rows) {
        if (!descends(r) && r.pid !== browserPid) continue;
        if (r.args.includes('--type=renderer')) renderer += r.rss;
        else if (r.args.includes('--type=gpu-process')) gpu += r.rss;
        else if (r.pid === browserPid) browser += r.rss;
    }
    return { rendererKB: renderer, gpuKB: gpu, browserKB: browser };
}

(async () => {
    const before = new Set(execSync("pgrep -f chrom || true").toString().split(/\s+/).filter(Boolean).map(Number));
    const browser = await chromium.launch({ headless: true });
    const after = execSync("ps -eo pid,args").toString().split('\n').slice(1).map(l => l.trim().split(/\s+/))
        .filter(r => r.length > 1 && /chrom/.test(r[1]) && !before.has(+r[0]) && !r.slice(1).join(' ').includes('--type='));
    const browserPid = after.length ? +after[0][0] : -1;
    console.log('browser pid', browserPid);
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('console', m => { const t = m.text(); if (/\[ws\]|error|Error/.test(t)) console.log('  [page]', t.slice(0, 160)); });
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));

    if (process.env.NEW_BUNDLE) await page.route(/ftelnet\.norip\.noxfer\.min\.js/, r => r.fulfill({ path: process.env.NEW_BUNDLE, contentType: 'application/javascript' }));
    await page.goto(BASE + '/terminal-iframe.html', { waitUntil: 'load' });
    await page.evaluate(() => {
        window.__created = {}; const orig = document.createElement;
        document.createElement = function (t) { t = String(t).toLowerCase(); window.__created[t] = (window.__created[t] || 0) + 1; return orig.apply(this, arguments); };
    });
    // Act as the parent: send init pointing at our local WS server.
    await page.evaluate((wsPort) => {
        window.postMessage({ cmd: 'init', config: {
            ftelnetUrl: 'ftelnet/ftelnet.norip.noxfer.min.js', ftelnetSplash: '',
            hostname: '127.0.0.1', wsp: wsPort, wssp: wsPort, telnetPort: 23, rloginPort: 1513,
            isLoggedIn: false, userAlias: '', userPassword: '', isSecure: false } }, location.origin);
    }, WS_PORT);

    // Wait for the client to exist and connect.
    await page.waitForFunction(() => window._ftClient && window._ftClient.Connected, null, { timeout: 30000 });
    console.log('connected');

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');

    async function sample(label) {
        await cdp.send('HeapProfiler.collectGarbage');
        await new Promise(r => setTimeout(r, 300));
        const m = (await cdp.send('Performance.getMetrics')).metrics;
        const g = n => { const x = m.find(e => e.name === n); return x ? x.value : NaN; };
        const internals = await page.evaluate(() => {
            const c = window._ftClient; const conn = c && c._Connection; const crt = c && c._Crt; const font = crt && crt._Font;
            const cv = crt && crt._Canvas;
            return {
                connected: !!(c && c.Connected),
                bytesAvailable: conn ? conn.bytesAvailable : -1,
                inputBufBacking: conn && conn._InputBuffer ? conn._InputBuffer._Bytes.length : -1,
                charMap: font ? font._CharMapLru.length : -1,
                charsMap: font ? font._CharsMapLru.length : -1,
                soundQueue: crt ? crt._PlaySoundQueue.length : -1,
                scrollbackRows: crt && crt._Scrollback ? crt._Scrollback.length : -1,
                canvas: cv ? cv.width + 'x' + cv.height : '',
                modernScrollback: c ? !!c._UseModernScrollback : null,
                audioState: crt && crt._AudioContext ? crt._AudioContext.state : 'none',
                attached: document.getElementsByTagName('*').length,
                created: JSON.stringify(window.__created)
            };
        });
        const rss = rendererRss(browserPid);
        const row = {
            t: new Date().toISOString().slice(11, 19), phase: label,
            heapUsedMB: +(g('JSHeapUsedSize') / 1048576).toFixed(1), heapTotalMB: +(g('JSHeapTotalSize') / 1048576).toFixed(1),
            nodes: g('Nodes'), listeners: g('JSEventListeners'),
            rendererMB: +(rss.rendererKB / 1024).toFixed(0), gpuMB: +(rss.gpuKB / 1024).toFixed(0),
            ...internals
        };
        console.log(JSON.stringify(row));
        return row;
    }

    const rows = [];
    async function phase(label, before) {
        if (before) await before();
        const end = Date.now() + PHASE_MS;
        rows.push(await sample(label));
        while (Date.now() < end) { await new Promise(r => setTimeout(r, SAMPLE_MS)); rows.push(await sample(label)); }
    }

    await phase('visible');
    await phase('hidden', () => page.evaluate(() => window.postMessage({ cmd: 'blur' }, location.origin)));
    await phase('restored', () => page.evaluate(() => window.postMessage({ cmd: 'focus' }, location.origin)));
    // Toggle churn: 20 rapid hide/show cycles, then settle.
    await phase('toggle-churn', async () => {
        for (let i = 0; i < 20; i++) {
            await page.evaluate(() => window.postMessage({ cmd: 'blur' }, location.origin));
            await new Promise(r => setTimeout(r, 400));
            await page.evaluate(() => { window.postMessage({ cmd: 'focus' }, location.origin); window.postMessage({ cmd: 'resize' }, location.origin); window.postMessage({ cmd: 'refit' }, location.origin); });
            await new Promise(r => setTimeout(r, 400));
        }
    });

    console.log('SUMMARY');
    for (const ph of ['visible', 'hidden', 'restored', 'toggle-churn']) {
        const r = rows.filter(x => x.phase === ph);
        if (r.length < 2) continue;
        const a = r[0], b = r[r.length - 1];
        console.log(ph.padEnd(13), 'heapUsed', a.heapUsedMB, '->', b.heapUsedMB, 'MB;', 'renderer', a.rendererMB, '->', b.rendererMB, 'MB;', 'gpu', a.gpuMB, '->', b.gpuMB, 'MB;', 'nodes', a.nodes, '->', b.nodes, '; listeners', a.listeners, '->', b.listeners, '; soundQ', a.soundQueue, '->', b.soundQueue, '; bufBacking', a.inputBufBacking, '->', b.inputBufBacking);
    }
    await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
