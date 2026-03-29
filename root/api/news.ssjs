/* news.ssjs — Server-side API for the webv4 News Reader
 *
 * Endpoints:
 *   ?call=get-categories         List categories with feed counts + icon data
 *   ?call=get-feeds              List feeds, paginated, filterable by category/search
 *   ?call=get-favorites          Get user favorites (auth required)
 *   ?call=toggle-favorite&url=X  Add/remove favorite (auth required)
 *   ?call=proxy-feed&url=X       Thin CORS proxy for RSS/Atom XML
 */

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
load('http.js');

/* ── paths ──────────────────────────────────────────────────────────── */

var MODS_DIR = system.mods_dir || (js.exec_dir + '../mods/');
if (MODS_DIR.slice(-1) !== '/' && MODS_DIR.slice(-1) !== '\\') MODS_DIR += '/';

var INI_PATH  = MODS_DIR + 'future_shell/config/newsreader.ini';
var CACHE_PATH = system.data_dir + 'newsreader_web.json';
var FAV_DIR   = MODS_DIR + 'future_shell/data/newsreader/';
var ICON_DIR  = MODS_DIR + 'future_shell/assets/newsreader/';
var ASSETS_DIR = MODS_DIR + 'future_shell/assets/';

/* ── helpers ────────────────────────────────────────────────────────── */

function jsonReply(obj) {
    http_reply.header['Content-Type'] = 'application/json; charset=utf-8';
    write(JSON.stringify(obj));
}

function errorReply(msg, status) {
    http_reply.header['Content-Type'] = 'application/json; charset=utf-8';
    if (status) http_reply.status = status;
    write(JSON.stringify({ error: true, message: String(msg) }));
}

function slugify(str) {
    if (!str) return '';
    return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/* ── INI parsing ────────────────────────────────────────────────────── */

function parseNewsIni() {
    var f = new File(INI_PATH);
    if (!f.open('r')) return null;
    var lines = f.readAll();
    f.close();

    var categories = {};
    var categoryOrder = [];
    var feeds = [];
    var currentSection = null;
    var currentData = {};

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.charAt(0) === ';' || line.charAt(0) === '#') continue;

        var secMatch = line.match(/^\[(.+)\]$/);
        if (secMatch) {
            if (currentSection) {
                processSection(currentSection, currentData, categories, categoryOrder, feeds);
            }
            currentSection = secMatch[1];
            currentData = {};
            continue;
        }

        var eq = line.indexOf('=');
        if (eq > 0 && currentSection) {
            var key = line.substring(0, eq).trim().toLowerCase();
            var val = line.substring(eq + 1).trim();
            currentData[key] = val;
        }
    }
    if (currentSection) {
        processSection(currentSection, currentData, categories, categoryOrder, feeds);
    }

    /* Build category list with feed counts */
    var catList = [];
    var feedCategorySlugs = {};

    for (var fi = 0; fi < feeds.length; fi++) {
        var slug = slugify(feeds[fi].category);
        feedCategorySlugs[slug] = feeds[fi].category;
    }

    for (var ci = 0; ci < categoryOrder.length; ci++) {
        var s = categoryOrder[ci];
        var cat = categories[s];
        var count = 0;
        for (var fj = 0; fj < feeds.length; fj++) {
            if (slugify(feeds[fj].category) === s) count++;
        }
        catList.push({ slug: s, name: cat.name, icon: cat.icon || s, feedCount: count });
    }

    /* Categories that only appear in feeds (not declared as [Category.x]) */
    for (var fcs in feedCategorySlugs) {
        if (!categories[fcs]) {
            var fc = 0;
            for (var fk = 0; fk < feeds.length; fk++) {
                if (slugify(feeds[fk].category) === fcs) fc++;
            }
            catList.push({ slug: fcs, name: feedCategorySlugs[fcs], icon: fcs, feedCount: fc });
        }
    }

    return { categories: catList, feeds: feeds };
}

function processSection(section, data, categories, categoryOrder, feeds) {
    var catMatch = section.match(/^Category\.(.+)$/i);
    if (catMatch) {
        var slug = catMatch[1].toLowerCase();
        categories[slug] = { name: data.label || catMatch[1], icon: data.icon || null };
        categoryOrder.push(slug);
        return;
    }

    var feedMatch = section.match(/^Feed\.(.+)$/i);
    if (feedMatch) {
        if (data.enabled && data.enabled.toLowerCase() === 'false') return;
        if (!data.url) return;
        feeds.push({
            key:  feedMatch[1],
            label: data.label || feedMatch[1],
            url:   data.url,
            category: data.category || 'Misc',
            icon:  data.icon || null,
            categoryIcon: data.category_icon || null
        });
    }
}

/* ── catalog cache ──────────────────────────────────────────────────── */

function loadCatalog() {
    var iniMtime = file_date(INI_PATH);
    if (file_exists(CACHE_PATH)) {
        try {
            var cf = new File(CACHE_PATH);
            if (cf.open('r')) {
                var raw = cf.readAll().join('');
                cf.close();
                var cached = JSON.parse(raw);
                if (cached._mtime && cached._mtime >= iniMtime) return cached;
            }
        } catch (e) {}
    }

    var catalog = parseNewsIni();
    if (!catalog) return { categories: [], feeds: [] };

    catalog._mtime = iniMtime;
    try {
        var wf = new File(CACHE_PATH);
        if (wf.open('w')) { wf.write(JSON.stringify(catalog)); wf.close(); }
    } catch (e) {}

    return catalog;
}

/* ── favorites ──────────────────────────────────────────────────────── */

function favPath(userNum) {
    return FAV_DIR + 'favorites_user' + userNum + '.json';
}

function loadFavorites(userNum) {
    var p = favPath(userNum);
    try {
        var f = new File(p);
        if (!f.exists || !f.open('r')) return [];
        var txt = f.readAll().join('');
        f.close();
        var obj = JSON.parse(txt);
        if (Array.isArray(obj)) return obj;
        if (obj && Array.isArray(obj.feeds)) return obj.feeds;
    } catch (e) {}
    return [];
}

function saveFavorites(userNum, list) {
    mkpath(FAV_DIR);
    var f = new File(favPath(userNum));
    if (!f.open('w')) return false;
    f.write(JSON.stringify({ feeds: list }));
    f.close();
    return true;
}

/* ── category icon helper ───────────────────────────────────────────── */

function loadCategoryIcon(iconName) {
    if (!iconName) return null;
    /* Try exact name, then sub_ prefixed, then sub_ + first word */
    var candidates = [
        iconName,
        'sub_' + iconName,
        'sub_' + iconName.split('_')[0]
    ];
    /* Search newsreader icon dir first, then parent assets dir */
    var dirs = [ICON_DIR, ASSETS_DIR];
    for (var di = 0; di < dirs.length; di++) {
        for (var ci = 0; ci < candidates.length; ci++) {
            var path = dirs[di] + candidates[ci] + '.bin';
            if (file_exists(path)) {
                try {
                    var f = new File(path);
                    if (!f.open('rb')) continue;
                    var raw = f.read();
                    f.close();
                    return base64_encode(raw);
                } catch (e) { continue; }
            }
        }
    }
    return null;
}

/* ── request handling ───────────────────────────────────────────────── */

var call = '';
if (typeof http_request !== 'undefined' && http_request.query && http_request.query.call) {
    call = http_request.query.call[0] || http_request.query.call || '';
}

switch (call) {

case 'get-categories': {
    var catalog = loadCatalog();
    var cats = catalog.categories || [];
    var result = [];
    for (var i = 0; i < cats.length; i++) {
        var c = cats[i];
        result.push({
            slug: c.slug,
            name: c.name,
            icon: c.icon,
            iconData: loadCategoryIcon(c.icon),
            feedCount: c.feedCount
        });
    }
    /* Load Favorites icon (heart_normal.bin) for client rendering */
    var favIcon = loadCategoryIcon('heart_normal');
    jsonReply({ categories: result, favIconData: favIcon });
    break;
}

case 'get-feeds': {
    var catalog = loadCatalog();
    var all = catalog.feeds || [];
    var catSlug = http_request.query.category ? (http_request.query.category[0] || http_request.query.category) : '';
    var search  = http_request.query.search   ? (http_request.query.search[0]   || http_request.query.search)   : '';
    var offset  = parseInt(http_request.query.offset ? (http_request.query.offset[0] || http_request.query.offset) : 0, 10);
    var limit   = parseInt(http_request.query.limit  ? (http_request.query.limit[0]  || http_request.query.limit)  : 25, 10);
    if (isNaN(offset) || offset < 0) offset = 0;
    if (isNaN(limit) || limit < 1)   limit = 25;
    if (limit > 100) limit = 100;

    /* Special pseudo-category: show only favorited feeds */
    var favFilter = null;
    if (catSlug === '__favorites__' && user.number > 0 && user.alias !== settings.guest) {
        favFilter = loadFavorites(user.number);
        catSlug = '';
    }

    var filtered = [];
    for (var fi = 0; fi < all.length; fi++) {
        var fd = all[fi];
        if (favFilter && favFilter.indexOf(fd.url) < 0) continue;
        if (catSlug && slugify(fd.category) !== catSlug) continue;
        if (search) {
            var q = search.toLowerCase();
            var match = (fd.label && fd.label.toLowerCase().indexOf(q) >= 0)
                || (fd.url && fd.url.toLowerCase().indexOf(q) >= 0)
                || (fd.category && fd.category.toLowerCase().indexOf(q) >= 0);
            if (!match) continue;
        }
        filtered.push(fd);
    }
    filtered.sort(function (a, b) {
        var A = (a.label || '').toLowerCase(), B = (b.label || '').toLowerCase();
        return A > B ? 1 : (A < B ? -1 : 0);
    });

    var total = filtered.length;
    var page  = filtered.slice(offset, offset + limit);
    jsonReply({ feeds: page, total: total, offset: offset, limit: limit });
    break;
}

case 'get-favorites': {
    if (user.number < 1 || user.alias === settings.guest) {
        jsonReply({ feeds: [] }); break;
    }
    jsonReply({ feeds: loadFavorites(user.number) });
    break;
}

case 'toggle-favorite': {
    if (user.number < 1 || user.alias === settings.guest) {
        errorReply('Login required', '401 Unauthorized'); break;
    }
    var turl = http_request.query.url ? (http_request.query.url[0] || http_request.query.url) : '';
    if (!turl) { errorReply('Missing url parameter'); break; }
    var favs = loadFavorites(user.number);
    var idx  = favs.indexOf(turl);
    if (idx >= 0) {
        favs.splice(idx, 1);
        saveFavorites(user.number, favs);
        jsonReply({ favorited: false, feeds: favs });
    } else {
        favs.push(turl);
        saveFavorites(user.number, favs);
        jsonReply({ favorited: true, feeds: favs });
    }
    break;
}

case 'proxy-feed': {
    var feedUrl = http_request.query.url ? (http_request.query.url[0] || http_request.query.url) : '';
    if (!feedUrl || (feedUrl.indexOf('http://') !== 0 && feedUrl.indexOf('https://') !== 0)) {
        errorReply('Invalid feed URL'); break;
    }
    try {
        var req = new HTTPRequest();
        req.follow_redirects = 5;
        req.recv_timeout = 15;
        var body = req.Get(feedUrl);
        http_reply.header['Content-Type'] = 'application/xml; charset=utf-8';
        http_reply.header['Cache-Control'] = 'public, max-age=300';
        write(body);
    } catch (e) {
        errorReply('Failed to fetch feed: ' + String(e));
    }
    break;
}

default:
    errorReply('Unknown or missing call parameter');
}
