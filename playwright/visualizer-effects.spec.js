const { test, expect } = require('@playwright/test');

function requireEnv(name) {
    if (!process.env[name]) {
        throw new Error('Missing required env var: ' + name);
    }
    return process.env[name];
}

test.describe('visualizer effects', function () {
    test.skip(!process.env.PW_SITE_URL, 'PW_SITE_URL is required');

    test('HUD and keyboard toggles work for lyric, laser, and wave effects', async function ({ browser }) {
        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block'
        });
        const page = await context.newPage();
        const pageErrors = [];

        page.on('pageerror', function (error) {
            pageErrors.push(String(error));
        });

        await page.goto(baseUrl + '/?page=000-home.xjs&_pw=' + Date.now(), {
            waitUntil: 'domcontentloaded'
        });

        await page.waitForFunction(function () {
            return !!window.sbbsVisualizer && !!document.getElementById('viz-panel');
        });

        await page.evaluate(function () {
            window.sbbsVisualizer.show();
        });

        await expect(page.locator('#viz-panel')).toBeVisible();
        await expect(page.locator('#viz-fx-lyrics')).toHaveText('Spitting');
        await expect(page.locator('#viz-fx-lasers')).toHaveText('Off');
        await expect(page.locator('#viz-fx-wave')).toHaveText('Off');

        await page.keyboard.press('e');
        await expect(page.locator('#viz-fx-lasers')).toHaveText('On');

        await page.keyboard.press('w');
        await expect(page.locator('#viz-fx-wave')).toHaveText('On');

        await page.keyboard.press('l');
        await expect(page.locator('#viz-fx-lyrics')).toHaveText('Ball');

        const canvases = await page.evaluate(function () {
            return {
                milkdrop: !!document.getElementById('viz-milkdrop'),
                wireframe: !!document.getElementById('viz-wireframe'),
                karaoke: !!document.getElementById('viz-karaoke')
            };
        });

        expect(canvases.milkdrop).toBeTruthy();
        expect(canvases.wireframe).toBeTruthy();
        expect(canvases.karaoke).toBeTruthy();
        expect(pageErrors).toEqual([]);

        await context.close();
    });
});
