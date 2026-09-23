/* link-preview.js — server-side OpenGraph metadata fetcher for web chat.
 *
 * getPreview(url, options) fetches a remote page and returns
 *   { url, finalUrl, kind, title, description, image, siteName }
 * or { error } — parsed from OpenGraph / twitter-card meta tags with
 * <title>/description fallbacks (the de-facto link-embed format).
 *
 * Every fetch is guarded against SSRF: only http(s) on default ports, no
 * userinfo, and the target host must resolve to a PUBLIC address — checked
 * again on every redirect hop (redirects are followed manually for exactly
 * this reason; a public page must not be able to bounce the BBS into
 * 127.0.0.1 or the LAN). Results are cached on disk so a busy channel does
 * not hammer remote sites: 24h for successes, 1h for failures.
 *
 * Strings are returned RAW (entity-decoded text) — the web client escapes
 * them at render time. Callers must not write them into HTML unescaped.
 *
 * Known limitation: http.js buffers the whole response before we can look at
 * it. A Range header asks for the first 256KB and best-effort mitigates
 * hostile payload sizes; servers that ignore Range are bounded only by the
 * receive timeout. Parsing always caps at the first 192KB.
 */

var linkPreview = (function () {
    'use strict';

    var MAX_URL_LENGTH = 2048;
    var MAX_REDIRECTS = 3;
    var RECV_TIMEOUT_SECONDS = 8;
    var PARSE_CAP_BYTES = 192 * 1024;
    var RANGE_HEADER = 'Range: bytes=0-262143';
    var CACHE_OK_SECONDS = 24 * 60 * 60;
    var CACHE_FAIL_SECONDS = 60 * 60;
    var TITLE_CAP = 200;
    var DESCRIPTION_CAP = 300;
    var SITE_NAME_CAP = 80;

    /* ------------------------------------------------------ URL handling */

    function parseUrl(url) {
        var match = /^(https?):\/\/([^/?#]+)((?:[/?#]).*)?$/i.exec(String(url || ''));
        var authority;
        var host;
        var port = null;
        var portMatch;
        if (!match) return null;
        authority = match[2];
        if (authority.indexOf('@') !== -1) return null;   /* no userinfo tricks */
        host = authority;
        portMatch = /^(.*):(\d+)$/.exec(authority);
        if (portMatch) {
            host = portMatch[1];
            port = parseInt(portMatch[2], 10);
        }
        if (!host.length) return null;
        return {
            scheme: match[1].toLowerCase(),
            host: host.toLowerCase(),
            port: port,
            rest: match[3] || '/'
        };
    }

    function validateTarget(url) {
        var parsed;
        if (!url || String(url).length > MAX_URL_LENGTH) return { ok: false, error: 'invalid url' };
        parsed = parseUrl(url);
        if (!parsed) return { ok: false, error: 'invalid url' };
        if (parsed.port !== null && parsed.port !== 80 && parsed.port !== 443) {
            return { ok: false, error: 'port not allowed' };
        }
        return { ok: true, host: parsed.host };
    }

    /* Resolve `ref` against `base` (absolute, protocol-relative, root- and
       path-relative forms). Enough for Location headers and og:image. */
    function resolveUrl(ref, base) {
        var parsed;
        var origin;
        var dir;
        ref = String(ref || '').replace(/^\s+|\s+$/g, '');
        if (!ref.length) return null;
        if (/^https?:\/\//i.test(ref)) return ref;
        /* Any other explicit scheme (javascript:, data:, ftp:...) must never
           be laundered into an http URL by the relative-path branch. */
        if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return null;
        parsed = parseUrl(base);
        if (!parsed) return null;
        origin = parsed.scheme + '://' + parsed.host + (parsed.port !== null ? ':' + parsed.port : '');
        if (/^\/\//.test(ref)) return parsed.scheme + ':' + ref;
        if (/^\//.test(ref)) return origin + ref;
        dir = parsed.rest.replace(/[?#].*$/, '');
        dir = dir.substring(0, dir.lastIndexOf('/') + 1) || '/';
        return origin + dir + ref;
    }

    /* -------------------------------------------------------- SSRF guard */

    function isPrivateIpv4(ip) {
        var parts = ip.split('.');
        var a;
        var b;
        if (parts.length !== 4) return true;   /* malformed: treat as unsafe */
        a = parseInt(parts[0], 10);
        b = parseInt(parts[1], 10);
        if (isNaN(a) || isNaN(b)) return true;
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;        /* CGNAT */
        if (a === 169 && b === 254) return true;                  /* link-local */
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 192 && b === 0) return true;                    /* 192.0.0/24 + 192.0.2/24 doc */
        if (a === 198 && (b === 18 || b === 19)) return true;     /* benchmarking */
        if (a === 198 && b === 51) return true;                   /* 198.51.100/24 doc */
        if (a === 203 && b === 0) return true;                    /* 203.0.113/24 doc */
        if (a >= 224) return true;                                /* multicast/reserved/broadcast */
        return false;
    }

    function isPrivateAddress(ip) {
        var value = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
        var mapped;
        if (!value.length) return true;
        if (value.indexOf(':') === -1) return isPrivateIpv4(value);
        if (value === '::' || value === '::1') return true;
        mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
        if (mapped) return isPrivateIpv4(mapped[1]);
        if (/^f[cd]/.test(value)) return true;                    /* fc00::/7 unique-local */
        if (/^fe[89ab]/.test(value)) return true;                 /* fe80::/10 link-local */
        return false;
    }

    /* The host itself may be an IP literal; otherwise resolve it. Returns
       null when the host is acceptable, else an error string. */
    function checkHostPublic(host) {
        var target = host;
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(host) && host.indexOf(':') === -1) {
            try { target = resolve_ip(host); } catch (_e) { target = null; }
            if (!target) return 'unresolvable host';
        }
        if (isPrivateAddress(target)) return 'address not allowed';
        return null;
    }

    /* --------------------------------------------------- metadata parsing */

    /* Everything in this lib stays "UTF-8 bytes carried in a JS string":
       that is how HTTPRequest delivers page bodies, and it is the only form
       Synchronet's byte-oriented write()/File.write round-trip losslessly.
       Numeric entities therefore decode to UTF-8 byte sequences, never to
       raw JS codepoints above 0xff. */
    function codepointToUtf8(code) {
        if (code < 0x80) return String.fromCharCode(code);
        if (code < 0x800) {
            return String.fromCharCode(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        }
        if (code < 0x10000) {
            return String.fromCharCode(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
        return String.fromCharCode(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
            0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }

    function decodeEntities(text) {
        return String(text || '')
            .replace(/&#x([0-9a-f]+);/gi, function (_m, hex) {
                var code = parseInt(hex, 16);
                return code > 0 && code < 0x110000 ? codepointToUtf8(code) : '';
            })
            .replace(/&#(\d+);/g, function (_m, dec) {
                var code = parseInt(dec, 10);
                return code > 0 && code < 0x110000 ? codepointToUtf8(code) : '';
            })
            .replace(/&nbsp;/gi, ' ')
            .replace(/&quot;/gi, '"')
            .replace(/&apos;/gi, "'")
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&amp;/gi, '&');
    }

    /* A length cap may slice a multi-byte UTF-8 sequence; drop the partial
       tail so the string stays valid. */
    function trimUtf8End(value) {
        var end = value.length;
        var lead;
        while (end > 0 && (value.charCodeAt(end - 1) & 0xc0) === 0x80) end--;
        if (end > 0) {
            lead = value.charCodeAt(end - 1);
            /* A lead byte with its full sequence present keeps its place. */
            if (lead >= 0xc0) {
                var expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
                if (end - 1 + expected <= value.length) end = end - 1 + expected;
                else end--;
            }
        }
        return value.substring(0, end);
    }

    var UTF8_ELLIPSIS = '\xe2\x80\xa6';

    function cleanText(text, cap) {
        var value = decodeEntities(text)
            .replace(/[\x00-\x1f\x7f]/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/^\s+|\s+$/g, '');
        if (value.length <= cap) return value;
        return trimUtf8End(value.substring(0, cap - UTF8_ELLIPSIS.length)) + UTF8_ELLIPSIS;
    }

    function attrFromTag(tag, name) {
        var match = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag);
        if (!match) return null;
        if (match[1] !== undefined) return match[1];
        if (match[2] !== undefined) return match[2];
        return match[3];
    }

    /* Pull OpenGraph/twitter/title metadata out of an HTML prefix. */
    function parseMetadata(html, baseUrl) {
        var source = String(html || '').substring(0, PARSE_CAP_BYTES);
        var tags = source.match(/<meta\b[^>]*>/gi) || [];
        var meta = {};
        var titleMatch;
        var image;
        tags.forEach(function (tag) {
            var key = attrFromTag(tag, 'property') || attrFromTag(tag, 'name');
            var content = attrFromTag(tag, 'content');
            if (!key || content === null) return;
            key = key.toLowerCase();
            if (meta[key] === undefined) meta[key] = content;
        });
        titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(source);
        image = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || '';
        image = image.length ? resolveUrl(image, baseUrl) : null;
        if (image && !/^https?:\/\//i.test(image)) image = null;
        return {
            title: cleanText(meta['og:title'] || meta['twitter:title'] || (titleMatch ? titleMatch[1] : ''), TITLE_CAP),
            description: cleanText(meta['og:description'] || meta['twitter:description'] || meta.description || '', DESCRIPTION_CAP),
            image: image || '',
            siteName: cleanText(meta['og:site_name'] || '', SITE_NAME_CAP)
        };
    }

    /* ------------------------------------------------------------ fetch */

    function fetchGuarded(url) {
        var currentUrl = String(url);
        var hop;
        var check;
        var hostError;
        var request;
        var body;
        var code;
        var contentType;
        var location;
        for (hop = 0; hop <= MAX_REDIRECTS; hop++) {
            check = validateTarget(currentUrl);
            if (!check.ok) return { error: check.error };
            hostError = checkHostPublic(check.host);
            if (hostError) return { error: hostError };
            request = new HTTPRequest(undefined, undefined,
                [RANGE_HEADER, 'Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'],
                RECV_TIMEOUT_SECONDS);
            try {
                body = request.Get(currentUrl);
            } catch (fetchError) {
                return { error: 'fetch failed' };
            }
            code = request.response_code || 0;
            if (code >= 300 && code < 400) {
                location = request.response_headers_parsed &&
                    request.response_headers_parsed.location &&
                    request.response_headers_parsed.location[0];
                if (!location) return { error: 'bad redirect' };
                currentUrl = resolveUrl(location, currentUrl);
                if (!currentUrl) return { error: 'bad redirect' };
                continue;   /* next hop re-runs the full guard */
            }
            if (code !== 200 && code !== 206) return { error: 'http ' + code };
            contentType = (request.response_headers_parsed &&
                request.response_headers_parsed['content-type'] &&
                request.response_headers_parsed['content-type'][0] || '').toLowerCase();
            return { finalUrl: currentUrl, body: body || '', contentType: contentType };
        }
        return { error: 'too many redirects' };
    }

    /* ------------------------------------------------------------ cache */

    function cacheKey(url) {
        if (typeof md5_calc === 'function') return md5_calc(String(url), false);
        /* md5_calc should always exist under Synchronet; degrade to a crude
           accumulator rather than failing previews outright. */
        var hash = 0;
        var i;
        for (i = 0; i < url.length; i++) hash = ((hash * 31) + url.charCodeAt(i)) >>> 0;
        return 'h' + hash.toString(16) + '_' + url.length;
    }

    function readCache(dir, key) {
        var path = dir + key + '.json';
        var file;
        var raw;
        var parsed;
        if (!dir || !file_exists(path)) return null;
        file = new File(path);
        if (!file.open('r')) return null;
        try { raw = file.read(); } finally { file.close(); }
        try { parsed = JSON.parse(raw); } catch (_e) { return null; }
        if (!parsed || typeof parsed.fetched !== 'number') return null;
        if (time() - parsed.fetched > (parsed.data && !parsed.data.error ? CACHE_OK_SECONDS : CACHE_FAIL_SECONDS)) return null;
        return parsed.data || null;
    }

    function writeCache(dir, key, data) {
        var file;
        if (!dir) return;
        if (!file_isdir(dir)) mkpath(dir);
        file = new File(dir + key + '.json');
        if (!file.open('w')) return;
        try { file.write(JSON.stringify({ fetched: time(), data: data })); }
        finally { file.close(); }
    }

    /* ------------------------------------------------------------ public */

    function urlBasename(url) {
        var path = String(url || '').replace(/^https?:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
        var segments = path.split('/');
        return segments[segments.length - 1] || '';
    }

    function getPreview(url, options) {
        var opts = options || {};
        var key;
        var cached;
        var fetched;
        var meta;
        var result;
        var check = validateTarget(url);
        if (!check.ok) return { error: check.error };
        key = cacheKey(url);
        cached = opts.cacheDir ? readCache(opts.cacheDir, key) : null;
        if (cached) return cached;
        fetched = fetchGuarded(url);
        if (fetched.error) {
            result = { error: fetched.error };
        } else if (fetched.contentType.indexOf('image/') === 0) {
            result = {
                url: url, finalUrl: fetched.finalUrl, kind: 'image',
                title: urlBasename(fetched.finalUrl), description: '',
                image: fetched.finalUrl, siteName: ''
            };
        } else if (fetched.contentType.indexOf('text/html') !== 0 &&
                   fetched.contentType.indexOf('application/xhtml') !== 0) {
            result = { error: 'not html' };
        } else {
            meta = parseMetadata(fetched.body, fetched.finalUrl);
            if (!meta.title.length && !meta.description.length && !meta.image) {
                result = { error: 'no metadata' };
            } else {
                result = {
                    url: url, finalUrl: fetched.finalUrl, kind: 'site',
                    title: meta.title, description: meta.description,
                    image: meta.image, siteName: meta.siteName
                };
            }
        }
        if (opts.cacheDir) writeCache(opts.cacheDir, key, result);
        return result;
    }

    return {
        parseUrl: parseUrl,
        validateTarget: validateTarget,
        resolveUrl: resolveUrl,
        isPrivateAddress: isPrivateAddress,
        checkHostPublic: checkHostPublic,
        parseMetadata: parseMetadata,
        decodeEntities: decodeEntities,
        getPreview: getPreview
    };
})();

linkPreview;
