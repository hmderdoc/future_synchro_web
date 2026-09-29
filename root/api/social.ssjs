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
 * GET  ?call=person&name=<nick>&network=local|mrc|ddial|irc   who a chat handle is (menu data)
 * GET  ?call=ignored                             my ignore list (shared with the terminal shell)
 * GET  ?call=forum&user=..[&page=N][&per=N][&ansi=1]  a page of their forum posts (alias + linked handles, every
 *                                                sub you may read; [ANSI]-tagged posts left out unless ansi=1)
 *                                                sub you may read) with the web thread key + forum icon
 * GET  ?call=forum-post&sub=<code>&number=N      one post rendered as forum HTML (the expand control)
 * GET  ?call=whoami                              { number, alias, csrf_token }
 *
 * POST (x-csrf-token header; JSON body)
 *   ?call=friend      { user, action: request|accept|decline|cancel|unfriend }
 *   ?call=post        { user, body }            update on my page, wall post elsewhere
 *   ?call=delete-post { user, id }
 *   ?call=save-profile { headline?, mood?, song?, featured?, wallPolicy?, theme? }
 *   ?call=upload-ansi { name, data (base64 CP437 ANSI), desc? }  -> my ANSI dir
 *   ?call=ignore      { name, network, on }
 *   ?call=nsfw        { dir, name, on: true|false|null }   (moderators: sysop or nsfw.json moderatorArs)
 *   ?call=placeholder { name, action: set|clear|link|unlink|notlocal|unnotlocal, collection?, index?, main? }  (sysop)
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

} else if (call === 'forum') {
    var fu = targetUser(request.get_param('user'));
    if (!fu) fail('No such user', '404 Not Found');
    else {
        var fpage = parseInt(String(request.get_param('page') || '0'), 10) || 0;
        var fper = parseInt(String(request.get_param('per') || '10'), 10) || 10;
        /* &ansi=1 includes posts tagged [ANSI] (ads, art drops); left out by default. */
        var fansi = String(request.get_param('ansi') || '0') === '1';
        var activity = Social.forumActivity(fu, me(), { page: fpage, per: fper, hideAnsi: !fansi });
        /* The forum page keys threads the way lib/forum.js groups them
           (subject merging, thread_id, thread_back), so the deep link asks
           the same code which thread each message landed in. One scan per
           sub on this page, cached for the request. */
        load(settings.web_lib + 'forum.js');
        var threadKeys = {};
        function threadKeyFor(sub, number) {
            var t, k, threads;
            if (!threadKeys.hasOwnProperty(sub)) {
                threadKeys[sub] = {};
                try {
                    threads = getMessageThreads(sub, settings.max_messages);
                    for (t in threads.thread) {
                        if (!threads.thread.hasOwnProperty(t)) continue;
                        for (k in threads.thread[t].messages) if (threads.thread[t].messages.hasOwnProperty(k)) threadKeys[sub][k] = threads.thread[t].id;
                    }
                } catch (_te) { }
            }
            return threadKeys[sub][String(number)] || 0;
        }
        var iconCache = {};
        for (var fi = 0; fi < activity.items.length; fi++) {
            var fit = activity.items[fi];
            fit.threadKey = threadKeyFor(fit.sub, fit.number);
            if (!iconCache.hasOwnProperty(fit.sub)) {
                try { iconCache[fit.sub] = _forumResolveIcon(fit.sub, fit.group) || ''; } catch (_ie) { iconCache[fit.sub] = ''; }
            }
            fit.icon = iconCache[fit.sub];
        }
        reply({ ok: true, forum: activity });
    }

} else if (call === 'forum-post') {
    var fpost = Social.forumPost(String(request.get_param('sub') || ''), parseInt(String(request.get_param('number') || '0'), 10) || 0);
    if (!fpost) fail('No such post', '404 Not Found');
    else {
        load(settings.web_lib + 'forum.js');
        var html = '';
        try {
            var pmb = new MsgBase(fpost.sub);
            if (pmb.open()) {
                var rawBody = pmb.get_msg_body(false, fpost.number) || '';
                pmb.close();
                html = formatMessage(rawBody, /\x1b\[/.test(rawBody));
            }
        } catch (_pe) { html = ''; }
        fpost.html = html;
        reply({ ok: true, post: fpost });
    }

} else if (call === 'render-ansi') {
    var path = Social.creationPath(request.get_param('dir'), request.get_param('name'));
    if (!path || !/\.(ans|asc|bin)$/i.test(path)) fail('No such file', '404 Not Found');
    else {
        var ansi_viewer = load({}, settings.web_lib + 'ansi-viewer.js');
        var rendered = ansi_viewer.render_file_html(path);
        reply({ ok: !!rendered.ok, html: rendered.ok ? rendered.html : '', error: rendered.ok ? '' : (rendered.message || 'render failed') });
    }

} else if (call === 'ansi-bin') {
    /* Cell grid of an ANSI creation for the browser's GraphicsConverter
       (the same path that draws avatars and game icons), so galleries get
       real thumbnails instead of a 100KB <pre> each. */
    var bpath = Social.creationPath(request.get_param('dir'), request.get_param('name'));
    if (!bpath || !/\.(ans|asc|bin)$/i.test(bpath)) fail('No such file', '404 Not Found');
    else {
        load('graphic.js');
        var Sauce = load({}, 'sauce_lib.js');
        var sauce = Sauce.read(bpath);
        var graphic;
        var MAX_ROWS = 400;
        try {
            if (sauce && sauce.cols && sauce.rows) graphic = new Graphic(sauce.cols, Math.min(sauce.rows, MAX_ROWS));
            else { graphic = new Graphic(80, 25); graphic.auto_extend = true; }
            if (/\.bin$/i.test(bpath) && !(sauce && sauce.cols && sauce.rows)) throw new Error('BIN without SAUCE');
            if (!graphic.load(bpath)) throw new Error('load failed');
            var rows = Math.min(graphic.height, MAX_ROWS);
            var bin = graphic.BIN.substr(0, graphic.width * rows * 2);
            http_reply.header['Cache-Control'] = 'public, max-age=3600';
            reply({ ok: true, cols: graphic.width, rows: rows, bin: base64_encode(bin) });
        } catch (bErr) {
            fail('Could not render: ' + bErr, '500 Internal Server Error');
        }
    }

} else if (call === 'image') {
    /* Serve a picture from the creation areas inline (download-file forces
       an attachment). Only files with an image extension, only creation dirs. */
    var ipath = Social.creationPath(request.get_param('dir'), request.get_param('name'));
    var ext = ipath ? String(file_getext(ipath) || '').toLowerCase() : '';
    var MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    if (!ipath || !MIME[ext]) fail('No such image', '404 Not Found');
    else {
        var imf = new File(ipath);
        if (!imf.open('rb')) fail('Could not read', '500 Internal Server Error');
        else {
            var bytes = imf.read();
            imf.close();
            http_reply.header['Content-Type'] = MIME[ext];
            http_reply.header['Content-Disposition'] = 'inline';
            http_reply.header['Content-Length'] = bytes.length;
            http_reply.header['Cache-Control'] = 'public, max-age=86400';
            write(bytes);
        }
    }

} else if (call === 'person') {
    /* Who is this chat handle, for the avatar context menu: local account
       (through the sysop link map, so a DDial nick can open a profile),
       relation to me, ignore state, and the sysop override state. */
    var pname = String(request.get_param('name') || '').replace(/[\x00-\x1f]/g, '').substr(0, 60);
    var pnet = String(request.get_param('network') || '').toLowerCase();
    if (pnet !== 'mrc' && pnet !== 'ddial' && pnet !== 'irc') pnet = 'local';
    if (!pname.length) fail('Name required', '400 Bad Request');
    else {
        var pnum = /^\d+$/.test(pname) ? (Social.account(parseInt(pname, 10)) ? parseInt(pname, 10) : 0) : Social.resolveLocalUser(pname, pnet);
        if (/^\d+$/.test(pname) && pnum) pname = Social.aliasOf(pnum);
        var pacct = pnum ? Social.account(pnum) : null;
        var out = {
            ok: true, name: pname, network: pnet,
            userNumber: pacct ? pacct.number : 0, alias: pacct ? pacct.alias : '',
            self: !!(pacct && me() && pacct.number === me()),
            relation: pacct && me() ? Social.relation(me(), pacct.number) : 'none',
            ignored: me() ? Social.isIgnored(me(), pname, pnet) : false,
            sysop: !!user.is_sysop
        };
        if (user.is_sysop) {
            var pinfo = Social.placeholderInfo(pname);
            var realAvatar = false;
            try {
                if (pacct) { var alib = load({}, 'avatar_lib.js'); var av = alib.read_localuser(pacct.number); realAvatar = !!(av && av.data && !av.disabled); }
            } catch (_avErr) { realAvatar = false; }
            out.avatarKind = realAvatar ? 'real' : pinfo.hasPlaceholder ? 'placeholder' : 'none';
            out.placeholderSource = pinfo.placeholderSource;
            out.linkedTo = pinfo.linkedTo;
            out.notLocal = pinfo.notLocal;
        }
        reply(out);
    }

} else if (call === 'ignored') {
    if (isGuest()) fail('Login required', '401 Unauthorized');
    else reply({ ok: true, ignored: Social.ignoreList(me()) });

} else if (call === 'ignore') {
    if (writeGate()) {
        var ib = postJson() || {};
        var inet = String(ib.network || '').toLowerCase();
        if (inet !== 'mrc' && inet !== 'ddial' && inet !== 'irc' && inet !== '') inet = 'local';
        var iname = String(ib.name || '').replace(/[\x00-\x1f]/g, '').substr(0, 60);
        if (!iname.length) fail('Name required', '400 Bad Request');
        else if (iname.toLowerCase() === String(user.alias).toLowerCase()) fail('That would be you', '400 Bad Request');
        else reply(Social.setIgnored(me(), iname, inet, ib.on !== false));
    }

} else if (call === 'placeholder') {
    /* Sysop overrides, same three tools as the terminal person menu. A real
       local avatar is never replaced: the resolvers only use these to fill gaps. */
    if (writeGate()) {
        if (!user.is_sysop) fail('Sysop only', '403 Forbidden');
        else {
            var sb2 = postJson() || {};
            var sname = String(sb2.name || '').replace(/[\x00-\x1f]/g, '').substr(0, 60);
            var saction = String(sb2.action || '');
            var sok = false;
            if (!sname.length) fail('Name required', '400 Bad Request');
            else {
                if (saction === 'set') {
                    var coll = String(sb2.collection || '');
                    var idx = parseInt(String(sb2.index), 10);
                    var cpath = /^[A-Za-z0-9][A-Za-z0-9._-]*\.bin$/.test(coll) ? system.text_dir + 'avatars/' + coll : '';
                    var raster = '';
                    if (cpath && file_exists(cpath) && idx >= 0) {
                        var cf = new File(cpath);
                        if (cf.open('rb')) { cf.position = idx * 120; raster = cf.read(120) || ''; cf.close(); }
                    }
                    sok = raster.length === 120 ? Social.setPlaceholder(sname, base64_encode(raster), coll + '#' + (idx + 1)) : false;
                } else if (saction === 'clear') sok = Social.clearPlaceholder(sname);
                else if (saction === 'link') sok = Social.linkHandle(sname, String(sb2.main || ''));
                else if (saction === 'unlink') sok = Social.linkHandle(sname, '');
                else if (saction === 'notlocal') sok = Social.setNotLocal(sname, true, user.alias);
                else if (saction === 'unnotlocal') sok = Social.setNotLocal(sname, false, user.alias);
                else { fail('Unknown action', '400 Bad Request'); sok = null; }
                if (sok !== null) reply({ ok: !!sok, action: saction, info: Social.placeholderInfo(sname) });
            }
        }
    }

} else if (call === 'nsfw') {
    /* Moderators (sysop or the configured flag) tag or clear a creation. */
    if (writeGate()) {
        var nb = postJson() || {};
        if (!Social.canModerate()) fail('Moderators only', '403 Forbidden');
        else reply(Social.setNsfw(String(nb.dir || ''), String(nb.name || ''), nb.on === null ? null : nb.on !== false, user.alias));
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
