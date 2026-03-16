/* chat.js - SSE event module for JSON chat service bridge
 *
 * Connects to the Synchronet JSON service (TCP :10088) and subscribes to
 * chat channel messages.  New messages, join/part events are emitted as
 * Server-Sent Events consumed by the browser's EventSource.
 *
 * Loaded by events.ssjs when the browser requests ?subscribe=chat
 */

load('json-client.js');

var _host = '127.0.0.1';
var _port = 10088;
var _client = null;
var _subscribed = false;
var _lastCycle = 0;
var _frequency = 1;
var _reconnectDelay = 5;
var _lastReconnect = 0;
var _channel = 'main';

if (typeof http_request !== 'undefined' &&
    http_request.query && http_request.query.channel) {
    _channel = String(http_request.query.channel[0]).replace(/[^a-zA-Z0-9_-]/g, '');
}

var _channelPath = 'channels.' + _channel + '.messages';

function _connect() {
    try {
        _client = new JSONClient(_host, _port);
        _client.subscribe('chat', _channelPath);
        _subscribed = true;
        return true;
    } catch (e) {
        log(LOG_WARNING, 'chat event: connect failed: ' + e);
        _client = null;
        return false;
    }
}

function _disconnect() {
    if (_client) {
        try {
            if (_subscribed) _client.unsubscribe('chat', _channelPath);
        } catch (e) {}
        try { _client.disconnect(); } catch (e) {}
        _client = null;
        _subscribed = false;
    }
}

function _processUpdate(packet) {
    if (!packet || !packet.location || !packet.oper) return;

    var oper = String(packet.oper).toUpperCase();

    if (oper === 'WRITE') {
        var msg = packet.data;
        if (!msg) return;
        var senderName = msg.nick ? (msg.nick.name || '') : '';
        var userNum = 0;
        if (senderName) {
            try { userNum = system.matchuser(senderName) || 0; } catch(e) {}
        }
        emit({
            event: 'chat',
            data: JSON.stringify({
                type: 'message',
                sender: senderName,
                system: msg.nick ? (msg.nick.host || '') : '',
                text: msg.str || '',
                timestamp: msg.time || Date.now(),
                userNumber: userNum
            })
        });
    } else if (oper === 'SUBSCRIBE') {
        emit({
            event: 'chat',
            data: JSON.stringify({
                type: 'join',
                sender: packet.data ? (packet.data.nick || '') : '',
                text: '',
                timestamp: Date.now()
            })
        });
    } else if (oper === 'UNSUBSCRIBE') {
        emit({
            event: 'chat',
            data: JSON.stringify({
                type: 'part',
                sender: packet.data ? (packet.data.nick || '') : '',
                text: '',
                timestamp: Date.now()
            })
        });
    }
}

function cycle() {
    var now = time();

    if (now - _lastCycle < _frequency) return;
    _lastCycle = now;

    if (!_client || !_client.connected) {
        _subscribed = false;
        if (now - _lastReconnect < _reconnectDelay) return;
        _lastReconnect = now;
        if (!_connect()) return;
    }

    try {
        _client.cycle();
        while (_client.updates.length) {
            _processUpdate(_client.updates.shift());
        }
    } catch (e) {
        log(LOG_WARNING, 'chat event: cycle error: ' + e);
        _disconnect();
    }
}

js.on_exit('try { if (typeof _disconnect === "function") _disconnect(); } catch(e) {}');

this;
