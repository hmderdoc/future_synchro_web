import puppeteer from 'puppeteer';
const URL = 'http://localhost:4080/ansi-editor/test.html';
(async () => {
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    page.setViewport({ width: 1400, height: 900 });
    const logs = [];
    page.on('console', msg => logs.push(msg.text()));
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    console.log('Loading editor...');
    await page.goto(URL, { waitUntil: 'networkidle0', timeout: 15000 });
    await page.waitForSelector('.me-editor', { timeout: 5000 });
    console.log('✓ Editor loaded');

    // Test 1: All tools
    const tools = await page.evaluate(() => Object.keys(window.editor.el.toolBtns));
    const expect = ['select','brush','line','rect','ellipse','fill','sample'];
    console.log(`${expect.every(t=>tools.includes(t)) ? '✓' : '✗'} Tools: ${tools.join(', ')}`);

    // Test 2: Fill toggle visibility
    const ft = await page.evaluate(() => { const e=window.editor; e._selectTool('rect'); return e.el.fillToggle.classList.contains('me-visible'); });
    console.log(`${ft?'✓':'✗'} Fill toggle visible with rect tool`);

    // Test 3: Line
    const lineN = await page.evaluate(() => { const e=window.editor; e._selectTool('line'); e._commitShape(0,0,10,5); let n=0; for(let y=0;y<=5;y++) for(let x=0;x<=10;x++) { const b=e.doc.at(x,y); if(b&&b.code!==32) n++; } return n; });
    console.log(`${lineN>0?'✓':'✗'} Line drew ${lineN} cells`);

    // Test 4: Rect outline
    const rectN = await page.evaluate(() => { const e=window.editor; e._selectTool('rect'); e.shapeFilled=false; e._commitShape(20,2,30,8); let n=0; for(let y=2;y<=8;y++) for(let x=20;x<=30;x++) { const b=e.doc.at(x,y); if(b&&b.code!==32) n++; } return n; });
    console.log(`${rectN>20?'✓':'✗'} Rect outline: ${rectN} cells (expect ~32)`);

    // Test 5: Filled rect
    const fRectN = await page.evaluate(() => { const e=window.editor; e.shapeFilled=true; e._commitShape(40,2,50,8); let n=0; for(let y=2;y<=8;y++) for(let x=40;x<=50;x++) { const b=e.doc.at(x,y); if(b&&b.code!==32) n++; } return n; });
    console.log(`${fRectN===77?'✓':'✗'} Filled rect: ${fRectN} cells (expect 77)`);

    // Test 6: Ellipse
    const ellN = await page.evaluate(() => { const e=window.editor; e._selectTool('ellipse'); e.shapeFilled=false; e._commitShape(60,12,70,18); let n=0; for(let y=5;y<=20;y++) for(let x=50;x<=75;x++) { const b=e.doc.at(x,y); if(b&&b.code!==32) n++; } return n; });
    console.log(`${ellN>0?'✓':'✗'} Ellipse: ${ellN} cells`);

    // Test 7: Resize
    const rz = await page.evaluate(() => { const e=window.editor; e.setCanvasSize(100,50); return {c:e.columns,r:e.rows}; });
    console.log(`${rz.c===100&&rz.r===50?'✓':'✗'} Resize: ${rz.c}×${rz.r}`);

    // Test 8: Auto-grow
    const ag = await page.evaluate(() => { const e=window.editor; e._selectTool('select'); e._moveCursor(0,e.rows-1); const before=e.rows; e._handleSelectKey({key:'Enter',preventDefault:()=>{}}); return {before,after:e.rows}; });
    console.log(`${ag.after>ag.before?'✓':'✗'} Auto-grow: ${ag.before}→${ag.after}`);

    // Test 9: Preview
    const pv = await page.evaluate(() => { const c=window.editor.el.previewCanvas; return {w:c?c.width:0,h:c?c.height:0}; });
    console.log(`${pv.w>0&&pv.h>0?'✓':'✗'} Preview: ${pv.w}×${pv.h}`);

    // Test 10: View frame
    const vf = await page.evaluate(() => window.editor.el.viewFrame.style.display);
    console.log(`${vf==='block'?'✓':'✗'} View frame: ${vf}`);

    // Test 11: Load file button
    const lb = await page.evaluate(() => !!document.querySelector('.me-action-left .me-btn'));
    console.log(`${lb?'✓':'✗'} Load File button`);

    // Test 12: Status bar dims clickable
    const sd = await page.evaluate(() => { const d=window.editor.el.statusDim; return {text:d.textContent,cursor:d.style.cursor}; });
    console.log(`${sd.text.includes('×')?'✓':'✗'} Status dimensions: "${sd.text}" cursor=${sd.cursor}`);

    // Test 13: Resize overlay
    const ro = await page.evaluate(() => { const e=window.editor; e._showResizeOverlay(); const v=e.el.resizeOverlay.classList.contains('me-visible'); e._hideOverlay(); return v; });
    console.log(`${ro?'✓':'✗'} Resize overlay opens`);

    // Test 14: loadBytes ANS
    const la = await page.evaluate(() => { try { const e=window.editor; e.loadBytes(new Uint8Array([72,101,108,108,111]),'t.ans'); const c=e.doc.at(0,0); return {ok:true,code:c?c.code:-1}; } catch(e) { return {ok:false,err:e.message}; } });
    console.log(`${la.ok&&la.code===72?'✓':'✗'} loadBytes ANS: code=${la.code}`);

    // Test 15: loadBytes BIN
    const lb2 = await page.evaluate(() => { try { const e=window.editor; e.loadBytes(new Uint8Array([65,0x07,66,0x1F]),'t.bin'); const c0=e.doc.at(0,0); const c1=e.doc.at(1,0); return {ok:true,c0:{code:c0.code,fg:c0.fg,bg:c0.bg},c1:{code:c1.code,fg:c1.fg,bg:c1.bg}}; } catch(e) { return {ok:false,err:e.message}; } });
    const binOk = lb2.ok && lb2.c0.code===65 && lb2.c0.fg===7 && lb2.c1.code===66 && lb2.c1.fg===15 && lb2.c1.bg===1;
    console.log(`${binOk?'✓':'✗'} loadBytes BIN: ${JSON.stringify(lb2)}`);

    // Summary
    if (errors.length > 0) { console.log('\n--- ERRORS ---'); errors.forEach(e => console.log('  ✗', e)); }
    else console.log('\n✓ No page errors');

    console.log('\nConsole:'); logs.slice(0,6).forEach(l => console.log('  ', l));

    await browser.close();
    process.exit(errors.length > 0 ? 1 : 0);
})();
