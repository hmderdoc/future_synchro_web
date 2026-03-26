// Add a parameter to the query string
function insertParam(key, value) {
    key = encodeURIComponent(key);
    value = encodeURIComponent(value);
    var kvp = window.location.search.substr(1).split('&');
    var i = kvp.length, x;
    while (i--) {
        x = kvp[i].split('=');
        if (x[0] == key) {
            x[1] = value;
            kvp[i] = x.join('=');
            break;
        }
    }
    if (i<0) kvp[kvp.length] = [key,value].join('=');
    window.location.search = kvp.join('&');
}

// For now we'll just remove nested quotes from the parent post
function quotify(id) {
    var btn = document.getElementById('quote-' + id);
    if (btn) btn.disabled = true;
    var msgEl = document.getElementById('message-' + id);
    var clone = msgEl.cloneNode(true);
    clone.querySelectorAll('blockquote').forEach(function (bq) { bq.remove(); });
    var replyEl = document.getElementById('replytext-' + id);
    replyEl.value =
        clone.textContent.replace(/\n\s*\n\s*\n/g, '\n\n').split(/\r?\n/).map(
            function (line) { return ("> " + line); }
        ).join('\n') +
        replyEl.value;
}

// (Try to) post a new message to 'sub' via the web API
async function postNew(sub) {
    var btn = document.getElementById('newmessage-button');
    btn.disabled = true;
    var to = document.getElementById('newmessage-to').value;
    var subject = document.getElementById('newmessage-subject').value;
    var body = document.getElementById('newmessage-body').value;
    const data = await v4_post('./api/forum.ssjs', {
        call: 'post',
        sub,
        to,
        subject,
        body
    });
    if (data.success) {
        var el = document.getElementById('newmessage');
        if (el) el.remove();
        var notice = document.createElement('div');
        notice.id = 'noticebox';
        notice.className = 'alert alert-success';
        notice.textContent = 'Your message has been posted.';
        var container = document.getElementById('forum-list-container');
        if (container) container.parentNode.insertBefore(notice, container);
        setTimeout(function () {
            notice.style.transition = 'opacity 1s';
            notice.style.opacity = '0';
            setTimeout(function () { notice.remove(); }, 1000);
        }, 3000);
    }
    btn.disabled = false;
}

// (Try to) post a reply to message number 'id' of 'sub' via the web API
async function postReply(sub, id) {
    var btn = document.getElementById('reply-button-' + id);
    btn.disabled = true;
    var body = document.getElementById('replytext-' + id).value;
    const data = await v4_post('./api/forum.ssjs', {
        call: 'post-reply',
        sub,
        body,
        pid: id
    });
    if (data.success) {
        var quoteBtn = document.getElementById('quote-' + id);
        if (quoteBtn) quoteBtn.disabled = false;
        var replyBox = document.getElementById('replybox-' + id);
        if (replyBox) replyBox.remove();
        var notice = document.createElement('div');
        notice.id = 'noticebox';
        notice.className = 'alert alert-success';
        notice.textContent = 'Your reply has been posted.';
        var container = document.getElementById('forum-list-container');
        if (container) container.parentNode.insertBefore(notice, container);
        setTimeout(function () {
            notice.style.transition = 'opacity 1s';
            notice.style.opacity = '0';
            setTimeout(function () { notice.remove(); }, 1000);
        }, 3000);
    } else {
        btn.disabled = false;
    }
}

// (Try to) delete a message via the web API
async function deleteMessage(sub, id) {
    const res = await v4_post('./api/forum.ssjs', { call: 'delete-message', sub: sub, number: id });
    if (res.success) {
        var el = document.getElementById('li-' + id);
        if (el) el.remove();
    }
}

// Add a new message input form to the element with id 'forum-list-container' for sub 'sub'
function addNew(sub) {
    if (document.getElementById('newmessage')) return;
    document.getElementById('forum-list-container').insertAdjacentHTML('beforeend',
        '<li id="newmessage" class="list-group-item">' +
        '<input id="newmessage-to" class="form-control" type="text" placeholder="To"><br>' +
        '<input id="newmessage-subject" class="form-control" type="text" placeholder="Subject"><br>' +
        '<textarea id="newmessage-body" class="form-control" rows="8"></textarea><br>' +
        '<input id="newmessage-button" class="btn btn-primary" type="submit" value="Submit" onclick="postNew(\'' + sub + '\')">' +
        '</li>'
    );
    v4_get('./api/forum.ssjs?call=get-signature').then(function (data) {
        var bodyEl = document.getElementById('newmessage-body');
        bodyEl.value = bodyEl.value + '\r\n' + data.signature;
        bodyEl.setSelectionRange(0, 0);
    });
    document.getElementById('newmessage').scrollIntoView({ behavior: 'smooth', block: 'end' });
    document.getElementById('newmessage-body').addEventListener('keydown', function (evt) {
        evt.stopImmediatePropagation();
    });
    if (typeof renderAllBinIcons === 'function') renderAllBinIcons(document.getElementById('newmessage'));
}

async function submitPoll(sub) {

    var submitBtn = document.getElementById('newpoll-submit');
    submitBtn.disabled = true;

    if (document.querySelectorAll('input[name="newpoll-answers"]:checked').length !== 1) return;

    var subject = document.getElementById('newpoll-subject').value;
    if (subject.length < 1) return;

    var answerCount = document.querySelector('input[name="newpoll-answers"]:checked').value;
    if (answerCount == 2) answerCount = document.querySelector('input[name="newpoll-answer-count"]').value;
    if (answerCount < 0 || answerCount > 15) return;

    var results = parseInt(document.querySelector('input[name="newpoll-results"]:checked').value);
    if (results < 0 || results > 3) return;

    var answers = [];
    document.querySelectorAll('input[name="newpoll-answer-input"]').forEach(function (el) {
        var val = el.value;
        if (val !== '') answers.push(val);
    });
    if (answers.length < 1) return;

    var comments = [];
    document.querySelectorAll('input[name="newpoll-comment-input"]').forEach(function (el) {
        var val = el.value;
        if (val !== '') comments.push(val);
    });

    const post_data = {
        sub,
        subject,
        votes: answerCount,
        results,
        answer: answers
    };
    if (comments.length) post_data.comment = comments;
    const res = await v4_post('./api/forum.ssjs?call=submit-poll', post_data);
    submitBtn.disabled = false;
    if (res.success) {
        var el = document.getElementById('newpoll');
        if (el) el.remove();
        var notice = document.createElement('div');
        notice.id = 'noticebox';
        notice.className = 'alert alert-success';
        notice.textContent = 'Your poll has been posted.';
        var container = document.getElementById('forum-list-container');
        if (container) container.parentNode.insertBefore(notice, container);
        setTimeout(function () {
            notice.style.transition = 'opacity 1s';
            notice.style.opacity = '0';
            setTimeout(function () { notice.remove(); }, 1000);
        }, 3000);
    }

}

function addPollField(type, elem) {

    var prefix = 'newpoll-' + type;

    var count = document.querySelectorAll('div[name="' + prefix + '"]').length;
    if (type === 'answer' && count > 15) return;
    var number = count + 1;

    document.querySelector(elem).insertAdjacentHTML('beforeend',
        '<div id="' + prefix + '-container-' + number + '" name="' + prefix + '" class="form-group">' +
            '<label for="' + prefix + '-' + number + '" class="col-sm-2 control-label">' +
                (type === 'answer' ? 'Answer' : 'Comment') +
            '</label>' +
            '<div class="col-sm-9">' +
                '<input id="' + prefix + '-' + number + '" class="form-control" name="' + prefix + '-input" type="text" maxlength="70"> ' +
            '</div>' +
            '<div class="col-sm-1">' +
                '<button type="button" class="btn btn-danger" onclick="document.getElementById(\'' + prefix + '-container-' + number + '\').remove()">' +
                    '<span class="bin-icon" data-icon="trash"></span>' +
                '</button> ' +
            '</div>' +
        '</div>'
    );

    document.getElementById(prefix + '-' + number).addEventListener('keydown', function (evt) {
        evt.stopImmediatePropagation();
    });

}

function addPoll(sub) {
    if (document.getElementById('newpoll')) return;
    document.getElementById('forum-list-container').insertAdjacentHTML('beforeend',
        '<li id="newpoll" class="list-group-item">' +
            '<strong>Add a new poll</strong>' +
            '<form id="newpoll-form" class="form-horizontal">' +
                '<div class="form-group">' +
                    '<label for="newpoll-subject" class="col-sm-2 control-label">Question</label>' +
                    '<div class="col-sm-10">' +
                        '<input id="newpoll-subject" class="form-control" type="text" placeholder="Required" maxlength="70">' +
                    '</div>' +
                '</div>' +
                '<div id="newpoll-comment-group"></div>' +
                '<div class="form-group">' +
                    '<label for="newpoll-answers" class="col-sm-2 control-label">Selection</label>' +
                    '<div class="col-sm-10">' +
                        '<label class="radio-inline">' +
                            '<input type="radio" name="newpoll-answers" value="1" checked> Single' +
                        '</label>' +
                        '<label class="radio-inline">' +
                            '<input type="radio" name="newpoll-answers" value="2"> Multiple ' +
                            '<input type="number" name="newpoll-answer-count" min="1" max="15" value="1">' +
                        '</label>' +
                    '</div>' +
                '</div>' +
                '<div class="form-group">' +
                    '<label for="newpoll-results" class="col-sm-2 control-label">Show results</label>' +
                    '<div class="col-sm-10">' +
                        '<label class="radio-inline">' +
                            '<input type="radio" name="newpoll-results" value="0" checked> Voters' +
                        '</label>' +
                        '<label class="radio-inline">' +
                            '<input type="radio" name="newpoll-results" value="1">  Everyone' +
                        '</label>' +
                        '<label class="radio-inline">' +
                            '<input type="radio" name="newpoll-results" value="2"> Me Only (Until closed) ' +
                        '</label>' +
                        '<label class="radio-inline">' +
                            '<input type="radio" name="newpoll-results" value="3"> Me Only ' +
                        '</label>' +
                    '</div>' +
                '</div>' +
                '<div id="newpoll-answer-group"></div>' +
                '<div id="newpoll-button" class="form-group">' +
                    '<div class="col-sm-offset-2 col-sm-10">' +
                        '<button id="newpoll-submit" type="button" class="btn btn-primary" onclick="submitPoll(\'' + sub + '\')">' +
                            'Submit' +
                        '</button>' +
                        '<div class="pull-right">' +
                            '<button type="button" title="Add another comment" class="btn btn-success" onclick="addPollField(\'comment\', \'#newpoll-comment-group\')">' +
                                '<span class="bin-icon" data-icon="pencil"></span>' +
                            '</button> ' +
                            '<button type="button" title="Add another answer" class="btn btn-success" onclick="addPollField(\'answer\', \'#newpoll-answer-group\')">' +
                                '<span class="bin-icon" data-icon="checkmark"></span>' +
                            '</button> ' +
                        '</div>' +
                    '</div>' +
                '</div>' +
            '</form>' +
        '</li>'
    );
    addPollField('comment', '#newpoll-comment-group');
    addPollField('answer', '#newpoll-answer-group');
    addPollField('answer', '#newpoll-answer-group');
    document.getElementById('newpoll').scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// Add a reply input form to the page for message with number 'id' in sub 'sub'
function addReply(sub, id) {
    if (document.getElementById('replybox-' + id)) return;
    document.getElementById('li-' + id).insertAdjacentHTML('beforeend',
        '<div class="reply" id="replybox-' + id + '">' +
        '<strong>Reply</strong>' +
        '<textarea rows="8" class="form-control reply" id="replytext-' + id + '""></textarea>' +
        '<button id="quote-' + id + '" class="btn" onclick="quotify(' + id + ')">Quote</button> ' +
        '<input id="reply-button-' + id + '" class="btn btn-primary" type="submit" value="Submit" onclick="postReply(\'' + sub + '\', ' + id + ')">' +
        '</div>'
    );
    v4_get('./api/forum.ssjs?call=get-signature').then(function (data) {
        var replyEl = document.getElementById('replytext-' + id);
        replyEl.value = replyEl.value + '\r\n' + data.signature;
        replyEl.setSelectionRange(0, 0);
    });
    document.getElementById('replytext-' + id).addEventListener('keydown', function (evt) {
        evt.stopImmediatePropagation();
    });
    if (typeof renderAllBinIcons === 'function') renderAllBinIcons(document.getElementById('replybox-' + id));
}

function onSubUnreadCount(data) {
    for (var sub in data) {
        var badge = document.getElementById('badge-' + sub);
        if (!badge) continue;
        if (data[sub].scanned > 0) {
            badge.textContent = data[sub].total;
        } else if (data[sub].total > 0) {
            badge.textContent = data[sub].total;
        } else {
            badge.textContent = '';
        }
    }
}

async function getSubUnreadCounts(grp) {
    const res = await v4_get('./api/forum.ssjs?call=get-sub-unread-counts&group=' + grp);
    onSubUnreadCount(res);
}

function onGroupUnreadCount(data) {
    for (var group in data) {
        var scannedEl = document.getElementById('badge-scanned-' + group);
        if (scannedEl) {
            scannedEl.textContent = (data[group].scanned == 0 ? "" : data[group].scanned);
        }
        var ignoredEl = document.getElementById('badge-ignored-' + group);
        if (ignoredEl) {
            ignoredEl.textContent =
                data[group].total == 0 || data[group].total == data[group].scanned
                ? ''
                : (data[group].total - data[group].scanned);
        }
    }
}

async function getGroupUnreadCounts() {
    const res = await v4_get('./api/forum.ssjs?call=get-group-unread-counts');
    onGroupUnreadCount(res);
}

function onThreadStats(data) {
    Object.keys(data).forEach(function (e) {

        var div1 = document.getElementById('replies-' + e);
        if (!div1) {
            var template = document.getElementById('forum-thread-replies-template');
            div1 = template.cloneNode(true);
            div1.id = 'replies-' + e;
            document.getElementById('left-' + e).appendChild(div1);
        }
        if (data[e].total > 1) {
            var mcEl = div1.querySelector('strong[data-message-count]');
            if (mcEl) mcEl.innerHTML = data[e].total - 1;
            if (data[e].total == 2) {
                var srEl = div1.querySelector('span[data-suffix-reply]');
                if (srEl) srEl.hidden = false;
            } else {
                var srsEl = div1.querySelector('span[data-suffix-replies]');
                if (srsEl) srsEl.hidden = false;
            }
            var lfEl = div1.querySelector('strong[data-last-from]');
            if (lfEl) lfEl.innerHTML = data[e].newest.from;
            var ltEl = div1.querySelector('span[data-last-time]');
            if (ltEl) ltEl.innerHTML = data[e].newest.date;
            div1.hidden = false;
        }

        var div2 = document.getElementById('stats-' + e);
        if (!div2) {
            var template2 = document.getElementById('forum-thread-stats-template');
            div2 = template2.cloneNode(true);
            div2.id = 'stats-' + e;
            document.getElementById('right-' + e).appendChild(div2);
        }
        if (data[e].unread) {
            var urm = div2.querySelector('span[data-unread-messages]');
            if (urm) {
                urm.innerHTML = data[e].unread;
                urm.hidden = false;
                div2.hidden = false;
            }
        }

        if (data[e].votes.total) {
            if (data[e].votes.up.t) {
                var uvEl = div2.querySelector('span[data-upvotes]');
                if (uvEl) uvEl.innerHTML = data[e].votes.up.p + '/' + data[e].votes.up.t;
                var uvbEl = div2.querySelector('span[data-upvotes-badge]');
                if (uvbEl) uvbEl.style.display = '';
            }
            if (data[e].votes.down.t) {
                var dvEl = div2.querySelector('span[data-downvotes]');
                if (dvEl) dvEl.innerHTML = data[e].votes.down.p + '/' + data[e].votes.down.t;
                var dvbEl = div2.querySelector('span[data-downvotes-badge]');
                if (dvbEl) dvbEl.style.display = '';
            }
            div2.hidden = false;
        }

    });
}

/*  Fetch a private mail message's body (with links to attachments) where 'id'
    is the message number.  Output it to an element with id 'message-<id>'. */
async function getMailBody(id) {
    var tgt = document.getElementById('message-' + id);
    if (!tgt) return;
    if (!tgt.hidden) {
        tgt.hidden = true;
    } else if (tgt.innerHTML !== '') {
        tgt.hidden = false;
    } else {
        const data = await v4_get('./api/forum.ssjs?call=get-mail-body&number=' + id);
        var str = data.body;
        if (data.inlines && data.inlines.length > 0) {
            str += '<br>Inline attachments: ' + data.inlines.join('<br>') + '<br>';
        }
        if (data.attachments && data.attachments.length > 0) {
            str += '<br>Attachments: ' + data.attachments.join('<br>') + '<br>';
        }
        str +=
            '<button class="btn btn-default icon" ' +
            'aria-label="Reply to this message" ' +
            'title="Reply to this message" ' +
            'name="reply-' + id + '" ' +
            'onclick="addReply(\'mail\',' + id + ')">' +
            '<span class="bin-icon" data-icon="irc"></span>' +
            '</button>' +
            '<button class="btn btn-default icon" aria-label="Delete this message" ' +
            'title="Delete this message" onclick="deleteMessage(\'mail\',' + id + ')">' +
            '<span class="bin-icon" data-icon="trash"></span>' +
            '</button>';
        if (data.buttons) str += data.buttons.join('');
        tgt.innerHTML = str;
        tgt.hidden = false;
        if (typeof renderAllBinIcons === 'function') renderAllBinIcons(tgt);
        if (typeof renderAnsiCanvases === 'function') renderAnsiCanvases(tgt);
    }
}

async function blockSender(id, from, from_net) {
    const data = await v4_get('./api/forum.ssjs?call=block-sender&from=' + from + '&from_net=' + from_net);
    if (!data.err) {
        var el = document.getElementById('bsb-' + id);
        if (el) el.disabled = true;
    }
}

async function setScanCfg(sub, cfg) {
    var opts = [ 'scan-cfg-off', 'scan-cfg-new', 'scan-cfg-youonly' ];
    const data = await v4_get('./api/forum.ssjs?call=set-scan-cfg&sub=' + sub + '&cfg=' + cfg);
    if (!data.success) return;
    opts.forEach(function (e, i) {
        var el = document.getElementById(e);
        if (!el) return;
        el.classList.toggle('btn-primary', (cfg == i));
        el.classList.toggle('btn-default', (cfg != i));
    });
}

function threadNav() {

    var container = document.getElementById('forum-list-container');
    if (!container) return;
    var items = container.querySelectorAll(':scope > .list-group-item');

    if (window.location.hash === '') {
        if (items.length) items[0].classList.add('current');
    } else {
        var hashEl = document.getElementById('li-' + window.location.hash.substr(1));
        if (hashEl) hashEl.classList.add('current');
    }

    window.addEventListener('keydown', function (evt) {
        var currentEl = container.querySelector(':scope > .current');
        if (!currentEl) return;
        var cid = currentEl.id.substr(3);
        switch (evt.keyCode) {
            case 37:
                // Left
                var pm = document.getElementById('pm-' + cid);
                if (pm) window.location.hash = pm.getAttribute('href');
                break;
            case 39:
                // Right
                var nm = document.getElementById('nm-' + cid);
                if (nm) window.location.hash = nm.getAttribute('href');
                break;
            default:
                break;
        }
    });

    window.addEventListener('hashchange', function () {
        container.querySelectorAll(':scope > .current').forEach(function (el) {
            el.classList.remove('current');
        });
        var id = window.location.hash.substr(1);
        var li = document.getElementById('li-' + id);
        if (!li) return;
        li.classList.add('current');
    });

}

async function vote(sub, id) {
    id = id.split('-');
    if (id.length != 2 || (id[0] != 'uv' && id[0] != 'dv') || isNaN(parseInt(id[1]))) {
        return;
    }
    const data = await v4_get('./api/forum.ssjs?call=vote&sub=' + sub + '&id=' + id[1] + '&up=' + (id[0] === 'uv' ? 1 : 0));
    if (!data.success) return;
    var btnEl = document.getElementById(id[0] + '-' + id[1]);
    if (btnEl) {
        btnEl.classList.add(id[0] === 'uv' ? 'upvote-fg' : 'downvote-fg');
        btnEl.disabled = true;
        btnEl.blur();
    }
    var countEl = document.getElementById(id[0] + '-count-' + id[1]);
    if (countEl) countEl.textContent = parseInt(countEl.textContent) + 1;
}

function enableVoteButtonHandlers(sub) {
    document.querySelectorAll('.btn-uv').forEach(function (el) {
        el.addEventListener('click', function () { vote(sub, this.id); });
    });
    document.querySelectorAll('.btn-dv').forEach(function (el) {
        el.addEventListener('click', function () { vote(sub, this.id); });
    });
}

async function getVotesInThread(sub, id) {
    const data = await v4_get('./api/forum.ssjs?call=get-thread-votes&sub=' + sub + '&id=' + id);
    Object.keys(data.m).forEach(function (m) {
        var uvCountEl = document.getElementById('uv-count-' + m);
        var dvCountEl = document.getElementById('dv-count-' + m);
        var uv = uvCountEl ? parseInt(uvCountEl.textContent) : 0;
        var dv = dvCountEl ? parseInt(dvCountEl.textContent) : 0;
        if (uv !== data.m[m].u && uvCountEl) {
            uvCountEl.textContent = data.m[m].u;
            var uvBtn = document.getElementById('uv-' + m);
            if (uvBtn) uvBtn.classList.add('indicator');
        }
        if (dv !== data.m[m].d && dvCountEl) {
            dvCountEl.textContent = data.m[m].d;
            var dvBtn = document.getElementById('dv-' + m);
            if (dvBtn) dvBtn.classList.add('indicator');
        }
        switch (data.m[m].v) {
            case 1:
                var uvBtn2 = document.getElementById('uv-' + m);
                if (uvBtn2) { uvBtn2.classList.add('upvote-fg'); uvBtn2.disabled = true; }
                var dvBtn2 = document.getElementById('dv-' + m);
                if (dvBtn2) dvBtn2.disabled = true;
                break;
            case 2:
                var dvBtn3 = document.getElementById('dv-' + m);
                if (dvBtn3) { dvBtn3.classList.add('downvote-fg'); dvBtn3.disabled = true; }
                var uvBtn3 = document.getElementById('uv-' + m);
                if (uvBtn3) uvBtn3.disabled = true;
                break;
            default:
                break;
        }
    });
}

async function getVotesInThreads(sub) {
    const data = await v4_get('./api/forum.ssjs?call=get-sub-votes&sub=' + sub);
    Object.keys(data).forEach(function (t) {
        var uv = data[t].p.u + ' / ' + data[t].t.u;
        var dv = data[t].p.d + ' / ' + data[t].t.d;
        var uvEl = document.getElementById('uv-count-' + t);
        if (uvEl && uv !== uvEl.textContent) uvEl.textContent = uv;
        var dvEl = document.getElementById('dv-count-' + t);
        if (dvEl && dv !== dvEl.textContent) dvEl.textContent = dv;
    });
}

async function submitPollAnswers(sub, id) {
    if (document.querySelectorAll('input[name="poll-' + id + '"]:checked').length < 1) return;
    var answers = [];
    document.querySelectorAll('input[name="poll-' + id + '"]:checked').forEach(function (el) {
        answers.push(el.value);
    });
    answers = answers.join('&answer=');

    const post_data = {
        call: 'submit-poll-answers',
        sub,
        id,
        answer: answers
    };
    const data = await v4_post('./api/forum.ssjs', post_data);
    document.querySelectorAll('input[name="poll-' + id + '"]').forEach(function (el) {
        el.disabled = true;
        if (el.checked) {
            el.parentElement.parentElement.classList.add('upvote-bg');
        }
    });
    var submitEl = document.getElementById('submit-poll-' + id);
    if (submitEl) submitEl.disabled = true;
}
