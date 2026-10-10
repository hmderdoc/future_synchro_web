// Baseline: logged-in SPA with the terminal never opened.
'use strict';
const { chromium } = require('playwright');
const BASE = process.env.PW_BASE || 'http://127.0.0.1:4080';
const USER = process.env.PW_USER, PASS = process.env.PW_PASS;
const TOTAL_MS = parseInt(process.env.TOTAL_MS || '240000', 10);
(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 } });
    const resp = await context.request.post(BASE + '/api/auth.ssjs', { form: { username: USER, password: PASS } });
    const json = await resp.json(); if (!json || !json.authenticated) throw new Error('login failed');
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable'); await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768 });
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.waitForSelector('#btn-terminal', { timeout: 30000 });
    const end = Date.now() + TOTAL_MS;
    while (true) {
        await cdp.send('HeapProfiler.collectGarbage'); await new Promise(r => setTimeout(r, 300));
        const m = (await cdp.send('Performance.getMetrics')).metrics; const g = n => { const x = m.find(e => e.name === n); return x ? x.value : NaN; };
        const attached = await page.evaluate(() => document.getElementsByTagName('*').length);
        console.log(JSON.stringify({ t: new Date().toISOString().slice(11, 19), phase: 'spa-only', heapUsedMB: +(g('JSHeapUsedSize') / 1048576).toFixed(1), nodes: g('Nodes'), listeners: g('JSEventListeners'), attached }));
        if (Date.now() >= end) break;
        await new Promise(r => setTimeout(r, 20000));
    }
    const prof = (await cdp.send('HeapProfiler.getSamplingProfile')).profile;
    const flat = new Map();
    (function walk(n) { const f = n.callFrame; const key = (f.functionName || '(anon)') + ' @ ' + (f.url || '').split('/').pop().split('?')[0] + ':' + f.lineNumber; flat.set(key, (flat.get(key) || 0) + n.selfSize); (n.children || []).forEach(walk); })(prof.head);
    console.log('TOP RETAINED ALLOCATION SITES (spa-only):');
    for (const [k, v] of [...flat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log('  ' + (v / 1048576).toFixed(1).padStart(6) + ' MB  ' + k);
    await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
