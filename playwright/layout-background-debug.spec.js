const { test, expect } = require('@playwright/test');

const SITE_URL = process.env.PW_SITE_URL;

test.describe('layout background debug', function () {
    test.skip(!SITE_URL, 'PW_SITE_URL is required');

    test('inspect tall viewport background coverage', async function ({ browser }, testInfo) {
        const baseUrl = SITE_URL.replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true,
            viewport: { width: 1365, height: 1400 },
            serviceWorkers: 'block'
        });
        const page = await context.newPage();

        await page.goto(baseUrl + '/?page=009-news.xjs&_pw=' + Date.now(), {
            waitUntil: 'domcontentloaded'
        });
        await page.waitForTimeout(2500);

        const probe = await page.evaluate(function () {
            function info(el) {
                if (!el) return null;
                var rect = el.getBoundingClientRect();
                var style = getComputedStyle(el);
                return {
                    tag: el.tagName,
                    id: el.id || null,
                    className: typeof el.className === 'string' ? el.className : null,
                    background: style.backgroundColor,
                    rect: {
                        x: rect.x,
                        y: rect.y,
                        width: rect.width,
                        height: rect.height,
                        bottom: rect.bottom
                    }
                };
            }

            var x = Math.floor(window.innerWidth / 2);
            var y = Math.max(0, window.innerHeight - 10);
            var stack = [];
            var el = document.elementFromPoint(x, y);
            while (el) {
                stack.push(info(el));
                el = el.parentElement;
            }

            return {
                innerWidth: window.innerWidth,
                innerHeight: window.innerHeight,
                html: info(document.documentElement),
                body: info(document.body),
                spaContainer: info(document.querySelector('.spa-container')),
                row: info(document.querySelector('.spa-container > .row')),
                content: info(document.getElementById('content')),
                sidebar: info(document.getElementById('sidebar')),
                bottomPoint: {
                    x: x,
                    y: y,
                    stack: stack.slice(0, 8)
                }
            };
        });

        const shot = testInfo.outputPath('layout-background-debug.png');
        await page.screenshot({ path: shot, fullPage: false });

        console.log('PLAYWRIGHT_LAYOUT_BG=' + JSON.stringify({
            probe: probe,
            screenshot: shot
        }));

        expect(probe).toBeTruthy();
        await context.close();
    });
});
