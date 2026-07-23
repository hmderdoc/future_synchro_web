/* newsflip.ssjs — Backend API for the Flipboard-style news reader
 *
 * Feed scraping is handled by the standalone newsflip-scrape.js timed event.
 * This API only reads from the cache and serves data to the frontend.
 *
 * Endpoints:
 *   ?call=get-articles       Paginated articles for infinite scroll
 *   ?call=get-topics         Available topics for onboarding
 *   ?call=get-user-prefs     Get saved topic preferences
 *   ?call=set-user-prefs     Save topic preferences (topics=csv)
 *   ?call=get-article-content  Fetch full article content for reading view
 *   ?call=refresh            Force re-scrape (sysop only)
 *   ?call=archive-url        Returns archive.ph URL for a given link
 */

'use strict';

load('sbbsdefs.js');
var settings = load('modopts.js', 'web');
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
var NewsflipContent = load('newsflip_content.js');  // shared full-text extractor (web + BBS)

var CACHE_DIR = system.data_dir + 'newsflip/';
var ARTICLES_PATH  = CACHE_DIR + 'articles.json';
var META_PATH      = CACHE_DIR + 'scrape_meta.json';
var PREFS_DIR      = CACHE_DIR + 'prefs/';
var CONTENT_DIR    = CACHE_DIR + 'content/';

/* ── topic definitions ──────────────────────────────────────────────── */

var TOPICS = [
    { id: 'top',            label: 'Top Stories',    icon: '*', cats: ['Top Stories', 'Featured', 'Breaking'] },
    { id: 'tech',           label: 'Tech',           icon: '>', cats: ['Technology', 'Sci/Tech', 'Gadgets'] },
    { id: 'business',       label: 'Business',       icon: '$', cats: ['Business', 'Finance', 'Economy'] },
    { id: 'science',        label: 'Science',        icon: '~', cats: ['Science', 'Sci/Tech', 'Space'] },
    { id: 'sports',         label: 'Sports',         icon: '+', cats: ['Sports'] },
    { id: 'entertainment',  label: 'Entertainment',  icon: '#', cats: ['Entertainment', 'Celebrity', 'Music', 'Movies'] },
    { id: 'health',         label: 'Health',         icon: '+', cats: ['Health', 'Wellness'] },
    { id: 'travel',         label: 'Travel',         icon: '^', cats: ['Travel', 'Lifestyle'] },
    { id: 'politics',       label: 'Politics',       icon: '!', cats: ['Politics', 'Government'] },
    { id: 'quirky',         label: 'Quirky',         icon: '?', cats: ['Offbeat', 'Odd News', 'Humor', 'Fun'] }
];

/* ── helpers ────────────────────────────────────────────────────────── */

function mkdirp(path) {
    if (file_isdir(path)) return;
    mkdirp(path.replace(/[\/\\][^\/\\]+[\/\\]?$/, ''));
    mkdir(path);
}

function jsonReply(obj) {
    http_reply.header['Content-Type'] = 'application/json; charset=utf-8';
    write(asciiSafeJson(JSON.stringify(obj)));
}

/* Strip control characters and encode high-bytes for clean JSON.
 * Synchronet's JSON.stringify may not escape control chars 0x00-0x1f
 * or high bytes properly, causing JSON.parse to fail on reload. */
function asciiSafeJson(str) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) {
            out += '\\u' + ('0000' + c.toString(16)).slice(-4);
        } else if (c > 0x7e) {
            out += '\\u' + ('0000' + c.toString(16)).slice(-4);
        } else {
            out += str.charAt(i);
        }
    }
    return out;
}

/* Full-article content extraction (fetch + Readability, RSS fallback) now
 * lives in the shared newsflip_content.js module; see get-article-content. */

/* ── article loading (cache-only) ─────────────────────────────────── */

function loadArticles() {
    try {
        var f = new File(ARTICLES_PATH);
        if (!f.open('r')) return [];
        var raw = f.read();
        f.close();
        if (!raw || raw.length === 0) return [];
        return JSON.parse(raw);
    } catch (e) {
        log(LOG_ERR, 'newsflip: loadArticles parse error: ' + e.message);
        return [];
    }
}

/* ── user preferences ─────────────────────────────────────────────── */

function prefsPath(userNum) {
    return PREFS_DIR + 'user' + userNum + '.json';
}

function loadPrefs(userNum) {
    try {
        var f = new File(prefsPath(userNum));
        if (!f.exists || !f.open('r')) return null;
        var raw = f.readAll().join('');
        f.close();
        return JSON.parse(raw);
    } catch (e) { return null; }
}

function savePrefs(userNum, prefs) {
    mkdirp(PREFS_DIR);
    var f = new File(prefsPath(userNum));
    if (!f.open('w')) return false;
    f.write(JSON.stringify(prefs));
    f.close();
    return true;
}

/* ── request routing ──────────────────────────────────────────────── */

var call = '';
if (http_request.query.call) {
    call = (typeof http_request.query.call === 'object')
        ? http_request.query.call[0] : http_request.query.call;
}

switch (call) {

case 'get-topics': {
    jsonReply({
        topics: TOPICS.map(function (t) {
            return { id: t.id, label: t.label, icon: t.icon };
        })
    });
    break;
}

case 'get-articles': {
    var articles = loadArticles();
    var topicFilter = http_request.query.topics
        ? (typeof http_request.query.topics === 'object'
            ? http_request.query.topics[0] : http_request.query.topics).split(',')
        : null;
    var offset = parseInt(http_request.query.offset
        ? (typeof http_request.query.offset === 'object'
            ? http_request.query.offset[0] : http_request.query.offset) : 0, 10);
    var limit = parseInt(http_request.query.limit
        ? (typeof http_request.query.limit === 'object'
            ? http_request.query.limit[0] : http_request.query.limit) : 20, 10);
    if (isNaN(offset) || offset < 0) offset = 0;
    if (isNaN(limit)  || limit < 1)  limit = 20;
    if (limit > 50) limit = 50;

    /* If user has prefs and no explicit topic filter, use their prefs */
    if (!topicFilter && user.number > 0 && user.alias !== settings.guest) {
        var prefs = loadPrefs(user.number);
        if (prefs && prefs.topics && prefs.topics.length > 0) {
            topicFilter = prefs.topics;
        }
    }

    var filtered = articles;
    if (topicFilter && topicFilter.length > 0) {
        filtered = articles.filter(function (a) {
            return topicFilter.indexOf(a.topic) >= 0;
        });
    }

    /* Round-robin interleave so every topic gets visibility */
    if (!topicFilter || topicFilter.length > 1) {
        var buckets = {};
        for (var ii = 0; ii < filtered.length; ii++) {
            var tt = filtered[ii].topic;
            if (!buckets[tt]) buckets[tt] = [];
            buckets[tt].push(filtered[ii]);
        }
        var keys = Object.keys(buckets);
        var interleaved = [];
        var maxLen = 0;
        for (var jj = 0; jj < keys.length; jj++) {
            if (buckets[keys[jj]].length > maxLen) maxLen = buckets[keys[jj]].length;
        }
        for (var row = 0; row < maxLen; row++) {
            for (var col = 0; col < keys.length; col++) {
                if (row < buckets[keys[col]].length) {
                    interleaved.push(buckets[keys[col]][row]);
                }
            }
        }
        filtered = interleaved;
    }

    var page = filtered.slice(offset, offset + limit);
    var meta = {};
    try {
        var mf2 = new File(META_PATH);
        if (mf2.open('r')) { meta = JSON.parse(mf2.readAll().join('')); mf2.close(); }
    } catch(e) {}

    jsonReply({
        articles: page,
        total: filtered.length,
        offset: offset,
        limit: limit,
        lastScrape: meta.lastScrape || 0,
        hasMore: offset + limit < filtered.length
    });
    break;
}

case 'get-article-content': {
    var artId = http_request.query.id
        ? (typeof http_request.query.id === 'object'
            ? http_request.query.id[0] : http_request.query.id)
        : '';
    if (!artId) { jsonReply({ error: 'missing id' }); break; }

    /* Find article in main cache so the extractor has link/feedUrl/meta. */
    var allArts = loadArticles();
    var art = null;
    for (var ai = 0; ai < allArts.length; ai++) {
        if (allArts[ai].id === artId) { art = allArts[ai]; break; }
    }

    /* Cache-only fallback: if the story aged out of the main cache but we
     * already extracted its content, serve that rather than 404. */
    if (!art) { art = { id: artId }; }

    /* Shared extractor: article URL + Mozilla Readability, falling back to the
     * RSS content tag. Reads/writes content/<id>.json (shared with the BBS). */
    var result = NewsflipContent.getArticleContent(art);
    if (!result) { jsonReply({ error: 'not found' }); break; }

    http_reply.header['Content-Type'] = 'application/json; charset=utf-8';
    write(NewsflipContent.asciiSafeJson(JSON.stringify(result)));
    break;
}

case 'get-user-prefs': {
    if (user.number < 1 || user.alias === settings.guest) {
        jsonReply({ topics: [] });
        break;
    }
    var prefs = loadPrefs(user.number);
    jsonReply(prefs || { topics: [] });
    break;
}

case 'set-user-prefs': {
    if (user.number < 1 || user.alias === settings.guest) {
        jsonReply({ ok: false, error: 'guest' });
        break;
    }
    var topicsStr = http_request.query.topics
        ? (typeof http_request.query.topics === 'object'
            ? http_request.query.topics[0] : http_request.query.topics)
        : '';
    var topicsList = topicsStr.split(',').filter(function (t) { return t; });
    savePrefs(user.number, { topics: topicsList });
    jsonReply({ ok: true });
    break;
}

case 'refresh': {
    if (user.security.level < 90) {
        jsonReply({ ok: false, error: 'forbidden' });
        break;
    }
    /* Delete meta so the timed event re-scrapes on next run */
    file_remove(META_PATH);
    /* Clear content cache too */
    if (file_isdir(CONTENT_DIR)) {
        var cFiles = directory(CONTENT_DIR + '*.json');
        for (var ci = 0; ci < cFiles.length; ci++) {
            file_remove(cFiles[ci]);
        }
    }
    jsonReply({ ok: true, message: 'Cache cleared. Timed event will re-scrape within 20 minutes.' });
    break;
}

case 'archive-url': {
    var url = http_request.query.url
        ? (typeof http_request.query.url === 'object'
            ? http_request.query.url[0] : http_request.query.url)
        : '';
    jsonReply({ archiveUrl: 'https://archive.ph/?run=1&url=' + encodeURIComponent(url) });
    break;
}

default:
    jsonReply({ error: 'unknown call', call: call });
}
