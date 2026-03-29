function LoadingMessage() {

    let pos = 0;
    let cursor = ['|', '/', '—', '\\' ];
    let evt;

    const flc = document.getElementById('forum-list-container');
    
    this.start = function () {
        const elem = document.querySelector('div[data-loading-template]').cloneNode(true);
        const sc = elem.querySelector('span[data-spinning-cursor]');
        elem.removeAttribute('hidden');
        flc.appendChild(elem);
        evt = setInterval(() => {
            sc.innerHTML = cursor[pos % cursor.length];
            pos++;
        }, 250);
    }
    
    this.stop = function () {
        flc.removeChild(flc.querySelector('div[data-loading-template]'));
        clearInterval(evt);
    }

}

function formatMessageDate(t) {
    return (new Date(t * 1000)).toLocaleString();
}

// Safely write to localStorage; evict old forum caches on quota error
function safeSetItem(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        if (e.name === 'QuotaExceededError' || e.code === 22) {
            // Evict all forum-related caches and retry once
            var toRemove = [];
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && (k.endsWith('-threadList') || k.match(/^[a-z]+-[a-z]+-\d+$/))) {
                    toRemove.push(k);
                }
            }
            toRemove.forEach(function(k) { localStorage.removeItem(k); });
            try {
                localStorage.setItem(key, value);
            } catch (_) {
                // Still failing — give up silently; page works fine without cache
            }
        }
    }
}


async function setScanCfg(sub, cfg) {
	var opts = [
        'scan-cfg-off',
        'scan-cfg-new',
        'scan-cfg-youonly',
    ];
	const data = await v4_get(`./api/forum.ssjs?call=set-scan-cfg&sub=${sub}&cfg=${cfg}`);
	if (!data.success) return;
	opts.forEach((e, i) => {
        const elem = document.getElementById(`${e}`);
        if (cfg == i) {
            elem.classList.add('btn-primary');
            elem.classList.remove('btn-default');
        } else {
            elem.classList.add('btn-default');
            elem.classList.remove('btn-primary');
        }
	});
}



function showInlineNotice(msg) {
    var existing = document.getElementById('forum-inline-notice');
    if (existing) existing.remove();
    var notice = document.createElement('div');
    notice.id = 'forum-inline-notice';
    notice.className = 'alert alert-success alert-dismissible';
    notice.setAttribute('role', 'alert');
    notice.innerHTML = msg + '<button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>';
    var container = document.getElementById('forum-list-container') || document.getElementById('content');
    if (container) container.parentNode.insertBefore(notice, container);
    setTimeout(function () { var el = document.getElementById('forum-inline-notice'); if (el) el.remove(); }, 5000);
}

async function addNew(sub) {

    if (document.getElementById('newmessage') !== null) return;

    const elem = document.getElementById('forum-new-message-template').cloneNode(true);
    elem.id = 'newmessage';
    elem.innerHTML = elem.innerHTML.replace(/SUB/g, sub);

    const li = document.createElement('li');
    li.id = 'newmessage-li';
    li.className = 'list-group-item';
    li.appendChild(elem);
    document.getElementById('forum-list-container').prepend(li);

    elem.removeAttribute('hidden');

    const data = await v4_get('./api/forum.ssjs?call=get-signature');
    const nmb = elem.getElementsByTagName('textarea')[0];
    nmb.value += `\r\n${data.signature}`;
    nmb.setSelectionRange(0, 0);
	document.getElementById('newmessage').scrollIntoView({ behavior: 'smooth', block: 'end' });
	nmb.onkeydown = evt => evt.stopImmediatePropagation();

}


// After posting, refresh the visible content without full page reload
async function refreshThreadList(sub) {
    // Clear existing threads from DOM
    var container = document.getElementById('forum-list-container');
    if (!container) return;
    container.querySelectorAll('[data-thread]').forEach(function (el) { el.remove(); });
    // Reset scroll state so listThreads will fetch fresh
    _threadScrollLoading = false;
    _threadScrollExhausted = false;
    _threadScrollCursor = null;
    // Clear localStorage cache for this sub's thread list
    localStorage.removeItem(sub + '-threadList');
    // Re-fetch
    await listThreads(sub, _threadPageSize);
}

async function refreshMessageList(sub, thread) {
    // Find the last visible message number
    var lastMsg = lastVisibleMessage();
    if (lastMsg === null) return;
    // Fetch messages after the last one we have
    // Clear localStorage cache so we get fresh data
    localStorage.removeItem(sub + '-' + thread);
    _msgScrollLoading = false;
    // Fetch all messages fresh, but only render the new ones
    var data = await v4_fetch_jsonl('./api/forum.ssjs?call=get-thread&sub=' + sub + '&thread=' + thread + '&count=100&after=' + lastMsg);
    if (!data || !data.length) return;
    var users = [];
    data.forEach(function (e) {
        var elemId = 'forum-message-' + e.number;
        if (document.getElementById(elemId)) return; // Already rendered
        var elem = document.getElementById('forum-message-template').cloneNode(true);
        elem.id = elemId;
        elem.setAttribute('data-message', e.number);
        var akey = populateMessageCard(elem, e);
        var deleteBtn = elem.querySelector('button[data-button-delete]');
        if (deleteBtn) deleteBtn.onclick = function () { deleteMessage(sub, e.number); };
        var replyBtn = elem.querySelector('button[data-button-reply]');
        if (replyBtn) replyBtn.onclick = function () { addReply(sub, e.number); };
        var upvoteBtn = elem.querySelector('button[data-button-upvote]');
        if (upvoteBtn) upvoteBtn.onclick = function () { vote(sub, e.number, true); };
        var downvoteBtn = elem.querySelector('button[data-button-downvote]');
        if (downvoteBtn) downvoteBtn.onclick = function () { vote(sub, e.number, false); };
        elem.removeAttribute('hidden');
        if (typeof renderAllBinIcons === 'function') renderAllBinIcons(elem);
        renderAnsiCanvases(elem);
        document.getElementById('forum-list-container').appendChild(elem);
        if (users.indexOf(akey) < 0) users.push(akey);
    });
    if (users.length && typeof Avatars !== 'undefined' && Avatars.draw) Avatars.draw(users);
    // Scroll to the new message
    var lastNewEl = document.getElementById('forum-message-' + data[data.length - 1].number);
    if (lastNewEl) lastNewEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function postNew(sub) {

    var _nm = document.getElementById('newmessage');
    var _inputs = _nm.getElementsByTagName('input');
    var _textarea = _nm.getElementsByTagName('textarea')[0];
    _inputs[2].setAttribute('disabled', true);

	var _postData = {
		call: 'post',
		sub,
		to: _inputs[0].value,
		subject: _inputs[1].value,
		body: _textarea.value,
	};
	// If the ANSI editor was used, body is base64-encoded raw CP437.
	if (_textarea.dataset.ansi === '1') _postData.ansi = '1';
	const data = await v4_post('./api/forum.ssjs', _postData);

    document.getElementById('newmessage').getElementsByTagName('input')[2].setAttribute('disabled', true);

    if (data.success) {
        const li = document.getElementById('newmessage-li');
        li.parentNode.removeChild(li);
		showInlineNotice('Your message has been posted.');
		await refreshThreadList(sub);
    }

}

function populateMessageCard(elem, e) {
    var avatarSlot = elem.querySelector('[data-message-avatar]') || elem.querySelector('div[data-avatar]');
    var titleRow = elem.querySelector('[data-message-title-row]');
    var subjectEl = elem.querySelector('strong[data-message-subject]');
    var fromAddressEl = elem.querySelector('span[data-message-from-address]');
    var unreadBadge = elem.querySelector('[data-badge-unread]');
    var akey;

    elem.querySelector('a[data-message-anchor]').id = e.number;

    if (e.subject) {
        if (titleRow) titleRow.removeAttribute('hidden');
        if (subjectEl) subjectEl.textContent = e.subject;
    } else {
        if (titleRow) titleRow.setAttribute('hidden', true);
        if (subjectEl) subjectEl.textContent = '';
    }

    elem.querySelector('strong[data-message-from]').textContent = e.from || '';
    if (e.from_net_addr) {
        akey = `${e.from}@${e.from_net_addr}`;
        if (fromAddressEl) fromAddressEl.textContent = `@${e.from_net_addr}`;
        if (avatarSlot) avatarSlot.setAttribute('data-avatar', akey);
    } else {
        akey = e.from;
        if (fromAddressEl) fromAddressEl.textContent = '';
        if (avatarSlot) avatarSlot.setAttribute('data-avatar', `${e.from}`);
    }
    elem.querySelector('strong[data-message-to]').textContent = e.to || '';
    elem.querySelector('strong[data-message-date]').textContent = formatMessageDate(e.when_written_time);
    elem.querySelector('span[data-upvote-count]').textContent = e.votes ? e.votes.up : 0;
    elem.querySelector('span[data-downvote-count]').textContent = e.votes ? e.votes.down : 0;
    elem.querySelector('div[data-message-body]').innerHTML = e.body;
    elem.querySelector('a[data-direct-link]').setAttribute('href', `#${e.number}`);

    if (unreadBadge) {
        if (e.unread) {
            unreadBadge.removeAttribute('hidden');
        } else {
            unreadBadge.setAttribute('hidden', true);
        }
    }

    return akey;
}

async function addReply(sub, id) {

    if (document.getElementById(`replybox-${id}`) !== null) return;

    const elem = document.getElementById('forum-message-reply-template').cloneNode(true);
    elem.id = `replybox-${id}`;
    elem.innerHTML = elem.innerHTML.replace(/SUB/g, sub);
    elem.innerHTML = elem.innerHTML.replace(/ID/g, id);
    elem.removeAttribute('hidden');

	const data = await v4_get('./api/forum.ssjs?call=get-signature');
    const nmb = elem.getElementsByTagName('textarea')[0];
    nmb.value += `\r\n${data.signature}`;
    nmb.setSelectionRange(0, 0);
    nmb.onkeydown = evt => evt.stopImmediatePropagation();

    var msgElem = document.getElementById('forum-message-' + id);
    if (msgElem) msgElem.after(elem);

}

async function postReply(sub, id) {
    document.getElementById(`reply-button-${id}`).setAttribute('disabled', true);
	var _replyEl = document.getElementById(`replytext-${id}`);
	var _postData = {
		call: 'post-reply',
		sub,
		body: _replyEl.value,
		pid: id,
	};
	if (_replyEl.dataset.ansi === '1') _postData.ansi = '1';
	const data = await v4_post('./api/forum.ssjs', _postData);
	if (data.success) {
        document.getElementById(`quote-${id}`).setAttribute('disabled', false);
        const rb = document.getElementById(`replybox-${id}`);
        rb.parentNode.removeChild(rb);
		showInlineNotice('Your message has been posted.');
		var _thread = new URLSearchParams(window.location.search).get('thread');
		if (_thread) await refreshMessageList(sub, _thread);
	} else {
        document.getElementById(`reply-button-${id}`).setAttribute('disabled', false);
	}
}


function quotify(id) {
    var btn = document.getElementById('quote-' + id);
    if (btn) btn.disabled = true;
    var msgBody = document.querySelector('#forum-message-' + id + ' div[data-message-body]');
    if (!msgBody) return;
    var clone = msgBody.cloneNode(true);
    clone.querySelectorAll('blockquote').forEach(function (bq) { bq.remove(); });
    var replyEl = document.getElementById('replytext-' + id);
    if (!replyEl) return;
    replyEl.value =
        clone.textContent.replace(/\n\s*\n\s*\n/g, '\n\n').split(/\r?\n/).map(
            function (line) { return ('> ' + line); }
        ).join('\n') +
        replyEl.value;
}

async function deleteMessage(sub, id) {
    var res = await v4_post('./api/forum.ssjs', { call: 'delete-message', sub: sub, number: id });
    if (res.success) {
        var el = document.getElementById('forum-message-' + id);
        if (el) el.remove();
        showInlineNotice('Message deleted.');
    }
}

async function vote(sub, id, up) {
    var data = await v4_get('./api/forum.ssjs?call=vote&sub=' + sub + '&id=' + id + '&up=' + (up ? 1 : 0));
    if (!data.success) return;
    var elem = document.getElementById('forum-message-' + id);
    if (!elem) return;
    var btn, countEl;
    if (up) {
        btn = elem.querySelector('button[data-button-upvote]');
        countEl = elem.querySelector('span[data-upvote-count]');
        if (btn) btn.classList.add('upvote-fg');
    } else {
        btn = elem.querySelector('button[data-button-downvote]');
        countEl = elem.querySelector('span[data-downvote-count]');
        if (btn) btn.classList.add('downvote-fg');
    }
    if (btn) { btn.disabled = true; btn.blur(); }
    if (countEl) countEl.textContent = parseInt(countEl.textContent) + 1;
}
async function postNewPoll(sub) {

    document.getElementById('newpoll-submit').setAttribute('disabled', true);

    if (document.querySelectorAll('input[name="newpoll-answers"]:checked').length !== 1) return;

	const subject = document.getElementById('newpoll-subject').value;
	if (subject.length < 1) return;

	let answerCount = document.querySelector('input[name="newpoll-answers"]:checked:first').value;
	if (answerCount == 2) answerCount = document.querySelector('input[name="newpoll-answer-count"]').value;
	if (answerCount < 0 || answerCount > 15) return;

	const results = parseInt(document.querySelector('input[name="newpoll-results"]:checked').value);
	if (results < 0 || results > 3) return;

    const answers = Array.from(document.querySelectorAll('input[name="forum-new-poll-field-answer"]')).reduce((a, c) => {
        if (c.value !== '') a.push(c.value);
        return a;
    }, []);
    if (!answers.length) return;

    const comments = Array.from(document.querySelectorAll('input[name="forum-new-poll-field-comment"]')).reduce((a, c) => {
        if (c.value !== '') a.push(c);
        return a;
    }, []);

	const post_data = {
		sub,
		subject,
		votes: answerCount,
		results,
		answer: answers
	};
	if (comments.length) post_data.comment = comments;
    const res = await v4_post('./api/forum.ssjs?call=submit-poll', post_data);
    document.getElementById('newpoll-submit').setAttribute('disabled', false);
	if (res.success) {
        const np = document.getElementById('forum-new-poll');
        np.parentNode.removeChild(np);
		showInlineNotice('Your poll has been posted.');
		await refreshThreadList(sub);
	}

}

function addPoll(sub) {

    if (document.getElementById('forum-new-poll') !== null) return;

    const elem = document.getElementById('forum-new-poll-template').cloneNode(true);
    elem.id = 'forum-new-poll';
    elem.innerHTML = elem.innerHTML.replace(/\-template/g, '');
    elem.innerHTML = elem.innerHTML.replace(/SUB/g, sub);
    elem.removeAttribute('hidden');

    const li = document.createElement('li');
    li.id = 'newpoll-li';
    li.className = 'list-group-item';
    li.appendChild(elem);
    document.getElementById('forum-list-container').prepend(li);

    addPollField('comment', 'newpoll-comment-group');
	addPollField('answer', 'newpoll-answer-group');
	addPollField('answer', 'newpoll-answer-group');
	document.getElementById('forum-new-poll').scrollIntoView({ behavior: 'smooth', block: 'end' });

}

function addPollField(type, target) {
    
    const prefix = `forum-new-poll-field-${type}`;
	const count = document.querySelectorAll(`div[name="${prefix}"]`).length;
	if (type === 'answer' && count > 15) return;
	const number = count + 1;

    const elem = document.getElementById(`forum-new-poll-field-container-template`).cloneNode(true);
    elem.id = `${prefix}-${number}`;
    elem.innerHTML = elem.innerHTML.replace(/\-template/g, '');
    elem.innerHTML = elem.innerHTML.replace(/TYPE/g, type);
    elem.innerHTML = elem.innerHTML.replace(/NUMBER/g, number);
	elem.onkeydown = evt => evt.stopImmediatePropagation();
    elem.removeAttribute('hidden');

    document.getElementById(target).appendChild(elem);

}


// Message list

function lastVisibleMessage() {
    const lastMessageElement = Array.from(document.querySelectorAll('li[data-message]')).pop();
    if (!lastMessageElement) return null;
    const ret = parseInt(lastMessageElement.getAttribute('data-message'), 10);
    if (isNaN(ret) || ret < 0) return null;
    return ret;
}

async function listMessages(sub, thread, count, after) {

    if (_msgScrollLoading) return;
    _msgScrollLoading = true;

    var sentinel = document.getElementById('forum-message-sentinel');
    if (sentinel) sentinel.setAttribute('hidden', true);

    let _data;
    const loadingMessage = new LoadingMessage();
    loadingMessage.start();
    let data = JSON.parse(localStorage.getItem(`${sub}-${thread}`));
    if (data === null) { // We have no local cache
        if (after) { // User clicked "Load more" but we don't know what the newest visible message is meant to be
            const lastMessage = lastVisibleMessage();
            if (lastMessage === null) { // No messages in view, so start at the beginning
                data = await v4_fetch_jsonl(`./api/forum.ssjs?call=get-thread&sub=${sub}&thread=${thread}&count=${count}`);
            } else { // Messages are in view, but we have no cache
                // Rebuild cache and get next 'count' messages
                data = await v4_fetch_jsonl(`./api/forum.ssjs?call=get-thread&sub=${sub}&thread=${thread}&count=${count}&after=${lastMessage}&reload=true`);
                const lmi = data.findIndex(e => e.number === lastMessage);
                if (lmi > -1) _data = data.slice(lmi + 1); // If our lastMessage is cached, set _data to everything after it
            }
        } else { // A clean first load of the page, or reload of first 'count' messages
            data = await v4_fetch_jsonl(`./api/forum.ssjs?call=get-thread&sub=${sub}&thread=${thread}&count=${count}`);
        }
    } else if (after) {
        _data = await v4_fetch_jsonl(`./api/forum.ssjs?call=get-thread&sub=${sub}&thread=${thread}&count=${count}&after=${data[data.length - 1].number}`);
        data = data.concat(_data);
    } else {
        // Always fetch fresh on first load; cache is only for scroll-more
        data = await v4_fetch_jsonl(`./api/forum.ssjs?call=get-thread&sub=${sub}&thread=${thread}&count=${count}`);
    }
    if (data && data.length) safeSetItem(`${sub}-${thread}`, JSON.stringify(data));
    loadingMessage.stop();

    if (!data || !data.length) {
        // Thread expired or empty — clean up any stale cache and show notice
        localStorage.removeItem(`${sub}-${thread}`);
        var container = document.getElementById('forum-list-container');
        if (container && !container.querySelector('.forum-expired-notice')) {
            var notice = document.createElement('div');
            notice.className = 'forum-expired-notice alert alert-info';
            notice.textContent = 'This thread is no longer available.';
            container.appendChild(notice);
        }
        _msgScrollLoading = false;
        _msgScrollExhausted = true;
        return;
    }

    // TO DO: what about poll messages? If they may show up in (_data || data) then they need to be handled differently and a template created in forum.xjs
    const users = [];
    (_data || data).forEach((e, i) => {
        let akey;
        let elem;
        let append = false;
        const elemId = `forum-message-${e.number}`;
        if ((elem = document.getElementById(elemId)) === null) {
            elem = document.getElementById('forum-message-template').cloneNode(true);
            elem.id = elemId;
            elem.setAttribute('data-message', e.number);
            append = true;
        }
        akey = populateMessageCard(elem, e);
        // Wire button handlers
        var deleteBtn = elem.querySelector('button[data-button-delete]');
        if (deleteBtn) deleteBtn.onclick = function () { deleteMessage(sub, e.number); };
        var replyBtn = elem.querySelector('button[data-button-reply]');
        if (replyBtn) replyBtn.onclick = function () { addReply(sub, e.number); };
        var upvoteBtn = elem.querySelector('button[data-button-upvote]');
        if (upvoteBtn) upvoteBtn.onclick = function () { vote(sub, e.number, true); };
        var downvoteBtn = elem.querySelector('button[data-button-downvote]');
        if (downvoteBtn) downvoteBtn.onclick = function () { vote(sub, e.number, false); };
        applyVoteState(e.number);
        elem.removeAttribute('hidden');
        if (typeof renderAllBinIcons === 'function') renderAllBinIcons(elem);
        renderAnsiCanvases(elem);
        if (append) document.getElementById('forum-list-container').appendChild(elem);
        if (users.indexOf(akey) < 0) users.push(akey);
    });

    var loaded = (_data || data).length;
    _msgScrollLoading = false;
    if (loaded < count) {
        _msgScrollExhausted = true;
        if (sentinel) sentinel.setAttribute('hidden', true);
    } else {
        if (sentinel) sentinel.removeAttribute('hidden');
    }

    if (Avatars) Avatars.draw(users);

}


var _msgScrollLoading = false;
var _msgScrollExhausted = false;
var _msgScrollObserver = null;

async function initMessageInfiniteScroll(sub, thread, count) {
    var sentinel = document.getElementById('forum-message-sentinel');
    if (!sentinel) return;
    if (_msgScrollObserver) _msgScrollObserver.disconnect();
    _msgScrollExhausted = false;
    _msgScrollLoading = false;
    await listMessages(sub, thread, count);
    if (_msgScrollExhausted) return;
    _msgScrollObserver = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting && !_msgScrollLoading && !_msgScrollExhausted) {
            listMessages(sub, thread, count, true);
        }
    }, { rootMargin: '200px' });
    _msgScrollObserver.observe(sentinel);
}



// Thread list

function threadAvatarKey(msg) {
    if (!msg || !msg.from) return null;
    return msg.from_net_addr ? `${msg.from}@${msg.from_net_addr}` : `${msg.from}`;
}

function setThreadAvatar(slot, msg) {
    if (!slot) return null;
    var key = threadAvatarKey(msg);
    slot.innerHTML = '';
    if (!key) {
        slot.removeAttribute('data-avatar');
        slot.setAttribute('hidden', true);
        return null;
    }
    slot.setAttribute('data-avatar', key);
    slot.removeAttribute('hidden');
    return key;
}

function setThreadReplyState(elem, threadData) {
    var replies = elem.querySelector('div[data-replies]');
    var noReplies = elem.querySelector('[data-no-replies]');
    var singular = replies ? replies.querySelector('span[data-suffix-reply]') : null;
    var plural = replies ? replies.querySelector('span[data-suffix-replies]') : null;
    var latestAvatar = elem.querySelector('[data-thread-latest-avatar]');
    var avatarKeys = [];
    var replyCount = Math.max(0, ((threadData && threadData.messages) || 0) - 1);

    if (singular) singular.setAttribute('hidden', true);
    if (plural) plural.setAttribute('hidden', true);

    if (replyCount > 0 && replies && threadData && threadData.last) {
        replies.querySelector('strong[data-message-count]').textContent = replyCount;
        if (replyCount === 1) {
            if (singular) singular.removeAttribute('hidden');
        } else {
            if (plural) plural.removeAttribute('hidden');
        }
        replies.querySelector('strong[data-last-from]').textContent = threadData.last.from || '';
        replies.querySelector('span[data-last-time]').textContent = formatMessageDate(threadData.last.when_written_time);
        replies.removeAttribute('hidden');
        if (noReplies) noReplies.setAttribute('hidden', true);
        var latestKey = setThreadAvatar(latestAvatar, threadData.last);
        if (latestKey) avatarKeys.push(latestKey);
    } else {
        if (replies) replies.setAttribute('hidden', true);
        if (noReplies) noReplies.removeAttribute('hidden');
        setThreadAvatar(latestAvatar, null);
    }

    return avatarKeys;
}

function setThreadUnreadState(elem, unread) {
    var stats = elem.querySelector('div[data-stats]');
    var unreadBadge = stats ? stats.querySelector('span[data-unread-messages]') : null;
    if (!unreadBadge) return false;
    unreadBadge.textContent = `${typeof unread === 'number' ? unread : 0} UNREAD`;
    unreadBadge.removeAttribute('hidden');
    if (stats) stats.removeAttribute('hidden');
    return true;
}

function setThreadVoteState(elem, votes) {
    var stats = elem.querySelector('div[data-stats]');
    var upBadge = stats ? stats.querySelector('span[data-upvotes-badge]') : null;
    var downBadge = stats ? stats.querySelector('span[data-downvotes-badge]') : null;
    var shown = false;

    if (upBadge) {
        upBadge.style.setProperty('display', 'none');
    }
    if (downBadge) {
        downBadge.style.setProperty('display', 'none');
    }

    if (votes && votes.total) {
        if (upBadge && votes.up && votes.up.t) {
            stats.querySelector('span[data-upvotes]').textContent = `${votes.up.p}/${votes.up.t}`;
            upBadge.style.setProperty('display', '');
            shown = true;
        }
        if (downBadge && votes.down && votes.down.t) {
            stats.querySelector('span[data-downvotes]').textContent = `${votes.down.p}/${votes.down.t}`;
            downBadge.style.setProperty('display', '');
            shown = true;
        }
    }

    if (shown && stats) stats.removeAttribute('hidden');
    return shown;
}

function populateThreadCard(elem, e) {
    var stats = elem.querySelector('div[data-stats]');
    var subBadge = elem.querySelector('[data-search-sub-badge]');
    var avatarKeys = [];

    elem.querySelector('strong[data-thread-subject]').textContent = e.subject || '';
    elem.querySelector('strong[data-thread-from]').textContent = (e.first && e.first.from) ? e.first.from : '';
    elem.querySelector('span[data-thread-date-start]').textContent = formatMessageDate(e.first.when_written_time);

    if (subBadge) {
        if (e.sub_name) {
            subBadge.textContent = e.sub_name;
            subBadge.removeAttribute('hidden');
        } else {
            subBadge.textContent = '';
            subBadge.setAttribute('hidden', true);
        }
    }

    if (stats) stats.setAttribute('hidden', true);
    var originKey = setThreadAvatar(elem.querySelector('[data-thread-origin-avatar]'), e.first);
    if (originKey) avatarKeys.push(originKey);
    avatarKeys = avatarKeys.concat(setThreadReplyState(elem, e));

    var hasUnread = setThreadUnreadState(elem, typeof e.unread === 'number' ? e.unread : 0);
    var hasVotes = setThreadVoteState(elem, e.votes);
    if (!hasUnread && !hasVotes && stats) stats.setAttribute('hidden', true);

    return avatarKeys.filter(function (key, index, array) {
        return array.indexOf(key) === index;
    });
}

function onThreadStats(data) {

    Object.entries(data).forEach(([k, v]) => {

        if (k == 'sub' || k == 'scan_cfg') return;

        let cache = JSON.parse(localStorage.getItem(`${data.sub}-threadList`));
        if (cache) {
            const idx = cache.threads.findIndex(e => e.id == k);
            if (idx > -1) {
                cache.total += (v.messages - cache.threads[idx].messages);
                cache.threads[idx].last.from = v.last.from;
                cache.threads[idx].last.when_written_time = v.last.when_written_time;
                cache.threads[idx].messages = v.messages;
                cache.threads[idx].unread = v.unread;
                cache.threads[idx].votes = v.votes;
            }
            safeSetItem(`${data.sub}-threadList`, JSON.stringify(cache));
        }

        const elem = document.getElementById(`forum-thread-link-${k}`);
        if (elem === null) return;

        const avatarKeys = setThreadReplyState(elem, v);
        const hasUnread = setThreadUnreadState(elem, typeof v.unread === 'number' ? v.unread : 0);
        const hasVotes = setThreadVoteState(elem, v.votes);
        if (!hasUnread && !hasVotes) {
            const stats = elem.querySelector('div[data-stats]');
            if (stats) stats.setAttribute('hidden', true);
        }
        if (avatarKeys.length && typeof Avatars !== 'undefined' && Avatars.draw) {
            Avatars.draw(avatarKeys);
        }

    });

}

function lastVisibleThread() {
    const lastThreadElement = Array.from(document.querySelectorAll('[data-thread]')).pop();
    if (!lastThreadElement) return null;
    const ret = parseInt(lastThreadElement.getAttribute('data-thread'), 10);
    if (isNaN(ret) || ret < 0) return null;
    return ret;
}

async function listThread(e) {
    let elem;
    let append = false;
    const elemId = `forum-thread-link-${e.id}`;

    if ((elem = document.getElementById(elemId)) === null) {
        elem = document.getElementById('forum-thread-link-template').cloneNode(true);
        elem.id = elemId;
        elem.setAttribute('data-thread', e.id);
        elem.setAttribute('href', `${elem.getAttribute('href')}&thread=${e.id}`);
        append = true;
    }

    const avatarKeys = populateThreadCard(elem, e);

    elem.removeAttribute('hidden');
    if (typeof renderAllBinIcons === 'function') renderAllBinIcons(elem);
    renderAnsiCanvases(elem);
    if (append) document.getElementById('forum-list-container').appendChild(elem);
    if (avatarKeys.length && typeof Avatars !== 'undefined' && Avatars.draw) Avatars.draw(avatarKeys);
}

var _threadScrollLoading = false;
var _threadScrollExhausted = false;
var _threadScrollObserver = null;
var _threadScrollCursor = null;
var _threadPageSize = 20;

function _sortParams() {
    var p = '';
    if (_threadSortMode && _threadSortMode !== 'activity') p += '&sort=' + _threadSortMode;
    if (_threadSortDir) p += '&dir=' + _threadSortDir;
    return p;
}

async function listThreads(sub, count, after) {

    if (_threadScrollLoading) return;
    _threadScrollLoading = true;

    const sentinel = document.getElementById('forum-thread-sentinel');
    if (sentinel) sentinel.setAttribute('hidden', true);

    const lm = new LoadingMessage();
    lm.start();
    let loaded = 0;
    try {
        let response;
        let data = ((_threadSortMode && _threadSortMode !== 'activity') || _threadSortDir) ? undefined : await sbbs.forum.getThreads(v => v.sub === sub);
        if (data === undefined || !data.length) {
            if (after) {
                const lastThread = lastVisibleThread();
                if (lastThread === null) {
                    response = await v4_get(`./api/forum.ssjs?call=list-threads&sub=${sub}&count=${count}` + _sortParams());
                } else {
                    response = await v4_get(`./api/forum.ssjs?call=list-threads&sub=${sub}&count=${count}&after=${lastThread}&reload=true` + _sortParams());
                }
            } else {
                response = await v4_get(`./api/forum.ssjs?call=list-threads&sub=${sub}&count=${count}` + _sortParams());
            }
        } else if (after) {
            if (!_threadScrollCursor) {
                // Cache loaded without API — fetch first page to get ordering cursor
                var fresh = await v4_get(`./api/forum.ssjs?call=list-threads&sub=${sub}&count=${count}` + _sortParams());
                if (fresh && fresh.threads && fresh.threads.length > 0) {
                    _threadScrollCursor = fresh.threads[fresh.threads.length - 1].id;
                }
            }
            if (_threadScrollCursor) {
                response = await v4_get(`./api/forum.ssjs?call=list-threads&sub=${sub}&count=${count}&after=${_threadScrollCursor}` + _sortParams());
                if (response && response.threads) data = data.concat(response.threads);
            }
        } else {
            // Always fetch fresh on first load; IndexedDB cache is only for scroll-more
            response = await v4_get(`./api/forum.ssjs?call=list-threads&sub=${sub}&count=${count}` + _sortParams());
        }

        if (response && response.threads) {
            loaded = response.threads.length;
            response.threads.forEach(e => {
                sbbs.forum.setThread(e);
                listThread(e);
            });
            if (loaded > 0) _threadScrollCursor = response.threads[loaded - 1].id;
        } else if (data && data.length) {
            loaded = data.length;
            data.forEach(listThread);
        }
    } catch (err) {
        console.error('listThreads error:', err);
    }
    lm.stop();
    _threadScrollLoading = false;
    if (loaded < count) {
        _threadScrollExhausted = true;
        if (sentinel) sentinel.setAttribute('hidden', true);
    } else {
        if (sentinel) sentinel.removeAttribute('hidden');
    }
}

async function initThreadInfiniteScroll(sub, count) {
    _threadPageSize = count;
    const sentinel = document.getElementById('forum-thread-sentinel');
    if (!sentinel) return;
    if (_threadScrollObserver) _threadScrollObserver.disconnect();
    _threadScrollExhausted = false;
    _threadScrollLoading = false;
    _threadScrollCursor = null;
    await listThreads(sub, count);
    if (_threadScrollExhausted) return;
    _threadScrollObserver = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting && !_threadScrollLoading && !_threadScrollExhausted) {
            listThreads(sub, count, true);
        }
    }, { rootMargin: '200px' });
    _threadScrollObserver.observe(sentinel);
}




// Search & Sort

var _searchActive = false;
var _searchOffset = 0;
var _searchTotal = 0;
var _searchExhausted = false;
var _searchLoading = false;
var _threadSortMode = 'activity';
var _threadSortDir = '';

async function searchForum(loadMore) {
    var input = document.getElementById('forum-search-input');
    if (!input) return;
    var query = input.value.trim();
    if (!query) return;

    if (_searchLoading) return;
    _searchLoading = true;

    var bar = document.getElementById('forum-search-bar');
    var scope = bar ? bar.getAttribute('data-scope') : 'forum';
    var group = bar ? bar.getAttribute('data-group') : '';
    var sub = bar ? bar.getAttribute('data-sub') : '';
    var sort = _threadSortMode || 'activity';

    if (!loadMore) {
        _searchOffset = 0;
        _searchExhausted = false;
        _searchActive = true;
        var container = document.getElementById('forum-list-container');
        if (container) container.innerHTML = '';
        var clearBtn = document.getElementById('forum-search-clear');
        if (clearBtn) clearBtn.removeAttribute('hidden');
        // Disconnect thread scroll observer during search
        if (_threadScrollObserver) _threadScrollObserver.disconnect();
    }

    var count = 20;
    var url = './api/forum.ssjs?call=search-threads&query=' + encodeURIComponent(query) +
              '&scope=' + scope + '&count=' + count + '&offset=' + _searchOffset +
              '&sort=' + sort + (_threadSortDir ? '&dir=' + _threadSortDir : '');
    if ((scope === 'group' || scope === 'sub') && group) url += '&group=' + group;
    if (scope === 'sub' && sub) url += '&sub=' + sub;

    var lm = new LoadingMessage();
    lm.start();
    try {
        var data = await v4_get(url);
        if (data && data.threads) {
            _searchTotal = data.total;
            data.threads.forEach(function(e) { listSearchResult(e); });
            _searchOffset += data.threads.length;
            if (_searchOffset >= _searchTotal || data.threads.length < count) {
                _searchExhausted = true;
            }
        }
    } catch (err) {
        console.error('searchForum error:', err);
    }
    lm.stop();
    _searchLoading = false;

    var sentinel = document.getElementById('forum-thread-sentinel');
    if (sentinel) {
        if (_searchExhausted) {
            sentinel.setAttribute('hidden', true);
        } else {
            sentinel.removeAttribute('hidden');
        }
    }

    // Show result count
    var countEl = document.getElementById('forum-search-count');
    if (!countEl) {
        countEl = document.createElement('small');
        countEl.id = 'forum-search-count';
        countEl.className = 'text-muted';
        countEl.style.marginLeft = '0.5em';
        var barDiv = document.getElementById('forum-search-bar');
        if (barDiv) barDiv.appendChild(countEl);
    }
    countEl.textContent = _searchTotal + ' result' + (_searchTotal !== 1 ? 's' : '');

    // Re-attach observer for search infinite scroll
    if (!_searchExhausted && sentinel) {
        if (_threadScrollObserver) _threadScrollObserver.disconnect();
        _threadScrollObserver = new IntersectionObserver(function(entries) {
            if (entries[0].isIntersecting && !_searchLoading && !_searchExhausted) {
                searchForum(true);
            }
        }, { rootMargin: '200px' });
        _threadScrollObserver.observe(sentinel);
    }
}

function listSearchResult(e) {
    var tmpl = document.getElementById('forum-search-result-template') || document.getElementById('forum-thread-link-template');
    if (!tmpl) return;
    var elem = tmpl.cloneNode(true);
    elem.id = 'forum-search-result-' + e.sub + '-' + e.id;
    elem.setAttribute('data-thread', e.id);

    var page = new URLSearchParams(window.location.search).get('page') || '002-forum.xjs';
    elem.setAttribute('href', './?page=' + page + '&sub=' + e.sub + '&thread=' + e.id);
    var avatarKeys = populateThreadCard(elem, e);

    elem.removeAttribute('hidden');
    if (typeof renderAllBinIcons === 'function') renderAllBinIcons(elem);
    renderAnsiCanvases(elem);
    document.getElementById('forum-list-container').appendChild(elem);
    if (avatarKeys.length && typeof Avatars !== 'undefined' && Avatars.draw) Avatars.draw(avatarKeys);
}

function clearSearch() {
    _searchActive = false;
    _searchOffset = 0;
    _searchTotal = 0;
    _searchExhausted = false;
    _searchLoading = false;

    var input = document.getElementById('forum-search-input');
    if (input) input.value = '';
    var clearBtn = document.getElementById('forum-search-clear');
    if (clearBtn) clearBtn.setAttribute('hidden', true);
    var countEl = document.getElementById('forum-search-count');
    if (countEl) countEl.remove();

    // Remove q from URL and reload page content
    var url = new URL(window.location);
    url.searchParams.delete('q');
    window.location.href = url.toString();
}

function _defaultDir(mode) {
    return (mode === 'subject' || mode === 'sender') ? 'asc' : 'desc';
}

function setSort(mode) {
    if (_threadSortMode === mode) {
        // Toggle direction
        var def = _defaultDir(mode);
        var alt = def === 'desc' ? 'asc' : 'desc';
        _threadSortDir = (_threadSortDir === alt) ? '' : alt;
    } else {
        _threadSortMode = mode;
        _threadSortDir = '';
    }

    document.querySelectorAll('#forum-sort-controls button').forEach(function(btn) {
        var arrow = btn.querySelector('.sort-arrow');
        if (btn.getAttribute('data-sort') === _threadSortMode) {
            btn.classList.add('active');
            if (!arrow) {
                arrow = document.createElement('span');
                arrow.className = 'sort-arrow';
                arrow.style.marginLeft = '4px';
                btn.appendChild(arrow);
            }
            var def = _defaultDir(_threadSortMode);
            var isReversed = _threadSortDir && _threadSortDir !== def;
            arrow.textContent = (def === 'desc') ? (isReversed ? '\u25B2' : '\u25BC') : (isReversed ? '\u25BC' : '\u25B2');
        } else {
            btn.classList.remove('active');
            if (arrow) arrow.remove();
        }
    });

    // Update URL
    var url = new URL(window.location);
    if (_threadSortMode !== 'activity') url.searchParams.set('sort', _threadSortMode);
    else url.searchParams.delete('sort');
    if (_threadSortDir) url.searchParams.set('dir', _threadSortDir);
    else url.searchParams.delete('dir');
    history.replaceState(null, '', url);

    if (_searchActive) {
        searchForum();
    } else {
        // Re-load threads with new sort
        var container = document.getElementById('forum-list-container');
        if (container) container.innerHTML = '';
        _threadScrollLoading = false;
        _threadScrollExhausted = false;
        _threadScrollCursor = null;
        if (_threadScrollObserver) _threadScrollObserver.disconnect();
        var bar = document.getElementById('forum-search-bar');
        var sub = bar ? bar.getAttribute('data-sub') : '';
        if (sub) initThreadInfiniteScroll(sub, _threadPageSize);
    }
}


// Sub list

function showNewestMessage(elem, msg) {
    elem.querySelector('strong[data-newest-message-subject]').innerHTML = msg.subject;
    elem.querySelector('span[data-newest-message-from]').innerHTML = msg.from;
    elem.querySelector('span[data-newest-message-date]').innerHTML = formatMessageDate(msg.date);
    elem.querySelector('span[data-newest-message-container]').removeAttribute('hidden');
}

async function onNewestSubMessage(sub, msg) {
    const rec = await sbbs.forum.getSub(sub);
    if (rec !== undefined) {
        rec.newest_message = msg;
        sbbs.forum.setSub(rec);
    }
    const elem = document.getElementById(`forum-sub-link-${sub}`);
    if (elem !== null) showNewestMessage(elem, msg);
}

async function getNewestMessagePerSub(group) {
    const data = await v4_get(`./api/forum.ssjs?call=get-newest-message-per-sub&group=${group}`);
    Object.entries(data).forEach(([k, v]) => onNewestSubMessage(k, v));
}

function showSubUnreadCount(elem, s, u) { // sub link element, sub code, { total, scanned, newest }
    var unreadBadge = elem.querySelector('span[data-unread-unscanned]');
    var scannedBadge = elem.querySelector('span[data-unread-scanned]');
    var total = u && typeof u.total === 'number' ? u.total : 0;
    if (unreadBadge) {
        unreadBadge.textContent = total + ' UNREAD';
        unreadBadge.hidden = false;
    }
    if (scannedBadge) {
        scannedBadge.textContent = '';
        scannedBadge.hidden = true;
    }
}

function onSubUnreadCount(data) {
    Object.entries(data).forEach(async ([k, v]) => {
        const sub = await sbbs.forum.getSub(k);
        if (sub !== undefined) {
            sub.unread = v;
            await sbbs.forum.setSub(sub);
        }
        const elem = document.getElementById(`forum-sub-link-${k}`);
        if (elem !== null) showSubUnreadCount(elem, k, v);
    });
}

/* ---- Forum icon rendering (12x6 .bin -> dataURL via GraphicsConverter) ---- */
var _forumIconCache = {};
function renderForumIcon(elem, b64) {
    if (!elem) return;
    if (!b64) { elem.style.display = 'none'; return; }
    elem.style.display = '';
    elem.innerHTML = '';
    if (_forumIconCache[b64]) {
        var img = document.createElement('img');
        img.src = _forumIconCache[b64];
        img.className = 'forum-icon-img';
        elem.appendChild(img);
        return;
    }
    try {
        var gc = GraphicsConverter.shared();
        gc.from_bin(atob(b64), 12, 6, function (url) {
            _forumIconCache[b64] = url;
            var img = document.createElement('img');
            img.src = url;
            img.className = 'forum-icon-img';
            elem.appendChild(img);
        }, true);
    } catch (ex) {
        elem.style.display = 'none';
    }
}

function onSubList(data) {
    data.sort((a, b) => a.index < b.index ? -1 : 1).forEach(e => {
        let elem;
        let append = false;
        const elemId = `forum-sub-link-${e.code}`;
        if ((elem = document.getElementById(elemId)) === null) {
            elem = document.getElementById('forum-sub-link-template').cloneNode(true);
            elem.id = elem.id.replace(/template$/, e.code);
            elem.setAttribute('href', `${elem.getAttribute('href')}&sub=${e.code}`);
            append = true;
        }
        renderForumIcon(elem.querySelector('[data-forum-icon]'), e.icon);
        var unreadBadge = elem.querySelector('span[data-unread-unscanned]');
        var scannedBadge = elem.querySelector('span[data-unread-scanned]');
        var totalMsgsBadge = elem.querySelector('span[data-total-msgs]');
        var newestContainer = elem.querySelector('span[data-newest-message-container]');
        elem.querySelector('strong[data-sub-name]').innerHTML = e.name;
        elem.querySelector('p[data-sub-description]').innerHTML = e.description || '';
        if (unreadBadge) {
            unreadBadge.textContent = '0 UNREAD';
            unreadBadge.hidden = false;
        }
        if (scannedBadge) {
            scannedBadge.textContent = '';
            scannedBadge.hidden = true;
        }
        if (totalMsgsBadge) {
            totalMsgsBadge.textContent = '';
            totalMsgsBadge.hidden = true;
        }
        if (newestContainer) newestContainer.setAttribute('hidden', 'hidden');
        if (e.newest) showNewestMessage(elem, e.newest);
        if (e.unread != null) showSubUnreadCount(elem, e.code, e.unread);
        if (e.total_msgs != null) {
            if (totalMsgsBadge) {
                totalMsgsBadge.textContent = e.total_msgs + ' MSGS';
                totalMsgsBadge.hidden = false;
            }
        }
        if (append) document.getElementById('forum-list-container').appendChild(elem);
    });
}

async function listSubs(group) {

    const lm = new LoadingMessage();
    lm.start();
 
    let data = await sbbs.forum.getSubs(v => v.grp_index === group);
    if (data === undefined || !data.length || (data[0] && !data[0].hasOwnProperty('icon'))) {
        data = await v4_get(`./api/forum.ssjs?call=list-subs&group=${group}`);
        data.forEach(async e => await sbbs.forum.setSub(e));
    } else {
        // TO DO: add a TTL for this data instead of refreshing every time
        v4_get(`./api/forum.ssjs?call=list-subs&group=${group}`).then(onSubList);
    }
    lm.stop();
    onSubList(data);

}


// Group list

function showGroupUnreadCount(elem, u) {
    var unreadBadge = elem.querySelector('span[data-unread-unscanned]');
    var scannedBadge = elem.querySelector('span[data-unread-scanned]');
    var total = u && typeof u.total === 'number' ? u.total : 0;
    if (unreadBadge) {
        unreadBadge.textContent = total + ' UNREAD';
        unreadBadge.hidden = false;
    }
    if (scannedBadge) {
        scannedBadge.textContent = '';
        scannedBadge.hidden = true;
    }
}

function onGroupUnreadCount(data) {
    Object.entries(data).forEach(async ([k, v]) => {
        const elem = document.getElementById(`forum-group-link-${k}`);
        showGroupUnreadCount(elem, v);
        const grp = await sbbs.forum.getGroup(parseInt(k, 10));
        if (grp !== undefined) {
            grp.unread = v;
            await sbbs.forum.setGroup(grp);
        }
    });
}

function onGroupList(data) {
    data.forEach(e => {
        let elem;
        let append = false;
        const elemId = `forum-group-link-${e.index}`;
        if ((elem = document.getElementById(elemId)) === null) {
            elem = document.getElementById('forum-group-link-template').cloneNode(true);
            elem.id = elem.id.replace(/template$/, e.index);
            elem.setAttribute('href', `${elem.getAttribute('href')}&group=${e.index}`);
            append = true;
        }
        renderForumIcon(elem.querySelector('[data-forum-icon]'), e.icon);
        elem.querySelector('strong[data-group-name]').innerHTML = e.name;
        elem.querySelector('span[data-unread-unscanned]').innerHTML = '0 UNREAD';
        elem.querySelector('span[data-unread-unscanned]').hidden = false;
        elem.querySelector('span[data-unread-scanned]').innerHTML = '';
        elem.querySelector('span[data-unread-scanned]').hidden = true;
        var desc = elem.querySelector('span[data-group-description]');
        if (desc) desc.innerHTML = e.description || '';
        elem.querySelector('span[data-group-sub-count]').innerHTML = e.sub_count;
        if (e.unread != null) showGroupUnreadCount(elem, e.unread);
        if (append) document.getElementById('forum-list-container').appendChild(elem);
    });
}

async function listGroups() {
    const lm = new LoadingMessage();
    lm.start();
    let data = await sbbs.forum.getGroups();
    if (data === undefined || (Array.isArray(data) && data.length && !data[0].hasOwnProperty('icon'))) {
        console.debug('groups not in cache, fetching');
        data = await v4_get('./api/forum.ssjs?call=list-groups');
        data.forEach(async e => await sbbs.forum.setGroup(e));
    } else {
        // TO DO: add a TTL for this data instead of refreshing every time
        v4_get('./api/forum.ssjs?call=list-groups').then(async data => {
            for (const e of data) {
                await sbbs.forum.setGroup(e);
            }
            onGroupList(data);
        });
    }
    onGroupList(data);
    lm.stop();
}


// --- Vote state tracking for thread view ---
var _threadVoteCache = null;

function applyVoteState(msgNum) {
    if (!_threadVoteCache || !_threadVoteCache[msgNum]) return;
    var vd = _threadVoteCache[msgNum];
    var elem = document.getElementById('forum-message-' + msgNum);
    if (!elem) return;
    var uvBtn = elem.querySelector('button[data-button-upvote]');
    var dvBtn = elem.querySelector('button[data-button-downvote]');
    var uvCount = elem.querySelector('span[data-upvote-count]');
    var dvCount = elem.querySelector('span[data-downvote-count]');
    if (uvCount && vd.u !== undefined) {
        if (parseInt(uvCount.textContent) !== vd.u) {
            uvCount.textContent = vd.u;
            if (uvBtn) uvBtn.classList.add('indicator');
        }
    }
    if (dvCount && vd.d !== undefined) {
        if (parseInt(dvCount.textContent) !== vd.d) {
            dvCount.textContent = vd.d;
            if (dvBtn) dvBtn.classList.add('indicator');
        }
    }
    switch (vd.v) {
        case 1:
            if (uvBtn) { uvBtn.classList.add('upvote-fg'); uvBtn.disabled = true; }
            if (dvBtn) dvBtn.disabled = true;
            break;
        case 2:
            if (dvBtn) { dvBtn.classList.add('downvote-fg'); dvBtn.disabled = true; }
            if (uvBtn) uvBtn.disabled = true;
            break;
    }
}

async function getVotesInThread(sub, id) {
    var data = await v4_get('./api/forum.ssjs?call=get-thread-votes&sub=' + sub + '&id=' + id);
    if (!data || !data.m) return;
    _threadVoteCache = data.m;
    Object.keys(data.m).forEach(function (m) { applyVoteState(m); });
}

async function getVotesInThreads(sub) {
    var data = await v4_get('./api/forum.ssjs?call=get-sub-votes&sub=' + sub);
    if (!data) return;
    Object.keys(data).forEach(function (t) {
        var elem = document.getElementById('forum-thread-link-' + t);
        if (!elem) return;
        var uvSpan = elem.querySelector('span[data-upvotes]');
        var dvSpan = elem.querySelector('span[data-downvotes]');
        if (uvSpan) {
            var uv = data[t].p.u + '/' + data[t].t.u;
            if (uv !== uvSpan.textContent) uvSpan.textContent = uv;
        }
        if (dvSpan) {
            var dv = data[t].p.d + '/' + data[t].t.d;
            if (dv !== dvSpan.textContent) dvSpan.textContent = dv;
        }
    });
}

// --- Thread keyboard navigation ---
function threadNav() {
    var flc = document.getElementById('forum-list-container');
    if (!flc) return;
    function setCurrentFromHash() {
        flc.querySelectorAll('.current').forEach(function (el) { el.classList.remove('current'); });
        var target;
        if (window.location.hash === '') {
            target = flc.querySelector('.list-group-item[data-message]');
        } else {
            target = document.getElementById('forum-message-' + window.location.hash.substr(1));
        }
        if (target) {
            target.classList.add('current');
            target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
    setCurrentFromHash();
    document.addEventListener('keydown', function (evt) {
        if (evt.target.tagName === 'TEXTAREA' || evt.target.tagName === 'INPUT') return;
        var cur = flc.querySelector('.list-group-item.current');
        if (!cur) return;
        var items = Array.from(flc.querySelectorAll('.list-group-item[data-message]'));
        var idx = items.indexOf(cur);
        if (idx < 0) return;
        switch (evt.keyCode) {
            case 37:
                if (idx > 0) {
                    cur.classList.remove('current');
                    items[idx - 1].classList.add('current');
                    items[idx - 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    evt.preventDefault();
                }
                break;
            case 39:
                if (idx < items.length - 1) {
                    cur.classList.remove('current');
                    items[idx + 1].classList.add('current');
                    items[idx + 1].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    evt.preventDefault();
                }
                break;
        }
    });
    // keyboard nav uses direct DOM manipulation, no hashchange needed
}

// --- Poll interaction ---
async function getPollData(sub, id) {
    var data = await v4_get('./api/forum.ssjs?call=get-poll-results&sub=' + sub + '&id=' + id);
    if (!data) return;
    if (data.tally) {
        data.tally.forEach(function (e, i) {
            if (e > 0) {
                var el = document.getElementById('poll-count-' + id + '-' + i);
                if (el) el.textContent = e;
            }
        });
    }
    if (data.answers > 0) {
        document.querySelectorAll('input[name="poll-' + id + '"]').forEach(function (el) {
            el.disabled = true;
        });
        var submitBtn = document.getElementById('submit-poll-' + id);
        if (submitBtn) submitBtn.disabled = true;
    }
}

function pollControl(id, count) {
    document.querySelectorAll('input[name="poll-' + id + '"]').forEach(function (el) {
        el.addEventListener('change', function () {
            var checked = document.querySelectorAll('input[name="poll-' + id + '"]:checked').length;
            document.querySelectorAll('input[name="poll-' + id + '"]:not(:checked)').forEach(function (inp) {
                inp.disabled = checked >= count;
            });
        });
    });
}

async function submitPollAnswers(sub, id) {
    var checked = document.querySelectorAll('input[name="poll-' + id + '"]:checked');
    if (checked.length < 1) return;
    var answers = Array.from(checked).map(function (el) { return el.value; });
    await v4_post('./api/forum.ssjs', {
        call: 'submit-poll-answers',
        sub: sub,
        id: id,
        answer: answers.join('&answer=')
    });
    document.querySelectorAll('input[name="poll-' + id + '"]').forEach(function (el) {
        el.disabled = true;
        if (el.checked) el.parentElement.parentElement.classList.add('upvote-bg');
    });
    var submitBtn = document.getElementById('submit-poll-' + id);
    if (submitBtn) submitBtn.disabled = true;
}

// --- Block sender ---
async function blockSender(id, from, from_net) {
    var data = await v4_get('./api/forum.ssjs?call=block-sender&from=' + encodeURIComponent(from) + '&from_net=' + encodeURIComponent(from_net));
    if (!data.err) {
        var btn = document.getElementById('bsb-' + id);
        if (btn) btn.disabled = true;
    }
}

// --- Unread count fetchers (complement SSE push) ---
async function getSubUnreadCounts(grp) {
    var res = await v4_get('./api/forum.ssjs?call=get-sub-unread-counts&group=' + grp);
    if (res) onSubUnreadCount(res);
}

async function getGroupUnreadCounts() {
    var res = await v4_get('./api/forum.ssjs?call=get-group-unread-counts');
    if (res) onGroupUnreadCount(res);
}


/* ---- ANSI art canvas rendering (upgrade <pre class="ansi"> to GraphicsConverter image) ---- */
var _ansiRenderCache = {};
function renderAnsiCanvases(root) {
    var elems = (root || document).querySelectorAll('.ansi-render[data-ansi-cells]');
    if (!elems.length) return;
    if (typeof GraphicsConverter === 'undefined' || !GraphicsConverter.shared) return;
    var gc = GraphicsConverter.shared();
    if (!gc.from_bitmap_cells) return;

    elems.forEach(function (el) {
        var b64 = el.getAttribute('data-ansi-cells');
        var w = parseInt(el.getAttribute('data-ansi-w'), 10) || 80;
        var h = parseInt(el.getAttribute('data-ansi-h'), 10) || 25;
        if (!b64) return;

        /* Check cache */
        var cacheKey = w + 'x' + h + ':' + b64.substr(0, 64);
        if (_ansiRenderCache[cacheKey]) {
            _replaceAnsiWithImg(el, _ansiRenderCache[cacheKey], w, h);
            return;
        }

        /* Decode base64 -> cell array for from_bitmap_cells */
        var raw;
        try { raw = atob(b64); } catch (e) { return; }
        var total = w * h;
        if (raw.length < total * 2) return;

        var cells = [];
        for (var i = 0; i < total; i++) {
            var charCode = raw.charCodeAt(i * 2) & 0xFF;
            var attr = raw.charCodeAt(i * 2 + 1) & 0xFF;
            cells.push({
                charCode: charCode,
                fg: attr & 0xF,
                bg: (attr >> 4) & 0xF
            });
        }

        gc.from_bitmap_cells(cells, w, h, function (dataURL) {
            if (!dataURL) return;
            _ansiRenderCache[cacheKey] = dataURL;
            _replaceAnsiWithImg(el, dataURL, w, h);
        }, true);
    });
}

function _replaceAnsiWithImg(el, dataURL, w, h) {
    var img = document.createElement('img');
    img.src = dataURL;
    img.alt = 'ANSI art (' + w + '\u00d7' + h + ')';
    img.className = 'ansi-canvas-img';
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.imageRendering = 'pixelated';
    img.style.display = 'block';
    el.innerHTML = '';
    el.appendChild(img);
}

/* ---- Render breadcrumb icons on page load ---- */
function _renderBreadcrumbIcons() {
    document.querySelectorAll('span.bc-icon[data-bc-icon]').forEach(function (span) {
        if (span.querySelector('.forum-icon-img')) return; // already rendered
        var b64 = span.getAttribute('data-bc-icon');
        if (!b64) { span.remove(); return; }
        renderForumIcon(span, b64);
    });
}
// Run immediately, and retry after a short delay in case
// GraphicsConverter spritesheet hasn't loaded yet.
_renderBreadcrumbIcons();
setTimeout(_renderBreadcrumbIcons, 150);
