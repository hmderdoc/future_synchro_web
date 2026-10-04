/* mail-attach.ssjs — chunked staging for e-mail attachments from the web composer.
 *
 * Same wire scheme as chat-upload.ssjs (the web server only hands JavaScript a
 * request body of at most 4 MiB, so the client slices the file and posts base64
 * chunks):
 *
 *   POST ?action=begin&name=..&size=..            -> {id, name, chunkSize}
 *   POST ?action=chunk&id=..&seq=..               body = raw base64, no form
 *   POST ?action=abort&id=..
 *
 * There is no `finish`: once every byte is in, the composer passes the id along
 * with forum.ssjs?call=post / post-reply, and postMail() (lib/forum.js) MIME-
 * encodes the staged files into the message and deletes them. Staging lives
 * under data/, never the web root, so any file type is fine to hold.
 */
load('sbbsdefs.js');
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };

load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
load(settings.web_lib + 'mail-attach-lib.js');
var request = require({}, settings.web_lib + 'request.js', 'request');

/* Divisible by 3, so each chunk's base64 is padding-free and the concatenation
   decodes to exactly the original bytes. */
var CHUNK_RAW_BYTES = 1998000;
var MAX_OPEN_UPLOADS = 12;            /* staged, not yet sent, per user */

function param(name, fallback) {
    return request.has_param(name) ? String(request.get_param(name)) : (fallback === undefined ? '' : fallback);
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

function newId() {
    var id = '';
    while (id.length < 24) id += format('%02x', random(256));
    return id.substr(0, 24);
}

if (user.number < 1 || user.alias === settings.guest) fail('authentication required');
if (user.security.restrictions & UFLAG_E || user.security.restrictions & UFLAG_M) fail('You are not allowed to send e-mail.');
if (http_request.method !== 'POST') fail('POST required');
if (!validateCsrfToken()) fail('Invalid CSRF token');
if (!MailAttach.ensureDir()) fail('attachment storage unavailable');

switch (param('action', '')) {

case 'begin':
    (function () {
        var name = MailAttach.cleanName(param('name', ''));
        var size = parseInt(param('size', ''), 10);
        var id;
        var f;
        if (!name) fail('Missing file name.');
        if (isNaN(size) || size <= 0) fail('That file is empty.');
        if (size > MailAttach.MAX_TOTAL) {
            fail('Attachments can total at most ' + MailAttach.MAX_TOTAL_MB + ' MB per message.');
        }
        if (MailAttach.openFor(user.number) >= MAX_OPEN_UPLOADS) {
            fail('Too many attachments waiting to be sent. Send or remove some first.');
        }
        id = newId();
        f = new File(MailAttach.partPath(id));
        if (!f.open('wb')) fail('Could not open attachment staging file.');
        f.close();
        MailAttach.writeMeta(id, {
            id: id,
            user: user.number,
            name: name,
            size: size,
            received: 0,
            nextSeq: 0,
            started: time()
        });
        respond({ ok: true, id: id, name: name, chunkSize: CHUNK_RAW_BYTES });
    }());
    break;

case 'chunk':
    (function () {
        var id = param('id', '');
        var seq = parseInt(param('seq', ''), 10);
        var meta;
        var body;
        var f;
        var before;
        var after;
        if (!MailAttach.validId(id)) fail('bad attachment id');
        meta = MailAttach.readMeta(id);
        if (!meta || meta.user !== user.number) fail('unknown attachment');
        /* The chunk is the whole request body: routing it through a form field
           would url-encode base64's + and / and inflate it past the ceiling. */
        body = typeof http_request.post_data === 'string' ? http_request.post_data : '';
        if (!body.length) fail('empty chunk');
        if (!/^[A-Za-z0-9+/=\r\n]+$/.test(body)) fail('chunk is not base64');
        if (seq !== meta.nextSeq) fail('chunk out of order', { expected: meta.nextSeq });

        before = file_size(MailAttach.partPath(id));
        f = new File(MailAttach.partPath(id));
        if (!f.open('ab')) fail('cannot append to attachment');
        f.base64 = true;                  /* file.write() b64-decodes for us */
        f.write(body);
        f.close();
        after = file_size(MailAttach.partPath(id));
        if (after <= before) {
            MailAttach.drop(id);
            fail('chunk could not be decoded');
        }
        if (after > meta.size) {
            MailAttach.drop(id);
            fail('attachment is larger than declared');
        }
        meta.received = after;
        meta.nextSeq = seq + 1;
        MailAttach.writeMeta(id, meta);
        respond({ ok: true, received: after, done: after === meta.size });
    }());
    break;

case 'abort':
    (function () {
        var id = param('id', '');
        var meta;
        if (!MailAttach.validId(id)) fail('bad attachment id');
        meta = MailAttach.readMeta(id);
        if (meta && meta.user === user.number) MailAttach.drop(id);
        respond({ ok: true });
    }());
    break;

default:
    fail('unknown action');
}
