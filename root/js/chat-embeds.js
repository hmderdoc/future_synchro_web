/* chat-embeds.js — rich media + website link previews for the web chat.
 *
 * Classifies URLs found in chat messages and renders STATELESS embed cards:
 *   - image URLs        -> inline image card (same markup the markdown
 *                          ![alt](url) embed uses, so its CSS/error handling
 *                          applies unchanged)
 *   - video/audio URLs  -> poster card; playback opens in the floating dock
 *   - YouTube / Vimeo   -> poster card (thumbnail when available); playback
 *                          embeds the provider's player in the floating dock
 *   - other http(s)     -> OpenGraph link-preview card hydrated from
 *                          ./api/link-preview.ssjs (auth-gated server side)
 *
 * Message cards are deliberately stateless: the chat page rebuilds the
 * transcript DOM on every update, so anything that holds playback state would
 * be destroyed mid-play. All playback lives in a single floating dock element
 * attached to document.body — it survives transcript re-renders AND SPA page
 * swaps (the same pattern as the persistent radio player). The dock's CSS is
 * injected from here for the same reason: page-scoped styles leave the DOM
 * when the SPA swaps pages.
 *
 * Dual environment: browser (window.ChatEmbeds) and node (module.exports) so
 * the pure parts are unit-testable (see test-chat-embeds.js).
 */
(function (global, factory) {
    var api = factory(global);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (global && typeof global.document !== 'undefined') global.ChatEmbeds = api;
}(typeof window !== 'undefined' ? window : null, function (global) {
    'use strict';

    var URL_PATTERN = /(https?:\/\/[^\s<]+)/gi;
    var IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)([?#]|$)/i;
    var VIDEO_EXT = /\.(mp4|webm|ogv|m4v|mov)([?#]|$)/i;
    var AUDIO_EXT = /\.(mp3|ogg|oga|m4a|flac|wav)([?#]|$)/i;
    var ANSI_EXT = /\.(ans|asc)([?#]|$)/i;
    var MAX_MEDIA_CARDS = 3;
    var PREVIEW_ENDPOINT = './api/link-preview.ssjs';
    var ANSI_ENDPOINT = './api/chat-ansi.ssjs';

    /* Chat attachments live under /chatmedia/<date>/<id>.<ext> and are purged
       after a week. Recognising them lets a dead link render as "expired"
       rather than as a broken image. */
    var MEDIA_PATH = /\/chatmedia\/(\d{4}-\d{2}-\d{2}\/[a-f0-9]{24}\.[a-z0-9]{1,4})([?#]|$)/i;
    var PREVIEW_CACHE_PREFIX = 'chat-link-preview:';
    var PREVIEW_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

    /* ------------------------------------------------------------- pure */

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function escapeAttr(str) {
        return escapeHtml(str);
    }

    function linkifyPlain(text) {
        return escapeHtml(text || '').replace(URL_PATTERN, function (url) {
            return '<a href="' + url + '" target="_blank" rel="noopener">' + url + '</a>';
        });
    }

    /* ------------------------------------------------ pipe colour codes

       Mystic / MRC pipe codes typed into chat (`|12red |10green`, `|22` for a
       brown background): |00-|15 are CGA foregrounds, |16-|23 CGA backgrounds,
       in plain CGA index order. Anything else after a pipe is ordinary text.
       Our own control markers ([BITMAP|80|237|...], [TVTUNER|...]) hold valid
       looking codes and never reach this renderer as text - but are skipped
       here as well so a marker that does slip through is shown intact. */

    var PIPE_CODE = /\|(0[0-9]|1[0-9]|2[0-3])/g;
    var CGA_HEX = ['#555555', '#0000AA', '#00AA00', '#00AAAA', '#AA0000', '#AA00AA', '#AA5500', '#AAAAAA',
        '#555555', '#5555FF', '#55FF55', '#55FFFF', '#FF5555', '#FF55FF', '#FFFF55', '#FFFFFF'];
    /* |00 black is lifted to dark gray (index 0 above): the page is black,
       and the terminal renderer guards it the same way. Backgrounds keep
       true black so |16 can end a highlight. */
    var CGA_BG_HEX = ['#000000', '#0000AA', '#00AA00', '#00AAAA', '#AA0000', '#AA00AA', '#AA5500', '#AAAAAA'];

    function isControlMarker(text) {
        return /^\s*\[(BITMAP|TVTUNER)\|/.test(String(text || ''));
    }

    function hasPipeCodes(text) {
        if (isControlMarker(text)) return false;
        PIPE_CODE.lastIndex = 0;
        return PIPE_CODE.test(String(text || ''));
    }

    /* Text with every valid code removed (previews, toasts, URL detection). */
    function stripPipeCodes(text) {
        if (isControlMarker(text)) return String(text || '');
        return String(text || '').replace(PIPE_CODE, '');
    }

    /* -> [{text, fg, bg}] with fg/bg CGA indexes or -1 for the bubble default. */
    function parsePipeSegments(text) {
        var source = String(text || '');
        var segments = [];
        var fg = -1;
        var bg = -1;
        var last = 0;
        var match;
        if (isControlMarker(source)) return [{ text: source, fg: -1, bg: -1 }];
        PIPE_CODE.lastIndex = 0;
        while ((match = PIPE_CODE.exec(source)) !== null) {
            if (match.index > last) segments.push({ text: source.substring(last, match.index), fg: fg, bg: bg });
            var code = parseInt(match[1], 10);
            if (code <= 15) fg = code;
            else bg = code === 16 ? -1 : code - 16;
            last = match.index + match[0].length;
        }
        if (last < source.length) segments.push({ text: source.substring(last), fg: fg, bg: bg });
        return segments;
    }

    /* Escaped, linkified HTML with each coloured run wrapped in a span. The
       colour values come from the fixed tables above, never from the message,
       so nothing a sender types can reach the style attribute. */
    function linkify(text) {
        if (!hasPipeCodes(text)) return linkifyPlain(text);
        return parsePipeSegments(text).map(function (segment) {
            var html = linkifyPlain(segment.text);
            var style = '';
            if (segment.fg >= 0) style += 'color:' + CGA_HEX[segment.fg] + ';';
            if (segment.bg > 0) style += 'background-color:' + CGA_BG_HEX[segment.bg] + ';';
            return style ? '<span class="chat-pipe-color" style="' + style + '">' + html + '</span>' : html;
        }).join('');
    }

    /* Short labels (an MRC board's name): foreground colours only, no links,
       no highlight backgrounds. Same fixed table as linkify. */
    function colorizePipeLabel(text) {
        if (!hasPipeCodes(text)) return escapeHtml(text);
        return parsePipeSegments(text).map(function (segment) {
            var html = escapeHtml(segment.text);
            return segment.fg >= 0 ? '<span class="chat-pipe-color" style="color:' + CGA_HEX[segment.fg] + ';">' + html + '</span>' : html;
        }).join('');
    }

    /* Bridged networks (DDial) colour text with ANSI, which reaches the page
       as runs [{n, c:'#rrggbb'|''}] covering the text exactly. Runs that do
       not add up, or carry anything but a hex colour, are ignored - the style
       attribute only ever sees a value this pattern accepted. */
    var RUN_COLOR = /^#[0-9a-fA-F]{6}$/;

    function validColorRuns(text, runs) {
        var total = 0;
        if (!runs || !runs.length) return false;
        for (var i = 0; i < runs.length; i += 1) {
            var run = runs[i];
            if (!run || !(run.n > 0) || Math.floor(run.n) !== run.n) return false;
            if (run.c && !RUN_COLOR.test(run.c)) return false;
            total += run.n;
        }
        return total === String(text || '').length;
    }

    /* Black-on-black is unreadable here; lift it the way |00 is lifted. */
    function runColor(hex) {
        return /^#0{6}$/.test(hex) ? CGA_HEX[0] : hex;
    }

    function colorizeRuns(text, runs, renderPlain) {
        var source = String(text || '');
        var render = renderPlain || linkifyPlain;
        var at = 0;
        if (!validColorRuns(source, runs)) return null;
        return runs.map(function (run) {
            var html = render(source.substr(at, run.n));
            at += run.n;
            return run.c ? '<span class="chat-pipe-color" style="color:' + runColor(run.c) + ';">' + html + '</span>' : html;
        }).join('');
    }

    function extractUrls(text) {
        var found = String(text || '').match(URL_PATTERN);
        return found ? found.slice() : [];
    }

    /* Trailing punctuation glued to a pasted URL ("see https://x.test/a."). */
    function trimUrl(url) {
        return String(url || '').replace(/[.,;:!?)\]}>'"]+$/, '');
    }

    function urlHost(url) {
        var match = /^https?:\/\/([^/?#]+)/i.exec(String(url || ''));
        var host = match ? match[1] : '';
        host = host.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
        return host.toLowerCase();
    }

    function urlFilename(url) {
        var path = String(url || '').replace(/^https?:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
        var segments = path.split('/');
        var name = segments[segments.length - 1] || '';
        try { name = decodeURIComponent(name); } catch (_e) { /* keep raw */ }
        return name;
    }

    function youtubeId(url) {
        var host = urlHost(url);
        var match;
        if (host === 'youtu.be') {
            match = /^https?:\/\/[^/]+\/([A-Za-z0-9_-]{6,15})([?#]|$)/i.exec(url);
            return match ? match[1] : null;
        }
        if (!/(^|\.)((youtube)(-nocookie)?\.com)$/.test(host)) return null;
        match = /[?&]v=([A-Za-z0-9_-]{6,15})([&#]|$)/.exec(url);
        if (match) return match[1];
        match = /\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{6,15})([?#/]|$)/.exec(url);
        return match ? match[1] : null;
    }

    function vimeoId(url) {
        var host = urlHost(url);
        var match;
        if (!/(^|\.)vimeo\.com$/.test(host)) return null;
        match = /^https?:\/\/[^/]+\/(?:video\/)?(\d{6,12})([?#/]|$)/i.exec(url);
        return match ? match[1] : null;
    }

    /* One classified embed: { kind, url, id?, poster? }. kind 'link' means
       "no native embed — a candidate for the OpenGraph preview card". */
    function classifyUrl(rawUrl) {
        var url = trimUrl(rawUrl);
        var id;
        if (!/^https?:\/\//i.test(url)) return null;
        id = youtubeId(url);
        if (id) {
            return {
                kind: 'youtube', url: url, id: id,
                poster: 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg'
            };
        }
        id = vimeoId(url);
        if (id) return { kind: 'vimeo', url: url, id: id };
        if (IMAGE_EXT.test(url)) return { kind: 'image', url: url };
        if (VIDEO_EXT.test(url)) return { kind: 'video', url: url };
        if (AUDIO_EXT.test(url)) return { kind: 'audio', url: url };
        /* Only OUR ANSI uploads get a render card: an arbitrary .ans on the
           internet is not something this server should be fetching. */
        if (ANSI_EXT.test(url) && mediaFile(url)) return { kind: 'ansi', url: url };
        return { kind: 'link', url: url };
    }

    /* The '<date>/<id>.<ext>' part of a chat attachment URL, or ''. */
    function mediaFile(url) {
        var match = MEDIA_PATH.exec(String(url || ''));
        return match ? match[1] : '';
    }

    /* All embeds for one message: bounded media cards plus at most ONE
       link-preview candidate (the first plain link). */
    function collectEmbeds(text, options) {
        var opts = options || {};
        var maxMedia = opts.maxMedia || MAX_MEDIA_CARDS;
        var urls = extractUrls(text);
        var media = [];
        var previewUrl = null;
        var seen = {};
        urls.forEach(function (rawUrl) {
            var embed = classifyUrl(rawUrl);
            if (!embed || seen[embed.url]) return;
            seen[embed.url] = true;
            if (embed.kind === 'link') {
                if (!previewUrl) previewUrl = embed.url;
                return;
            }
            if (media.length < maxMedia) media.push(embed);
        });
        return { media: media, previewUrl: previewUrl };
    }

    /* --------------------------------------------------- card rendering */

    /* Same whole-word keyword rule as the file areas (the list comes from
       mods/load/social_lib.js via sbbsConfig): generated pictures land in
       chat first, under the same file names, so they veil here too. */
    function isNsfwText(text) {
        var words = (window.sbbsConfig && window.sbbsConfig.nsfwKeywords) || [];
        if (!words.length || !text) return false;
        var decoded = String(text);
        try { decoded = decodeURIComponent(decoded); } catch (_e) { /* keep as is */ }
        var parts = decoded.toLowerCase().split(/[^a-z0-9]+/);
        for (var i = 0; i < parts.length; i++) if (parts[i] && words.indexOf(parts[i]) !== -1) return true;
        return false;
    }

    function renderImageCardHtml(embed, caption) {
        var name = urlFilename(embed.url);
        var file = mediaFile(embed.url);
        var nsfw = isNsfwText(embed.url) || isNsfwText(name) || isNsfwText(caption || '');
        return '<div class="chat-rich-image-card' + (nsfw ? ' is-nsfw' : '') + '"' +
            (file ? ' data-chat-media="' + escapeAttr(file) + '"' : '') + '>' +
            '<a class="chat-rich-image-link" href="' + escapeAttr(embed.url) + '" target="_blank" rel="noopener">' +
                '<span class="chat-rich-image-frame">' +
                    '<img class="chat-rich-image-preview" src="' + escapeAttr(embed.url) + '" alt="' + escapeAttr(name || 'Chat image') + '" loading="lazy">' +
                    (nsfw ? '<span class="chat-rich-nsfw-veil" data-chat-nsfw-reveal>NSFW<small>click to reveal</small></span>' : '') +
                '</span>' +
                '<span class="chat-rich-image-fallback">Open image</span>' +
            '</a>' +
        '</div>';
    }

    /* Shown in place of any attachment whose week is up. Chat history keeps the
       original message text, so this is the only trace the purge leaves. */
    function renderExpiredHtml(label) {
        return '<div class="chat-rich-expired">' +
            '<span class="chat-rich-expired-icon" aria-hidden="true">&#9673;</span>' +
            '<span class="chat-rich-expired-copy">' +
                '<span class="chat-rich-expired-title">Attachment expired</span>' +
                '<span class="chat-rich-expired-note">' + escapeHtml(label || 'Chat uploads are kept for one week.') + '</span>' +
            '</span>' +
        '</div>';
    }

    /* ANSI has no browser-native renderer; hydrate() fetches the converted
       HTML from the server and fills this in. */
    function renderAnsiCardHtml(embed) {
        var name = urlFilename(embed.url);
        return '<div class="chat-rich-ansi-card" data-chat-ansi="' + escapeAttr(mediaFile(embed.url)) + '">' +
            '<div class="chat-rich-ansi-head">' +
                '<span class="chat-rich-ansi-name">' + escapeHtml(name || 'ANSI') + '</span>' +
                '<a class="chat-rich-ansi-link" href="' + escapeAttr(embed.url) + '" target="_blank" rel="noopener">Download</a>' +
            '</div>' +
            '<div class="chat-rich-ansi-body">Loading ANSI&hellip;</div>' +
        '</div>';
    }

    function mediaBrandLabel(embed) {
        if (embed.kind === 'youtube') return 'YouTube video';
        if (embed.kind === 'vimeo') return 'Vimeo video';
        if (embed.kind === 'video') return 'Video';
        return 'Audio';
    }

    function mediaOpenLabel(embed) {
        if (embed.kind === 'youtube') return 'Open on YouTube';
        if (embed.kind === 'vimeo') return 'Open on Vimeo';
        return 'Open link';
    }

    function renderMediaCardHtml(embed) {
        var label = mediaBrandLabel(embed);
        var title = urlFilename(embed.url) || urlHost(embed.url);
        var slim = embed.kind === 'audio';
        var file = mediaFile(embed.url);
        var html = '<div class="chat-rich-media-card' + (slim ? ' chat-rich-media-card-audio' : '') + '"' +
            (file ? ' data-chat-media="' + escapeAttr(file) + '"' : '') +
            ' data-chat-embed-kind="' + escapeAttr(embed.kind) + '"' +
            ' data-chat-embed-url="' + escapeAttr(embed.url) + '"' +
            (embed.id ? ' data-chat-embed-id="' + escapeAttr(embed.id) + '"' : '') +
            ' data-chat-embed-title="' + escapeAttr(title) + '">';
        html += '<button type="button" class="chat-rich-media-poster" data-chat-embed-play="1" title="Play ' + escapeAttr(label) + '">';
        if (embed.poster) {
            html += '<img class="chat-rich-media-thumb" src="' + escapeAttr(embed.poster) + '" alt="" loading="lazy">';
        }
        html += '<span class="chat-rich-media-overlay">' +
            '<span class="chat-rich-media-play" aria-hidden="true">&#9654;</span>' +
            '<span class="chat-rich-media-copy">' +
                '<span class="chat-rich-media-brand">' + escapeHtml(label) + '</span>' +
                (title ? '<span class="chat-rich-media-name">' + escapeHtml(title) + '</span>' : '') +
            '</span>' +
        '</span>';
        html += '</button>';
        html += '<div class="chat-rich-media-actions">' +
            '<a class="chat-rich-media-link" href="' + escapeAttr(embed.url) + '" target="_blank" rel="noopener">' + escapeHtml(mediaOpenLabel(embed)) + '</a>' +
        '</div>';
        html += '</div>';
        return html;
    }

    /* entry: undefined/'pending' -> skeleton, {ok:true,data} -> card,
       {ok:false} -> '' (the plain link in the text stays). */
    function renderLinkPreviewHtml(url, entry) {
        var data = entry && entry.ok ? (entry.data || {}) : null;
        var pending = !entry;
        var host = urlHost(url);
        var title;
        var parts;
        if (entry && !entry.ok) return '';
        title = data && data.title ? data.title : (pending ? 'Loading preview…' : host);
        parts = '<span class="chat-rich-link-copy">' +
            '<span class="chat-rich-link-site">' + escapeHtml((data && data.siteName) || host) + '</span>' +
            '<span class="chat-rich-link-title">' + escapeHtml(title) + '</span>' +
            ((data && data.description) ? '<span class="chat-rich-link-desc">' + escapeHtml(data.description) + '</span>' : '') +
        '</span>';
        if (data && data.image) {
            parts = '<span class="chat-rich-link-media"><img src="' + escapeAttr(data.image) + '" alt="" loading="lazy"></span>' + parts;
        }
        return '<a class="chat-rich-link-card' + (pending ? ' is-pending' : '') + '"' +
            ' data-chat-link-preview="' + escapeAttr(url) + '"' +
            ' href="' + escapeAttr(url) + '" target="_blank" rel="noopener">' + parts + '</a>';
    }

    /* Bubble HTML: linkified text plus embed cards. `getPreviewEntry` lets the
       browser side render cached previews synchronously (no flicker on the
       full transcript re-render); node tests pass a stub. */
    function renderRichHtml(text, options) {
        var opts = options || {};
        /* URLs are found in the code-free text: `|11https://...` is a link. */
        /* Colour runs index the text as sent, so they win over pipe codes. */
        var runHtml = opts.colorRuns ? colorizeRuns(text, opts.colorRuns) : null;
        var embeds = collectEmbeds(runHtml === null ? stripPipeCodes(text) : String(text || ''), opts);
        var parts = ['<div class="chat-rich-text">' + (runHtml === null ? linkify(text || '') : runHtml) + '</div>'];
        embeds.media.forEach(function (embed) {
            if (embed.kind === 'image') parts.push(renderImageCardHtml(embed, text));
            else if (embed.kind === 'ansi') parts.push(renderAnsiCardHtml(embed));
            else parts.push(renderMediaCardHtml(embed));
        });
        if (embeds.previewUrl && opts.allowLinkPreviews) {
            parts.push(renderLinkPreviewHtml(embeds.previewUrl,
                opts.getPreviewEntry ? opts.getPreviewEntry(embeds.previewUrl) : getCachedPreview(embeds.previewUrl)));
        }
        if (parts.length === 1) return parts[0];
        return '<div class="chat-rich-block">' + parts.join('') + '</div>';
    }

    /* ------------------------------------------------- preview caching */

    var previewMemory = {};   /* url -> {ok, data} | 'pending' */

    function sessionStore() {
        try { return global && global.sessionStorage ? global.sessionStorage : null; }
        catch (_e) { return null; }
    }

    function getCachedPreview(url) {
        var store;
        var raw;
        var parsed;
        var cached = previewMemory[url];
        if (cached && cached !== 'pending') return cached;
        if (cached === 'pending') return undefined;
        store = sessionStore();
        if (!store) return undefined;
        try {
            raw = store.getItem(PREVIEW_CACHE_PREFIX + url);
            if (!raw) return undefined;
            parsed = JSON.parse(raw);
            if (!parsed || (Date.now() - (parsed.t || 0)) > PREVIEW_CACHE_TTL_MS) return undefined;
            previewMemory[url] = { ok: !!parsed.ok, data: parsed.data || null };
            return previewMemory[url];
        } catch (_e) { return undefined; }
    }

    function putCachedPreview(url, entry) {
        var store = sessionStore();
        previewMemory[url] = entry;
        if (!store) return;
        try {
            store.setItem(PREVIEW_CACHE_PREFIX + url, JSON.stringify({
                t: Date.now(), ok: entry.ok, data: entry.data || null
            }));
        } catch (_e) { /* quota — memory cache still works */ }
    }

    /* Re-render every card for `url` currently in the document (the message
       list may have re-rendered while the fetch was in flight). */
    function patchPreviewCards(url) {
        var doc = global && global.document;
        var entry;
        var replacementHtml;
        if (!doc) return;
        entry = getCachedPreview(url);
        replacementHtml = renderLinkPreviewHtml(url, entry);
        Array.prototype.slice.call(doc.querySelectorAll('[data-chat-link-preview]')).forEach(function (card) {
            var holder;
            if (card.getAttribute('data-chat-link-preview') !== url) return;
            if (!replacementHtml.length) {
                card.parentNode && card.parentNode.removeChild(card);
                return;
            }
            holder = doc.createElement('div');
            holder.innerHTML = replacementHtml;
            if (holder.firstChild) card.parentNode.replaceChild(holder.firstChild, card);
        });
    }

    /* ------------------------------------------- chat attachment hydration */

    /* file -> 'expired' | html | 'pending'. Survives transcript re-renders, so
       a purged attachment is not re-fetched once per update tick. */
    var ansiMemory = {};
    var expiredMedia = {};

    function replaceWithExpired(node, label) {
        var doc = global && global.document;
        var holder;
        if (!doc || !node || !node.parentNode) return;
        holder = doc.createElement('div');
        holder.innerHTML = renderExpiredHtml(label);
        if (holder.firstChild) node.parentNode.replaceChild(holder.firstChild, node);
    }

    /* An image whose file is gone fires `error`; that is the cheapest possible
       expiry check, since it costs nothing while the file is still there. */
    function hydrateMediaCards(doc, scope) {
        Array.prototype.slice.call(scope.querySelectorAll('[data-chat-media]')).forEach(function (card) {
            var file = card.getAttribute('data-chat-media') || '';
            var img;
            if (!file.length) return;
            if (expiredMedia[file]) {
                replaceWithExpired(card);
                return;
            }
            img = card.querySelector('img');
            if (!img || img.getAttribute('data-chat-expiry-bound') === '1') return;
            img.setAttribute('data-chat-expiry-bound', '1');
            img.addEventListener('error', function () {
                expiredMedia[file] = true;
                replaceWithExpired(card);
            });
        });
    }

    function patchAnsiCards(file) {
        var doc = global && global.document;
        var entry = ansiMemory[file];
        if (!doc || !entry || entry === 'pending') return;
        Array.prototype.slice.call(doc.querySelectorAll('[data-chat-ansi]')).forEach(function (card) {
            var body;
            if (card.getAttribute('data-chat-ansi') !== file) return;
            if (entry === 'expired') {
                replaceWithExpired(card);
                return;
            }
            body = card.querySelector('.chat-rich-ansi-body');
            if (body) body.innerHTML = entry;
        });
    }

    function hydrateAnsiCards(doc, scope, endpoint) {
        Array.prototype.slice.call(scope.querySelectorAll('[data-chat-ansi]')).forEach(function (card) {
            var file = card.getAttribute('data-chat-ansi') || '';
            if (!file.length) return;
            if (ansiMemory[file] && ansiMemory[file] !== 'pending') {
                patchAnsiCards(file);
                return;
            }
            if (ansiMemory[file] === 'pending') return;
            ansiMemory[file] = 'pending';
            fetch((endpoint || ANSI_ENDPOINT) + '?file=' + encodeURIComponent(file), { credentials: 'same-origin' })
                .then(function (response) { return response.ok ? response.json() : null; })
                .then(function (payload) {
                    if (payload && payload.ok && payload.html) ansiMemory[file] = payload.html;
                    else if (payload && payload.expired) ansiMemory[file] = 'expired';
                    else ansiMemory[file] = 'expired';
                    patchAnsiCards(file);
                })
                .catch(function () {
                    ansiMemory[file] = 'expired';
                    patchAnsiCards(file);
                });
        });
    }

    /* Fetch previews for any pending cards under `root`. `enabled` should be
       false for guests — the endpoint requires an authenticated session. */
    function hydrate(root, options) {
        var opts = options || {};
        var doc = global && global.document;
        var scope = root || doc;
        if (!doc || !scope || !scope.querySelectorAll) return;

        hydrateMediaCards(doc, scope);
        hydrateAnsiCards(doc, scope, opts.ansiEndpoint);
        Array.prototype.slice.call(scope.querySelectorAll('[data-chat-link-preview]')).forEach(function (card) {
            var url = card.getAttribute('data-chat-link-preview') || '';
            var cached;
            if (!url.length) return;
            if (opts.enabled === false) {
                card.parentNode && card.parentNode.removeChild(card);
                return;
            }
            cached = getCachedPreview(url);
            if (cached) return;                      /* rendered from cache already */
            if (previewMemory[url] === 'pending') return;
            previewMemory[url] = 'pending';
            fetch((opts.endpoint || PREVIEW_ENDPOINT) + '?url=' + encodeURIComponent(url), { credentials: 'same-origin' })
                .then(function (response) { return response.ok ? response.json() : null; })
                .then(function (payload) {
                    var ok = !!(payload && !payload.error && (payload.title || payload.image || payload.description));
                    putCachedPreview(url, { ok: ok, data: ok ? payload : null });
                    patchPreviewCards(url);
                })
                .catch(function () {
                    putCachedPreview(url, { ok: false, data: null });
                    patchPreviewCards(url);
                });
        });
    }

    /* ------------------------------------------------ floating player dock */

    var DOCK_ID = 'chat-embed-dock';
    var DOCK_STYLE_ID = 'chat-embed-dock-style';
    var DOCK_BOX_KEY = 'chat-embed-dock-box';
    var DOCK_MARGIN = 12;          /* gap kept between the dock and every viewport edge */
    var DOCK_MIN_WIDTH = 220;
    var DOCK_MIN_HEIGHT = 130;
    var DOCK_DEFAULT_WIDTH = 440;
    var DOCK_BODY_RATIO = 9 / 16;  /* default player body height, as a share of the width */

    /* Geometry is owned by JS (see placeDock): the dock used to be pinned with
       `right`/`bottom`, which put its far edge under the iOS browser chrome and
       let a player taller than the viewport hang off the top with no way to
       reach it. Everything here is sized in a column so an explicit height can
       flow into the player body. */
    var DOCK_CSS = '' +
        '#chat-embed-dock{position:fixed;left:0;top:0;z-index:10050;box-sizing:border-box;' +
            'display:flex;flex-direction:column;width:440px;' +
            'background:#050505;border:1px solid #333333;' +
            'box-shadow:0 6px 24px rgba(0,0,0,0.6);font-size:0.85rem;}' +
        '#chat-embed-dock *{box-sizing:border-box;}' +
        '#chat-embed-dock .chat-embed-dock-bar{display:flex;align-items:center;gap:8px;' +
            'flex:0 0 auto;padding:6px 8px;border-bottom:1px solid #222222;color:#55FFFF;' +
            'cursor:move;touch-action:none;user-select:none;-webkit-user-select:none;}' +
        '#chat-embed-dock .chat-embed-dock-title{flex:1;min-width:0;overflow:hidden;' +
            'text-overflow:ellipsis;white-space:nowrap;}' +
        '#chat-embed-dock .chat-embed-dock-close{border:1px solid #333333;background:transparent;' +
            'color:#AAAAAA;cursor:pointer;font:inherit;line-height:1;padding:2px 8px;' +
            'touch-action:manipulation;}' +
        '#chat-embed-dock .chat-embed-dock-close:hover{color:#FFFFFF;border-color:#AAAAAA;}' +
        '#chat-embed-dock .chat-embed-dock-body{background:#000000;position:relative;' +
            'flex:1 1 auto;min-height:0;overflow:hidden;}' +
        '#chat-embed-dock .chat-embed-dock-frame{position:absolute;inset:0;}' +
        '#chat-embed-dock .chat-embed-dock-frame>iframe,' +
        '#chat-embed-dock .chat-embed-dock-frame>video{position:absolute;inset:0;' +
            'width:100%;height:100%;border:0;background:#000000;}' +
        '#chat-embed-dock .chat-embed-dock-frame>video{object-fit:contain;}' +
        '#chat-embed-dock audio{display:block;width:100%;}' +
        /* Resize rail. A full-width strip under the body rather than a corner
           overlay, which would land on the native video controls' fullscreen
           button; the hatch marks just mark its right end. */
        '#chat-embed-dock .chat-embed-dock-grip{flex:0 0 auto;height:16px;' +
            'border-top:1px solid #222222;cursor:nwse-resize;touch-action:none;' +
            'background-color:#0A0A0A;background-repeat:no-repeat;' +
            'background-position:right 3px bottom 3px;background-size:11px 11px;' +
            'background-image:linear-gradient(135deg,transparent 0 46%,#666666 46% 54%,' +
            'transparent 54% 68%,#666666 68% 76%,transparent 76%);}' +
        /* Mid-gesture the iframe must not swallow the pointer stream. */
        '#chat-embed-dock.is-gesturing{user-select:none;-webkit-user-select:none;}' +
        '#chat-embed-dock.is-gesturing .chat-embed-dock-body{pointer-events:none;}';

    function ensureDockStyles(doc) {
        var style;
        if (doc.getElementById(DOCK_STYLE_ID)) return;
        style = doc.createElement('style');
        style.id = DOCK_STYLE_ID;
        style.textContent = DOCK_CSS;
        doc.head.appendChild(style);
    }

    /* Where the user last dragged/resized the dock to. Held in memory because
       openPlayer tears the dock down and rebuilds it on every play, and
       mirrored to localStorage so the choice also survives a reload. */
    var dockBox = null;
    var dockUnbindViewport = null;

    function finite(value, fallback) {
        return typeof value === 'number' && isFinite(value) ? value : fallback;
    }

    function loadDockBox() {
        var raw, parsed;
        if (dockBox) return dockBox;
        try { raw = global.localStorage.getItem(DOCK_BOX_KEY); } catch (e) { return null; }
        if (!raw) return null;
        try { parsed = JSON.parse(raw); } catch (e) { return null; }
        if (!parsed || typeof parsed !== 'object') return null;
        dockBox = {
            left: finite(parsed.left, 0),
            top: finite(parsed.top, 0),
            width: finite(parsed.width, DOCK_DEFAULT_WIDTH),
            height: finite(parsed.height, 0)
        };
        return dockBox;
    }

    function saveDockBox(box) {
        dockBox = box;
        try { global.localStorage.setItem(DOCK_BOX_KEY, JSON.stringify(box)); } catch (e) {}
    }

    /* env() is only readable back through a real property, so measure the
       notch / home-indicator insets off a throwaway probe. Cached, because the
       clamp below can run on every scroll frame; the viewport hooks drop the
       cache whenever a rotation could have changed them. */
    var dockInsets = null;

    function safeInsets(doc) {
        var probe, css;
        if (dockInsets) return dockInsets;
        probe = doc.createElement('div');
        probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;' +
            'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
            'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);';
        doc.body.appendChild(probe);
        css = doc.defaultView.getComputedStyle(probe);
        dockInsets = {
            top: parseFloat(css.paddingTop) || 0,
            right: parseFloat(css.paddingRight) || 0,
            bottom: parseFloat(css.paddingBottom) || 0,
            left: parseFloat(css.paddingLeft) || 0
        };
        probe.parentNode.removeChild(probe);
        return dockInsets;
    }

    /* The band the user can actually see, in the layout-viewport coordinates a
       fixed element is positioned in. This is the heart of the off-screen bug:
       on iOS the layout viewport runs on behind the collapsing browser toolbar
       and the on-screen keyboard, so a dock pinned to its bottom edge sits in
       the hidden strip. visualViewport reports the visible band instead.
       Pinch-zoom is excluded — the dock should not shrink because the user
       zoomed in. */
    function viewportBounds(view) {
        var vv = view.visualViewport;
        if (vv && vv.width && vv.height && !(vv.scale > 1.01)) {
            return { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height };
        }
        return { left: 0, top: 0, width: view.innerWidth, height: view.innerHeight };
    }

    /* The one place dock geometry is written. Shrinks the box to what the
       visible band can hold, then nudges it back inside — so a player can
       never end up clipped or parked off-screen, whatever the drag, the
       resize, the rotation or the keyboard that got it there. */
    function placeDock(dock, box) {
        var doc = dock.ownerDocument;
        var view = doc.defaultView;
        var insets = safeInsets(doc);
        var bounds = viewportBounds(view);
        var minLeft = bounds.left + DOCK_MARGIN + insets.left;
        var minTop = bounds.top + DOCK_MARGIN + insets.top;
        var maxRight = bounds.left + bounds.width - insets.right - DOCK_MARGIN;
        var maxBottom = bounds.top + bounds.height - insets.bottom - DOCK_MARGIN;
        var height;

        box.width = Math.min(Math.max(box.width, DOCK_MIN_WIDTH), Math.max(DOCK_MIN_WIDTH, maxRight - minLeft));
        dock.style.width = box.width + 'px';
        if (dock.getAttribute('data-resizable') === '1') {
            box.height = Math.min(Math.max(box.height, DOCK_MIN_HEIGHT), Math.max(DOCK_MIN_HEIGHT, maxBottom - minTop));
            dock.style.height = box.height + 'px';
        }

        /* Audio docks hug their controls, so measure rather than assume. */
        height = dock.offsetHeight || finite(box.height, DOCK_MIN_HEIGHT);
        box.left = Math.min(Math.max(box.left, minLeft), Math.max(minLeft, maxRight - box.width));
        box.top = Math.min(Math.max(box.top, minTop), Math.max(minTop, maxBottom - height));
        dock.style.left = box.left + 'px';
        dock.style.top = box.top + 'px';
        return box;
    }

    function dockRectBox(dock) {
        var rect = dock.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    }

    /* Drag from the title bar, resize from the rail. Pointer events so mouse
       and touch share one path, and pointer capture so a gesture that strays
       over the player iframe keeps reporting. */
    function startDockGesture(dock, event, mode) {
        var handle = event.currentTarget;
        var start, startX, startY;

        /* One gesture at a time: a second finger must not fight the first. */
        if (event.button > 0 || dock.classList.contains('is-gesturing')) return;
        start = dockRectBox(dock);
        startX = event.clientX;
        startY = event.clientY;
        event.preventDefault();
        dock.classList.add('is-gesturing');
        try { handle.setPointerCapture(event.pointerId); } catch (e) {}

        function onMove(moveEvent) {
            var dx = moveEvent.clientX - startX;
            var dy = moveEvent.clientY - startY;
            placeDock(dock, mode === 'resize'
                ? { left: start.left, top: start.top, width: start.width + dx, height: start.height + dy }
                : { left: start.left + dx, top: start.top + dy, width: start.width, height: start.height });
        }
        function onEnd() {
            var box = dockRectBox(dock);
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onEnd);
            handle.removeEventListener('pointercancel', onEnd);
            dock.classList.remove('is-gesturing');
            /* Only deliberate gestures are remembered — a box squeezed down by
               a small viewport should not become the user's preferred size. */
            saveDockBox({
                left: box.left,
                top: box.top,
                width: box.width,
                height: dock.getAttribute('data-resizable') === '1' ? box.height : 0
            });
        }
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onEnd);
        handle.addEventListener('pointercancel', onEnd);
    }

    function bindDockGestures(dock) {
        var bar = dock.querySelector('.chat-embed-dock-bar');
        var grip = dock.querySelector('.chat-embed-dock-grip');
        if (bar) bar.addEventListener('pointerdown', function (event) {
            var target = event.target;
            if (target && target.closest && target.closest('.chat-embed-dock-close')) return;
            startDockGesture(dock, event, 'move');
        });
        if (grip) grip.addEventListener('pointerdown', function (event) {
            startDockGesture(dock, event, 'resize');
        });
    }

    /* Rotating the device, raising the keyboard or the mobile browser toolbar
       sliding in can all strand the dock outside the visible band, so re-run
       the clamp whenever the viewport moves under it. */
    function bindDockViewport(dock) {
        var view = dock.ownerDocument.defaultView;
        var vv = view.visualViewport;
        var pending = 0;
        function reflow() {
            if (pending) return;
            pending = view.requestAnimationFrame(function () {
                pending = 0;
                if (dock.parentNode) placeDock(dock, dockRectBox(dock));
            });
        }
        function remeasure() {
            dockInsets = null;   /* a rotation can change the notch insets */
            reflow();
        }
        view.addEventListener('resize', remeasure);
        view.addEventListener('orientationchange', remeasure);
        if (vv) {
            vv.addEventListener('resize', remeasure);
            vv.addEventListener('scroll', reflow);
        }
        dockUnbindViewport = function () {
            if (pending) view.cancelAnimationFrame(pending);
            view.removeEventListener('resize', remeasure);
            view.removeEventListener('orientationchange', remeasure);
            if (vv) {
                vv.removeEventListener('resize', remeasure);
                vv.removeEventListener('scroll', reflow);
            }
            dockUnbindViewport = null;
        };
    }

    function closePlayer() {
        var doc = global && global.document;
        var dock = doc && doc.getElementById(DOCK_ID);
        if (dockUnbindViewport) dockUnbindViewport();
        if (dock && dock.parentNode) dock.parentNode.removeChild(dock);
    }

    function playerBodyHtml(embed) {
        if (embed.kind === 'youtube') {
            return '<div class="chat-embed-dock-frame"><iframe src="https://www.youtube-nocookie.com/embed/' +
                escapeAttr(embed.id) + '?autoplay=1" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>';
        }
        if (embed.kind === 'vimeo') {
            return '<div class="chat-embed-dock-frame"><iframe src="https://player.vimeo.com/video/' +
                escapeAttr(embed.id) + '?autoplay=1" allow="autoplay; picture-in-picture; fullscreen" allowfullscreen></iframe></div>';
        }
        if (embed.kind === 'video') {
            return '<div class="chat-embed-dock-frame"><video src="' + escapeAttr(embed.url) +
                '" controls autoplay playsinline></video></div>';
        }
        return '<audio src="' + escapeAttr(embed.url) + '" controls autoplay></audio>';
    }

    /* Open (or retarget) the floating dock. Attached to document.body, so it
       survives both transcript re-renders and SPA page swaps. */
    function openPlayer(embed) {
        var doc = global && global.document;
        var dock, resizable, saved, bar, grip, box;
        if (!doc || !embed || !embed.url) return;
        ensureDockStyles(doc);
        closePlayer();
        /* Audio has no picture to enlarge, so it keeps its natural height and
           gets no grip; everything else is a free-form resizable window. */
        resizable = embed.kind !== 'audio';
        dock = doc.createElement('div');
        dock.id = DOCK_ID;
        dock.setAttribute('data-resizable', resizable ? '1' : '0');
        dock.innerHTML = '<div class="chat-embed-dock-bar">' +
            '<span class="chat-embed-dock-title">' + escapeHtml(embed.title || embed.url) + '</span>' +
            '<button type="button" class="chat-embed-dock-close" title="Close player">&times;</button>' +
            '</div>' +
            '<div class="chat-embed-dock-body">' + playerBodyHtml(embed) + '</div>' +
            (resizable ? '<div class="chat-embed-dock-grip" title="Drag to resize"></div>' : '');
        dock.querySelector('.chat-embed-dock-close').addEventListener('click', closePlayer);
        doc.body.appendChild(dock);

        saved = loadDockBox();
        box = { left: 0, top: 0, width: DOCK_DEFAULT_WIDTH, height: 0 };
        if (saved) {
            box.left = saved.left;
            box.top = saved.top;
            box.width = saved.width;
            box.height = saved.height;
        } else {
            /* First open: aim past the bottom-right corner and let placeDock
               pull it back to the margin. */
            box.left = doc.defaultView.innerWidth;
            box.top = doc.defaultView.innerHeight;
        }
        if (resizable && !box.height) {
            bar = dock.querySelector('.chat-embed-dock-bar');
            grip = dock.querySelector('.chat-embed-dock-grip');
            /* 16:9 body, plus the title bar, the resize rail and the dock's
               own 1px borders. */
            box.height = Math.round(box.width * DOCK_BODY_RATIO) +
                (bar ? bar.offsetHeight : 28) + (grip ? grip.offsetHeight : 17) + 2;
        }
        placeDock(dock, box);
        bindDockGestures(dock);
        bindDockViewport(dock);
    }

    /* Delegated click handling for the poster cards under `container`. */
    function init(container) {
        if (!container || container.dataset && container.dataset.chatEmbedsBound === '1') return;
        if (container.dataset) container.dataset.chatEmbedsBound = '1';
        container.addEventListener('click', function (event) {
            var button = event.target && event.target.closest ? event.target.closest('[data-chat-embed-play]') : null;
            var card = button && button.closest('[data-chat-embed-kind]');
            if (!card) return;
            event.preventDefault();
            openPlayer({
                kind: card.getAttribute('data-chat-embed-kind') || '',
                url: card.getAttribute('data-chat-embed-url') || '',
                id: card.getAttribute('data-chat-embed-id') || '',
                title: card.getAttribute('data-chat-embed-title') || ''
            });
        });
    }

    return {
        escapeHtml: escapeHtml,
        hasPipeCodes: hasPipeCodes,
        stripPipeCodes: stripPipeCodes,
        parsePipeSegments: parsePipeSegments,
        colorizePipeLabel: colorizePipeLabel,
        linkify: linkify,
        isNsfwText: isNsfwText,
        extractUrls: extractUrls,
        trimUrl: trimUrl,
        urlHost: urlHost,
        urlFilename: urlFilename,
        youtubeId: youtubeId,
        vimeoId: vimeoId,
        classifyUrl: classifyUrl,
        collectEmbeds: collectEmbeds,
        mediaFile: mediaFile,
        renderMediaCardHtml: renderMediaCardHtml,
        renderImageCardHtml: renderImageCardHtml,
        renderAnsiCardHtml: renderAnsiCardHtml,
        renderExpiredHtml: renderExpiredHtml,
        renderLinkPreviewHtml: renderLinkPreviewHtml,
        renderRichHtml: renderRichHtml,
        colorizeRuns: colorizeRuns,
        hydrate: hydrate,
        init: init,
        openPlayer: openPlayer,
        closePlayer: closePlayer
    };
}));
