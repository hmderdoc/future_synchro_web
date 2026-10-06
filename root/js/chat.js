/* chat.js - Global ChatService singleton
 *
 * Lives in the persistent SPA shell.
 * Manages dynamic chat SSE, room/thread state, unread badges, toasts, and page-facing chat actions.
 */
(function () {
    'use strict';

    if (window.ChatService) return;

    var DEFAULT_CHANNEL = 'main';
    var MAX_MESSAGES = 200;
    var TOAST_DURATION = 30000;
    var MAX_TOASTS = 4;
    var RECONCILE_INTERVAL = 15000;
    var BRIDGE_POLL_INTERVAL = 4000;
    var _bridgeTimer = null;
    var RECONNECT_DELAY = 4000;
    var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    var DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    var DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

    var _messages = [];
    var _users = [];
    /* Join/leave lines per room (upper-cased name), merged into the room's
       messages by time: history reloads replace _messages, not these. */
    var _presenceNotices = {};
    var MAX_PRESENCE_NOTICES = 50;
    var _rooms = [];
    var _privateThreads = [];
    var _onlinePeerKeys = {};
    var _onlinePeerNames = {};
    var _unreadChannels = {};
    var _unreadPrivate = {};
    var _chatPageActive = false;
    var _unreadCount = 0;
    var _eventSource = null;
    var _reconcileTimer = 0;
    var _sendRefreshTimer = 0;
    var _reconnectTimer = 0;
    var _reconnectAttemptCount = 0;
    var _realtimeHealthy = false;
    var _serviceHealthy = true;
    var _lastRoomPollAt = 0;
    var _lastPrivatePollAt = 0;
    var _usersRefreshTick = 0;
    var _currentChannel = DEFAULT_CHANNEL;
    var _activeView = { type: 'channel', name: DEFAULT_CHANNEL, system: '', avatar: '', bridge: '' };
    var _status = { type: '', message: '', showRetry: false };
    var _guestMode = false;
    var _bitmapRecords = {};
    // Bridged networks (DDial / MRC) the user is staying logged in to from any
    // page of the site: set when they open the tab, cleared by Leave. Kept in
    // localStorage so a reload does not log them off and back on.
    var _bridgeHold = {};
    // MRC room the user picked ('' = the mux default).
    var _bridgeRoom = { mrc: '', irc: '' };
    // Who is on each bridged network, from its last who-list: nameKey -> true.
    var _bridgeOnline = { mrc: {}, ddial: {} };
    var _markReadTimer = 0;
    // Local rooms whose join we have posted but not yet seen confirmed.
    var _pendingJoin = {};
    var HOLD_STORAGE_KEY = 'chatBridgeHold';
    var ROOM_STORAGE_KEY = 'chatBridgeRoom';
    var IRC_ROOM_STORAGE_KEY = 'chatIrcRoom';
    // Newest network sequence number shown to the user, per bridged network:
    // the server counts a network's unread room messages from here (only
    // while the user is on that network, like a joined local room).
    var SEEN_STORAGE_KEY = 'chatBridgeSeen';
    var _bridgeSeen = {};
    // Networks whose count this page load has already shown once: the first
    // count after a (re)load is old news, not something to toast.
    var _bridgeCountShown = {};
    // Chat messages already announced on this device: every open tab runs
    // its own stream and sync, and the network counts can repeat their
    // latest message, so a desktop notification is claimed here first
    // (shared by all tabs) and a toast once per tab.
    var ANNOUNCED_STORAGE_KEY = 'chatAnnounced';
    var ANNOUNCED_TTL_MS = 30 * 60 * 1000;
    var _toasted = {};

    function loadBridgeSeen() {
        _bridgeSeen = {};
        String(readStorage(SEEN_STORAGE_KEY) || '').split(',').forEach(function (pair) {
            var parts = pair.split(':');
            var net = normalizeBridge(parts[0]);
            var seq = parseInt(parts[1], 10);
            if (net && seq > 0) _bridgeSeen[net] = seq;
        });
    }

    function setBridgeSeen(net, seq) {
        net = normalizeBridge(net);
        if (!net || !(seq > 0) || _bridgeSeen[net] === seq) return;
        _bridgeSeen[net] = seq;
        writeStorage(SEEN_STORAGE_KEY, Object.keys(_bridgeSeen).map(function (k) { return k + ':' + _bridgeSeen[k]; }).join(','));
    }

    /* Which kind of chat notification a message is (mods/load/notify_lib.js
       CHAT_KINDS): a message in a room here that says your name is a mention. */
    function chatKind(msg) {
        if (msg.type === 'private') return 'chat_private';
        if (msg.bridge === 'mrc') return 'chat_mrc';
        if (msg.bridge === 'ddial') return 'chat_ddial';
        if (msg.bridge === 'irc') return 'chat_irc';
        var me = (window.sbbsConfig && window.sbbsConfig.userAlias) || '';
        var said = String(getMessageText(msg) || msg.previewText || '');
        if (me && new RegExp('(^|[^a-z0-9])@?' + me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)', 'i').test(said)) {
            return 'chat_mention';
        }
        return 'chat_local';
    }

    /* How the user wants that kind announced: 'off', 'web' (toast),
       'native' (desktop notification) or 'both' (Settings > Notifications). */
    function chatMode(kind) {
        var prefs = window.sbbsConfig && window.sbbsConfig.notifyPrefs;
        var mode = prefs && prefs.chat && prefs.chat[kind];
        if (mode) return mode;
        return kind === 'chat_private' || kind === 'chat_mention' ? 'both' : 'web';
    }

    function readStorage(key) {
        try { return window.localStorage ? window.localStorage.getItem(key) : null; } catch (_e) { return null; }
    }

    function writeStorage(key, value) {
        try {
            if (!window.localStorage) return;
            if (value === null) window.localStorage.removeItem(key);
            else window.localStorage.setItem(key, value);
        } catch (_e) {}
    }

    function loadBridgeState() {
        var held = String(readStorage(HOLD_STORAGE_KEY) || '').split(',');
        var room = String(readStorage(ROOM_STORAGE_KEY) || '');
        _bridgeHold = {};
        held.forEach(function (name) {
            if (isBridgeRoom(name)) _bridgeHold[name.toLowerCase()] = true;
        });
        _bridgeRoom.mrc = sanitizeBridgeRoomName(room);
        _bridgeRoom.irc = sanitizeBridgeRoomName(readStorage(IRC_ROOM_STORAGE_KEY) || '');
        loadBridgeSeen();
    }

    function heldBridgeNames() {
        return Object.keys(_bridgeHold).filter(function (name) { return !!_bridgeHold[name]; });
    }

    function saveBridgeHold() {
        var names = heldBridgeNames();
        writeStorage(HOLD_STORAGE_KEY, names.length ? names.join(',') : null);
    }

    function sanitizeBridgeRoomName(raw) {
        return String(raw || '').replace(/^#/, '').replace(/[^A-Za-z0-9_.-]/g, '').substr(0, 30);
    }

    function normalizeBridge(raw) {
        var key = String(raw || '').toLowerCase();
        return key === 'mrc' || key === 'ddial' || key === 'irc' ? key : '';
    }

    function bridgeTitle(net) {
        return net === 'mrc' ? 'MRC' : net === 'irc' ? 'IRC' : 'DDial';
    }

    // Presence / room parameters every request that touches a bridged
    // network carries: active = the chat page is showing, hold = networks to
    // stay on regardless, room = the MRC room the user wants.
    function bridgeQuery() {
        var held = heldBridgeNames();
        return '&active=' + (_chatPageActive ? '1' : '0')
            + (held.length ? '&hold=' + encodeURIComponent(held.join(',')) : '')
            + (_bridgeRoom.mrc ? '&room=' + encodeURIComponent(_bridgeRoom.mrc) : '')
            + (_bridgeRoom.irc ? '&ircroom=' + encodeURIComponent(_bridgeRoom.irc) : '')
            + (Object.keys(_bridgeSeen).length
                ? '&seen=' + encodeURIComponent(Object.keys(_bridgeSeen).map(function (k) { return k + ':' + _bridgeSeen[k]; }).join(','))
                : '');
    }

    function trimText(value) {
        return String(value || '').replace(/^\s+|\s+$/g, '');
    }

    function normalizeUpper(value) {
        return trimText(value).toUpperCase();
    }

    function sanitizeChannelName(raw) {
        var channel = String(raw || DEFAULT_CHANNEL).replace(/[^a-zA-Z0-9_-]/g, '');
        return channel.length ? channel : DEFAULT_CHANNEL;
    }

    function sanitizeAlias(raw) {
        return trimText(String(raw || '')).replace(/[\x00-\x1f]/g, '').substr(0, 60);
    }

    function buildNameKey(name) {
        return normalizeUpper(name).replace(/[^A-Z0-9]/g, '');
    }

    // One thread per person: per BBS for this system's chat, per NETWORK for
    // DDial/MRC (a nick's site or line may change between messages). Mirrors
    // buildThreadKey in api/chat.ssjs.
    function buildThreadKey(name, system, bridge) {
        var net = normalizeBridge(bridge);
        if (net) {
            return buildNameKey(name) + '|@' + net.toUpperCase();
        }
        return buildNameKey(name) + '|' + normalizeUpper(system);
    }

    function threadKeyOf(thread) {
        return buildThreadKey(thread.name, thread.system || '', thread.bridge || '');
    }

    function getCurrentPrivateKey() {
        if (_activeView.type !== 'private') {
            return '';
        }
        return buildThreadKey(_activeView.name, _activeView.system || '', _activeView.bridge || '');
    }

    function isLoggedIn() {
        return !!(window.sbbsConfig && window.sbbsConfig.isLoggedIn);
    }

    function dispatch(name, detail) {
        window.dispatchEvent(new CustomEvent('chat:' + name, { detail: detail }));
    }

    function cloneStatus() {
        return {
            type: _status.type,
            message: _status.message,
            showRetry: _status.showRetry
        };
    }

    function updateBadge() {
        var total = 0;
        var key;
        var badge = document.getElementById('badge-chat-unread');

        for (key in _unreadChannels) {
            if (Object.prototype.hasOwnProperty.call(_unreadChannels, key)) {
                total += _unreadChannels[key] || 0;
            }
        }
        for (key in _unreadPrivate) {
            if (Object.prototype.hasOwnProperty.call(_unreadPrivate, key)) {
                total += _unreadPrivate[key] || 0;
            }
        }

        _unreadCount = total;

        if (badge) {
            if (total > 0) {
                badge.textContent = total > 99 ? '99+' : String(total);
                badge.style.display = '';
            } else {
                badge.textContent = '';
                badge.style.display = 'none';
            }
        }
    }

    function rebuildOnlinePresence(entries) {
        var nextKeys = {};
        var nextNames = {};

        (entries || []).forEach(function (entry) {
            var name = sanitizeAlias(entry && (entry.nick || entry.name) || '');
            var system = trimText(entry && entry.system || '');
            var nameKey = buildNameKey(name);

            if (!nameKey.length) {
                return;
            }

            nextKeys[buildThreadKey(name, system)] = true;
            nextNames[nameKey] = true;
        });

        _onlinePeerKeys = nextKeys;
        _onlinePeerNames = nextNames;
        dispatchPrivateThreads();
    }

    function isThreadOnline(name, system, bridge) {
        var net = normalizeBridge(bridge);
        var exactKey = buildThreadKey(name, system || '');
        var nameKey = buildNameKey(name);

        if (net) {
            return !!(_bridgeOnline[net] && _bridgeOnline[net][nameKey]);
        }

        if (_onlinePeerKeys[exactKey]) {
            return true;
        }

        if (!trimText(system).length && _onlinePeerNames[nameKey]) {
            return true;
        }

        return false;
    }

    function escapeHtml(str) {
        var d = document.createElement('div');
        d.appendChild(document.createTextNode(str || ''));
        return d.innerHTML;
    }

    function isBitmapMessageText(text) {
        return typeof text === 'string' && text.indexOf('[BITMAP|') === 0 && text.charAt(text.length - 1) === ']';
    }

    function parseBitmapMessage(text) {
        var inner = '';
        var parts = [];
        var width = 0;
        var height = 0;

        if (!isBitmapMessageText(text)) {
            return null;
        }

        inner = text.slice(1, -1);
        parts = inner.split('|');

        if (parts.length !== 5 || parts[0] !== 'BITMAP') {
            return null;
        }

        width = parseInt(parts[1] || '', 10) || 0;
        height = parseInt(parts[2] || '', 10) || 0;

        if (width < 1 || height < 1 || !(parts[4] || '').length || ((parts[4] || '').length % 2) !== 0) {
            return null;
        }

        return {
            width: width,
            height: height,
            fromName: parts[3] || '',
            hexData: parts[4] || ''
        };
    }

    function buildBitmapPreview(parsed) {
        if (!parsed) {
            return '[image]';
        }

        return '[image ' + String(parsed.width || 0) + 'x' + String(parsed.height || 0) + ']';
    }

    function buildMessagePreview(text) {
        var parsed = parseBitmapMessage(text);

        if (parsed) {
            return buildBitmapPreview(parsed);
        }

        // Mystic/MRC pipe colour codes (|00-|23) colour the bubble on the chat
        // page (chat-embeds.js); a toast or thread preview is plain text, so
        // drop them rather than show "|22". Control markers keep their pipes.
        if (/^\s*\[(BITMAP|TVTUNER)\|/.test(String(text || ''))) {
            return String(text || '');
        }
        return String(text || '').replace(/\|(0[0-9]|1[0-9]|2[0-3])/g, '');
    }

    function buildBitmapKey(text) {
        var value = String(text || '');
        var hash = 5381;
        var index = 0;
        var key;
        var suffix = 1;
        var base;

        for (index = 0; index < value.length; index += 1) {
            hash = (((hash << 5) + hash) + value.charCodeAt(index)) >>> 0;
        }

        base = 'bmp-' + hash.toString(16) + '-' + String(value.length);
        key = base;

        while (_bitmapRecords[key] && _bitmapRecords[key].sourceText !== value) {
            suffix += 1;
            key = base + '-' + String(suffix);
        }

        return key;
    }

    function ensureBitmapRecord(text) {
        var parsed = parseBitmapMessage(text);
        var key;

        if (!parsed) {
            return null;
        }

        key = buildBitmapKey(text);
        if (!_bitmapRecords[key]) {
            _bitmapRecords[key] = {
                key: key,
                sourceText: String(text || ''),
                fromName: parsed.fromName || '',
                width: parsed.width || 0,
                height: parsed.height || 0,
                actualWidth: 0,
                actualHeight: 0,
                previewText: buildBitmapPreview(parsed),
                bitmap: null,
                dataURL: '',
                renderPending: false,
                error: ''
            };
        }

        return _bitmapRecords[key];
    }

    function copyOwnProperties(source) {
        var target = {};
        var key;

        if (!source) {
            return target;
        }

        for (key in source) {
            if (Object.prototype.hasOwnProperty.call(source, key)) {
                target[key] = source[key];
            }
        }

        return target;
    }

    function getMessageText(message) {
        if (!message) {
            return '';
        }

        if (typeof message.text === 'string') {
            return message.text;
        }

        if (typeof message.str === 'string') {
            return message.str;
        }

        return '';
    }

    function normalizeThreadSummary(summary) {
        var next = copyOwnProperties(summary);

        if (typeof next.preview === 'string' && next.preview.length) {
            next.preview = buildMessagePreview(next.preview);
        }

        return next;
    }

    function normalizeMessage(message) {
        var next = copyOwnProperties(message);
        var text = getMessageText(next);
        var record;

        next.text = text;
        next.previewText = buildMessagePreview(text);
        next.kind = 'text';

        record = ensureBitmapRecord(text);
        if (record) {
            next.kind = 'bitmap';
            next.bitmapKey = record.key;
            next.bitmapWidth = record.width || 0;
            next.bitmapHeight = record.height || 0;
            next.bitmapFromName = record.fromName || '';
            next.previewText = record.previewText;
        }

        return next;
    }

    function normalizeMessages(messages) {
        return (messages || []).map(function (message) {
            return normalizeMessage(message);
        });
    }

    function buildMessageIdentity(message) {
        return [
            String(message && (message.timestamp || 0)),
            String(message && (message.sender || '')),
            String(message && (message.system || '')),
            String(message && (message.channel || '')),
            String(message && (message.userNumber || 0)),
            String(message && (message.avatar || '')),
            String(getMessageText(message)),
            String(message && (message.kind || '')),
            String(message && (message.bitmapKey || ''))
        ].join('\u001f');
    }

    function messagesMatch(currentMessages, nextMessages) {
        var index = 0;

        if ((currentMessages || []).length !== (nextMessages || []).length) {
            return false;
        }

        for (index = 0; index < currentMessages.length; index += 1) {
            if (buildMessageIdentity(currentMessages[index]) !== buildMessageIdentity(nextMessages[index])) {
                return false;
            }
        }

        return true;
    }

    function hexToBytes(hex) {
        var bytes = [];
        var index = 0;

        for (index = 0; index < hex.length; index += 2) {
            bytes.push(parseInt(hex.substr(index, 2), 16) || 0);
        }

        return bytes;
    }

    function bytesToHex(bytes) {
        var hex = '';
        for (var i = 0; i < bytes.length; i++) {
            var b = bytes[i].toString(16);
            if (b.length < 2) b = '0' + b;
            hex += b;
        }
        return hex;
    }

    /**
     * Convert a CGA-order color index (0-15) to xterm-order.
     * CGA:   0=Blk 1=Blu 2=Grn 3=Cyn 4=Red 5=Mag 6=Brn 7=LGry  (+8 bright)
     * Xterm: 0=Blk 1=Red 2=Grn 3=Brn 4=Blu 5=Mag 6=Cyn 7=LGry  (+8 bright)
     * Swaps: 1<->4, 3<->6 on the low 3 bits; preserves bright bit.
     */
    function cgaToXterm(c) {
        var lo = c & 7;
        if (lo === 1) lo = 4;
        else if (lo === 4) lo = 1;
        else if (lo === 3) lo = 6;
        else if (lo === 6) lo = 3;
        return (c & 8) | lo;
    }

    /**
     * Encode cell grid into the BITMAP binary format.
     * cells: array of {code, fg, bg} (from AnsiEditor TextDocument - CGA order)
     * width/height: grid dimensions
     * Returns Uint8Array: [height, ...fgSlice, ...bgSlice, ...charSlice]
     * Color indices are converted from CGA to xterm order for the renderer.
     */
    function encodeBitmapRaw(cells, width, height) {
        var total = width * height;
        var buf = new Uint8Array(1 + total * 3);
        buf[0] = height;
        for (var i = 0; i < total; i++) {
            var cell = cells[i] || { code: 32, fg: 7, bg: 0 };
            buf[1 + i] = cgaToXterm(cell.fg) & 0xFF;               // fg slice
            buf[1 + total + i] = cgaToXterm(cell.bg) & 0xFF;       // bg slice
            buf[1 + total * 2 + i] = (cell.code || 32) & 0xFF;     // char slice
        }
        return buf;
    }

    /**
     * Compress bytes using browser-native CompressionStream (zlib/deflate).
     * Returns a Promise<Uint8Array> of zlib-compressed data.
     */
    function compressZlib(rawBytes) {
        var cs = new CompressionStream('deflate');
        var writer = cs.writable.getWriter();
        writer.write(rawBytes);
        writer.close();
        return new Response(cs.readable).arrayBuffer().then(function (buf) {
            return new Uint8Array(buf);
        });
    }

    /**
     * Build a complete [BITMAP|w|h|fromName|hexData] payload string.
     * cells: array of {code, fg, bg}
     * width, height: integer dimensions
     * fromName: sender alias
     * Returns Promise<string>
     */
    function buildBitmapPayload(cells, width, height, fromName) {
        var raw = encodeBitmapRaw(cells, width, height);
        return compressZlib(raw).then(function (compressed) {
            var hex = bytesToHex(compressed);
            return '[BITMAP|' + width + '|' + height + '|' + (fromName || '') + '|' + hex + ']';
        });
    }


    function createInflateState(bytes, offset) {
        return {
            bytes: bytes,
            position: offset,
            bitBuffer: 0,
            bitCount: 0
        };
    }

    function readByte(state) {
        var value = state.bytes[state.position];
        state.position += 1;
        return value === undefined ? 0 : value;
    }

    function readBits(state, count) {
        var buffer = state.bitBuffer;
        var available = state.bitCount;
        var out = 0;

        while (available < count) {
            buffer |= readByte(state) << available;
            available += 8;
        }

        out = buffer & ((1 << count) - 1);
        state.bitBuffer = buffer >>> count;
        state.bitCount = available - count;
        return out;
    }

    function alignByte(state) {
        state.bitBuffer = 0;
        state.bitCount = 0;
    }

    function reverseBits(value, count) {
        var result = 0;
        var index = 0;

        for (index = 0; index < count; index += 1) {
            result = (result << 1) | (value & 1);
            value >>= 1;
        }

        return result;
    }

    function buildHuffmanTable(codeLengths) {
        var table = {
            maxBits: 0,
            map: {}
        };
        var counts = [];
        var nextCodes = [];
        var code = 0;
        var index = 0;

        for (index = 0; index < codeLengths.length; index += 1) {
            if ((codeLengths[index] || 0) > table.maxBits) {
                table.maxBits = codeLengths[index] || 0;
            }
        }

        for (index = 0; index <= table.maxBits; index += 1) {
            counts[index] = 0;
        }

        for (index = 0; index < codeLengths.length; index += 1) {
            counts[codeLengths[index] || 0] = (counts[codeLengths[index] || 0] || 0) + 1;
        }

        counts[0] = 0;
        for (index = 1; index <= table.maxBits; index += 1) {
            code = (code + (counts[index - 1] || 0)) << 1;
            nextCodes[index] = code;
        }

        for (index = 0; index < codeLengths.length; index += 1) {
            var length = codeLengths[index] || 0;
            var nextCode;
            var key;

            if (!length) {
                continue;
            }

            nextCode = nextCodes[length] || 0;
            key = String(reverseBits(nextCode, length) | (length << 16));
            table.map[key] = index;
            nextCodes[length] = nextCode + 1;
        }

        return table;
    }

    function readHuffmanCode(table, state) {
        var code = 0;
        var length = 0;
        var key;

        for (length = 1; length <= table.maxBits; length += 1) {
            code |= readBits(state, 1) << (length - 1);
            key = String(code | (length << 16));
            if (table.map[key] !== undefined) {
                return table.map[key] || 0;
            }
        }

        throw new Error('Huffman decode failed');
    }

    function buildFixedLiteralTable() {
        var lengths = [];
        var index = 0;

        for (index = 0; index <= 287; index += 1) {
            lengths[index] = 0;
        }
        for (index = 0; index <= 143; index += 1) {
            lengths[index] = 8;
        }
        for (index = 144; index <= 255; index += 1) {
            lengths[index] = 9;
        }
        for (index = 256; index <= 279; index += 1) {
            lengths[index] = 7;
        }
        for (index = 280; index <= 287; index += 1) {
            lengths[index] = 8;
        }

        return buildHuffmanTable(lengths);
    }

    function buildFixedDistanceTable() {
        var lengths = [];
        var index = 0;

        for (index = 0; index < 32; index += 1) {
            lengths[index] = 5;
        }

        return buildHuffmanTable(lengths);
    }

    function decodeDynamicTables(state) {
        var hlit = readBits(state, 5) + 257;
        var hdist = readBits(state, 5) + 1;
        var hclen = readBits(state, 4) + 4;
        var order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        var codeLengths = [];
        var index = 0;
        var codeTable;

        for (index = 0; index < 19; index += 1) {
            codeLengths[index] = 0;
        }

        for (index = 0; index < hclen; index += 1) {
            codeLengths[order[index] || 0] = readBits(state, 3);
        }

        codeTable = buildHuffmanTable(codeLengths);

        function readLengths(count) {
            var out = [];
            var previous = 0;

            while (out.length < count) {
                var symbol = readHuffmanCode(codeTable, state);
                var repeat = 0;
                var repeatIndex = 0;

                if (symbol <= 15) {
                    out.push(symbol);
                    previous = symbol;
                    continue;
                }

                if (symbol === 16) {
                    repeat = 3 + readBits(state, 2);
                    for (repeatIndex = 0; repeatIndex < repeat; repeatIndex += 1) {
                        out.push(previous);
                    }
                    continue;
                }

                if (symbol === 17) {
                    repeat = 3 + readBits(state, 3);
                    previous = 0;
                    for (repeatIndex = 0; repeatIndex < repeat; repeatIndex += 1) {
                        out.push(0);
                    }
                    continue;
                }

                if (symbol === 18) {
                    repeat = 11 + readBits(state, 7);
                    previous = 0;
                    for (repeatIndex = 0; repeatIndex < repeat; repeatIndex += 1) {
                        out.push(0);
                    }
                    continue;
                }

                throw new Error('Bad RLE in code lengths');
            }

            return out;
        }

        return {
            lit: buildHuffmanTable(readLengths(hlit)),
            dist: buildHuffmanTable(readLengths(hdist))
        };
    }

    function inflateRaw(bytes, start) {
        var state = createInflateState(bytes, start);
        var output = [];
        var fixedLiterals = buildFixedLiteralTable();
        var fixedDistances = buildFixedDistanceTable();
        var done = false;

        while (!done) {
            var isFinal = readBits(state, 1);
            var blockType = readBits(state, 2);
            var literalTable = null;
            var distanceTable = null;
            var length = 0;
            var notLength = 0;
            var index = 0;

            if (blockType === 0) {
                alignByte(state);
                length = readByte(state) | (readByte(state) << 8);
                notLength = readByte(state) | (readByte(state) << 8);
                if ((length ^ 65535) !== notLength) {
                    throw new Error('Stored block length mismatch');
                }
                for (index = 0; index < length; index += 1) {
                    output.push(readByte(state));
                }
            } else {
                if (blockType === 1) {
                    literalTable = fixedLiterals;
                    distanceTable = fixedDistances;
                } else if (blockType === 2) {
                    var tables = decodeDynamicTables(state);
                    literalTable = tables.lit;
                    distanceTable = tables.dist;
                } else {
                    throw new Error('Invalid DEFLATE block type');
                }

                while (literalTable && distanceTable) {
                    var symbol = readHuffmanCode(literalTable, state);
                    var lengthIndex;
                    var distanceSymbol;
                    var distance;
                    var base;
                    var copyIndex;

                    if (symbol < 256) {
                        output.push(symbol);
                        continue;
                    }
                    if (symbol === 256) {
                        break;
                    }

                    lengthIndex = symbol - 257;
                    length = (LENGTH_BASE[lengthIndex] || 0) + ((LENGTH_EXTRA[lengthIndex] || 0) ? readBits(state, LENGTH_EXTRA[lengthIndex] || 0) : 0);
                    distanceSymbol = readHuffmanCode(distanceTable, state);
                    distance = (DISTANCE_BASE[distanceSymbol] || 0) + ((DISTANCE_EXTRA[distanceSymbol] || 0) ? readBits(state, DISTANCE_EXTRA[distanceSymbol] || 0) : 0);
                    base = output.length - distance;

                    if (base < 0) {
                        throw new Error('Invalid DEFLATE distance');
                    }

                    for (copyIndex = 0; copyIndex < length; copyIndex += 1) {
                        output.push(output[base + copyIndex] || 0);
                    }
                }
            }

            if (isFinal) {
                done = true;
            }
        }

        return output;
    }

    function inflateZlib(bytes, offset) {
        var position = offset || 0;
        var cmf = bytes[position] || 0;
        var flg = bytes[position + 1] || 0;

        position += 2;
        if ((cmf & 15) !== 8) {
            throw new Error('Unsupported zlib compression method');
        }
        if (flg & 32) {
            position += 4;
        }

        return inflateRaw(bytes, position);
    }

    function decodeBitmap(hexData, expectedWidth, expectedHeight) {
        var compressed = hexToBytes(hexData);
        var decompressed = inflateZlib(compressed, 0);
        var bitmap = [];
        var dataHeight = 0;
        var dataLength = 0;
        var slicePoint = 0;
        var totalPixels = 0;
        var dataWidth = 0;
        var width = 0;
        var height = 0;
        var index = 0;

        if (decompressed.length < 4) {
            return {
                bitmap: bitmap,
                width: 0,
                height: 0,
                actualWidth: 0,
                actualHeight: 0
            };
        }

        dataHeight = decompressed[0] || 0;
        if (dataHeight < 1) {
            return {
                bitmap: bitmap,
                width: 0,
                height: 0,
                actualWidth: 0,
                actualHeight: 0
            };
        }

        dataLength = decompressed.length - 1;
        slicePoint = Math.floor(dataLength / 3);
        totalPixels = slicePoint;
        dataWidth = Math.floor(totalPixels / dataHeight);
        width = expectedWidth || dataWidth;
        height = expectedHeight || dataHeight;

        if (width * height !== totalPixels) {
            width = dataWidth;
            height = dataHeight;
        }

        for (index = 0; index < totalPixels; index += 1) {
            bitmap.push({
                charCode: decompressed[1 + slicePoint * 2 + index] || 32,
                fg: decompressed[1 + index] || 0,
                bg: decompressed[1 + slicePoint + index] || 0
            });
        }

        return {
            bitmap: bitmap,
            width: width,
            height: height,
            actualWidth: dataWidth,
            actualHeight: dataHeight
        };
    }

    function decodeBitmapRecord(record) {
        var parsed;
        var decoded;

        if (!record) {
            return null;
        }

        if (record.bitmap && record.width > 0 && record.height > 0) {
            return record;
        }

        parsed = parseBitmapMessage(record.sourceText);
        if (!parsed) {
            throw new Error('Invalid bitmap payload');
        }

        decoded = decodeBitmap(parsed.hexData, parsed.width, parsed.height);
        if (!decoded.bitmap.length || !decoded.width || !decoded.height) {
            throw new Error('Decoded bitmap was empty');
        }

        record.bitmap = decoded.bitmap;
        record.width = decoded.width || parsed.width || 0;
        record.height = decoded.height || parsed.height || 0;
        record.actualWidth = decoded.actualWidth || record.width;
        record.actualHeight = decoded.actualHeight || record.height;
        record.previewText = buildBitmapPreview({ width: record.width, height: record.height });
        return record;
    }

    // CP437 positions that terminals interpret as control codes rather than
    // display; their glyphs can't survive a plain .ans byte stream.
    var ANS_UNSAFE_BYTES = { 7: 1, 8: 1, 9: 1, 10: 1, 12: 1, 13: 1, 26: 1, 27: 1 };

    /**
     * Serialize a decoded bitmap record into .ans body bytes: CP437 chars
     * with ANSI SGR color sequences. fg/bg in record.bitmap are xterm-order,
     * which is exactly the SGR 30-37/40-47 color order.
     * Returns { bytes: number[], ice: boolean } - ice is true when any
     * bright background is used (rendered as blink + SAUCE iCE flag).
     */
    function encodeBitmapAnsBody(record) {
        var bytes = [];
        var cur = { bold: false, blink: false, fg: 7, bg: 0 };
        var ice = false;
        var width = record.width;
        var height = record.height;
        var y;
        var x;
        var last;
        var cell;
        var bold;
        var blink;
        var fg;
        var bg;
        var code;
        var params;

        function sgr(list) {
            var seq = '[' + list.join(';') + 'm';
            var index;
            bytes.push(27);
            for (index = 0; index < seq.length; index += 1) {
                bytes.push(seq.charCodeAt(index));
            }
        }

        for (y = 0; y < height; y += 1) {
            // Trim trailing spaces on the default background; SAUCE keeps
            // the true dimensions either way.
            last = width - 1;
            while (last >= 0) {
                cell = record.bitmap[y * width + last];
                if (cell && ((cell.charCode || 32) !== 32 || (cell.bg || 0) !== 0)) {
                    break;
                }
                last -= 1;
            }

            for (x = 0; x <= last; x += 1) {
                cell = record.bitmap[y * width + x] || { charCode: 32, fg: 7, bg: 0 };
                bold = (cell.fg & 8) !== 0;
                blink = (cell.bg & 8) !== 0;
                fg = cell.fg & 7;
                bg = cell.bg & 7;
                if (blink) {
                    ice = true;
                }

                params = [];
                if ((cur.bold && !bold) || (cur.blink && !blink)) {
                    params.push('0');
                    cur.bold = false;
                    cur.blink = false;
                    cur.fg = 7;
                    cur.bg = 0;
                }
                if (bold && !cur.bold) params.push('1');
                if (blink && !cur.blink) params.push('5');
                if (fg !== cur.fg) params.push('3' + fg);
                if (bg !== cur.bg) params.push('4' + bg);
                if (params.length) {
                    sgr(params);
                    cur.bold = bold;
                    cur.blink = blink;
                    cur.fg = fg;
                    cur.bg = bg;
                }

                code = (cell.charCode || 32) & 0xFF;
                bytes.push(ANS_UNSAFE_BYTES[code] ? 32 : code);
            }

            // Full-width rows get no CRLF: viewers wrap at the SAUCE width
            // and treat an explicit newline after the wrap as a blank row
            // (Moebius's exporter follows the same convention).
            if (y < height - 1 && last + 1 < width) {
                if (cur.bg !== 0 || cur.blink) {
                    sgr(['0']);
                    cur.bold = false;
                    cur.blink = false;
                    cur.fg = 7;
                    cur.bg = 0;
                }
                bytes.push(13, 10);
            }
        }

        sgr(['0']);
        return { bytes: bytes, ice: ice };
    }

    /**
     * Build the 129-byte trailer: EOF (0x1A) + a SAUCE00 record.
     * DataType 1/FileType 1 = Character/ANSi, TInfo1 = width in chars,
     * TInfo2 = line count, TFlags = iCE colors + 8-pixel font.
     */
    function buildSauceTrailer(opts) {
        var buf = new Uint8Array(129);
        var i;

        function putStr(offset, str, len, padByte) {
            var s = String(str || '');
            var index;
            for (index = 0; index < len; index += 1) {
                buf[offset + index] = index < s.length ? (s.charCodeAt(index) & 0xFF) : padByte;
            }
        }

        buf[0] = 26;
        putStr(1, 'SAUCE00', 7, 32);
        putStr(8, opts.title, 35, 32);
        putStr(43, opts.author, 20, 32);
        putStr(63, opts.group, 20, 32);
        putStr(83, opts.date, 8, 32);
        for (i = 0; i < 4; i += 1) {
            buf[91 + i] = (opts.fileSize >>> (i * 8)) & 0xFF;
        }
        buf[95] = 1;
        buf[96] = 1;
        buf[97] = opts.width & 0xFF;
        buf[98] = (opts.width >>> 8) & 0xFF;
        buf[99] = opts.height & 0xFF;
        buf[100] = (opts.height >>> 8) & 0xFF;
        buf[106] = (opts.ice ? 1 : 0) | 2;
        putStr(107, 'IBM VGA', 22, 0);
        return buf;
    }

    /**
     * Save a bitmap chat message as a .ans file (CP437 + SGR colors + SAUCE).
     * timestampMs (the message time) becomes the SAUCE date when provided.
     */
    function downloadBitmapAns(record, timestampMs) {
        var body;
        var date;
        var sauce;
        var out;
        var name;
        var url;
        var link;

        try {
            decodeBitmapRecord(record);
        } catch (_err) {
            return;
        }
        if (!record.bitmap || !record.width || !record.height) {
            return;
        }

        body = encodeBitmapAnsBody(record);
        date = timestampMs ? new Date(timestampMs) : new Date();
        sauce = buildSauceTrailer({
            title: 'webchat drawing',
            author: String(record.fromName || '').slice(0, 20),
            group: String((window.sbbsConfig && window.sbbsConfig.systemName) || '').slice(0, 20),
            date: String(date.getFullYear()) +
                ('0' + (date.getMonth() + 1)).slice(-2) +
                ('0' + date.getDate()).slice(-2),
            fileSize: body.bytes.length,
            width: record.width,
            height: record.height,
            ice: body.ice
        });

        out = new Uint8Array(body.bytes.length + sauce.length);
        out.set(body.bytes, 0);
        out.set(sauce, body.bytes.length);

        name = String(record.fromName || '').replace(/[^A-Za-z0-9_-]+/g, '') || 'chat';
        url = URL.createObjectURL(new Blob([out], { type: 'application/octet-stream' }));
        link = document.createElement('a');
        link.href = url;
        link.download = name + '-' + record.width + 'x' + record.height + '.ans';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    function buildBitmapDownloadButton(el, record) {
        var button = document.createElement('button');
        var ts = parseInt(el.getAttribute('data-chat-bitmap-ts') || '', 10) || 0;

        button.type = 'button';
        button.className = 'chat-bitmap-download';
        button.title = 'Download .ans';
        button.setAttribute('aria-label', 'Download as ANSI file');
        button.innerHTML =
            '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">' +
            '<path d="M7.25 1.5h1.5v6.63l2.44-2.44 1.06 1.06L8 11 3.75 6.75l1.06-1.06 2.44 2.44V1.5z"/>' +
            '<path d="M2.5 12.5h11V14h-11v-1.5z"/></svg>';
        button.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            downloadBitmapAns(record, ts);
        });
        return button;
    }

    function updateBitmapElement(el, record) {
        var text;
        var placeholder;
        var img;

        if (!el) {
            return;
        }

        while (el.firstChild) {
            el.removeChild(el.firstChild);
        }

        el.classList.remove('is-loading', 'is-ready', 'is-error');
        text = el.getAttribute('data-chat-bitmap-alt') || (record && record.previewText) || '[image]';
        if (record && record.width > 0 && record.height > 0) {
            el.style.aspectRatio = String(record.width * 8) + ' / ' + String(record.height * 16);
            if (
                el.parentNode &&
                el.parentNode.parentNode &&
                el.parentNode.parentNode.classList &&
                el.parentNode.parentNode.classList.contains('chat-bitmap-shell')
            ) {
                el.parentNode.parentNode.style.maxWidth = String(record.width * 8) + 'px';
            }
        }

        if (record && record.dataURL) {
            img = new Image();
            img.className = 'chat-bitmap-image';
            img.alt = text;
            img.src = record.dataURL;
            el.classList.add('is-ready');
            el.appendChild(img);
            el.appendChild(buildBitmapDownloadButton(el, record));
            return;
        }

        placeholder = document.createElement('div');
        placeholder.className = 'chat-bitmap-placeholder';

        if (!record || record.error) {
            placeholder.textContent = 'Image unavailable';
            el.classList.add('is-error');
        } else {
            placeholder.textContent = 'Rendering ' + text + '...';
            el.classList.add('is-loading');
        }

        el.appendChild(placeholder);
    }

    function refreshBitmapElements(key, root) {
        var scope = root || document;
        var elements;

        if (!key) {
            return;
        }

        elements = scope.querySelectorAll('[data-chat-bitmap-key="' + key + '"]');
        elements.forEach(function (el) {
            updateBitmapElement(el, _bitmapRecords[key] || null);
        });
    }

    function renderBitmapRecord(record) {
        if (!record || record.dataURL || record.renderPending || record.error) {
            return;
        }

        if (typeof GraphicsConverter === 'undefined' || !GraphicsConverter.shared) {
            return;
        }

        try {
            decodeBitmapRecord(record);
        } catch (err) {
            record.error = err && err.message ? err.message : 'Decode failed';
            refreshBitmapElements(record.key);
            return;
        }

        if (!GraphicsConverter.shared().from_bitmap_cells) {
            return;
        }

        record.renderPending = true;
        GraphicsConverter.shared().from_bitmap_cells(record.bitmap, record.width, record.height, function (dataURL) {
            record.renderPending = false;
            record.dataURL = dataURL || '';
            if (!record.dataURL && !record.error) {
                record.error = 'Render failed';
            }
            refreshBitmapElements(record.key);
        }, true);
    }

    function renderEmbeddedBitmaps(root) {
        var elements = (root || document).querySelectorAll('[data-chat-bitmap-key]');

        if (!elements.length) {
            return;
        }

        elements.forEach(function (el) {
            var key = el.getAttribute('data-chat-bitmap-key');
            var record = key ? _bitmapRecords[key] : null;

            updateBitmapElement(el, record);
            if (record && !record.dataURL && !record.renderPending && !record.error) {
                renderBitmapRecord(record);
            }
        });
    }

    function renderEmbeddedAvatars(root) {
        var els = (root || document).querySelectorAll('div[data-avatar-bin]:empty');
        if (!els.length || typeof GraphicsConverter === 'undefined' || !GraphicsConverter.shared) return;

        var gc = GraphicsConverter.shared();
        els.forEach(function (el) {
            var bin = el.getAttribute('data-avatar-bin');
            if (!bin) return;
            try {
                gc.from_bin(atob(bin), 10, 6, function (dataURL) {
                    var img = new Image();
                    img.addEventListener('load', function () {
                        if (!el.hasChildNodes()) el.appendChild(img);
                    });
                    img.src = dataURL;
                }, true);
            } catch (_ex) {}
        });
    }

    function removeToast(el) {
        if (!el || !el.parentNode) return;
        el.classList.add('chat-toast-exit');
        setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
        }, 400);
    }

    /* Where a chat notification leads: the thread, room or network. */
    function chatHref(msg) {
        var href = './?page=001-chat.xjs';
        if (msg.type === 'private' && msg.peerName) {
            href += '&private=' + encodeURIComponent(msg.peerName);
            if (msg.peerSystem) href += '&system=' + encodeURIComponent(msg.peerSystem);
            if (msg.peerBridge) href += '&bridge=' + encodeURIComponent(msg.peerBridge);
        } else if (msg.channel) {
            href += '&channel=' + encodeURIComponent(msg.channel);
        }
        return href;
    }

    function nativeAllowed() {
        return 'Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator;
    }

    /* The sender's avatar as a notification icon: the 80x96 drawing scaled
       up 3x with hard pixels so the OS doesn't blur it. From the avatar the
       message carries, else the site's avatar cache / lookup by user number.
       Prefers the server's PNG of it (api/push.ssjs ?call=icon, the same file
       a push uses): some notification centres drop data: URL icons. Falls
       back to drawing it here. cb(null) when there is none or it isn't ready
       within 4s. */
    var _notifyIcons = {};
    function avatarIcon(msg, cb) {
        var done = false;
        function finish(url) { if (!done) { done = true; cb(url); } }
        setTimeout(function () { finish(null); }, 4000);
        var key = msg.avatar ? 'bin:' + msg.avatar : msg.userNumber > 0 ? 'user:' + msg.userNumber : '';
        if (!key || typeof GraphicsConverter === 'undefined') { finish(null); return; }
        if (_notifyIcons[key]) { finish(_notifyIcons[key]); return; }
        function scale(dataURL) {
            if (!dataURL) { finish(null); return; }
            var img = new Image();
            img.onload = function () {
                var c = document.createElement('canvas');
                c.width = img.width * 3;
                c.height = img.height * 3;
                var ctx = c.getContext('2d');
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(img, 0, 0, c.width, c.height);
                _notifyIcons[key] = c.toDataURL('image/png');
                finish(_notifyIcons[key]);
            };
            img.onerror = function () { finish(null); };
            img.src = dataURL;
        }
        function drawHere(b64) {
            try { GraphicsConverter.shared().from_bin(atob(b64), 10, 6, scale, true); } catch (e) { finish(null); }
        }
        function fromBin(b64) {
            fetch('./api/push.ssjs?call=icon&avatar=' + encodeURIComponent(b64), { credentials: 'same-origin' })
                .then(function (r) { return r.json(); })
                .then(function (res) {
                    if (!res || !res.ok || !res.url) throw new Error('no icon');
                    _notifyIcons[key] = new URL(res.url, location.href).href;
                    finish(_notifyIcons[key]);
                })
                .catch(function () { drawHere(b64); });
        }
        if (msg.avatar) { fromBin(msg.avatar); return; }
        var store = window.sbbs && window.sbbs.avatars;
        function fromCache() {
            Promise.resolve(store ? store.get(msg.userNumber) : null).then(function (cached) {
                if (cached && cached.dataURL) scale(cached.dataURL); else finish(null);
            }).catch(function () { finish(null); });
        }
        fetch('./api/system.ssjs?call=get-avatar&user=' + encodeURIComponent(msg.userNumber), { credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (list) {
                var a = list && list[0];
                if (a && a.data) fromBin(a.data); else fromCache();
            }).catch(fromCache);
    }

    /* A desktop notification, with the sender's avatar as its picture. A
       private message uses the server push's tag, so the two replace each
       other instead of doubling up. */
    function nativeNotify(msg, href, kind) {
        var who = msg.sender || 'Someone';
        var where = msg.bridge ? bridgeTitle(msg.bridge) : '#' + (msg.channel || _currentChannel);
        var title = kind === 'chat_private' ? who + ' sent you a private message'
            : kind === 'chat_mention' ? who + ' mentioned you in ' + where
            : who + ' in ' + where;
        var body = (msg.previewText || buildMessagePreview(getMessageText(msg)) || '').substring(0, 200);
        var tag = msg.type === 'private'
            ? 'pm:' + String(msg.peerName || who).toLowerCase()
            : 'chat:' + String(msg.channel || _currentChannel).toLowerCase();
        avatarIcon(msg, function (icon) {
            navigator.serviceWorker.ready.then(function (reg) {
                return reg.showNotification(title, {
                    body: body, tag: tag, renotify: true,
                    icon: icon || './images/icon-192.png', badge: './images/icon-maskable-192.png',
                    data: { url: href }
                });
            }).catch(function () { /* the in-site badge still counts it */ });
        });
    }

    /* Announce a chat message, unless the user is looking right at it (the
       room or thread on screen in a visible tab): a toast, a desktop
       notification or both, per their choice for its kind. Desktop without
       the browser's permission falls back to a toast so nothing is lost. */
    function notifyChat(msg, viewing) {
        if (!msg || msg.isSelf) return;
        if (viewing && !document.hidden) return;
        var kind = chatKind(msg);
        var mode = chatMode(kind);
        if (mode === 'off') return;
        var href = chatHref(msg);
        var key = announceKey(msg);
        var native = (mode === 'native' || mode === 'both') && nativeAllowed();
        if (native) {
            claimAnnouncement(key, function (fresh) {
                if (fresh) nativeNotify(msg, href, kind);
            });
        }
        if ((mode === 'web' || mode === 'both' || (mode === 'native' && !native)) && !_toasted[key]) {
            if (Object.keys(_toasted).length > 200) _toasted = {};
            _toasted[key] = Date.now();
            renderToast(msg, href);
        }
    }

    /* One chat message, however it reached this tab (stream, sync, network
       count): where it was said, who said it, when and what. */
    function announceKey(msg) {
        var where = msg.type === 'private'
            ? 'pm:' + (msg.peerBridge || '') + ':' + (msg.peerName || msg.sender || '')
            : (msg.bridge || '') + '#' + (msg.channel || _currentChannel);
        var text = String(msg.previewText || getMessageText(msg) || '').substring(0, 80);
        return (where + '|' + (msg.sender || '') + '|' + (msg.timestamp || 0) + '|' + text).toLowerCase();
    }

    /* cb(true) the first time any tab on this device claims key (within
       ANNOUNCED_TTL_MS), cb(false) after. Web Locks keep two tabs that got
       the same stream event at once from both winning. */
    function claimAnnouncement(key, cb) {
        function claim() {
            var now = Date.now();
            var seen = {};
            try { seen = JSON.parse(readStorage(ANNOUNCED_STORAGE_KEY) || '{}') || {}; } catch (_e) { seen = {}; }
            Object.keys(seen).forEach(function (k) {
                if (!(now - seen[k] < ANNOUNCED_TTL_MS)) delete seen[k];
            });
            if (seen[key]) return false;
            seen[key] = now;
            writeStorage(ANNOUNCED_STORAGE_KEY, JSON.stringify(seen));
            return true;
        }
        if (navigator.locks && navigator.locks.request) {
            navigator.locks.request('chatAnnounce', claim).then(cb, function () { cb(true); });
        } else {
            cb(claim());
        }
    }

    /* The in-site toast itself; notifyChat decides whether to show it. */
    function renderToast(msg, href) {
        var container;
        var toast;
        var avatarDiv;
        var contentDiv;
        var senderDiv;
        var textDiv;
        var closeBtn;

        container = document.getElementById('chat-toasts');
        if (!container) return;

        while (container.children.length >= MAX_TOASTS) {
            container.removeChild(container.lastChild);
        }

        toast = document.createElement('div');
        toast.className = 'chat-toast chat-toast-enter';

        avatarDiv = document.createElement('div');
        avatarDiv.className = 'chat-toast-avatar';
        if (msg.avatar) {
            avatarDiv.setAttribute('data-avatar-bin', msg.avatar);
        } else if (msg.userNumber && msg.userNumber > 0) {
            avatarDiv.setAttribute('data-avatar', String(msg.userNumber));
        }
        toast.appendChild(avatarDiv);

        contentDiv = document.createElement('div');
        contentDiv.className = 'chat-toast-content';
        senderDiv = document.createElement('div');
        senderDiv.className = 'chat-toast-sender';
        senderDiv.textContent = msg.type === 'private'
            ? ('PM from ' + (msg.sender || 'Unknown') + (msg.peerBridge ? ' (' + bridgeTitle(msg.peerBridge) + ')' : ''))
            : (msg.sender || 'System');
        textDiv = document.createElement('div');
        textDiv.className = 'chat-toast-text';
        textDiv.textContent = (msg.previewText || buildMessagePreview(getMessageText(msg))).substring(0, 200);
        contentDiv.appendChild(senderDiv);
        contentDiv.appendChild(textDiv);
        toast.appendChild(contentDiv);

        closeBtn = document.createElement('button');
        closeBtn.className = 'chat-toast-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            removeToast(toast);
        });
        toast.appendChild(closeBtn);

        toast.addEventListener('click', function () {
            var a = document.createElement('a');
            removeToast(toast);
            a.href = href;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        });

        container.insertBefore(toast, container.firstChild);

        if (msg.avatar) {
            renderEmbeddedAvatars(toast);
        } else if (msg.userNumber && msg.userNumber > 0 && typeof Avatars !== 'undefined' && Avatars.draw) {
            Avatars.draw([String(msg.userNumber)]);
        }

        requestAnimationFrame(function () {
            toast.classList.remove('chat-toast-enter');
        });

        setTimeout(function () {
            removeToast(toast);
        }, TOAST_DURATION);
    }

    function setStatus(type, message, showRetry) {
        var nextType = type || '';
        var nextMessage = message || '';
        var nextRetry = !!showRetry;

        if (_status.type === nextType && _status.message === nextMessage && _status.showRetry === nextRetry) {
            return;
        }

        _status.type = nextType;
        _status.message = nextMessage;
        _status.showRetry = nextRetry;
        dispatch('status', cloneStatus());
    }

    function refreshStatus() {
        if (!_serviceHealthy) {
            setStatus(
                'error',
                'Chat cannot reach the JSON service right now. Check chat.ssjs host/port and make sure the JSON service is running.',
                true
            );
            return;
        }

        if (!_realtimeHealthy) {
            if (_reconnectAttemptCount > 2) {
                setStatus(
                    'warning',
                    'Realtime chat updates are still unavailable. Retrying in the background while history continues to sync.',
                    true
                );
            } else {
                setStatus(
                    'warning',
                    'Realtime chat updates were interrupted. Retrying automatically while history continues to sync.',
                    true
                );
            }
            return;
        }

        setStatus('', '', false);
    }

    function fetchJSON(url, options) {
        return fetch(url, options || {}).then(function (response) {
            if (!response.ok) {
                throw new Error('HTTP ' + String(response.status));
            }
            return response.json();
        });
    }

    function findRoom(name) {
        var key = normalizeUpper(name);
        var index;

        for (index = 0; index < _rooms.length; index += 1) {
            if (normalizeUpper(_rooms[index].name) === key) {
                return _rooms[index];
            }
        }

        return null;
    }

    function ensureRoom(name) {
        var room = findRoom(name);

        if (room) return room;

        room = {
            name: name,
            userCount: 0,
            lastTimestamp: 0,
            newCount: 0
        };
        _rooms.push(room);
        return room;
    }

    function upsertPrivateThread(summary) {
        summary = normalizeThreadSummary(summary);
        var key = threadKeyOf(summary);
        var index;

        for (index = 0; index < _privateThreads.length; index += 1) {
            if (threadKeyOf(_privateThreads[index]) === key) {
                _privateThreads[index].system = summary.system || _privateThreads[index].system || '';
                if (summary.avatar) _privateThreads[index].avatar = summary.avatar;
                _privateThreads[index].lastTimestamp = Math.max(_privateThreads[index].lastTimestamp || 0, summary.lastTimestamp || 0);
                if (summary.preview) {
                    _privateThreads[index].preview = summary.preview;
                }
                return _privateThreads[index];
            }
        }

        _privateThreads.push({
            name: summary.name,
            system: summary.system || '',
            bridge: normalizeBridge(summary.bridge),
            avatar: summary.avatar || undefined,
            lastTimestamp: summary.lastTimestamp || 0,
            preview: summary.preview || ''
        });
        return _privateThreads[_privateThreads.length - 1];
    }

    function dispatchMessages() {
        dispatch('messagesUpdated', _messages.slice());
    }

    function cloneRooms() {
        return _rooms.map(function (room) {
            return {
                name: room.name,
                bridge: room.bridge || '',
                label: room.label || '',
                topic: room.topic || '',
                // Bridged rooms: the network room the session is in (MRC),
                // and whether the user is staying on the network site-wide.
                room: room.room || '',
                held: !!(room.bridge && _bridgeHold[normalizeBridge(room.name)]),
                // Local rooms: in the user's sidebar (server-side membership).
                // Bridged networks are always listed.
                joined: !!room.bridge || !!room.joined,
                userCount: room.userCount || 0,
                lastTimestamp: room.lastTimestamp || 0,
                newCount: room.newCount || 0,
                unreadCount: _unreadChannels[normalizeUpper(room.name)] || 0,
                isActive: normalizeUpper(_activeView.type) === 'CHANNEL' &&
                    normalizeUpper(_activeView.name) === normalizeUpper(room.name)
            };
        });
    }

    function clonePrivateThreads() {
        var map = {};
        var list = [];

        _privateThreads.forEach(function (thread) {
            var key = threadKeyOf(thread);

            if (!map[key]) {
                map[key] = {
                    name: thread.name,
                    system: thread.system || '',
                    bridge: thread.bridge || '',
                    avatar: thread.avatar || undefined,
                    lastTimestamp: thread.lastTimestamp || 0,
                    preview: thread.preview || ''
                };
                list.push(map[key]);
                return;
            }

            if (thread.avatar && !map[key].avatar) {
                map[key].avatar = thread.avatar;
            }
            if ((thread.lastTimestamp || 0) >= (map[key].lastTimestamp || 0)) {
                map[key].lastTimestamp = thread.lastTimestamp || 0;
                if (thread.preview) {
                    map[key].preview = thread.preview;
                }
                if (thread.system) {
                    map[key].system = thread.system;
                }
            }
        });

        return list.map(function (thread) {
            var key = threadKeyOf(thread);
            return {
                name: thread.name,
                system: thread.system || '',
                bridge: thread.bridge || '',
                avatar: thread.avatar || undefined,
                lastTimestamp: thread.lastTimestamp || 0,
                preview: thread.preview || '',
                unreadCount: _unreadPrivate[key] || 0,
                isOnline: isThreadOnline(thread.name, thread.system || '', thread.bridge || ''),
                isActive: normalizeUpper(_activeView.type) === 'PRIVATE' &&
                    key === getCurrentPrivateKey()
            };
        });
    }

    function cloneUsers() {
        return _users.map(function (entry) {
            return {
                nick: entry.nick || '',
                system: entry.system || '',
                bridge: entry.bridge || '',
                userNumber: entry.userNumber || 0,
                avatar: entry.avatar || undefined,
                qwkid: entry.qwkid || undefined,
                nickColors: entry.nickColors || undefined
            };
        });
    }

    function dispatchRooms() {
        dispatch('roomsUpdated', cloneRooms());
        updateBadge();
    }

    function dispatchPrivateThreads() {
        dispatch('privateUpdated', clonePrivateThreads());
        updateBadge();
    }

    function dispatchUsers() {
        dispatch('usersUpdated', cloneUsers());
    }

    function dispatchView() {
        dispatch('viewChanged', {
            type: _activeView.type,
            name: _activeView.name,
            system: _activeView.system || '',
            avatar: _activeView.avatar || '',
            bridge: _activeView.bridge || '',
            currentChannel: _currentChannel
        });
    }

    function applyRoomSummaries(summaries, serverTime, silent) {
        summaries = Array.isArray(summaries) ? summaries : [];
        serverTime = serverTime || Date.now();
        var nextRooms = [];

        summaries.forEach(function (summary) {
            var room = ensureRoom(summary.name);
            // DDial / MRC rooms (served by their multiplexer): the page shows
            // these as network TABS, not as entries in the room list.
            room.bridge = summary.bridge || '';
            room.label = summary.label || '';
            room.userCount = summary.userCount || 0;
            room.lastTimestamp = summary.lastTimestamp || 0;
            room.newCount = summary.newCount || 0;
            if (summary.room) room.room = String(summary.room);
            // A join we posted counts before the server's summaries catch up.
            if (summary.joined) delete _pendingJoin[normalizeUpper(summary.name)];
            room.joined = !!summary.joined || !!_pendingJoin[normalizeUpper(summary.name)];

            if (
                !_realtimeHealthy &&
                (summary.newCount || 0) > 0 &&
                (room.joined || room.bridge) &&
                !(normalizeUpper(_activeView.type) === 'CHANNEL' && normalizeUpper(_activeView.name) === normalizeUpper(summary.name))
            ) {
                _unreadChannels[normalizeUpper(summary.name)] = (_unreadChannels[normalizeUpper(summary.name)] || 0) + summary.newCount;
            }

            if (_chatPageActive && normalizeUpper(_activeView.type) === 'CHANNEL' && normalizeUpper(_activeView.name) === normalizeUpper(summary.name)) {
                _unreadChannels[normalizeUpper(summary.name)] = 0;
            }

            if (room.bridge && summary.counted) applyBridgeUnread(room, summary);

            nextRooms.push(room);
        });

        _rooms = nextRooms.length ? nextRooms : [ensureRoom(_currentChannel)];
        ensureRoom(_currentChannel);
        _lastRoomPollAt = serverTime;
        _serviceHealthy = true;
        if (!silent) refreshStatus();
        dispatchRooms();
    }

    /* A network the user is on: its unread room messages since what this
       browser last showed (the server counts them from _bridgeSeen). The
       open network is read as it arrives; a network seen for the first time
       starts from now, not from its whole backlog. */
    function applyBridgeUnread(room, summary) {
        var net = normalizeBridge(room.name);
        var key = normalizeUpper(room.name);
        var viewing = _chatPageActive && !document.hidden && normalizeUpper(_activeView.type) === 'CHANNEL' && normalizeUpper(_activeView.name) === key;
        var before = _unreadChannels[key] || 0;
        if (viewing || !_bridgeSeen[net] || !_bridgeHold[net]) {
            _unreadChannels[key] = 0;
            setBridgeSeen(net, summary.seq || 0);
            return;
        }
        _unreadChannels[key] = summary.newCount || 0;
        var firstCount = !_bridgeCountShown[net];
        _bridgeCountShown[net] = true;
        if (!firstCount && summary.newCount > before && summary.latest) {
            room.lastTimestamp = Math.max(room.lastTimestamp || 0, summary.latest.timestamp || 0);
            notifyChat({
                type: 'message', channel: room.name, bridge: net,
                sender: summary.latest.sender + ' (' + bridgeTitle(net) + ')',
                text: summary.latest.text, previewText: summary.latest.text,
                userNumber: summary.latest.userNumber || 0,
                avatar: summary.latest.avatar || undefined
            });
        }
    }

    function loadRoomSummaries(silent) {
        var url = './api/chat.ssjs?action=channels';
        return fetchJSON(url + (_lastRoomPollAt > 0 ? '&since=' + encodeURIComponent(String(_lastRoomPollAt)) : '')).then(function (response) {
            applyRoomSummaries(response && response.channels, response && response.serverTime, silent);
            return true;
        }).catch(function () {
            _serviceHealthy = false;
            if (!silent) refreshStatus();
            return false;
        });
    }

    function loadPrivateThreads(silent) {
        if (!isLoggedIn()) {
            _privateThreads = [];
            dispatchPrivateThreads();
            return Promise.resolve(true);
        }

        var url = './api/chat.ssjs?action=private';
        return fetchJSON(url + (_lastPrivatePollAt > 0 ? '&since=' + encodeURIComponent(String(_lastPrivatePollAt)) : '')).then(function (response) {
            applyPrivateThreads(response && response.threads, response && response.serverTime, silent);
            return true;
        }).catch(function () {
            _serviceHealthy = false;
            if (!silent) refreshStatus();
            return false;
        });
    }

    function applyPrivateThreads(threads, serverTime, silent) {
        threads = Array.isArray(threads) ? threads : [];
        serverTime = serverTime || Date.now();
        var nextThreads = [];
        var seen = {};
        var previous = {};
        var nextUnread = {};

        _privateThreads.forEach(function (thread) {
            previous[threadKeyOf(thread)] = thread.lastTimestamp || 0;
        });

        threads.forEach(function (summary) {
            var thread = upsertPrivateThread(summary);
            var key = threadKeyOf(thread);
            var viewing = _chatPageActive && normalizeUpper(_activeView.type) === 'PRIVATE' && key === getCurrentPrivateKey();
            var serverUnread = typeof summary.unreadCount === 'number' ? summary.unreadCount : (summary.newCount || 0);

            // The server counts what the peer said since the thread was last
            // read here (readAt); a live event may have bumped the local count
            // since the last sync, so keep whichever is higher.
            nextUnread[key] = viewing ? 0 : Math.max(serverUnread, _unreadPrivate[key] || 0);

            // Bridged PMs have no push channel: a thread that grew since the
            // last sync, while the page was elsewhere, is what a toast is for.
            if (
                thread.bridge && !viewing && serverUnread > 0 &&
                Object.prototype.hasOwnProperty.call(previous, key) &&
                (summary.lastTimestamp || 0) > previous[key]
            ) {
                notifyChat({
                    type: 'private',
                    sender: thread.name,
                    peerName: thread.name,
                    peerSystem: thread.system || '',
                    peerBridge: thread.bridge,
                    avatar: thread.avatar,
                    previewText: thread.preview || ''
                });
            }

            if (!seen[key]) {
                seen[key] = true;
                nextThreads.push(thread);
            }
        });

        if (normalizeUpper(_activeView.type) === 'PRIVATE') {
            if (!nextThreads.some(function (thread) {
                return threadKeyOf(thread) === getCurrentPrivateKey();
            })) {
                nextThreads.push({
                    name: _activeView.name,
                    system: _activeView.system || '',
                    bridge: _activeView.bridge || '',
                    avatar: _activeView.avatar || undefined,
                    lastTimestamp: 0,
                    preview: ''
                });
            }
        }

        _privateThreads = nextThreads;
        _unreadPrivate = nextUnread;
        _lastPrivatePollAt = serverTime;
        _serviceHealthy = true;
        if (!silent) refreshStatus();
        dispatchPrivateThreads();
    }

    function applyPublicHistory(response, silent) {
        var nextMessages = normalizeMessages(response && Array.isArray(response.messages) ? response.messages : []);
        var messagesChanged = !messagesMatch(_messages, nextMessages);
        if (messagesChanged) {
            _messages = nextMessages;
        }
        if (_chatPageActive && !document.hidden) _unreadChannels[normalizeUpper(_currentChannel)] = 0;
        // Bridged rooms (MRC) carry the network's own room topic, and which
        // network room the session is actually in.
        if (response && response.bridge) {
            ensureRoom(_currentChannel).topic = String(response.topic || '');
            ensureRoom(_currentChannel).room = String(response.room || '');
            // On screen now (and looked at): nothing up to here is unread.
            if (_chatPageActive && !document.hidden && response.seq) setBridgeSeen(response.bridge, response.seq);
        }
        _serviceHealthy = true;
        if (!silent) refreshStatus();
        if (messagesChanged) {
            dispatchMessages();
        }
        dispatchRooms();
    }

    function loadPublicHistory(silent) {
        return fetchJSON('./api/chat.ssjs?action=history&channel=' + encodeURIComponent(_currentChannel)
            + bridgeQuery()).then(function (response) {
            if (response && response.error) throw new Error(String(response.error));
            applyPublicHistory(response, silent);
            return true;
        }).catch(function () {
            _serviceHealthy = false;
            if (!silent) refreshStatus();
            return false;
        });
    }

    function loadPrivateHistory(silent) {
        var url = './api/chat.ssjs?action=privateHistory&target=' + encodeURIComponent(_activeView.name);
        if (_activeView.system) {
            url += '&system=' + encodeURIComponent(_activeView.system);
        }
        if (_activeView.bridge) {
            url += '&bridge=' + encodeURIComponent(_activeView.bridge);
        }
        // The thread is on screen: the server records it as read.
        if (_chatPageActive && !document.hidden) {
            url += '&read=1';
        }

        return fetchJSON(url).then(function (response) {
            var nextMessages;
            var messagesChanged;
            var peerChanged = false;
            var nextSystem = '';
            var nextAvatar = '';

            if (response && response.error) throw new Error(String(response.error));

            nextMessages = normalizeMessages(response && Array.isArray(response.messages) ? response.messages : []);
            messagesChanged = !messagesMatch(_messages, nextMessages);
            if (messagesChanged) {
                _messages = nextMessages;
            }
            if (response && response.peer) {
                nextSystem = response.peer.system || _activeView.system || '';
                nextAvatar = response.peer.avatar || '';
                peerChanged =
                    trimText(_activeView.system || '') !== trimText(nextSystem) ||
                    trimText(_activeView.avatar || '') !== trimText(nextAvatar);
                _activeView.system = nextSystem;
                _activeView.avatar = nextAvatar;
                upsertPrivateThread({
                    name: response.peer.name,
                    system: response.peer.system,
                    bridge: _activeView.bridge || response.peer.bridge || '',
                    avatar: response.peer.avatar
                });
            }
            if (_chatPageActive) _unreadPrivate[getCurrentPrivateKey()] = 0;
            _serviceHealthy = true;
            if (!silent) refreshStatus();
            if (messagesChanged) {
                dispatchMessages();
            }
            dispatchPrivateThreads();
            if (peerChanged) {
                dispatchView();
            }
            return true;
        }).catch(function () {
            _serviceHealthy = false;
            if (!silent) refreshStatus();
            return false;
        });
    }

    function loadActiveHistory(silent) {
        if (normalizeUpper(_activeView.type) === 'PRIVATE') {
            return loadPrivateHistory(silent);
        }
        return loadPublicHistory(silent);
    }

    function applyUsers(users, silent) {
        var net = isBridgeRoom(_currentChannel) ? normalizeBridge(_currentChannel) : '';
        _users = Array.isArray(users) ? users : [];
        if (net) {
            // The network's who-list is the presence source for its threads.
            var online = {};
            _users.forEach(function (entry) {
                var key = buildNameKey(entry && entry.nick || '');
                if (key.length) online[key] = true;
            });
            _bridgeOnline[net] = online;
            dispatchPrivateThreads();
        }
        _serviceHealthy = true;
        if (!silent) refreshStatus();
        dispatchUsers();
    }

    function rosterHas(nick, systemName) {
        return _users.some(function (entry) {
            return normalizeUpper(entry.nick) === normalizeUpper(nick) &&
                (!systemName || !entry.system || normalizeUpper(entry.system) === normalizeUpper(systemName));
        });
    }

    /* "X is here." / "X has left." like the terminal chat; other BBSes named. */
    function addPresenceNotice(room, payload, joined) {
        var key = normalizeUpper(room);
        var list;
        if (!payload.sender) return;
        list = _presenceNotices[key] || (_presenceNotices[key] = []);
        list.push({
            kind: 'notice',
            sender: '',
            text: payload.sender + (payload.remote && payload.system ? ' (' + payload.system + ')' : '') + (joined ? ' is here.' : ' has left.'),
            timestamp: payload.timestamp || Date.now()
        });
        if (list.length > MAX_PRESENCE_NOTICES) list.shift();
        if (_chatPageActive && normalizeUpper(_activeView.type) === 'CHANNEL' && key === normalizeUpper(_activeView.name)) dispatchMessages();
    }

    function messagesWithNotices() {
        var notices = normalizeUpper(_activeView.type) === 'CHANNEL' ? _presenceNotices[normalizeUpper(_activeView.name)] : null;
        var out, i, j;
        if (!notices || !notices.length) return _messages.slice();
        out = [];
        for (i = 0, j = 0; i < _messages.length || j < notices.length;) {
            if (j >= notices.length || (i < _messages.length && (_messages[i].timestamp || 0) <= notices[j].timestamp)) out.push(_messages[i++]);
            else out.push(notices[j++]);
        }
        return out;
    }

    function loadUsers(channel, silent) {
        var ch = sanitizeChannelName(channel || _currentChannel);
        return fetchJSON('./api/chat.ssjs?action=who&channel=' + encodeURIComponent(ch)).then(function (response) {
            if (response && response.error) throw new Error(String(response.error));
            applyUsers(response && response.users, silent);
            return true;
        }).catch(function () {
            _serviceHealthy = false;
            if (!silent) refreshStatus();
            return false;
        });
    }

    function loadPresenceMap(silent) {
        var targets = _rooms.filter(function (room) {
            return !!room && !!room.name && ((room.userCount || 0) > 0 || normalizeUpper(room.name) === normalizeUpper(_currentChannel));
        });
        var requests;

        if (!targets.length) {
            rebuildOnlinePresence([]);
            return Promise.resolve(true);
        }

        requests = targets.map(function (room) {
            return fetchJSON('./api/chat.ssjs?action=who&channel=' + encodeURIComponent(room.name)).then(function (response) {
                return response && Array.isArray(response.users) ? response.users : [];
            }).catch(function () {
                return [];
            });
        });

        return Promise.all(requests).then(function (results) {
            var combined = [];

            results.forEach(function (entries) {
                if (Array.isArray(entries) && entries.length) {
                    combined = combined.concat(entries);
                }
            });

            applyPresence(combined, silent);
            return true;
        }).catch(function () {
            _serviceHealthy = false;
            if (!silent) refreshStatus();
            return false;
        });
    }

    function applyPresence(combined, silent) {
        rebuildOnlinePresence(Array.isArray(combined) ? combined : []);
        _serviceHealthy = true;
        if (!silent) refreshStatus();
    }

    function sendPublicMessage(text) {
        var body = new URLSearchParams();
        body.set('action', 'send');
        body.set('channel', _currentChannel);
        body.set('message', text);

        return fetchJSON('./api/chat.ssjs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });
    }

    function sendPrivateMessage(text) {
        var body = new URLSearchParams();
        body.set('action', 'sendPrivate');
        body.set('target', _activeView.name);
        body.set('message', text);
        if (_activeView.system) {
            body.set('system', _activeView.system);
        }
        if (_activeView.bridge) {
            body.set('bridge', _activeView.bridge);
            if (_activeView.bridge === 'mrc' && _bridgeRoom.mrc) {
                body.set('room', _bridgeRoom.mrc);
            }
            if (_activeView.bridge === 'irc' && _bridgeRoom.irc) {
                body.set('ircroom', _bridgeRoom.irc);
            }
        }

        return fetchJSON('./api/chat.ssjs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });
    }

    function postForm(params) {
        var body = new URLSearchParams();
        Object.keys(params).forEach(function (key) {
            if (params[key] !== undefined && params[key] !== null && String(params[key]).length) {
                body.set(key, String(params[key]));
            }
        });
        return fetchJSON('./api/chat.ssjs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });
    }

    function postThreadState(name, system, bridge, patch) {
        var params = { action: 'threadState', target: name, system: system || '', bridge: bridge || '' };
        Object.keys(patch).forEach(function (key) { params[key] = patch[key]; });
        return postForm(params).catch(function () { return null; });
    }

    // A live PM arrived in the thread that is open: tell the server it was
    // read, coalescing bursts into one request.
    function scheduleMarkRead() {
        if (_markReadTimer) return;
        _markReadTimer = setTimeout(function () {
            _markReadTimer = 0;
            if (normalizeUpper(_activeView.type) !== 'PRIVATE' || !_chatPageActive) return;
            postThreadState(_activeView.name, _activeView.system, _activeView.bridge, { read: '1' });
        }, 1500);
    }

    function dismissPrivateThread(name, system, bridge) {
        var key = buildThreadKey(name, system || '', bridge || '');
        var wasActive = normalizeUpper(_activeView.type) === 'PRIVATE' && key === getCurrentPrivateKey();

        if (!isLoggedIn() || !sanitizeAlias(name).length) {
            return Promise.resolve(false);
        }

        _privateThreads = _privateThreads.filter(function (thread) {
            return threadKeyOf(thread) !== key;
        });
        _unreadPrivate[key] = 0;

        if (wasActive) {
            // Leave the thread before dropping it, or the view would re-add it.
            setActivePublicChannel(_currentChannel, false);
        } else {
            dispatchPrivateThreads();
        }

        return postThreadState(name, system, bridge, { dismiss: '1' }).then(function (response) {
            return !!(response && response.success);
        });
    }


    function reconcileState(forceUsers) {
        // Skip when visualizer is active — reduce background work
        if (!forceUsers && document.body.classList.contains('viz-open')) return;

        // One combined ?action=sync request per tick instead of the old fan-out
        // (channels + private + history + presence(one who PER room) + who). The
        // server bundles all of those over a single JSONClient connection, which is
        // what was churning the JSON service. Private-thread history is the only
        // piece still fetched on its own, and only while a DM is open.
        _usersRefreshTick += 1;
        var wantUsers = forceUsers || _chatPageActive || _usersRefreshTick >= 2;
        if (wantUsers) _usersRefreshTick = 0;

        var isPrivateView = normalizeUpper(_activeView.type) === 'PRIVATE';
        var since = Math.min(_lastRoomPollAt || 0, _lastPrivatePollAt || 0);

        var url = './api/chat.ssjs?action=sync'
            + '&channel=' + encodeURIComponent(_currentChannel)
            + '&who=' + (wantUsers ? '1' : '0')
            + '&presence=1'
            /* A network room's history counts as read, so ask for it only
               while the user is actually looking at it; otherwise the server
               counts that network's unread messages, which is what toasts
               and the badge need (else DDial as the last-open room never
               notified from another page or a hidden tab). */
            + '&history=' + (isPrivateView || (isBridgeRoom(_currentChannel) && !(_chatPageActive && !document.hidden)) ? '0' : '1')
            // Bridged rooms: on MRC a poll IS the user's presence on the
            // network. The server keeps it alive while the chat page shows
            // that tab (active) or the user has chosen to stay on the
            // network from the rest of the site (hold) - this 15s sync is
            // what carries their private messages in meanwhile.
            + bridgeQuery()
            + (since > 0 ? '&since=' + encodeURIComponent(String(since)) : '');

        return fetchJSON(url).then(function (response) {
            if (!response || response.error) {
                _serviceHealthy = false;
                return false;
            }

            applyRoomSummaries(response.channels, response.serverTime, true);

            if (response.private) {
                applyPrivateThreads(response.private.threads, response.serverTime, true);
            } else if (!isLoggedIn()) {
                applyPrivateThreads([], response.serverTime, true);
            }

            if (wantUsers && response.who) {
                applyUsers(response.who.users, true);
            }

            if (response.presence) {
                applyPresence(response.presence, true);
            }

            if (!isPrivateView && response.history) {
                applyPublicHistory(response.history, true);
            }

            _serviceHealthy = true;

            // sync only carries public-channel history; refresh an open DM thread on its own.
            if (isPrivateView) {
                return loadPrivateHistory(true).then(function () { return true; }).catch(function () { return false; });
            }
            return true;
        }).catch(function () {
            _serviceHealthy = false;
            return false;
        });
    }

    function startReconcileLoop() {
        if (_guestMode || _reconcileTimer) return;
        _reconcileTimer = setInterval(function () {
            reconcileState(false);
        }, RECONCILE_INTERVAL);
        // DDial / MRC rooms are served by their multiplexer, not the JSON chat
        // service, so they have no push channel: while one is open on the chat
        // page, fetch it on a short loop instead of waiting for the 15s sync.
        if (!_bridgeTimer) {
            _bridgeTimer = setInterval(function () {
                if (!_chatPageActive || document.hidden) return;
                if (normalizeUpper(_activeView.type) === 'PRIVATE') return;
                if (!isBridgeRoom(_currentChannel)) return;
                loadPublicHistory(true);
            }, BRIDGE_POLL_INTERVAL);
        }
    }

    function isBridgeRoom(name) {
        var key = normalizeUpper(name);
        return key === 'DDIAL' || key === 'MRC' || key === 'IRC';
    }

    // Stop being on a bridged network: log off now and stop holding it.
    function leaveBridge(name) {
        var net = normalizeBridge(name);
        if (!net || !isLoggedIn()) return Promise.resolve(false);
        delete _bridgeHold[net];
        saveBridgeHold();
        if (isBridgeRoom(_currentChannel) && normalizeBridge(_currentChannel) === net) {
            setActivePublicChannel(DEFAULT_CHANNEL, true);
        } else {
            dispatchRooms();
        }
        return postForm({ action: 'leave', channel: net }).then(function (response) {
            return !!(response && response.success);
        }).catch(function () { return false; });
    }

    // Change MRC room / IRC channel. The mux moves the session on the next
    // request that names the room; the room is remembered per browser.
    function setBridgeRoom(net, roomName) {
        var clean = sanitizeBridgeRoomName(roomName);
        net = normalizeBridge(net);
        if ((net !== 'mrc' && net !== 'irc') || !clean.length) return Promise.resolve(false);
        if (net === 'irc') clean = clean.replace(/\./g, '');
        _bridgeRoom[net] = clean;
        writeStorage(net === 'irc' ? IRC_ROOM_STORAGE_KEY : ROOM_STORAGE_KEY, clean);
        ensureRoom(net).room = clean;
        dispatchRooms();
        if (!isBridgeRoom(_currentChannel) || normalizeBridge(_currentChannel) !== net) {
            return Promise.resolve(true);
        }
        return loadPublicHistory(false).then(function (ok) {
            loadUsers(_currentChannel, true);
            return ok;
        });
    }

    // MRC's room list / IRC's channel list, from the server's LIST reply. The
    // reply trickles in; `pending` says to ask again shortly.
    function fetchBridgeRooms(net) {
        net = normalizeBridge(net);
        if ((net !== 'mrc' && net !== 'irc') || !isLoggedIn()) {
            return Promise.resolve({ rooms: [], pending: false });
        }
        return fetchJSON('./api/chat.ssjs?action=rooms&channel=' + net + bridgeQuery()).then(function (response) {
            if (!response || response.error) throw new Error(response && response.error ? String(response.error) : 'rooms');
            return {
                rooms: Array.isArray(response.rooms) ? response.rooms : [],
                pending: !!response.pending,
                room: String(response.room || '')
            };
        });
    }

    function scheduleHistoryRefresh() {
        if (_sendRefreshTimer) {
            clearTimeout(_sendRefreshTimer);
        }
        _sendRefreshTimer = setTimeout(function () {
            _sendRefreshTimer = 0;
            loadActiveHistory(true);
            loadRoomSummaries(true);
            loadPrivateThreads(true);
        }, 1000);
    }

    /* The local room the open stream is subscribed to. The chat service
       announces every (un)subscribe to the room as the user joining or
       leaving, so the stream only reconnects when this room changes:
       viewing DDial/MRC (served by polling) or a page change keeps it. */
    var _streamChannel = '';

    function streamChannelFor(name) {
        return isBridgeRoom(name) ? (_streamChannel || DEFAULT_CHANNEL) : name;
    }

    function buildEventUrl() {
        _streamChannel = streamChannelFor(_currentChannel);
        var url = './api/events.ssjs?subscribe=chat&channel=' + encodeURIComponent(_streamChannel);
        if (isLoggedIn()) {
            url += '&mailbox=1';
        }
        return url;
    }

    function closeEventSource() {
        if (!_eventSource) return;
        try { _eventSource.close(); } catch (_e) {}
        _eventSource = null;
    }

    function scheduleReconnect() {
        if (_guestMode || _reconnectTimer) return;
        _reconnectTimer = setTimeout(function () {
            _reconnectTimer = 0;
            if (!_eventSource) connectEvents(true);
        }, RECONNECT_DELAY);
    }

    function connectEvents(isReconnect) {
        if (_guestMode) return;
        if (!window.EventSource) {
            _realtimeHealthy = false;
            refreshStatus();
            return;
        }

        closeEventSource();
        _eventSource = new EventSource(buildEventUrl());
        if (isReconnect) {
            refreshStatus();
        }

        _eventSource.onopen = function () {
            _realtimeHealthy = true;
            _reconnectAttemptCount = 0;
            refreshStatus();
        };

        _eventSource.addEventListener('chat', function (event) {
            var payload = null;
            var room;
            var thread;
            var threadKey;

            try {
                payload = JSON.parse(event.data);
            } catch (_parseErr) {
                return;
            }

            if (!payload) return;

            if (payload.type === 'message') {
                payload = normalizeMessage(payload);
                room = ensureRoom(payload.channel || _currentChannel);
                room.lastTimestamp = Math.max(room.lastTimestamp || 0, payload.timestamp || 0);

                if (_chatPageActive && normalizeUpper(_activeView.type) === 'CHANNEL' && normalizeUpper(_activeView.name) === normalizeUpper(payload.channel || _currentChannel)) {
                    _messages.push(payload);
                    if (_messages.length > MAX_MESSAGES) _messages.shift();
                    if (document.hidden && !payload.isSelf) {
                        // On screen but nobody looking: count it and tell the device.
                        _unreadChannels[normalizeUpper(payload.channel || _currentChannel)] = (_unreadChannels[normalizeUpper(payload.channel || _currentChannel)] || 0) + 1;
                        notifyChat(payload, true);
                    } else {
                        _unreadChannels[normalizeUpper(payload.channel || _currentChannel)] = 0;
                    }
                    dispatchMessages();
                } else {
                    _unreadChannels[normalizeUpper(payload.channel || _currentChannel)] = (_unreadChannels[normalizeUpper(payload.channel || _currentChannel)] || 0) + 1;
                    notifyChat(payload, false);
                }

                dispatchRooms();
                return;
            }

            if (payload.type === 'join' || payload.type === 'part') {
                var noticeRoom = payload.channel || _currentChannel;
                var viewingRoom = normalizeUpper(noticeRoom) === normalizeUpper(_currentChannel);
                if (payload.type === 'join') {
                    // A second tab or device of someone already here is not an arrival.
                    if (!(viewingRoom && rosterHas(payload.sender, payload.system))) addPresenceNotice(noticeRoom, payload, true);
                    if (viewingRoom) loadUsers(_currentChannel, true);
                } else if (viewingRoom) {
                    // Still on the roster after the refresh: another session of theirs remains.
                    loadUsers(_currentChannel, true).then(function () {
                        if (!rosterHas(payload.sender, payload.system)) addPresenceNotice(noticeRoom, payload, false);
                    });
                } else {
                    addPresenceNotice(noticeRoom, payload, false);
                }
                loadRoomSummaries(true).then(function () {
                    loadPresenceMap(true);
                });
                return;
            }

            if (payload.type === 'private') {
                payload = normalizeMessage(payload);
                thread = upsertPrivateThread({
                    name: payload.peerName || payload.sender,
                    system: payload.peerSystem || payload.system || '',
                    avatar: payload.peerAvatar || payload.avatar || undefined,
                    lastTimestamp: payload.timestamp || Date.now(),
                    preview: payload.previewText || payload.text || ''
                });
                threadKey = threadKeyOf(thread);

                if (_chatPageActive && normalizeUpper(_activeView.type) === 'PRIVATE' && threadKey === getCurrentPrivateKey()) {
                    _messages.push(normalizeMessage({
                        sender: payload.sender,
                        system: payload.system,
                        text: payload.text,
                        timestamp: payload.timestamp,
                        userNumber: payload.userNumber,
                        avatar: payload.avatar
                    }));
                    if (_messages.length > MAX_MESSAGES) _messages.shift();
                    _unreadPrivate[threadKey] = 0;
                    if (!payload.isSelf) scheduleMarkRead();
                    dispatchMessages();
                } else if (payload.isSelf) {
                    // Our own PM from another device/session: not unread here.
                    _unreadPrivate[threadKey] = _unreadPrivate[threadKey] || 0;
                } else {
                    _unreadPrivate[threadKey] = (_unreadPrivate[threadKey] || 0) + 1;
                    notifyChat(payload, false);
                }

                _lastPrivatePollAt = Math.max(_lastPrivatePollAt, payload.timestamp || 0);
                dispatchPrivateThreads();
            }
        });

        _eventSource.onerror = function () {
            _realtimeHealthy = false;
            _reconnectAttemptCount += 1;
            refreshStatus();
            closeEventSource();
            scheduleReconnect();
        };
    }

    // viewOnly: show the room without joining it (after leaving the last
    // room the page parks the view on #main and offers to join it).
    function setActivePublicChannel(name, reconnect, viewOnly) {
        var next = sanitizeChannelName(name || DEFAULT_CHANNEL);

        _currentChannel = next;
        var room = ensureRoom(next);
        _activeView = { type: 'channel', name: next, system: '', avatar: '', bridge: '' };
        _unreadChannels[normalizeUpper(next)] = 0;

        // Opening a bridged network is joining it; from here on the user
        // stays on it from any page of the site until they Leave.
        if (isBridgeRoom(next) && isLoggedIn() && !_bridgeHold[normalizeBridge(next)]) {
            _bridgeHold[normalizeBridge(next)] = true;
            saveBridgeHold();
        }
        // Opening a local room (a link, a search, the picker) joins it.
        if (!isBridgeRoom(next) && isLoggedIn() && !room.joined && !viewOnly) {
            room.joined = true;
            _pendingJoin[normalizeUpper(next)] = true;
            postForm({ action: 'joinRoom', channel: next }).catch(function () {});
        }

        dispatchView();
        dispatchRooms();

        loadActiveHistory(false);
        loadUsers(next, false);
        loadPresenceMap(true);

        if (!_eventSource || normalizeUpper(streamChannelFor(next)) !== normalizeUpper(_streamChannel)) {
            connectEvents(true);
        }
    }

    function openPrivateThread(name, system, avatar, bridge) {
        var safeName = sanitizeAlias(name);
        var net = normalizeBridge(bridge);
        var key;

        if (!safeName.length) return;
        if (!isLoggedIn()) {
            setStatus('info', 'Log in to open private chats.', false);
            return;
        }

        upsertPrivateThread({
            name: safeName,
            system: trimText(system),
            bridge: net,
            avatar: trimText(avatar),
            lastTimestamp: 0,
            preview: ''
        });

        _activeView = {
            type: 'private',
            name: safeName,
            system: trimText(system),
            avatar: trimText(avatar),
            bridge: net
        };
        key = getCurrentPrivateKey();
        _unreadPrivate[key] = 0;

        dispatchView();
        dispatchPrivateThreads();
        loadActiveHistory(false);
    }

    function setChatPageActive(active) {
        _chatPageActive = !!active;
        if (_chatPageActive) {
            // Room unread is per visit: clear it on entering the chat page.
            // Private threads keep theirs - a PM is read when its thread is
            // opened (the server tracks that), not when the page is.
            _unreadChannels = {};
            dispatchRooms();
            dispatchPrivateThreads();
            updateBadge();
        }
    }

    function send(text) {
        var trimmed = trimText(text);
        if (!trimmed.length || !isLoggedIn()) {
            return Promise.resolve(false);
        }

        if (normalizeUpper(_activeView.type) === 'PRIVATE') {
            return sendPrivateMessage(trimmed).then(function (response) {
                if (response && response.error) {
                    _serviceHealthy = false;
                    setStatus('error', String(response.error), true);
                    return false;
                }
                _serviceHealthy = true;
                refreshStatus();
                loadActiveHistory(true);
                loadPrivateThreads(true);
                scheduleHistoryRefresh();
                return true;
            }).catch(function () {
                _serviceHealthy = false;
                refreshStatus();
                return false;
            });
        }

        return sendPublicMessage(trimmed).then(function (response) {
            if (response && response.error) {
                _serviceHealthy = false;
                setStatus('error', String(response.error), true);
                return false;
            }
            _serviceHealthy = true;
            refreshStatus();
            loadActiveHistory(true);
            loadRoomSummaries(true);
            scheduleHistoryRefresh();
            return true;
        }).catch(function () {
            _serviceHealthy = false;
            refreshStatus();
            return false;
        });
    }

    // Join-or-create a local room and open it. (createRoom is the old name.)
    function joinRoom(name) {
        var raw = trimText(name);
        var next = sanitizeChannelName(raw);

        if (!raw.length || !next.length || !isLoggedIn() || isBridgeRoom(next)) {
            return Promise.resolve(false);
        }

        return postForm({ action: 'joinRoom', channel: next }).then(function (response) {
            if (response && response.error) {
                _serviceHealthy = false;
                setStatus('error', String(response.error), true);
                return false;
            }
            ensureRoom(next).joined = true;
            _pendingJoin[normalizeUpper(next)] = true;
            _serviceHealthy = true;
            refreshStatus();
            loadRoomSummaries(true);
            setActivePublicChannel(next, true);
            return true;
        }).catch(function () {
            _serviceHealthy = false;
            refreshStatus();
            return false;
        });
    }

    function joinedLocalRooms() {
        return _rooms.filter(function (room) { return !room.bridge && room.joined; });
    }

    // Drop a local room from the sidebar (the room goes on without us). If
    // it was the open one, move to the most recently active room we are
    // still in - or, when there is none left, park on #main WITHOUT joining
    // it, so the page can ask.
    function leaveRoom(name) {
        var next = sanitizeChannelName(name);
        var room = findRoom(next);
        var remaining;

        if (!isLoggedIn() || isBridgeRoom(next)) {
            return Promise.resolve(false);
        }
        if (room) room.joined = false;
        delete _pendingJoin[normalizeUpper(next)];
        _unreadChannels[normalizeUpper(next)] = 0;
        if (normalizeUpper(_currentChannel) === normalizeUpper(next) && normalizeUpper(_activeView.type) === 'CHANNEL') {
            remaining = joinedLocalRooms().sort(function (a, b) { return (b.lastTimestamp || 0) - (a.lastTimestamp || 0); });
            if (remaining.length) {
                setActivePublicChannel(remaining[0].name, true);
            } else {
                setActivePublicChannel(DEFAULT_CHANNEL, true, true);
            }
        } else {
            dispatchRooms();
        }
        return postForm({ action: 'leaveRoom', channel: next }).then(function (response) {
            if (response && response.error) {
                setStatus('error', String(response.error), false);
                return false;
            }
            return true;
        }).catch(function () { return false; });
    }

    function retrySync() {
        _reconnectAttemptCount = 0;
        _serviceHealthy = true;
        closeEventSource();
        reconcileState(true);
        connectEvents(true);
    }

    function initializeFromLocation() {
        var params;
        var requestedChannel;
        var requestedPrivate;
        var requestedSystem;

        try {
            params = new URLSearchParams(window.location.search);
        } catch (_err) {
            params = null;
        }

        if (!params) {
            setActivePublicChannel(DEFAULT_CHANNEL, false);
            return;
        }

        requestedChannel = sanitizeChannelName(params.get('channel') || DEFAULT_CHANNEL);
        requestedPrivate = sanitizeAlias(params.get('private') || '');
        requestedSystem = trimText(params.get('system') || '');
        var requestedBridge = normalizeBridge(params.get('bridge') || '');

        loadBridgeState();
        _currentChannel = requestedChannel;
        ensureRoom(requestedChannel);
        if (isBridgeRoom(requestedChannel) && isLoggedIn()) {
            _bridgeHold[normalizeBridge(requestedChannel)] = true;
            saveBridgeHold();
        }

        if (requestedPrivate.length && isLoggedIn()) {
            _activeView = {
                type: 'private',
                name: requestedPrivate,
                system: requestedSystem,
                avatar: '',
                bridge: requestedBridge
            };
            upsertPrivateThread({
                name: requestedPrivate,
                system: requestedSystem,
                bridge: requestedBridge,
                avatar: '',
                lastTimestamp: 0,
                preview: ''
            });
        } else {
            _activeView = {
                type: 'channel',
                name: requestedChannel,
                system: '',
                avatar: '',
                bridge: ''
            };
        }

        dispatchView();
        dispatchRooms();

        if (!isLoggedIn()) {
            // Guest snapshot mode: one-time fetch, no SSE or polling
            _guestMode = true;
            loadRoomSummaries(false);
            loadActiveHistory(false);
            return;
        }

        dispatchPrivateThreads();
        loadRoomSummaries(false).then(function () {
            loadPresenceMap(true);
        });
        loadPrivateThreads(false);
        loadActiveHistory(false);
        loadUsers(_currentChannel, false);
        if (!_eventSource) connectEvents(false); /* a page may have opened it already */
        startReconcileLoop();
        // Back to a tab that was hidden on a room: what came in meanwhile is read now.
        document.addEventListener('visibilitychange', function () {
            if (document.hidden || !_chatPageActive || normalizeUpper(_activeView.type) !== 'CHANNEL') return;
            _unreadChannels[normalizeUpper(_currentChannel)] = 0;
            dispatchRooms();
            loadActiveHistory(true);
        });
    }

    window.ChatService = {
        send: send,
        createRoom: joinRoom,
        joinRoom: joinRoom,
        leaveRoom: leaveRoom,
        hasJoinedRooms: function () { return joinedLocalRooms().length > 0; },
        retrySync: retrySync,
        loadHistory: function () { return loadActiveHistory(false); },
        getUsers: function (channel, silent) { return loadUsers(channel || _currentChannel, !!silent); },
        getUsersSnapshot: function () { return cloneUsers(); },
        getMessages: messagesWithNotices,
        getRooms: function () { return cloneRooms(); },
        getPrivateThreads: function () { return clonePrivateThreads(); },
        getStatus: function () { return cloneStatus(); },
        getActiveView: function () {
            return {
                type: _activeView.type,
                name: _activeView.name,
                system: _activeView.system || '',
                avatar: _activeView.avatar || '',
                bridge: _activeView.bridge || '',
                currentChannel: _currentChannel
            };
        },
        setActiveChannel: function (name) { setActivePublicChannel(name, true); },
        openPrivateThread: openPrivateThread,
        dismissPrivateThread: dismissPrivateThread,
        leaveBridge: leaveBridge,
        isBridgeHeld: function (name) { return !!_bridgeHold[normalizeBridge(name)]; },
        setBridgeRoom: setBridgeRoom,
        getBridgeRoom: function (name) { var net = normalizeBridge(name); return net === 'mrc' || net === 'irc' ? _bridgeRoom[net] : ''; },
        fetchBridgeRooms: fetchBridgeRooms,
        isGuestMode: function () { return _guestMode; },
        setChatPageActive: setChatPageActive,
        _renderEmbeddedAvatars: renderEmbeddedAvatars,
        _renderEmbeddedBitmaps: renderEmbeddedBitmaps,
        buildBitmapPayload: buildBitmapPayload
    };

    window.addEventListener('spa:beforeNavigate', function () {
        _chatPageActive = false;
    });

    window.addEventListener('beforeunload', function () {
        if (_reconcileTimer) clearInterval(_reconcileTimer);
        if (_sendRefreshTimer) clearTimeout(_sendRefreshTimer);
        if (_reconnectTimer) clearTimeout(_reconnectTimer);
        closeEventSource();
    });

    // Defer init until sbbsConfig is available (set later in index.xjs)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeFromLocation);
    } else {
        initializeFromLocation();
    }
})();
