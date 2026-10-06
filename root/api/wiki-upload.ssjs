/* wiki-upload.ssjs - images for wiki pages, into the Wiki > Images file area
 *
 * The editor drops, pastes or picks a picture (or names one on the web) and
 * gets back the markup to insert: ![image](wiki:name.png). Files land in the
 * `wiki_images` directory and are added to its file base, so they are also
 * there over FTP (Wiki/images/) and in the file listings.
 *
 * Uploads are chunked like chat-upload.ssjs: the web server hands scripts a
 * request body only up to 4 MiB, so the browser sends base64 slices.
 *
 *   POST ?action=begin&name=..&size=..&slug=..   -> {ok, id, chunkSize}
 *   POST ?action=chunk&id=..&seq=..             body = raw base64
 *   POST ?action=finish&id=..                    -> {ok, name, target, markup}
 *   POST ?action=abort&id=..
 *   POST ?action=fetch&slug=..                   JSON {url} -> same as finish
 *   GET  ?action=list                            -> {ok, images: [{name, target, added, by}]}
 *
 * Writes need a login, edit rights on the page being edited (slug) and the
 * CSRF token. The stored type comes from the file's own bytes, never from
 * its name; the stored name is the original, cleaned up and made unique.
 */
load('sbbsdefs.js');
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
var request = require({}, settings.web_lib + 'request.js', 'request');
load('/sbbs/xtrn/wiki/dist/wiki-core.js');

var DIR_CODE = 'wiki_images';
var CHUNK_RAW_BYTES = 1998000;          /* multiple of 3: base64 slices join cleanly */
var MAX_BYTES = 15 * 1024 * 1024;
var STAGE_DIR = system.data_dir + 'wiki-upload/';
var STAGE_STALE_SEC = 3600;
var MAX_OPEN_UPLOADS = 6;
var FETCH_TIMEOUT_SEC = 20;
var FETCH_MAX_REDIRECTS = 3;
var NAME_MAX = 48;

/* ------------------------------------------------------------- helpers */

function param(name, fallback) {
    return request.has_param(name) ? String(request.get_param(name)) : (fallback === undefined ? '' : fallback);
}

function respond(payload) {
    http_reply.header['Content-Type'] = 'application/json; charset=utf-8';
    http_reply.header['Cache-Control'] = 'no-store';
    write(JSON.stringify(payload));
    exit();
}

function fail(message, status) {
    if (status) http_reply.status = status;
    respond({ ok: false, error: message });
}

function isGuest() { return user.number < 1 || user.alias === settings.guest; }

function validId(id) { return /^[a-f0-9]{24}$/.test(String(id || '')); }

function newId() {
    var id = '';
    while (id.length < 24) id += format('%02x', random(256));
    return id.substr(0, 24);
}

function readJson(path) {
    var f = new File(path);
    if (!f.open('r')) return null;
    try { return JSON.parse(f.read()); } catch (e) { return null; } finally { f.close(); }
}

function writeJson(path, value) {
    var f = new File(path);
    if (!f.open('w')) return false;
    f.write(JSON.stringify(value));
    f.close();
    return true;
}

function partPath(id) { return STAGE_DIR + id + '.part'; }
function metaPath(id) { return STAGE_DIR + id + '.json'; }

function dropUpload(id) {
    if (file_exists(partPath(id))) file_remove(partPath(id));
    if (file_exists(metaPath(id))) file_remove(metaPath(id));
}

/* Abandoned uploads are swept on the way in; open ones are capped per user. */
function sweepAndCount(number) {
    var open = 0;
    directory(STAGE_DIR + '*.json').forEach(function (path) {
        var meta = readJson(path);
        var id = file_getname(path).replace(/\.json$/, '');
        if (!meta || time() - (meta.started || 0) > STAGE_STALE_SEC) { if (validId(id)) dropUpload(id); return; }
        if (meta.user === number) open++;
    });
    /* Staged downloads and finished-but-unstored files left by a failure. */
    directory(STAGE_DIR + '*.img').forEach(function (path) {
        if (time() - file_date(path) > STAGE_STALE_SEC) file_remove(path);
    });
    return open;
}

/* Login + edit rights on the page being edited + CSRF. */
function writeGate(slug) {
    if (isGuest()) fail('Log in to add images.', '401 Unauthorized');
    var cfg = WikiCore.readConfig('/sbbs/xtrn/wiki/wiki.ini');
    var who = { alias: user.alias, level: user.security.level, authenticated: true };
    if (!WikiCore.isValidSlug(slug) || !WikiCore.canEditPage(slug, who, cfg.minEditLevel)) {
        fail('You can only add images to pages you can edit.', '403 Forbidden');
    }
    if (!validateCsrfToken()) fail('Invalid CSRF token', '403 Forbidden');
}

function wikiDir() {
    var dir = file_area.dir[DIR_CODE];
    if (!dir) fail('The Wiki > Images file area is not set up.', '500 Internal Server Error');
    return dir;
}

/* The file's real type, from its first bytes: png, jpg, gif or webp. */
function sniff(path) {
    var f = new File(path);
    var head = '';
    if (!f.open('rb')) return '';
    try { head = f.read(12); } finally { f.close(); }
    if (head.substr(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
    if (head.substr(0, 3) === '\xff\xd8\xff') return 'jpg';
    if (head.substr(0, 6) === 'GIF87a' || head.substr(0, 6) === 'GIF89a') return 'gif';
    if (head.substr(0, 4) === 'RIFF' && head.substr(8, 4) === 'WEBP') return 'webp';
    return '';
}

/* "My Cool Photo (1).JPG" -> "my-cool-photo-1"; empty becomes "image". */
function cleanBase(name) {
    var base = String(name || '').replace(/^.*[\\\/]/, '').replace(/\?.*$/, '').replace(/\.[A-Za-z0-9]{1,5}$/, '');
    base = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substr(0, NAME_MAX).replace(/-+$/, '');
    return base.length ? base : 'image';
}

function uniqueName(dir, base, ext) {
    var name = base + '.' + ext;
    for (var n = 2; file_exists(dir.path + name); n++) name = base + '-' + n + '.' + ext;
    return name;
}

/* Move a staged file into the area, add it to the file base, reply. */
function store(stagedPath, originalName, desc) {
    var dir = wikiDir();
    var ext = sniff(stagedPath);
    if (!ext) { file_remove(stagedPath); fail('That isn\'t a PNG, JPEG, GIF or WebP image.'); }
    var name = uniqueName(dir, cleanBase(originalName), ext);
    if (!file_rename(stagedPath, dir.path + name)) {
        if (!file_copy(stagedPath, dir.path + name)) { file_remove(stagedPath); fail('Could not store the image.'); }
        file_remove(stagedPath);
    }
    var fb = new FileBase(DIR_CODE), added = false;
    if (fb.open()) {
        try {
            added = fb.add({ name: name, from: user.alias, desc: String(desc || name).substr(0, 58) });
        } catch (e) { added = false; } finally { fb.close(); }
    }
    if (!added) { file_remove(dir.path + name); fail('Could not add the image to the file area.'); }
    respond({ ok: true, name: name, target: 'wiki:' + name, markup: '![image](wiki:' + name + ')' });
}

/* ----------------------------------------------------- web fetch guard */

/* Addresses a page must never make this server fetch: loopback, private,
   link-local, CGNAT, multicast and the like. */
function privateIp(ip) {
    ip = String(ip || '').toLowerCase();
    var v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
    if (v4) {
        var a = +v4[1], b = +v4[2];
        return a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19));
    }
    if (ip === '::' || ip === '::1') return true;
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(ip);
}

function checkUrl(url) {
    var m = /^(https?):\/\/([^\/:?#\s]+)(?::(\d+))?(?:[\/?#]|$)/i.exec(url);
    if (!m) fail('Use a full http:// or https:// address.');
    var host = m[2].replace(/^\[|\]$/g, '');
    var ips = resolve_ip(host, true);
    if (!ips || (Array.isArray(ips) && !ips.length)) fail('Couldn\'t find ' + host + '.');
    if (!Array.isArray(ips)) ips = [ips];
    for (var i = 0; i < ips.length; i++) {
        if (privateIp(ips[i])) fail('That address isn\'t on the public internet.');
    }
}

function fetchToStage(url, stagedPath) {
    load('http.js');
    for (var hop = 0; hop <= FETCH_MAX_REDIRECTS; hop++) {
        checkUrl(url);
        var req = new HTTPRequest(undefined, undefined, { 'Accept': 'image/*' }, FETCH_TIMEOUT_SEC);
        req.follow_redirects = 0;
        var bytes = 0;
        try { bytes = req.Download(url, stagedPath); } catch (e) { fail('Couldn\'t download that image (' + e.message + ').'); }
        var code = req.response_code;
        if ([301, 302, 303, 307, 308].indexOf(code) !== -1) {
            var loc = req.response_headers_parsed && req.response_headers_parsed.location;
            if (!loc || !loc[0]) fail('The address redirected nowhere.');
            url = /^https?:\/\//i.test(loc[0]) ? loc[0] : url.replace(/^(https?:\/\/[^\/]+).*$/i, '$1') + (loc[0].charAt(0) === '/' ? '' : '/') + loc[0];
            continue;
        }
        if (code < 200 || code >= 300 || bytes <= 0) fail('The address answered ' + code + ', not an image.');
        if (file_size(stagedPath) > MAX_BYTES) { file_remove(stagedPath); fail('That image is over the ' + (MAX_BYTES / 1048576) + ' MB limit.'); }
        return url;
    }
    fail('Too many redirects.');
}

/* ------------------------------------------------------------- actions */

if (!file_isdir(STAGE_DIR)) mkdir(STAGE_DIR);
var action = param('action', '');

switch (action) {

case 'list':
    (function () {
        var dir = wikiDir();
        var fb = new FileBase(DIR_CODE), list = [];
        if (fb.open()) {
            try { list = fb.get_list('', FileBase.DETAIL.NORM) || []; } catch (e) { list = []; } finally { fb.close(); }
        }
        list.sort(function (a, b) { return (b.added || 0) - (a.added || 0); });
        respond({ ok: true, images: list.slice(0, 200).map(function (f) {
            return { name: f.name, target: 'wiki:' + f.name, added: f.added || 0, by: f.from || '' };
        }) });
    }());
    break;

case 'begin':
    (function () {
        writeGate(param('slug', ''));
        wikiDir();
        var name = param('name', '');
        var size = parseInt(param('size', '0'), 10) || 0;
        if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) fail('Only PNG, JPEG, GIF and WebP images can go in a page.');
        if (size <= 0) fail('Missing file size.');
        if (size > MAX_BYTES) fail('That image is over the ' + (MAX_BYTES / 1048576) + ' MB limit.');
        if (sweepAndCount(user.number) >= MAX_OPEN_UPLOADS) fail('Too many uploads in progress; let those finish first.');
        var id = newId();
        var f = new File(partPath(id));
        if (!f.open('wb')) fail('Could not start the upload.');
        f.close();
        writeJson(metaPath(id), { id: id, user: user.number, name: name, size: size, started: time(), nextSeq: 0 });
        respond({ ok: true, id: id, chunkSize: CHUNK_RAW_BYTES });
    }());
    break;

case 'chunk':
    (function () {
        var id = param('id', '');
        var seq = parseInt(param('seq', '-1'), 10);
        if (!validId(id)) fail('bad upload id');
        var meta = readJson(metaPath(id));
        if (!meta || meta.user !== user.number) fail('unknown upload');
        var body = typeof http_request.post_data === 'string' ? http_request.post_data : '';
        if (!body.length || !/^[A-Za-z0-9+\/=\r\n]+$/.test(body)) fail('bad chunk');
        if (seq !== meta.nextSeq) fail('chunk out of order');
        var f = new File(partPath(id));
        if (!f.open('ab')) fail('cannot append to upload');
        f.base64 = true;
        f.write(body);
        f.close();
        var got = file_size(partPath(id));
        if (got > meta.size) { dropUpload(id); fail('upload is larger than declared'); }
        meta.nextSeq = seq + 1;
        writeJson(metaPath(id), meta);
        respond({ ok: true, received: got });
    }());
    break;

case 'finish':
    (function () {
        var id = param('id', '');
        if (!validId(id)) fail('bad upload id');
        var meta = readJson(metaPath(id));
        if (!meta || meta.user !== user.number) fail('unknown upload');
        if (file_size(partPath(id)) !== meta.size) { dropUpload(id); fail('The upload didn\'t arrive complete; try again.'); }
        var staged = STAGE_DIR + id + '.img';
        file_rename(partPath(id), staged);
        dropUpload(id);
        store(staged, meta.name, cleanBase(meta.name).replace(/-/g, ' '));
    }());
    break;

case 'abort':
    (function () {
        var id = param('id', '');
        if (validId(id)) {
            var meta = readJson(metaPath(id));
            if (meta && meta.user === user.number) dropUpload(id);
        }
        respond({ ok: true });
    }());
    break;

case 'fetch':
    (function () {
        writeGate(param('slug', ''));
        wikiDir();
        var body = null;
        try { body = JSON.parse(http_request.post_data || '{}'); } catch (e) { body = null; }
        var url = body && typeof body.url === 'string' ? body.url.replace(/^\s+|\s+$/g, '') : '';
        if (!url.length) fail('Paste an image address first.');
        if (sweepAndCount(user.number) >= MAX_OPEN_UPLOADS) fail('Too many uploads in progress; let those finish first.');
        var staged = STAGE_DIR + newId() + '.img';
        var finalUrl = fetchToStage(url, staged);
        store(staged, finalUrl, 'from ' + finalUrl.replace(/^https?:\/\//i, '').substr(0, 50));
    }());
    break;

default:
    fail('unknown action');
}
