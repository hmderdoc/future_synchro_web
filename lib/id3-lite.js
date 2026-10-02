/* id3-lite.js - just enough ID3v2 for the web: title / artist / album /
 * year text and where the cover picture sits in the file.
 *
 * Id3Lite.read(path) -> null (no ID3v2 tag) or
 *   { title, artist, album, year,               // UTF-8 byte strings
 *     art: { offset, length, mime } | null }    // front cover preferred
 *
 * Handles v2.2 / v2.3 / v2.4 frames and the four text encodings. Tags using
 * whole-tag unsynchronisation are skipped for art (rare, and the picture
 * bytes would need un-escaping). Strings come back as UTF-8 bytes, which is
 * what the rest of the JSON these APIs write already carries.
 */

var Id3Lite = (function () {
    var MAX_TAG = 8 * 1024 * 1024;

    function u8(s, i) { return s.charCodeAt(i) & 0xff; }
    function be32(s, i) { return ((u8(s, i) << 24) | (u8(s, i + 1) << 16) | (u8(s, i + 2) << 8) | u8(s, i + 3)) >>> 0; }
    function be24(s, i) { return (u8(s, i) << 16) | (u8(s, i + 1) << 8) | u8(s, i + 2); }
    function syncsafe(s, i) { return (u8(s, i) << 21) | (u8(s, i + 1) << 14) | (u8(s, i + 2) << 7) | u8(s, i + 3); }

    function utf8(cp) {
        if (cp < 0x80) return String.fromCharCode(cp);
        if (cp < 0x800) return String.fromCharCode(0xc0 | (cp >> 6), 0x80 | (cp & 63));
        if (cp < 0x10000) return String.fromCharCode(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        return String.fromCharCode(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }

    /* Frame text (encoding byte first) -> UTF-8 bytes. */
    function text(data) {
        if (!data.length) return '';
        var enc = u8(data, 0), body = data.substr(1), out = '', i;
        if (enc === 3) return body.replace(/\x00[\s\S]*$/, '');
        if (enc === 0) {
            for (i = 0; i < body.length && body.charCodeAt(i) !== 0; i++) out += utf8(u8(body, i));
            return out;
        }
        var le = enc === 1 && u8(body, 0) === 0xff && u8(body, 1) === 0xfe;
        if (enc === 1 && (le || (u8(body, 0) === 0xfe && u8(body, 1) === 0xff))) body = body.substr(2);
        for (i = 0; i + 1 < body.length; i += 2) {
            var cu = le ? (u8(body, i) | (u8(body, i + 1) << 8)) : ((u8(body, i) << 8) | u8(body, i + 1));
            if (cu === 0) break;
            if (cu >= 0xd800 && cu < 0xdc00 && i + 3 < body.length) {
                var lo = le ? (u8(body, i + 2) | (u8(body, i + 3) << 8)) : ((u8(body, i + 2) << 8) | u8(body, i + 3));
                cu = 0x10000 + ((cu - 0xd800) << 10) + (lo - 0xdc00);
                i += 2;
            }
            out += utf8(cu);
        }
        return out;
    }

    /* Index just past a terminator for the given text encoding. */
    function skipTerminated(data, i, enc) {
        if (enc === 1 || enc === 2) {
            for (; i + 1 < data.length; i += 2) if (data.charCodeAt(i) === 0 && data.charCodeAt(i + 1) === 0) return i + 2;
            return data.length;
        }
        var z = data.indexOf('\x00', i);
        return z === -1 ? data.length : z + 1;
    }

    function read(path) {
        var f = new File(path);
        if (!f.open('rb')) return null;
        try {
            var head = f.read(10);
            if (head.length < 10 || head.substr(0, 3) !== 'ID3') return null;
            var ver = u8(head, 3), flags = u8(head, 5), size = syncsafe(head, 6);
            if (ver < 2 || ver > 4 || size <= 0 || size > MAX_TAG) return null;
            var tag = f.read(size);
        } finally {
            f.close();
        }

        var pos = 0;
        if ((flags & 0x40) && ver >= 3) pos = ver === 4 ? syncsafe(tag, 0) : be32(tag, 0) + 4;
        var unsync = (flags & 0x80) !== 0;
        var idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
        var out = { title: '', artist: '', album: '', year: '', art: null };
        var NAMES = ver === 2
            ? { TT2: 'title', TP1: 'artist', TAL: 'album', TYE: 'year' }
            : { TIT2: 'title', TPE1: 'artist', TALB: 'album', TYER: 'year', TDRC: 'year' };

        while (pos + hdrLen <= tag.length) {
            var id = tag.substr(pos, idLen);
            if (!/^[A-Z0-9]+$/.test(id)) break;               // padding
            var fsize = ver === 2 ? be24(tag, pos + 3) : (ver === 4 ? syncsafe(tag, pos + 4) : be32(tag, pos + 4));
            var start = pos + hdrLen;
            if (fsize <= 0 || start + fsize > tag.length) break;
            var data = tag.substr(start, fsize);

            if (NAMES[id] && !out[NAMES[id]]) {
                out[NAMES[id]] = text(data).replace(/^\s+|\s+$/g, '');
            } else if ((id === 'APIC' || id === 'PIC') && !unsync) {
                var enc = u8(data, 0), i = 1, mime;
                if (id === 'PIC') {
                    var fmt = data.substr(1, 3).toLowerCase();
                    mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
                    i = 4;
                } else {
                    var z = data.indexOf('\x00', 1);
                    mime = (z === -1 ? '' : data.substring(1, z)).toLowerCase() || 'image/jpeg';
                    if (mime.indexOf('/') === -1) mime = 'image/' + (mime === 'png' ? 'png' : 'jpeg');
                    i = z + 1;
                }
                var ptype = u8(data, i);
                i = skipTerminated(data, i + 1, enc);
                if (i < data.length && (!out.art || ptype === 3 && out.art.type !== 3)) {
                    out.art = { offset: 10 + start + i, length: data.length - i, mime: mime, type: ptype };
                }
            }
            pos = start + fsize;
        }
        return out;
    }

    return { read: read };
})();

this;
