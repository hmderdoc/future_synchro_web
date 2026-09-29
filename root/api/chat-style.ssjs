/* chat-style.ssjs - a member's chat handle style (per-letter colours + tag)
 *
 * Thin JSON layer over the shared store mods/load/chat_style_lib.js: the
 * same record the terminal shell's Chat Settings edits, so a colour picked
 * here paints the name in avatar chat, on DDial, in the MRC alias and on the
 * profile page, terminal and web alike.
 *
 * GET  ?call=get                 { ok, alias, style: { colors[], tag }, presets }
 * POST ?call=save                JSON { colors: [...], tag: { text, fg, bg } }   (x-csrf-token header)
 * POST ?call=clear
 */
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
var request = require({}, settings.web_lib + 'request.js', 'request');
load(system.mods_dir + 'load/chat_style_lib.js');

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
function writeGate() {
    if (isGuest()) { fail('Login required', '401 Unauthorized'); return false; }
    if (http_request.method !== 'POST') { fail('POST required', '405 Method Not Allowed'); return false; }
    if (!validateCsrfToken()) { fail('Invalid CSRF token', '403 Forbidden'); return false; }
    return true;
}

var call = request.has_param('call') ? String(request.get_param('call')).toLowerCase() : '';

if (call === 'get') {
    if (isGuest()) { fail('Login required', '401 Unauthorized'); }
    else {
        reply({
            ok: true,
            alias: user.alias,
            style: ChatStyle.get(user.number),
            maxTag: ChatStyle.MAX_TAG
        });
    }
} else if (call === 'save') {
    if (writeGate()) {
        var body = postJson();
        if (!body) { fail('Bad JSON', '400 Bad Request'); }
        else {
            var result = ChatStyle.set(user.number, { colors: body.colors, tag: body.tag }, user.number);
            if (!result.ok) fail(result.reason || 'Could not save');
            else reply({ ok: true, style: result.style });
        }
    }
} else if (call === 'clear') {
    if (writeGate()) {
        var cleared = ChatStyle.set(user.number, {}, user.number);
        if (!cleared.ok) fail(cleared.reason || 'Could not save');
        else reply({ ok: true, style: cleared.style });
    }
} else {
    fail('Unknown call', '404 Not Found');
}
