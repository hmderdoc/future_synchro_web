// Oneliners API – read and post one-liners via the JSON DB service
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
load('json-client.js');

var reply = {};
var olSettings;

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
            if (typeof http_request.query.count !== 'undefined') {
                count = Math.min(parseInt(http_request.query.count[0], 10) || 50, 200);
            }
            try {
                var jc = new JSONClient(olSettings.server, olSettings.port);
                var total = jc.read('ONELINERS', 'ONELINERS.length', 1) || 0;
                var start = Math.max(0, total - count);
                var lines = jc.slice('ONELINERS', 'ONELINERS', start, undefined, 1) || [];
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
                reply = { oneliners: result, qwkid: system.qwk_id.toLowerCase() };
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
            if (text.length > 200) {
                text = text.substring(0, 200);
            }
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
