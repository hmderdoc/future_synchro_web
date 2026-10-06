/* push.ssjs - native push devices for the signed-in user
 * (mods/load/push_lib.js; mods/push/push_daemon.js sends).
 *
 * GET  ?call=key                          { ok, publicKey }
 * GET  ?call=status&endpoint=...          { ok, enabled }   this device on?
 * GET  ?call=icon&avatar=<base64 10x6>    { ok, url }       that avatar as a PNG
 *                                          notification icon (the push daemon's
 *                                          files, mods/push/avatar_png.js)
 * POST (x-csrf-token header; JSON body)
 *   ?call=subscribe    { subscription }   PushSubscription.toJSON()
 *   ?call=unsubscribe  { endpoint }
 *   ?call=test                            a test push to every device
 */

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
var request = require({}, settings.web_lib + 'request.js', 'request');
load(system.mods_dir + 'load/push_lib.js');

http_reply.header['Content-Type'] = 'application/json; charset=utf-8';
http_reply.header['Cache-Control'] = 'no-store';

function reply(obj) { write(JSON.stringify(obj)); }
function fail(message, status) {
    if (status) http_reply.status = status;
    reply({ ok: false, error: String(message) });
}

var call = request.has_param('call') ? String(request.get_param('call')).toLowerCase() : '';

function body() {
    try { return JSON.parse(http_request.post_data || '{}'); } catch (e) { return null; }
}

if (user.number < 1 || user.alias === settings.guest) {
    fail('Login required', '401 Unauthorized');

} else if (call === 'key') {
    var key = Push.publicKey();
    if (key) reply({ ok: true, publicKey: key });
    else fail('Push is not set up on this system', '503 Service Unavailable');

} else if (call === 'status') {
    reply({ ok: true, enabled: Push.hasDevice(user.number, String(request.get_param('endpoint') || '')) });

} else if (call === 'icon') {
    /* A served PNG, not a data: URL: some OS notification centres show only
       real image URLs. Drawn once per avatar by the push daemon's renderer. */
    var b64 = String(request.get_param('avatar') || '');
    if (!b64.length || b64.length > 400 || !/^[A-Za-z0-9+\/=]+$/.test(b64)) {
        fail('Bad avatar', '400 Bad Request');
    } else {
        var iconName = sha1_calc(base64_decode(b64), true).substr(0, 20) + '.png';
        var iconFile = settings.web_root + 'push-avatars/' + iconName;
        if (!file_exists(iconFile)) {
            var nodes = ['/home/sbbs/.nvm/versions/node/v22.20.0/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
            var nodeBin = 'node';
            for (var ni = 0; ni < nodes.length; ni++) { if (file_exists(nodes[ni])) { nodeBin = nodes[ni]; break; } }
            system.exec(nodeBin + ' ' + system.mods_dir + 'push/avatar_icon.js ' + b64);
        }
        if (file_exists(iconFile)) {
            http_reply.header['Cache-Control'] = 'private, max-age=86400';
            reply({ ok: true, url: './push-avatars/' + iconName });
        } else fail('Could not draw that avatar', '500 Internal Server Error');
    }

} else if (http_request.method !== 'POST') {
    fail('POST required', '405 Method Not Allowed');

} else if (!validateCsrfToken()) {
    fail('Invalid CSRF token', '403 Forbidden');

} else if (call === 'subscribe') {
    var sub = body();
    if (sub && Push.subscribe(user.number, sub.subscription, http_request.header['user-agent']))
        reply({ ok: true });
    else fail('Bad subscription', '400 Bad Request');

} else if (call === 'unsubscribe') {
    var un = body();
    if (un && typeof un.endpoint === 'string') reply({ ok: Push.unsubscribe(user.number, un.endpoint) });
    else fail('Bad request', '400 Bad Request');

} else if (call === 'test') {
    reply({ ok: Push.enqueue(user.number, 'test', {
        title: system.name, body: 'Push notifications are working on this device.', url: './?page=010-settings.xjs', tag: 'test'
    }) });

} else {
    fail('Unknown call', '400 Bad Request');
}
