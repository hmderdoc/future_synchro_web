const { test, expect } = require('@playwright/test');

// Debug: why is the visualizer not showing TheDraw (TDF) fonts?
// Cold-cache run: fresh context, no service worker, empty IndexedDB —
// same as a user whose browser storage was cleared.
test.describe('tdf font pipeline', function () {
    test.skip(!process.env.PW_SITE_URL, 'PW_SITE_URL is required');

    test('tdf-browser loads fonts and renders on a cold cache', async function ({ browser }) {
        const baseUrl = process.env.PW_SITE_URL.replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block'
        });
        const page = await context.newPage();

        const consoleMsgs = [];
        const pageErrors = [];
        const failedRequests = [];
        page.on('console', function (msg) {
            const text = msg.text();
            if (/\[tdf\]|\[viz|tdf-serve|error/i.test(text)) consoleMsgs.push(msg.type() + ': ' + text);
        });
        page.on('pageerror', function (e) { pageErrors.push(String(e)); });
        page.on('requestfailed', function (req) {
            failedRequests.push(req.url() + ' — ' + (req.failure() ? req.failure().errorText : '?'));
        });
        page.on('response', function (res) {
            if (res.url().indexOf('tdf-serve') !== -1 && res.status() !== 200) {
                failedRequests.push('HTTP ' + res.status() + ' ' + res.url());
            }
        });

        await page.goto(baseUrl + '/?page=000-home.xjs&_pw=' + Date.now(), {
            waitUntil: 'domcontentloaded'
        });

        // Is the loader even present?
        const hasLoader = await page.waitForFunction(function () {
            return !!window.tdfBrowser;
        }, null, { timeout: 15000 }).catch(function () { return null; });

        if (!hasLoader) {
            console.log('FAIL: window.tdfBrowser never appeared');
            console.log('console:', JSON.stringify(consoleMsgs, null, 2));
            console.log('pageErrors:', JSON.stringify(pageErrors, null, 2));
            console.log('failedRequests:', JSON.stringify(failedRequests, null, 2));
            expect(hasLoader).toBeTruthy();
            return;
        }

        // Wait for init to finish (isReady flips true after map + initial pool)
        const becameReady = await page.waitForFunction(function () {
            return window.tdfBrowser.isReady();
        }, null, { timeout: 30000 }).catch(function () { return null; });

        const state = await page.evaluate(function () {
            const t = window.tdfBrowser;
            const pools = {};
            for (let h = 3; h <= 12; h++) pools[h] = t.poolSize(h);
            let sample = null, renderError = null;
            try {
                sample = t.render('TEST', 5) || t.render('TEST', 4) || t.render('TEST', 3);
            } catch (e) { renderError = String(e); }
            return {
                ready: t.isReady(),
                pools: pools,
                sampleFont: sample ? sample.fontName : null,
                sampleRows: sample ? sample.rows.length : 0,
                renderError: renderError,
                strobePresent: !!window.asciiStrobe,
                strobeEnabled: !!(window.asciiStrobe && window.asciiStrobe.isEnabled())
            };
        });

        console.log('became ready:', !!becameReady);
        console.log('state:', JSON.stringify(state, null, 2));
        console.log('tdf/viz console:', JSON.stringify(consoleMsgs, null, 2));
        console.log('pageErrors:', JSON.stringify(pageErrors, null, 2));
        console.log('failedRequests:', JSON.stringify(failedRequests, null, 2));

        expect(state.ready).toBeTruthy();
        expect(state.sampleRows).toBeGreaterThan(0);
        await context.close();
    });

    test('stale IndexedDB cache (fonts absent from map) still fills pools', async function ({ browser }) {
        const baseUrl = process.env.PW_SITE_URL.replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block'
        });
        const page = await context.newPage();
        const tdfLogs = [];
        page.on('console', function (msg) {
            if (msg.text().indexOf('[tdf]') !== -1) tdfLogs.push(msg.text());
        });

        await page.goto(baseUrl + '/?page=000-home.xjs&_pw=' + Date.now(), {
            waitUntil: 'domcontentloaded'
        });
        await page.waitForFunction(function () {
            return window.tdfBrowser && window.tdfBrowser.isReady();
        }, null, { timeout: 30000 });

        // Replace the entire font cache with 35 entries that parse as valid
        // TDF data but whose names do not exist in the current font map —
        // the state a regenerated figlet_font_map.json leaves behind.
        await page.evaluate(async function () {
            const res = await fetch('./api/tdf-serve.ssjs?font=aaa');
            const json = await res.json();
            const db = await new Promise(function (resolve, reject) {
                const req = indexedDB.open('tdf-font-cache', 1);
                req.onsuccess = function (e) { resolve(e.target.result); };
                req.onerror = function () { reject(req.error); };
            });
            await new Promise(function (resolve, reject) {
                const tx = tx_store(db);
                function tx_store(db) {
                    const t = db.transaction('fonts', 'readwrite');
                    const st = t.objectStore('fonts');
                    st.clear();
                    for (let i = 0; i < 35; i++) st.put(json.b64, 'zz-stale-' + i);
                    return t;
                }
                tx.oncomplete = resolve;
                tx.onerror = function () { reject(tx.error); };
            });
            db.close();
        });

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(function () {
            return window.tdfBrowser && window.tdfBrowser.isReady();
        }, null, { timeout: 30000 });

        const state = await page.evaluate(function () {
            const t = window.tdfBrowser;
            const pools = {};
            for (let h = 3; h <= 12; h++) pools[h] = t.poolSize(h);
            const sample = t.render('TEST', 5);
            return { pools: pools, rendered: !!(sample && sample.rows.length) };
        });

        console.log('post-stale-cache state:', JSON.stringify(state, null, 2));
        console.log('tdf logs:', JSON.stringify(tdfLogs, null, 2));

        for (let h = 3; h <= 12; h++) {
            expect(state.pools[h], 'tier ' + h + ' pool empty after stale cache').toBeGreaterThan(0);
        }
        expect(state.rendered).toBeTruthy();
        await context.close();
    });
});
