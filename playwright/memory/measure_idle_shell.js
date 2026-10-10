// Terminal iframe standalone, rlogin as the test user, Enter through logon
// (declining to read messages), confirm the shell is up by watching the cell
// buffer and the mouse-reporting flag, then idle so screensavers start.
'use strict';
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const BASE = process.env.PW_BASE || 'http://127.0.0.1:4080';
const USER = process.env.PW_USER, PASS = process.env.PW_PASS;
const TOTAL_MS = parseInt(process.env.TOTAL_MS || '900000', 10);
const SAMPLE_MS = 30000;
const PRUNE = process.env.PRUNE === '1';

function rss(browserPid) {
    const rows = execSync("ps -eo pid,ppid,rss,args").toString().split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(r => r.length > 3)
        .map(r => ({ pid: +r[0], ppid: +r[1], rss: +r[2], args: r.slice(3).join(' ') }));
    const byPid = new Map(rows.map(r => [r.pid, r]));
    function descends(r) { let p = r; for (let i = 0; i < 6 && p; i++) { if (p.pid === browserPid) return true; p = byPid.get(p.ppid); } return false; }
    let renderer = 0, gpu = 0; for (const r of rows) { if (!descends(r)) continue; if (r.args.includes('--type=renderer')) renderer += r.rss; else if (r.args.includes('--type=gpu-process')) gpu += r.rss; }
    return { rendererMB: Math.round(renderer / 1024), gpuMB: Math.round(gpu / 1024) };
}
const screenText = () => {
    const crt = window._ftClient && window._ftClient._Crt; if (!crt || !crt._Buffer) return [];
    const out = [];
    for (let y = 1; y <= crt._ScreenSize.y; y++) { let line = ''; for (let x = 1; x <= crt._ScreenSize.x; x++) { const c = crt._Buffer[y] && crt._Buffer[y][x]; line += c && c.Ch ? c.Ch : ' '; } out.push(line.replace(/\s+$/, '')); }
    return out;
};

(async () => {
    const before = new Set(execSync("pgrep -f chrom || true").toString().split(/\s+/).filter(Boolean).map(Number));
    const browser = await chromium.launch({ headless: true });
    const after = execSync("ps -eo pid,args").toString().split('\n').slice(1).map(l => l.trim().split(/\s+/))
        .filter(r => r.length > 1 && /chrom/.test(r[1]) && !before.has(+r[0]) && !r.slice(1).join(' ').includes('--type='));
    const browserPid = after.length ? +after[0][0] : -1;
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 900 } });
    const resp = await context.request.post(BASE + '/api/auth.ssjs', { form: { username: USER, password: PASS } });
    if (!(await resp.json()).authenticated) throw new Error('login failed');
    const html = await (await context.request.get(BASE + '/')).text();
    const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };
    const cfg = { ftelnetUrl: pick(/ftelnetUrl:\s*'([^']*)'/), ftelnetSplash: '', hostname: '127.0.0.1', wsp: +pick(/wsp:\s*(\d+)/), wssp: +pick(/wssp:\s*(\d+)/),
        telnetPort: +pick(/telnetPort:\s*(\d+)/), rloginPort: +pick(/rloginPort:\s*(\d+)/), isLoggedIn: true, userAlias: USER, userPassword: PASS, isSecure: false };

    const page = await context.newPage();
    page.on('pageerror', e => console.log('  [pageerror]', String(e).slice(0, 200)));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable'); await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 32768 });
    if (process.env.NEW_BUNDLE) await page.route(/ftelnet\.norip\.noxfer\.min\.js/, r => r.fulfill({ path: process.env.NEW_BUNDLE, contentType: 'application/javascript' }));
    await page.goto(BASE + '/terminal-iframe.html', { waitUntil: 'load' });
    await page.evaluate(() => { window.__created = {}; const orig = document.createElement; document.createElement = function (t) { t = String(t).toLowerCase(); window.__created[t] = (window.__created[t] || 0) + 1; return orig.apply(this, arguments); }; });
    await page.evaluate((cfg) => window.postMessage({ cmd: 'init', config: cfg }, location.origin), cfg);
    await page.waitForFunction(() => window._ftClient && window._ftClient.Connected, null, { timeout: 40000 });
    await page.evaluate(() => { window.__rx = 0; window._ftClient.ondata.on(function (d) { window.__rx += d.length; }); });
    if (PRUNE) await page.evaluate(() => { setInterval(() => { document.querySelectorAll('#fTelnetContainer canvas').forEach(c => { while (c.firstChild) c.removeChild(c.firstChild); }); }, 1000); });
    console.log('connected (rlogin)', PRUNE ? '[PRUNE divs]' : '[as-is]');
    await page.evaluate(() => { const cv = document.querySelector('#fTelnetContainer canvas'); if (cv) { cv.tabIndex = 0; cv.focus(); } });

    // Logon walk: press Enter (or N at a yes/no prompt) until the shell enables mouse reporting.
    const t0 = Date.now(); let inShell = false;
    while (Date.now() - t0 < 120000) {
        await page.waitForTimeout(2500);
        const st = await page.evaluate(() => ({ mouse: !!(window._ftClient && window._ftClient._Crt && window._ftClient._Crt._ReportMouse), lines: (window.__st || (window.__st = null), null) }));
        const lines = await page.evaluate(screenText);
        const nonEmpty = lines.filter(l => l.trim()); const tail = nonEmpty.slice(-3).join(' | ').slice(0, 200);
        const head = lines.slice(0, 2).join('');
        if (/\xDA\xC4{6,}|\xC9\xCD{6,}/.test(head) && st.mouse) { inShell = true; console.log('shell detected (frame + mouse) after', Math.round((Date.now() - t0) / 1000), 's:', tail); break; }
        const joined = nonEmpty.join('\n');
        const yn = /\(Y\/N\)|\[Y\/N\]|\[Y,N\]|\(Y,N\)|Yes\/No|\bY\/n\b|\by\/N\b|N done/i.test(joined);
        const quit = /Q\)uit/i.test(joined);
        const key = yn ? 'n' : (quit ? 'q' : 'Enter');
        console.log('  key', key, '::', tail);
        await page.keyboard.press(key);
    }
    if (!inShell) console.log('WARNING: shell not detected within 120 s; idling anyway');

    let lastRx = 0, lastT = Date.now(); const rows = [];
    async function sample() {
        await cdp.send('HeapProfiler.collectGarbage'); await new Promise(r => setTimeout(r, 300));
        const m = (await cdp.send('Performance.getMetrics')).metrics; const g = n => { const x = m.find(e => e.name === n); return x ? x.value : NaN; };
        const i = await page.evaluate(() => { const c = window._ftClient, conn = c && c._Connection, crt = c && c._Crt, font = crt && crt._Font;
            return { connected: !!(c && c.Connected), mouse: !!(crt && crt._ReportMouse), bytesAvailable: conn ? conn.bytesAvailable : -1, charsMap: font ? font._CharsMapLru.length : -1, charMap: font ? font._CharMapLru.length : -1,
                soundQueue: crt ? crt._PlaySoundQueue.length : -1, ariaDivs: document.querySelectorAll('canvas > div').length, attached: document.getElementsByTagName('*').length, canvases: window.__created.canvas || 0, rx: window.__rx }; });
        const lines = await page.evaluate(screenText); const top = lines.filter(l => l.trim())[0] || '';
        const now = Date.now(); const rate = Math.round((i.rx - lastRx) / ((now - lastT) / 1000)); lastRx = i.rx; lastT = now;
        const row = { t: new Date().toISOString().slice(11, 19), min: +((now - t0) / 60000).toFixed(1), heapMB: +(g('JSHeapUsedSize') / 1048576).toFixed(1), nodes: g('Nodes'), ...rss(browserPid), rxBps: rate, ...i, top: top.slice(0, 60) };
        console.log(JSON.stringify(row)); rows.push(row); return row;
    }
    const end = Date.now() + TOTAL_MS; await sample();
    while (Date.now() < end) { await new Promise(r => setTimeout(r, SAMPLE_MS)); await sample(); }

    await cdp.send('HeapProfiler.collectGarbage');
    const prof = (await cdp.send('HeapProfiler.getSamplingProfile')).profile; const flat = new Map();
    (function walk(n) { const f = n.callFrame; const key = (f.functionName || '(anon)') + ' @ ' + (f.url || '').split('/').pop().split('?')[0] + ':' + f.lineNumber; flat.set(key, (flat.get(key) || 0) + n.selfSize); (n.children || []).forEach(walk); })(prof.head);
    console.log('TOP RETAINED ALLOCATION SITES:'); for (const [k, v] of [...flat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log('  ' + (v / 1048576).toFixed(1).padStart(6) + ' MB  ' + k);
    const a = rows[0], b = rows[rows.length - 1];
    console.log('SUMMARY', PRUNE ? 'pruned' : 'as-is', 'over', b.min, 'min: heap', a.heapMB, '->', b.heapMB, 'MB; renderer', a.rendererMB, '->', b.rendererMB, 'MB; gpu', a.gpuMB, '->', b.gpuMB, 'MB; nodes', a.nodes, '->', b.nodes, '; ariaDivs', a.ariaDivs, '->', b.ariaDivs, '; canvases', a.canvases, '->', b.canvases, '; peak rxBps', Math.max(...rows.map(r => r.rxBps)));
    try { await page.evaluate(() => window._ftClient.Disconnect(false)); } catch (_) {}
    await browser.close();
})().catch(e => { console.error('FAILED', e); process.exit(1); });
