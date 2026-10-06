/* Sysop avatar profiles for the website.
 *
 * The terminal shell (mods/fshell_ts) lets a sysop pin a placeholder avatar to
 * any handle and link a person's handles across networks ("oxy" is
 * "oxyosbourne"). Both live in data/avatar_placeholders.json:
 *
 *   { entries: { "<handle>": { data: "<base64 10x6 raster>", ... } },
 *     links:   { "<alias>": "<main name>" } }          (keys lowercased)
 *
 * This is the website's reader for that file, so an assignment made on the
 * terminal shows up here too. Same rule as the shell
 * (src/notifications/avatar_placeholders.ts), in this order:
 *
 *   1. the linked main name's REAL avatar, if that name is a local account
 *   2. the person's own real avatar, if they are a local account
 *   3. a placeholder - their own, else their main name's
 *   4. the person's own art from the message nets, matched by NAME (avatar_lib
 *      keeps what DoveNet etc. deliver in data/qnet|fido/*.avatars.ini, one
 *      file per sending BBS; newest copy wins when a name has several)
 *   5. nothing (the page falls back to an identicon / initial)
 *
 * A real avatar is never overridden: a placeholder only fills a gap.
 *
 * Usage:  var profile = AvatarProfiles.resolve(name, userNumber);
 *         -> { userNumber: <account whose avatar to draw, or 0>,
 *              avatar:     <base64 raster to draw instead, or ''> }
 */
var AvatarProfiles = (function () {
    var PATH = system.data_dir + 'avatar_placeholders.json';
    var _stamp = -1;
    var _entries = {};
    var _links = {};
    /* Sysop "not a local user" marks: never match these to an account by name. */
    var _notLocal = {};
    var _avatarLib = null;
    var _realCache = {};
    /* Name -> newest net avatar. Built from ~250 small ini files, so it is
       cached in data/ and rebuilt at most every NET_MAX_AGE seconds; a
       request normally costs one stat and one read. */
    var NET_CACHE = system.data_dir + 'avatar_net_index.json';
    var NET_MAX_AGE = 600;
    var _net = null;

    function key(name) {
        return String(name === undefined || name === null ? '' : name)
            .replace(/[\x00-\x1f\x7f]/g, '')
            .replace(/^\s+|\s+$/g, '')
            .toLowerCase()
            .substr(0, 60);
    }

    /* Forms of a handle worth matching: as seen, without the collision
       suffix (^11D) and MRC site tags (trailing Alias[FL] terminal /
       Alias<FL> web; retired leading [FL]Alias and other boards' !xx!),
       with underscores as spaces, and fully collapsed. */
    function forms(name) {
        var raw = String(name || '');
        var plain = raw
            .replace(/\^\(?[A-Za-z0-9]{1,8}\)?$/, '')
            .replace(/(\[\w{1,4}\]|<\w{1,4}>)$/, '')
            .replace(/^(\[\w{1,4}\]|<\w{1,4}>|!\w{1,4}!)/, '');
        var list = [raw, plain, plain.replace(/_/g, ' '), plain.replace(/[^A-Za-z0-9]/g, '')];
        var out = [];
        var seen = {};
        for (var i = 0; i < list.length; i += 1) {
            var k = key(list[i]);
            if (k.length && !seen[k]) { seen[k] = true; out.push(k); }
        }
        return out;
    }

    function load() {
        var stamp = file_exists(PATH) ? (file_date(PATH) * 1000 + (file_size(PATH) % 1000)) : 0;
        if (stamp === _stamp) { return; }
        _stamp = stamp;
        _entries = {};
        _links = {};
        _notLocal = {};
        if (!stamp) { return; }
        var f = new File(PATH);
        if (!f.open('r')) { return; }
        var text = '';
        try { text = f.read(2 * 1024 * 1024) || ''; } finally { f.close(); }
        try {
            var parsed = JSON.parse(text);
            var entries = parsed && typeof parsed.entries === 'object' ? parsed.entries : {};
            var links = parsed && typeof parsed.links === 'object' ? parsed.links : {};
            var name;
            for (name in entries) {
                if (!entries.hasOwnProperty(name) || !entries[name]) { continue; }
                var data = String(entries[name].data || '').replace(/\s+/g, '');
                /* 120 raster bytes = exactly 160 base64 chars; this string goes
                   into an HTML attribute, so accept nothing else. */
                if (data.length === 160 && /^[A-Za-z0-9+\/]+=*$/.test(data) && key(name).length) {
                    _entries[key(name)] = data;
                }
            }
            for (name in links) {
                if (!links.hasOwnProperty(name)) { continue; }
                var alias = key(name);
                var main = key(links[name]);
                if (alias.length && main.length && alias !== main) { _links[alias] = main; }
            }
            var marks = parsed && typeof parsed.notLocal === 'object' ? parsed.notLocal : {};
            for (name in marks) {
                if (marks.hasOwnProperty(name) && marks[name] && key(name).length) { _notLocal[key(name)] = true; }
            }
        } catch (_parseError) {
            _entries = {};
            _links = {};
            _notLocal = {};
        }
    }

    function hasRealAvatar(userNumber) {
        if (!userNumber || userNumber < 1) { return false; }
        if (_realCache.hasOwnProperty(userNumber)) { return _realCache[userNumber]; }
        var real = false;
        try {
            if (!_avatarLib) { _avatarLib = load_avatar_lib(); }
            var obj = _avatarLib ? _avatarLib.read_localuser(userNumber) : null;
            real = !!(obj && obj.data && !obj.disabled);
        } catch (_avatarError) { real = false; }
        _realCache[userNumber] = real;
        return real;
    }

    function load_avatar_lib() {
        try { return js.global.load({}, 'avatar_lib.js'); } catch (_loadError) { return null; }
    }

    function localUser(name) {
        var found = 0;
        try { found = system.matchuser(name) || 0; } catch (_matchError) { found = 0; }
        return found;
    }

    var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

    /* avatar_lib's `Oct 26 2025 14:09:40` stamps; 0 when unreadable. */
    function stampMs(value) {
        var m = /^\s*(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(String(value || ''));
        if (!m || !MONTHS.hasOwnProperty(m[1].toLowerCase())) { return 0; }
        return Date.UTC(+m[3], MONTHS[m[1].toLowerCase()], +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    }

    function buildNetIndex() {
        var index = {};
        var newest = {};
        var paths = [];
        try {
            paths = (directory(system.data_dir + 'qnet/*.avatars.ini') || [])
                .concat(directory(system.data_dir + 'fido/*.avatars.ini') || []);
        } catch (_dirError) { paths = []; }
        for (var i = 0; i < paths.length; i += 1) {
            var f = new File(paths[i]);
            if (!f.open('r')) { continue; }
            var sections = [];
            try { sections = f.iniGetSections() || []; } catch (_iniError) { sections = []; }
            for (var j = 0; j < sections.length; j += 1) {
                var name = String(sections[j]);
                var k = key(name);
                if (!k.length || /^md5:/i.test(name)) { continue; }
                var obj = f.iniGetObject(name) || {};
                var data = String(obj.data || '').replace(/\s+/g, '');
                if (obj.disabled === true || /^(true|yes|1)$/i.test(String(obj.disabled || ''))) { continue; }
                if (data.length !== 160 || !/^[A-Za-z0-9+\/]+=*$/.test(data)) { continue; }
                var at = Math.max(stampMs(obj.updated), stampMs(obj.created));
                if (!index.hasOwnProperty(k) || at > newest[k]) { index[k] = data; newest[k] = at; }
            }
            f.close();
        }
        return index;
    }

    function netIndex() {
        if (_net) { return _net; }
        var fresh = file_exists(NET_CACHE) && (time() - file_date(NET_CACHE)) < NET_MAX_AGE;
        if (fresh) {
            var f = new File(NET_CACHE);
            if (f.open('r')) {
                try { _net = JSON.parse(f.read(4 * 1024 * 1024) || '{}'); } catch (_cacheError) { _net = null; } finally { f.close(); }
            }
            if (_net && typeof _net === 'object') { return _net; }
        }
        _net = buildNetIndex();
        /* Write-then-rename so a concurrent request never reads half a file. */
        var tmp = NET_CACHE + '.' + Math.floor(Math.random() * 1e9) + '.tmp';
        var out = new File(tmp);
        if (out.open('w')) {
            try { out.write(JSON.stringify(_net)); } finally { out.close(); }
            if (!file_rename(tmp, NET_CACHE)) { file_remove(tmp); }
        }
        return _net;
    }

    function resolve(name, userNumber) {
        load();
        var result = { userNumber: userNumber > 0 ? userNumber : 0, avatar: '' };
        var names = forms(name);
        var i;
        var main = '';
        /* A sysop marked this handle as NOT any local account: skip every
           account path (name match and links); a placeholder or net art may
           still apply. Same rule as the terminal shell. */
        for (i = 0; i < names.length; i += 1) {
            if (_notLocal[names[i]]) {
                result.userNumber = 0;
                for (i = 0; i < names.length; i += 1) {
                    if (_entries.hasOwnProperty(names[i])) { return { userNumber: 0, avatar: _entries[names[i]] }; }
                }
                var netMarked = netIndex();
                for (i = 0; i < names.length; i += 1) {
                    if (netMarked.hasOwnProperty(names[i])) { return { userNumber: 0, avatar: netMarked[names[i]] }; }
                }
                return result;
            }
        }
        /* A handle that IS a local account name (as seen, or cleaned of network
           decorations) is that account - the terminal shell matches the same way. */
        for (i = 0; i < names.length && !result.userNumber; i += 1) {
            result.userNumber = localUser(names[i]);
        }
        for (i = 0; i < names.length && !main.length; i += 1) {
            if (_links.hasOwnProperty(names[i])) { main = _links[names[i]]; }
        }
        if (main.length) {
            var mainNumber = localUser(main);
            if (hasRealAvatar(mainNumber)) { return { userNumber: mainNumber, avatar: '' }; }
        }
        if (hasRealAvatar(result.userNumber)) { return result; }
        if (main.length) { names.push(main); }
        for (i = 0; i < names.length; i += 1) {
            if (_entries.hasOwnProperty(names[i])) {
                /* Drawn from the raster; drop the account so the page does not
                   fetch that account's (absent) avatar instead. */
                return { userNumber: 0, avatar: _entries[names[i]] };
            }
        }
        var net = netIndex();
        for (i = 0; i < names.length; i += 1) {
            if (net.hasOwnProperty(names[i])) { return { userNumber: 0, avatar: net[names[i]] }; }
        }
        return result;
    }

    /* Convenience: fill `avatar` / `userNumber` on a message- or user-shaped
       object unless the sender already supplied an inline avatar. */
    function apply(target, name) {
        if (!target || target.avatar || !name) { return target; }
        var profile = resolve(name, target.userNumber || 0);
        target.userNumber = profile.userNumber;
        if (profile.avatar) { target.avatar = profile.avatar; }
        return target;
    }

    /* The base64 avatar to draw for a sender, for places that need the art
       itself rather than an account number to look up (chat toasts,
       notifications, push icons): their inline avatar if they sent one,
       else a placeholder / linked identity (resolve), else the real avatar
       of the account that resolves to. '' when there is nothing to draw. */
    function avatarData(name, userNumber, inlineAvatar) {
        var target = apply({ userNumber: userNumber || 0, avatar: inlineAvatar ? String(inlineAvatar) : '' }, name);
        if (target.avatar) { return target.avatar; }
        if (target.userNumber > 0) {
            var lib = load_avatar_lib();
            var real = null;
            try { real = lib ? lib.read_localuser(target.userNumber) : null; } catch (_readError) { real = null; }
            if (real && real.data && !real.disabled) { return String(real.data); }
        }
        return '';
    }

    return { resolve: resolve, apply: apply, avatarData: avatarData };
}());
