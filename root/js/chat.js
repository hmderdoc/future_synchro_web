/* chat.js - Global ChatService singleton
 *
 * Lives in the persistent SPA shell (loaded from index.xjs).
 * Manages connection state, message buffer, unread badge, and toasts.
 */
(function () {
    'use strict';

    if (window.ChatService) return;

    var MAX_MESSAGES = 200;
    var TOAST_DURATION = 30000;
    var MAX_TOASTS = 4;

    var _messages = [];
    var _pendingSends = {};
    var _unreadCount = 0;
    var _chatPageActive = false;
    var _users = [];

    /* ---- Badge ---- */
    function _updateBadge() {
        var el = document.getElementById('badge-chat-unread');
        if (!el) return;
        if (_unreadCount > 0) {
            el.textContent = _unreadCount > 99 ? '99+' : _unreadCount;
            el.classList.remove('d-none');
        } else {
            el.classList.add('d-none');
        }
    }

    /* ---- Toasts ---- */
    function _showToast(msg) {
        if (_chatPageActive) return;

        var container = document.getElementById('chat-toasts');
        if (!container) return;

        while (container.children.length >= MAX_TOASTS) {
            container.removeChild(container.lastChild);
        }

        var toast = document.createElement('div');
        toast.className = 'chat-toast chat-toast-enter';

        /* Avatar placeholder */
        var avatarDiv = document.createElement('div');
        avatarDiv.className = 'chat-toast-avatar';
        if (msg.userNumber && msg.userNumber > 0) {
            avatarDiv.setAttribute('data-avatar', msg.userNumber);
        }
        toast.appendChild(avatarDiv);

        /* Content: sender + text */
        var contentDiv = document.createElement('div');
        contentDiv.className = 'chat-toast-content';
        var senderDiv = document.createElement('div');
        senderDiv.className = 'chat-toast-sender';
        senderDiv.textContent = msg.sender || 'System';
        var textDiv = document.createElement('div');
        textDiv.className = 'chat-toast-text';
        textDiv.textContent = (msg.text || '').substring(0, 120);
        contentDiv.appendChild(senderDiv);
        contentDiv.appendChild(textDiv);
        toast.appendChild(contentDiv);

        /* Close button */
        var closeBtn = document.createElement('button');
        closeBtn.className = 'chat-toast-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _removeToast(toast);
        });
        toast.appendChild(closeBtn);

        /* Click anywhere else → navigate to chat */
        toast.addEventListener('click', function () {
            _removeToast(toast);
            /* Use an anchor click so SPA router intercepts it */
            var a = document.createElement('a');
            a.href = './?page=004-chat.xjs';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        });

        container.insertBefore(toast, container.firstChild);

        /* Render avatar into the toast */
        if (msg.userNumber && msg.userNumber > 0 && typeof Avatars !== 'undefined' && Avatars.draw) {
            Avatars.draw([String(msg.userNumber)]);
        }

        requestAnimationFrame(function () {
            toast.classList.remove('chat-toast-enter');
        });

        setTimeout(function () { _removeToast(toast); }, TOAST_DURATION);
    }

    function _removeToast(el) {
        if (!el || !el.parentNode) return;
        el.classList.add('chat-toast-exit');
        setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
        }, 400);
    }

    function _escapeHtml(str) {
        var d = document.createElement('div');
        d.appendChild(document.createTextNode(str));
        return d.innerHTML;
    }

    /* ---- Message handling ---- */
    function _onMessage(e) {
        var data = e.detail;
        if (!data) return;

        if (data.type === 'message') {
            /* Dedup echo from our own send (match by text within 10s window) */
            var dominated = false;
            for (var k in _pendingSends) {
                if (k.indexOf(':' + data.text) > -1) {
                    var sentTs = parseInt(k.split(':')[0], 10);
                    if (Math.abs(data.timestamp - sentTs) < 10000) {
                        delete _pendingSends[k];
                        dominated = true;
                        break;
                    }
                }
            }
            if (dominated) return;

            _messages.push(data);
            if (_messages.length > MAX_MESSAGES) _messages.shift();

            if (!_chatPageActive) {
                _unreadCount++;
                _updateBadge();
                _showToast(data);
            }

            window.dispatchEvent(new CustomEvent('chat:newMessage', { detail: data }));
        } else if (data.type === 'join' || data.type === 'part') {
            window.dispatchEvent(new CustomEvent('chat:userEvent', { detail: data }));
        }
    }

    /* ---- API calls ---- */
    function send(text) {
        if (!text || !window.sbbsConfig || !window.sbbsConfig.isLoggedIn) return;

        var ts = Date.now();
        _pendingSends[ts + ':' + text] = true;
        setTimeout(function () { delete _pendingSends[ts + ':' + text]; }, 10000);

        var localMsg = {
            type: 'message',
            sender: window.sbbsConfig.userAlias || '',
            text: text,
            timestamp: ts,
            userNumber: window.sbbsConfig.userNumber || 0
        };
        _messages.push(localMsg);
        if (_messages.length > MAX_MESSAGES) _messages.shift();
        window.dispatchEvent(new CustomEvent('chat:newMessage', { detail: localMsg }));

        var xhr = new XMLHttpRequest();
        xhr.open('POST', './api/chat.ssjs');
        xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        xhr.send('action=send&channel=main&message=' + encodeURIComponent(text));
    }

    function loadHistory(channel) {
        var ch = channel || 'main';
        var xhr = new XMLHttpRequest();
        xhr.open('GET', './api/chat.ssjs?action=history&channel=' + encodeURIComponent(ch));
        xhr.onload = function () {
            if (xhr.status === 200) {
                try {
                    var resp = JSON.parse(xhr.responseText);
                    if (resp.messages && resp.messages.length) {
                        _messages = resp.messages.map(function (m) {
                            return {
                                type: 'message',
                                sender: m.sender || '',
                                system: m.system || '',
                                text: m.text || '',
                                timestamp: m.timestamp || 0,
                                userNumber: m.userNumber || 0
                            };
                        });
                        window.dispatchEvent(new CustomEvent('chat:historyLoaded'));
                    }
                } catch (e) {}
            }
        };
        xhr.send();
    }

    function getUsers(channel) {
        var ch = channel || 'main';
        var xhr = new XMLHttpRequest();
        xhr.open('GET', './api/chat.ssjs?action=who&channel=' + encodeURIComponent(ch));
        xhr.onload = function () {
            if (xhr.status === 200) {
                try {
                    var resp = JSON.parse(xhr.responseText);
                    _users = resp.users || [];
                    window.dispatchEvent(new CustomEvent('chat:usersUpdated', { detail: _users }));
                } catch (e) {}
            }
        };
        xhr.send();
    }

    /* ---- Public API ---- */
    window.ChatService = {
        send: send,
        loadHistory: loadHistory,
        getUsers: getUsers,
        getMessages: function () { return _messages; },
        setChatPageActive: function (active) {
            _chatPageActive = active;
            if (active) {
                _unreadCount = 0;
                _updateBadge();
            }
        }
    };

    /* Listen for SSE-dispatched events */
    window.addEventListener('chat:message', _onMessage);

    /* On SPA navigation away, mark chat inactive */
    window.addEventListener('spa:beforeNavigate', function () {
        _chatPageActive = false;
    });

})();
