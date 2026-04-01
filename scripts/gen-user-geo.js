#!/usr/bin/env node
'use strict';
const geoip = require('geoip-lite');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'root', 'api', 'data');
const OUT_FILE = path.join(OUT_DIR, 'user-geo.json');
const INPUT_FILE = process.argv[2] || path.join(OUT_DIR, 'users-raw.json');

let users;
try {
    users = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
} catch (err) {
    console.error('[gen-user-geo] Cannot read input:', INPUT_FILE, err.message);
    process.exit(1);
}

const results = [];
const seen = {};

for (const u of users) {
    if (seen[u.n]) continue;
    seen[u.n] = true;
    if (u.ip.startsWith('127.') || u.ip.startsWith('10.') ||
        u.ip.startsWith('192.168.') || u.ip === '0.0.0.0') continue;
    const geo = geoip.lookup(u.ip);
    if (!geo || !geo.ll || !geo.ll[0]) continue;
    const jitter = () => (Math.random() - 0.5) * 0.8;
    results.push({
        number: u.n,
        alias: u.a,
        location: u.loc,
        country: geo.country || '',
        region: geo.region || '',
        lat: +(geo.ll[0] + jitter()).toFixed(3),
        lon: +(geo.ll[1] + jitter()).toFixed(3),
    });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(results));
console.log('[gen-user-geo] ' + results.length + '/' + users.length + ' geolocated -> ' + OUT_FILE);
