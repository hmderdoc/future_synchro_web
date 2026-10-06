// leaderboards.ssjs - rankings for the home page's Forums, Posters, Rico and
// Suave cards.
//
// GET ?call=forums  -> [{ code, name, group, posts, icon, group_icon }]
//                      most posts in the last 30 days first
// GET ?call=posters -> [{ number, alias, posts }]   most forum posts first
// GET ?call=rico    -> [{ number, alias, coins }]   most BBScoin first
// GET ?call=suave   -> [{ number, alias, friends }] most friends first
//
// The counting happens ahead of time: the HM_LEADERBOARDS timed event
// (mods/hm_leaderboards.js) rebuilds every board into data/leaderboards/
// every few minutes, and this only reads them (mods/load/leaderboards_lib.js
// rebuilds one here only if it is missing or the event has stopped).
// Forums and posters are then cut down to the subs this reader may read, so
// counts match what they would see on a profile.

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(system.mods_dir + 'load/leaderboards_lib.js');

var LIMIT = 50;
var FORUM_LIMIT = 30;

function param(name, fallback) {
    var v = http_request.query[name];
    return v && v.length ? String(v[0]) : fallback;
}

function reply(obj) {
    http_reply.header['Content-Type'] = 'application/json';
    http_reply.header['Cache-Control'] = 'no-store';
    write(JSON.stringify(obj));
}

function readable(code) {
    var s = msg_area.sub[code];
    try { return !!(s && s.can_read); } catch (e) { return false; }
}

function forums() {
    var counts = Leaderboards.get('forums', settings.guest) || {}, rows = [];
    for (var code in counts) {
        if (counts.hasOwnProperty(code) && readable(code)) rows.push({ code: code, posts: counts[code] });
    }
    rows.sort(function (a, b) { return b.posts - a.posts || (a.code < b.code ? -1 : 1); });
    rows = rows.slice(0, FORUM_LIMIT);
    /* Icons: the sub's own and its network's (group's), as the forum shows them. */
    load(settings.web_lib + 'forum.js');
    return rows.map(function (r) {
        var s = msg_area.sub[r.code], g = msg_area.grp_list[s.grp_index];
        return {
            code: r.code, name: s.name, group: s.grp_name, posts: r.posts,
            icon: _forumResolveIcon(r.code, 'boards') || null,
            group_icon: g ? _forumResolveIcon(g.name, 'group') || null : null
        };
    });
}

function posters() {
    var bySub = Leaderboards.get('posters', settings.guest) || {}, totals = {};
    for (var code in bySub) {
        if (!bySub.hasOwnProperty(code) || !readable(code)) continue;
        for (var n in bySub[code]) {
            if (bySub[code].hasOwnProperty(n)) totals[n] = (totals[n] || 0) + bySub[code][n];
        }
    }
    var out = [];
    for (var k in totals) {
        var num = parseInt(k, 10), alias = Leaderboards.listable(num, settings.guest);
        if (alias) out.push({ number: num, alias: alias, posts: totals[k] });
    }
    out.sort(function (a, b) { return b.posts - a.posts || a.number - b.number; });
    return out.slice(0, LIMIT);
}

var call = param('call', '');
if (call === 'forums') reply(forums());
else if (call === 'posters') reply(posters());
else if (call === 'rico' || call === 'suave') reply(Leaderboards.get(call, settings.guest) || []);
else reply({ error: 'unknown call' });
