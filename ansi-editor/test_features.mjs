import puppeteer from 'puppeteer';
const URL = 'http://localhost:4080/ansi-editor/test.html';

(async () => {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    const logs = [];
    page.on('console', msg => logs.push(msg.text()));
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    console.log('Loading editor...');
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });
    await page.waitForSelector('.me-editor', { timeout: 8000 });
    console.log('✓ Editor loaded');

    let pass = 0, fail = 0;
    function check(ok, label) {
        console.log(`${ok ? '✓' : '✗'} ${label}`);
        if (ok) pass++; else fail++;
    }

    // Test 1: All 7 tools exist
    const tools = await page.evaluate(() => Object.keys(window.editor.el.toolBtns));
    const expect7 = ['select','brush','line','rect','ellipse','fill','sample'];
    check(expect7.every(t => tools.includes(t)), `Tools: ${tools.join(', ')}`);

    // Test 2: Fill toggle visible with rect tool
    const ft = await page.evaluate(() => {
        const e = window.editor;
        e._selectTool('rect');
        return e.el.fillToggle.classList.contains('me-visible');
    });
    check(ft, 'Fill toggle visible with rect tool');

    // Test 3: Fill toggle hidden with brush tool
    const ftHidden = await page.evaluate(() => {
        window.editor._selectTool('brush');
        return !window.editor.el.fillToggle.classList.contains('me-visible');
    });
    check(ftHidden, 'Fill toggle hidden with brush tool');

    // Test 4: Line tool draws cells
    const lineN = await page.evaluate(() => {
        const e = window.editor;
        e._selectTool('line');
        e._commitShape(0, 0, 10, 5);
        let n = 0;
        for (let y = 0; y <= 5; y++)
            for (let x = 0; x <= 10; x++) {
                const b = e.doc.at(x, y);
                if (b && b.code !== 32) n++;
            }
        return n;
    });
    check(lineN > 5, `Line drew ${lineN} cells`);

    // Test 5: Rect outline
    const rectN = await page.evaluate(() => {
        const e = window.editor;
        e._selectTool('rect');
        e.shapeFilled = false;
        e._commitShape(20, 2, 30, 8);
        let n = 0;
        for (let y = 2; y <= 8; y++)
            for (let x = 20; x <= 30; x++) {
                const b = e.doc.at(x, y);
                if (b && b.code !== 32) n++;
            }
        return n;
    });
    check(rectN > 20, `Rect outline: ${rectN} cells`);

    // Test 6: Filled rect
    const fRectN = await page.evaluate(() => {
        const e = window.editor;
        e.shapeFilled = true;
        e._commitShape(40, 2, 50, 8);
        let n = 0;
        for (let y = 2; y <= 8; y++)
            for (let x = 40; x <= 50; x++) {
                const b = e.doc.at(x, y);
                if (b && b.code !== 32) n++;
            }
        return n;
    });
    check(fRectN === 77, `Filled rect: ${fRectN} cells (expect 77)`);

    // Test 7: Ellipse draws cells
    const ellN = await page.evaluate(() => {
        const e = window.editor;
        e._selectTool('ellipse');
        e.shapeFilled = false;
        e._commitShape(55, 10, 75, 20);
        let n = 0;
        for (let y = 5; y <= 24; y++)
            for (let x = 50; x <= 79; x++) {
                const b = e.doc.at(x, y);
                if (b && b.code !== 32) n++;
            }
        return n;
    });
    check(ellN > 10, `Ellipse: ${ellN} cells`);

    // Test 8: Canvas resize
    const rz = await page.evaluate(() => {
        const e = window.editor;
        e.setCanvasSize(100, 50);
        return { c: e.columns, r: e.rows };
    });
    check(rz.c === 100 && rz.r === 50, `Resize: ${rz.c}×${rz.r}`);

    // Test 9: Auto-grow on Enter at last row
    const ag = await page.evaluate(() => {
        const e = window.editor;
        e._selectTool('select');
        e._moveCursor(0, e.rows - 1);
        const before = e.rows;
        e._handleSelectKey({ key: 'Enter', preventDefault: () => {} });
        return { before, after: e.rows };
    });
    check(ag.after > ag.before, `Auto-grow: ${ag.before}→${ag.after}`);

    // Test 10: Preview canvas exists and has size
    const pv = await page.evaluate(() => {
        const c = window.editor.el.previewCanvas;
        return { w: c ? c.width : 0, h: c ? c.height : 0 };
    });
    check(pv.w > 0 && pv.h > 0, `Preview: ${pv.w}×${pv.h}`);

    // Test 11: View frame exists
    const vf = await page.evaluate(() => window.editor.el.viewFrame.style.display);
    check(vf === 'block', `View frame display: ${vf}`);

    // Test 12: Load File button exists
    const lb = await page.evaluate(() => !!document.querySelector('.me-action-left .me-btn'));
    check(lb, 'Load File button exists');

    // Test 13: Status bar dims clickable
    const sd = await page.evaluate(() => {
        const d = window.editor.el.statusDim;
        return { text: d.textContent, cls: d.className };
    });
    check(sd.text.includes('\u00D7') && sd.cls.includes('me-status-dim'), `Status dimensions: "${sd.text}"`);

    // Test 14: Resize overlay opens/closes
    const ro = await page.evaluate(() => {
        const e = window.editor;
        e._showResizeOverlay();
        const v = e.el.resizeOverlay.classList.contains('me-visible');
        e._hideOverlay();
        const h = !e.el.resizeOverlay.classList.contains('me-visible');
        return { opened: v, closed: h };
    });
    check(ro.opened && ro.closed, 'Resize overlay opens and closes');

    // Test 15: loadBytes ANS
    const la = await page.evaluate(() => {
        try {
            const e = window.editor;
            e.loadBytes(new Uint8Array([72, 101, 108, 108, 111]), 't.ans');
            const c = e.doc.at(0, 0);
            return { ok: true, code: c ? c.code : -1 };
        } catch (err) { return { ok: false, err: err.message }; }
    });
    check(la.ok && la.code === 72, `loadBytes ANS: code=${la.code}`);

    // Test 16: loadBytes BIN
    const lb2 = await page.evaluate(() => {
        try {
            const e = window.editor;
            e.loadBytes(new Uint8Array([65, 0x07, 66, 0x1F]), 't.bin');
            const c0 = e.doc.at(0, 0);
            const c1 = e.doc.at(1, 0);
            return {
                ok: true,
                c0: { code: c0.code, fg: c0.fg, bg: c0.bg },
                c1: { code: c1.code, fg: c1.fg, bg: c1.bg }
            };
        } catch (err) { return { ok: false, err: err.message }; }
    });
    const binOk = lb2.ok && lb2.c0.code === 65 && lb2.c0.fg === 7 &&
                  lb2.c1.code === 66 && lb2.c1.fg === 15 && lb2.c1.bg === 1;
    check(binOk, `loadBytes BIN: ${JSON.stringify(lb2)}`);

    // Summary
    console.log(`\n${pass} passed, ${fail} failed`);
    if (errors.length > 0) {
        console.log('--- PAGE ERRORS ---');
        errors.forEach(e => console.log('  ✗', e));
    }

    await browser.close();
    process.exit(fail > 0 || errors.length > 0 ? 1 : 0);
})();
