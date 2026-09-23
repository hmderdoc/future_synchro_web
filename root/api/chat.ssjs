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
load(settings.web_lib + 'avatar-profiles.js');
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

function isUserMailboxName(name) {
    /* True if the name matches a local user account. Used ONLY on the write path
       to stop a new public room from colliding with a username (which would mix a
       user's private mailbox and a public room in the same channels.<name> key).
       NOT used to gate reads - a legit public room can share a name with a bot
       account (e.g. GameBot), so reads are gated on the public_channels registry. */
    var candidate = trimText(name);
    if (!candidate.length) {
        return false;
    }
    try {
        return (system.matchuser(candidate) || 0) > 0;
    } catch (_matchError) {
        return false;
    }
}

function isRegisteredPublicChannel(client, channel) {
    /* A channel is publicly readable/listable ONLY if it is explicitly registered
       as a public room. Private mailboxes (channels.<alias>.*) are never registered,
       so this allowlist keeps them off every unauthenticated read/list endpoint. */
    if (channel === _defaultChannel) {
        return true;
    }
    try {
        return client.read('chat', 'public_channels.' + channel, 1) === true;
    } catch (_registryError) {
        return false;
    }
}

function channelHasPrivateTraffic(client, channel) {
    var history = getRecentHistory(client, 'channels.' + channel + '.history', 20);
    var index = 0;
    for (index = 0; index < history.length; index += 1) {
        if (isPrivateMessage(history[index])) {
            return true;
        }
    }
    return false;
}

function isWritablePublicChannel(client, channel) {
    /* Permit posting/creating a public room only when it is already an established
       public room, or a fresh name that is neither a username nor an in-use mailbox.
       This is what prevents a "public" post from ever landing in channels.<alias>. */
    if (isRegisteredPublicChannel(client, channel)) {
        return true;
    }
    if (isUserMailboxName(channel)) {
        return false;
    }
    return !channelHasPrivateTraffic(client, channel);
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

    /* Sysop placeholder avatars + cross-network name links (terminal-side
       tools): fills avatar/userNumber unless the sender sent an avatar inline. */
    var profiled = AvatarProfiles.apply(
        { userNumber: userNumber, avatar: nick && nick.avatar ? String(nick.avatar) : '' }, sender);
    userNumber = profiled.userNumber;

    return {
        sender: sender,
        system: systemName,
        text: message && message.str ? String(message.str) : '',
        timestamp: message && message.time ? message.time : 0,
        userNumber: userNumber,
        isSelf: isSelf,
        avatar: profiled.avatar ? profiled.avatar : undefined,
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

function listPublicChannelNames(client) {
    var seen = {};
    var names = [];
    var registryKeys = [];
    var index = 0;

    try { registryKeys = getKeys(client.keys('chat', 'public_channels', 1)); } catch (_registryError) {}

    function addName(value) {
        var normalized = sanitizeChannel(value, '');
        if (!normalized.length || seen[normalized.toUpperCase()]) {
            return;
        }
        seen[normalized.toUpperCase()] = true;
        names.push(normalized);
    }

    /* Allowlist only: the default room plus channels explicitly registered as
       public. Private mailboxes (channels.<alias>.*) are never registered, so
       they can never surface in the public channel list. (Previously this also
       scanned every channels.* key and promoted any with non-private traffic,
       which leaked mailboxes that had a stray public-shaped message.) */
    addName(_defaultChannel);

    for (index = 0; index < registryKeys.length; index += 1) {
        addName(registryKeys[index]);
    }

    return names.sort();
}

function summarizePublicChannel(client, channelName, sinceTimestamp, ownAlias) {
    var history = getRecentHistory(client, 'channels.' + channelName + '.history', Math.max(60, _maxHistory));
    var index = 0;
    var lastTimestamp = 0;
    var newCount = 0;
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
        whoCount = buildWhoUsers(client, channelName).length;
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

/* --- shared read builders (used by the individual actions AND by `sync`, which
       bundles them into a single JSONClient connection per poll) --- */

function buildWhoUsers(client, channel) {
    var users = [];
    var whoResult = client.who('chat', 'channels.' + channel + '.messages') || {};
    var seen = {};
    var key;

    for (key in whoResult) {
        if (!Object.prototype.hasOwnProperty.call(whoResult, key)) {
            continue;
        }

        var entry = whoResult[key];
        var nickObj = normalizeNick(entry && entry.nick && typeof entry.nick === 'object' ? entry.nick : null);
        var nickName = nickObj && nickObj.name ? nickObj.name : String(entry && entry.nick ? entry.nick : key);
        var systemName = nickObj && nickObj.host ? nickObj.host : String(entry && entry.system ? entry.system : '');
        var qwkid = nickObj && nickObj.qwkid ? nickObj.qwkid : '';
        var identityKey = '$' + normalizeUpper(nickName) + '|' + normalizeUpper(qwkid || systemName);
        var userNumber = 0;
        var existingIndex = seen[identityKey];

        if (nickName.length) {
            try { userNumber = system.matchuser(nickName) || 0; } catch (_matchUserError) {}
        }

        if (typeof existingIndex === 'number') {
            if (!users[existingIndex].avatar && nickObj && nickObj.avatar) {
                users[existingIndex].avatar = nickObj.avatar;
            }
            if (!users[existingIndex].qwkid && qwkid) {
                users[existingIndex].qwkid = qwkid;
            }
            if (!users[existingIndex].userNumber && userNumber) {
                users[existingIndex].userNumber = userNumber;
            }
            continue;
        }

        seen[identityKey] = users.length;
        var whoProfile = AvatarProfiles.apply(
            { userNumber: userNumber, avatar: nickObj && nickObj.avatar ? String(nickObj.avatar) : '' }, nickName);
        users.push({
            nick: nickName,
            system: systemName,
            userNumber: whoProfile.userNumber,
            avatar: whoProfile.avatar ? whoProfile.avatar : undefined,
            qwkid: qwkid || undefined
        });
    }

    return users;
}

function buildPublicHistory(client, channel, count, ownAlias) {
    var history = getRecentHistory(client, 'channels.' + channel + '.history', count);
    var messages = [];
    var index = 0;

    for (index = 0; index < history.length; index += 1) {
        if (isPrivateMessage(history[index])) {
            continue;
        }
        messages.push(formatChatMessage(history[index], ownAlias));
    }

    return messages;
}

function buildChannelSummaries(client, since, ownAlias) {
    var names = listPublicChannelNames(client);
    var summaries = [];
    var index = 0;

    for (index = 0; index < names.length; index += 1) {
        summaries.push(summarizePublicChannel(client, names[index], since, ownAlias));
    }

    summaries.sort(function (a, b) {
        return (b.lastTimestamp || 0) - (a.lastTimestamp || 0);
    });

    return summaries;
}

/* Message CONTENT and member NAMES are for signed-in users. Anonymous web
   visitors run as the Guest account (user.number > 0), so a bare
   `user.number > 0` test does not exclude them. Guests still get each public
   room's user count and last-message time (buildChannelSummaries) so the page
   can show that a room is alive without showing what is said in it. This has
   to be enforced here: hiding it in the page would leave the API readable. */
function isAuthedUser() {
    return user.number > 0 && user.alias !== settings.guest;
}

function lockedHistory(channelName) {
    return { channel: channelName, messages: [], locked: true };
}

function lockedWho(client, channelName) {
    var count = 0;
    try { count = buildWhoUsers(client, channelName).length; } catch (_countError) { count = 0; }
    return { channel: channelName, users: [], userCount: count, locked: true };
}

/* ------------------------------------------------------------------------
   Bridged rooms: DDial and MRC on the website.

   These two "channels" do not live in the JSON chat database. They are served
   by the fshell_ts multiplexers (the same long-lived services terminal users
   ride), which answer one-shot loopback requests authenticated by a shared
   secret in mods/fshell_ts/config/web-bridge.ini. This API has already
   authenticated the user (session cookie) and VOUCHES for the alias it
   passes; the browser never sees the secret or talks to a mux. No secret
   configured = the rooms simply do not exist.

   - ddial: each web user gets their OWN line under their own alias while
     they have the room open (so their name - and avatar - is the real one).
     A bare read (room counts, another page of the site) takes no line.
   - mrc:   each web user gets their own `<FL>Alias` identity, created when
     they open the room and logged off ~90s after their tab stops polling.
   ------------------------------------------------------------------------ */
var BRIDGE_ROOMS = {
    ddial: { label: 'DDial', portKey: 'ddial_port', port: 5001 },
    mrc: { label: 'MRC', portKey: 'mrc_port', port: 5000 }
};
var _bridgeConfig;

function bridgeConfig() {
    if (_bridgeConfig !== undefined) { return _bridgeConfig; }
    _bridgeConfig = null;
    try {
        var f = new File(system.mods_dir + 'fshell_ts/config/web-bridge.ini');
        if (f.exists && f.open('r')) {
            var root = f.iniGetObject() || {};
            f.close();
            var secret = typeof root.secret === 'string' ? root.secret.replace(/^\s+|\s+$/g, '') : '';
            if (secret.length >= 16) { _bridgeConfig = { secret: secret, root: root }; }
        }
    } catch (_bridgeConfigError) { _bridgeConfig = null; }
    return _bridgeConfig;
}

function bridgeRoomFor(channelName) {
    var key = String(channelName || '').toLowerCase();
    return BRIDGE_ROOMS.hasOwnProperty(key) && bridgeConfig() ? key : '';
}

/* DDial and MRC are 8-bit BBS networks: browser punctuation would arrive as
   CP437 garbage. Fold the common offenders to ASCII and drop the rest. */
function bridgeWireText(text) {
    return String(text || '')
        .replace(/[\u2018\u2019\u201A\u2032]/g, "'").replace(/[\u201C\u201D\u201E\u2033]/g, '"')
        .replace(/[\u2013\u2014\u2212]/g, '-').replace(/\u2026/g, '...').replace(/\u00A0/g, ' ')
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '')
        .substr(0, 400);
}

function bridgeRequest(room, payload) {
    var config = bridgeConfig();
    var def = BRIDGE_ROOMS[room];
    if (!config || !def) { return null; }
    var port = parseInt(config.root[def.portKey], 10);
    if (isNaN(port) || port < 1 || port > 65535) { port = def.port; }
    payload.service = 'web';
    payload.secret = config.secret;
    var sock = new Socket();
    var line = null;
    try {
        if (!sock.connect('127.0.0.1', port, 2)) { return null; }
        sock.send(JSON.stringify(payload) + '\n');
        line = sock.recvline(262144, 3);
    } catch (_bridgeSockError) {
        line = null;
    } finally {
        try { sock.close(); } catch (_bridgeCloseError) {}
    }
    if (!line) { return null; }
    try { return JSON.parse(line); } catch (_bridgeParseError) { return null; }
}

/* `[FL]Hm_Derdoc` / `<FL>Hm_Derdoc` / `Hm_Derdoc^11D` -> a local account number, or 0. */
function bridgeLocalUserNumber(name) {
    var plain = String(name || '')
        .replace(/^(\[\w{1,4}\]|<\w{1,4}>|!\w{1,4}!)/, '')
        .replace(/\^\(?[A-Za-z0-9]{1,8}\)?$/, '');
    var found = 0;
    try { found = system.matchuser(plain) || system.matchuser(plain.replace(/_/g, ' ')) || 0; } catch (_bridgeMatchError) { found = 0; }
    return found;
}

/* Colour runs from the DDial mux ([{n, c:'#rrggbb'|''}]) -> the same, but only
   if they are well formed and cover exactly `length` characters (after `pad`
   uncoloured ones we prepended). Anything else is dropped, not repaired. */
function bridgeColorRuns(runs, length, pad) {
    if (!runs || typeof runs.length !== 'number' || !runs.length || runs.length > 512) { return null; }
    var out = pad > 0 ? [{ n: pad, c: '' }] : [];
    var total = 0;
    for (var i = 0; i < runs.length; i += 1) {
        var run = runs[i];
        var n = run ? Math.floor(Number(run.n)) : 0;
        var c = run ? String(run.c || '') : '';
        if (!(n > 0) || (c.length && !/^#[0-9a-f]{6}$/.test(c))) { return null; }
        total += n;
        out.push({ n: n, c: c });
    }
    return total === length ? out : null;
}

function bridgeMessages(room, response, ownAlias) {
    var out = [];
    var events = response && response.events ? response.events : [];
    var ownNick = response && response.nick ? String(response.nick) : '';
    for (var i = 0; i < events.length; i += 1) {
        var ev = events[i];
        if (!ev || typeof ev.text !== 'string' || !ev.text.length) { continue; }
        if (ev.kind !== 'chat') {
            /* An empty sender renders as a centred system line on the page. */
            out.push({ sender: '', system: '', text: ev.text.replace(/\|\w\w/g, ''), timestamp: ev.t || 0, userNumber: 0, isSelf: false });
            continue;
        }
        var sender = String(ev.sender || '');
        var isSelf = room === 'ddial'
            ? (!!ev.web && normalizeUpper(sender) === normalizeUpper(ownAlias))
            : (ownNick.length > 0 && normalizeUpper(sender) === normalizeUpper(ownNick));
        /* `web` = one of OUR website users on their own DDial line: `sender` is
           their account alias, so the local account (and its avatar) resolves.
           Everyone else on DDial is a free-form handle with no account here;
           the page resolves those through the avatar profile lookup. */
        var privateTag = ev.private ? '(private) ' : '';
        var bridged = {
            sender: sender,
            system: room === 'ddial' ? String(ev.origin || 'DDial') : String(ev.site || 'MRC').replace(/_/g, ' '),
            text: privateTag + ev.text,
            timestamp: ev.t || 0,
            userNumber: bridgeLocalUserNumber(sender),
            isSelf: isSelf,
            private: false
        };
        /* DDial paints handles (and sometimes bodies) with ANSI; the mux hands
           those over as exact hex runs aligned to sender / text. */
        var senderColors = bridgeColorRuns(ev.senderColors, sender.length, 0);
        var textColors = bridgeColorRuns(ev.textColors, ev.text.length, privateTag.length);
        if (senderColors) { bridged.senderColors = senderColors; }
        if (textColors) { bridged.textColors = textColors; }
        out.push(AvatarProfiles.apply(bridged, sender));
    }
    return out;
}

function bridgeHistory(room, ownAlias) {
    /* present = the user has this room open on the chat page right now. On
       DDial that is what holds their line (on MRC any poll does, which is why
       bridgePresenceAllowed gates MRC polls entirely). */
    var present = hasRequestParam('active') && getRequestValue('active', '0') === '1';
    var response = bridgeRequest(room, { op: 'poll', user: ownAlias, since: 0, present: present });
    if (!response || !response.ok) {
        var why = response && response.error ? response.error : (BRIDGE_ROOMS[room].label + ' is unavailable right now');
        return { channel: room, messages: [{ sender: '', system: '', text: why, timestamp: Date.now(), userNumber: 0, isSelf: false }], bridge: room };
    }
    return { channel: room, messages: bridgeMessages(room, response, ownAlias), bridge: room, topic: response.topic || '' };
}

function bridgeWho(room, ownAlias) {
    var response = bridgeRequest(room, { op: 'who', user: ownAlias });
    var users = [];
    var list = response && response.ok && response.users ? response.users : [];
    for (var i = 0; i < list.length; i += 1) {
        var entry = list[i];
        var nick = typeof entry === 'string' ? entry : String(entry && entry.handle ? entry.handle : '');
        if (!nick.length) { continue; }
        users.push(AvatarProfiles.apply({
            nick: nick,
            system: typeof entry === 'string' ? 'MRC' : String(entry.origin || 'DDial'),
            userNumber: bridgeLocalUserNumber(nick)
        }, nick));
    }
    return { channel: room, users: users, bridge: room };
}

/* Room-list rows. DDial is summarised with a poll (costs nothing: no line is
   taken). MRC is NOT polled here: a poll IS a login there, and listing the
   room must not announce the user to the network - only opening it does. */
/* On MRC every poll keeps the user logged in to the network. Only do that
   while they are actually looking at the chat page (the client says so with
   active=1); on any other page of the site the session is left to expire.
   DDial reads take no line and announce nothing, so they are always fine. */
function bridgePresenceAllowed(room) {
    if (room !== 'mrc') { return true; }
    return hasRequestParam('active') && getRequestValue('active', '0') === '1';
}

function bridgeSummaries(ownAlias) {
    var out = [];
    if (!bridgeConfig()) { return out; }
    var ddial = bridgeRequest('ddial', { op: 'poll', user: ownAlias, since: 999999999 });
    out.push({
        name: 'ddial', label: 'DDial', bridge: 'ddial',
        userCount: ddial && ddial.ok ? (ddial.userCount || 0) : 0,
        lastTimestamp: ddial && ddial.ok ? (ddial.lastEventMs || 0) : 0,
        newCount: 0
    });
    out.push({ name: 'mrc', label: 'MRC', bridge: 'mrc', userCount: 0, lastTimestamp: 0, newCount: 0 });
    return out;
}

function flagDefaultsOn(name) {
    /* a sync sub-section is included unless the client explicitly passes name=0 */
    return hasRequestParam(name) ? getRequestValue(name, '1') !== '0' : true;
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

        if (bridgeRoomFor(historyChannel)) {
            reply = !isAuthedUser() ? lockedHistory(historyChannel)
                : bridgePresenceAllowed(bridgeRoomFor(historyChannel))
                    ? bridgeHistory(bridgeRoomFor(historyChannel), user.alias)
                    : { channel: historyChannel, messages: [], bridge: bridgeRoomFor(historyChannel) };
            reply.serverTime = Date.now();
            break;
        }

        reply = withClient(function (client) {
            if (!isRegisteredPublicChannel(client, historyChannel)) {
                return { error: 'not found' };
            }
            var ownAlias = user.number > 0 ? user.alias : '';
            if (!isAuthedUser()) {
                var lockedReply = lockedHistory(historyChannel);
                lockedReply.serverTime = Date.now();
                return lockedReply;
            }
            return {
                channel: historyChannel,
                messages: buildPublicHistory(client, historyChannel, historyCount, ownAlias),
                serverTime: Date.now()
            };
        });
        break;

    case 'who':
        var whoChannel = getChannel();

        if (bridgeRoomFor(whoChannel)) {
            reply = isAuthedUser()
                ? bridgeWho(bridgeRoomFor(whoChannel), user.alias)
                : { channel: whoChannel, users: [], userCount: 0, locked: true };
            reply.serverTime = Date.now();
            break;
        }

        reply = withClient(function (client) {
            if (!isRegisteredPublicChannel(client, whoChannel)) {
                return { error: 'not found' };
            }
            if (!isAuthedUser()) {
                var lockedWhoReply = lockedWho(client, whoChannel);
                lockedWhoReply.serverTime = Date.now();
                return lockedWhoReply;
            }
            return {
                channel: whoChannel,
                users: buildWhoUsers(client, whoChannel),
                serverTime: Date.now()
            };
        });
        break;

    case 'channels':
        var sinceChannels = getRequestTimestamp('since');

        reply = withClient(function (client) {
            var ownAlias = user.number > 0 ? user.alias : '';
            return {
                channels: buildChannelSummaries(client, sinceChannels, ownAlias)
                    .concat(isAuthedUser() ? bridgeSummaries(ownAlias) : []),
                serverTime: Date.now()
            };
        });
        break;

    case 'sync':
        /* Combined poll: everything the reconcile loop needs in ONE JSONClient
           connection instead of one per sub-request. Each section can be turned
           off with <name>=0; `history` is opt-IN (pass history=1) since the client
           usually only needs it on the active channel. */
        var syncChannel = getChannel();
        var syncSince = getRequestTimestamp('since');
        var syncWantChannels = flagDefaultsOn('channels');
        var syncWantWho = flagDefaultsOn('who');
        var syncWantPrivate = flagDefaultsOn('private');
        var syncWantHistory = hasRequestParam('history') && getRequestValue('history', '0') !== '0';
        var syncWantPresence = hasRequestParam('presence') && getRequestValue('presence', '0') !== '0';
        var syncHistoryCount = 60;

        if (hasRequestParam('count')) {
            var syncRequestedCount = parseInt(getRequestValue('count', ''), 10);
            if (!isNaN(syncRequestedCount) && syncRequestedCount > 0 && syncRequestedCount <= Math.max(60, _maxHistory)) {
                syncHistoryCount = syncRequestedCount;
            }
        }

        reply = withClient(function (client) {
            var ownAlias = user.number > 0 ? user.alias : '';
            var isAuthed = isAuthedUser();
            var syncBridge = isAuthed ? bridgeRoomFor(syncChannel) : '';
            var channelReadable = !syncBridge && isRegisteredPublicChannel(client, syncChannel);
            var out = { channel: syncChannel, serverTime: Date.now() };

            if (syncWantChannels) {
                out.channels = buildChannelSummaries(client, syncSince, ownAlias)
                    .concat(isAuthed ? bridgeSummaries(ownAlias) : []);
            }
            if (syncBridge) {
                /* The open room is DDial/MRC: served by its mux, not the JSON DB.
                   For MRC this poll is also the keep-alive for the user's session. */
                if (bridgePresenceAllowed(syncBridge)) {
                    if (syncWantHistory) { out.history = bridgeHistory(syncBridge, ownAlias); }
                    if (syncWantWho) { out.who = bridgeWho(syncBridge, ownAlias); }
                }
            }
            if (syncWantWho && channelReadable) {
                out.who = isAuthed
                    ? { channel: syncChannel, users: buildWhoUsers(client, syncChannel) }
                    : lockedWho(client, syncChannel);
            }
            if (syncWantHistory && channelReadable) {
                out.history = isAuthed
                    ? { channel: syncChannel, messages: buildPublicHistory(client, syncChannel, syncHistoryCount, ownAlias) }
                    : lockedHistory(syncChannel);
            }
            if (syncWantPrivate && isAuthed) {
                out.private = { threads: summarizePrivateThreads(client, user.alias, syncSince) };
            }
            if (syncWantPresence && !isAuthed) {
                out.presence = []; /* names are for signed-in users */
            } else if (syncWantPresence) {
                /* who-users across occupied public rooms (+ the active one), all on
                   this one connection - replaces the client's per-room who fan-out. */
                var presenceNames = [];
                var presenceSeen = {};
                var presenceUsers = [];
                var pi = 0;

                function presenceAdd(nm) {
                    var key = String(nm || '').toUpperCase();
                    if (!nm || presenceSeen[key]) { return; }
                    presenceSeen[key] = true;
                    presenceNames.push(nm);
                }

                if (out.channels) {
                    for (pi = 0; pi < out.channels.length; pi += 1) {
                        if ((out.channels[pi].userCount || 0) > 0) { presenceAdd(out.channels[pi].name); }
                    }
                } else {
                    var allPresenceNames = listPublicChannelNames(client);
                    for (pi = 0; pi < allPresenceNames.length; pi += 1) { presenceAdd(allPresenceNames[pi]); }
                }
                if (channelReadable) { presenceAdd(syncChannel); }

                for (pi = 0; pi < presenceNames.length; pi += 1) {
                    presenceUsers = presenceUsers.concat(buildWhoUsers(client, presenceNames[pi]));
                }
                out.presence = presenceUsers;
            }

            return out;
        });
        break;

    case 'motd':
        var motdChannel = hasRequestParam('channel') ? sanitizeChannel(getRequestValue('channel', 'motd'), 'motd') : 'motd';

        reply = withClient(function (client) {
            if (motdChannel !== 'motd' && !isRegisteredPublicChannel(client, motdChannel)) {
                return { error: 'not found' };
            }
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
            if (!isWritablePublicChannel(client, createChannelName)) {
                return { error: 'invalid channel' };
            }
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

        if (bridgeRoomFor(sendChannel)) {
            var wireText = bridgeWireText(messageText);
            if (!wireText.length || wireText.indexOf('[BITMAP|') === 0) {
                reply = { error: 'Only plain text can be sent to ' + BRIDGE_ROOMS[bridgeRoomFor(sendChannel)].label };
                break;
            }
            var bridgeSent = bridgeRequest(bridgeRoomFor(sendChannel), { op: 'send', user: user.alias, text: wireText });
            reply = bridgeSent && bridgeSent.ok
                ? { success: true, channel: sendChannel, timestamp: Date.now(), serverTime: Date.now() }
                : { error: bridgeSent && bridgeSent.error ? bridgeSent.error : 'That network is unavailable right now' };
            break;
        }

        var maxMessageLen = (messageText.indexOf('[BITMAP|') === 0) ? 32000 : 1000;
        if (messageText.length > maxMessageLen) {
            messageText = messageText.substr(0, maxMessageLen);
        }
        messageText = messageText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

        reply = withClient(function (client) {
            if (!isWritablePublicChannel(client, sendChannel)) {
                return { error: 'invalid channel' };
            }
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
