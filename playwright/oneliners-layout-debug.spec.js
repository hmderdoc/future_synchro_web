const { test, expect } = require('@playwright/test');

const SITE_URL = process.env.PW_SITE_URL;
const SITE_USERNAME = process.env.PW_SITE_USERNAME;
const SITE_PASSWORD = process.env.PW_SITE_PASSWORD;

function requireEnv(name) {
    if (!process.env[name]) {
        throw new Error('Missing required env var: ' + name);
    }
    return process.env[name];
}

async function loginViaApi(context) {
    const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
    const username = requireEnv('PW_SITE_USERNAME');
    const password = requireEnv('PW_SITE_PASSWORD');
    const response = await context.request.post(baseUrl + '/api/auth.ssjs', {
        form: {
            username: username,
            password: password
        }
    });
    expect(response.ok()).toBeTruthy();
    const json = await response.json();
    expect(json && json.authenticated).toBeTruthy();
}

test.describe('one-liners layout debug', function () {
    test.skip(!SITE_URL || !SITE_USERNAME || !SITE_PASSWORD,
        'PW_SITE_URL, PW_SITE_USERNAME, and PW_SITE_PASSWORD are required');

    test('feed renders as cards and scrolls internally', async function ({ browser }, testInfo) {
        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block'
        });
        const page = await context.newPage();

        await loginViaApi(context);
        await page.goto(baseUrl + '/?page=004-oneliners.xjs&_pw=' + Date.now(), {
            waitUntil: 'domcontentloaded'
        });

        await expect(page.locator('#ol-post-card')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('#ol-list .ol-card, #ol-list .ol-row').first()).toBeVisible({ timeout: 30000 });

        const before = await page.evaluate(function () {
            const firstEntry = document.querySelector('#ol-list .ol-card, #ol-list .ol-row');
            const alias = firstEntry ? firstEntry.querySelector('.ol-alias') : null;
            const viewport = document.getElementById('ol-feed-viewport');
            const sidebar = document.getElementById('sidebar');
            const postCard = document.getElementById('ol-post-card');
            return {
                firstEntryBackground: firstEntry ? getComputedStyle(firstEntry).backgroundColor : null,
                firstEntryBorder: firstEntry ? getComputedStyle(firstEntry).border : null,
                aliasColor: alias ? getComputedStyle(alias).color : null,
                viewportOverflow: viewport ? getComputedStyle(viewport).overflowY : null,
                viewportScrollTop: viewport ? viewport.scrollTop : null,
                windowScrollY: window.scrollY,
                sidebarTop: sidebar ? sidebar.getBoundingClientRect().top : null,
                postBottom: postCard ? postCard.getBoundingClientRect().bottom : null
            };
        });

        await page.evaluate(function () {
            const viewport = document.getElementById('ol-feed-viewport');
            if (viewport) viewport.scrollTop = 900;
        });
        await page.waitForTimeout(250);

        const after = await page.evaluate(function () {
            const firstEntry = document.querySelector('#ol-list .ol-card, #ol-list .ol-row');
            const viewport = document.getElementById('ol-feed-viewport');
            const sidebar = document.getElementById('sidebar');
            const postCard = document.getElementById('ol-post-card');
            const firstRect = firstEntry ? firstEntry.getBoundingClientRect() : null;
            return {
                viewportScrollTop: viewport ? viewport.scrollTop : null,
                windowScrollY: window.scrollY,
                sidebarTop: sidebar ? sidebar.getBoundingClientRect().top : null,
                firstEntryTop: firstRect ? firstRect.top : null,
                postBottom: postCard ? postCard.getBoundingClientRect().bottom : null
            };
        });

        const shot = testInfo.outputPath('oneliners-layout.png');
        await page.screenshot({ path: shot, fullPage: true });

        console.log('PLAYWRIGHT_ONELINERS_LAYOUT=' + JSON.stringify({
            before: before,
            after: after,
            screenshot: shot
        }));

        expect(before.firstEntryBackground).toBe('rgb(0, 0, 0)');
        expect(before.aliasColor).toBe('rgb(85, 255, 255)');
        expect(before.viewportOverflow).toBe('auto');
        expect(after.viewportScrollTop).toBeGreaterThan(0);
        expect(Math.abs((after.windowScrollY || 0) - (before.windowScrollY || 0))).toBeLessThan(2);
        expect(Math.abs((after.sidebarTop || 0) - (before.sidebarTop || 0))).toBeLessThan(2);
        expect(after.firstEntryTop).toBeLessThan(after.postBottom);

        await context.close();
    });
});
