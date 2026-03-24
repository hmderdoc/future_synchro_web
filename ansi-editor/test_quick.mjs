import puppeteer from 'puppeteer';
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = 9879;
const root = process.cwd();

const server = http.createServer((req, res) => {
    let url = decodeURIComponent(req.url.split('?')[0]);
    let fp = path.join(root, url);
    try {
        if (!fs.existsSync(fp)) { res.writeHead(404); res.end('Not found'); return; }
        const stat = fs.statSync(fp);
        if (stat.isDirectory()) fp = path.join(fp, 'index.html');
        if (!fs.existsSync(fp)) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200);
        fs.createReadStream(fp).pipe(res);
    } catch(e) {
        res.writeHead(500); res.end(e.message);
    }
}).listen(PORT);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', msg => console.log('PAGE:', msg.text()));
page.on('pageerror', err => console.log('PAGE_ERR:', err.message));
await page.goto(`http://localhost:${PORT}/test.html`, { waitUntil: 'networkidle0', timeout: 15000 });
console.log('Page loaded, waiting 2s...');
await new Promise(r => setTimeout(r, 2000));

const hasEditor = await page.evaluate(() => !!document.querySelector('.me-editor'));
console.log('Has .me-editor:', hasEditor);

if (hasEditor) {
    console.log('Editor found!');
} else {
    const html = await page.content();
    console.log('HTML length:', html.length);
    console.log('HTML snippet:', html.substring(0, 500));
}

await browser.close();
server.close();
