const { test, expect } = require('@playwright/test');

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
        form: { username: username, password: password }
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
                return /terminal-iframe\.html/.test(String(iframe.contentWindow.location.href || ''));
            } catch (_) {
                return false;
            }
        });
    }, { timeout: 30000 }).toBeTruthy();
}

async function getTerminalState(page) {
    return await page.evaluate(function () {
        var button = document.getElementById('btn-terminal');
        var label = document.getElementById('crt-label');
        var panel = document.getElementById('terminal-panel');
        var iframe = document.getElementById('terminal-iframe');
        var win = iframe && iframe.contentWindow;
        var client = win && win._ftClient;
        var opts = client && (client._Options || client.Options);
        return {
            buttonVisible: !!button,
            modemActive: !!(button && button.classList.contains('modem-active')),
            crtVisible: !!(button && button.classList.contains('crt-visible')),
            crtLabel: label ? label.textContent : '',
            panelHidden: !!(panel && panel.classList.contains('is-hidden')),
            terminalType: opts && opts.RLoginTerminalType ? String(opts.RLoginTerminalType) : null,
            connectionType: opts && opts.ConnectionType ? String(opts.ConnectionType) : null
        };
    });
}

async function disconnectTerminal(page) {
    const result = await page.evaluate(function () {
        var iframe = document.getElementById('terminal-iframe');
        var win = iframe && iframe.contentWindow;
        var client = win && win._ftClient;
        if (!client || typeof client.Disconnect !== 'function') return false;
        try {
            client.Disconnect();
            return true;
        } catch (_) {
            return false;
        }
    });
    expect(result).toBeTruthy();
}

test.describe('terminal door reconnect', function () {
    test.skip(
        !process.env.PW_SITE_URL || !process.env.PW_SITE_USERNAME || !process.env.PW_SITE_PASSWORD,
        'PW_SITE_URL, PW_SITE_USERNAME, and PW_SITE_PASSWORD are required'
    );

    test('navbar reconnect should clear prior xtrn terminal type', async function ({ browser }) {
        test.setTimeout(90000);
        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block'
        });
        const page = await context.newPage();

        console.log('step: login');
        await loginViaApi(context);
        console.log('step: open games page');
        await page.goto(baseUrl + '/?page=003-games.xjs', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#games-grid .game-row[data-code] .game-launch-btn', { timeout: 30000 });

        const firstCode = await page.locator('#games-grid .game-row[data-code]').first().getAttribute('data-code');
        expect(firstCode).toBeTruthy();
        console.log('step: launch code=' + firstCode);

        await page.locator('#games-grid .game-row .game-launch-btn').first().click();
        await waitForTerminalWindow(page);
        console.log('step: terminal iframe ready');

        await expect.poll(async function () {
            const state = await getTerminalState(page);
            return state.terminalType;
        }, { timeout: 30000 }).toBe('xtrn=' + firstCode);
        console.log('step: xtrn terminal type observed');

        await disconnectTerminal(page);
        console.log('step: disconnected terminal');

        await expect.poll(async function () {
            const state = await getTerminalState(page);
            return state.panelHidden;
        }, { timeout: 10000 }).toBeTruthy();
        console.log('step: panel auto-hidden');

        await page.click('#btn-terminal');
        console.log('step: reopened from navbar');

        await expect.poll(async function () {
            const state = await getTerminalState(page);
            return state.terminalType;
        }, { timeout: 15000 }).toBe('ansi-bbs-cp437-truecolor');
        await expect.poll(async function () {
            const state = await getTerminalState(page);
            return state.modemActive;
        }, { timeout: 15000 }).toBeTruthy();
        console.log('step: terminal reconnected with ansi-bbs-cp437-truecolor');

        await context.close();
    });
});
