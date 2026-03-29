// Oneliners API – read and post one-liners via the JSON DB service
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
load('json-client.js');

var reply = {};
var olSettings;
var OL_TERMINAL_COLUMNS = 80;
var OL_TERMINAL_PADDING = 3;
var OL_MAX_RAW_LENGTH = 512;

function getVisibleOnelinerText(text) {
    var i = 0;
    var out = '';

    while (i < text.length) {
        var ch = text.charCodeAt(i);
        if (ch === 1 && i + 1 < text.length) {
            i += 2;
            continue;
        }
        if (text.charAt(i) === '|' && i + 2 < text.length &&
            text.charAt(i + 1) >= '0' && text.charAt(i + 1) <= '9' &&
            text.charAt(i + 2) >= '0' && text.charAt(i + 2) <= '9') {
            i += 3;
            continue;
        }
        if (ch >= 32) {
            out += text.charAt(i);
        }
        i++;
    }

    return out;
}

function getVisibleOnelinerLength(text) {
    return getVisibleOnelinerText(text).length;
}

function truncateOnelinerToVisibleLength(text, maxVisible) {
    var i = 0;
    var visible = 0;
    var out = '';

    while (i < text.length) {
        var ch = text.charCodeAt(i);
        if (ch === 1 && i + 1 < text.length) {
            out += text.substring(i, i + 2);
            i += 2;
            continue;
        }
        if (text.charAt(i) === '|' && i + 2 < text.length &&
            text.charAt(i + 1) >= '0' && text.charAt(i + 1) <= '9' &&
            text.charAt(i + 2) >= '0' && text.charAt(i + 2) <= '9') {
            out += text.substring(i, i + 3);
            i += 3;
            continue;
        }
        if (ch >= 32) {
            if (visible >= maxVisible) {
                break;
            }
            visible++;
        }
        out += text.charAt(i);
        i++;
    }

    return out;
}

function getPostVisibleLimit() {
    return Math.max(1, OL_TERMINAL_COLUMNS - user.alias.length - system.qwk_id.length - OL_TERMINAL_PADDING);
}

// Load oneliners settings (server/port for JSON DB)
try {
    var sf = new File(system.exec_dir + '../xtrn/oneliners/settings.ini');
    sf.open('r');
    olSettings = sf.iniGetObject();
    sf.close();
} catch (e) {
    olSettings = { server: 'localhost', port: 10088 };
}

http_reply.header['Content-Type'] = 'application/json';

if (typeof http_request.query.call === 'undefined') {
    write(JSON.stringify({ error: 'no call' }));
} else {
    var call = http_request.query.call[0];

    switch (call) {

        case 'get-oneliners': {
            var count = 50;
            var offset = 0;
            if (typeof http_request.query.count !== 'undefined') {
                count = Math.min(parseInt(http_request.query.count[0], 10) || 50, 100);
            }
            if (typeof http_request.query.offset !== 'undefined') {
                offset = Math.max(parseInt(http_request.query.offset[0], 10) || 0, 0);
            }
            try {
                var jc = new JSONClient(olSettings.server, olSettings.port);
                var total = jc.read('ONELINERS', 'ONELINERS.length', 1) || 0;
                var end = Math.max(0, total - offset);
                var start = Math.max(0, end - count);
                var lines = [];
                if (end > start) {
                    lines = jc.slice('ONELINERS', 'ONELINERS', start, end, 1) || [];
                }
                jc.disconnect();

                var result = [];
                for (var i = 0; i < lines.length; i++) {
                    var ln = lines[i];
                    if (!ln || typeof ln.oneliner !== 'string') continue;
                    if (typeof ln.alias !== 'string' || typeof ln.qwkid !== 'string') continue;
                    result.push({
                        time: ln.time || 0,
                        alias: ln.alias,
                        qwkid: ln.qwkid,
                        systemName: ln.systemName || '',
                        oneliner: ln.oneliner
                    });
                }
                reply = {
                    oneliners: result,
                    qwkid: system.qwk_id.toLowerCase(),
                    total: total,
                    hasMore: start > 0,
                    nextOffset: offset + (end - start)
                };
            } catch (e) {
                log(LOG_ERR, 'oneliners API get error: ' + e);
                reply = { error: String(e) };
            }
            break;
        }

        case 'post-oneliner': {
            if (user.number < 1 || user.alias === settings.guest) {
                reply = { error: 'not authenticated' };
                break;
            }
            var visibleLimit = getPostVisibleLimit();
            var text = '';
            if (http_request.method === 'POST' && typeof http_request.body !== 'undefined') {
                var params = http_request.body.split('&');
                for (var p = 0; p < params.length; p++) {
                    var kv = params[p].split('=');
                    if (decodeURIComponent(kv[0]) === 'oneliner') {
                        text = decodeURIComponent(kv.slice(1).join('=').replace(/\+/g, ' '));
                    }
                }
            }
            if (!text && typeof http_request.query.oneliner !== 'undefined') {
                text = http_request.query.oneliner[0];
            }
            if (!text || !text.length) {
                reply = { error: 'empty oneliner' };
                break;
            }
            if (text.length > OL_MAX_RAW_LENGTH) {
                text = text.substring(0, OL_MAX_RAW_LENGTH);
            }
            if (!getVisibleOnelinerText(text).trim().length) {
                reply = { error: 'empty oneliner' };
                break;
            }
            if (getVisibleOnelinerLength(text) > visibleLimit) {
                reply = { error: 'one-liner exceeds ' + visibleLimit + ' visible characters' };
                break;
            }
            text = truncateOnelinerToVisibleLength(text, visibleLimit);
            try {
                var jc = new JSONClient(olSettings.server, olSettings.port);
                var obj = {
                    time: time(),
                    client: (typeof client !== 'undefined') ? client.ip_address : system.inet_addr,
                    alias: user.alias,
                    systemName: system.name,
                    systemHost: system.inet_addr,
                    qwkid: system.qwk_id.toLowerCase(),
                    oneliner: text
                };
                jc.push('ONELINERS', 'ONELINERS', obj, 2);
                jc.disconnect();
                reply = { ok: true, oneliner: {
                    time: obj.time,
                    alias: obj.alias,
                    qwkid: obj.qwkid,
                    systemName: obj.systemName,
                    oneliner: obj.oneliner
                }};
            } catch (e) {
                log(LOG_ERR, 'oneliners API post error: ' + e);
                reply = { error: String(e) };
            }
            break;
        }

        default:
            reply = { error: 'unknown call' };
            break;
    }

    write(JSON.stringify(reply));
}
