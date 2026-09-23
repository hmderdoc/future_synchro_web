const { test, expect } = require('@playwright/test');

// The kill-switch worker at ./sw.js must rescue clients stuck on the legacy
// registration: wipe every cache, unregister itself, reload the window, and
// let the fresh page register the live worker (./sw.ssjs).
test.describe('sw.js kill-switch rescue', function () {
    test.skip(!process.env.PW_SITE_URL, 'PW_SITE_URL is required');

    test('legacy ./sw.js registration self-destructs and recovers the page', async function ({ browser }) {
        const baseUrl = process.env.PW_SITE_URL.replace(/\/+$/, '');
        // Service workers ENABLED — this test exercises the real SW lifecycle.
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();
        const swLogs = [];
        page.on('console', function (msg) {
            if (/\[SW\]|serviceworker|sw\.js|sw\.ssjs/i.test(msg.text())) swLogs.push(msg.text());
        });

        await page.goto(baseUrl + '/?page=000-home.xjs&_pw=' + Date.now(), {
            waitUntil: 'load'
        });

        // Let the normal sw.ssjs registration (and its controllerchange
        // reload) settle before simulating the stuck state.
        await page.waitForFunction(function () {
            return !!navigator.serviceWorker.controller &&
                   window.tdfBrowser && window.tdfBrowser.isReady();
        }, null, { timeout: 90000 });

        // Simulate the stuck legacy client: an ancient cache full of junk,
        // and the scope's registration pointed back at ./sw.js.  The site's
        // controllerchange handler reloads the page right after first SW
        // activation, which can race this evaluate — retry through it.
        for (let attempt = 0; ; attempt++) {
            try {
                await page.evaluate(async function () {
                    const c = await caches.open('futureland-ancient-junk');
                    await c.put(new Request('./junk-entry'), new Response('stale shell'));
                    await navigator.serviceWorker.register('./sw.js');
                });
                break;
            } catch (e) {
                if (attempt >= 3 || String(e).indexOf('Execution context was destroyed') === -1) throw e;
                await page.waitForLoadState('load');
                await page.waitForFunction(function () {
                    return window.tdfBrowser && window.tdfBrowser.isReady();
                }, null, { timeout: 90000 });
            }
        }

        // The rescue worker installs (skipWaiting), claims, wipes caches,
        // unregisters, and navigates the window. Poll until the origin is
        // clean: junk cache gone and no registration pointing at sw.js.
        await page.waitForFunction(async function () {
            const names = await caches.keys();
            if (names.indexOf('futureland-ancient-junk') !== -1) return false;
            const regs = await navigator.serviceWorker.getRegistrations();
            return regs.every(function (r) {
                const w = r.active || r.waiting || r.installing;
                return !w || w.scriptURL.indexOf('sw.js') === -1 ||
                       w.scriptURL.indexOf('sw.ssjs') !== -1;
            });
        }, null, { timeout: 90000 });

        // Full recovery: the (reloaded) page runs the current shell — TDF
        // loader present and ready, fonts renderable.
        await page.waitForFunction(function () {
            return window.tdfBrowser && window.tdfBrowser.isReady();
        }, null, { timeout: 90000 });

        const state = await page.evaluate(async function () {
            const regs = await navigator.serviceWorker.getRegistrations();
            const sample = window.tdfBrowser.render('TEST', 5);
            return {
                registrations: regs.map(function (r) {
                    const w = r.active || r.waiting || r.installing;
                    return w ? w.scriptURL : null;
                }),
                cacheNames: await caches.keys(),
                rendered: !!(sample && sample.rows.length)
            };
        });

        console.log('post-rescue state:', JSON.stringify(state, null, 2));
        console.log('sw logs:', JSON.stringify(swLogs, null, 2));

        expect(state.registrations.every(function (u) {
            return u === null || u.indexOf('sw.ssjs') !== -1;
        }), 'no registration may point at legacy sw.js').toBeTruthy();
        expect(state.cacheNames.indexOf('futureland-ancient-junk')).toBe(-1);
        expect(state.rendered).toBeTruthy();
        await context.close();
    });
});
