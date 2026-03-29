const { test, expect } = require('@playwright/test');

const siteUrl = process.env.PW_SITE_URL || 'https://futureland.today';

test.describe('search layout alignment', () => {
  test('news and forum search rows match intended orientation', async ({ page }) => {
    await page.goto(`${siteUrl}/?page=009-news.xjs`, { waitUntil: 'networkidle' });

    await page.waitForSelector('#news-search-bar .input-group');
    await page.waitForSelector('#news-breadcrumb .breadcrumb');

    const newsMetrics = await page.evaluate(() => {
      const searchGroup = document.querySelector('#news-search-bar .input-group');
      const breadcrumb = document.querySelector('#news-breadcrumb .breadcrumb');
      const searchBtn = document.getElementById('news-search-btn');
      const searchInput = document.getElementById('news-search-input');
      const hasBinIcon = !!searchBtn.querySelector('.bin-icon');
      const searchRect = searchGroup.getBoundingClientRect();
      const crumbRect = breadcrumb.getBoundingClientRect();
      const btnRect = searchBtn.getBoundingClientRect();
      const inputRect = searchInput.getBoundingClientRect();
      return {
        searchTop: searchRect.top,
        breadcrumbTop: crumbRect.top,
        searchHeight: searchRect.height,
        breadcrumbHeight: crumbRect.height,
        btnLeft: btnRect.left,
        inputLeft: inputRect.left,
        hasBinIcon,
        buttonText: searchBtn.textContent.trim()
      };
    });

    expect(newsMetrics.searchTop).toBeLessThan(newsMetrics.breadcrumbTop);
    expect(Math.abs(newsMetrics.searchHeight - newsMetrics.breadcrumbHeight)).toBeLessThanOrEqual(6);
    expect(newsMetrics.btnLeft).toBeLessThan(newsMetrics.inputLeft);
    expect(newsMetrics.hasBinIcon).toBeTruthy();
    expect(newsMetrics.buttonText).not.toContain('🔍');

    await page.goto(`${siteUrl}/?page=002-forum.xjs`, { waitUntil: 'networkidle' });
    await page.waitForSelector('#forum-search-bar .input-group');

    const forumMetrics = await page.evaluate(() => {
      const searchBtn = document.getElementById('forum-search-btn');
      const searchInput = document.getElementById('forum-search-input');
      const hasBinIcon = !!searchBtn.querySelector('.bin-icon');
      const btnRect = searchBtn.getBoundingClientRect();
      const inputRect = searchInput.getBoundingClientRect();
      return {
        btnLeft: btnRect.left,
        inputLeft: inputRect.left,
        hasBinIcon
      };
    });

    expect(forumMetrics.btnLeft).toBeLessThan(forumMetrics.inputLeft);
    expect(forumMetrics.hasBinIcon).toBeTruthy();
  });
});
