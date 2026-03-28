// Local Playwright harness for webv4_custom debugging.
/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: './playwright',
  timeout: 120000,
  retries: 0,
  use: {
    headless: true,
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  reporter: [['list']]
};
