const { test, expect } = require('@playwright/test');

const siteUrl = process.env.PW_SITE_URL || 'https://futureland.today';

test.describe('games layout', () => {
  test('controls, stats, and game rows render as black cards', async ({ page }) => {
    await page.goto(`${siteUrl}/?page=003-games.xjs`, { waitUntil: 'networkidle' });

    await page.waitForSelector('#games-controls .games-toolbar-card');
    await page.waitForSelector('.games-stats-card');
    await page.waitForSelector('#games-grid .game-row');

    const metrics = await page.evaluate(() => {
      const controlCard = document.querySelector('#games-controls .games-toolbar-card');
      const statsCard = document.querySelector('.games-stats-card');
      const gameCard = document.querySelector('#games-grid .game-row');
      const controlStyle = window.getComputedStyle(controlCard);
      const statsStyle = window.getComputedStyle(statsCard);
      const gameStyle = window.getComputedStyle(gameCard);
      return {
        controlBg: controlStyle.backgroundColor,
        controlBorder: controlStyle.borderTopColor,
        statsBg: statsStyle.backgroundColor,
        gameBg: gameStyle.backgroundColor,
        gameBorder: gameStyle.borderTopColor,
        gameDisplay: gameStyle.display
      };
    });

    expect(metrics.controlBg).toBe('rgb(0, 0, 0)');
    expect(metrics.statsBg).toBe('rgb(0, 0, 0)');
    expect(metrics.gameBg).toBe('rgb(0, 0, 0)');
    expect(metrics.gameDisplay).toBe('grid');
    expect(metrics.controlBorder).toBe('rgb(85, 85, 255)');
    expect(metrics.gameBorder).toBe('rgb(85, 85, 255)');
  });
});
