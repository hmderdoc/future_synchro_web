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
        if (!badge) return;

        if (total > 0) {
            badge.textContent = total > 99 ? '99+' : String(total);
            badge.classList.remove('d-none');
            badge.style.display = '';
        } else {
            badge.textContent = '';
            badge.classList.add('d-none');
            badge.style.display = 'none';
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
        textDiv.textContent = (msg.text || '').substring(0, 200);
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
        var key = buildThreadKey(summary.name, summary.system || '');
        var index;

        for (index = 0; index < _privateThreads.length; index += 1) {
            if (buildThreadKey(_privateThreads[index].name, _privateThreads[index].system || '') === key) {
                _privateThreads[index].system = summary.system || _privateThreads[index].system || '';
                _privateThreads[index].avatar = summary.avatar || _privateThreads[index].avatar;
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

    function loadRoomSummaries(silent) {
        var url = './api/chat.ssjs?action=channels';
        return fetchJSON(url + (_lastRoomPollAt > 0 ? '&since=' + encodeURIComponent(String(_lastRoomPollAt)) : '')).then(function (response) {
            var summaries = response && Array.isArray(response.channels) ? response.channels : [];
            var serverTime = response && response.serverTime ? response.serverTime : Date.now();
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

                if (normalizeUpper(_activeView.type) === 'CHANNEL' && normalizeUpper(_activeView.name) === normalizeUpper(summary.name)) {
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
            var threads = response && Array.isArray(response.threads) ? response.threads : [];
            var serverTime = response && response.serverTime ? response.serverTime : Date.now();
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

                if (normalizeUpper(_activeView.type) === 'PRIVATE' && key === getCurrentPrivateKey()) {
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
            return true;
        }).catch(function () {
            _serviceHealthy = false;
            if (!silent) refreshStatus();
            return false;
        });
    }

    function loadPublicHistory(silent) {
        return fetchJSON('./api/chat.ssjs?action=history&channel=' + encodeURIComponent(_currentChannel)).then(function (response) {
            if (response && response.error) throw new Error(String(response.error));

            _messages = response && Array.isArray(response.messages) ? response.messages : [];
            _unreadChannels[normalizeUpper(_currentChannel)] = 0;
            _serviceHealthy = true;
            if (!silent) refreshStatus();
            dispatchMessages();
            dispatchRooms();
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
            if (response && response.error) throw new Error(String(response.error));

            _messages = response && Array.isArray(response.messages) ? response.messages : [];
            if (response && response.peer) {
                _activeView.system = response.peer.system || _activeView.system || '';
                _activeView.avatar = response.peer.avatar || _activeView.avatar || '';
                upsertPrivateThread(response.peer);
            }
            _unreadPrivate[getCurrentPrivateKey()] = 0;
            _serviceHealthy = true;
            if (!silent) refreshStatus();
            dispatchMessages();
            dispatchPrivateThreads();
            dispatchView();
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

    function loadUsers(channel, silent) {
        var ch = sanitizeChannelName(channel || _currentChannel);
        return fetchJSON('./api/chat.ssjs?action=who&channel=' + encodeURIComponent(ch)).then(function (response) {
            if (response && response.error) throw new Error(String(response.error));
            _users = response && Array.isArray(response.users) ? response.users : [];
            _serviceHealthy = true;
            if (!silent) refreshStatus();
            dispatchUsers();
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

            rebuildOnlinePresence(combined);
            _serviceHealthy = true;
            if (!silent) refreshStatus();
            return true;
        }).catch(function () {
            _serviceHealthy = false;
            if (!silent) refreshStatus();
            return false;
        });
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
        return loadRoomSummaries(true).then(function () {
            var work = [
                loadPrivateThreads(true),
                loadActiveHistory(true),
                loadPresenceMap(true)
            ];

            _usersRefreshTick += 1;
            if (forceUsers || _chatPageActive || _usersRefreshTick >= 2) {
                _usersRefreshTick = 0;
                work.push(loadUsers(_currentChannel, true));
            }

            return Promise.all(work).then(function () {
                return true;
            }).catch(function () {
                return false;
            });
        }).catch(function () {
            return false;
        });
    }

    function startReconcileLoop() {
        if (_reconcileTimer) return;
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
        if (_reconnectTimer) return;
        _reconnectTimer = setTimeout(function () {
            _reconnectTimer = 0;
            connectEvents(true);
        }, RECONNECT_DELAY);
    }

    function connectEvents(isReconnect) {
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
                room = ensureRoom(payload.channel || _currentChannel);
                room.lastTimestamp = Math.max(room.lastTimestamp || 0, payload.timestamp || 0);

                if (normalizeUpper(_activeView.type) === 'CHANNEL' && normalizeUpper(_activeView.name) === normalizeUpper(payload.channel || _currentChannel)) {
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
                thread = upsertPrivateThread({
                    name: payload.peerName || payload.sender,
                    system: payload.peerSystem || payload.system || '',
                    avatar: payload.peerAvatar || payload.avatar || undefined,
                    lastTimestamp: payload.timestamp || Date.now(),
                    preview: payload.text || ''
                });
                threadKey = buildThreadKey(thread.name, thread.system || '');

                if (normalizeUpper(_activeView.type) === 'PRIVATE' && threadKey === getCurrentPrivateKey()) {
                    _messages.push({
                        sender: payload.sender,
                        system: payload.system,
                        text: payload.text,
                        timestamp: payload.timestamp,
                        userNumber: payload.userNumber,
                        avatar: payload.avatar
                    });
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
            if (normalizeUpper(_activeView.type) === 'CHANNEL') {
                _unreadChannels[normalizeUpper(_activeView.name)] = 0;
                dispatchRooms();
            } else if (normalizeUpper(_activeView.type) === 'PRIVATE') {
                _unreadPrivate[getCurrentPrivateKey()] = 0;
                dispatchPrivateThreads();
            }
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
        setChatPageActive: setChatPageActive,
        _renderEmbeddedAvatars: renderEmbeddedAvatars
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

    initializeFromLocation();
})();
