/* chat.ssjs - REST API for JSON chat service
 *
 * Endpoints:
 *   GET  ?action=history&channel=main             - public room history
 *   GET  ?action=who&channel=main                 - current public room subscribers
 *   GET  ?action=channels[&since=timestamp]       - public room summaries
 *   GET  ?action=motd[&channel=motd]               - latest MOTD message
 *   GET  ?action=motd[&channel=motd]               - latest MOTD message
 *   POST ?action=createChannel                    - initialize/register a public room (and join it)
 *   POST ?action=joinRoom&channel=name            - join-or-create a public room (sidebar membership)
 *   POST ?action=leaveRoom&channel=name           - drop a room from the sidebar
 *   POST ?action=send                             - send a public room message
 *   GET  ?action=private[&since=timestamp]        - private thread summaries (auth required)
 *   GET  ?action=privateHistory&target=Alias[&bridge=mrc|ddial][&read=1]
 *                                                 - private thread history (auth required)
 *   POST ?action=sendPrivate[&bridge=mrc|ddial]   - send a private message (auth required)
 *   POST ?action=threadState&target=..&read=1|dismiss=1
 *                                                 - mark a private thread read / dismiss it
 *   GET  ?action=rooms&channel=mrc                - MRC room list (bridge)
 *   POST ?action=leave&channel=mrc|ddial          - log the user off that network (bridge)
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
        avatar: trimText(nick.avatar),
        /* 'mrc' | 'ddial' when this person is reached over a bridged network
           (see "Bridged rooms" below); '' for this BBS's own chat. */
        bridge: bridgeName(nick.bridge)
    };
}

function bridgeName(raw) {
    var key = String(raw || '').toLowerCase();
    return key === 'mrc' || key === 'ddial' ? key : '';
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

    /* One thread per nick per network: an MRC user's site, or a DDial user's
       line, can change between messages without it being a new person. The
       page builds the same key (chat.js buildThreadKey). */
    if (normalized && normalized.bridge) {
        return nameKey + '|@' + normalized.bridge.toUpperCase();
    }
    return nameKey + '|' + remoteKey;
}

/* Key under which a thread's read/dismissed state is stored. Local peers
   sometimes arrive with host '' and sometimes with this system's name (a
   recipient typed on the page vs. a sender's own nick), so both fold to ''. */
function threadStateKey(nick) {
    var normalized = normalizeNick(nick);
    if (!normalized) {
        return '';
    }
    if (!normalized.bridge && normalizeUpper(normalized.host) === normalizeUpper(system.name)) {
        return buildThreadKey({ name: normalized.name });
    }
    return buildThreadKey(normalized);
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
        bridge: nick && nick.bridge ? nick.bridge : undefined,
        private: isPrivateMessage(message),
        peerName: peer && peer.name ? peer.name : undefined,
        peerSystem: peer && peer.host ? peer.host : undefined,
        peerAvatar: peer && peer.avatar ? peer.avatar : undefined,
        peerBridge: peer && peer.bridge ? peer.bridge : undefined
    };
}

function getMailboxMessagesPath(alias) {
    return 'channels.' + alias + '.messages';
}

function getMailboxHistoryPath(alias) {
    return 'channels.' + alias + '.history';
}

/* ------------------------------------------------------------------------
   Private threads: state and the bridged-network mirror.

   Local PMs live in the JSON chat mailbox (channels.<alias>.history), shared
   with the terminal's Avatar Chat. PMs over DDial/MRC exist only in a mux's
   short ring buffer, for as long as the web session lives - so every one the
   site sees (received in a poll, or sent from here) is copied into
   web_pm.<alias>.history, a store of this web tier's own. Kept apart from the
   mailbox so the terminal's local chat never shows MRC traffic as its own.

   web_pm.<alias>.state holds per-thread {readAt, dismissedAt} so read status
   and dismissals survive reloads and follow the user across devices.
   ------------------------------------------------------------------------ */
var _bridgePmMax = 400;

function getBridgePmHistoryPath(alias) {
    return 'web_pm.' + alias + '.history';
}

function getThreadStatePath(alias) {
    return 'web_pm.' + alias + '.state';
}

function readThreadState(client, alias) {
    var state = null;
    try { state = client.read('chat', getThreadStatePath(alias), 1); } catch (_stateReadError) { state = null; }
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

function updateThreadState(client, alias, key, patch) {
    var state = readThreadState(client, alias);
    var entry = state[key] && typeof state[key] === 'object' ? state[key] : {};
    var field;
    if (!key.length) {
        return;
    }
    for (field in patch) {
        if (Object.prototype.hasOwnProperty.call(patch, field)) {
            entry[field] = patch[field];
        }
    }
    state[key] = entry;
    if (client.write('chat', getThreadStatePath(alias), state, 2) !== true) {
        throw new Error('unable to save thread state for ' + alias);
    }
}

/* The `(Private)` marker MRC clients put in front of a PM body (pipe-coded
   `|11(|03Private|11)|07 `). The web shows a PM as a thread, so the word is
   noise there. */
function stripPrivateMarker(text) {
    return String(text || '').replace(/^(\|\d\d)*\s*\((\|\d\d)*Private(\|\d\d)*\)(\|\d\d)*\s*/i, '');
}

/* Append bridged PM packets the store has not seen (by `bkey`, which the mux's
   own frame time makes stable across polls), oldest first, and cap the store. */
function appendBridgePrivate(client, ownAlias, packets) {
    var location = getBridgePmHistoryPath(ownAlias);
    var recent = getRecentHistory(client, location, 160);
    var seen = {};
    var added = 0;
    var index = 0;
    var all = null;

    if (!packets.length) {
        return 0;
    }
    ensureHistoryArray(client, location);
    for (index = 0; index < recent.length; index += 1) {
        if (recent[index] && recent[index].bkey) {
            seen[recent[index].bkey] = true;
        }
    }
    for (index = 0; index < packets.length; index += 1) {
        if (seen[packets[index].bkey]) {
            continue;
        }
        seen[packets[index].bkey] = true;
        if (client.push('chat', location, packets[index], 2) === true) {
            added += 1;
        }
    }
    if (added > 0 && recent.length >= 160) {
        try { all = client.read('chat', location, 1); } catch (_lenError) { all = null; }
        if (Array.isArray(all) && all.length > _bridgePmMax) {
            client.write('chat', location, all.slice(all.length - Math.floor(_bridgePmMax * 0.75)), 2);
        }
    }
    return added;
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

/* ------------------------------------------------------------------------
   Room membership. The sidebar lists the public rooms the user has JOINED
   (plus the bridged networks), not every room with a pulse - that looked
   like a list of rooms demanding to be joined. web_rooms.<alias> = {NAME:
   name}; `main` is always in it. Speaking in or opening a room joins it;
   leaveRoom drops it. Per user, server-side, so it follows them around.
   ------------------------------------------------------------------------ */
function getJoinedRoomsPath(alias) {
    return 'web_rooms.' + alias;
}

function readJoinedRooms(client, alias) {
    var stored = null;
    var out = {};
    var key;
    if (alias) {
        try { stored = client.read('chat', getJoinedRoomsPath(alias), 1); } catch (_roomsReadError) { stored = null; }
    }
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        /* A record exists: it is the truth, even when it is empty (the user
           left every room; the page then offers #main). */
        for (key in stored) {
            if (Object.prototype.hasOwnProperty.call(stored, key) && sanitizeChannel(stored[key], '').length) {
                out[normalizeUpper(stored[key])] = sanitizeChannel(stored[key], '');
            }
        }
        return out;
    }
    /* No record yet (or a guest): start in the default room. */
    out[normalizeUpper(_defaultChannel)] = _defaultChannel;
    return out;
}

function writeJoinedRooms(client, alias, joined) {
    if (client.write('chat', getJoinedRoomsPath(alias), joined, 2) !== true) {
        throw new Error('unable to save room membership for ' + alias);
    }
}

function joinRoomMembership(client, alias, channelName) {
    var joined = readJoinedRooms(client, alias);
    if (joined[normalizeUpper(channelName)]) {
        return;
    }
    joined[normalizeUpper(channelName)] = channelName;
    writeJoinedRooms(client, alias, joined);
}

function leaveRoomMembership(client, alias, channelName) {
    var joined = readJoinedRooms(client, alias);
    delete joined[normalizeUpper(channelName)];
    writeJoinedRooms(client, alias, joined);
    return true;
}

/* Every private message the user can see: local mailbox + bridged mirror. */
function loadAllPrivateHistory(client, ownAlias) {
    return getRecentHistory(client, getMailboxHistoryPath(ownAlias), Math.max(80, _maxHistory * 2))
        .concat(getRecentHistory(client, getBridgePmHistoryPath(ownAlias), _bridgePmMax));
}

function summarizePrivateThreads(client, ownAlias, sinceTimestamp) {
    var history = loadAllPrivateHistory(client, ownAlias);
    var state = readThreadState(client, ownAlias);
    var threads = {};
    var index = 0;
    var summaries = [];
    var key;

    for (index = 0; index < history.length; index += 1) {
        var message = history[index];
        var peer = resolvePrivatePeerNick(message, ownAlias);
        var sender = normalizeNick(message ? message.nick : null);
        var timestamp = message && message.time ? message.time : 0;
        var fromPeer = false;
        var stateEntry = null;

        if (!isPrivateMessage(message) || !peer) {
            continue;
        }

        key = buildThreadKey(peer);
        if (!threads[key]) {
            stateEntry = state[threadStateKey(peer)] || {};
            threads[key] = {
                name: peer.name,
                system: peer.host || '',
                bridge: peer.bridge || undefined,
                avatar: peer.avatar || undefined,
                lastTimestamp: 0,
                lastFromPeer: 0,
                preview: '',
                newCount: 0,
                unreadCount: 0,
                readAt: Number(stateEntry.readAt) || 0,
                dismissedAt: Number(stateEntry.dismissedAt) || 0
            };
        }

        if (timestamp >= threads[key].lastTimestamp) {
            threads[key].lastTimestamp = timestamp;
            threads[key].preview = message && message.str ? String(message.str) : '';
            if (peer.avatar) threads[key].avatar = peer.avatar;
            threads[key].system = peer.host || threads[key].system;
        }

        fromPeer = !!sender && normalizeUpper(sender.name) !== normalizeUpper(ownAlias);
        if (fromPeer && timestamp > threads[key].lastFromPeer) {
            threads[key].lastFromPeer = timestamp;
        }
        /* Unread = what the peer said after the thread was last read here.
           newCount keeps the old "since your last poll" meaning for callers
           still using it. */
        if (fromPeer && timestamp > threads[key].readAt) {
            threads[key].unreadCount += 1;
        }
        if (sinceTimestamp > 0 && timestamp > sinceTimestamp && fromPeer) {
            threads[key].newCount += 1;
        }
    }

    for (key in threads) {
        if (Object.prototype.hasOwnProperty.call(threads, key)) {
            /* Dismissed (X on the page) = hidden until something newer than the
               dismissal is sent or received in that thread. */
            if (threads[key].dismissedAt > 0 && threads[key].lastTimestamp <= threads[key].dismissedAt) {
                continue;
            }
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

function loadPrivateHistory(client, ownAlias, targetName, targetSystem, targetBridge) {
    var history = targetBridge
        ? getRecentHistory(client, getBridgePmHistoryPath(ownAlias), _bridgePmMax)
        : getRecentHistory(client, getMailboxHistoryPath(ownAlias), Math.max(80, _maxHistory * 2));
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

        /* Bridged threads are per nick per network (the site/line may vary). */
        if (targetBridge) {
            if (peer.bridge !== targetBridge) {
                continue;
            }
        } else if (targetSystemKey.length && peerSystemKey.length && peerSystemKey !== targetSystemKey) {
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
            bridge: selectedPeer.bridge || undefined,
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
    /* Guests are "in" the default room only (they cannot join anything). */
    var joined = ownAlias && isAuthedUser() ? readJoinedRooms(client, ownAlias) : readJoinedRooms(client, '');

    for (index = 0; index < names.length; index += 1) {
        var summary = summarizePublicChannel(client, names[index], since, ownAlias);
        summary.joined = !!joined[normalizeUpper(names[index])];
        summaries.push(summary);
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
   - mrc:   each web user gets their own `Alias<FL>` identity, created when
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

/* `Hm_Derdoc[FL]` / `Hm_Derdoc<FL>^11D` / retired `[FL]Hm_Derdoc` -> a local account number, or 0. */
function bridgeLocalUserNumber(name) {
    var plain = String(name || '')
        .replace(/\^\(?[A-Za-z0-9]{1,8}\)?$/, '')
        .replace(/(\[\w{1,4}\]|<\w{1,4}>)$/, '')
        .replace(/^(\[\w{1,4}\]|<\w{1,4}>|!\w{1,4}!)/, '');
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

/* MRC BBS names often carry Mystic pipe colours (|09Some|15BBS): `plain` is
   the name for thread keys and comparisons; the page paints `pipe` when set. */
function bridgeSiteName(room, ev) {
    var raw = room === 'ddial' ? '' : String(ev.site || 'MRC').replace(/_/g, ' ').substr(0, 120);
    var plain = raw.replace(/\|\d\d/g, '').replace(/^\s+|\s+$/g, '') || (room === 'ddial' ? '' : 'MRC');
    return { plain: plain, pipe: raw !== plain && /\|\d\d/.test(raw) ? raw : '' };
}

function bridgeIsSelf(room, ev, ownAlias, ownNick) {
    /* `web` = one of OUR website users on their own DDial line: `sender` is
       their account alias. On MRC the mux tells us the nick it gave us. */
    var sender = String(ev.sender || '');
    return room === 'ddial'
        ? (!!ev.web && normalizeUpper(sender) === normalizeUpper(ownAlias))
        : (ownNick.length > 0 && normalizeUpper(sender) === normalizeUpper(ownNick));
}

/* A bridge (DDial's Telegram relay `tg_`, IRC/MRC relays) posts as ONE handle
   and puts the real person in the body: `<mro1337> he's gonna leave`. Split
   that into the speaker and what they said (same rule as the terminal shell's
   splitRelayedLine) so the speaker gets their own avatar, person menu and
   local-account match. `offset` = characters the wrapper took. */
function splitRelayedLine(text) {
    var source = String(text === undefined || text === null ? '' : text);
    var match = /^(\s*<([^<>\s]{1,40})>\s+)/.exec(source);
    if (!match) { return null; }
    var offset = match[1].length;
    if (offset >= source.length) { return null; }
    return { speaker: match[2], rest: source.substr(offset), offset: offset };
}

/* Colour runs with the first `offset` characters dropped (the wrapper). */
function sliceColorRuns(runs, offset) {
    if (!runs) { return null; }
    var out = [];
    var skip = offset;
    for (var i = 0; i < runs.length; i += 1) {
        var run = runs[i];
        if (skip >= run.n) { skip -= run.n; continue; }
        out.push({ n: run.n - skip, c: run.c });
        skip = 0;
    }
    return out.length ? out : null;
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
        /* Private messages are threads in the sidebar (bridgePrivatePackets),
           not lines in the room. */
        if (ev.private) { continue; }
        var sender = String(ev.sender || '');
        /* `sender` of a web user is their account alias, so the local account
           (and its avatar) resolves. Everyone else on DDial is a free-form
           handle with no account here; the page resolves those through the
           avatar profile lookup. */
        var site = bridgeSiteName(room, ev);
        var bridged = {
            sender: sender,
            system: room === 'ddial' ? String(ev.origin || 'DDial') : site.plain,
            text: ev.text,
            timestamp: ev.t || 0,
            userNumber: bridgeLocalUserNumber(sender),
            isSelf: bridgeIsSelf(room, ev, ownAlias, ownNick),
            bridge: room,
            private: false
        };
        /* DDial paints handles (and sometimes bodies) with ANSI; the mux hands
           those over as exact hex runs aligned to sender / text. */
        var senderColors = bridgeColorRuns(ev.senderColors, sender.length, 0);
        var textColors = bridgeColorRuns(ev.textColors, ev.text.length, 0);
        /* Relayed through a bridge: the person in the `<nick>` wrapper is the
           sender. The handle colours were the bridge's, so they are dropped;
           the body colours are kept minus the wrapper. */
        var relay = splitRelayedLine(ev.text);
        if (relay && !bridged.isSelf) {
            bridged.sender = relay.speaker;
            bridged.system = bridged.system + ' via ' + sender;
            bridged.relayedVia = sender;
            bridged.text = relay.rest;
            bridged.userNumber = bridgeLocalUserNumber(relay.speaker);
            senderColors = null;
            textColors = sliceColorRuns(textColors, relay.offset);
            sender = relay.speaker;
        }
        if (senderColors) { bridged.senderColors = senderColors; }
        if (site.pipe) { bridged.systemPipe = site.pipe; }
        if (textColors) { bridged.textColors = textColors; }
        out.push(AvatarProfiles.apply(bridged, sender));
    }
    return out;
}

/* The private messages in a poll, as mailbox-shaped packets for the web_pm
   store: the same shape a local PM has (formatChatMessage and the thread
   summariser read both), with the network on the peer's nick. */
function bridgePrivatePackets(room, response, ownAlias) {
    var out = [];
    var events = response && response.events ? response.events : [];
    var ownNick = response && response.nick ? String(response.nick) : '';
    for (var i = 0; i < events.length; i += 1) {
        var ev = events[i];
        if (!ev || ev.kind !== 'chat' || !ev.private || typeof ev.text !== 'string') { continue; }
        var sender = String(ev.sender || '');
        if (!sender.length || bridgeIsSelf(room, ev, ownAlias, ownNick)) { continue; }
        var text = stripPrivateMarker(ev.text);
        if (!text.length) { continue; }
        out.push({
            nick: {
                name: sender,
                host: room === 'ddial' ? String(ev.origin || 'DDial') : bridgeSiteName(room, ev).plain,
                bridge: room
            },
            str: text,
            time: ev.t || Date.now(),
            private: { to: { name: ownAlias, host: system.name } },
            /* Stable across polls (the mux stamps each frame once), so the
               same PM is never stored twice. */
            bkey: room + ':' + String(ev.t || 0) + ':' + sender.toLowerCase()
        });
    }
    return out;
}

function mirrorBridgePrivate(client, room, response, ownAlias) {
    if (!client || !response || !response.ok) { return; }
    try {
        appendBridgePrivate(client, ownAlias, bridgePrivatePackets(room, response, ownAlias));
    } catch (mirrorError) {
        log(LOG_WARNING, 'chat.ssjs: could not store ' + room + ' private messages: ' + mirrorError);
    }
}

/* ?hold=mrc,ddial - networks the browser wants to stay logged in to from
   any page of the site (the user opened that tab and has not left it). */
function heldBridges() {
    var out = {};
    var names = getRequestText('hold').split(',');
    for (var i = 0; i < names.length; i += 1) {
        var name = bridgeName(names[i]);
        if (name) { out[name] = true; }
    }
    return out;
}

/* ?room=name - the MRC room the browser wants ('' = stay where the session is). */
function requestedBridgeRoom() {
    return hasRequestParam('room')
        ? String(getRequestValue('room', '')).replace(/[^A-Za-z0-9_.-]/g, '').substr(0, 30)
        : '';
}

/* True when this request should hold the user's place on `room`: the chat
   page is showing it (active=1) or they asked to stay on it (hold=). */
function bridgePresent(room) {
    return (hasRequestParam('active') && getRequestValue('active', '0') === '1') || !!heldBridges()[room];
}

function bridgePoll(room, ownAlias, present, client) {
    var response = bridgeRequest(room, {
        op: 'poll', user: ownAlias, since: 0, present: present,
        room: room === 'mrc' ? requestedBridgeRoom() : ''
    });
    mirrorBridgePrivate(client, room, response, ownAlias);
    return response;
}

function bridgeHistory(room, ownAlias, client) {
    /* present = hold the user's line/session (DDial takes the line on it; on
       MRC any poll does, which is why bridgePresenceAllowed gates MRC polls). */
    var response = bridgePoll(room, ownAlias, bridgePresent(room), client);
    if (!response || !response.ok) {
        var why = response && response.error ? response.error : (BRIDGE_ROOMS[room].label + ' is unavailable right now');
        return { channel: room, messages: [{ sender: '', system: '', text: why, timestamp: Date.now(), userNumber: 0, isSelf: false }], bridge: room };
    }
    /* The network's own room topic (MRC ROOMTOPIC), pipe colour codes dropped. */
    var topic = String(response.topic || '').replace(/\|\d\d/g, '').replace(/^\s+|\s+$/g, '').substr(0, 200);
    return {
        channel: room, messages: bridgeMessages(room, response, ownAlias), bridge: room, topic: topic,
        room: String(response.room || ''), nick: String(response.nick || ''), userCount: response.userCount || 0
    };
}

function bridgeWho(room, ownAlias) {
    var response = bridgeRequest(room, { op: 'who', user: ownAlias, room: room === 'mrc' ? requestedBridgeRoom() : '' });
    var users = [];
    var list = response && response.ok && response.users ? response.users : [];
    for (var i = 0; i < list.length; i += 1) {
        var entry = list[i];
        var nick = typeof entry === 'string' ? entry : String(entry && entry.handle ? entry.handle : '');
        if (!nick.length) { continue; }
        var person = AvatarProfiles.apply({
            nick: nick,
            system: typeof entry === 'string' ? 'MRC' : String(entry.origin || 'DDial'),
            userNumber: bridgeLocalUserNumber(nick)
        }, nick);
        person.bridge = room;
        /* The handle as its line last painted it on the net (DDial). */
        var nickColors = typeof entry === 'string' ? null : bridgeColorRuns(entry.colors, nick.length, 0);
        if (nickColors && person.nick === nick) { person.nickColors = nickColors; }
        users.push(person);
    }
    return { channel: room, users: users, bridge: room, room: String(response && response.room || '') };
}

/* Room-list rows. DDial is summarised with a poll (costs nothing: no line is
   taken). MRC is NOT polled here: a poll IS a login there, and listing the
   room must not announce the user to the network - only opening it does. */
/* On MRC every poll keeps the user logged in to the network. Only do that
   while they are looking at the chat page (active=1) or have asked to stay
   on the network from the rest of the site (hold=mrc, set when they open the
   tab and cleared by Leave); otherwise the session is left to expire.
   DDial reads take no line and announce nothing, so they are always fine. */
function bridgePresenceAllowed(room) {
    if (room !== 'mrc') { return true; }
    return bridgePresent(room);
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
            var historyBridge = bridgeRoomFor(historyChannel);
            reply = !isAuthedUser() ? lockedHistory(historyChannel)
                : bridgePresenceAllowed(historyBridge)
                    /* on a JSONClient so private messages in the poll can be stored */
                    ? withClient(function (client) { return bridgeHistory(historyBridge, user.alias, client); })
                    : { channel: historyChannel, messages: [], bridge: historyBridge };
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
            var polledBridges = {};
            if (syncBridge) {
                /* The open room is DDial/MRC: served by its mux, not the JSON DB.
                   For MRC this poll is also the keep-alive for the user's session. */
                if (bridgePresenceAllowed(syncBridge)) {
                    if (syncWantHistory) {
                        out.history = bridgeHistory(syncBridge, ownAlias, client);
                        polledBridges[syncBridge] = out.history;
                    }
                    if (syncWantWho) { out.who = bridgeWho(syncBridge, ownAlias); }
                }
            }
            if (isAuthed) {
                /* Networks the user is staying on from elsewhere on the site:
                   one presence poll each keeps the session (and the line) and
                   brings in any private messages, which the private section
                   below then lists. */
                var held = heldBridges();
                var heldName;
                for (heldName in held) {
                    if (!Object.prototype.hasOwnProperty.call(held, heldName) || polledBridges[heldName]) { continue; }
                    polledBridges[heldName] = bridgePoll(heldName, ownAlias, true, client);
                }
                /* The room list's MRC row is never polled on its own (that is a
                   login); fill it from a poll this request made anyway. */
                if (out.channels && polledBridges.mrc && polledBridges.mrc.ok !== false) {
                    for (var mi = 0; mi < out.channels.length; mi += 1) {
                        if (out.channels[mi].bridge === 'mrc') {
                            out.channels[mi].userCount = polledBridges.mrc.userCount || 0;
                            out.channels[mi].room = String(polledBridges.mrc.room || '');
                        }
                    }
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
        var targetBridge = bridgeName(getRequestText('bridge'));
        /* read=1: the thread is on screen, so everything in it is read now. */
        var markRead = getRequestText('read') === '1';

        if (!targetAlias.length) {
            reply = { error: 'target required' };
            break;
        }

        reply = withClient(function (client) {
            var result = loadPrivateHistory(client, user.alias, targetAlias, targetSystem, targetBridge);
            if (markRead) {
                updateThreadState(client, user.alias,
                    threadStateKey({ name: targetAlias, host: targetSystem, bridge: targetBridge }),
                    { readAt: Date.now() });
            }
            result.serverTime = Date.now();
            return result;
        });
        break;

    case 'threadState':
        /* Per-thread read / dismissed state (sidebar management). */
        if (http_request.method !== 'POST') {
            reply = { error: 'POST required' };
            break;
        }

        if (user.number < 1 || user.alias === settings.guest) {
            reply = { error: 'authentication required' };
            break;
        }

        var stateTarget = sanitizeAlias(getRequestText('target'));
        var stateSystem = trimText(getRequestText('system'));
        var stateBridge = bridgeName(getRequestText('bridge'));
        var statePatch = {};
        var stateNow = Date.now();

        if (!stateTarget.length) {
            reply = { error: 'target required' };
            break;
        }
        if (getRequestText('read') === '1') { statePatch.readAt = stateNow; }
        if (getRequestText('dismiss') === '1') { statePatch.dismissedAt = stateNow; statePatch.readAt = stateNow; }
        if (getRequestText('restore') === '1') { statePatch.dismissedAt = 0; }

        reply = withClient(function (client) {
            updateThreadState(client, user.alias,
                threadStateKey({ name: stateTarget, host: stateSystem, bridge: stateBridge }), statePatch);
            return { success: true, target: stateTarget, serverTime: stateNow };
        });
        break;

    case 'rooms':
        /* MRC's room list, via the user's web session (opening the picker is
           part of being in the MRC tab, so the login this implies is expected). */
        if (!isAuthedUser()) {
            reply = { error: 'authentication required' };
            break;
        }
        if (bridgeRoomFor(getChannel()) !== 'mrc') {
            reply = { error: 'not found' };
            break;
        }
        var roomsReply = bridgeRequest('mrc', { op: 'rooms', user: user.alias, room: requestedBridgeRoom() });
        reply = roomsReply && roomsReply.ok
            ? { rooms: Array.isArray(roomsReply.rooms) ? roomsReply.rooms : [], pending: !!roomsReply.pending,
                room: String(roomsReply.room || ''), serverTime: Date.now() }
            : { error: roomsReply && roomsReply.error ? roomsReply.error : 'MRC is unavailable right now' };
        break;

    case 'leave':
        /* Log the user off a bridged network now (the Leave button), instead
           of waiting for the mux's idle timeout. */
        if (http_request.method !== 'POST') {
            reply = { error: 'POST required' };
            break;
        }
        if (!isAuthedUser()) {
            reply = { error: 'authentication required' };
            break;
        }
        var leaveRoom = bridgeRoomFor(getChannel());
        if (!leaveRoom) {
            reply = { error: 'not found' };
            break;
        }
        var leaveReply = bridgeRequest(leaveRoom, { op: 'leave', user: user.alias });
        reply = leaveReply && leaveReply.ok
            ? { success: true, channel: leaveRoom, serverTime: Date.now() }
            : { error: leaveReply && leaveReply.error ? leaveReply.error : 'That network is unavailable right now' };
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
            joinRoomMembership(client, user.alias, createChannelName);
            return {
                success: true,
                channel: createChannelName,
                serverTime: Date.now()
            };
        });
        break;

    case 'joinRoom':
        /* Join-or-create: puts the room in the user's sidebar. Same rules as
           createChannel (a fresh name must not be a user's mailbox). */
        if (http_request.method !== 'POST') {
            reply = { error: 'POST required' };
            break;
        }
        if (user.number < 1 || user.alias === settings.guest) {
            reply = { error: 'authentication required' };
            break;
        }
        var joinChannelName = getChannel();
        if (bridgeRoomFor(joinChannelName)) {
            reply = { error: 'invalid channel' };
            break;
        }
        reply = withClient(function (client) {
            if (!isWritablePublicChannel(client, joinChannelName)) {
                return { error: 'invalid channel' };
            }
            ensureHistoryArray(client, 'channels.' + joinChannelName + '.history');
            registerPublicChannel(client, joinChannelName);
            joinRoomMembership(client, user.alias, joinChannelName);
            return { success: true, channel: joinChannelName, serverTime: Date.now() };
        });
        break;

    case 'leaveRoom':
        /* Drop a room from the sidebar; the room itself is untouched. */
        if (http_request.method !== 'POST') {
            reply = { error: 'POST required' };
            break;
        }
        if (user.number < 1 || user.alias === settings.guest) {
            reply = { error: 'authentication required' };
            break;
        }
        var leaveChannelName = getChannel();
        reply = withClient(function (client) {
            leaveRoomMembership(client, user.alias, leaveChannelName);
            return { success: true, channel: leaveChannelName, serverTime: Date.now() };
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
            /* Speaking in a room is being in it. */
            joinRoomMembership(client, user.alias, sendChannel);
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
        var privateBridge = bridgeName(getRequestText('bridge'));
        var privateMessageText = getRequestText('message');

        if (!privateTarget.length) {
            reply = { error: 'target required' };
            break;
        }

        if (!privateMessageText.length) {
            reply = { error: 'empty message' };
            break;
        }

        if (privateBridge) {
            /* A PM to someone on DDial/MRC goes through that network's mux,
               then a copy is kept in the web_pm store so the thread exists
               here (the network itself echoes nothing back to the sender). */
            if (!bridgeRoomFor(privateBridge)) {
                reply = { error: 'That network is not available' };
                break;
            }
            var privateWire = bridgeWireText(privateMessageText);
            if (!privateWire.length || privateWire.indexOf('[BITMAP|') === 0) {
                reply = { error: 'Only plain text can be sent over ' + BRIDGE_ROOMS[privateBridge].label };
                break;
            }
            var privateSent = bridgeRequest(privateBridge, {
                op: 'send', user: user.alias, text: privateWire, to: privateTarget,
                room: privateBridge === 'mrc' ? requestedBridgeRoom() : ''
            });
            if (!privateSent || !privateSent.ok) {
                reply = { error: privateSent && privateSent.error ? privateSent.error : 'That network is unavailable right now' };
                break;
            }
            reply = withClient(function (client) {
                var sentAt = Date.now();
                var ownPacket = buildPrivateMessage(buildOwnNick(),
                    { name: privateTarget, host: privateSystem || undefined, bridge: privateBridge }, privateWire, sentAt);
                ownPacket.bkey = 'self:' + privateBridge + ':' + String(sentAt);
                appendBridgePrivate(client, user.alias, [ownPacket]);
                updateThreadState(client, user.alias,
                    threadStateKey({ name: privateTarget, host: privateSystem, bridge: privateBridge }), { readAt: sentAt });
                return { success: true, target: privateTarget, bridge: privateBridge, timestamp: sentAt, serverTime: sentAt };
            });
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
            /* Replying reads the thread. */
            updateThreadState(client, user.alias,
                threadStateKey({ name: privateTarget, host: privateSystem }), { readAt: packet.time });

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
