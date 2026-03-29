const { test, expect } = require('@playwright/test');

const SITE_URL = process.env.PW_SITE_URL;

function requireEnv(name) {
    if (!process.env[name]) {
        throw new Error('Missing required env var: ' + name);
    }
    return process.env[name];
}

test.describe('forum layout debug', function () {
    test.skip(!SITE_URL, 'PW_SITE_URL is required');

    test('measure search, breadcrumb, and card spacing', async function ({ browser }, testInfo) {
        const baseUrl = requireEnv('PW_SITE_URL').replace(/\/+$/, '');
        const context = await browser.newContext({
            ignoreHTTPSErrors: true
        });
        const page = await context.newPage();

        await page.goto(baseUrl + '/?page=002-forum.xjs&_pw=' + Date.now(), {
            waitUntil: 'domcontentloaded'
        });
        await expect(page.locator('#forum-search-bar')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('.forum-breadcrumb')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('#forum-list-container .forum-directory-card').first()).toBeVisible({ timeout: 30000 });
        await page.waitForTimeout(1500);
        await page.evaluate(function () {
            var firstCard = document.querySelector('#forum-list-container .forum-directory-card');
            if (firstCard && typeof showGroupUnreadCount === 'function') {
                showGroupUnreadCount(firstCard, { total: 854, scanned: 13 });
            }
        });

        const shot = testInfo.outputPath('forum-layout.png');
        await page.screenshot({ path: shot, fullPage: true });

        const metrics = await page.evaluate(function () {
            const searchBar = document.getElementById('forum-search-bar');
            const inputGroup = searchBar ? searchBar.querySelector('.input-group') : null;
            const breadcrumb = document.querySelector('.forum-breadcrumb');
            const firstCard = document.querySelector('#forum-list-container .forum-directory-card');
            const searchInput = document.getElementById('forum-search-input');
            const scopeBtn = document.getElementById('forum-search-scope-btn');
            const searchBtn = document.getElementById('forum-search-btn');
            const firstGroupName = firstCard ? firstCard.querySelector('[data-group-name]') : null;
            const firstGroupDescription = firstCard ? firstCard.querySelector('[data-group-description]') : null;
            const firstGroupSubCount = firstCard ? firstCard.querySelector('[data-group-sub-count]') : null;
            const firstIcon = firstCard ? firstCard.querySelector('.forum-icon') : null;
            const firstGroupHeading = firstCard ? firstCard.querySelector('.forum-group-heading') : null;
            const firstGroupBadges = firstCard ? firstCard.querySelector('.forum-group-badges') : null;
            const firstUnreadBadge = firstCard ? firstCard.querySelector('[data-unread-unscanned]') : null;
            const firstScannedBadge = firstCard ? firstCard.querySelector('[data-unread-scanned]') : null;

            function rect(el) {
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return {
                    top: r.top,
                    bottom: r.bottom,
                    left: r.left,
                    right: r.right,
                    width: r.width,
                    height: r.height
                };
            }

            function styles(el) {
                if (!el) return null;
                const cs = getComputedStyle(el);
                return {
                    marginTop: cs.marginTop,
                    marginBottom: cs.marginBottom,
                    paddingTop: cs.paddingTop,
                    paddingBottom: cs.paddingBottom,
                    height: cs.height,
                    display: cs.display,
                    alignItems: cs.alignItems,
                    backgroundColor: cs.backgroundColor,
                    color: cs.color,
                    border: cs.border,
                    borderColor: cs.borderColor
                };
            }

            const searchRect = rect(searchBar);
            const inputRect = rect(inputGroup);
            const crumbRect = rect(breadcrumb);
            const cardRect = rect(firstCard);

            return {
                location: window.location.href,
                gapSearchToBreadcrumb: searchRect && crumbRect ? crumbRect.top - searchRect.bottom : null,
                gapInputToBreadcrumb: inputRect && crumbRect ? crumbRect.top - inputRect.bottom : null,
                gapBreadcrumbToCard: crumbRect && cardRect ? cardRect.top - crumbRect.bottom : null,
                rects: {
                    searchBar: searchRect,
                    inputGroup: inputRect,
                    breadcrumb: crumbRect,
                    firstCard: cardRect,
                    searchInput: rect(searchInput),
                    scopeBtn: rect(scopeBtn),
                    searchBtn: rect(searchBtn),
                    firstGroupHeading: rect(firstGroupHeading),
                    firstGroupBadges: rect(firstGroupBadges),
                    firstUnreadBadge: rect(firstUnreadBadge),
                    firstScannedBadge: rect(firstScannedBadge),
                    firstGroupName: rect(firstGroupName)
                },
                styles: {
                    searchBar: styles(searchBar),
                    inputGroup: styles(inputGroup),
                    breadcrumb: styles(breadcrumb),
                    firstCard: styles(firstCard),
                    searchInput: styles(searchInput),
                    scopeBtn: styles(scopeBtn),
                    searchBtn: styles(searchBtn),
                    firstGroupHeading: styles(firstGroupHeading),
                    firstGroupBadges: styles(firstGroupBadges),
                    firstUnreadBadge: styles(firstUnreadBadge),
                    firstScannedBadge: styles(firstScannedBadge),
                    firstGroupName: styles(firstGroupName),
                    firstGroupDescription: styles(firstGroupDescription),
                    firstGroupSubCount: styles(firstGroupSubCount),
                    firstIcon: styles(firstIcon)
                },
                breadcrumbText: breadcrumb ? (breadcrumb.textContent || '').trim() : null,
                groupCardText: {
                    name: firstGroupName ? (firstGroupName.textContent || '').trim() : null,
                    description: firstGroupDescription ? (firstGroupDescription.textContent || '').trim() : null,
                    subCount: firstGroupSubCount ? (firstGroupSubCount.textContent || '').trim() : null,
                    unread: firstUnreadBadge ? (firstUnreadBadge.textContent || '').trim() : null,
                    scanned: firstScannedBadge ? (firstScannedBadge.textContent || '').trim() : null
                }
            };
        });

        console.log('PLAYWRIGHT_FORUM_LAYOUT=' + JSON.stringify({
            metrics: metrics,
            screenshot: shot
        }));

        await context.close();
    });
});
