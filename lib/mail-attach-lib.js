/* mail-attach-lib.js — staged web-mail attachments and the MIME message they
 * become. Used by root/api/mail-attach.ssjs (staging) and lib/forum.js
 * (postMail, at send time).
 *
 * A message with attachments is stored the way the mail server stores incoming
 * Internet mail: a multipart/mixed body with MIME-Version / Content-Type kept as
 * RFC822 header fields. That one shape is what everything else already reads:
 * the web reader (mime-decode.js + api/attachments.ssjs), the terminal mail
 * reader (offers each attachment for download), and the mail server, which
 * sends those header fields and the body as-is when the recipient is on the
 * Internet.
 */
require('smbdefs.js', 'RFC822HEADER');

var MailAttach = (function () {

    var STAGE_DIR = system.data_dir + 'mail-attach/';
    var STALE_SEC = 6 * 3600;             /* staged but never sent */
    var MAX_FILES = 10;
    var MAX_TOTAL_MB = 10;
    var MAX_TOTAL = MAX_TOTAL_MB * 1024 * 1024;

    function validId(id) {
        return /^[a-f0-9]{24}$/.test(String(id || ''));
    }

    function partPath(id) { return STAGE_DIR + id + '.part'; }
    function metaPath(id) { return STAGE_DIR + id + '.json'; }

    function ensureDir() {
        if (!file_isdir(STAGE_DIR)) mkdir(STAGE_DIR);
        return file_isdir(STAGE_DIR);
    }

    function readJson(path) {
        var f = new File(path);
        var text;
        if (!f.open('r')) return null;
        text = f.read();
        f.close();
        try { return JSON.parse(text); } catch (e) { return null; }
    }

    function readMeta(id) { return readJson(metaPath(id)); }

    function writeMeta(id, meta) {
        var f = new File(metaPath(id));
        if (!f.open('w')) return false;
        f.write(JSON.stringify(meta));
        f.close();
        return true;
    }

    function drop(id) {
        if (file_exists(partPath(id))) file_remove(partPath(id));
        if (file_exists(metaPath(id))) file_remove(metaPath(id));
    }

    /* Counts this user's staged files, sweeping anyone's abandoned ones. */
    function openFor(number) {
        var names = directory(STAGE_DIR + '*.json');
        var count = 0;
        var i;
        var meta;
        for (i = 0; i < names.length; i += 1) {
            meta = readJson(names[i]);
            if (time() - file_date(names[i]) > STALE_SEC) {
                if (meta && validId(meta.id)) drop(meta.id);
                else file_remove(names[i]);
                continue;
            }
            if (meta && meta.user === number) count += 1;
        }
        return count;
    }

    /* The name ends up inside a quoted MIME parameter and, on the terminal
       side, as a file name in the node's temp dir: keep it plain ASCII. */
    function cleanName(name) {
        name = String(name || '').replace(/^.*[\\\/]/, '');
        name = name.replace(/[^A-Za-z0-9._()+ -]+/g, '_').replace(/_+/g, '_');
        name = name.replace(/^[\s.]+|\s+$/g, '');
        if (name.length > 80) {
            var m = /(\.[A-Za-z0-9]{1,8})$/.exec(name);
            name = name.substr(0, 80 - (m ? m[1].length : 0)) + (m ? m[1] : '');
        }
        return name;
    }

    function mimeType(name) {
        var m = /\.([A-Za-z0-9]+)$/.exec(name);
        var type;
        var f;
        if (!m) return 'application/octet-stream';
        f = new File(system.ctrl_dir + 'mime_types.ini');
        if (f.open('r')) {
            type = f.iniGetValue(null, m[1].toLowerCase());
            f.close();
        }
        return (type && /^[\w.+-]+\/[\w.+-]+$/.test(type)) ? type : 'application/octet-stream';
    }

    /* Validates the ids this user is sending with. Returns
       { files: [{id, name, size}] } or { error: '...' }. */
    function collect(ids, number) {
        var files = [];
        var seen = {};
        var total = 0;
        var i;
        var meta;
        for (i = 0; i < ids.length; i += 1) {
            if (!validId(ids[i]) || seen[ids[i]]) continue;
            seen[ids[i]] = true;
            meta = readMeta(ids[i]);
            if (!meta || meta.user !== number || !file_exists(partPath(ids[i]))) {
                return { error: 'An attachment expired or is missing. Remove it and attach it again.' };
            }
            if (meta.received !== meta.size || file_size(partPath(ids[i])) !== meta.size) {
                return { error: meta.name + ' has not finished uploading.' };
            }
            total += meta.size;
            files.push({ id: meta.id, name: meta.name, size: meta.size });
        }
        if (files.length > MAX_FILES) return { error: 'At most ' + MAX_FILES + ' attachments per message.' };
        if (total > MAX_TOTAL) return { error: 'Attachments can total at most ' + MAX_TOTAL_MB + ' MB per message.' };
        return { files: files };
    }

    function readBase64(id) {
        var f = new File(partPath(id));
        var data;
        if (!f.open('rb')) return null;
        f.base64 = true;                  /* file.read() b64-encodes for us */
        data = f.read();
        f.close();
        return data;
    }

    /* Turns header + text into a multipart/mixed message carrying 'files'
       (from collect()). Adds the MIME header fields to 'header' and returns
       the body, or null if a staged file could not be read. */
    function build(header, text, files) {
        var boundary = format('----=_FL_%08x%08x%08x', random(0x7fffffff), random(0x7fffffff), time());
        var out = [
            'This is a multi-part message in MIME format.',
            '',
            '--' + boundary,
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
            '',
            text.replace(/\r?\n/g, '\r\n'),
        ];
        var i;
        var data;
        for (i = 0; i < files.length; i += 1) {
            data = readBase64(files[i].id);
            if (data === null) return null;
            out.push(
                '--' + boundary,
                'Content-Type: ' + mimeType(files[i].name) + '; name="' + files[i].name + '"',
                'Content-Transfer-Encoding: base64',
                'Content-Disposition: attachment; filename="' + files[i].name + '"',
                '',
                data.replace(/(.{76})/g, '$1\r\n').replace(/\r\n$/, '')
            );
        }
        out.push('--' + boundary + '--', '');
        if (!header.field_list) header.field_list = [];
        header.field_list.push(
            { type: RFC822HEADER, data: 'MIME-Version: 1.0' },
            { type: RFC822HEADER, data: 'Content-Type: multipart/mixed; boundary="' + boundary + '"' }
        );
        header.auxattr = (header.auxattr || 0) | MSG_MIMEATTACH;
        return out.join('\r\n');
    }

    function release(files) {
        for (var i = 0; i < files.length; i += 1) drop(files[i].id);
    }

    return {
        MAX_FILES: MAX_FILES,
        MAX_TOTAL: MAX_TOTAL,
        MAX_TOTAL_MB: MAX_TOTAL_MB,
        validId: validId,
        partPath: partPath,
        ensureDir: ensureDir,
        readMeta: readMeta,
        writeMeta: writeMeta,
        drop: drop,
        openFor: openFor,
        cleanName: cleanName,
        collect: collect,
        build: build,
        release: release
    };
})();
