require('sbbsdefs.js', 'MSG_DELETE');
require('xjs.js', 'xjs_compile');
require('funclib.js', 'pipeToCtrlA');
load(settings.web_lib + 'mime-decode.js');
load(settings.web_lib + 'avatars.js');

var avatars = new Avatars();

/* ---- Forum icon resolution (mirrors shell _mbFindIconBase logic) ---- */
var _forumIconDir = system.text_dir + 'icons/';

function _forumBuildVariants(name) {
    var out = [];
    if (!name) return out;
    var base = ('' + name).trim();
    if (!base.length) return out;
    out.push(base);
    var lower = base.toLowerCase();
    if (out.indexOf(lower) === -1) out.push(lower);
    var sh = lower.replace(/\s+/g, '-');
    if (sh.length && out.indexOf(sh) === -1) out.push(sh);
    var su = lower.replace(/\s+/g, '_');
    if (su.length && out.indexOf(su) === -1) out.push(su);
    var ah = lower.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (ah.length && out.indexOf(ah) === -1) out.push(ah);
    var au = lower.replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    if (au.length && out.indexOf(au) === -1) out.push(au);
    var an = lower.replace(/[^a-z0-9]+/g, '');
    if (an.length && out.indexOf(an) === -1) out.push(an);
    return out;
}

var _forumIconCache = {};
function _forumFindIcon(name) {
    if (!name) return null;
    var key = ('' + name).toLowerCase();
    if (_forumIconCache.hasOwnProperty(key)) return _forumIconCache[key];
    var variants = _forumBuildVariants(name);
    var exts = ['.bin'];
    for (var v = 0; v < variants.length; v++) {
        for (var e = 0; e < exts.length; e++) {
            var path = _forumIconDir + variants[v] + exts[e];
            try {
                if (file_exists(path)) {
                    var f = new File(path);
                    if (f.open('rb')) {
                        var b64 = base64_encode(f.read());
                        f.close();
                        _forumIconCache[key] = b64;
                        return b64;
                    }
                }
            } catch (_e) {}
        }
    }
    _forumIconCache[key] = null;
    return null;
}

function _forumResolveIcon(name, fallback) {
    var icon = _forumFindIcon(name);
    if (!icon && fallback) icon = _forumFindIcon(fallback);
    return icon;
}

function listGroups() {
    const response = [];
    msg_area.grp_list.forEach(function (grp) {
        if (grp.sub_list.length < 1) return;
        var icon = _forumResolveIcon(grp.name, 'group');
        response.push({
            index: grp.index,
            name: grp.name,
            description: grp.description,
            sub_count: grp.sub_list.length,
            icon: icon || null,
            // unread: is_user() ? getGroupUnreadCount(grp.index) : null,
        });
    });
    return response;
}

// Returns an array of objects of "useful" information about subs
function listSubs(group) {
    return msg_area.grp_list[group].sub_list.map(function (e) {
        const mb = new MsgBase(e.code);
        if (!mb.open()) throw new Error(mb.error);
        var icon = _forumResolveIcon(e.code, 'boards');
        const ret = {
            index: e.index,
            code: e.code,
            grp_index: e.grp_index,
            grp_name: e.grp_name,
            name: e.name,
            description: e.description,
            can_post: e.can_post,
            is_operator: e.is_operator,
            is_moderated: e.is_moderated,
            scan_ptr: e.scan_ptr,
            scan_cfg: e.scan_cfg,
            icon: icon || null,
            total_msgs: mb.total_msgs,
            unread: is_user() ? getSubUnreadCount(mb) : null,
            newest: getNewestMessageInSub(mb),
        };
        mb.close();
        return ret;
    });
}

function getNewestMessageInSub(sub) {

    var mb;
    if (sub instanceof MsgBase) {
        mb = sub;
    } else {
        mb = new MsgBase(sub.code);
        if (!mb.open()) throw new Error(mb.error);
    }
    
    var h;
    var ret;
    for (var m = mb.last_msg; m >= mb.first_msg; m--) {
        h = mb.get_msg_header(m);
        if (h === null) continue;
        ret = {
            from: h.from,
            subject: h.subject,
            date: h.when_written_time,
        };
        break;
    }
    
    if (!(sub instanceof MsgBase)) mb.close();
    
    return ret;

}

function getNewestMessagePerSub(grp) {
    grp = parseInt(grp, 10);
    if (isNaN(grp) || grp < 0 || !msg_area.grp_list[grp]) return [];
    return msg_area.grp_list[grp].sub_list.reduce(function (a, c) {
        const s = getNewestMessageInSub(c);
        if (s !== undefined) a[c.code] = s;
        return a;
    }, {});
}

function getSubUnreadCount(sub) {

    var ret = {
        scanned: 0,
        total: 0,
    };

    var mb;
    if (sub instanceof MsgBase) {
        mb = sub;
    } else {
        if (msg_area.sub[sub] === undefined) return ret;
        mb = new MsgBase(sub);
        if (!mb.open()) throw new Error(mb.error);
    }

    var sy = msg_area.sub[mb.cfg.code].scan_cfg&SCAN_CFG_YONLY;
    var sn = msg_area.sub[mb.cfg.code].scan_cfg&SCAN_CFG_NEW;
    for (var m = msg_area.sub[mb.cfg.code].scan_ptr + 1; m <= mb.last_msg; m++) {
        var h = mb.get_msg_header(m);
        if (h === null || h.attr&MSG_DELETE || h.attr&MSG_NODISP) continue;
        if ((sy && (h.to_ext === user.number || h.to === user.alias || h.to === user.name)) || sn) ret.scanned++;
        ret.total++;
    }

    if (!(sub instanceof MsgBase)) mb.close();
    
    return ret;

}

function getSubUnreadCounts(group) {
    return msg_area.grp_list[group].sub_list.reduce(function (a, c) {
        a[c.code] = getSubUnreadCount(c.code);
        return a;
    }, {});
}

function getGroupUnreadCount(group) {
    var ret = {
        scanned : 0,
        total : 0
    };
    if (msg_area.grp_list[group] === undefined) return ret;
    msg_area.grp_list[group].sub_list.forEach(function (sub) {
        var count = getSubUnreadCount(sub.code);
        ret.scanned += count.scanned;
        ret.total += count.total;
    });
    return ret;
}

function getGroupUnreadCounts() {
    return msg_area.grp_list.reduce(function (a, c) {
        a[c.index] = getGroupUnreadCount(c.index);
        return a;
    }, {});
}

function getUnreadInThread(sub, thread, mkeys) {
    if (typeof thread == 'number') {
        var threads = getMessageThreads(sub, settings.max_messages);
        if (threads.thread[thread] === undefined) return 0;
        thread = threads.thread[thread];
    }
    var count = 0;
    if (!mkeys) mkeys = Object.keys(thread.messages);
    mkeys.forEach(function (m) {
        if (thread.messages[m].number > msg_area.sub[sub].scan_ptr) count++;
    });
    return count;
}

function getThreadVoteTotals(thread, mkeys) {
    if (!mkeys) mkeys = Object.keys(thread.messages); // Not sure why it doesn't just do this already - does anything else call getThreadVoteTotals?
    return mkeys.reduce(function (a, c, i) {
        if (thread.messages[c].upvotes > 0) {
            if (i == 0) a.up.p++;
            a.up.t++;
        }
        if (thread.messages[c].downvotes > 0) {
            if (i == 0) a.down.p++;
            a.down.t++;
        }
        a.total = a.up.t + a.down.t;
        return a;
    }, { up: { p: 0, t: 0 }, down: { p: 0, t: 0 }, total: 0 });
}

// Called from lib/events/forum.js to scan a sub for updates
// Very similar to listThreads, but the reply is smaller and there is no paging/offset
function getThreadStats(sub, guest) {
    const threads = getMessageThreads(sub, settings.max_messages);
    const ret = {
        sub: sub.code,
        scan_cfg: sub.scan_cfg,
    };
    threads.order.forEach(function (e) {
        const thread = threads.thread[e];
        const mkeys = Object.keys(thread.messages);
        ret[e] = {
            id: e,
            last: {
                from: thread.messages[mkeys[mkeys.length - 1]].from,
                when_written_time: thread.messages[mkeys[mkeys.length - 1]].when_written_time,
            },
            messages: mkeys.length,
            unread: guest ? 0 : getUnreadInThread(sub, thread, mkeys),
            votes: getThreadVoteTotals(thread, mkeys),
        };
    });
    return ret;
}

function sortThreadOrder(threadMap, sort, dir) {
    var defaultDir = (sort === 'subject' || sort === 'sender') ? 'asc' : 'desc';
    var flip = (dir && dir !== defaultDir) ? -1 : 1;
    var keys = Object.keys(threadMap);
    return keys.sort(function (a, b) {
        var ta = threadMap[a];
        var tb = threadMap[b];
        var keysA, keysB, sa, sb, fa, fb;
        var result;
        switch (sort) {
            case 'started':
                keysA = Object.keys(ta.messages).sort(function(x,y){return x-y;});
                keysB = Object.keys(tb.messages).sort(function(x,y){return x-y;});
                result = tb.messages[keysB[0]].when_written_time - ta.messages[keysA[0]].when_written_time; break;
            case 'subject':
                sa = (ta.subject || '').replace(/^(re:\s*)*/ig, '').toLowerCase();
                sb = (tb.subject || '').replace(/^(re:\s*)*/ig, '').toLowerCase();
                result = sa < sb ? -1 : sa > sb ? 1 : 0; break;
            case 'replies':
                result = Object.keys(tb.messages).length - Object.keys(ta.messages).length; break;
            case 'sender':
                keysA = Object.keys(ta.messages).sort(function(x,y){return x-y;});
                keysB = Object.keys(tb.messages).sort(function(x,y){return x-y;});
                fa = (ta.messages[keysA[0]].from || '').toLowerCase();
                fb = (tb.messages[keysB[0]].from || '').toLowerCase();
                result = fa < fb ? -1 : fa > fb ? 1 : 0; break;
            default:
                result = tb.newest - ta.newest; break;
        }
        return result * flip;
    });
}

/* Extract base64 avatar data from an AI definition message body.
   Returns the base64 string or null if not found. */
function extractAiDefAvatar(msgBase, msgNumber) {
    try {
        var header = msgBase.get_msg_header(false, msgNumber, false);
        if (!header) return null;
        var body = msgBase.get_msg_body(false, header, false, false, true);
        if (!body) return null;
        var start = body.indexOf('avatar_data_begin');
        var end = body.indexOf('avatar_data_end');
        if (start < 0 || end < 0 || end <= start) return null;
        var block = body.substring(start + 'avatar_data_begin'.length, end);
        return block.replace(/[\r\n\s]+/g, '').replace(/^\s+|\s+$/g, '');
    } catch (_e) {
        return null;
    }
}

function listThreads(sub, count, after, sort, dir) {

    count = parseInt(count, 10);
    if (isNaN(count) || count < 1) return false;

    var threads = getMessageThreads(sub, settings.max_messages);
    if ((sort && sort !== 'activity') || dir) {
        threads.order = sortThreadOrder(threads.thread, sort || 'activity', dir);
    }
    var offset = 0;
    if (after) offset = threads.order.indexOf(after) + 1;

    var msgs;
    var thread;
    var stop = Math.min(threads.order.length, offset + count);
    var ret = { total: threads.order.length, threads : [] };
    for (var n = offset; n < stop; n++) {
        thread = threads.thread[threads.order[n]];
        msgs = Object.keys(thread.messages);
        ret.threads.push({
            id: thread.id,
            subject: thread.subject,
            first: thread.messages[msgs[0]],
            last: thread.messages[msgs[msgs.length - 1]],
            messages: msgs.length,
            sub: sub,
            unread: is_user() ? getUnreadInThread(sub, thread) : 0,
            votes: getThreadVoteTotals(thread),
        });
    }

    /* For AI Definitions sub, extract the AI avatar from the most recent
       message body in each thread (walking backwards to find the latest). */
    if (sub === 'local-aidefinitions' && ret.threads.length > 0) {
        var aiMb = new MsgBase(sub);
        if (aiMb.open()) {
            ret.threads.forEach(function (t) {
                /* Walk the thread messages newest-first to find the latest avatar */
                var lastMsg = t.last;
                if (lastMsg && lastMsg.number) {
                    var av = extractAiDefAvatar(aiMb, lastMsg.number);
                    if (av) { t.aiAvatar = av; return; }
                }
                /* Fallback: try the first message */
                var firstMsg = t.first;
                if (firstMsg && firstMsg.number) {
                    var av = extractAiDefAvatar(aiMb, firstMsg.number);
                    if (av) t.aiAvatar = av;
                }
            });
            aiMb.close();
        }
    }

    return ret;

}

/*  Return the immediate neighbors (prev/next thread) of `thread` within `sub`,
    in the same order listThreads() would produce for the given sort. Used by
    the forum thread-read view to power keyboard (Shift+Left/Right) and button
    navigation between adjacent threads without making the client fetch the
    entire thread list. */
function getThreadNeighbors(sub, thread, sort, dir) {
    var threadId = parseInt(thread, 10);
    if (isNaN(threadId)) return false;
    var threads = getMessageThreads(sub, settings.max_messages);
    if ((sort && sort !== 'activity') || dir) {
        threads.order = sortThreadOrder(threads.thread, sort || 'activity', dir);
    }
    // threads.order is populated by getMessageThreads as Object.keys(...)
    // -- string keys, not numbers. indexOf uses strict equality, so we
    // have to compare like-to-like or every lookup returns -1.
    var pos = threads.order.indexOf(String(threadId));
    var ret = {
        position: pos,
        total: threads.order.length,
        prev: null,
        next: null,
    };
    if (pos < 0) return ret;
    if (pos > 0) {
        var prevT = threads.thread[threads.order[pos - 1]];
        ret.prev = { id: prevT.id, subject: prevT.subject };
    }
    if (pos < threads.order.length - 1) {
        var nextT = threads.thread[threads.order[pos + 1]];
        ret.next = { id: nextT.id, subject: nextT.subject };
    }
    return ret;
}

function searchThreads(query, scope, group, sub, sort, count, offset, dir) {
    count = parseInt(count, 10);
    if (isNaN(count) || count < 1) count = parseInt(settings.page_size, 10) || 20;
    offset = parseInt(offset, 10);
    if (isNaN(offset) || offset < 0) offset = 0;

    query = (query || '').toLowerCase().replace(/^\s+|\s+$/g, '');
    if (!query) return { total: 0, threads: [] };

    var subs = [];
    if (scope === 'sub' && sub && msg_area.sub[sub]) {
        subs.push(sub);
    } else if (scope === 'group' && group !== undefined && msg_area.grp_list[group]) {
        for (var s = 0; s < msg_area.grp_list[group].sub_list.length; s++) {
            subs.push(msg_area.grp_list[group].sub_list[s].code);
        }
    } else {
        for (var g = 0; g < msg_area.grp_list.length; g++) {
            for (var s = 0; s < msg_area.grp_list[g].sub_list.length; s++) {
                subs.push(msg_area.grp_list[g].sub_list[s].code);
            }
        }
    }

    var allMatches = [];
    for (var i = 0; i < subs.length; i++) {
        var threads = getMessageThreads(subs[i], settings.max_messages);
        for (var t in threads.thread) {
            var thread = threads.thread[t];
            var msgs = Object.keys(thread.messages).sort(function(a,b){return a-b;});
            if (!msgs.length) continue;
            var firstMsg = thread.messages[msgs[0]];
            var lastMsg = thread.messages[msgs[msgs.length - 1]];
            var subjectLower = (thread.subject || '').toLowerCase();
            var senderLower = (firstMsg.from || '').toLowerCase();
            if (subjectLower.indexOf(query) < 0 && senderLower.indexOf(query) < 0) continue;
            allMatches.push({
                id: thread.id,
                subject: thread.subject,
                first: firstMsg,
                last: lastMsg,
                messages: msgs.length,
                sub: subs[i],
                sub_name: msg_area.sub[subs[i]].name,
                unread: is_user() ? getUnreadInThread(subs[i], thread) : 0,
                votes: getThreadVoteTotals(thread),
                _newest: thread.newest
            });
        }
    }

    var _sDefaultDir = (sort === 'subject' || sort === 'sender') ? 'asc' : 'desc';
    var _sFlip = (dir && dir !== _sDefaultDir) ? -1 : 1;
    allMatches.sort(function(a, b) {
        var sa, sb, fa, fb, result;
        switch (sort) {
            case 'started':
                result = b.first.when_written_time - a.first.when_written_time; break;
            case 'subject':
                sa = (a.subject || '').replace(/^(re:\s*)*/ig, '').toLowerCase();
                sb = (b.subject || '').replace(/^(re:\s*)*/ig, '').toLowerCase();
                result = sa < sb ? -1 : sa > sb ? 1 : 0; break;
            case 'replies':
                result = b.messages - a.messages; break;
            case 'sender':
                fa = (a.first.from || '').toLowerCase();
                fb = (b.first.from || '').toLowerCase();
                result = fa < fb ? -1 : fa > fb ? 1 : 0; break;
            default:
                result = b._newest - a._newest; break;
        }
        return result * _sFlip;
    });

    var total = allMatches.length;
    var result = allMatches.slice(offset, offset + count);
    result.forEach(function(m) { delete m._newest; });
    return { total: total, threads: result };
}

function getVotesInThread(sub, thread) {
    var ret = { t : { u : 0, d : 0 }, m : {} };
    if (msg_area.sub[sub] === undefined) return ret;
    if (typeof thread === 'number') {
        var threads = getMessageThreads(sub, settings.max_messages);
        if (threads.thread[thread] === undefined) return ret;
        thread = threads.thread[thread];
    }
    var msgBase = new MsgBase(sub);
    if (!msgBase.open()) return ret;
    Object.keys(thread.messages).forEach(function (m) {
        if (thread.messages[m].upvotes > 0 || thread.messages[m].downvotes > 0) {
            ret.t.up += thread.messages[m].upvotes;
            ret.t.down += thread.messages[m].downvotes;
            ret.m[thread.messages[m].number] = {
                u: thread.messages[m].upvotes,
                d: thread.messages[m].downvotes,
                v: msgBase.how_user_voted(thread.messages[m].number, msgBase.cfg.settings&SUB_NAME ? user.name : user.alias),
            };
        }
    });
    msgBase.close();
    return ret;
}

function getVotesInThreads(sub) {
    var threads = getMessageThreads(sub, settings.max_messages);
    var ret = {};
    Object.keys(threads.thread).forEach(function (t) {
        Object.keys(threads.thread[t].messages).forEach(function (m, i) {
            if (threads.thread[t].messages[m].upvotes < 1 && threads.thread[t].messages[m].downvotes < 1) return;
            if (ret[t] === undefined) {
                ret[t] = { p: { u: 0, d: 0 }, t: { u: 0, d: 0 } };
                if (i < 1) {
                    ret[t].p.u = threads.thread[t].messages[m].upvotes;
                    ret[t].p.d = threads.thread[t].messages[m].downvotes;
                }
            }
            ret[t].t.u += threads.thread[t].messages[m].upvotes;
            ret[t].t.d += threads.thread[t].messages[m].downvotes;
        });
    });
    return ret;
}

function getUserPollData(sub, id) {
    var ret = {
        answers: 0,
        tally: [],
        show_results: false,
    };
    if (msg_area.sub[sub] === undefined) return ret;
    id = parseInt(id);
    if (isNaN(id)) return ret;
    var msgBase = new MsgBase(sub);
    if (!msgBase.open()) return ret;
    // var header = msgBase.get_msg_header(id);
    // Temporary use of get_all_msg_headers() to get header.tally for polls -- lol, "temporary"
    var headers = msgBase.get_all_msg_headers();
    var header = null;
    for (var h in headers) {
        if (headers[h].number !== id) continue;
        header = headers[h];
        break;
    }
    // End of temporary shitfest
    if (header === null || !(header.attr&MSG_POLL)) {
        msgBase.close();
        return ret;
    }
    if (header.tally && Array.isArray(header.tally)) ret.tally = header.tally;
    ret.answers = msgBase.how_user_voted(header.number, msgBase.cfg.settings&SUB_NAME ? user.name : user.alias);
    msgBase.close();
    var pollAttr = header.auxattr&POLL_RESULTS_MASK;
    if (header.from === user.alias || header.from === user.name) {
        ret.show_results = true;
    } else if (pollAttr === POLL_RESULTS_CLOSED && header.auxattr&POLL_CLOSED) {
        ret.show_results = true;
    } else if (pollAttr === POLL_RESULTS_OPEN) {
        ret.show_results = true;
    } else if (pollAttr === POLL_RESULTS_VOTERS && ret.answers > 0) {
        ret.show_results = true;
    }
    return ret;
}

function getMailHeaders(sent, ascending) {
    if (sent !== undefined && sent && user.security.restrictions&UFLAG_K) return []; // They'll just see nothing.  Provide actual feedback?  Does anyone use REST K?
    var headers = [];
    var msgBase = new MsgBase('mail');
    if (!msgBase.open()) return headers;
    for (var m = msgBase.first_msg; m <= msgBase.last_msg; m++) {
        var h = msgBase.get_msg_header(m);
        if (h === null || h.attr&MSG_DELETE) continue;
        if ((sent !== undefined && sent) && h.from_ext != user.number) continue;
        if ((sent === undefined || !sent) && h.to_ext != user.number) continue;
        headers.push(h);
    }
    msgBase.close();
    if (ascending === undefined || !ascending) headers.reverse(); // not sure why the double !checks re: ascending and sent
    return headers;
}

function is_spam(header) {
    return (header.attr&MSG_SPAM || (header.subject.search(/^SPAM:/) > -1));
}

function get_mail_headers(filter, ascending) {
    const ret = {
        headers: [],
        sent: { read: 0, unread: 0 },
        spam: { read: 0, unread: 0 },
        inbox: { read: 0, unread: 0 },
    };
    if (filter == 'sent' && user.security.restrictions&UFLAG_K) return ret; // I don't remember what this is for.
    const msg_base = new MsgBase('mail');
    if (!msg_base.open()) return ret;
    for (var n = msg_base.first_msg; n <= msg_base.last_msg; n++) {
        var h = msg_base.get_msg_header(n);
        if (h === null || h.attr&MSG_DELETE) continue;
        if (h.from_ext == user.number) {
            h.attr&MSG_READ ? ret.sent.read++ : (ret.sent.unread++);
            if (filter == 'sent') ret.headers.push(h);
        }
    	if (h.to_ext == user.number) {
            if (is_spam(h)) {
                h.attr&MSG_READ ? ret.spam.read++ : (ret.spam.unread++);
                if (filter == 'spam') ret.headers.push(h);
            } else {
                h.attr&MSG_READ ? ret.inbox.read++ : (ret.inbox.unread++);
                if (filter == 'inbox') ret.headers.push(h);
            }
        }
    }
    msg_base.close();
    if (ascending) ret.headers.reverse();
    return ret;
}

function mimeDecode(header, body, code) {
    const ret = {
        type: '',
        body: [],
    };
    const msg = mime_decode(header, body, code);
    if (msg.inlines) {
        ret.inlines = msg.inlines.map(function (e) {
            return format(
                '<a href="./api/attachments.ssjs?sub=%s&amp;msg=%s&amp;cid=%s" target="_blank">%s</a>',
                code, header.number, e, e
            );
        });
    }
    if (msg.attachments) {
        ret.attachments = msg.attachments.map(function (e) {
            return format(
                '<a href="./api/attachments.ssjs?sub=%s&amp;msg=%s&amp;filename=%s" target="_blank">%s</a>',
                code, header.number, e, e
            );
        });
    }
    ret.type = msg.type;
    ret.body = msg.body;
    return ret;
}

function getMailBody(number) {

    var ret = {
        type: '',
        body: ''
    };

    number = Number(number);
    if (isNaN(number) || number < 0) return ret;

    var msgBase = new MsgBase('mail');
    if (!msgBase.open()) return ret;
    var header = msgBase.get_msg_header(false, number, false);
    if (header !== null && (header.to_ext == user.number || header.from_ext == user.number)) {
        const body = msgBase.get_msg_body(false, header);
        const pt_body = msgBase.get_msg_body(false, header, false, false, true, true);
        var wasUnread = false;
        if (header.to_ext == user.number && !(header.attr & MSG_READ)) {
            header.attr |= MSG_READ;
            msgBase.put_msg_header(false, number, header);
            wasUnread = true;
        }
    }
    msgBase.close();
    if (!body) return ret;
    ret.was_unread = wasUnread;

    var decoded = mimeDecode(header, body, 'mail');
    ret.type = decoded.type;
    var _msgBody1 = pt_body == body ? decoded.body : pt_body;
    ret.body = formatMessage(_msgBody1, /\x1b\[/.test(_msgBody1)); // See above re: pt_body
    ret.inlines = decoded.inlines;
    ret.attachments = decoded.attachments;
    if (user.is_sysop) {
        ret.buttons = [
            format(xjs_eval(settings.web_components + 'twit-button.xjs', true), number, number, header.from, header.from_net_addr),
        ];
    }

    return ret;
}

function addTwit(str) {
    const f = new File(system.ctrl_dir + 'twitlist.cfg');
    if (!f.open('a')) {
        log(LOG_ERR, 'Failed to add ' + str + ' to twitlist');
        return;
    }
    f.writeln(str);
    f.close();
}

// Returns the user's signature, or an empty String
function getSignature() {
    var fn = format('%s/user/%04d.sig', system.data_dir, user.number);
    if (!file_exists(fn)) return '';
    var f = new File(fn);
    f.open('r');
    if (js.global.utf8_encode) {
    	var signature = utf8_encode(f.read());
    } else {
        var signature = ascii_str(f.read());
    }
    f.close();
    return signature;
}

// Post a messge to 'sub'
// Called by postNew/postReply, not directly
function postMessage(sub, header, body, ansi) {
    var ret = false;
    if (user.alias === settings.guest ||
        msg_area.sub[sub] === undefined ||
        !msg_area.sub[sub].can_post ||
        typeof header.to !== 'string' ||
        header.to === '' ||
        typeof header.from !== 'string' ||
        typeof header.subject !== 'string' ||
        typeof body !== 'string' ||
        body === ''
    ) {
        return ret;
    }
    try {
        if (msg_area.sub[sub].settings&SUB_NAME) {
            if (user.name === '') return ret;
            header.from = user.name;
        }
        if (ansi) {
            // ANSI content arrives as base64-encoded raw CP437 bytes.
            // Decode to get the original byte values, and store as-is
            // without UTF-8 headers — just like a BBS terminal post.
            body = base64_decode(body);
            var msgBase = new MsgBase(sub);
            if (msgBase.open()) {
                ret = msgBase.save_msg(header, body);
                msgBase.close();
            }
        } else {
            body = lfexpand(body);
            var msgBase = new MsgBase(sub);
            if(msgBase.open()) {
			header.ftn_charset = "UTF-8 4";
			header.auxattr = MSG_HFIELDS_UTF8;
			ret = msgBase.save_msg(header, word_wrap(body));
			msgBase.close();
		}
        }
    } catch (err) {
        log(err);
    }
    if (ret) user.posted_message();
    return ret;
}

// Post a message to the mail sub, if this user can do so
// Called by postNew/postReply, not directly
function postMail(header, body) {
    // Lazy ARS checks; we could check the *type* of email being sent, I guess.
    if (user.security.restrictions&UFLAG_E || user.security.restrictions&UFLAG_M) {
        return false;
    }
    if (typeof header.to !== 'string' || typeof header.subject !== 'string' || typeof body !== 'string') {
        return false;
    }
    var ret = false;
    if (user.number < 1 || user.alias === settings.guest) return ret;
    var na = netaddr_type(header.to_net_addr);
    header.to_net_type = na;
    if (na === NET_NONE) {
        var un = system.matchuser(header.to);
        if (un === 0) return false; // Should actually inform about this
        header.to_ext = un;
    }
    var msgBase = new MsgBase('mail');
    if (msgBase.open()) {
		header.ftn_charset = "UTF-8 4";
		header.auxattr = MSG_HFIELDS_UTF8;
        ret = msgBase.save_msg(header, lfexpand(body));
        msgBase.close();
    }
    if (ret) user.sent_email();
    return ret;
}

// Post a new (non-reply) message to 'sub'
function postNew(sub, to, subject, body, ansi) {
    if (typeof sub !== 'string' ||
        typeof to !== 'string' ||
        to === '' ||
        typeof subject !== 'string' ||
        subject === '' ||
        typeof body !== 'string' ||
        body === ''
    ) {
        return false;
    }
    var header = {
        to : to,
        from : user.alias,
        from_ext : user.number,
        subject : subject
    };
    if (sub === 'mail') {
	header.to_ext = system.matchuser(to);
	if (header.to_ext === 0)
		header.to_net_addr = header.to;
        return postMail(header, body);
    } else {
        return postMessage(sub, header, body, ansi);
    }
}

// Add a new message to 'sub' in reply to parent message 'pid'
function postReply(sub, body, pid, ansi) {
    var ret = false;
    if (typeof sub !== 'string' || typeof body !== 'string' || typeof pid !== 'number') return ret;
    try {
        var msgBase = new MsgBase(sub);
        msgBase.open();
        var pHeader = msgBase.get_msg_header(pid);
        msgBase.close();
        if (pHeader === null) return ret;
        var header = {
            to: pHeader.from == user.alias ? pHeader.to : pHeader.from,
            from: user.alias,
            from_ext: user.number,
            subject: pHeader.subject,
            thread_id: pHeader.thread_id === undefined ? pHeader.number : pHeader.thread_id,
            thread_back: pHeader.number,
        };
        if (sub === 'mail') {
            if (typeof pHeader.from_net_addr !== 'undefined') header.to_net_addr = pHeader.from_net_addr;
            ret = postMail(header, body);
        } else {
            ret = postMessage(sub, header, body, ansi);
        }
    } catch (err) {
        log(err);
    }
    return ret;
}

function postPoll(sub, subject, votes, results, answers, comments) {

    if (user.alias == settings.guest || user.security.restrictions&UFLAG_V) return false;
    if (typeof msg_area.sub[sub] === 'undefined' || !msg_area.sub[sub].can_post) return false;
    if (typeof subject !== 'string' || subject.length < 1) return false;
    if (!Array.isArray(answers) || answers.length < 2) return false;

    votes = parseInt(votes);
    if (isNaN(votes) || votes < 1 || votes > 15) return false;
    if (votes > answers) votes = answers;

    results = parseInt(results);
    if (isNaN(results) || results < 0 || results > 3) return false;

    var header = {
        attr: MSG_POLL,
        subject: subject.substr(0, LEN_TITLE),
        from: msg_area.sub[sub].settings&SUB_AONLY ? 'Anonymous' : (msg_area.sub[sub].settings&SUB_NAME ? user.name : user.alias),
        from_ext: user.number,
        to: 'All',
        field_list: [],
        auxattr: (results<<POLL_RESULTS_SHIFT) | MSG_HFIELDS_UTF8,
        votes: votes
    };

    if (Array.isArray(comments)) {
        comments.forEach(function (e) {
            header.field_list.push({
                type: SMB_COMMENT,
                data: e.substr(0, LEN_TITLE),
            });
        });
    }

    answers.forEach(function (e) {
        header.field_list.push({
            type: SMB_POLL_ANSWER,
            data: e.substr(0, LEN_TITLE),
        });
    });

    var msgBase = new MsgBase(sub);
    if (!msgBase.open()) return false;
    var ret = msgBase.add_poll(header);
    msgBase.close();

    if (ret) user.posted_message();
    return ret;

}

// Delete a message if
// - This is the mail sub, and the message was sent by or to this user
// - This is another sub on which the user is an operator
function deleteMessage(sub, number) {
    number = parseInt(number);
    if (msg_area.sub[sub] === undefined && sub !== 'mail') return false;
    var msgBase = new MsgBase(sub);
    if (!msgBase.open()) return false;
    var header = msgBase.get_msg_header(number);
    if (header === null) return false;
    if (sub === 'mail' && (header.to_ext == user.number || header.from_ext == user.number)) {
        var ret = msgBase.remove_msg(number);
    } else if (sub !== 'mail' && msg_area.sub[sub].is_operator) {
        var ret = msgBase.remove_msg(number);
    } else {
        var ret = false;
    }
    msgBase.close();
    return ret;
}

function deleteMail(numbers) {
    if (numbers === undefined || !Array.isArray(numbers)) return false;
    var msgBase = new MsgBase('mail');
    if (!msgBase.open()) return false;
    numbers.forEach(function (e) {
        e = parseInt(e);
        if (isNaN(e) || e < msgBase.first_msg || e > msgBase.last_msg) return;
        var header = msgBase.get_msg_header(e);
        if (header === null) return;
        if (header.to_ext == user.number || header.from_ext == user.number) {
            msgBase.remove_msg(e);
        }
    });
    msgBase.close();
    return true;
}

function voteMessage(sub, number, up) {
    if (typeof msg_area.sub[sub] === 'undefined' && sub !== 'mail') return false;
    if (user.alias == settings.guest || user.security.restrictions&UFLAG_V) return false;
    if (msg_area.sub[sub].settings&SUB_NOVOTING) return false;
    number = parseInt(number);
    if (isNaN(number)) return false;
    up = parseInt(up);
    if (isNaN(up) || up < 0 || up > 1) return false;
    var msgBase = new MsgBase(sub);
    if (!msgBase.open()) return false;
    var header = msgBase.get_msg_header(number);
    if (header === null || header.attr&MSG_POLL) {
        msgBase.close();
        return false;
    }
    var uv = msgBase.how_user_voted(header.number, msgBase.cfg.settings&SUB_NAME ? user.name : user.alias);
    if (uv === 0) {
        var vh = {
            from: msgBase.cfg.settings&SUB_NAME ? user.name : user.alias,
            from_ext: user.number,
            from_net_type: NET_NONE,
            thread_back: header.number,
            attr: up ? MSG_UPVOTE : MSG_DOWNVOTE,
        };
        var ret = msgBase.vote_msg(vh);
    }
    msgBase.close();
    return ret;
}

function submitPollAnswers(sub, number, answers) {
    if (typeof msg_area.sub[sub] === 'undefined') return false;
    if (msg_area.sub[sub].settings&SUB_NOVOTING) return false;
    if (user.alias == settings.guest || user.security.restrictions&UFLAG_V) return false;
    number = parseInt(number);
    if (isNaN(number)) return false;
    var msgBase = new MsgBase(sub);
    if (!msgBase.open()) return false;
    var ret = false;
    var header = msgBase.get_msg_header(number);
    if (header !== null && header.attr&MSG_POLL && !(header.auxattr&POLL_CLOSED) && answers.length > 0 && (answers.length <= header.votes || (answers.length == 1 && header.votes == 0))) {
        var uv = msgBase.how_user_voted(number, msgBase.cfg.settings&SUB_NAME ? user.name : user.alias);
        if (uv === 0) {
            var a = 0;
            answers.forEach(function (e) {
                e = parseInt(e);
                if (isNaN(e) || e < 0 || e > 15) return;
                a|=(1<<e);
            });
            ret = msgBase.vote_msg({
                from: msgBase.cfg.settings&SUB_NAME ? user.name : user.alias,
                from_ext: user.number,
                from_net_type: NET_NONE,
                thread_back: number,
                attr: MSG_VOTE,
                votes: a,
            });
        }
    }
    msgBase.close();
    return ret;
}

// Deuce's URL-ifier
function linkify(body) {
    urlRE = /(?:https?|ftp|telnet|ssh|gopher|rlogin|news):\/\/[^\s'"'<>()]*|[-\w.+]+@(?:[-\w]+\.)+[\w]{2,6}/gi;
    body = body.replace(urlRE, function (str) {
        var ret = '';
        var p = 0;
        var link = str.replace(/\.*$/, '');
        var linktext = link;
        if (link.indexOf('://') === -1) link = 'mailto:' + link;
        return ('<a class="ulLink" href="' + link + '" target="_blank" rel="noopener">' + linktext + '</a>' + str.substr(linktext.length));
    });
    return body;
}

// Somewhat modified version of Deuce's "magical quoting stuff" from v3
function quotify(body) {

    var blockquote_start = '<blockquote>';
    var blockquote_end = '</blockquote>';

    var quote_depth=0;
    var prefixes = [];

    const ret = body.split(/\r?\n/).reduce(function (a, c) {
        var line = '';
        var line_prefix = '';
        var m = c.match(/^((?:\s?[^\s]{0,3}&gt;\s?)+)/);
        if (m !== null) {
            var p;
            var broken = false;            
            var new_prefixes = m[1].match(/\s?[^\s]{0,3}&gt;\s?/g);
            line = c;
            // If the new length is smaller than the old one, close the extras
            for (p = new_prefixes.length; p < prefixes.length; p++) {
                if (quote_depth < 1) continue;
                line_prefix = line_prefix + blockquote_end;
                quote_depth--;
            }
            for (p in new_prefixes) {
                // Remove prefix from start of line
                line = line.substr(new_prefixes[p].length);
                if (prefixes[p] === undefined) {
                    /* New depth */
                    line_prefix = line_prefix + blockquote_start;
                    quote_depth++;
                } else if (broken) {
                    line_prefix = line_prefix + blockquote_start;
                    quote_depth++;
                } else if (prefixes[p].replace(/^\s*(.*?)\s*$/, '$1') != new_prefixes[p].replace(/^\s*(.*?)\s*$/, '$1')) {
                    // Close all remaining old prefixes and start one new one
                    for (var o = p; o < prefixes.length && o < new_prefixes.length; o++) {
                        if (quote_depth > 0) {
                            line_prefix = blockquote_end + line_prefix;
                            quote_depth--;
                        }
                    }
                    line_prefix = blockquote_start + line_prefix;
                    quote_depth++;
                    broken = true;
                }
            }
            prefixes = new_prefixes.slice();
            line = line_prefix + line;
        } else {
            for (p = 0; p < prefixes.length; p++) {
                if (quote_depth < 1) continue;
                line_prefix = line_prefix + blockquote_end;
                quote_depth--;
            }
            prefixes = [];
            line = line_prefix + c;
        }
        return a + line + '\r\n';
    }, '');

    if (quote_depth !== 0) {
        for (;quote_depth > 0; quote_depth--) {
            ret += blockquote_end;
        }
    }

    return ret.replace(/\<\/blockquote\>\r\n<blockquote\>/g, '\r\n');

}

// Format message body for the web
/* ---- ANSI-to-HTML via grid parser (ported from frame.js / message_boards.js) ---- */
var _ansiCgaFg = [
    'black', '#a80000', '#00a800', '#a85400', '#0000a8', '#a800a8', '#00a8a8', '#a8a8a8',
    '#545454', '#fc5454', '#54fc54', '#fcfc54', '#5454fc', '#fc54fc', '#54fcfc', 'white'
];
var _ansiCgaBg = [
    'black', '#a80000', '#00a800', '#a85400', '#0000a8', '#a800a8', '#00a8a8', '#a8a8a8'
];
/* Map CP437 bytes 0x01-0x1F to Unicode display glyphs */
var _cp437Low = [
    '', '\u263A', '\u263B', '\u2665', '\u2666', '\u2663', '\u2660', '\u2022',
    '\u25D8', '\u25CB', '\u25D9', '\u2642', '\u2640', '\u266A', '\u266B', '\u263C',
    '\u25BA', '\u25C4', '\u2195', '\u203C', '\u00B6', '\u00A7', '\u25AC', '\u21A8',
    '\u2191', '\u2193', '\u2192', '\u2190', '\u221F', '\u2194', '\u25B2', '\u25BC'
];
/* CP437 high bytes 0x80-0xFF -> Unicode */
var _cp437High = [
    '\u00C7','\u00FC','\u00E9','\u00E2','\u00E4','\u00E0','\u00E5','\u00E7',
    '\u00EA','\u00EB','\u00E8','\u00EF','\u00EE','\u00EC','\u00C4','\u00C5',
    '\u00C9','\u00E6','\u00C6','\u00F4','\u00F6','\u00F2','\u00FB','\u00F9',
    '\u00FF','\u00D6','\u00DC','\u00A2','\u00A3','\u00A5','\u20A7','\u0192',
    '\u00E1','\u00ED','\u00F3','\u00FA','\u00F1','\u00D1','\u00AA','\u00BA',
    '\u00BF','\u2310','\u00AC','\u00BD','\u00BC','\u00A1','\u00AB','\u00BB',
    '\u2591','\u2592','\u2593','\u2502','\u2524','\u2561','\u2562','\u2556',
    '\u2555','\u2563','\u2551','\u2557','\u255D','\u255C','\u255B','\u2510',
    '\u2514','\u2534','\u252C','\u251C','\u2500','\u253C','\u255E','\u255F',
    '\u255A','\u2554','\u2569','\u2566','\u2560','\u2550','\u256C','\u2567',
    '\u2568','\u2564','\u2565','\u2559','\u2558','\u2552','\u2553','\u256B',
    '\u256A','\u2518','\u250C','\u2588','\u2584','\u258C','\u2590','\u2580',
    '\u03B1','\u00DF','\u0393','\u03C0','\u03A3','\u03C3','\u00B5','\u03C4',
    '\u03A6','\u0398','\u03A9','\u03B4','\u221E','\u03C6','\u03B5','\u2229',
    '\u2261','\u00B1','\u2265','\u2264','\u2320','\u2321','\u00F7','\u2248',
    '\u00B0','\u2219','\u00B7','\u221A','\u207F','\u00B2','\u25A0','\u00A0'
];




function _cp437Char(ch) {
    var c = ch.charCodeAt(0);
    if (c > 0 && c < 0x20) return _cp437Low[c];
    if (c >= 0x80 && c <= 0xFF) return _cp437High[c - 0x80];
    return ch;
}
function _htmlSafe(ch) {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    var c = ch.charCodeAt(0);
    if (c > 127) return '&#' + c + ';';
    return ch;
}

function parseAnsiGrid(raw) {
    var WIDTH = 80;
    var lines = raw.split(/\r\n|\n|\r/);
    // grid[y][x] = { ch: char, fg: 0-15, bg: 0-7 }
    var grid = [];
    var fg = 7; // LIGHTGRAY
    var bg = 0; // BLACK
    var hi = 0; // HIGH bit
    var y = 0, maxY = 0;
    var saved = { x: 0, y: 0 };

    for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        var x = 0;

        while (line.length > 0) {
            /* SGR attribute sequence */
            var m = line.match(/^\x1b\[((?:[0-9]{1,3};?)*)([0-9]{0,3})m/);
            if (m !== null) {
                line = line.substr(m[0].length);
                var pstr = m[1], last = m[2];
                var params = [];
                if (pstr && pstr.length) params = pstr.split(';');
                if (last && last.length) params.push(last);
                if (!params.length) params = ['0'];
                for (var pi = 0; pi < params.length; pi++) {
                    var n = Number(params[pi] || '0');
                    if (n === 0) { fg = 7; bg = 0; hi = 0; }
                    else if (n === 1) { hi = 8; }
                    else if (n === 2 || n === 21 || n === 22) { hi = 0; }
                    else if (n === 5) { /* blink - ignore for web */ }
                    else if (n >= 30 && n <= 37) { fg = n - 30; }
                    else if (n >= 40 && n <= 47) { bg = n - 40; }
                    else if (n >= 90 && n <= 97) { fg = n - 90; hi = 8; }
                    else if (n >= 100 && n <= 107) { bg = n - 100; }
                    else if ((n === 38 || n === 48) && params.length > pi + 1) {
                        var mode = parseInt(params[pi + 1], 10);
                        if (mode === 5 && params.length > pi + 2) pi += 2;
                        else if (mode === 2 && params.length > pi + 4) pi += 4;
                    }
                }
                continue;
            }

            /* Cursor position (CUP) */
            m = line.match(/^\x1b\[(\d*);?(\d*)[Hf]/);
            if (m !== null) {
                line = line.substr(m[0].length);
                if (m[1]) y = Math.max(0, Number(m[1]) - 1);
                else y = 0;
                if (m[2]) x = Math.max(0, Number(m[2]) - 1);
                else x = 0;
                continue;
            }

            /* Cursor up */
            m = line.match(/^\x1b\[(\d*)A/);
            if (m !== null) { line = line.substr(m[0].length); y = Math.max(0, y - Number(m[1] || 1)); continue; }

            /* Cursor down */
            m = line.match(/^\x1b\[(\d*)B/);
            if (m !== null) { line = line.substr(m[0].length); y += Number(m[1] || 1); continue; }

            /* Cursor forward */
            m = line.match(/^\x1b\[(\d*)C/);
            if (m !== null) { line = line.substr(m[0].length); x += Number(m[1] || 1); continue; }

            /* Cursor backward */
            m = line.match(/^\x1b\[(\d*)D/);
            if (m !== null) { line = line.substr(m[0].length); x = Math.max(0, x - Number(m[1] || 1)); continue; }

            /* Save cursor */
            m = line.match(/^\x1b\[s/);
            if (m !== null) { line = line.substr(m[0].length); saved.x = x; saved.y = y; continue; }

            /* Restore cursor */
            m = line.match(/^\x1b\[u/);
            if (m !== null) { line = line.substr(m[0].length); x = saved.x; y = saved.y; continue; }

            /* Clear screen */
            m = line.match(/^\x1b\[2J/);
            if (m !== null) { line = line.substr(m[0].length); grid = []; x = 0; y = 0; continue; }

            /* Erase in Line (EL) */
            m = line.match(/^\x1b\[(\d*)K/);
            if (m !== null) {
                line = line.substr(m[0].length);
                var mode = Number(m[1] || 0);
                if (grid[y]) {
                    if (mode === 0) { for (var ex = x; ex < WIDTH; ex++) grid[y][ex] = { ch: ' ', fg: 7, bg: bg }; }
                    else if (mode === 1) { for (var ex = 0; ex <= x; ex++) grid[y][ex] = { ch: ' ', fg: 7, bg: bg }; }
                    else if (mode === 2) { grid[y] = []; }
                }
                continue;
            }

            /* Eat any other ESC sequence we don't handle */
            m = line.match(/^\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/);
            if (m !== null) { line = line.substr(m[0].length); continue; }
            m = line.match(/^\x1b[\x40-\x7e]/);
            if (m !== null) { line = line.substr(m[0].length); continue; }

            /* Ctrl-A (Synchronet attribute) - skip code + next char */
            if (line.charCodeAt(0) === 1 && line.length > 1) { line = line.substr(2); continue; }

            /* Skip other control chars */
            var cc = line.charCodeAt(0);
            if (cc === 0 || cc === 7 || cc === 0x1b || cc === 0x7f) { line = line.substr(1); continue; }

            /* Place visible character on grid */
            var ch = line.charAt(0);
            line = line.substr(1);
            if (x >= WIDTH) { x = 0; y++; }
            if (!grid[y]) grid[y] = [];
            grid[y][x] = { ch: ch, fg: fg + hi, bg: bg };
            if (y > maxY) maxY = y;
            x++;
        }
        y++;
        if (y > maxY + 1) maxY = y - 1;
    }

    return { grid: grid, width: WIDTH, height: maxY + 1 };
}

/**
 * Pack a parsed ANSI grid into a base64-encoded cell blob.
 * Each cell = 2 bytes: [cp437_charCode, (fg & 0xF) | ((bg & 0xF) << 4)]
 * Row-major order, WIDTH columns x height rows.
 * Color indices are in ANSI/xterm order (matching GraphicsConverter's XTERM_COLORS).
 */
function ansiGridToBase64(parsed) {
    var grid = parsed.grid;
    var w = parsed.width;
    var h = parsed.height;
    var total = w * h;
    var buf = '';
    for (var row = 0; row < h; row++) {
        for (var col = 0; col < w; col++) {
            var cell = grid[row] ? grid[row][col] : undefined;
            var charCode = cell ? cell.ch.charCodeAt(0) & 0xFF : 32;
            var fg = cell ? (cell.fg & 0xF) : 7;
            var bg = cell ? (cell.bg & 0xF) : 0;
            buf += String.fromCharCode(charCode);
            buf += String.fromCharCode(fg | (bg << 4));
        }
    }
    return base64_encode(buf);
}

/**
 * Render ANSI data to HTML.  Includes a canvas-ready data attribute
 * for client-side GraphicsConverter upgrade, with the old <pre> as fallback.
 */
function ansiToHtmlGrid(raw) {
    var parsed = parseAnsiGrid(raw);
    var grid = parsed.grid;
    var w = parsed.width;
    var h = parsed.height;

    /* Encode cell data for client-side canvas rendering */
    var cellsB64 = ansiGridToBase64(parsed);

    /* Build fallback HTML (legacy span-based render) */
    var html = '<pre class="ansi">';
    for (var row = 0; row < h; row++) {
        if (row > 0) html += '\n';
        var prevFg = -1, prevBg = -1, spanOpen = false;
        for (var col = 0; col < w; col++) {
            var cell = grid[row] ? grid[row][col] : undefined;
            var cFg = cell ? cell.fg : 7;
            var cBg = cell ? cell.bg : 0;
            var cCh = cell ? cell.ch : ' ';
            if (cFg !== prevFg || cBg !== prevBg) {
                if (spanOpen) html += '</span>';
                html += '<span style="color: ' + _ansiCgaFg[cFg] + '; background-color: ' + _ansiCgaBg[cBg] + ';">';
                spanOpen = true;
                prevFg = cFg;
                prevBg = cBg;
            }
            html += _htmlSafe(_cp437Char(cCh));
        }
        if (spanOpen) html += '</span>';
    }
    html += '</pre>';

    /* Wrap in a container with canvas data; client JS upgrades this */
    return '<div class="ansi-render" data-ansi-w="' + w + '" data-ansi-h="' + h + '" data-ansi-cells="' + cellsB64 + '">'
        + html + '</div>';
}

/* Convert Synchronet Ctrl-A attribute codes to HTML spans.
   Pipe codes should be converted to Ctrl-A first via pipeToCtrlA(). */
function ctrlAToHtml(body, exascii) {
    var fgMap = {
        'K': '#000', 'B': '#00a', 'G': '#0a0', 'C': '#0aa',
        'R': '#a00', 'M': '#a0a', 'Y': '#a50', 'W': '#aaa'
    };
    var fgMapHi = {
        'K': '#555', 'B': '#55f', 'G': '#5f5', 'C': '#5ff',
        'R': '#f55', 'M': '#f5f', 'Y': '#ff5', 'W': '#fff'
    };
    var bgMap = ['#000','#a00','#0a0','#a50','#00a','#a0a','#0aa','#aaa'];

    var hi = false;
    var fg = null;
    var bg = null;
    var spanOpen = false;
    var out = '';
    var i = 0;
    var hasCodes = body.indexOf('\x01') >= 0;

    // word_wrap the full body first (before ctrl-A processing)
    body = word_wrap(body, body.length);

    if (!hasCodes) {
        body = html_encode(body, exascii, false, false, false);
        return body;
    }

    // Process char-by-char to handle ctrl-A sequences
    while (i < body.length) {
        if (body.charCodeAt(i) === 1 && i + 1 < body.length) {
            var code = body.charAt(i + 1);
            i += 2;
            var upper = code.toUpperCase();

            if (upper === 'N' || upper === '-') {
                // Normal/reset
                hi = false; fg = null; bg = null;
                if (spanOpen) { out += '</span>'; spanOpen = false; }
            } else if (upper === 'H') {
                hi = true;
            } else if (upper === 'I') {
                // Blink - ignore for web
            } else if (fgMap[upper] !== undefined) {
                fg = upper;
                // Open or change span
                if (spanOpen) out += '</span>';
                var color = hi ? fgMapHi[upper] : fgMap[upper];
                var style = 'color:' + color;
                if (bg !== null) style += ';background:' + bgMap[bg];
                out += '<span style="' + style + '">';
                spanOpen = true;
            } else if (code >= '0' && code <= '7') {
                bg = parseInt(code, 10);
                if (spanOpen) out += '</span>';
                var style = '';
                if (fg !== null) {
                    style += 'color:' + (hi ? fgMapHi[fg] : fgMap[fg]);
                }
                if (style.length) style += ';';
                style += 'background:' + bgMap[bg];
                out += '<span style="' + style + '">';
                spanOpen = true;
            }
            // else: unknown code, skip silently
        } else {
            out += body.charAt(i);
            i++;
        }
    }
    if (spanOpen) out += '</span>';

    // Now process the assembled text (ctrl-A codes removed, spans inserted)
    // We need to html_encode the text portions but NOT the span tags
    // Split on tags, encode text segments, rejoin
    var parts = out.split(/(<span[^>]*>|<\/span>)/);
    for (var p = 0; p < parts.length; p++) {
        if (parts[p].charAt(0) !== '<') {
            parts[p] = html_encode(parts[p], exascii, false, false, false);
        }
    }
    return parts.join('');
}

function formatMessage(body, ansi, exascii) {

    // Workaround for html_encode(body, true, false, false, false);
    // which causes a crash if body is empty
    if (body === '') return body;

    if (typeof ansi === 'boolean' && ansi) {

        body = ansiToHtmlGrid(body);

    } else {

        // Convert pipe codes (|00-|23) to Ctrl-A codes
        body = pipeToCtrlA(body);
        // Strip ANSI escape sequences
        body = body.replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g,'');
        body = body.replace(/\x1b[\x40-\x7e]/g,'');
        // Strip unprintable control chars (NULL, BEL, DEL, ESC) but keep \x01
        body = body.replace(/[\x00\x07\x1b\x7f]/g,'');
        // Convert Ctrl-A color codes to HTML spans, then encode the rest
        body = ctrlAToHtml(body, exascii);
        body = quotify(body);
        body = linkify(body);
        body = body.replace(/\r\n$/,'');
        body = body.replace(/(\r?\n)/g, "<br>$1");

    }

    return body;

}

function setScanCfg(sub, cfg) {

    if (msg_area.sub[sub] === undefined) return false;

    cfg = parseInt(cfg);
    if (isNaN(cfg) || cfg < 0 || cfg > 2) return false;

    // Use bitwise ops to preserve bits we don't own (e.g. SCAN_CFG_TOYOU)
    // instead of clobbering the entire scan_cfg value.
    // Pattern from stock updatesubs.ssjs.
    if (cfg === 0) {
        msg_area.sub[sub].scan_cfg &= ~SCAN_CFG_NEW;
        msg_area.sub[sub].scan_cfg &= ~SCAN_CFG_YONLY;
    } else if (cfg === 1) {
        msg_area.sub[sub].scan_cfg |= SCAN_CFG_NEW;
        msg_area.sub[sub].scan_cfg &= ~SCAN_CFG_YONLY;
    } else if (cfg === 2) {
        msg_area.sub[sub].scan_cfg |= SCAN_CFG_YONLY;
        msg_area.sub[sub].scan_cfg |= SCAN_CFG_NEW;
    }
    return true;

}

function getMessageThreads(sub, max) {

    var threads = {
        thread: {},
        order: [],
    };
    var subjects = {};

    if (msg_area.sub[sub] === undefined) return threads;
    if (!msg_area.sub[sub].can_read) return threads;

    function addToThread(thread_id, header, subject) {
        if (subject !== undefined) subjects[subject] = thread_id;
        if (header.when_written_time > threads.thread[thread_id].newest) {
            threads.thread[thread_id].newest = header.when_written_time;
        }
        if (is_user() && header.number > msg_area.sub[sub].scan_ptr) {
            threads.thread[thread_id].unread++;
        }
        threads.thread[thread_id].messages[header.number] = {
            attr: header.attr,
            auxattr: header.auxattr,
            number: header.number,
            from: (header.attr&MSG_ANONYMOUS) ? "Anonymous" : (header.is_utf8 ? header.from : utf8_encode(header.from)),
            from_ext: header.from_ext,
            from_net_addr: header.from_net_addr,
            to: header.is_utf8 ? header.to : utf8_encode(header.to),
            when_written_time: header.when_written_time,
            upvotes: (header.attr&MSG_POLL ? 0 : (header.upvotes || 0)),
            downvotes: (header.attr&MSG_POLL ? 0 : (header.downvotes || 0)),
            is_utf8: header.is_utf8
        };
        if (header.attr&MSG_POLL) {
            header.field_list.sort(function (a, b) {
                if (a.type === 0x62) return -1;
                if (b.type === 0x62) return 1;
                return 0;
            });
            threads.thread[thread_id].messages[header.number].poll_comments = [];
            threads.thread[thread_id].messages[header.number].poll_answers = [];
            header.field_list.forEach(function (e) {
                if (e.type === SMB_COMMENT) {
                    threads.thread[thread_id].messages[header.number].poll_comments.push(e);
                } else if (e.type === SMB_POLL_ANSWER) {
                    threads.thread[thread_id].messages[header.number].poll_answers.push(e);
                }
            });
            threads.thread[thread_id].messages[header.number].votes = header.votes;
            threads.thread[thread_id].messages[header.number].tally = header.tally || [];
            threads.thread[thread_id].messages[header.number].subject = header.subject;
        } else {
            threads.thread[thread_id].votes.up += (header.upvotes || 0);
            threads.thread[thread_id].votes.down += (header.downvotes || 0);
        }
    }

    function getSomeMessageHeaders(msgBase, count) {
        var start = msgBase.last_msg - count;
        if (start < msgBase.first_msg) start = msgBase.first_msg;
        var headers = {};
        var c = 0;
        for (var m = start; m <= msgBase.last_msg; m++) {
            var header = msgBase.get_msg_header(m);
            if (header === null || header.attr&MSG_DELETE) continue;
            if (settings.forum_no_spam && is_spam(header)) continue;
            headers[header.number] = header;
            c++;
            if (c >= count) break;
        }
        return headers;
    }

    var msgBase = new MsgBase(sub);
    if (!msgBase.open()) return threads;
    if ((typeof max == 'number' && max > 0) || typeof msgBase.get_all_msg_headers != 'function') {
        var headers = getSomeMessageHeaders(msgBase, max);
    } else {
        var headers = msgBase.get_all_msg_headers();
    }
    msgBase.close();
    if (!headers) return threads;

    Object.keys(headers).forEach(function (h) {

        if (headers[h] === null || headers[h].attr&MSG_DELETE) {
            delete headers[h];
            return;
        }

        if (settings.forum_no_spam && is_spam(header)) {
            delete headers[h];
            return;
        }

        if (sub === 'mail' &&
            headers[h].to !== user.alias &&
            headers[h].to !== user.name &&
            headers[h].to_ext !== user.number &&
            headers[h].from !== user.alias &&
            headers[h].from !== user.name &&
            headers[h].from_ext !== user.number
        ) {
            delete headers[h];
            return;
        }

        var subject = headers[h].subject.replace(/^(re:\s*)*/ig, '');

        if (subjects[subject] !== undefined) {
            addToThread(subjects[subject], headers[h]);
        } else if (headers[h].thread_id !== 0) {
            if (threads.thread[headers[h].thread_id] === undefined) {
                threads.thread[headers[h].thread_id] = {
                    id: headers[h].thread_id,
                    newest: 0,
                    subject: headers[h].subject,
                    messages: {},
                    votes: {
                        up: 0,
                        down: 0
                    },
                    unread: 0
                };
            }
            addToThread(headers[h].thread_id, headers[h], subject);
        } else if (headers[h].thread_back !== 0) {
            if (threads.thread[headers[h].thread_back] !== undefined) {
                addToThread(headers[h].thread_back, headers[h], subject);
            } else {
                var threaded = false;
                for (var t in threads.thread) {
                    if (threads.thread[t].messages[headers[h].thread_back] !== undefined) {
                        addToThread(t, headers[h], subject);
                        threaded = true;
                        break;
                    }
                }
                if (!threaded) {
                    threads.thread[headers[h].thread_back] = {
                        id: headers[h].thread_back,
                        newest: 0,
                        subject: headers[h].subject,
                        messages: {},
                        votes: {
                            up: 0,
                            down: 0
                        },
                        unread: 0
                    };
                    addToThread(headers[h].thread_back, headers[h], subject);
                }
            }
        } else {
            threads.thread[headers[h].number] = {
                id: headers[h].number,
                newest: 0,
                subject: headers[h].subject,
                messages: {},
                votes: {
                    up: 0,
                    down: 0
                },
                unread: 0
            };
            addToThread(headers[h].number, headers[h], subject);
        }

        delete headers[h];

    });

    threads.order = Object.keys(threads.thread).sort(function (a, b) {
        return threads.thread[b].newest - threads.thread[a].newest;
    });

    return threads;

}

function getMessageThread(sub, thread, count, after, reload) {

    thread = parseInt(thread, 10);
    if (isNaN(thread)) return [];
    count = parseInt(count, 10);
    if (isNaN(count)) return [];

    const t = getMessageThreads(sub, settings.max_messages).thread[thread];
    const mkeys = Object.keys(t.messages);
    var m; // Current message
    var r = 0; // Messages returned
    var n = 0; // Index into t.messages
    if (after) {
        var i = mkeys.indexOf(after);
        if (reload) {
            if (i >= 0) count += i + 1;
        } else {
            if (i < 0) return [];
            n = i + 1;
        }
    }

    const msgBase = new MsgBase(sub);

    return function threadIterator() {
        if (r >= count || n >= mkeys.length) {
            if (msgBase.is_open) msgBase.close();
            return null; // Done
        }
        if (!msgBase.is_open && !msgBase.open()) {
            throw new Error('Failed to open ' + sub);
        }
        m = t.messages[mkeys[n]];
        var body = msgBase.get_msg_body(m.number);
        if (body === null) {
            n++;
            return threadIterator();
        }
        if (r == 0) m.subject = t.subject;
        m.body = formatMessage(body, /\x1b\[/.test(body));
        n++;
        r++;
        return m;
    }

}

function cleanSubject(subject) {
    return subject.replace(/^(re:\s*)*/ig, '');
}

var forum = {

    getThreadList: function getThreadList(sub) {

        const threads = {};
        const subjects = {}; // Map of "clean" subjects to threads
        const messages = {}; // Map of messsage numbers to threads

        function addThread(h, s) {
            threads[h.thread_id] = {
                first_message: {
                    from: h.from,
                    from_net_addr: h.from_net_addr,
                    from_net_type: h.from_net_type,
                    tags: h.tags,
                    to: h.to,
                    to_net_addr: h.to_net_addr,
                    to_net_type: h.to_net_type,
                    subject: h.subject,
                    when_written_time: h.when_written_time,
                },
                messages: 1,
                votes: {
                    parent: {
                        up: h.upvotes,
                        down: h.downvotes,
                    },
                    total: {
                        up: h.upvotes,
                        down: h.downvotes,
                    }
                }
            };
            subjects[s] = h.thread_id;
            messages[h.thread_id] = h.thread_id;
        }

        function addToThread(t, h, s, m) {
            threads[t].messages++;
            threads[t].last_message = {
                from: h.from,
                when_written_time: h.when_written_time,
            };
            threads[t].votes.total.up += h.upvotes;
            threads[t].votes.total.down += h.downvotes;
            if (subjects[s] === undefined) subjects[s] = t;
            messages[m] = t;
        }

        const mb = new MsgBase(sub);
        if (!mb.open()) return threads;
        const headers = mb.get_all_msg_headers();
        mb.close();

        var s; // "clean" subject of current message
        for (var h in headers) {
            if (headers[h] === null) continue; // Unnecessary? Does get_all_message_headers exclude empty slots?
            if (headers[h].attr&MSG_DELETE) continue;
            s = cleanSubject(headers[h].subject);
            // If we don't yet have a thread for this message's thread_id:
            if (threads[headers[h].thread_id] === undefined) {
                // If this message's thread_id points to a message that belongs to another thread:
                if (messages[headers[h].thread_id] !== undefined) {
                    // The record in messages[] for that message tells us which thread it belongs to
                    addToThread(messages[headers[h].thread_id], headers[h], s, h);
                // If this message's "clean" subject has been seen before:
                } else if (subjects[s] !== undefined) {
                    // The record in subjects[] for this subject tells us which thread shares this subject
                    addToThread(subjects[s], headers[h], s, h);
                // This is the first message in a new thread
                } else {
                    addThread(headers[h], s);
                }
            // We have a thread for this message's thread_id:
            } else {
                addToThread(headers[h].thread_id, headers[h], s, h);
            }
        }

        return threads;

    },

    getThread: function getThread(sub, id, onMessage) {

        id = parseInt(id, 10);
        if (isNaN(id) || id < 0) return;

        const mb = new MsgBase(sub);
        if (!mb.open()) return;

        if (id < mb.first_msg || id > mb.last_msg) {
            mb.close();
            return;
        }
        
        var b;
        var s;
        const subjects = [];
        const messages = [];

        const headers = mb.get_all_msg_headers();
        
        for (var h in headers) {

            if (headers[h] === null) continue; // Unnecessary? Does get_all_message_headers exclude empty slots?
            if (headers[h].attr&MSG_DELETE) continue;

            s = cleanSubject(headers[h].subject);
            if (headers[h].thread_id !== id && messages.indexOf(headers[h].thread_id) < 0 && subjects.indexOf(s) < 0) continue;
            messages.push(parseInt(h, 10));
            if (subjects.indexOf(s) < 0) subjects.push(s);

            b = mb.get_msg_body(parseInt(h, 10));
            if (b === null) continue; // Not sure if this is a holdover from early vote msg days. Is body ever null on a real message?

            onMessage({
                body: formatMessage(b, /\x1b\[/.test(b)),
                from: headers[h].from,
                from_net_addr: headers[h].from_net_addr,
                from_net_type: headers[h].from_net_type,
                number: parseInt(h, 10),
                subject: headers[h].subject,
                tags: headers[h].tags,
                thread_id: headers[h].thread_id, // for debug; remove this line at some point
                thread_back: headers[h].thread_back,
                thread_next: headers[h].thread_next,
                thread_first: headers[h].thread_first,
                to: headers[h].to,
                to_net_addr: headers[h].to_net_addr,
                to_net_type: headers[h].to_net_type,
                votes: {
                    up: headers[h].upvotes,
                    down: headers[h].downvotes,
                },
                when_written_time: headers[h].when_written_time,
                unread: is_user() && (parseInt(h, 10) > msg_area.sub[sub].scan_ptr),
            });

        }

        mb.close();

    }

};


function setScanPtr(sub, ptr) {
    if (!is_user()) return false;
    if (msg_area.sub[sub] === undefined) return false;
    ptr = parseInt(ptr, 10);
    if (isNaN(ptr)) return false;
    if (ptr > msg_area.sub[sub].scan_ptr) {
        msg_area.sub[sub].scan_ptr = ptr;
    }
    return true;
}

var getThread = forum.getThread;
var getThreadList = forum.getThreadList;

forum;
