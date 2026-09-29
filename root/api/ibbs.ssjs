/* ibbs.ssjs - callers on the other BBSes we exchange presence with
 *
 * The same InterBBS instant-message network the ibbs-online door and the
 * stock sbbsimsg.js use (exec/load/sbbsimsg_lib.js: ctrl/sbbsimsg.lst is the
 * list of systems, an "active users" request goes out over UDP and each
 * system answers with who is on). Local callers are left out here: the
 * Who's Online card already shows them.
 *
 * GET  ?call=online          { ok, at, users: [{ name, bbs, host, action, avatar? }] }
 *                            answers are cached for CACHE_SECONDS (a fresh
 *                            sweep waits up to 2 s for the systems to reply)
 * POST ?call=telegram        JSON { user, host, message }  (x-csrf-token; login required)
 *                            -> an InterBBS telegram over MSP to that system
 */
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
var request = require({}, settings.web_lib + 'request.js', 'request');

var CACHE_SECONDS = 45;
var SWEEP_SECONDS = 2;
var CACHE_PATH = system.data_dir + 'ibbs-online-cache.json';
var MAX_MESSAGE = 400;

http_reply.header['Content-Type'] = 'application/json; charset=utf-8';
http_reply.header['Cache-Control'] = 'no-store';

function reply(obj) { write(JSON.stringify(obj)); }
function fail(message, status) {
    if (status) http_reply.status = status;
    reply({ ok: false, error: String(message) });
}
function isGuest() { return user.number < 1 || user.alias === settings.guest; }
function postJson() {
    try { return JSON.parse(http_request.post_data || '{}'); } catch (e) { return null; }
}
function trim(v) { return String(v === undefined || v === null ? '' : v).replace(/^\s+|\s+$/g, ''); }

function readCache() {
    var f, raw, data;
    if (!file_exists(CACHE_PATH)) return null;
    f = new File(CACHE_PATH);
    if (!f.open('r')) return null;
    try { raw = f.read() || ''; } finally { f.close(); }
    try { data = JSON.parse(raw); } catch (e) { return null; }
    return data && typeof data === 'object' && data.at ? data : null;
}

function writeCache(data) {
    var f = new File(CACHE_PATH);
    if (!f.open('w+')) return;
    try { f.write(JSON.stringify(data)); } finally { f.close(); }
}

/* What the other system says a caller is doing, in a few words. */
function remoteAction(usr) {
    if (usr && usr.xtrn) return String(usr.xtrn);
    var a = String((usr && usr.action) || '');
    return a.replace(/^\s*running external program\s+#\d+\s*$/i, 'a door')
        .replace(/^\s*running external program\s+/i, '')
        .replace(/^\s*at external program menu\s*$/i, 'xtrn menu');
}

/* Their avatar as the door reads it (avatar_lib by name + net address, or the
   BBS name for the DoveNet-delivered sets): base64 BIN, '' when none. */
function remoteAvatar(name, host, bbs) {
    var lib, obj;
    try {
        lib = load({}, 'avatar_lib.js');
        obj = lib.read(0, name, host, bbs || undefined);
        if (obj && lib.is_enabled(obj) && obj.data) return String(obj.data);
    } catch (e) { }
    return '';
}

/* One sweep of the network: who is on each remote system right now. */
function sweep() {
    var lib = load({}, 'sbbsimsg_lib.js');
    var users = [];
    var begin, message, ip, sys, i, usr, localHost;
    if (!lib.read_sys_list()) return { at: time(), users: users, systems: 0 };
    try { lib.request_active_users(); } catch (e) { }
    if (lib.sock) {
        begin = system.timer;
        while (system.timer - begin < SWEEP_SECONDS) {
            if (!lib.sock.poll(0.25)) continue;
            message = lib.receive_active_users();
            if (message) lib.parse_active_users(message);
        }
    }
    localHost = String(system.inetaddr || system.host_name || '').toLowerCase();
    var systems = 0;
    for (ip in lib.sys_list) {
        if (!lib.sys_list.hasOwnProperty(ip)) continue;
        sys = lib.sys_list[ip];
        systems++;
        if (!sys.users || !sys.users.length) continue;
        if (String(sys.host || '').toLowerCase() === localHost) continue;
        var seen = {};
        for (i = 0; i < sys.users.length; i++) {
            usr = sys.users[i];
            if (seen[trim(usr.name).toLowerCase()]) continue;   /* on two nodes: one row */
            seen[trim(usr.name).toLowerCase()] = true;
            users.push({
                name: trim(usr.name) || '?',
                bbs: trim(sys.name) || trim(sys.host),
                host: trim(sys.host),
                action: remoteAction(usr),
                location: trim(usr.location || sys.location || ''),
                avatar: remoteAvatar(trim(usr.name), trim(sys.host), trim(sys.name))
            });
        }
    }
    users.sort(function (a, b) {
        var c = a.bbs.toLowerCase().localeCompare(b.bbs.toLowerCase());
        return c !== 0 ? c : a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return { at: time(), users: users, systems: systems };
}

var call = request.has_param('call') ? String(request.get_param('call')).toLowerCase() : '';

if (call === 'online') {
    var cached = readCache();
    var data = cached && time() - cached.at < CACHE_SECONDS ? cached : null;
    if (!data) {
        try { data = sweep(); } catch (e) { data = null; log(LOG_WARNING, 'ibbs.ssjs sweep failed: ' + e); }
        if (data) writeCache(data);
        else data = cached || { at: time(), users: [], systems: 0 };
    }
    reply({ ok: true, at: data.at, systems: data.systems || 0, users: data.users || [] });
} else if (call === 'telegram') {
    if (isGuest()) fail('Login required', '401 Unauthorized');
    else if (http_request.method !== 'POST') fail('POST required', '405 Method Not Allowed');
    else if (!validateCsrfToken()) fail('Invalid CSRF token', '403 Forbidden');
    else {
        var body = postJson();
        var to = body ? trim(body.user) : '';
        var host = body ? trim(body.host).toLowerCase() : '';
        var text = body ? trim(body.message).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').substr(0, MAX_MESSAGE) : '';
        if (!to.length || !host.length) fail('user and host required', '400 Bad Request');
        else if (!/^[a-z0-9.\-]+$/i.test(host) || host.indexOf('..') !== -1) fail('bad host', '400 Bad Request');
        else if (!text.length) fail('empty message', '400 Bad Request');
        else {
            var lib = load({}, 'sbbsimsg_lib.js');
            var result;
            try { result = lib.send_msg(to + '@' + host, text, user.alias); } catch (e) { result = String(e); }
            if (result === true) reply({ ok: true });
            else fail(result || 'send failed');
        }
    }
} else {
    fail('Unknown call', '404 Not Found');
}
