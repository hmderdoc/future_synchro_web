// Minimal dependency-free WebSocket server that streams synthetic truecolor
// ANSI at a configurable byte rate. Stands in for websocketservice.js so the
// fTelnet client can be measured in isolation.
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.WS_PORT || '18777', 10);
const RATE = parseInt(process.env.WS_RATE || '25000', 10); // bytes/sec target
const COLS = 80, ROWS = 25;

function frame(buf) {
    const len = buf.length;
    let hdr;
    if (len < 126) { hdr = Buffer.from([0x82, len]); }
    else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x82; hdr[1] = 126; hdr.writeUInt16BE(len, 2); }
    else { hdr = Buffer.alloc(10); hdr[0] = 0x82; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([hdr, buf]);
}

let seed = 12345;
function rnd(n) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; }
const BLOCKS = [' ', '\xb0', '\xb1', '\xb2', '\xdb', '\xdc', '\xdf'];

// A full-screen truecolor repaint: per-cell fg/bg changes, like gradient art.
function fullFrame(t) {
    let s = '\x1b[H';
    for (let y = 1; y <= ROWS - 1; y++) {
        s += '\x1b[' + y + ';1H';
        for (let x = 0; x < COLS; x++) {
            const r = (x * 3 + t) & 255, g = (y * 9 + t * 2) & 255, b = (x + y + t * 3) & 255;
            s += '\x1b[38;2;' + r + ';' + g + ';' + b + 'm\x1b[48;2;' + (255 - r) + ';' + (g >> 1) + ';' + (b >> 2) + 'm' + BLOCKS[rnd(BLOCKS.length)];
        }
    }
    s += '\x1b[0m';
    return s;
}

// Partial update: a status line, some scrolled text, an occasional bell.
function partial(t) {
    let s = '\x1b[' + ROWS + ';1H\x1b[0;1;37;44m ' + new Date().toISOString() + ' tick ' + t + ' \x1b[K\x1b[0m';
    s += '\x1b[' + (1 + rnd(ROWS - 2)) + ';' + (1 + rnd(COLS - 20)) + 'H\x1b[38;2;' + rnd(256) + ';' + rnd(256) + ';' + rnd(256) + 'm*** chat line ' + t + ' ***\x1b[0m';
    if (t % 40 === 0) s += '\x07';
    // Some scrolling output in a region to exercise ScrollUp + scrollback
    if (t % 10 === 0) s += '\x1b[' + ROWS + ';1H\r\nscroll ' + t + ' ' + 'x'.repeat(40) + '\r\n';
    return s;
}

let totalSent = 0, clients = 0;
const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
    const proto = protos.indexOf('binary') >= 0 ? 'binary' : protos[0];
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n' + (proto ? 'Sec-WebSocket-Protocol: ' + proto + '\r\n' : '') + '\r\n');
    clients++;
    console.log('[ws] client connected, proto=' + proto + ' path=' + req.url);
    socket.on('data', () => { /* drain client frames (telnet negotiation, keys) */ });
    socket.on('error', () => {});
    let t = 0, alive = true;
    socket.on('close', () => { alive = false; clients--; console.log('[ws] client closed'); });
    // Pace: every 100 ms send RATE/10 bytes worth of content.
    const perTick = Math.max(1, Math.floor(RATE / 10));
    let backlog = '';
    const timer = setInterval(() => {
        if (!alive) { clearInterval(timer); return; }
        while (Buffer.byteLength(backlog, 'latin1') < perTick) {
            t++;
            backlog += (t % 20 === 0) ? fullFrame(t) : partial(t);
        }
        const out = Buffer.from(backlog.slice(0, perTick), 'latin1');
        backlog = backlog.slice(perTick);
        if (socket.writable) { socket.write(frame(out)); totalSent += out.length; }
    }, 100);
});
server.listen(PORT, '127.0.0.1', () => console.log('[ws] listening on 127.0.0.1:' + PORT + ' rate=' + RATE + ' B/s'));
setInterval(() => console.log('[ws] clients=' + clients + ' totalSent=' + totalSent), 30000);
