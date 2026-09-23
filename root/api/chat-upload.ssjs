/* chat-upload.ssjs — chunked media upload for the web chat drop zone.
 *
 * The web server hands JavaScript the request body ONLY when it is at most
 * MAX_POST_LEN (4 MiB, websrvr.cpp); anything larger is spooled to a temp file
 * and http_request.post_data is never defined. So a 20 MB picture — let alone a
 * 100 MB phone video — cannot arrive in one request. The client slices the file
 * and posts base64 chunks here instead:
 *
 *   POST ?action=begin&name=..&size=..            -> {id, chunkSize}
 *   POST ?action=chunk&id=..&seq=..               body = raw base64, no form
 *   POST ?action=finish&id=..                     -> {url, transcoded, ...}
 *   POST ?action=abort&id=..
 *
 * Nothing binary is ever held in a JS string: the chunk stays base64 all the
 * way to File.base64 = true, which b64-decodes inside file.write(). Chunks are
 * sized to a multiple of 3 raw bytes so the base64 seams decode cleanly when
 * appended back to back.
 *
 * Stored names are generated here and the extension comes from a fixed
 * allowlist — never from the client's filename. That matters: the media
 * directory lives under the web root, so a stored `.ssjs`/`.xjs` would be
 * EXECUTED rather than served.
 *
 * Video is re-encoded to a small, web-friendly profile (see encodeVideo). At
 * most ENCODE_SLOTS encodes run at once and each is niced, because this box has
 * 4 cores and also has to keep running a BBS.
 */
load('sbbsdefs.js');
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };

load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
var request = require({}, settings.web_lib + 'request.js', 'request');

/* ------------------------------------------------------------- constants */

/* 1998000 is divisible by 3, so each chunk's base64 is padding-free and the
   concatenation decodes to exactly the original bytes. Encoded that is
   2664000 characters — comfortably under the 4 MiB the server will hand us. */
var CHUNK_RAW_BYTES = 1998000;

var STAGE_DIR = system.data_dir + 'chat-upload/';
var LOCK_DIR = STAGE_DIR + 'locks/';
var MEDIA_DIR = backslash(settings.web_root) + 'chatmedia/';
var MEDIA_URL_PATH = '/chatmedia/';

var ENCODE_SLOTS = 2;
var ENCODE_SLOT_STALE_SEC = 900;      /* a slot held this long lost its owner */
var STAGE_STALE_SEC = 3600;           /* abandoned part files */
var MAX_OPEN_UPLOADS = 3;             /* unfinished uploads per user */

var VIDEO_MAX_SECONDS = 15;
var VIDEO_MAX_HEIGHT = 720;
var VIDEO_TARGET_BYTES = 20 * 1024 * 1024;

/* Declared extension -> stored extension, kind, and the stream ffprobe must
   find for the upload to count as real media of that kind. */
var TYPES = {
    png:  { ext: 'png',  kind: 'image', stream: 'video' },
    jpg:  { ext: 'jpg',  kind: 'image', stream: 'video' },
    jpeg: { ext: 'jpg',  kind: 'image', stream: 'video' },
    gif:  { ext: 'gif',  kind: 'image', stream: 'video' },
    webp: { ext: 'webp', kind: 'image', stream: 'video' },
    mp3:  { ext: 'mp3',  kind: 'audio', stream: 'audio' },
    m4a:  { ext: 'm4a',  kind: 'audio', stream: 'audio' },
    ogg:  { ext: 'ogg',  kind: 'audio', stream: 'audio' },
    oga:  { ext: 'ogg',  kind: 'audio', stream: 'audio' },
    wav:  { ext: 'wav',  kind: 'audio', stream: 'audio' },
    flac: { ext: 'flac', kind: 'audio', stream: 'audio' },
    mp4:  { ext: 'mp4',  kind: 'video', stream: 'video' },
    m4v:  { ext: 'mp4',  kind: 'video', stream: 'video' },
    mov:  { ext: 'mp4',  kind: 'video', stream: 'video' },
    webm: { ext: 'mp4',  kind: 'video', stream: 'video' },
    ans:  { ext: 'ans',  kind: 'ansi',  stream: null },
    asc:  { ext: 'asc',  kind: 'ansi',  stream: null },
    nfo:  { ext: 'asc',  kind: 'ansi',  stream: null }
};

var MAX_BYTES = {
    image: 20 * 1024 * 1024,
    audio: 20 * 1024 * 1024,
    video: 100 * 1024 * 1024,
    ansi:  1 * 1024 * 1024
};

/* ------------------------------------------------------------ small utils */

function trimText(value) {
    return String(value === undefined || value === null ? '' : value).replace(/^\s+|\s+$/g, '');
}

function param(name, fallback) {
    return request.has_param(name) ? String(request.get_param(name)) : (fallback === undefined ? '' : fallback);
}

function intParam(name, fallback) {
    var value = parseInt(param(name, ''), 10);
    return isNaN(value) ? fallback : value;
}

function respond(payload) {
    http_reply.header['Content-Type'] = 'application/json; charset=utf-8';
    http_reply.header['Cache-Control'] = 'no-store';
    write(JSON.stringify(payload));
    exit();
}

function fail(message, extra) {
    var payload = extra || {};
    payload.ok = false;
    payload.error = message;
    respond(payload);
}

/* Upload ids are generated here and then spliced into shell command lines and
   file paths, so every path that reads one back off the wire re-checks it. */
function validId(id) {
    return /^[a-f0-9]{24}$/.test(String(id || ''));
}

function newId() {
    var id = '';
    while (id.length < 24) {
        id += format('%02x', random(256));
    }
    return id.substr(0, 24);
}

function ensureDir(path) {
    if (!file_isdir(path)) mkdir(path);
    return file_isdir(path);
}

function readJson(path) {
    var f = new File(path);
    var text = '';
    if (!f.open('r')) return null;
    text = f.read();
    f.close();
    try { return JSON.parse(text); } catch (e) { return null; }
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

/* Staging holds only uploads still in progress, so counting a user's open ones
   is cheap — and it is the thing standing between an authenticated account and
   filling the disk one abandoned 100 MB video at a time. The purge job sweeps
   whatever is left behind; this keeps the burst bounded in the meantime. */
function openUploadsFor(number) {
    var names = directory(STAGE_DIR + '*.json');
    var count = 0;
    var meta;
    var i;
    for (i = 0; i < names.length; i += 1) {
        meta = readJson(names[i]);
        /* The meta file is rewritten on every chunk, so its mtime is the
           upload's last sign of life. */
        if (time() - file_date(names[i]) > STAGE_STALE_SEC) {
            if (meta && validId(meta.id)) dropUpload(meta.id);
            else file_remove(names[i]);
            continue;
        }
        if (meta && meta.user === number) count += 1;
    }
    return count;
}

function dropUpload(id) {
    if (file_exists(partPath(id))) file_remove(partPath(id));
    if (file_exists(metaPath(id))) file_remove(metaPath(id));
}

/* Behind Caddy the request itself is plain HTTP on 4080; the browser's scheme
   is in X-Forwarded-Proto. Chat embeds classify on an absolute URL, and the
   message is also seen by terminal users, so the link has to be the public one. */
function publicBase() {
    var proto = trimText(http_request.header['x-forwarded-proto']) || http_request.scheme || 'https';
    var host = trimText(http_request.header['x-forwarded-host'])
        || trimText(http_request.vhost)
        || trimText(http_request.header['host'])
        || system.inet_addr;
    /* Both headers are comma-lists when more than one proxy is in the path. */
    return trimText(proto.split(',')[0]) + '://' + trimText(host.split(',')[0]);
}

function dayFolder() {
    return strftime('%Y-%m-%d', time());
}

/* --------------------------------------------------------- shell helpers */

/* Every argument here is server-generated (ids match validId, directories are
   constants), so nothing user-controlled reaches the command line. */
function runCapture(command) {
    var outPath = STAGE_DIR + 'exec-' + newId() + '.out';
    var code = system.exec(command + ' > ' + outPath + ' 2>&1');
    var f = new File(outPath);
    var text = '';
    if (f.open('r')) {
        text = f.read();
        f.close();
    }
    if (file_exists(outPath)) file_remove(outPath);
    return { code: code, output: String(text || '') };
}

/* ffprobe doubles as the format check: if it cannot parse the file, whatever
   was uploaded is not the media the extension claims. */
function probe(path) {
    var result = runCapture('ffprobe -v error -print_format json -show_format -show_streams ' + path);
    var parsed = null;
    try { parsed = JSON.parse(result.output); } catch (e) { return null; }
    if (!parsed || !parsed.streams) return null;
    return parsed;
}

function findStream(info, type) {
    var i;
    for (i = 0; i < info.streams.length; i += 1) {
        if (info.streams[i].codec_type === type) return info.streams[i];
    }
    return null;
}

function probeDuration(info) {
    var seconds = parseFloat(info && info.format ? info.format.duration : 0);
    return isNaN(seconds) ? 0 : seconds;
}

/* ------------------------------------------------------- encode slot lock */

function slotPath(index) { return LOCK_DIR + 'slot' + index; }

function releaseStaleSlots() {
    var i;
    var age;
    for (i = 0; i < ENCODE_SLOTS; i += 1) {
        if (!file_isdir(slotPath(i))) continue;
        age = time() - file_date(slotPath(i));
        if (age > ENCODE_SLOT_STALE_SEC) rmdir(slotPath(i));
    }
}

/* mkdir is atomic, so the directory itself is the lock. */
function acquireSlot() {
    var i;
    releaseStaleSlots();
    for (i = 0; i < ENCODE_SLOTS; i += 1) {
        if (mkdir(slotPath(i))) return i;
    }
    return -1;
}

function releaseSlot(index) {
    if (index >= 0 && file_isdir(slotPath(index))) rmdir(slotPath(index));
}

/* One encode per user at a time — the client hides the drop zone while a video
   is working, but a second tab would not know about the first. */
function userBusyPath() { return LOCK_DIR + 'user-' + user.number; }

function claimUser() {
    if (file_isdir(userBusyPath()) && (time() - file_date(userBusyPath())) > ENCODE_SLOT_STALE_SEC) {
        rmdir(userBusyPath());
    }
    return mkdir(userBusyPath());
}

function releaseUser() {
    if (file_isdir(userBusyPath())) rmdir(userBusyPath());
}

/* ------------------------------------------------------------- video path */

/* True when the upload already matches what we would have encoded it to, so
   the encode can be skipped outright. This is the case the progress note in the
   UI is nudging people towards. */
function videoAlreadyFine(info, declaredExt, bytes) {
    var video = findStream(info, 'video');
    var audio = findStream(info, 'audio');
    if (declaredExt !== 'mp4' && declaredExt !== 'm4v') return false;
    if (!video || video.codec_name !== 'h264') return false;
    if (audio && audio.codec_name !== 'aac') return false;
    if (parseInt(video.height, 10) > VIDEO_MAX_HEIGHT) return false;
    if (probeDuration(info) > VIDEO_MAX_SECONDS + 0.5) return false;
    if (bytes > VIDEO_TARGET_BYTES) return false;
    return true;
}

/* Why the encode was needed, in the user's terms — the client shows this so the
   cost is explainable rather than mysterious. */
function encodeReason(info, declaredExt, bytes) {
    var video = findStream(info, 'video');
    var audio = findStream(info, 'audio');
    var reasons = [];
    if (declaredExt !== 'mp4' && declaredExt !== 'm4v') reasons.push('container is .' + declaredExt);
    if (video && video.codec_name !== 'h264') reasons.push('video is ' + video.codec_name + ', not H.264');
    if (audio && audio.codec_name !== 'aac') reasons.push('audio is ' + audio.codec_name + ', not AAC');
    if (video && parseInt(video.height, 10) > VIDEO_MAX_HEIGHT) {
        reasons.push(video.width + 'x' + video.height + ' is taller than ' + VIDEO_MAX_HEIGHT + 'p');
    }
    if (probeDuration(info) > VIDEO_MAX_SECONDS + 0.5) {
        reasons.push('clip runs ' + Math.round(probeDuration(info)) + 's, over the ' + VIDEO_MAX_SECONDS + 's limit');
    }
    if (!reasons.length && bytes > VIDEO_TARGET_BYTES) {
        reasons.push('file is ' + Math.round(bytes / 1048576) + ' MB');
    }
    return reasons.join(', ');
}

function encodeVideo(sourcePath, destPath, crf, height) {
    var command = 'nice -n 15 ffmpeg -nostdin -v error -y'
        + ' -t ' + VIDEO_MAX_SECONDS
        + ' -i ' + sourcePath
        + ' -vf "scale=-2:\'min(' + height + ',ih)\'"'
        + ' -c:v libx264 -preset veryfast -crf ' + crf + ' -pix_fmt yuv420p -threads 2'
        + ' -c:a aac -b:a 96k -ac 2'
        + ' -movflags +faststart'
        + ' ' + destPath;
    return runCapture(command);
}

/* ----------------------------------------------------------------- guards */

if (user.number < 1 || user.alias === settings.guest) {
    fail('authentication required');
}

if (http_request.method !== 'POST') {
    fail('POST required');
}

if (!validateCsrfToken()) {
    fail('Invalid CSRF token');
}

if (!ensureDir(STAGE_DIR) || !ensureDir(LOCK_DIR) || !ensureDir(MEDIA_DIR)) {
    fail('upload storage unavailable');
}

/* ---------------------------------------------------------------- actions */

var action = param('action', '');

switch (action) {

case 'begin':
    (function () {
        var declared = trimText(param('name', '')).toLowerCase();
        var match = /\.([a-z0-9]{1,4})$/.exec(declared);
        var ext = match ? match[1] : '';
        var type = TYPES[ext];
        var size = intParam('size', -1);
        var id;
        var f;

        if (!type) {
            fail('That file type cannot be posted to chat.');
        }
        if (size <= 0) {
            fail('Missing file size.');
        }
        if (size > MAX_BYTES[type.kind]) {
            fail(type.kind === 'video'
                ? 'Videos have to be under ' + Math.round(MAX_BYTES.video / 1048576) + ' MB.'
                : 'That file is over the ' + Math.round(MAX_BYTES[type.kind] / 1048576) + ' MB limit.');
        }
        if (openUploadsFor(user.number) >= MAX_OPEN_UPLOADS) {
            fail('You have too many uploads in progress. Let those finish first.');
        }

        id = newId();
        f = new File(partPath(id));
        if (!f.open('wb')) {
            fail('Could not open upload staging file.');
        }
        f.close();

        writeJson(metaPath(id), {
            id: id,
            user: user.number,
            alias: user.alias,
            declaredExt: ext,
            kind: type.kind,
            storedExt: type.ext,
            size: size,
            started: time(),
            received: 0,
            nextSeq: 0
        });

        respond({ ok: true, id: id, chunkSize: CHUNK_RAW_BYTES, kind: type.kind });
    }());
    break;

case 'chunk':
    (function () {
        var id = param('id', '');
        var seq = intParam('seq', -1);
        var meta;
        var body;
        var f;
        var before;
        var after;

        if (!validId(id)) fail('bad upload id');
        meta = readJson(metaPath(id));
        if (!meta || meta.user !== user.number) fail('unknown upload');

        /* The chunk is the whole request body: routing it through a form field
           would url-encode base64's + and / and inflate it past the ceiling. */
        body = typeof http_request.post_data === 'string' ? http_request.post_data : '';
        if (!body.length) fail('empty chunk');
        if (!/^[A-Za-z0-9+/=\r\n]+$/.test(body)) fail('chunk is not base64');

        if (seq !== meta.nextSeq) {
            fail('chunk out of order', { expected: meta.nextSeq });
        }

        before = file_size(partPath(id));
        f = new File(partPath(id));
        if (!f.open('ab')) fail('cannot append to upload');
        f.base64 = true;                  /* file.write() b64-decodes for us */
        f.write(body);
        f.close();

        after = file_size(partPath(id));
        if (after <= before) {
            dropUpload(id);
            fail('chunk could not be decoded');
        }
        if (after > meta.size) {
            dropUpload(id);
            fail('upload is larger than declared');
        }

        meta.received = after;
        meta.nextSeq = seq + 1;
        writeJson(metaPath(id), meta);

        respond({ ok: true, received: after, nextSeq: meta.nextSeq });
    }());
    break;

case 'finish':
    (function () {
        var id = param('id', '');
        var meta;
        var bytes;
        var info;
        var stream;
        var folder;
        var destDir;
        var destName;
        var destPath;
        var slot = -1;
        var encoded = null;
        var transcoded = false;
        var reason = '';
        var encodeStarted = 0;
        var encodeMs = 0;
        var seconds = 0;

        if (!validId(id)) fail('bad upload id');
        meta = readJson(metaPath(id));
        if (!meta || meta.user !== user.number) fail('unknown upload');
        if (!TYPES[meta.declaredExt]) {
            dropUpload(id);
            fail('unknown upload');
        }

        bytes = file_size(partPath(id));
        if (bytes <= 0) {
            dropUpload(id);
            fail('upload is empty');
        }

        /* ANSI is plain CP437 text with no structure to probe; the allowlisted
           stored extension is what keeps it inert. */
        if (meta.kind !== 'ansi') {
            info = probe(partPath(id));
            stream = info ? findStream(info, TYPES[meta.declaredExt].stream) : null;
            if (!info || !stream) {
                dropUpload(id);
                fail('That file is not a readable ' + meta.kind + '.');
            }
            seconds = probeDuration(info);
            if (meta.kind === 'video' && seconds <= 0) {
                dropUpload(id);
                fail('That video has no playable length.');
            }
        }

        folder = dayFolder();
        destDir = MEDIA_DIR + folder + '/';
        if (!ensureDir(destDir)) {
            dropUpload(id);
            fail('media storage unavailable');
        }
        destName = id + '.' + meta.storedExt;
        destPath = destDir + destName;

        if (meta.kind === 'video' && !videoAlreadyFine(info, meta.declaredExt, bytes)) {
            reason = encodeReason(info, meta.declaredExt, bytes);

            if (!claimUser()) {
                fail('You already have a video encoding. Wait for that one to post first.', { busy: 'user' });
            }

            slot = acquireSlot();
            if (slot < 0) {
                releaseUser();
                fail('The encoder is busy. Try again in a moment.', { busy: 'slots', retry: true });
            }

            encodeStarted = Date.now();
            encoded = encodeVideo(partPath(id), destPath, 28, VIDEO_MAX_HEIGHT);

            /* Belt and braces: a dense 15s clip should land near 3 MB, but if
               it somehow overshoots, take one harder pass rather than storing
               something bigger than the limit we advertise. */
            if (encoded.code === 0 && file_size(destPath) > VIDEO_TARGET_BYTES) {
                if (file_exists(destPath)) file_remove(destPath);
                encoded = encodeVideo(partPath(id), destPath, 32, 480);
            }

            encodeMs = Date.now() - encodeStarted;
            releaseSlot(slot);
            releaseUser();

            if (encoded.code !== 0 || !file_exists(destPath) || file_size(destPath) <= 0) {
                if (file_exists(destPath)) file_remove(destPath);
                dropUpload(id);
                log(LOG_WARNING, 'chat-upload: ffmpeg failed for ' + id + ': ' + encoded.output.substr(0, 400));
                fail('That video could not be converted.');
            }

            transcoded = true;
            seconds = Math.min(seconds, VIDEO_MAX_SECONDS);
        } else if (!file_rename(partPath(id), destPath)) {
            dropUpload(id);
            fail('Could not store the upload.');
        }

        dropUpload(id);

        respond({
            ok: true,
            url: publicBase() + MEDIA_URL_PATH + folder + '/' + destName,
            name: destName,
            kind: meta.kind,
            bytes: file_size(destPath),
            sourceBytes: bytes,
            seconds: Math.round(seconds * 10) / 10,
            transcoded: transcoded,
            reason: reason,
            encodeMs: encodeMs,
            expiresDays: 7
        });
    }());
    break;

case 'abort':
    (function () {
        var id = param('id', '');
        if (!validId(id)) fail('bad upload id');
        var meta = readJson(metaPath(id));
        if (meta && meta.user === user.number) dropUpload(id);
        respond({ ok: true });
    }());
    break;

default:
    fail('unknown action: ' + action);
}
