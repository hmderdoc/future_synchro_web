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
    var RECONNECT_DELAY = 4000;
    var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    var LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    var DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    var DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

    var _messages = [];
    var _users = [];
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
    var _activeView = { type: 'channel', name: DEFAULT_CHANNEL, system: '', avatar: '' };
    var _status = { type: '', message: '', showRetry: false };
    var _guestMode = false;
    var _bitmapRecords = {};

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

    function buildThreadKey(name, system) {
        return buildNameKey(name) + '|' + normalizeUpper(system);
    }

    function getCurrentPrivateKey() {
        if (_activeView.type !== 'private') {
            return '';
        }
        return buildThreadKey(_activeView.name, _activeView.system || '');
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

    function isThreadOnline(name, system) {
        var exactKey = buildThreadKey(name, system || '');
        var nameKey = buildNameKey(name);

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

        return String(text || '');
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

    function showToast(msg) {
        var container;
        var toast;
        var avatarDiv;
        var contentDiv;
        var senderDiv;
        var textDiv;
        var closeBtn;
        var href = './?page=004-chat.xjs';

        if (_chatPageActive) return;

        container = document.getElementById('chat-toasts');
        if (!container) return;

        while (container.children.length >= MAX_TOASTS) {
            container.removeChild(container.lastChild);
        }

        if (msg.type === 'private' && msg.peerName) {
            href += '&private=' + encodeURIComponent(msg.peerName);
            if (msg.peerSystem) {
                href += '&system=' + encodeURIComponent(msg.peerSystem);
            }
        } else if (msg.channel) {
            href += '&channel=' + encodeURIComponent(msg.channel);
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
            ? ('PM from ' + (msg.sender || 'Unknown'))
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
        var key = buildThreadKey(summary.name, summary.system || '');
        var index;

        for (index = 0; index < _privateThreads.length; index += 1) {
            if (buildThreadKey(_privateThreads[index].name, _privateThreads[index].system || '') === key) {
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
            var key = buildThreadKey(thread.name, thread.system || '');

            if (!map[key]) {
                map[key] = {
                    name: thread.name,
                    system: thread.system || '',
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
            var key = buildThreadKey(thread.name, thread.system || '');
            return {
                name: thread.name,
                system: thread.system || '',
                avatar: thread.avatar || undefined,
                lastTimestamp: thread.lastTimestamp || 0,
                preview: thread.preview || '',
                unreadCount: _unreadPrivate[key] || 0,
                isOnline: isThreadOnline(thread.name, thread.system || ''),
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
                userNumber: entry.userNumber || 0,
                avatar: entry.avatar || undefined,
                qwkid: entry.qwkid || undefined
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
            currentChannel: _currentChannel
        });
    }

    function applyRoomSummaries(summaries, serverTime, silent) {
        summaries = Array.isArray(summaries) ? summaries : [];
        serverTime = serverTime || Date.now();
        var nextRooms = [];

        summaries.forEach(function (summary) {
            var room = ensureRoom(summary.name);
            room.userCount = summary.userCount || 0;
            room.lastTimestamp = summary.lastTimestamp || 0;
            room.newCount = summary.newCount || 0;

            if (
                !_realtimeHealthy &&
                (summary.newCount || 0) > 0 &&
                !(normalizeUpper(_activeView.type) === 'CHANNEL' && normalizeUpper(_activeView.name) === normalizeUpper(summary.name))
            ) {
                _unreadChannels[normalizeUpper(summary.name)] = (_unreadChannels[normalizeUpper(summary.name)] || 0) + summary.newCount;
            }

            if (_chatPageActive && normalizeUpper(_activeView.type) === 'CHANNEL' && normalizeUpper(_activeView.name) === normalizeUpper(summary.name)) {
                _unreadChannels[normalizeUpper(summary.name)] = 0;
            }

            nextRooms.push(room);
        });

        _rooms = nextRooms.length ? nextRooms : [ensureRoom(_currentChannel)];
        ensureRoom(_currentChannel);
        _lastRoomPollAt = serverTime;
        _serviceHealthy = true;
        if (!silent) refreshStatus();
        dispatchRooms();
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

        threads.forEach(function (summary) {
            var thread = upsertPrivateThread(summary);
            var key = buildThreadKey(thread.name, thread.system || '');

            if (
                !_realtimeHealthy &&
                (summary.newCount || 0) > 0 &&
                !(normalizeUpper(_activeView.type) === 'PRIVATE' && key === getCurrentPrivateKey())
            ) {
                _unreadPrivate[key] = (_unreadPrivate[key] || 0) + summary.newCount;
            }

            if (_chatPageActive && normalizeUpper(_activeView.type) === 'PRIVATE' && key === getCurrentPrivateKey()) {
                _unreadPrivate[key] = 0;
            }

            if (!seen[key]) {
                seen[key] = true;
                nextThreads.push(thread);
            }
        });

        if (normalizeUpper(_activeView.type) === 'PRIVATE') {
            if (!nextThreads.some(function (thread) {
                return buildThreadKey(thread.name, thread.system || '') === getCurrentPrivateKey();
            })) {
                nextThreads.push({
                    name: _activeView.name,
                    system: _activeView.system || '',
                    avatar: _activeView.avatar || undefined,
                    lastTimestamp: 0,
                    preview: ''
                });
            }
        }

        _privateThreads = nextThreads;
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
        if (_chatPageActive) _unreadChannels[normalizeUpper(_currentChannel)] = 0;
        _serviceHealthy = true;
        if (!silent) refreshStatus();
        if (messagesChanged) {
            dispatchMessages();
        }
        dispatchRooms();
    }

    function loadPublicHistory(silent) {
        return fetchJSON('./api/chat.ssjs?action=history&channel=' + encodeURIComponent(_currentChannel)).then(function (response) {
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
                upsertPrivateThread(response.peer);
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
        _users = Array.isArray(users) ? users : [];
        _serviceHealthy = true;
        if (!silent) refreshStatus();
        dispatchUsers();
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

        return fetchJSON('./api/chat.ssjs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
        });
    }

    function createRoomRequest(name) {
        var body = new URLSearchParams();
        body.set('action', 'createChannel');
        body.set('channel', sanitizeChannelName(name));

        return fetchJSON('./api/chat.ssjs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString()
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
            + '&history=' + (isPrivateView ? '0' : '1')
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

    function buildEventUrl() {
        var url = './api/events.ssjs?subscribe=chat&channel=' + encodeURIComponent(_currentChannel);
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
            connectEvents(true);
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
                    _unreadChannels[normalizeUpper(payload.channel || _currentChannel)] = 0;
                    dispatchMessages();
                } else {
                    _unreadChannels[normalizeUpper(payload.channel || _currentChannel)] = (_unreadChannels[normalizeUpper(payload.channel || _currentChannel)] || 0) + 1;
                    if (!_chatPageActive) showToast(payload);
                }

                dispatchRooms();
                return;
            }

            if (payload.type === 'join' || payload.type === 'part') {
                if (normalizeUpper(payload.channel || _currentChannel) === normalizeUpper(_currentChannel)) {
                    loadUsers(_currentChannel, true);
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
                threadKey = buildThreadKey(thread.name, thread.system || '');

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
                    dispatchMessages();
                } else {
                    _unreadPrivate[threadKey] = (_unreadPrivate[threadKey] || 0) + 1;
                    if (!_chatPageActive) showToast(payload);
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

    function setActivePublicChannel(name, reconnect) {
        var next = sanitizeChannelName(name || DEFAULT_CHANNEL);
        var changed = normalizeUpper(_currentChannel) !== normalizeUpper(next);

        _currentChannel = next;
        ensureRoom(next);
        _activeView = { type: 'channel', name: next, system: '', avatar: '' };
        _unreadChannels[normalizeUpper(next)] = 0;

        dispatchView();
        dispatchRooms();

        loadActiveHistory(false);
        loadUsers(next, false);
        loadPresenceMap(true);

        if (changed || reconnect) {
            connectEvents(changed || reconnect);
        }
    }

    function openPrivateThread(name, system, avatar) {
        var safeName = sanitizeAlias(name);
        var key;

        if (!safeName.length) return;
        if (!isLoggedIn()) {
            setStatus('info', 'Log in to open private chats.', false);
            return;
        }

        upsertPrivateThread({
            name: safeName,
            system: trimText(system),
            avatar: trimText(avatar),
            lastTimestamp: 0,
            preview: ''
        });

        _activeView = {
            type: 'private',
            name: safeName,
            system: trimText(system),
            avatar: trimText(avatar)
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
            // Clear all unread counts on entering the chat page
            _unreadChannels = {};
            _unreadPrivate = {};
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

    function createRoom(name) {
        var raw = trimText(name);
        var next = sanitizeChannelName(raw);

        if (!raw.length || !next.length || !isLoggedIn()) {
            return Promise.resolve(false);
        }

        return createRoomRequest(next).then(function (response) {
            if (response && response.error) {
                _serviceHealthy = false;
                setStatus('error', String(response.error), true);
                return false;
            }
            ensureRoom(next);
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

        _currentChannel = requestedChannel;
        ensureRoom(requestedChannel);

        if (requestedPrivate.length && isLoggedIn()) {
            _activeView = {
                type: 'private',
                name: requestedPrivate,
                system: requestedSystem,
                avatar: ''
            };
            upsertPrivateThread({
                name: requestedPrivate,
                system: requestedSystem,
                avatar: '',
                lastTimestamp: 0,
                preview: ''
            });
        } else {
            _activeView = {
                type: 'channel',
                name: requestedChannel,
                system: '',
                avatar: ''
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
        connectEvents(false);
        startReconcileLoop();
    }

    window.ChatService = {
        send: send,
        createRoom: createRoom,
        retrySync: retrySync,
        loadHistory: function () { return loadActiveHistory(false); },
        getUsers: function (channel, silent) { return loadUsers(channel || _currentChannel, !!silent); },
        getUsersSnapshot: function () { return cloneUsers(); },
        getMessages: function () { return _messages.slice(); },
        getRooms: function () { return cloneRooms(); },
        getPrivateThreads: function () { return clonePrivateThreads(); },
        getStatus: function () { return cloneStatus(); },
        getActiveView: function () {
            return {
                type: _activeView.type,
                name: _activeView.name,
                system: _activeView.system || '',
                avatar: _activeView.avatar || '',
                currentChannel: _currentChannel
            };
        },
        setActiveChannel: function (name) { setActivePublicChannel(name, true); },
        openPrivateThread: openPrivateThread,
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
