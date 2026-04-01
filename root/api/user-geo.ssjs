// user-geo.ssjs - Returns geolocated user data as JSON
// Regenerates cache on-demand when stale (> 1 hour)

var DATA_DIR = '/sbbs/webv4_custom/root/api/data/';
var RAW_FILE = DATA_DIR + 'users-raw.json';
var GEO_FILE = DATA_DIR + 'user-geo.json';
var GEN_SCRIPT = '/sbbs/webv4_custom/scripts/gen-user-geo.js';
var MAX_AGE  = 3600;

http_reply.header['Content-Type'] = 'application/json';
http_reply.header['Cache-Control'] = 'public, max-age=300';

function fileAge(path) {
    if (!file_exists(path)) return Infinity;
    return time() - file_date(path);
}

function regenerate() {
    load('sbbsdefs.js');
    var out = [];
    var u = new User(1);
    for (var i = 1; i <= system.lastuser; i++) {
        u.number = i;
        if (u.settings & USER_DELETED) continue;
        if (u.alias === 'Guest') continue;
        var ip = u.ip_address;
        if (ip === undefined || ip === null || ip === '' || ip === '0.0.0.0') continue;
        out.push({ n: i, a: u.alias, ip: ip, loc: u.location || '' });
    }
    u = undefined;

    if (!file_isdir(DATA_DIR)) {
        mkpath(DATA_DIR);
    }

    var f = new File(RAW_FILE);
    if (f.open('w')) {
        f.write(JSON.stringify(out));
        f.close();
    }
    system.exec('node ' + GEN_SCRIPT);
}

if (fileAge(GEO_FILE) > MAX_AGE) {
    regenerate();
}

var result = '[]';
if (file_exists(GEO_FILE)) {
    var f = new File(GEO_FILE);
    if (f.open('r')) {
        result = f.read();
        f.close();
    }
}
write(result);
