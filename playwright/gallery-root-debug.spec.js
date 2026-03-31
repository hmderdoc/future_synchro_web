const { test, expect } = require('@playwright/test');

const SITE_URL = process.env.PW_SITE_URL;

function requireEnv(name) {
    if (!process.env[name]) {
        throw new Error('Missing required env var: ' + name);
    }
    return process.env[name];
}

async function snapshotState(page, label) {
    return page.evaluate(function (tag) {
        var look = document.getElementById('ahv-look');
        var play = document.getElementById('ahv-slideshow-toggle');
        var order = document.getElementById('ahv-order-toggle');
        var count = document.getElementById('ahv-count');
        var file = document.getElementById('ahv-file');
        var status = document.getElementById('ahv-status');
        var error = document.getElementById('ahv-error');
        var selected = look && look.selectedIndex >= 0 ? look.options[look.selectedIndex] : null;
        var folderOptions = look ? Array.prototype.slice.call(look.options)
            .map(function (opt) {
                return {
                    text: opt.textContent,
                    value: opt.value
                };
            })
            .filter(function (opt) {
                return /^Folder:/.test(opt.text) || /^Root:/.test(opt.text);
            }) : [];
        var galleryOptions = look ? Array.prototype.slice.call(look.options)
            .map(function (opt) {
                return {
                    text: opt.textContent,
                    value: opt.value
                };
            })
            .filter(function (opt) {
                return /^Gallery:/.test(opt.text);
            }) : [];

        return {
            label: tag,
            href: window.location.href,
            selectedText: selected ? selected.textContent : null,
            selectedValue: selected ? selected.value : null,
            countText: count ? count.textContent : null,
            fileText: file ? file.textContent : null,
            statusText: status ? status.textContent : null,
            errorText: error ? error.textContent : null,
            playText: play ? play.textContent : null,
            playDisabled: play ? play.disabled : null,
            orderText: order ? order.textContent : null,
            orderDisabled: order ? order.disabled : null,
            folderOptions: folderOptions,
            galleryOptions: galleryOptions
        };
    }, label);
}

test.describe('gallery root selection debug', function () {
    test.skip(!SITE_URL, 'PW_SITE_URL is required');

    test('switching to Root: Entire Archive keeps archive scope and playability', async function ({ browser }, testInfo) {
        test.setTimeout(60000);

        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            serviceWorkers: 'block'
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);

        async function selectLookByText(text) {
            const responsePromise = page.waitForResponse(function (response) {
                return response.url().indexOf('/api/ansi-viewer.ssjs?') >= 0 && response.request().method() === 'GET';
            }, { timeout: 15000 }).catch(function () {
                return null;
            });
            await page.locator('#ahv-look').selectOption({ label: text });
            await responsePromise;
            await page.waitForTimeout(600);
        }

        async function clickPlayIfPossible() {
            const play = page.locator('#ahv-slideshow-toggle');
            if (!(await play.isEnabled())) return false;
            const responsePromise = page.waitForResponse(function (response) {
                return response.url().indexOf('/api/ansi-viewer.ssjs?') >= 0 && response.request().method() === 'GET';
            }, { timeout: 15000 }).catch(function () {
                return null;
            });
            await play.click();
            await responsePromise;
            await page.waitForTimeout(600);
            return true;
        }

        await page.goto(baseUrl + '/?page=012-futureland-gallery.xjs&_pw=' + Date.now(), {
            waitUntil: 'domcontentloaded'
        });
        await expect(page.locator('#ahv-look')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('#ahv-stage-wrap')).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(1200);

        const initial = await snapshotState(page, 'initial');
        const targetGallery = initial.galleryOptions.find(function (opt) {
            return opt.text === 'Gallery: 2015';
        }) || initial.galleryOptions.find(function (opt) {
            return opt.text === 'Gallery: 2013';
        });

        expect(targetGallery).toBeTruthy();

        await selectLookByText(targetGallery.text);
        const afterGallery = await snapshotState(page, 'afterGallery');
        const nestedFolder = afterGallery.folderOptions.find(function (opt) {
            return opt.text !== 'Root: Entire Archive';
        });

        expect(afterGallery.folderOptions.some(function (opt) {
            return opt.text === 'Root: Entire Archive';
        })).toBeTruthy();
        expect(nestedFolder).toBeTruthy();

        await selectLookByText(nestedFolder.text);
        const afterNested = await snapshotState(page, 'afterNested');

        await selectLookByText('Root: Entire Archive');
        const afterRoot = await snapshotState(page, 'afterRoot');

        const playClicked = await clickPlayIfPossible();
        const afterPlay = await snapshotState(page, 'afterPlay');

        const shot = testInfo.outputPath('gallery-root-debug.png');
        await page.screenshot({ path: shot, fullPage: true });

        console.log('PLAYWRIGHT_GALLERY_ROOT=' + JSON.stringify({
            initial: initial,
            afterGallery: afterGallery,
            afterNested: afterNested,
            afterRoot: afterRoot,
            afterPlay: afterPlay,
            playClicked: playClicked,
            screenshot: shot
        }));

        expect(afterRoot.selectedText).toBe('Root: Entire Archive');
        expect(afterRoot.playDisabled).toBeFalsy();
        expect(afterRoot.href).toContain('slide_scope=all');
        expect(afterPlay.href).toContain('slide_scope=all');
        expect(afterPlay.playDisabled).toBeFalsy();

        await context.close();
    });
});
