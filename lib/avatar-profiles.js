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
 *   4. nothing (the page falls back to an identicon / initial)
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
    var _avatarLib = null;
    var _realCache = {};

    function key(name) {
        return String(name === undefined || name === null ? '' : name)
            .replace(/[\x00-\x1f\x7f]/g, '')
            .replace(/^\s+|\s+$/g, '')
            .toLowerCase()
            .substr(0, 60);
    }

    /* Forms of a handle worth matching: as seen, without MRC site tags
       ([FL] terminal / <FL> web / legacy !xx!) and collision suffix (^11D),
       with underscores as spaces, and fully collapsed. */
    function forms(name) {
        var raw = String(name || '');
        var plain = raw
            .replace(/^(\[\w{1,4}\]|<\w{1,4}>|!\w{1,4}!)/, '')
            .replace(/\^\(?[A-Za-z0-9]{1,8}\)?$/, '');
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
        } catch (_parseError) {
            _entries = {};
            _links = {};
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

    function resolve(name, userNumber) {
        load();
        var result = { userNumber: userNumber > 0 ? userNumber : 0, avatar: '' };
        var names = forms(name);
        var i;
        var main = '';
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

    return { resolve: resolve, apply: apply };
}());
