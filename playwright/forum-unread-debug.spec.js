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

test.describe('forum unread debug', function () {
    test.skip(!SITE_URL || !SITE_USERNAME || !SITE_PASSWORD,
        'PW_SITE_URL, PW_SITE_USERNAME, and PW_SITE_PASSWORD are required');

	    test('inspect logged-in group unread badges', async function ({ browser }, testInfo) {
	        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
	        const context = await browser.newContext({
	            ignoreHTTPSErrors: true,
	            serviceWorkers: 'block'
	        });
        const page = await context.newPage();
        const apiResponses = [];
        const consoleMessages = [];

        page.on('console', function (msg) {
            consoleMessages.push({
                type: msg.type(),
                text: msg.text()
            });
        });

        page.on('response', async function (response) {
            const url = response.url();
            if (url.indexOf('/api/forum.ssjs?call=get-group-unread-counts') === -1) return;
            let body = null;
            try {
                body = await response.json();
            } catch (_) {}
            apiResponses.push({
                url: url,
                status: response.status(),
                body: body
            });
        });

        await loginViaApi(context);
        await page.goto(baseUrl + '/?page=002-forum.xjs&_pw=' + Date.now(), {
            waitUntil: 'domcontentloaded'
        });
        await expect(page.locator('#forum-list-container .forum-directory-card').first()).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(2500);

        const shot = testInfo.outputPath('forum-unread.png');
        await page.screenshot({ path: shot, fullPage: true });

	        const probe = await page.evaluate(function () {
	            const firstCard = document.querySelector('#forum-list-container .forum-directory-card');
	            const firstHeading = firstCard ? firstCard.querySelector('.forum-group-heading') : null;
	            const firstTitle = firstCard ? firstCard.querySelector('.forum-group-heading h3') : null;
	            const visibleBadges = Array.from(document.querySelectorAll('#forum-list-container [data-unread-unscanned]'))
	                .filter(function (el) { return !el.hidden && !!(el.textContent || '').trim(); })
	                .map(function (el) {
	                    var rect = el.getBoundingClientRect();
	                    return {
	                        text: (el.textContent || '').trim(),
	                        color: getComputedStyle(el).color,
	                        fontWeight: getComputedStyle(el).fontWeight,
	                        background: getComputedStyle(el).backgroundColor,
	                        border: getComputedStyle(el).border,
	                        title: el.getAttribute('title'),
	                        rect: {
	                            x: rect.x,
	                            y: rect.y,
	                            width: rect.width,
	                            height: rect.height
	                        }
	                    };
	                });

	            return {
	                location: window.location.href,
	                firstCardText: firstCard ? (firstCard.textContent || '').trim() : null,
	                firstHeading: firstHeading ? (function () {
	                    var rect = firstHeading.getBoundingClientRect();
	                    return {
	                        rect: {
	                            x: rect.x,
	                            y: rect.y,
	                            width: rect.width,
	                            height: rect.height
	                        }
	                    };
	                })() : null,
	                firstTitle: firstTitle ? (function () {
	                    var rect = firstTitle.getBoundingClientRect();
	                    return {
	                        text: (firstTitle.textContent || '').trim(),
	                        color: getComputedStyle(firstTitle).color,
	                        rect: {
	                            x: rect.x,
	                            y: rect.y,
	                            width: rect.width,
	                            height: rect.height
	                        }
	                    };
	                })() : null,
	                firstBadge: firstCard ? (function () {
	                    var badge = firstCard.querySelector('[data-unread-unscanned]');
	                    if (!badge) return null;
	                    var rect = badge.getBoundingClientRect();
	                    return {
	                        hidden: badge.hidden,
	                        text: (badge.textContent || '').trim(),
	                        color: getComputedStyle(badge).color,
	                        fontWeight: getComputedStyle(badge).fontWeight,
	                        background: getComputedStyle(badge).backgroundColor,
	                        border: getComputedStyle(badge).border,
	                        rect: {
	                            x: rect.x,
	                            y: rect.y,
	                            width: rect.width,
	                            height: rect.height
	                        }
	                    };
	                })() : null,
	                visibleBadges: visibleBadges
	            };
        });

        console.log('PLAYWRIGHT_FORUM_UNREAD=' + JSON.stringify({
            probe: probe,
            apiResponses: apiResponses,
            consoleMessages: consoleMessages,
            screenshot: shot
        }));

	        await context.close();
	    });

	    test('inspect logged-in sub list pills', async function ({ browser }, testInfo) {
	        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
	        const context = await browser.newContext({
	            ignoreHTTPSErrors: true,
	            serviceWorkers: 'block'
	        });
	        const page = await context.newPage();
	        const apiResponses = [];
	        const consoleMessages = [];

	        page.on('console', function (msg) {
	            consoleMessages.push({
	                type: msg.type(),
	                text: msg.text()
	            });
	        });

	        page.on('response', async function (response) {
	            const url = response.url();
	            if (url.indexOf('/api/forum.ssjs?call=list-subs&group=0') === -1) return;
	            let body = null;
	            try {
	                body = await response.json();
	            } catch (_) {}
	            apiResponses.push({
	                url: url,
	                status: response.status(),
	                body: body
	            });
	        });

	        await loginViaApi(context);
	        await page.goto(baseUrl + '/?page=002-forum.xjs&group=0&_pw=' + Date.now(), {
	            waitUntil: 'domcontentloaded'
	        });
	        await expect(page.locator('#forum-list-container .forum-directory-card').first()).toBeVisible({ timeout: 30000 });
	        await page.waitForTimeout(2500);

	        const shot = testInfo.outputPath('forum-subs.png');
	        await page.screenshot({ path: shot, fullPage: true });

	        const probe = await page.evaluate(function () {
	            const firstCard = document.querySelector('#forum-list-container .forum-directory-card');
	            const firstHeading = firstCard ? firstCard.querySelector('.forum-sub-heading') : null;
	            const firstMeta = firstCard ? firstCard.querySelector('.forum-sub-meta') : null;
	            const firstTitle = firstCard ? firstCard.querySelector('strong[data-sub-name]') : null;
	            const firstUnread = firstCard ? firstCard.querySelector('[data-unread-unscanned]') : null;
	            const firstTotal = firstCard ? firstCard.querySelector('[data-total-msgs]') : null;
	            const firstDescription = firstCard ? firstCard.querySelector('p[data-sub-description]') : null;

	            function rectInfo(el) {
	                if (!el) return null;
	                var rect = el.getBoundingClientRect();
	                return {
	                    x: rect.x,
	                    y: rect.y,
	                    width: rect.width,
	                    height: rect.height
	                };
	            }

	            function pillInfo(el) {
	                if (!el) return null;
	                return {
	                    hidden: el.hidden,
	                    text: (el.textContent || '').trim(),
	                    color: getComputedStyle(el).color,
	                    fontWeight: getComputedStyle(el).fontWeight,
	                    background: getComputedStyle(el).backgroundColor,
	                    border: getComputedStyle(el).border,
	                    rect: rectInfo(el)
	                };
	            }

	            return {
	                location: window.location.href,
	                firstCardText: firstCard ? (firstCard.textContent || '').trim() : null,
	                firstHeading: firstHeading ? { rect: rectInfo(firstHeading) } : null,
	                firstMeta: firstMeta ? { rect: rectInfo(firstMeta) } : null,
	                firstTitle: firstTitle ? {
	                    text: (firstTitle.textContent || '').trim(),
	                    color: getComputedStyle(firstTitle).color,
	                    rect: rectInfo(firstTitle)
	                } : null,
	                firstDescription: firstDescription ? {
	                    text: (firstDescription.textContent || '').trim(),
	                    color: getComputedStyle(firstDescription).color,
	                    rect: rectInfo(firstDescription)
	                } : null,
	                firstUnread: pillInfo(firstUnread),
	                firstTotal: pillInfo(firstTotal)
	            };
	        });

	        console.log('PLAYWRIGHT_FORUM_SUBS=' + JSON.stringify({
	            probe: probe,
	            apiResponses: apiResponses,
	            consoleMessages: consoleMessages,
	            screenshot: shot
	        }));

	        await context.close();
	    });

	    test('inspect logged-in sports sub card layout', async function ({ browser }, testInfo) {
	        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
	        const context = await browser.newContext({
	            ignoreHTTPSErrors: true,
	            serviceWorkers: 'block'
	        });
	        const page = await context.newPage();

	        await loginViaApi(context);
	        await page.goto(baseUrl + '/?page=002-forum.xjs&group=1&_pw=' + Date.now(), {
	            waitUntil: 'domcontentloaded'
	        });
	        await expect(page.locator('#forum-list-container .forum-directory-card').first()).toBeVisible({ timeout: 30000 });
	        await page.waitForTimeout(2500);

	        const shot = testInfo.outputPath('forum-sports-sub.png');
	        await page.screenshot({ path: shot, fullPage: true });

	        const probe = await page.evaluate(function () {
	            var cards = Array.from(document.querySelectorAll('#forum-list-container .forum-directory-card'));
	            var target = cards.find(function (card) {
	                var title = card.querySelector('strong[data-sub-name]');
	                return title && /sports/i.test(title.textContent || '');
	            }) || null;

	            function rectInfo(el) {
	                if (!el) return null;
	                var rect = el.getBoundingClientRect();
	                return {
	                    x: rect.x,
	                    y: rect.y,
	                    width: rect.width,
	                    height: rect.height
	                };
	            }

	            function pillInfo(el) {
	                if (!el) return null;
	                return {
	                    hidden: el.hidden,
	                    text: (el.textContent || '').trim(),
	                    color: getComputedStyle(el).color,
	                    fontWeight: getComputedStyle(el).fontWeight,
	                    background: getComputedStyle(el).backgroundColor,
	                    border: getComputedStyle(el).border,
	                    rect: rectInfo(el)
	                };
	            }

	            if (!target) return { found: false };

	            var title = target.querySelector('strong[data-sub-name]');
	            var description = target.querySelector('p[data-sub-description]');
	            var unread = target.querySelector('[data-unread-unscanned]');
	            var total = target.querySelector('[data-total-msgs]');
	            var latest = target.querySelector('[data-newest-message-container]');
	            var icon = target.querySelector('[data-forum-icon]');
	            var cardRect = rectInfo(target);
	            var iconRect = rectInfo(icon);
	            var iconCenterDelta = null;
	            if (cardRect && iconRect) {
	                iconCenterDelta = Math.abs((iconRect.y + (iconRect.height / 2)) - (cardRect.y + (cardRect.height / 2)));
	            }

	            return {
	                found: true,
	                title: title ? {
	                    text: (title.textContent || '').trim(),
	                    color: getComputedStyle(title).color,
	                    rect: rectInfo(title)
	                } : null,
	                description: description ? {
	                    text: (description.textContent || '').trim(),
	                    color: getComputedStyle(description).color,
	                    rect: rectInfo(description)
	                } : null,
	                unread: pillInfo(unread),
	                total: pillInfo(total),
	                latest: latest ? {
	                    text: (latest.textContent || '').replace(/\s+/g, ' ').trim(),
	                    rect: rectInfo(latest)
	                } : null,
	                cardRect: cardRect,
	                iconRect: iconRect,
	                iconCenterDelta: iconCenterDelta
	            };
	        });

	        console.log('PLAYWRIGHT_FORUM_SPORTS=' + JSON.stringify({
	            probe: probe,
	            screenshot: shot
	        }));

	        await context.close();
	    });

	    test('inspect logged-in thread list card layout', async function ({ browser }, testInfo) {
	        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
	        const context = await browser.newContext({
	            ignoreHTTPSErrors: true,
	            serviceWorkers: 'block'
	        });
	        const page = await context.newPage();

	        function absoluteUrl(href) {
	            if (!href) return null;
	            if (/^https?:\/\//i.test(href)) return href;
	            if (href.charAt(0) === '/') return baseUrl + href;
	            return baseUrl + '/' + href.replace(/^\.\//, '');
	        }

	        await loginViaApi(context);
	        await page.goto(baseUrl + '/?page=002-forum.xjs&group=1&_pw=' + Date.now(), {
	            waitUntil: 'domcontentloaded'
	        });
	        await expect(page.locator('#forum-list-container .forum-directory-card').first()).toBeVisible({ timeout: 30000 });

	        const subUrls = await page.$$eval('#forum-list-container a.forum-directory-card', function (cards) {
	            return cards.map(function (card) { return card.getAttribute('href'); }).filter(Boolean);
	        });

	        let probe = null;
	        let inspectedUrl = null;
	        for (const href of subUrls.slice(0, 6)) {
	            const nextUrl = absoluteUrl(href);
	            if (!nextUrl) continue;
	            inspectedUrl = nextUrl;
	            await page.goto(nextUrl + (nextUrl.indexOf('?') > -1 ? '&' : '?') + '_pw=' + Date.now(), {
	                waitUntil: 'domcontentloaded'
	            });
	            await expect(page.locator('#forum-list-container .forum-thread-card').first()).toBeVisible({ timeout: 30000 });
	            await page.waitForTimeout(2500);

	            probe = await page.evaluate(function () {
	                var cards = Array.from(document.querySelectorAll('#forum-list-container .forum-thread-card'));
	                var target = cards.find(function (card) {
	                    var replies = card.querySelector('[data-replies]');
	                    return replies && !replies.hidden;
	                }) || cards[0] || null;

	                function rectInfo(el) {
	                    if (!el) return null;
	                    var rect = el.getBoundingClientRect();
	                    return {
	                        x: rect.x,
	                        y: rect.y,
	                        width: rect.width,
	                        height: rect.height
	                    };
	                }

	                function pillInfo(el) {
	                    if (!el) return null;
	                    return {
	                        hidden: el.hidden,
	                        text: (el.textContent || '').trim(),
	                        color: getComputedStyle(el).color,
	                        fontWeight: getComputedStyle(el).fontWeight,
	                        background: getComputedStyle(el).backgroundColor,
	                        border: getComputedStyle(el).border,
	                        rect: rectInfo(el)
	                    };
	                }

	                function avatarInfo(el) {
	                    if (!el) return null;
	                    return {
	                        hidden: el.hidden,
	                        rect: rectInfo(el),
	                        hasGraphic: !!el.querySelector('img, canvas')
	                    };
	                }

	                if (!target) return { found: false };

	                var replies = target.querySelector('[data-replies]');
	                var noReplies = target.querySelector('[data-no-replies]');
	                var subject = target.querySelector('strong[data-thread-subject]');
	                var unread = target.querySelector('[data-unread-messages]');
	                var origin = target.querySelector('.forum-thread-origin');
	                var latest = (!replies || replies.hidden) ? noReplies : replies;

	                return {
	                    found: true,
	                    hasReplies: !!(replies && !replies.hidden),
	                    subject: subject ? {
	                        text: (subject.textContent || '').trim(),
	                        color: getComputedStyle(subject).color,
	                        fontWeight: getComputedStyle(subject).fontWeight,
	                        rect: rectInfo(subject)
	                    } : null,
	                    unread: pillInfo(unread),
	                    originRect: rectInfo(origin),
	                    latestRect: rectInfo(latest),
	                    originAvatar: avatarInfo(target.querySelector('[data-thread-origin-avatar]')),
	                    latestAvatar: avatarInfo(target.querySelector('[data-thread-latest-avatar]')),
	                    latestText: latest ? (latest.textContent || '').replace(/\s+/g, ' ').trim() : null,
	                    cardRect: rectInfo(target)
	                };
	            });

	            if (probe && probe.found && probe.hasReplies) break;
	        }

	        const shot = testInfo.outputPath('forum-thread-cards.png');
	        await page.screenshot({ path: shot, fullPage: true });

	        console.log('PLAYWRIGHT_FORUM_THREADS=' + JSON.stringify({
	            url: inspectedUrl || page.url(),
	            probe: probe,
	            screenshot: shot
	        }));

	        await context.close();
	    });

	    test('inspect thread read cards and ansi toggle', async function ({ browser }, testInfo) {
	        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
	        const context = await browser.newContext({
	            ignoreHTTPSErrors: true,
	            serviceWorkers: 'block'
	        });
	        const page = await context.newPage();

	        function absoluteUrl(href) {
	            if (!href) return null;
	            if (/^https?:\/\//i.test(href)) return href;
	            if (href.charAt(0) === '/') return baseUrl + href;
	            return baseUrl + '/' + href.replace(/^\.\//, '');
	        }

	        await loginViaApi(context);
	        await page.goto(baseUrl + '/?page=002-forum.xjs&group=1&_pw=' + Date.now(), {
	            waitUntil: 'domcontentloaded'
	        });
	        await expect(page.locator('#forum-list-container .forum-directory-card').first()).toBeVisible({ timeout: 30000 });

	        const subUrls = await page.$$eval('#forum-list-container a.forum-directory-card', function (cards) {
	            return cards.map(function (card) { return card.getAttribute('href'); }).filter(Boolean);
	        });

	        let threadUrl = null;
	        for (const href of subUrls.slice(0, 6)) {
	            const nextUrl = absoluteUrl(href);
	            if (!nextUrl) continue;
	            await page.goto(nextUrl + (nextUrl.indexOf('?') > -1 ? '&' : '?') + '_pw=' + Date.now(), {
	                waitUntil: 'domcontentloaded'
	            });
	            await expect(page.locator('#forum-list-container .forum-thread-card').first()).toBeVisible({ timeout: 30000 });
	            threadUrl = await page.locator('#forum-list-container .forum-thread-card').first().getAttribute('href');
	            if (threadUrl) {
	                threadUrl = absoluteUrl(threadUrl);
	                break;
	            }
	        }

	        expect(threadUrl).toBeTruthy();
	        await page.goto(threadUrl + (threadUrl.indexOf('?') > -1 ? '&' : '?') + '_pw=' + Date.now(), {
	            waitUntil: 'domcontentloaded'
	        });
	        await expect(page.locator('#forum-list-container .forum-message-card').first()).toBeVisible({ timeout: 30000 });
	        await page.waitForTimeout(2500);

	        const cardProbe = await page.evaluate(function () {
	            var first = document.querySelector('#forum-list-container .forum-message-card');
	            function rectInfo(el) {
	                if (!el) return null;
	                var rect = el.getBoundingClientRect();
	                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
	            }
	            if (!first) return { found: false };
	            var subject = first.querySelector('strong[data-message-subject]');
	            var avatar = first.querySelector('[data-message-avatar]');
	            return {
	                found: true,
	                subject: subject ? {
	                    text: (subject.textContent || '').trim(),
	                    color: getComputedStyle(subject).color,
	                    fontWeight: getComputedStyle(subject).fontWeight,
	                    rect: rectInfo(subject)
	                } : null,
	                card: {
	                    border: getComputedStyle(first).border,
	                    background: getComputedStyle(first).backgroundColor,
	                    rect: rectInfo(first)
	                },
	                avatar: avatar ? {
	                    rect: rectInfo(avatar),
	                    hasGraphic: !!avatar.querySelector('img, canvas')
	                } : null
	            };
	        });

	        const replyButton = page.locator('#forum-list-container .forum-message-card button[data-button-reply]').first();
	        await replyButton.click();
	        const replyBox = page.locator('div[id^="replybox-"]').first();
	        await expect(replyBox).toBeVisible({ timeout: 30000 });
	        const toggleButton = replyBox.locator('.ansi-editor-toggle');
	        const replyTextarea = replyBox.locator('textarea');

	        await toggleButton.click();
	        await expect(page.locator('.ansi-editor-container')).toHaveCount(1, { timeout: 30000 });
	        await expect(toggleButton).toHaveText('Text Mode');

	        await toggleButton.click();
	        await expect(page.locator('.ansi-editor-container')).toHaveCount(0, { timeout: 30000 });
	        await expect(toggleButton).toHaveText('ANSI Art');

	        const toggleProbe = await page.evaluate(function () {
	            var replyBox = document.querySelector('div[id^="replybox-"]');
	            if (!replyBox) return { found: false };
	            var textarea = replyBox.querySelector('textarea');
	            var toggle = replyBox.querySelector('.ansi-editor-toggle');
	            return {
	                found: true,
	                buttonText: toggle ? (toggle.textContent || '').trim() : null,
	                editorCount: document.querySelectorAll('.ansi-editor-container').length,
	                textareaDisplay: textarea ? getComputedStyle(textarea).display : null,
	                textareaSessionActive: !!(textarea && textarea._ansiEditorSession)
	            };
	        });

	        const shot = testInfo.outputPath('forum-thread-read.png');
	        await page.screenshot({ path: shot, fullPage: true });

	        console.log('PLAYWRIGHT_FORUM_THREAD_READ=' + JSON.stringify({
	            url: page.url(),
	            cardProbe: cardProbe,
	            toggleProbe: toggleProbe,
	            screenshot: shot
	        }));

	        await context.close();
	    });

	    test('inspect thread read with service worker enabled', async function ({ browser }, testInfo) {
	        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
	        const context = await browser.newContext({
	            ignoreHTTPSErrors: true
	        });
	        const page = await context.newPage();
	        const consoleMessages = [];
	        const pageErrors = [];

	        page.on('console', function (msg) {
	            consoleMessages.push({
	                type: msg.type(),
	                text: msg.text()
	            });
	        });
	        page.on('pageerror', function (err) {
	            pageErrors.push(String(err));
	        });

	        function absoluteUrl(href) {
	            if (!href) return null;
	            if (/^https?:\/\//i.test(href)) return href;
	            if (href.charAt(0) === '/') return baseUrl + href;
	            return baseUrl + '/' + href.replace(/^\.\//, '');
	        }

	        await loginViaApi(context);
	        await page.goto(baseUrl + '/?page=002-forum.xjs&group=0&_pw=' + Date.now(), {
	            waitUntil: 'domcontentloaded'
	        });
	        await expect(page.locator('#forum-list-container .forum-directory-card').first()).toBeVisible({ timeout: 30000 });

	        const subUrl = await page.locator('#forum-list-container a.forum-directory-card').first().getAttribute('href');
	        expect(subUrl).toBeTruthy();
	        await page.goto(absoluteUrl(subUrl) + '&_pw=' + Date.now(), {
	            waitUntil: 'domcontentloaded'
	        });
	        await expect(page.locator('#forum-list-container .forum-thread-card').first()).toBeVisible({ timeout: 30000 });

	        const threadUrl = await page.locator('#forum-list-container .forum-thread-card').first().getAttribute('href');
	        expect(threadUrl).toBeTruthy();

	        const finalUrl = absoluteUrl(threadUrl) + '&_pw=' + Date.now();
	        await page.goto(finalUrl, { waitUntil: 'domcontentloaded' });
	        await page.waitForTimeout(1500);
	        await page.reload({ waitUntil: 'domcontentloaded' });
	        await page.waitForTimeout(2500);

	        const messageCount = await page.locator('#forum-list-container .forum-message-card').count();
	        const shot = testInfo.outputPath('forum-thread-read-sw.png');
	        await page.screenshot({ path: shot, fullPage: true });

	        console.log('PLAYWRIGHT_FORUM_THREAD_READ_SW=' + JSON.stringify({
	            url: page.url(),
	            messageCount: messageCount,
	            consoleMessages: consoleMessages,
	            pageErrors: pageErrors,
	            screenshot: shot
	        }));

	        expect(messageCount).toBeGreaterThan(0);
	        expect(pageErrors).toEqual([]);

	        await context.close();
	    });
	});
