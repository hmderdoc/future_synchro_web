/* chat.js - SSE event module for JSON chat service bridge */

load('json-client.js');

var _host = '127.0.0.1';
var _port = 10088;
var _defaultChannel = 'main';
var _channel = _defaultChannel;
var _includeMailbox = false;
var _client = null;
var _publicSubscribed = false;
var _mailboxSubscribed = false;
var _lastCycle = 0;
var _frequency = 1;
var _reconnectDelay = 5;
var _lastReconnect = 0;
var _channelPath = '';
var _mailboxPath = '';

function trimText(value) {
    return String(value || '').replace(/^\s+|\s+$/g, '');
}

function sanitizeChannel(raw, fallback) {
    var channel = String(raw || fallback || _defaultChannel).replace(/[^a-zA-Z0-9_-]/g, '');
    return channel.length ? channel : (fallback || _defaultChannel);
}

function sanitizeAlias(raw) {
    return trimText(String(raw || '')).replace(/[\x00-\x1f]/g, '').substr(0, 60);
}

function normalizeUpper(value) {
    return trimText(value).toUpperCase();
}

function isRegisteredPublicChannel(client, channel) {
    /* Public subscriptions are allowlisted to channels explicitly registered as
       public rooms. Private mailboxes (channels.<alias>.*) are never registered,
       so a client can never subscribe to another user's mailbox as a "channel"
       and have their incoming DMs relayed back. */
    if (channel === _defaultChannel) {
        return true;
    }
    try {
        return client.read('chat', 'public_channels.' + channel, 1) === true;
    } catch (_registryError) {
        return false;
    }
}

function normalizeNick(nick) {
    if (!nick || typeof nick !== 'object') {
        return null;
    }

    var name = sanitizeAlias(nick.name);
    if (!name.length) {
        return null;
    }

    return {
        name: name,
        host: trimText(nick.host),
        qwkid: normalizeUpper(nick.qwkid),
        avatar: trimText(nick.avatar)
    };
}

function isPrivateMessage(message) {
    return !!(
        message &&
        message.private &&
        message.private.to &&
        sanitizeAlias(message.private.to.name).length
    );
}

function resolvePrivatePeerNick(message, ownAlias) {
    var sender = normalizeNick(message ? message.nick : null);
    var recipient = normalizeNick(message && message.private ? message.private.to : null);

    if (!sender || !recipient) {
        return null;
    }

    if (normalizeUpper(sender.name) === normalizeUpper(ownAlias)) {
        return recipient;
    }

    return sender;
}

if (typeof http_request !== 'undefined' && http_request.query && http_request.query.channel) {
    _channel = sanitizeChannel(http_request.query.channel[0], _defaultChannel);
}

if (
    typeof http_request !== 'undefined' &&
    http_request.query &&
    http_request.query.mailbox &&
    user &&
    user.number > 0
) {
    _includeMailbox = String(http_request.query.mailbox[0]) !== '0';
}

_channelPath = 'channels.' + _channel + '.messages';
_mailboxPath = _includeMailbox ? ('channels.' + user.alias + '.messages') : '';

function _connect() {
    if (user.number < 1) {
        return false;
    }
    try {
        _client = new JSONClient(_host, _port);

        /* Only ever subscribe to a registered public room as the public channel.
           If a non-public name was requested (e.g. another user's mailbox), fall
           back to the default room. The user's OWN mailbox is subscribed
           separately below, scoped to user.alias. */
        if (!isRegisteredPublicChannel(_client, _channel)) {
            _channel = _defaultChannel;
            _channelPath = 'channels.' + _channel + '.messages';
        }

        _client.subscribe('chat', _channelPath);
        _publicSubscribed = true;

        if (_mailboxPath.length) {
            _client.subscribe('chat', _mailboxPath);
            _mailboxSubscribed = true;
        }

        return true;
    } catch (e) {
        log(LOG_WARNING, 'chat event: connect failed: ' + e);
        _client = null;
        _publicSubscribed = false;
        _mailboxSubscribed = false;
        return false;
    }
}

function _disconnect() {
    if (!_client) {
        return;
    }

    try {
        if (_publicSubscribed) {
            _client.unsubscribe('chat', _channelPath);
        }
    } catch (_unsubscribePublicError) {}

    try {
        if (_mailboxSubscribed && _mailboxPath.length) {
            _client.unsubscribe('chat', _mailboxPath);
        }
    } catch (_unsubscribeMailboxError) {}

    try { _client.disconnect(); } catch (_disconnectError) {}
    _client = null;
    _publicSubscribed = false;
    _mailboxSubscribed = false;
}

function _processPublicUpdate(packet) {
    var oper = String(packet.oper).toUpperCase();
    var payload = packet.data || {};
    if (oper === 'WRITE' && isPrivateMessage(payload)) {
        return; /* never emit a private message on a public channel stream */
    }
    var nick = normalizeNick(payload.nick);
    var sender = nick && nick.name ? nick.name : '';
    var systemName = nick && nick.host ? nick.host : '';
    var userNumber = 0;
    var isSelf = false;

    if (sender.length) {
        try { userNumber = system.matchuser(sender) || 0; } catch (_matchError) {}
    }

    isSelf =
        user &&
        user.number > 0 &&
        normalizeUpper(sender) === normalizeUpper(user.alias) &&
        (!systemName.length || normalizeUpper(systemName) === normalizeUpper(system.name));

    if (oper === 'WRITE') {
        emit({
            event: 'chat',
            data: JSON.stringify({
                type: 'message',
                channel: _channel,
                sender: sender,
                system: systemName,
                text: payload.str || '',
                timestamp: payload.time || Date.now(),
                userNumber: userNumber,
                isSelf: isSelf,
                avatar: nick && nick.avatar ? String(nick.avatar) : undefined
            })
        });
        return;
    }

    if (oper === 'SUBSCRIBE' || oper === 'UNSUBSCRIBE') {
        emit({
            event: 'chat',
            data: JSON.stringify({
                type: oper === 'SUBSCRIBE' ? 'join' : 'part',
                channel: _channel,
                sender: sender,
                system: systemName,
                text: '',
                timestamp: Date.now()
            })
        });
    }
}

function _processPrivateUpdate(packet) {
    var oper = String(packet.oper).toUpperCase();
    var payload = packet.data || {};
    var nick = normalizeNick(payload.nick);
    var sender = nick && nick.name ? nick.name : '';
    var systemName = nick && nick.host ? nick.host : '';
    var userNumber = 0;
    var peer = null;
    var isSelf = false;

    if (oper !== 'WRITE' || !isPrivateMessage(payload)) {
        return;
    }

    if (sender.length) {
        try { userNumber = system.matchuser(sender) || 0; } catch (_matchError) {}
    }

    isSelf =
        user &&
        user.number > 0 &&
        normalizeUpper(sender) === normalizeUpper(user.alias) &&
        (!systemName.length || normalizeUpper(systemName) === normalizeUpper(system.name));

    peer = resolvePrivatePeerNick(payload, user.alias);

    emit({
        event: 'chat',
        data: JSON.stringify({
            type: 'private',
            sender: sender,
            system: systemName,
            text: payload.str || '',
            timestamp: payload.time || Date.now(),
            userNumber: userNumber,
            isSelf: isSelf,
            avatar: nick && nick.avatar ? String(nick.avatar) : undefined,
            peerName: peer && peer.name ? peer.name : sender,
            peerSystem: peer && peer.host ? peer.host : systemName,
            peerAvatar: peer && peer.avatar ? peer.avatar : (nick && nick.avatar ? String(nick.avatar) : undefined)
        })
    });
}

function _processUpdate(packet) {
    if (!packet || !packet.location || !packet.oper) {
        return;
    }

    if (packet.location === _channelPath) {
        _processPublicUpdate(packet);
        return;
    }

    if (_mailboxPath.length && packet.location === _mailboxPath) {
        _processPrivateUpdate(packet);
    }
}

function cycle() {
    var now = time();

    if (now - _lastCycle < _frequency) {
        return;
    }
    _lastCycle = now;

    if (!_client || !_client.connected) {
        _publicSubscribed = false;
        _mailboxSubscribed = false;
        if (now - _lastReconnect < _reconnectDelay) {
            return;
        }
        _lastReconnect = now;
        if (!_connect()) {
            return;
        }
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
