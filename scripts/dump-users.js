// dump-users.js - Synchronet jsexec script
// Writes user records (number, alias, ip, location) as JSON
// Usage: jsexec dump-users.js [output-path]
load('sbbsdefs.js');
var outPath = argv[0] || system.temp_dir + 'users-raw.json';
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
var f = new File(outPath);
if (f.open('w')) {
    f.write(JSON.stringify(out));
    f.close();
    print('Wrote ' + out.length + ' users to ' + outPath);
} else {
    print('ERROR: cannot write ' + outPath);
}
