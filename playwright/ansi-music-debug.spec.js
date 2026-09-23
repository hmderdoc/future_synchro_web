const { test, expect } = require('@playwright/test');

test('deployed terminal loads and filters ANSI music', async ({ browser }) => {
    const baseUrl = String(process.env.PW_SITE_URL || '').replace(/\/+$/, '');
    test.skip(!baseUrl, 'PW_SITE_URL is required');
    const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        serviceWorkers: 'block'
    });
    const page = await context.newPage();
    const responses = [];
    page.on('response', response => {
        if (/ansi-music|terminal-iframe/.test(response.url())) {
            responses.push({ url: response.url(), status: response.status() });
        }
    });
    await page.goto(baseUrl + '/terminal-iframe.html?_pw=' + Date.now(), {
        waitUntil: 'domcontentloaded'
    });
    await page.waitForFunction(() => !!window._ftClient, null, { timeout: 30000 });
    const result = await page.evaluate(() => {
        if (!window.AnsiMusic) return { loaded: false };
        const played = [];
        const filter = new window.AnsiMusic.Filter(mml => played.push(mml));
        return {
            loaded: true,
            output: filter.feed('\x1b[MBMLT145O2F#4O4A8P8\x0eafter'),
            played,
            client: !!window._ftClient,
            bridge: !!(window._ftClient && window._ftClient._Ansi &&
                window._ftClient._Ansi._flwebBridgeInstalled),
            writeHasMusicFilter: !!(window._ftClient && window._ftClient._Ansi &&
                /ansiMusicFilter/.test(String(window._ftClient._Ansi.Write)))
        };
    });
    expect(result).toEqual({
        loaded: true,
        output: 'after',
        played: ['BMLT145O2F#4O4A8P8'],
        client: true,
        bridge: true,
        writeHasMusicFilter: true
    });
    expect(responses.some(response => /ansi-music\.js/.test(response.url) && response.status === 200)).toBeTruthy();
    await context.close();
});
