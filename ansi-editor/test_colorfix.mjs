import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 9877;
const root = path.resolve('.');
let server, browser, page;

function mime(f) {
    if (f.endsWith('.html')) return 'text/html';
    if (f.endsWith('.js')) return 'application/javascript';
    if (f.endsWith('.css')) return 'text/css';
    return 'application/octet-stream';
}

async function setup() {
    server = http.createServer((req, res) => {
        let fp = path.join(root, decodeURIComponent(req.url.split('?')[0]));
        if (fp.endsWith('/')) fp += 'index.html';
        if (!fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
        const stat = fs.statSync(fp);
        if (stat.isDirectory()) fp = path.join(fp, 'index.html');
        if (!fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': mime(fp) });
        fs.createReadStream(fp).pipe(res);
    }).listen(PORT);
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}/test.html`, { waitUntil: 'networkidle0', timeout: 15000 });
    await page.waitForSelector('.me-editor', { timeout: 10000 });
}

async function teardown() {
    if (browser) await browser.close();
    if (server) server.close();
}

let passed = 0, failed = 0;
function assert(name, cond) {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.log(`  ✗ ${name}`); }
}

async function runTests() {
    await setup();
    try {
        // Test 1: Color mapping roundtrip - ansiToCga in sauce.js
        console.log('\n=== Color Mapping Tests ===');
        const colorTest = await page.evaluate(() => {
            // Create test ANSI data: ESC[31m (ANSI Red) then 'A'
            // ANSI SGR 31 = Red in ANSI order, should map to CGA index 4 (Red)
            const testAnsi = new Uint8Array([
                0x1B, 0x5B, 0x33, 0x31, 0x6D,  // ESC[31m (ANSI Red)
                0x41,                             // 'A'
                0x1B, 0x5B, 0x33, 0x34, 0x6D,  // ESC[34m (ANSI Blue) 
                0x42,                             // 'B'
                0x1B, 0x5B, 0x33, 0x33, 0x6D,  // ESC[33m (ANSI Yellow/Brown)
                0x43,                             // 'C'
                0x1B, 0x5B, 0x33, 0x36, 0x6D,  // ESC[36m (ANSI Cyan)
                0x44,                             // 'D'
            ]);
            
            // Use the editor's loadBytes with a .ans filename  
            window.editor.loadBytes(testAnsi, 'test.ans');
            
            // Read back the cells
            const cellA = window.editor.doc.at(0, 0);  // 'A' with Red
            const cellB = window.editor.doc.at(1, 0);  // 'B' with Blue
            const cellC = window.editor.doc.at(2, 0);  // 'C' with Brown
            const cellD = window.editor.doc.at(3, 0);  // 'D' with Cyan
            
            return {
                A: { code: cellA.code, fg: cellA.fg },
                B: { code: cellB.code, fg: cellB.fg },
                C: { code: cellC.code, fg: cellC.fg },
                D: { code: cellD.code, fg: cellD.fg },
            };
        });
        
        assert('ESC[31m (ANSI Red) → CGA fg=4 (Red)', colorTest.A.fg === 4);
        assert('ESC[34m (ANSI Blue) → CGA fg=1 (Blue)', colorTest.B.fg === 1);
        assert('ESC[33m (ANSI Yellow) → CGA fg=6 (Brown)', colorTest.C.fg === 6);
        assert('ESC[36m (ANSI Cyan) → CGA fg=3 (Cyan)', colorTest.D.fg === 3);
        
        // Test 2: Background colors
        const bgTest = await page.evaluate(() => {
            const testAnsi = new Uint8Array([
                0x1B, 0x5B, 0x34, 0x31, 0x6D,  // ESC[41m (ANSI Red bg)
                0x41,
                0x1B, 0x5B, 0x34, 0x34, 0x6D,  // ESC[44m (ANSI Blue bg)
                0x42,
            ]);
            window.editor.loadBytes(testAnsi, 'test.ans');
            const cellA = window.editor.doc.at(0, 0);
            const cellB = window.editor.doc.at(1, 0);
            return { A_bg: cellA.bg, B_bg: cellB.bg };
        });
        
        assert('ESC[41m (ANSI Red bg) → CGA bg=4', bgTest.A_bg === 4);
        assert('ESC[44m (ANSI Blue bg) → CGA bg=1', bgTest.B_bg === 1);
        
        // Test 3: Bold (high-intensity) color mapping
        const boldTest = await page.evaluate(() => {
            const testAnsi = new Uint8Array([
                0x1B, 0x5B, 0x31, 0x3B, 0x33, 0x31, 0x6D,  // ESC[1;31m (Bold ANSI Red = Light Red)
                0x41,
                0x1B, 0x5B, 0x31, 0x3B, 0x33, 0x34, 0x6D,  // ESC[1;34m (Bold ANSI Blue = Light Blue)
                0x42,
            ]);
            window.editor.loadBytes(testAnsi, 'test.ans');
            const cellA = window.editor.doc.at(0, 0);
            const cellB = window.editor.doc.at(1, 0);
            return { A_fg: cellA.fg, B_fg: cellB.fg };
        });
        
        assert('ESC[1;31m (Bold Red) → CGA fg=12 (Light Red)', boldTest.A_fg === 12);
        assert('ESC[1;34m (Bold Blue) → CGA fg=9 (Light Blue)', boldTest.B_fg === 9);
        
        // Test 4: Encoder roundtrip
        const roundtrip = await page.evaluate(() => {
            // Load ANSI with known colors
            const testAnsi = new Uint8Array([
                0x1B, 0x5B, 0x33, 0x31, 0x6D, 0x52,  // ESC[31m R (Red)
                0x1B, 0x5B, 0x33, 0x34, 0x6D, 0x42,  // ESC[34m B (Blue)
            ]);
            window.editor.loadBytes(testAnsi, 'test.ans');
            
            // Get the ANSI output
            const output = window.editor.getAnsiData();
            
            // Find SGR codes in output
            // Look for ESC[...m patterns
            const codes = [];
            for (let i = 0; i < output.length; i++) {
                if (output[i] === 0x1B && output[i+1] === 0x5B) {
                    let params = '';
                    let j = i + 2;
                    while (j < output.length && output[j] !== 0x6D) {
                        params += String.fromCharCode(output[j]);
                        j++;
                    }
                    codes.push(params);
                    i = j;
                }
            }
            return codes;
        });
        
        // The encoder should output ESC[31m for Red and ESC[34m for Blue
        const hasRed31 = roundtrip.some(c => c.includes('31'));
        const hasBlue34 = roundtrip.some(c => c.includes('34'));
        assert('Encoder outputs SGR 31 for CGA Red', hasRed31);
        assert('Encoder outputs SGR 34 for CGA Blue', hasBlue34);
        
        // Test 5: Palette layout
        console.log('\n=== Palette Layout Tests ===');
        const palLayout = await page.evaluate(() => {
            const cells = document.querySelectorAll('.me-pal-cell');
            return Array.from(cells).map(c => parseInt(c.dataset.colorIndex));
        });
        
        const expectedOrder = [0, 8, 1, 9, 2, 10, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15];
        assert('Palette order matches Moebius layout', 
            JSON.stringify(palLayout) === JSON.stringify(expectedOrder));
        
        // Test 6: Selection features
        console.log('\n=== Selection Tests ===');
        
        const hasSelOverlay = await page.evaluate(() => {
            return !!document.querySelector('.me-selection-overlay');
        });
        assert('Selection overlay div exists', hasSelOverlay);
        
        // Test selection API
        const selectionWorks = await page.evaluate(() => {
            // Set selection programmatically
            window.editor._selection = { sx: 0, sy: 0, dx: 5, dy: 2 };
            window.editor._updateSelectionOverlay();
            const ov = document.querySelector('.me-selection-overlay');
            const isVisible = !ov.classList.contains('me-hidden');
            
            // Copy and check clipboard
            window.editor._copySelection();
            const hasClip = window.editor._clipboard !== null;
            const clipSize = hasClip ? window.editor._clipboard.data.length : 0;
            
            // Clear
            window.editor._clearSelection();
            const isHidden = ov.classList.contains('me-hidden');
            
            return { isVisible, hasClip, clipSize, isHidden };
        });
        
        assert('Selection overlay becomes visible', selectionWorks.isVisible);
        assert('Copy creates clipboard data', selectionWorks.hasClip);
        assert('Clipboard has correct size (6x3=18)', selectionWorks.clipSize === 18);
        assert('Clear hides selection overlay', selectionWorks.isHidden);
        
        // Test paste
        const pasteWorks = await page.evaluate(() => {
            // Create a 2x2 clipboard with known data
            window.editor._clipboard = {
                columns: 2, rows: 2,
                data: [
                    { code: 65, fg: 4, bg: 0 },
                    { code: 66, fg: 1, bg: 0 },
                    { code: 67, fg: 4, bg: 0 },
                    { code: 68, fg: 1, bg: 0 },
                ]
            };
            window.editor._moveCursor(10, 10);
            window.editor._pasteClipboard();
            
            const a = window.editor.doc.at(10, 10);
            const b = window.editor.doc.at(11, 10);
            return { a_code: a.code, a_fg: a.fg, b_code: b.code, b_fg: b.fg };
        });
        
        assert('Paste places block A at cursor', pasteWorks.a_code === 65 && pasteWorks.a_fg === 4);
        assert('Paste places block B next to A', pasteWorks.b_code === 66 && pasteWorks.b_fg === 1);

        // Test select tool icon
        const toolIcon = await page.evaluate(() => {
            const selectBtn = document.querySelector('.me-tool-btn');
            return selectBtn ? selectBtn.textContent : null;
        });
        assert('Select tool has correct icon', toolIcon === '⬚');
        
    } finally {
        await teardown();
    }
    
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => { console.error(e); process.exit(1); });
