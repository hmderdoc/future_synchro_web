/* notifications.ssjs - your notifications ("X replied to your message ...")
 *
 * Thin JSON layer over mods/load/notify_lib.js (the terminal shell reads the
 * same data/notify/ files), so reading one here marks it read there too.
 *
 * GET  ?call=list[&filter=unread|read|all][&offset=N][&limit=N]
 *          { ok, unread, total, entries: [ entry + href + images ] }
 *          images: what the entry's thumbnail cycles through, each
 *          { kind: 'network'|'board'|'type'|'avatar', bin: base64, cols, rows }:
 *          a forum post's network and board icons and the poster's avatar,
 *          a mail's mailbox icon and the sender's avatar (any that exist).
 * GET  ?call=unread                     { ok, unread }
 * GET  ?call=prefs                      { ok, prefs: { toast: { kind: bool } } }
 * POST (x-csrf-token header; JSON body)
 *   ?call=mark-read  { ids: [id, ...] } or { all: true }   -> { ok, unread }
 *   ?call=set-prefs  { toast: { kind: bool, ... } }          -> { ok, prefs }
 */

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
var request = require({}, settings.web_lib + 'request.js', 'request');
load(system.mods_dir + 'load/notify_lib.js');
load(settings.web_lib + 'avatar-profiles.js');

http_reply.header['Content-Type'] = 'application/json; charset=utf-8';
http_reply.header['Cache-Control'] = 'no-store';

function reply(obj) { write(JSON.stringify(obj)); }
function fail(message, status) {
    if (status) http_reply.status = status;
    reply({ ok: false, error: String(message) });
}

/* Where an entry opens on the site; '' if this user can't read it now. */
function href(e) {
    if (e.type === 'mail') return './?page=000-mail.xjs&n=' + e.num;
    var s = e.sub && msg_area.sub[e.sub];
    if (!s || !s.can_read) return '';
    return './?page=002-forum.xjs&sub=' + encodeURIComponent(e.sub)
        + '&thread=' + e.thread + '#' + e.num;
}

/* Thumbnail images, cached for the request (a page repeats boards and people). */
var _iconsLoaded = false, _avatarLib = null, _avatarCache = {}, _typeIcons = {};
function forumIcon(name, fallback) {
    if (!_iconsLoaded) { load(settings.web_lib + 'forum.js'); _iconsLoaded = true; }
    return _forumResolveIcon(name, fallback) || '';
}
function personAvatar(e) {
    if (!e.actor || e.actor === 'Anonymous') return '';
    var key = e.actor.toLowerCase() + '|' + (e.actor_ext || 0) + '|' + (e.actor_net || '');
    if (_avatarCache.hasOwnProperty(key)) return _avatarCache[key];
    var data = '';
    try { data = AvatarProfiles.avatarData(e.actor, e.actor_ext || 0, ''); } catch (_p) { data = ''; }
    if (!data) {
        /* Their own art from the networks, else the identicon the site draws. */
        try {
            if (!_avatarLib) _avatarLib = load({}, 'avatar_lib.js');
            var a = _avatarLib.read(0, e.actor, e.actor_net || undefined);
            if (a && a.data && !a.disabled) data = String(a.data);
        } catch (_a) { data = ''; }
    }
    return (_avatarCache[key] = data);
}
function typeIcon(name) {
    if (!_typeIcons.hasOwnProperty(name)) _typeIcons[name] = forumIcon(name, null);
    return _typeIcons[name];
}
function thumbImages(e) {
    var out = [];
    function add(kind, bin, cols, rows) { if (bin) out.push({ kind: kind, bin: bin, cols: cols, rows: rows }); }
    if (e.type === 'mail') {
        add('type', typeIcon('mailbox'), 12, 6);
    } else {
        var s = e.sub && msg_area.sub[e.sub];
        var g = s ? msg_area.grp_list[s.grp_index] : null;
        if (g) add('network', forumIcon(g.name, 'group'), 12, 6);
        if (s) add('board', forumIcon(e.sub, 'boards'), 12, 6);
    }
    add('avatar', personAvatar(e), 10, 6);
    return out;
}

var call = request.has_param('call') ? String(request.get_param('call')).toLowerCase() : '';

if (user.number < 1 || user.alias === settings.guest) {
    fail('Login required', '401 Unauthorized');

} else if (call === 'list') {
    var page = Notify.list(user.number, {
        filter: request.has_param('filter') ? String(request.get_param('filter')) : 'all',
        offset: parseInt(request.get_param('offset'), 10) || 0,
        limit: parseInt(request.get_param('limit'), 10) || 30
    });
    page.entries.forEach(function (e) { e.href = href(e); e.images = thumbImages(e); });
    page.ok = true;
    reply(page);

} else if (call === 'unread') {
    reply({ ok: true, unread: Notify.unread(user.number) });

} else if (call === 'prefs') {
    reply({ ok: true, prefs: Notify.prefs(user.number) });

} else if (call === 'set-prefs') {
    var patch;
    try { patch = JSON.parse(http_request.post_data || '{}'); } catch (e) { patch = null; }
    if (http_request.method !== 'POST') fail('POST required', '405 Method Not Allowed');
    else if (!validateCsrfToken()) fail('Invalid CSRF token', '403 Forbidden');
    else if (!patch) fail('Bad request', '400 Bad Request');
    else reply({ ok: true, prefs: Notify.setPrefs(user.number, patch) });

} else if (call === 'mark-read') {
    if (http_request.method !== 'POST') fail('POST required', '405 Method Not Allowed');
    else if (!validateCsrfToken()) fail('Invalid CSRF token', '403 Forbidden');
    else {
        var body;
        try { body = JSON.parse(http_request.post_data || '{}'); } catch (e) { body = null; }
        if (!body) fail('Bad request', '400 Bad Request');
        else {
            var ids = body.all ? 'all' : (Array.isArray(body.ids) ? body.ids.map(String) : []);
            reply({ ok: true, unread: Notify.markRead(user.number, ids) });
        }
    }

} else {
    fail('Unknown call', '400 Bad Request');
}
