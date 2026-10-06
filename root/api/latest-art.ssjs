// latest-art.ssjs - newest ANSI uploads for the home page's Latest Art card.
//
// GET ?call=list&since=<unix>&offset=0&limit=10
//   -> { total, items: [{ dir, name, title, by, added, thumb: cells }] }
//      newest first, from the art directories of the OriginalContent and
//      Artwork libraries, NSFW-flagged pieces left out (this feeds the public
//      landing page); thumb holds only the top rows (render_file_cells).
// GET ?call=full&dir=<code>&file=<name>
//   -> the whole piece as cells, for the expanded preview.
//
// Cells are what js/graphics-converter.js draws: { cols, rows, bin, ice,
// spacing, ratio }. Uploader names resolve to accounts the way profile pages
// credit work (social_lib resolveLocalUser, then the file name's handle).

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
var ansi_viewer = load({}, settings.web_lib + 'ansi-viewer.js');

var ART_LIBS = ['originalcontent', 'artwork'];
var ART_EXT = /\.(ans|asc|bin|xb|icn|adf|pcb)$/i;
var THUMB_ROWS = 30;
var MAX_LIMIT = 20;

function param(name, fallback) {
    var v = http_request.query[name];
    return v && v.length ? String(v[0]) : fallback;
}

function reply(obj) {
    http_reply.header['Content-Type'] = 'application/json';
    http_reply.header['Cache-Control'] = 'no-store';
    write(JSON.stringify(obj));
}

function artDirs() {
    var out = [];
    file_area.lib_list.forEach(function (lib) {
        if (ART_LIBS.indexOf(String(lib.name).toLowerCase()) === -1) return;
        lib.dir_list.forEach(function (d) {
            if (d.can_download && user.compare_ars(d.download_ars)) out.push(d.code);
        });
    });
    return out;
}

function cellsOut(c) {
    return c && c.ok ? { cols: c.cols, rows: c.rows, bin: c.bin, ice: c.ice, spacing: c.spacing, ratio: c.ratio } : null;
}

var Social = null;
try { Social = load({}, system.mods_dir + 'load/social_lib.js').Social; } catch (e) { Social = null; }
var resolved = {};
function resolveName(name) {
    if (!name || !Social) return 0;
    if (resolved[name] === undefined) {
        try { resolved[name] = Social.resolveLocalUser(name, '') || 0; } catch (e) { resolved[name] = 0; }
    }
    return resolved[name];
}
function uploader(file) {
    var n = resolveName(String(file.from || ''));
    if (!n) {
        var parts = String(file.name).replace(/\.[^.]+$/, '').split('_');
        for (var w = Math.min(3, parts.length - 1); w >= 1 && !n; w--) {
            var tail = parts.slice(-w).join(' ');
            if (w === 1 && tail.length < 4) continue;
            n = resolveName(tail);
        }
    }
    return n ? String(new User(n).alias) : String(file.from || '');
}

/* The site's NSFW rule (keywords + manual flags), as profile pages use. */
function nsfw(dir, name, desc) {
    try { return !!(Social && Social.isNsfw(dir, name, desc)); } catch (e) { return false; }
}

function prettyName(name) {
    return String(name).replace(/\.[^.]+$/, '').replace(/_/g, ' ');
}

var call = param('call', 'list');
var dirs = artDirs();

if (call === 'full') {
    var dir = param('dir', ''), file = param('file', '');
    if (dirs.indexOf(dir) === -1 || !file || /[\/\\\x00]/.test(file) || !ART_EXT.test(file)
        || !file_exists(file_area.dir[dir].path + file) || nsfw(dir, file, '')) {
        reply({ ok: false, error: 'Not found' });
    } else {
        var full = ansi_viewer.render_file_cells(file_area.dir[dir].path + file, 600);
        reply({ ok: !!full.ok, cells: cellsOut(full), error: full.ok ? undefined : full.message });
    }
} else {
    var since = parseInt(param('since', '0'), 10) || 0;
    var offset = Math.max(0, parseInt(param('offset', '0'), 10) || 0);
    var limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(param('limit', '10'), 10) || 10));
    var all = [];
    dirs.forEach(function (code) {
        var fb = new FileBase(code);
        if (!fb.open()) return;
        var list = [];
        try { list = fb.get_list('*', FileBase.DETAIL.NORM) || []; } finally { fb.close(); }
        list.forEach(function (f) {
            if (!f || !ART_EXT.test(f.name) || (f.added || 0) < since) return;
            if (nsfw(code, f.name, f.desc)) return;      /* public landing page */
            if (!file_exists(file_area.dir[code].path + f.name)) return;   /* listed, but the file is gone */
            all.push({ dir: code, file: f });
        });
    });
    all.sort(function (a, b) { return (b.file.added || 0) - (a.file.added || 0); });
    var items = all.slice(offset, offset + limit).map(function (e) {
        var path = file_area.dir[e.dir].path + e.file.name;
        var thumb = ansi_viewer.render_file_cells(path, THUMB_ROWS);
        var title = thumb.ok && thumb.credit && thumb.credit.title ? thumb.credit.title : (e.file.desc || prettyName(e.file.name));
        return {
            dir: e.dir,
            name: String(e.file.name),
            title: String(title).replace(/\s+$/, ''),
            by: uploader(e.file),
            added: e.file.added || 0,
            thumb: cellsOut(thumb)
        };
    });
    reply({ total: all.length, items: items });
}
