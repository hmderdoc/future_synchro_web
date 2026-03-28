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

test.describe('flweb audio', function () {
    test.skip(!SITE_URL || !SITE_USERNAME || !SITE_PASSWORD,
        'PW_SITE_URL, PW_SITE_USERNAME, and PW_SITE_PASSWORD are required');

    test('shared mp3 route and playback path', async function ({ browser }) {
        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block'
        });
        const page = await context.newPage();
        const consoleMessages = [];
        const assetResponses = [];

        page.on('console', function (msg) {
            consoleMessages.push({
                type: msg.type(),
                text: msg.text()
            });
        });

        page.on('response', async function (response) {
            if (response.url().indexOf('/api/flweb-assets.ssjs') === -1) return;
            assetResponses.push({
                url: response.url(),
                status: response.status(),
                contentType: response.headers()['content-type'] || ''
            });
        });

        await loginViaApi(context);
        await page.goto(baseUrl + '/terminal-iframe.html', { waitUntil: 'domcontentloaded' });
        await page.addScriptTag({ url: baseUrl + '/js/flweb.js' });
        await page.waitForTimeout(1500);

        await page.click('body', { position: { x: 20, y: 20 } });

        const probe = await page.evaluate(async function () {
            var src;
            var routeCheck;
            var unlocked;
            var playResult;
            var ctxState = null;

            if (!window.FLWeb) {
                return { ok: false, error: 'FLWeb unavailable' };
            }

            src = window.FLWeb.buildAssetUrl({
                scope: 'shared',
                path: 'youGotmail.mp3'
            });

            routeCheck = await fetch(src, { credentials: 'same-origin' }).then(async function (response) {
                return {
                    ok: response.ok,
                    status: response.status,
                    contentType: response.headers.get('content-type') || '',
                    length: (await response.arrayBuffer()).byteLength
                };
            }).catch(function (err) {
                return { ok: false, error: String(err) };
            });

            if (typeof window.FLWeb.unlockAudio === 'function') {
                unlocked = await window.FLWeb.unlockAudio().catch(function (err) {
                    return 'unlock-error:' + String(err);
                });
            } else {
                unlocked = 'no-unlock';
            }

            try {
                playResult = window.FLWeb.playAudio({
                    asset: { scope: 'shared', path: 'youGotmail.mp3' },
                    id: 'pw-audio-test',
                    volume: 1
                });
            } catch (err) {
                playResult = 'throw:' + String(err);
            }

            try {
                var Ctor = window.AudioContext || window.webkitAudioContext;
                if (Ctor) {
                    var ctx = window.FLWeb && window.FLWeb.__audioContext ? window.FLWeb.__audioContext : null;
                    if (ctx) ctxState = ctx.state;
                }
            } catch (_) {}

            return {
                ok: true,
                src: src,
                routeCheck: routeCheck,
                unlocked: unlocked,
                playResult: playResult,
                ctxState: ctxState
            };
        });

        await page.waitForTimeout(3000);

        console.log('PLAYWRIGHT_FLWEB_AUDIO_PROBE=' + JSON.stringify({
            probe: probe,
            assetResponses: assetResponses,
            consoleMessages: consoleMessages
        }));

        expect(probe.ok).toBeTruthy();
        expect(probe.routeCheck && probe.routeCheck.ok).toBeTruthy();
        expect(assetResponses.length).toBeGreaterThan(0);

        await context.close();
    });
});
