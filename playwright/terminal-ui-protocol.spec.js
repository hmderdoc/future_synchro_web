const { test, expect } = require('@playwright/test');

const SITE_URL = process.env.PW_SITE_URL;
const SITE_USERNAME = process.env.PW_SITE_USERNAME;
const SITE_PASSWORD = process.env.PW_SITE_PASSWORD;
const XTRN_CODE = process.env.PW_XTRN_CODE || 'TEST3';

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

async function waitForTerminalWindow(page) {
    const locator = page.locator('#terminal-iframe');
    await expect(locator).toBeVisible({ timeout: 30000 });
    await expect.poll(async function () {
        return await page.evaluate(function () {
            var iframe = document.getElementById('terminal-iframe');
            if (!iframe || !iframe.contentWindow) return false;
            try {
                return /terminal-iframe\.html/.test(
                    String(iframe.contentWindow.location.href || '')
                );
            } catch (_) {
                return false;
            }
        });
    }, { timeout: 30000 }).toBeTruthy();
}

async function stuffTerminalInput(page, text) {
    return await page.evaluate(function (payload) {
        var iframe = document.getElementById('terminal-iframe');
        var win = iframe && iframe.contentWindow;
        var client = win && win._ftClient;
        if (!client || typeof client.StuffInputBuffer !== 'function') return false;
        client.StuffInputBuffer(String(payload || ''));
        return true;
    }, text);
}

async function openProbePage(page, baseUrl) {
    await page.goto(baseUrl + '/flweb-probe.html?_pw=' + Date.now(), {
        waitUntil: 'domcontentloaded'
    });
    await page.waitForFunction(function () {
        return !!window.FLWeb &&
            typeof window.FLWeb.handleTerminalUi === 'function' &&
            typeof window.FLWeb.buildAssetUrl === 'function';
    });
}

test.describe('terminal ui protocol', function () {
    test.skip(!SITE_URL || !SITE_USERNAME || !SITE_PASSWORD,
        'PW_SITE_URL, PW_SITE_USERNAME, and PW_SITE_PASSWORD are required');

    test('FLWeb alert handler works on probe page', async function ({ browser }) {
        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block'
        });
        const page = await context.newPage();
        let dialogMessage = null;

        page.on('dialog', async function (dialog) {
            dialogMessage = dialog.message();
            await dialog.dismiss();
        });

        await loginViaApi(context);
        await openProbePage(page, baseUrl);
        await page.evaluate(function () {
            window.FLWeb.handleTerminalUi({
                action: 'alert',
                message: 'sent from terminal'
            });
        });

        await expect.poll(function () {
            return dialogMessage;
        }, { timeout: 15000 }).toBe('sent from terminal');

        await context.close();
    });
});
