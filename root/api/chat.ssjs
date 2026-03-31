/* chat.ssjs - REST API for JSON chat service
 *
 * Endpoints:
 *   GET  ?action=history&channel=main             - public room history
 *   GET  ?action=who&channel=main                 - current public room subscribers
 *   GET  ?action=channels[&since=timestamp]       - public room summaries
 *   GET  ?action=motd[&channel=motd]               - latest MOTD message
 *   GET  ?action=motd[&channel=motd]               - latest MOTD message
 *   POST ?action=createChannel                    - initialize/register a public room
 *   POST ?action=send                             - send a public room message
 *   GET  ?action=private[&since=timestamp]        - private thread summaries (auth required)
 *   GET  ?action=privateHistory&target=Alias      - private thread history (auth required)
 *   POST ?action=sendPrivate                      - send a private message (auth required)
 */

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
var request = require({}, settings.web_lib + 'request.js', 'request');
load('json-client.js');

var _host = '127.0.0.1';
var _port = 10088;
var _defaultChannel = 'main';
var _maxHistory = 200;
var _writeTimeout = 5000;
var _bodyParams = null;

http_reply.header['Content-Type'] = 'application/json';

function trimText(value) {
    return String(value || '').replace(/^\s+|\s+$/g, '');
}

function normalizeUpper(value) {
    return trimText(value).toUpperCase();
}

function sanitizeChannel(raw, fallback) {
    var channel = String(raw || fallback || _defaultChannel).replace(/[^a-zA-Z0-9_-]/g, '');
    return channel.length ? channel : (fallback || _defaultChannel);
}

function sanitizeAlias(raw) {
    var alias = trimText(String(raw || ''));
    alias = alias.replace(/[\x00-\x1f]/g, '');
    return alias.substr(0, 60);
}

function getBodyParams() {
    var params = {};
    var pairs = [];
    var index = 0;
    var key = '';
    var value = '';
    var parts = [];

    if (_bodyParams !== null) {
        return _bodyParams;
    }

    _bodyParams = params;

    if (http_request.method !== 'POST' || typeof http_request.body !== 'string' || !http_request.body.length) {
        return _bodyParams;
    }

    pairs = http_request.body.split('&');
    for (index = 0; index < pairs.length; index += 1) {
        parts = pairs[index].split('=');
        key = decodeURIComponent(String(parts.shift() || '').replace(/\+/g, ' '));
        value = decodeURIComponent(String(parts.join('=') || '').replace(/\+/g, ' '));

        if (!key.length) {
            continue;
        }

        if (!Array.isArray(_bodyParams[key])) {
            _bodyParams[key] = [];
        }
        _bodyParams[key].push(value);
    }

    return _bodyParams;
}

function hasRequestParam(name) {
    return (
        (Array.isArray(http_request.query[name]) && http_request.query[name].length) ||
        (Array.isArray(getBodyParams()[name]) && getBodyParams()[name].length)
    );
}

function getRequestValue(name, fallback) {
    if (Array.isArray(http_request.query[name]) && http_request.query[name].length) {
        return String(http_request.query[name][0]);
    }

    if (Array.isArray(getBodyParams()[name]) && getBodyParams()[name].length) {
        return String(getBodyParams()[name][0]);
    }

    return typeof fallback === 'undefined' ? '' : String(fallback);
}

function getChannel() {
    var raw = hasRequestParam('channel') ? getRequestValue('channel', _defaultChannel) : _defaultChannel;
    return sanitizeChannel(raw, _defaultChannel);
}

function getRequestText(name) {
    return hasRequestParam(name) ? getRequestValue(name, '') : '';
}

function getRequestTimestamp(name) {
    var raw = getRequestText(name);
    var parsed = parseInt(raw, 10);
    return isNaN(parsed) || parsed < 1 ? 0 : parsed;
}

function getKeys(result) {
    var keys = [];
    var key;

    if (Array.isArray(result)) {
        return result;
    }

    if (!result || typeof result !== 'object') {
        return keys;
    }

    for (key in result) {
        if (Object.prototype.hasOwnProperty.call(result, key)) {
            keys.push(key);
        }
    }

    return keys;
}

function withClient(fn) {
    var client = null;
    try {
        client = new JSONClient(_host, _port);
        client.settings.TIMEOUT = _writeTimeout;
        var result = fn(client);
        client.disconnect();
        return result;
    } catch (e) {
        log(LOG_ERR, 'chat.ssjs: ' + e);
        if (client) {
            try { client.disconnect(); } catch (_disconnectError) {}
        }
        return { error: e && e.message ? String(e.message) : 'chat service error' };
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
        ip: trimText(nick.ip),
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

function buildThreadKey(nick) {
    var normalized = normalizeNick(nick);
    var nameKey = normalized ? normalizeUpper(normalized.name).replace(/[^A-Z0-9]/g, '') : '';
    var remoteKey = normalized && normalized.host
        ? normalizeUpper(normalized.host)
        : (normalized && normalized.qwkid ? normalized.qwkid : '');

    return nameKey + '|' + remoteKey;
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

function formatChatMessage(message, ownAlias) {
    var nick = normalizeNick(message ? message.nick : null);
    var sender = nick && nick.name ? nick.name : '';
    var systemName = nick && nick.host ? nick.host : '';
    var userNumber = 0;
    var peer = null;
    var isSelf = false;

    if (sender.length) {
        try { userNumber = system.matchuser(sender) || 0; } catch (_matchError) {}
    }

    if (ownAlias) {
        isSelf =
            normalizeUpper(sender) === normalizeUpper(ownAlias) &&
            (!systemName.length || normalizeUpper(systemName) === normalizeUpper(system.name));
    }

    if (ownAlias && isPrivateMessage(message)) {
        peer = resolvePrivatePeerNick(message, ownAlias);
    }

    return {
        sender: sender,
        system: systemName,
        text: message && message.str ? String(message.str) : '',
        timestamp: message && message.time ? message.time : 0,
        userNumber: userNumber,
        isSelf: isSelf,
        avatar: nick && nick.avatar ? String(nick.avatar) : undefined,
        private: isPrivateMessage(message),
        peerName: peer && peer.name ? peer.name : undefined,
        peerSystem: peer && peer.host ? peer.host : undefined,
        peerAvatar: peer && peer.avatar ? peer.avatar : undefined
    };
}

function getMailboxMessagesPath(alias) {
    return 'channels.' + alias + '.messages';
}

function getMailboxHistoryPath(alias) {
    return 'channels.' + alias + '.history';
}

function ensureHistoryArray(client, location) {
    var existing = null;
    var created = false;

    try {
        existing = client.read('chat', location, 1);
    } catch (_readError) {
        existing = null;
    }

    if (Array.isArray(existing)) {
        return;
    }

    created = client.write('chat', location, [], 2) === true;
    if (!created) {
        throw new Error('unable to initialize history array at ' + location);
    }
}

function registerPublicChannel(client, channelName) {
    var registered = client.write('chat', 'public_channels.' + channelName, true, 2) === true;
    if (!registered) {
        throw new Error('unable to register public channel ' + channelName);
    }
}

function confirmLatestHistoryMessage(client, historyPath, packet) {
    var latest = [];
    var entry = null;

    try {
        latest = client.slice('chat', historyPath, -1, undefined, 1) || [];
    } catch (_sliceError) {
        latest = [];
    }

    if (!Array.isArray(latest) || !latest.length) {
        throw new Error('message did not persist to ' + historyPath);
    }

    entry = latest[0];
    if (!entry || entry.time !== packet.time || String(entry.str || '') !== String(packet.str || '')) {
        throw new Error('history verification failed for ' + historyPath);
    }
}

function getRecentHistory(client, historyPath, count) {
    var history = [];

    try {
        history = client.slice('chat', historyPath, -count, undefined, 1) || [];
    } catch (_sliceError) {
        history = [];
    }

    return Array.isArray(history) ? history : [];
}

function historyHasPublicTraffic(history) {
    var index = 0;

    for (index = 0; index < history.length; index += 1) {
        if (!isPrivateMessage(history[index])) {
            return true;
        }
    }

    return false;
}

function listPublicChannelNames(client) {
    var seen = {};
    var names = [];
    var registryKeys = [];
    var channelKeys = [];
    var index = 0;
    var name = '';
    var history = [];

    try { registryKeys = getKeys(client.keys('chat', 'public_channels', 1)); } catch (_registryError) {}
    try { channelKeys = getKeys(client.keys('chat', 'channels', 1)); } catch (_channelsError) {}

    function addName(value) {
        var normalized = sanitizeChannel(value, '');
        if (!normalized.length || seen[normalized.toUpperCase()]) {
            return;
        }
        seen[normalized.toUpperCase()] = true;
        names.push(normalized);
    }

    addName(_defaultChannel);

    for (index = 0; index < registryKeys.length; index += 1) {
        addName(registryKeys[index]);
    }

    for (index = 0; index < channelKeys.length; index += 1) {
        name = sanitizeChannel(channelKeys[index], '');
        if (!name.length || seen[name.toUpperCase()]) {
            continue;
        }

        history = getRecentHistory(client, 'channels.' + name + '.history', 20);
        if (historyHasPublicTraffic(history)) {
            addName(name);
        }
    }

    return names.sort();
}

function summarizePublicChannel(client, channelName, sinceTimestamp, ownAlias) {
    var history = getRecentHistory(client, 'channels.' + channelName + '.history', Math.max(60, _maxHistory));
    var index = 0;
    var lastTimestamp = 0;
    var newCount = 0;
    var users = {};
    var whoCount = 0;

    for (index = 0; index < history.length; index += 1) {
        var message = history[index];
        var nick = normalizeNick(message ? message.nick : null);
        var timestamp = message && message.time ? message.time : 0;

        if (isPrivateMessage(message)) {
            continue;
        }

        if (timestamp > lastTimestamp) {
            lastTimestamp = timestamp;
        }

        if (
            sinceTimestamp > 0 &&
            timestamp > sinceTimestamp &&
            nick &&
            normalizeUpper(nick.name) !== normalizeUpper(ownAlias)
        ) {
            newCount += 1;
        }
    }

    try {
        users = client.who('chat', 'channels.' + channelName + '.messages') || {};
        whoCount = getKeys(users).length;
    } catch (_whoError) {
        whoCount = 0;
    }

    return {
        name: channelName,
        userCount: whoCount,
        lastTimestamp: lastTimestamp,
        newCount: sinceTimestamp > 0 ? newCount : 0
    };
}

function summarizePrivateThreads(client, ownAlias, sinceTimestamp) {
    var history = getRecentHistory(client, getMailboxHistoryPath(ownAlias), Math.max(80, _maxHistory * 2));
    var threads = {};
    var index = 0;
    var summaries = [];
    var key;

    for (index = 0; index < history.length; index += 1) {
        var message = history[index];
        var peer = resolvePrivatePeerNick(message, ownAlias);
        var sender = normalizeNick(message ? message.nick : null);
        var timestamp = message && message.time ? message.time : 0;

        if (!isPrivateMessage(message) || !peer) {
            continue;
        }

        key = buildThreadKey(peer);
        if (!threads[key]) {
            threads[key] = {
                name: peer.name,
                system: peer.host || '',
                avatar: peer.avatar || undefined,
                lastTimestamp: 0,
                preview: '',
                newCount: 0
            };
        }

        if (timestamp >= threads[key].lastTimestamp) {
            threads[key].lastTimestamp = timestamp;
            threads[key].preview = message && message.str ? String(message.str) : '';
            if (peer.avatar) threads[key].avatar = peer.avatar;
            threads[key].system = peer.host || threads[key].system;
        }

        if (
            sinceTimestamp > 0 &&
            timestamp > sinceTimestamp &&
            sender &&
            normalizeUpper(sender.name) !== normalizeUpper(ownAlias)
        ) {
            threads[key].newCount += 1;
        }
    }

    for (key in threads) {
        if (Object.prototype.hasOwnProperty.call(threads, key)) {
            summaries.push(threads[key]);
        }
    }

    summaries.sort(function (a, b) {
        return (b.lastTimestamp || 0) - (a.lastTimestamp || 0);
    });

    /* Live-lookup current avatars for local users so the sidebar
       never shows stale avatars from old messages */
    var _sumAvatarLib = null;
    summaries.forEach(function (entry) {
        var isLocal = !entry.system || normalizeUpper(entry.system) === normalizeUpper(system.name);
        if (!isLocal) return;
        try {
            var userNum = system.matchuser(entry.name) || 0;
            if (userNum > 0) {
                if (!_sumAvatarLib) _sumAvatarLib = load({}, 'avatar_lib.js');
                var avatarObj = _sumAvatarLib.read_localuser(userNum) || {};
                if (avatarObj && avatarObj.data) {
                    entry.avatar = String(avatarObj.data);
                }
            }
        } catch (_e) {}
    });

    return summaries;
}

function loadPrivateHistory(client, ownAlias, targetName, targetSystem) {
    var history = getRecentHistory(client, getMailboxHistoryPath(ownAlias), Math.max(80, _maxHistory * 2));
    var index = 0;
    var messages = [];
    var selectedPeer = null;
    var targetNameKey = normalizeUpper(targetName);
    var targetSystemKey = normalizeUpper(targetSystem);

    for (index = 0; index < history.length; index += 1) {
        var message = history[index];
        var peer = resolvePrivatePeerNick(message, ownAlias);
        var peerNameKey = peer ? normalizeUpper(peer.name) : '';
        var peerSystemKey = peer && peer.host ? normalizeUpper(peer.host) : '';

        if (!isPrivateMessage(message) || !peer || peerNameKey !== targetNameKey) {
            continue;
        }

        if (targetSystemKey.length && peerSystemKey.length && peerSystemKey !== targetSystemKey) {
            continue;
        }

        /* Always update so we end up with the most recent peer avatar */
        selectedPeer = peer;

        messages.push(formatChatMessage(message, ownAlias));
    }

    /* Live-lookup the peer's CURRENT avatar so we never return stale data
       from old messages. Local users get an avatar_lib lookup; remote peers
       fall back to whatever the most-recent message carried. */
    var liveAvatar = undefined;
    if (selectedPeer) {
        var isLocal = !selectedPeer.host || normalizeUpper(selectedPeer.host) === normalizeUpper(system.name);
        if (isLocal) {
            try {
                var peerUserNum = system.matchuser(selectedPeer.name) || 0;
                if (peerUserNum > 0) {
                    var peerAvatarLib = load({}, 'avatar_lib.js');
                    var peerAvatarObj = peerAvatarLib.read_localuser(peerUserNum) || {};
                    if (peerAvatarObj && peerAvatarObj.data) {
                        liveAvatar = String(peerAvatarObj.data);
                    }
                }
            } catch (_avErr) {}
        }
    }

    return {
        peer: selectedPeer ? {
            name: selectedPeer.name,
            system: selectedPeer.host || '',
            avatar: liveAvatar || selectedPeer.avatar || undefined
        } : null,
        messages: messages
    };
}

function buildOwnNick() {
    var avatarLib = load({}, 'avatar_lib.js');
    var avatarObj = avatarLib.read_localuser(user.number) || {};

    return {
        name: user.alias,
        host: system.name,
        ip: user.ip_address || '0.0.0.0',
        qwkid: system.qwk_id,
        avatar: avatarObj && avatarObj.data ? String(avatarObj.data) : undefined
    };
}

function buildPrivateMessage(sender, recipient, text, timestamp) {
    return {
        nick: sender,
        str: text,
        time: timestamp,
        private: {
            to: recipient
        }
    };
}

var reply = { error: 'invalid request' };
var action = hasRequestParam('action') ? getRequestValue('action', '') : '';

switch (action) {
    case 'history':
        var historyChannel = getChannel();
        var historyCount = 60;

        if (hasRequestParam('count')) {
            var requestedCount = parseInt(getRequestValue('count', ''), 10);
            if (!isNaN(requestedCount) && requestedCount > 0 && requestedCount <= Math.max(60, _maxHistory)) {
                historyCount = requestedCount;
            }
        }

        reply = withClient(function (client) {
            var history = getRecentHistory(client, 'channels.' + historyChannel + '.history', historyCount);
            var messages = [];
            var index = 0;
            var ownAlias = user.number > 0 ? user.alias : '';

            for (index = 0; index < history.length; index += 1) {
                if (isPrivateMessage(history[index])) {
                    continue;
                }
                messages.push(formatChatMessage(history[index], ownAlias));
            }

            return {
                channel: historyChannel,
                messages: messages,
                serverTime: Date.now()
            };
        });
        break;

    case 'who':
        var whoChannel = getChannel();

        reply = withClient(function (client) {
            var users = [];
            var whoResult = client.who('chat', 'channels.' + whoChannel + '.messages') || {};
            var key;

            for (key in whoResult) {
                if (!Object.prototype.hasOwnProperty.call(whoResult, key)) {
                    continue;
                }

                var entry = whoResult[key];
                var nickObj = normalizeNick(entry && entry.nick && typeof entry.nick === 'object' ? entry.nick : null);
                var nickName = nickObj && nickObj.name ? nickObj.name : String(entry && entry.nick ? entry.nick : key);
                var systemName = nickObj && nickObj.host ? nickObj.host : String(entry && entry.system ? entry.system : '');
                var userNumber = 0;

                if (nickName.length) {
                    try { userNumber = system.matchuser(nickName) || 0; } catch (_matchUserError) {}
                }

                users.push({
                    nick: nickName,
                    system: systemName,
                    userNumber: userNumber,
                    avatar: nickObj && nickObj.avatar ? nickObj.avatar : undefined,
                    qwkid: nickObj && nickObj.qwkid ? nickObj.qwkid : undefined
                });
            }

            return {
                channel: whoChannel,
                users: users,
                serverTime: Date.now()
            };
        });
        break;

    case 'channels':
        var sinceChannels = getRequestTimestamp('since');

        reply = withClient(function (client) {
            var names = listPublicChannelNames(client);
            var summaries = [];
            var ownAlias = user.number > 0 ? user.alias : '';
            var index = 0;

            for (index = 0; index < names.length; index += 1) {
                summaries.push(summarizePublicChannel(client, names[index], sinceChannels, ownAlias));
            }

            summaries.sort(function (a, b) {
                return (b.lastTimestamp || 0) - (a.lastTimestamp || 0);
            });

            return {
                channels: summaries,
                serverTime: Date.now()
            };
        });
        break;

    case 'motd':
        var motdChannel = hasRequestParam('channel') ? sanitizeChannel(getRequestValue('channel', 'motd'), 'motd') : 'motd';

        reply = withClient(function (client) {
            var history = getRecentHistory(client, 'channels.' + motdChannel + '.history', 10);
            var latest = null;
            var index = 0;

            for (index = history.length - 1; index >= 0; index -= 1) {
                if (!isPrivateMessage(history[index])) {
                    latest = history[index];
                    break;
                }
            }

            var ownAlias = user.number > 0 ? user.alias : '';
            var formatted = latest ? formatChatMessage(latest, ownAlias) : null;

            return {
                channel: motdChannel,
                message: formatted,
                previewText: formatted ? trimText(formatted.text) : '',
                timestamp: formatted && formatted.timestamp ? formatted.timestamp : 0,
                serverTime: Date.now()
            };
        });
        break;

    case 'motd':
        var motdChannel = hasRequestParam('channel') ? sanitizeChannel(getRequestValue('channel', 'motd'), 'motd') : 'motd';

        reply = withClient(function (client) {
            var history = getRecentHistory(client, 'channels.' + motdChannel + '.history', 10);
            var latest = null;
            var index = 0;

            for (index = history.length - 1; index >= 0; index -= 1) {
                if (!isPrivateMessage(history[index])) {
                    latest = history[index];
                    break;
                }
            }

            var ownAlias = user.number > 0 ? user.alias : '';
            var formatted = latest ? formatChatMessage(latest, ownAlias) : null;

            return {
                channel: motdChannel,
                message: formatted,
                previewText: formatted ? trimText(formatted.text) : '',
                timestamp: formatted && formatted.timestamp ? formatted.timestamp : 0,
                serverTime: Date.now()
            };
        });
        break;

    case 'private':
        if (user.number < 1 || user.alias === settings.guest) {
            reply = { error: 'authentication required' };
            break;
        }

        var sincePrivate = getRequestTimestamp('since');

        reply = withClient(function (client) {
            return {
                threads: summarizePrivateThreads(client, user.alias, sincePrivate),
                serverTime: Date.now()
            };
        });
        break;

    case 'privateHistory':
        if (user.number < 1 || user.alias === settings.guest) {
            reply = { error: 'authentication required' };
            break;
        }

        var targetAlias = sanitizeAlias(getRequestText('target'));
        var targetSystem = trimText(getRequestText('system'));

        if (!targetAlias.length) {
            reply = { error: 'target required' };
            break;
        }

        reply = withClient(function (client) {
            var result = loadPrivateHistory(client, user.alias, targetAlias, targetSystem);
            result.serverTime = Date.now();
            return result;
        });
        break;

    case 'createChannel':
        if (http_request.method !== 'POST') {
            reply = { error: 'POST required' };
            break;
        }

        if (user.number < 1 || user.alias === settings.guest) {
            reply = { error: 'authentication required' };
            break;
        }

        var createChannelName = getChannel();
        reply = withClient(function (client) {
            ensureHistoryArray(client, 'channels.' + createChannelName + '.history');
            registerPublicChannel(client, createChannelName);
            return {
                success: true,
                channel: createChannelName,
                serverTime: Date.now()
            };
        });
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

        var sendChannel = getChannel();
        var messageText = getRequestText('message');

        if (!messageText.length) {
            reply = { error: 'empty message' };
            break;
        }

        var maxMessageLen = (messageText.indexOf('[BITMAP|') === 0) ? 32000 : 1000;
        if (messageText.length > maxMessageLen) {
            messageText = messageText.substr(0, maxMessageLen);
        }
        messageText = messageText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

        reply = withClient(function (client) {
            var packet = {
                nick: buildOwnNick(),
                str: messageText,
                time: Date.now()
            };
            var basePath = 'channels.' + sendChannel;
            var messageWriteOk = false;
            var historyPushOk = false;

            ensureHistoryArray(client, basePath + '.history');
            registerPublicChannel(client, sendChannel);
            messageWriteOk = client.write('chat', basePath + '.messages', packet, 2) === true;
            historyPushOk = client.push('chat', basePath + '.history', packet, 2) === true;

            if (!messageWriteOk) {
                throw new Error('unable to write live message for channel ' + sendChannel);
            }

            if (!historyPushOk) {
                throw new Error('unable to append history for channel ' + sendChannel);
            }

            confirmLatestHistoryMessage(client, basePath + '.history', packet);

            return {
                success: true,
                channel: sendChannel,
                timestamp: packet.time,
                serverTime: Date.now()
            };
        });
        break;

    case 'sendPrivate':
        if (http_request.method !== 'POST') {
            reply = { error: 'POST required' };
            break;
        }

        if (user.number < 1 || user.alias === settings.guest) {
            reply = { error: 'authentication required' };
            break;
        }

        var privateTarget = sanitizeAlias(getRequestText('target'));
        var privateSystem = trimText(getRequestText('system'));
        var privateMessageText = getRequestText('message');

        if (!privateTarget.length) {
            reply = { error: 'target required' };
            break;
        }

        if (!privateMessageText.length) {
            reply = { error: 'empty message' };
            break;
        }

        var maxPrivateLen = (privateMessageText.indexOf('[BITMAP|') === 0) ? 32000 : 1000;
        if (privateMessageText.length > maxPrivateLen) {
            privateMessageText = privateMessageText.substr(0, maxPrivateLen);
        }
        privateMessageText = privateMessageText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

        reply = withClient(function (client) {
            var sender = buildOwnNick();
            var recipient = {
                name: privateTarget,
                host: privateSystem || undefined
            };
            var packet = buildPrivateMessage(sender, recipient, privateMessageText, Date.now());
            var recipientBase = 'channels.' + privateTarget;
            var ownMailboxHistory = getMailboxHistoryPath(user.alias);
            var mailboxWriteOk = false;
            var recipientHistoryOk = false;
            var ownHistoryOk = false;

            ensureHistoryArray(client, recipientBase + '.history');
            ensureHistoryArray(client, ownMailboxHistory);
            mailboxWriteOk = client.write('chat', getMailboxMessagesPath(privateTarget), packet, 2) === true;
            recipientHistoryOk = client.push('chat', recipientBase + '.history', packet, 2) === true;
            ownHistoryOk = client.push('chat', ownMailboxHistory, packet, 2) === true;

            if (!mailboxWriteOk) {
                throw new Error('unable to write private mailbox message for ' + privateTarget);
            }

            if (!recipientHistoryOk) {
                throw new Error('unable to append recipient private history for ' + privateTarget);
            }

            if (!ownHistoryOk) {
                throw new Error('unable to append own private history for ' + user.alias);
            }

            confirmLatestHistoryMessage(client, recipientBase + '.history', packet);
            confirmLatestHistoryMessage(client, ownMailboxHistory, packet);

            return {
                success: true,
                target: privateTarget,
                timestamp: packet.time,
                serverTime: Date.now()
            };
        });
        break;

    default:
        reply = { error: 'unknown action: ' + action };
        break;
}

writeln(JSON.stringify(reply));
