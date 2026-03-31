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

test.describe('settings icon debug', function () {
    test.skip(!SITE_URL || !SITE_USERNAME || !SITE_PASSWORD,
        'PW_SITE_URL, PW_SITE_USERNAME, and PW_SITE_PASSWORD are required');

    test('renders gear icon in logged-in user dropdown', async function ({ browser }, testInfo) {
        test.setTimeout(30000);
        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block'
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const consoleMessages = [];

        page.on('console', function (msg) {
            consoleMessages.push({
                type: msg.type(),
                text: msg.text()
            });
        });

        await loginViaApi(context);
        await page.goto(baseUrl + '/?_pw=' + Date.now(), {
            waitUntil: 'domcontentloaded'
        });

        const authToggle = page.locator('.auth-nav-link').first();
        await expect(authToggle).toBeVisible({ timeout: 30000 });
        await authToggle.click();

        const settingsItem = page.locator('.dropdown-menu .dropdown-item[href="./?page=010-settings.xjs"]').first();
        await expect(settingsItem).toBeVisible({ timeout: 15000 });
        await page.waitForTimeout(500);

        const probe = await settingsItem.evaluate(function (el) {
            const icon = el.querySelector('.bin-icon');
            const img = icon ? icon.querySelector('img') : null;
            return {
                text: (el.textContent || '').trim(),
                iconKey: icon ? icon.getAttribute('data-icon') : null,
                iconInnerHtml: icon ? icon.innerHTML : null,
                iconImgCount: icon ? icon.querySelectorAll('img').length : 0,
                iconImgSrc: img ? img.getAttribute('src') : null,
                knownIcons: window.sbbsBinIcons ? Object.prototype.hasOwnProperty.call(window.sbbsBinIcons, 'gear') : false
            };
        });

        console.log('PLAYWRIGHT_SETTINGS_ICON=' + JSON.stringify({
            probe: probe,
            consoleMessages: consoleMessages
        }));

        await context.close();
    });
});
