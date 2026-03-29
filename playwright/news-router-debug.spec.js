const { test, expect } = require('@playwright/test');

const siteUrl = process.env.PW_SITE_URL || 'https://futureland.today';

test.describe('news router history', () => {
  test('back button restores feed and article states', async ({ page }) => {
    await page.goto(`${siteUrl}/?page=009-news.xjs`, { waitUntil: 'networkidle' });

    await page.waitForSelector('.news-cat-card');
    await page.locator('.news-cat-card').first().click();

    await page.waitForSelector('.news-feed-item');
    const firstFeedLabel = (await page.locator('.news-feed-item .news-feed-label').first().textContent()).trim();
    await page.locator('.news-feed-item').first().click();

    await page.waitForSelector('.news-article-row');
    const firstArticleTitle = (await page.locator('.news-article-title').first().textContent()).trim();
    await page.locator('.news-article-row').first().click();

    await page.waitForSelector('.news-article-detail h2');
    await expect(page.locator('.news-article-detail h2')).toHaveText(firstArticleTitle);

    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForSelector('.news-article-row');
    await expect(page.locator('.news-article-row').first()).toBeVisible();
    await expect(page.locator('#news-breadcrumb')).toContainText(firstFeedLabel);

    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForSelector('.news-feed-item');
    await expect(page.locator('.news-feed-item').first()).toBeVisible();
    await expect(page.locator('#news-breadcrumb')).not.toContainText(firstFeedLabel);
  });
});
