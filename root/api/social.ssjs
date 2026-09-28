/* social.ssjs - friends, profiles, walls and updates for the website
 *
 * Thin JSON layer over the shared store mods/load/social_lib.js (the terminal
 * shell uses the same file), so a friend made here is a friend there.
 *
 * GET  ?call=profile&user=<alias|number>      summary (see Social.summary)
 * GET  ?call=feed&user=..[&kind=wall|update][&limit=N]
 * GET  ?call=creations&user=..[&kind=track|ansi|image|text|art]
 * GET  ?call=render-ansi&dir=<code>&name=<file> HTML for one ANSI creation
 * GET  ?call=requests                            my incoming / outgoing requests
 * GET  ?call=whoami                              { number, alias, csrf_token }
 *
 * POST (x-csrf-token header; JSON body)
 *   ?call=friend      { user, action: request|accept|decline|cancel|unfriend }
 *   ?call=post        { user, body }            update on my page, wall post elsewhere
 *   ?call=delete-post { user, id }
 *   ?call=save-profile { headline?, mood?, song?, featured?, wallPolicy?, theme? }
 *   ?call=upload-ansi { name, data (base64 CP437 ANSI), desc? }  -> my ANSI dir
 *
 * Guests can read profiles of members only as far as the page allows (the
 * page itself is member-gated in webctrl.ini); every write needs a login.
 */

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
var request = require({}, settings.web_lib + 'request.js', 'request');
load(system.mods_dir + 'load/social_lib.js');

http_reply.header['Content-Type'] = 'application/json; charset=utf-8';
http_reply.header['Cache-Control'] = 'no-store';

function reply(obj) { write(JSON.stringify(obj)); }
function fail(message, status) {
    if (status) http_reply.status = status;
    reply({ ok: false, error: String(message) });
}
function isGuest() { return user.number < 1 || user.alias === settings.guest; }
function me() { return isGuest() ? 0 : user.number; }

function postJson() {
    try { return JSON.parse(http_request.post_data || '{}'); } catch (e) { return null; }
}

/* ?user= may be an alias or a number; default = me. */
function targetUser(raw) {
    var value = String(raw === undefined || raw === null ? '' : raw).replace(/^\s+|\s+$/g, '');
    var n;
    if (!value.length) return me();
    if (/^\d+$/.test(value)) { n = parseInt(value, 10); return Social.account(n) ? n : 0; }
    return Social.localUserByAlias(value);
}

function writeGate() {
    if (isGuest()) { fail('Login required', '401 Unauthorized'); return false; }
    if (http_request.method !== 'POST') { fail('POST required', '405 Method Not Allowed'); return false; }
    if (!validateCsrfToken()) { fail('Invalid CSRF token', '403 Forbidden'); return false; }
    return true;
}

var call = request.has_param('call') ? String(request.get_param('call')).toLowerCase() : '';

if (call === 'whoami') {
    reply({ ok: true, number: me(), alias: isGuest() ? '' : user.alias, csrf_token: isGuest() ? '' : (getCsrfToken() || '') });

} else if (call === 'profile') {
    var pn = targetUser(request.get_param('user'));
    var summary = pn ? Social.summary(pn, me()) : null;
    if (!summary) fail('No such user', '404 Not Found');
    else reply({ ok: true, profile: summary });

} else if (call === 'feed') {
    var fn = targetUser(request.get_param('user'));
    if (!fn) fail('No such user', '404 Not Found');
    else {
        var kind = String(request.get_param('kind') || '');
        var limit = parseInt(String(request.get_param('limit') || '0'), 10) || 0;
        reply({ ok: true, posts: Social.feed(fn, { kind: kind === 'wall' || kind === 'update' ? kind : '', limit: limit }) });
    }

} else if (call === 'creations') {
    var cn = targetUser(request.get_param('user'));
    if (!cn) fail('No such user', '404 Not Found');
    else {
        var ck = String(request.get_param('kind') || '');
        var list = Social.creations(cn, { kind: ck.length ? ck : undefined });
        // Never hand out disk paths.
        for (var i = 0; i < list.length; i++) delete list[i].path;
        reply({ ok: true, creations: list });
    }

} else if (call === 'render-ansi') {
    var path = Social.creationPath(request.get_param('dir'), request.get_param('name'));
    if (!path || !/\.(ans|asc|bin)$/i.test(path)) fail('No such file', '404 Not Found');
    else {
        var ansi_viewer = load({}, settings.web_lib + 'ansi-viewer.js');
        var rendered = ansi_viewer.render_file_html(path);
        reply({ ok: !!rendered.ok, html: rendered.ok ? rendered.html : '', error: rendered.ok ? '' : (rendered.message || 'render failed') });
    }

} else if (call === 'requests') {
    if (isGuest()) fail('Login required', '401 Unauthorized');
    else reply({ ok: true, incoming: Social.incomingRequests(me()), outgoing: Social.outgoingRequests(me()) });

} else if (call === 'friend') {
    if (writeGate()) {
        var fb = postJson() || {};
        var other = targetUser(fb.user);
        var action = String(fb.action || 'request');
        var result;
        if (!other) fail('No such user', '404 Not Found');
        else {
            if (action === 'accept') result = Social.acceptRequest(me(), other);
            else if (action === 'decline') result = Social.declineRequest(me(), other);
            else if (action === 'cancel') result = Social.cancelRequest(me(), other);
            else if (action === 'unfriend') result = Social.unfriend(me(), other);
            else result = Social.relation(me(), other) === 'incoming' ? Social.acceptRequest(me(), other) : Social.requestFriend(me(), other, fb.message || '');
            result.relation = Social.relation(me(), other);
            reply(result);
        }
    }

} else if (call === 'post') {
    if (writeGate()) {
        var pb = postJson() || {};
        var owner = targetUser(pb.user);
        if (!owner) fail('No such user', '404 Not Found');
        else reply(Social.post(owner, me(), pb.body || ''));
    }

} else if (call === 'delete-post') {
    if (writeGate()) {
        var db = postJson() || {};
        var downer = targetUser(db.user);
        if (!downer) fail('No such user', '404 Not Found');
        else reply(Social.deletePost(downer, String(db.id || ''), me()));
    }

} else if (call === 'save-profile') {
    if (writeGate()) {
        var sb = postJson();
        if (!sb || typeof sb !== 'object') fail('Bad request body', '400 Bad Request');
        else reply(Social.saveProfile(me(), sb, me()));
    }

} else if (call === 'upload-ansi') {
    if (writeGate()) {
        var ub = postJson() || {};
        var name = String(ub.name || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').substr(0, 60);
        var data = '';
        try { data = base64_decode(String(ub.data || '')) || ''; } catch (e) { data = ''; }
        var dirCode = 'originalcontent_ansi';
        var dir = file_area.dir[dirCode];
        if (!dir) fail('ANSI area is not configured', '500 Internal Server Error');
        else if (!name.length) fail('Name required', '400 Bad Request');
        else if (!data.length || data.length > 512 * 1024) fail('Empty or oversized artwork', '400 Bad Request');
        else {
            if (!/\.ans$/i.test(name)) name += '.ans';
            var full = dir.path + name;
            if (file_exists(full)) fail('A file with that name already exists; pick another', '409 Conflict');
            else {
                var f = new File(full);
                if (!f.open('wb')) fail('Could not write the file', '500 Internal Server Error');
                else {
                    try { f.write(data); } finally { f.close(); }
                    var fb2 = new FileBase(dirCode);
                    var added = false;
                    if (fb2.open()) {
                        try {
                            added = fb2.add({ name: name, from: user.alias, desc: String(ub.desc || '').substr(0, 58) || name.replace(/\.ans$/i, '').replace(/_/g, ' ') });
                        } catch (e2) { added = false; } finally { fb2.close(); }
                    }
                    if (!added) { try { file_remove(full); } catch (e3) { } fail('Could not add to the file base', '500 Internal Server Error'); }
                    else reply({ ok: true, dir: dirCode, name: name, vpath: dir.lib_name + '/' + dir.name + '/' + name });
                }
            }
        }
    }

} else {
    fail('Unknown call', '400 Bad Request');
}
