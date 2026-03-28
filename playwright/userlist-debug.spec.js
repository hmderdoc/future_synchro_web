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

test.describe('userlist debug', function () {
    test.skip(!SITE_URL || !SITE_USERNAME || !SITE_PASSWORD,
        'PW_SITE_URL, PW_SITE_USERNAME, and PW_SITE_PASSWORD are required');

    test('inspect userlist rendering and sort navigation', async function ({ browser }, testInfo) {
        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block'
        });
        const page = await context.newPage();
        const consoleMessages = [];
        const avatarResponses = [];
        const pageResponses = [];

        page.on('console', function (msg) {
            consoleMessages.push({
                type: msg.type(),
                text: msg.text()
            });
        });

        page.on('response', async function (response) {
            const url = response.url();
            if (url.indexOf('/api/system.ssjs?call=get-avatar') !== -1) {
                let body = null;
                try {
                    body = await response.json();
                } catch (_) {}
                avatarResponses.push({
                    url: url,
                    status: response.status(),
                    body: body
                });
            }
            if (url.indexOf('/api/page.ssjs?') !== -1) {
                pageResponses.push({
                    url: url,
                    status: response.status(),
                    title: response.headers()['x-page-title'] || '',
                    noSidebar: response.headers()['x-page-nosidebar'] || ''
                });
            }
        });

        await loginViaApi(context);
        await page.goto(baseUrl + '/?page=005-userlist.xjs&_pw=' + Date.now(), {
            waitUntil: 'domcontentloaded'
        });
        await expect(page.locator('.userlist-page')).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(4000);
        await page.evaluate(function () {
            var modal = document.getElementById('popUpModal');
            if (modal && modal.classList.contains('show') && window.bootstrap && window.bootstrap.Modal) {
                window.bootstrap.Modal.getOrCreateInstance(modal).hide();
            }
        });
        await page.waitForTimeout(500);

        const beforeShot = testInfo.outputPath('userlist-before.png');
        await page.screenshot({ path: beforeShot, fullPage: true });

        const before = await page.evaluate(function () {
            const root = document.querySelector('.userlist-page');
            const firstCard = document.querySelector('.userlist-card');
            const firstName = document.querySelector('.userlist-name');
            const firstLocation = document.querySelector('.userlist-location');
            const firstLastOn = document.querySelector('.userlist-laston');
            const avatarDiv = document.querySelector('.userlist-avatar');
            const sortLinks = Array.from(document.querySelectorAll('.userlist-chip')).map(function (el) {
                return {
                    text: (el.textContent || '').trim(),
                    href: el.getAttribute('href'),
                    resolvedHref: el.href
                };
            });

            return {
                location: window.location.href,
                title: document.title,
                pageText: root ? root.innerText.slice(0, 300) : '',
                cssVars: root ? {
                    red: getComputedStyle(root).getPropertyValue('--userlist-red').trim(),
                    yellow: getComputedStyle(root).getPropertyValue('--userlist-yellow').trim(),
                    gray: getComputedStyle(root).getPropertyValue('--userlist-gray').trim(),
                    border: getComputedStyle(root).getPropertyValue('--userlist-border').trim()
                } : null,
                styles: {
                    cardBorder: firstCard ? getComputedStyle(firstCard).borderColor : null,
                    name: firstName ? getComputedStyle(firstName).color : null,
                    location: firstLocation ? getComputedStyle(firstLocation).color : null,
                    laston: firstLastOn ? getComputedStyle(firstLastOn).color : null
                },
                avatar: {
                    dataAvatar: avatarDiv ? avatarDiv.getAttribute('data-avatar') : null,
                    innerHTML: avatarDiv ? avatarDiv.innerHTML : null,
                    imgCount: avatarDiv ? avatarDiv.querySelectorAll('img').length : 0
                },
                sortLinks: sortLinks
            };
        });

        const aliasLink = page.locator('.userlist-chip', { hasText: 'Alias' }).first();
        await expect(aliasLink).toBeVisible({ timeout: 15000 });
        const aliasHref = await aliasLink.getAttribute('href');
        await aliasLink.click({ force: true });
        await page.waitForTimeout(3000);

        const afterShot = testInfo.outputPath('userlist-after-alias-click.png');
        await page.screenshot({ path: afterShot, fullPage: true });

        const after = await page.evaluate(function () {
            return {
                location: window.location.href,
                title: document.title,
                hasUserlist: !!document.querySelector('.userlist-page'),
                hasHomeMarker: !!document.querySelector('.bl-panel'),
                firstHeading: document.querySelector('h1, h2, h3, .card-header, .panel-heading')
                    ? (document.querySelector('h1, h2, h3, .card-header, .panel-heading').textContent || '').trim()
                    : null
            };
        });

        console.log('PLAYWRIGHT_USERLIST_DEBUG=' + JSON.stringify({
            aliasHref: aliasHref,
            before: before,
            after: after,
            avatarResponses: avatarResponses,
            pageResponses: pageResponses,
            consoleMessages: consoleMessages,
            screenshots: {
                before: beforeShot,
                after: afterShot
            }
        }));

        await context.close();
    });
});
