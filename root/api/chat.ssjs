/* chat.ssjs - REST API for JSON chat service
 *
 * Endpoints:
 *   GET  ?action=history&channel=main   - last N messages
 *   GET  ?action=who&channel=main       - subscriber list
 *   GET  ?action=channels               - available channels
 *   POST ?action=send                   - send a message (auth required)
 *       body: channel=main&message=hello
 */

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
var request = require({}, settings.web_lib + 'request.js', 'request');
load('json-client.js');

var _host = '127.0.0.1';
var _port = 10088;

http_reply.header['Content-Type'] = 'application/json';

var reply = { error: 'invalid request' };
var action = request.has_param('action') ? http_request.query.action[0] : '';

function getChannel() {
    var ch = request.has_param('channel') ? http_request.query.channel[0] : 'main';
    return String(ch).replace(/[^a-zA-Z0-9_-]/g, '') || 'main';
}

function withClient(fn) {
    var client = null;
    try {
        client = new JSONClient(_host, _port);
        var result = fn(client);
        client.disconnect();
        return result;
    } catch (e) {
        log(LOG_ERR, 'chat.ssjs: ' + e);
        if (client) try { client.disconnect(); } catch (ex) {}
        return { error: 'chat service error' };
    }
}

switch (action) {

    case 'history':
        var channel = getChannel();
        var count = 50;
        if (request.has_param('count')) {
            var c = parseInt(http_request.query.count[0], 10);
            if (!isNaN(c) && c > 0 && c <= 200) count = c;
        }
        reply = withClient(function (client) {
            var path = 'channels.' + channel + '.history';
            var history = client.slice('chat', path, -count, undefined, 1);
            var messages = [];
            if (Array.isArray(history)) {
                for (var i = 0; i < history.length; i++) {
                    var m = history[i];
                    if (!m) continue;
                    var senderName = m.nick ? (m.nick.name || '') : '';
                    var userNum = 0;
                    if (senderName) {
                        try { userNum = system.matchuser(senderName) || 0; } catch(e) {}
                    }
                    messages.push({
                        sender: senderName,
                        system: m.nick ? (m.nick.host || '') : '',
                        text: m.str || '',
                        timestamp: m.time || 0,
                        userNumber: userNum
                    });
                }
            }
            return { channel: channel, messages: messages };
        });
        break;

    case 'who':
        var channel = getChannel();
        reply = withClient(function (client) {
            var path = 'channels.' + channel + '.messages';
            var whoResult = client.who('chat', path);
            var users = [];
            if (whoResult && typeof whoResult === 'object') {
                for (var key in whoResult) {
                    if (!whoResult.hasOwnProperty(key)) continue;
                    var entry = whoResult[key];
                    var uNum = system.matchuser(entry.nick || key);
                    users.push({
                        nick: entry.nick || key,
                        system: entry.system || '',
                        userNumber: uNum || 0
                    });
                }
            }
            return { channel: channel, users: users };
        });
        break;

    case 'channels':
        reply = { channels: ['main'] };
        break;

    case 'send':
        if (http_request.method !== 'POST') {
            reply = { error: 'POST required' };
            break;
        }
        if (user.number < 1 || user.alias === settings.guest) {
            reply = { error: 'authentication required' };
            break;
        }
        var channel = getChannel();
        var message = '';
        if (request.has_param('message')) {
            message = String(http_request.query.message[0]);
        }
        if (!message || message.length === 0) {
            reply = { error: 'empty message' };
            break;
        }
        if (message.length > 1000) message = message.substr(0, 1000);
        message = message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

        reply = withClient(function (client) {
            var nick = {
                name: user.alias,
                host: system.name,
                ip: user.ip_address || '0.0.0.0'
            };
            var msg = {
                nick: nick,
                str: message,
                time: Date.now()
            };
            var chanPath = 'channels.' + channel;
            client.write('chat', chanPath + '.messages', msg, 2);
            client.push('chat', chanPath + '.history', msg, 2);
            return {
                success: true,
                timestamp: msg.time
            };
        });
        break;

    default:
        reply = { error: 'unknown action: ' + action };
        break;
}

writeln(JSON.stringify(reply));
