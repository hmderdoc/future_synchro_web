/* id3parser.js - Lightweight ID3v2 tag parser for browser
 *
 * Parses ID3v2.3/v2.4 frames from an ArrayBuffer (first ~128KB of an MP3).
 * Extracts: APIC (album art), SYLT (synchronized lyrics), plus text frames
 * (TIT2, TPE1, TCOM, TCON, TDRC/TYER, TALB).
 *
 * Usage:
 *   var tags = window.parseID3v2(arrayBuffer);
 *   tags.artist   // string or ''
 *   tags.title    // string or ''
 *   tags.composer // string or ''
 *   tags.genre    // string or ''
 *   tags.year     // string or ''
 *   tags.album    // string or ''
 *   tags.picture  // { mime: 'image/jpeg', blob: Blob } or null
 *   tags.sylt     // [{time: seconds, text: ''}, ...] or []
 */
(function () {
    'use strict';

    /* Read a synchsafe integer (ID3v2.4 sizes) */
    function synchsafe(b, off) {
        return ((b[off] & 0x7F) << 21) |
               ((b[off+1] & 0x7F) << 14) |
               ((b[off+2] & 0x7F) << 7)  |
                (b[off+3] & 0x7F);
    }

    /* Read a regular big-endian 32-bit int (ID3v2.3 frame sizes) */
    function bigEndian32(b, off) {
        return (b[off] << 24) | (b[off+1] << 16) | (b[off+2] << 8) | b[off+3];
    }

    /* Decode a text frame payload (handles encoding byte) */
    function decodeText(bytes, start, end) {
        if (start >= end) return '';
        var enc = bytes[start];
        var data = bytes.subarray(start + 1, end);

        if (enc === 0) {
            // ISO-8859-1
            var s = '';
            for (var i = 0; i < data.length; i++) {
                if (data[i] === 0) break;
                s += String.fromCharCode(data[i]);
            }
            return s;
        } else if (enc === 1 || enc === 2) {
            // UTF-16 (BOM or BE)
            var bom = (data.length >= 2 && data[0] === 0xFF && data[1] === 0xFE) ? 'le'
                    : (data.length >= 2 && data[0] === 0xFE && data[1] === 0xFF) ? 'be' : 'le';
            var offset = (data.length >= 2 && (data[0] === 0xFF || data[0] === 0xFE)) ? 2 : 0;
            var decoder = new TextDecoder(bom === 'le' ? 'utf-16le' : 'utf-16be');
            var txt = decoder.decode(data.subarray(offset));
            // Strip null terminators
            var nul = txt.indexOf('\0');
            return nul >= 0 ? txt.substring(0, nul) : txt;
        } else if (enc === 3) {
            // UTF-8
            var decoder8 = new TextDecoder('utf-8');
            var txt8 = decoder8.decode(data);
            var nul8 = txt8.indexOf('\0');
            return nul8 >= 0 ? txt8.substring(0, nul8) : txt8;
        }
        return '';
    }

    /* Find a null terminator in a byte array for a given encoding */
    function findNull(bytes, start, enc) {
        if (enc === 1 || enc === 2) {
            // UTF-16: null is two zero bytes (aligned)
            for (var i = start; i < bytes.length - 1; i += 2) {
                if (bytes[i] === 0 && bytes[i+1] === 0) return i;
            }
            return bytes.length;
        }
        // ISO-8859-1 or UTF-8
        for (var j = start; j < bytes.length; j++) {
            if (bytes[j] === 0) return j;
        }
        return bytes.length;
    }

    /* Parse APIC (attached picture) frame */
    function parseAPIC(bytes) {
        if (bytes.length < 4) return null;
        var enc = bytes[0];
        // MIME type (always ISO-8859-1 terminated by 0x00)
        var mimeEnd = findNull(bytes, 1, 0);
        var mime = '';
        for (var i = 1; i < mimeEnd; i++) mime += String.fromCharCode(bytes[i]);
        if (!mime) mime = 'image/jpeg';
        // Picture type (1 byte) - skip it
        var picDataStart = mimeEnd + 2; // +1 null, +1 picture type
        // Description (terminated string in the given encoding)
        var descEnd = findNull(bytes, picDataStart, enc);
        var imgStart = descEnd + (enc === 1 || enc === 2 ? 2 : 1);
        if (imgStart >= bytes.length) return null;

        var blob = new Blob([bytes.subarray(imgStart)], { type: mime });
        return { mime: mime, blob: blob };
    }

    /* Parse SYLT (synchronized lyrics) frame
     * Returns array of {time: seconds, text: string}
     */
    function parseSYLT(bytes) {
        if (bytes.length < 6) return [];
        var enc = bytes[0];
        // bytes[1..3] = language (3 chars), skip
        var timestampFormat = bytes[4]; // 1=MPEG frames, 2=milliseconds
        // bytes[5] = content type, skip
        // bytes[6..] = content descriptor (null-terminated), then sync data
        var pos = 6;
        // Skip content descriptor
        var descEnd = findNull(bytes, pos, enc);
        pos = descEnd + (enc === 1 || enc === 2 ? 2 : 1);

        var result = [];
        while (pos < bytes.length - 4) {
            // Read text until null
            var textEnd = findNull(bytes, pos, enc);
            var text = '';
            if (enc === 0) {
                for (var i = pos; i < textEnd; i++) text += String.fromCharCode(bytes[i]);
            } else if (enc === 1 || enc === 2) {
                var bom2 = (textEnd - pos >= 2 && bytes[pos] === 0xFF && bytes[pos+1] === 0xFE) ? 'le' : 'be';
                var skip = (textEnd - pos >= 2 && (bytes[pos] === 0xFF || bytes[pos] === 0xFE)) ? 2 : 0;
                var dec = new TextDecoder(bom2 === 'le' ? 'utf-16le' : 'utf-16be');
                text = dec.decode(bytes.subarray(pos + skip, textEnd));
            } else if (enc === 3) {
                text = new TextDecoder('utf-8').decode(bytes.subarray(pos, textEnd));
            }
            pos = textEnd + (enc === 1 || enc === 2 ? 2 : 1);

            // Read 4-byte timestamp
            if (pos + 4 > bytes.length) break;
            var ts = bigEndian32(bytes, pos);
            pos += 4;

            // Convert to seconds
            var timeSec = (timestampFormat === 2) ? ts / 1000 : ts / 38.46; // ~38.46 frames/sec for 44.1kHz

            text = text.trim();
            if (text) result.push({ time: timeSec, text: text });
        }
        return result.sort(function (a, b) { return a.time - b.time; });
    }

    /* Main parser */
    function parseID3v2(buffer) {
        var result = {
            title: '', artist: '', composer: '', genre: '',
            year: '', album: '', picture: null, sylt: []
        };

        var bytes = new Uint8Array(buffer);
        // Check ID3v2 header: "ID3"
        if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
            return result;
        }

        var majorVer = bytes[3]; // 3 or 4
        // var minorVer = bytes[4];
        var flags = bytes[5];
        var tagSize = synchsafe(bytes, 6);

        // Extended header?
        var pos = 10;
        if (flags & 0x40) {
            // Skip extended header
            var extSize = (majorVer >= 4) ? synchsafe(bytes, pos) : bigEndian32(bytes, pos);
            pos += extSize;
        }

        var tagEnd = Math.min(10 + tagSize, bytes.length);
        var frameSizeReader = (majorVer >= 4) ? synchsafe : bigEndian32;

        // Text frame IDs we care about
        var TEXT_FRAMES = {
            'TIT2': 'title',
            'TPE1': 'artist',
            'TCOM': 'composer',
            'TCON': 'genre',
            'TDRC': 'year',     // v2.4
            'TYER': 'year',     // v2.3
            'TALB': 'album'
        };

        while (pos + 10 <= tagEnd) {
            // Frame header: 4-char ID, 4-byte size, 2-byte flags
            var frameId = String.fromCharCode(bytes[pos], bytes[pos+1], bytes[pos+2], bytes[pos+3]);
            if (frameId[0] === '\0') break; // Padding reached

            var frameSize = frameSizeReader(bytes, pos + 4);
            var frameFlags = (bytes[pos + 8] << 8) | bytes[pos + 9];
            pos += 10;

            if (frameSize <= 0 || pos + frameSize > tagEnd) break;

            var frameData = bytes.subarray(pos, pos + frameSize);

            if (TEXT_FRAMES[frameId]) {
                result[TEXT_FRAMES[frameId]] = decodeText(bytes, pos, pos + frameSize);
            } else if (frameId === 'APIC') {
                result.picture = parseAPIC(frameData);
            } else if (frameId === 'SYLT') {
                result.sylt = parseSYLT(frameData);
            }

            pos += frameSize;
        }

        // Clean up genre: ID3v1 numeric genre in parens e.g. "(17)"
        if (result.genre && /^\(\d+\)/.test(result.genre)) {
            var genreNum = parseInt(result.genre.replace(/[()]/g, ''), 10);
            result.genre = ID3V1_GENRES[genreNum] || result.genre;
        }

        return result;
    }

    // Common ID3v1 genres (subset)
    var ID3V1_GENRES = [
        'Blues','Classic Rock','Country','Dance','Disco','Funk','Grunge',
        'Hip-Hop','Jazz','Metal','New Age','Oldies','Other','Pop','R&B',
        'Rap','Reggae','Rock','Techno','Industrial','Alternative','Ska',
        'Death Metal','Pranks','Soundtrack','Euro-Techno','Ambient',
        'Trip-Hop','Vocal','Jazz+Funk','Fusion','Trance','Classical',
        'Instrumental','Acid','House','Game','Sound Clip','Gospel','Noise',
        'AlternRock','Bass','Soul','Punk','Space','Meditative',
        'Instrumental Pop','Instrumental Rock','Ethnic','Gothic',
        'Darkwave','Techno-Industrial','Electronic','Pop-Folk','Eurodance',
        'Dream','Southern Rock','Comedy','Cult','Gangsta','Top 40',
        'Christian Rap','Pop/Funk','Jungle','Native American','Cabaret',
        'New Wave','Psychedelic','Rave','Showtunes','Trailer','Lo-Fi',
        'Tribal','Acid Punk','Acid Jazz','Polka','Retro','Musical',
        'Rock & Roll','Hard Rock'
    ];

    window.parseID3v2 = parseID3v2;
})();
