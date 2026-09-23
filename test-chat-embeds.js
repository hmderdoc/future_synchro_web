'use strict';

var assert = require('assert');
var embeds = require('./root/js/chat-embeds.js');

/* ---------------------------------------------------------- classification */

assert.strictEqual(embeds.youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
assert.strictEqual(embeds.youtubeId('https://youtu.be/dQw4w9WgXcQ?t=42'), 'dQw4w9WgXcQ');
assert.strictEqual(embeds.youtubeId('https://www.youtube.com/shorts/abc123XYZ_-'), 'abc123XYZ_-');
assert.strictEqual(embeds.youtubeId('https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x'), 'dQw4w9WgXcQ');
assert.strictEqual(embeds.youtubeId('https://notyoutube.com/watch?v=dQw4w9WgXcQ'), null);
assert.strictEqual(embeds.youtubeId('https://evilyoutube.com/watch?v=dQw4w9WgXcQ'), null);
assert.strictEqual(embeds.vimeoId('https://vimeo.com/76979871'), '76979871');
assert.strictEqual(embeds.vimeoId('https://player.vimeo.com/video/76979871'), '76979871');
assert.strictEqual(embeds.vimeoId('https://vimeo.com/user123'), null);

assert.strictEqual(embeds.classifyUrl('https://x.test/cat.PNG?s=1').kind, 'image');
assert.strictEqual(embeds.classifyUrl('https://x.test/clip.mp4').kind, 'video');
assert.strictEqual(embeds.classifyUrl('https://x.test/song.mp3').kind, 'audio');
assert.strictEqual(embeds.classifyUrl('https://x.test/page').kind, 'link');
assert.strictEqual(embeds.classifyUrl('ftp://x.test/file.png'), null);

/* Trailing punctuation from prose is not part of the URL. */
assert.strictEqual(embeds.trimUrl('https://x.test/a).'), 'https://x.test/a');
assert.strictEqual(embeds.classifyUrl('https://x.test/cat.png,').url, 'https://x.test/cat.png');

/* ------------------------------------------------------------ collection */

var collected = embeds.collectEmbeds(
    'look https://a.test/cat.png and https://www.youtube.com/watch?v=dQw4w9WgXcQ ' +
    'plus https://site.test/article and https://other.test/post');
assert.strictEqual(collected.media.length, 2);
assert.strictEqual(collected.media[0].kind, 'image');
assert.strictEqual(collected.media[1].kind, 'youtube');
assert.strictEqual(collected.media[1].poster, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
/* Only the FIRST plain link becomes the preview candidate. */
assert.strictEqual(collected.previewUrl, 'https://site.test/article');

/* Duplicate URLs render one card. */
var dupes = embeds.collectEmbeds('https://a.test/cat.png https://a.test/cat.png');
assert.strictEqual(dupes.media.length, 1);

/* Media cap. */
var many = embeds.collectEmbeds(
    'https://a.test/1.png https://a.test/2.png https://a.test/3.png https://a.test/4.png');
assert.strictEqual(many.media.length, 3);

/* --------------------------------------------------------------- escaping */

/* Message text is escaped before linkifying. */
var xss = embeds.renderRichHtml('<img onerror=alert(1)> https://x.test/a', {});
assert.ok(xss.indexOf('<img onerror') === -1);
assert.ok(xss.indexOf('&lt;img') !== -1);

/* Attribute injection through a crafted URL stays inert. */
var crafted = embeds.renderMediaCardHtml({
    kind: 'video', url: 'https://x.test/a.mp4?"><script>alert(1)</script>'
});
assert.ok(crafted.indexOf('<script') === -1);

/* Preview data is escaped (server returns raw strings). */
var previewCard = embeds.renderLinkPreviewHtml('https://x.test/a', {
    ok: true,
    data: { title: '<b>Bold</b>', description: 'a & b', siteName: 'X"Y', image: 'https://x.test/i.png' }
});
assert.ok(previewCard.indexOf('<b>') === -1);
assert.ok(previewCard.indexOf('&lt;b&gt;Bold') !== -1);
assert.ok(previewCard.indexOf('a &amp; b') !== -1);
assert.ok(previewCard.indexOf('src="https://x.test/i.png"') !== -1);

/* -------------------------------------------------------- preview states */

/* Unknown entry -> pending skeleton; failed -> no card at all. */
assert.ok(embeds.renderLinkPreviewHtml('https://x.test/a', undefined).indexOf('is-pending') !== -1);
assert.strictEqual(embeds.renderLinkPreviewHtml('https://x.test/a', { ok: false }), '');

/* ------------------------------------------------------------- rich html */

/* Plain text stays a single rich-text div (no wrapper block). */
var plain = embeds.renderRichHtml('hello world', {});
assert.ok(plain.indexOf('chat-rich-block') === -1);
assert.ok(plain.indexOf('hello world') !== -1);

/* Preview cards render only when allowed (guests get plain links). */
var noPreview = embeds.renderRichHtml('see https://site.test/article', {
    allowLinkPreviews: false, getPreviewEntry: function () { return undefined; }
});
assert.ok(noPreview.indexOf('data-chat-link-preview') === -1);
var withPreview = embeds.renderRichHtml('see https://site.test/article', {
    allowLinkPreviews: true, getPreviewEntry: function () { return undefined; }
});
assert.ok(withPreview.indexOf('data-chat-link-preview="https://site.test/article"') !== -1);

/* Image URLs reuse the existing image-card markup (CSS + error fallback). */
var imageHtml = embeds.renderRichHtml('https://a.test/cat.png', {});
assert.ok(imageHtml.indexOf('chat-rich-image-card') !== -1);
assert.ok(imageHtml.indexOf('chat-rich-image-preview') !== -1);

console.log('chat-embeds: all tests passed');

/* ------------------------------------------------------ pipe colour codes */

/* The message that prompted this (guest9, Mystic 1.12): a background code. */
var guest9 = "_ Bon Jour /rainbow [FR +33] |22 bonza, G'Day AUS NZ";
assert.strictEqual(embeds.hasPipeCodes(guest9), true);
assert.strictEqual(embeds.stripPipeCodes(guest9), "_ Bon Jour /rainbow [FR +33]  bonza, G'Day AUS NZ");
var guest9Html = embeds.renderRichHtml(guest9);
assert.ok(guest9Html.indexOf('|22') === -1, 'code must not show');
assert.ok(guest9Html.indexOf('background-color:#AA5500') !== -1, '|22 is a brown background');
assert.ok(guest9Html.indexOf('G&#39;Day') !== -1, 'text is still escaped');

assert.deepStrictEqual(embeds.parsePipeSegments('|12red |10green|07 plain'), [
    { text: 'red ', fg: 12, bg: -1 }, { text: 'green', fg: 10, bg: -1 }, { text: ' plain', fg: 7, bg: -1 }]);
/* |16 (black) ends a highlight instead of painting black on black. */
assert.deepStrictEqual(embeds.parsePipeSegments('a|20b|16c'), [
    { text: 'a', fg: -1, bg: -1 }, { text: 'b', fg: -1, bg: 4 }, { text: 'c', fg: -1, bg: -1 }]);
/* |00 black text is lifted so it stays readable on the black page. */
assert.ok(embeds.linkify('|00shadow').indexOf('color:#555555') !== -1);

/* Non-codes and our control markers are untouched; plain text takes the old path byte-for-byte. */
assert.strictEqual(embeds.hasPipeCodes('time:<30m|1h|2d> a|b |24 |9 |XY'), false);
assert.strictEqual(embeds.hasPipeCodes('[BITMAP|80|237|krueger|789ced]'), false);
assert.strictEqual(embeds.stripPipeCodes('[BITMAP|80|237|krueger|789ced]'), '[BITMAP|80|237|krueger|789ced]');
assert.strictEqual(embeds.renderRichHtml('hello world'), '<div class="chat-rich-text">hello world</div>');

/* Nothing a sender types reaches the style attribute or escapes the span. */
var hostile = embeds.linkify('|12<img src=x onerror=alert(1)>"\';color:red|10x');
assert.ok(hostile.indexOf('<img') === -1);
assert.ok(hostile.indexOf('&lt;img') !== -1);
assert.strictEqual((hostile.match(/style="/g) || []).length, 2);
assert.ok(/style="color:#FF5555;"/.test(hostile));

/* A code glued to a URL still yields a working link and its embed card. */
var glued = embeds.renderRichHtml('|11https://a.test/cat.png');
assert.ok(glued.indexOf('href="https://a.test/cat.png"') !== -1);
assert.strictEqual(embeds.collectEmbeds(embeds.stripPipeCodes('|11https://a.test/cat.png')).media.length, 1);

console.log('pipe colour tests ok');

/* ---- colour runs (bridged DDial ANSI) ---- */
assert.strictEqual(
    embeds.colorizeRuns('Jonny', [{ n: 3, c: '#ff8700' }, { n: 2, c: '#55ffff' }]),
    '<span class="chat-pipe-color" style="color:#ff8700;">Jon</span><span class="chat-pipe-color" style="color:#55ffff;">ny</span>');
/* Uncoloured runs stay bare; black is lifted off the black page. */
assert.strictEqual(
    embeds.colorizeRuns('ab', [{ n: 1, c: '' }, { n: 1, c: '#000000' }]),
    'a<span class="chat-pipe-color" style="color:#555555;">b</span>');
/* Runs that do not cover the text, or carry a non-hex colour, are refused. */
assert.strictEqual(embeds.colorizeRuns('abc', [{ n: 2, c: '#ffffff' }]), null);
assert.strictEqual(embeds.colorizeRuns('ab', [{ n: 2, c: 'red;background:url(x)' }]), null);
assert.strictEqual(embeds.colorizeRuns('ab', [{ n: 2, c: '#fff"onmouseover="x' }]), null);
/* Text inside a run is still escaped, and a refused overlay falls back to plain rendering. */
assert.ok(embeds.colorizeRuns('<b>', [{ n: 3, c: '#ffffff' }]).indexOf('&lt;b&gt;') !== -1);
assert.strictEqual(
    embeds.renderRichHtml('hi there', { colorRuns: [{ n: 3, c: '' }, { n: 5, c: '#00aa00' }] }),
    '<div class="chat-rich-text">hi <span class="chat-pipe-color" style="color:#00aa00;">there</span></div>');
assert.strictEqual(embeds.renderRichHtml('hi', { colorRuns: [{ n: 9, c: '#00aa00' }] }), '<div class="chat-rich-text">hi</div>');

console.log('colour run tests ok');

/* ------------------------------------------- chat attachments (uploads) */

var MEDIA = 'https://futureland.today/chatmedia/2026-09-23/0123456789abcdef01234567';

/* Uploaded media still classifies on extension, so images/audio/video reuse
   the existing cards untouched. */
assert.strictEqual(embeds.classifyUrl(MEDIA + '.png').kind, 'image');
assert.strictEqual(embeds.classifyUrl(MEDIA + '.mp4').kind, 'video');
assert.strictEqual(embeds.classifyUrl(MEDIA + '.mp3').kind, 'audio');

/* ANSI gets a card ONLY for our own uploads — the render endpoint reads the
   file off local disk, so an arbitrary .ans URL must stay a plain link. */
assert.strictEqual(embeds.classifyUrl(MEDIA + '.ans').kind, 'ansi');
assert.strictEqual(embeds.classifyUrl(MEDIA + '.asc').kind, 'ansi');
assert.strictEqual(embeds.classifyUrl('https://evil.test/payload.ans').kind, 'link');
/* The host is deliberately NOT part of the match: the same upload is reachable
   as futureland.today and www.futureland.today, and pinning the origin would
   break the card for half the users. Safe because the card renders OUR file of
   that name (or the expired placeholder), never anything fetched from the host
   in the URL, and a 96-bit id is not guessable. */
assert.strictEqual(embeds.classifyUrl('https://evil.test/chatmedia/2026-09-23/0123456789abcdef01234567.ans').kind, 'ansi');

/* mediaFile() is what the expiry and ANSI hydration key off. */
assert.strictEqual(embeds.mediaFile(MEDIA + '.png'), '2026-09-23/0123456789abcdef01234567.png');
assert.strictEqual(embeds.mediaFile('https://x.test/cat.png'), '');
/* Names we never generate are not treated as attachments. */
assert.strictEqual(embeds.mediaFile('https://x.test/chatmedia/2026-09-23/short.png'), '');
assert.strictEqual(embeds.mediaFile('https://x.test/chatmedia/not-a-date/0123456789abcdef01234567.png'), '');

/* Cards carry the attachment id so a purged file can be swapped for the
   expired placeholder without re-parsing the message. */
assert.ok(embeds.renderImageCardHtml({ kind: 'image', url: MEDIA + '.png' })
    .indexOf('data-chat-media="2026-09-23/0123456789abcdef01234567.png"') !== -1);
assert.ok(embeds.renderMediaCardHtml({ kind: 'video', url: MEDIA + '.mp4' })
    .indexOf('data-chat-media="2026-09-23/0123456789abcdef01234567.mp4"') !== -1);
/* Third-party media is not an attachment and gets no marker. */
assert.ok(embeds.renderImageCardHtml({ kind: 'image', url: 'https://x.test/cat.png' })
    .indexOf('data-chat-media') === -1);

/* The ANSI card is a placeholder until hydrate() fills it from the server. */
var ansiCard = embeds.renderAnsiCardHtml({ kind: 'ansi', url: MEDIA + '.ans' });
assert.ok(ansiCard.indexOf('data-chat-ansi="2026-09-23/0123456789abcdef01234567.ans"') !== -1);
assert.ok(ansiCard.indexOf('Loading ANSI') !== -1);

/* An ANSI upload inside a sentence renders as a card, not a bare link. */
assert.ok(embeds.renderRichHtml('check this ' + MEDIA + '.ans').indexOf('chat-rich-ansi-card') !== -1);

/* The expired placeholder escapes whatever label it is handed. */
assert.ok(embeds.renderExpiredHtml('<img onerror=x>').indexOf('&lt;img onerror=x&gt;') !== -1);
assert.ok(embeds.renderExpiredHtml().indexOf('kept for one week') !== -1);

console.log('chat attachment tests ok');
