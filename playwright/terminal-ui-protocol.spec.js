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

    test('FLWeb can fetch and play NBA_JAM xtrn audio asset', async function ({ browser }) {
        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block'
        });
        const page = await context.newPage();
        const assetResponses = [];
        const consoleMessages = [];
        let sharedAssetStatus = null;
        let xtrnAssetStatus = null;

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
        sharedAssetStatus = await context.request.get(
            baseUrl + '/api/flweb-assets.ssjs?scope=shared&path=' +
            encodeURIComponent('youGotmail.mp3')
        );
        xtrnAssetStatus = await context.request.get(
            baseUrl + '/api/flweb-assets.ssjs?scope=xtrn&code=NBA_JAM&path=' +
            encodeURIComponent('01 - Main Theme - Jon Hey.mp3')
        );
        await openProbePage(page, baseUrl);
        await page.click('body', { position: { x: 40, y: 40 } });

        const probe = await page.evaluate(async function () {
            var sharedSrc;
            var xtrnSrc;
            var routeCheck = {};
            var unlocked;
            var playResult = {};
            var ctx;
            var decodeShared = false;
            var decodeXtrn = false;

            function decodeAudioBuffer(arrayBuffer) {
                return new Promise(function (resolve, reject) {
                    var localCtx = ctx || new (window.AudioContext || window.webkitAudioContext)();
                    var cloned = arrayBuffer.slice ? arrayBuffer.slice(0) : arrayBuffer;
                    try {
                        var ret = localCtx.decodeAudioData(cloned, resolve, reject);
                        if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
                    } catch (err) {
                        reject(err);
                    }
                });
            }

            if (!window.FLWeb) {
                return { ok: false, error: 'FLWeb unavailable' };
            }

            sharedSrc = window.FLWeb.buildAssetUrl({
                scope: 'shared',
                path: 'youGotmail.mp3'
            });

            xtrnSrc = window.FLWeb.buildAssetUrl({
                scope: 'xtrn',
                code: 'NBA_JAM',
                path: '01 - Main Theme - Jon Hey.mp3'
            });

            routeCheck.shared = await fetch(sharedSrc, { credentials: 'same-origin' })
                .then(async function (response) {
                    var buffer = await response.arrayBuffer();
                    return {
                        ok: response.ok,
                        status: response.status,
                        contentType: response.headers.get('content-type') || '',
                        length: buffer.byteLength,
                        buffer: buffer
                    };
                }).catch(function (err) {
                    return { ok: false, error: String(err) };
                });

            routeCheck.xtrn = await fetch(xtrnSrc, { credentials: 'same-origin' })
                .then(async function (response) {
                    var buffer = await response.arrayBuffer();
                    return {
                        ok: response.ok,
                        status: response.status,
                        contentType: response.headers.get('content-type') || '',
                        length: buffer.byteLength,
                        buffer: buffer
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
                ctx = new (window.AudioContext || window.webkitAudioContext)();
                if (typeof ctx.resume === 'function') {
                    await ctx.resume();
                }
            } catch (_) {
                ctx = null;
            }

            if (ctx && routeCheck.shared && routeCheck.shared.ok && routeCheck.shared.buffer) {
                try {
                    await decodeAudioBuffer(routeCheck.shared.buffer);
                    decodeShared = true;
                } catch (err) {
                    decodeShared = 'decode-error:' + String(err);
                }
            }

            if (ctx && routeCheck.xtrn && routeCheck.xtrn.ok && routeCheck.xtrn.buffer) {
                try {
                    await decodeAudioBuffer(routeCheck.xtrn.buffer);
                    decodeXtrn = true;
                } catch (err) {
                    decodeXtrn = 'decode-error:' + String(err);
                }
            }

            delete routeCheck.shared.buffer;
            delete routeCheck.xtrn.buffer;

            try {
                playResult.shared = window.FLWeb.playAudio({
                    asset: {
                        scope: 'shared',
                        path: 'youGotmail.mp3'
                    },
                    id: 'pw-shared-audio',
                    volume: 0.2,
                    loop: false
                });
            } catch (err) {
                playResult.shared = 'throw:' + String(err);
            }

            try {
                playResult.xtrn = window.FLWeb.playAudio({
                    asset: {
                        scope: 'xtrn',
                        code: 'NBA_JAM',
                        path: '01 - Main Theme - Jon Hey.mp3'
                    },
                    id: 'pw-nba-jam-audio',
                    volume: 0.2,
                    loop: true
                });
            } catch (err) {
                playResult.xtrn = 'throw:' + String(err);
            }

            await new Promise(function (resolve) { setTimeout(resolve, 1500); });
            window.FLWeb.handleTerminalUi({ action: 'audio.stop', payload: { id: 'pw-shared-audio' } });
            window.FLWeb.handleTerminalUi({ action: 'audio.stop', payload: { id: 'pw-nba-jam-audio' } });

            return {
                ok: true,
                sharedSrc: sharedSrc,
                xtrnSrc: xtrnSrc,
                routeCheck: routeCheck,
                unlocked: unlocked,
                playResult: playResult,
                decodeShared: decodeShared,
                decodeXtrn: decodeXtrn
            };
        });

        await page.waitForTimeout(1000);

        console.log('PLAYWRIGHT_FLWEB_XTRN_AUDIO_PROBE=' + JSON.stringify({
            probe: probe,
            requestProbe: {
                shared: sharedAssetStatus && {
                    status: sharedAssetStatus.status(),
                    contentType: sharedAssetStatus.headers()['content-type'] || ''
                },
                xtrn: xtrnAssetStatus && {
                    status: xtrnAssetStatus.status(),
                    contentType: xtrnAssetStatus.headers()['content-type'] || ''
                }
            },
            assetResponses: assetResponses,
            consoleMessages: consoleMessages
        }));

        expect(probe.ok).toBeTruthy();
        expect(sharedAssetStatus.ok()).toBeTruthy();
        expect(xtrnAssetStatus.ok()).toBeTruthy();
        expect(probe.routeCheck && probe.routeCheck.shared && probe.routeCheck.shared.ok).toBeTruthy();
        expect(probe.routeCheck && probe.routeCheck.xtrn && probe.routeCheck.xtrn.ok).toBeTruthy();
        expect(probe.decodeShared).toBeTruthy();
        expect(probe.decodeXtrn).toBeTruthy();
        expect(assetResponses.some(function (entry) {
            return entry.url.indexOf('scope=shared') !== -1 && entry.status === 200;
        })).toBeTruthy();
        expect(assetResponses.some(function (entry) {
            return entry.url.indexOf('scope=xtrn') !== -1 && entry.status === 200;
        })).toBeTruthy();
        expect(consoleMessages.filter(function (entry) {
            return entry.type === 'warning' || entry.type === 'error';
        }).some(function (entry) {
            return entry.text.indexOf('[flweb]') !== -1;
        })).toBeFalsy();

        await context.close();
    });

});
