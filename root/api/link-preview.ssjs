/* link-preview.ssjs - OpenGraph link previews for web chat embeds.
 *
 *   GET ?url=https://example.com/article
 *     -> { url, finalUrl, kind, title, description, image, siteName }
 *     -> { error: '...' } when the target is unfetchable/unparseable
 *
 * Auth required (guests get plain links in chat instead): the fetcher makes
 * the BBS issue outbound HTTP requests, so it is not exposed anonymously.
 * All SSRF guarding, redirect vetting and disk caching live in
 * lib/link-preview.js.
 */

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
load('http.js');
var request = require({}, settings.web_lib + 'request.js', 'request');
var linkPreview = require({}, settings.web_lib + 'link-preview.js', 'linkPreview');

/* Metadata strings are UTF-8 bytes; say so explicitly. */
http_reply.header['Content-Type'] = 'application/json; charset=utf-8';

function replyJson(payload) {
    write(JSON.stringify(payload));
}

if (user.number < 1 || user.alias === settings.guest) {
    replyJson({ error: 'authentication required' });
} else if (!request.has_param('url')) {
    replyJson({ error: 'missing url' });
} else {
    /* Successful lookups are stable; let the browser keep them for a while. */
    http_reply.header['Cache-Control'] = 'private, max-age=3600';
    replyJson(linkPreview.getPreview(String(request.get_param('url')), {
        cacheDir: settings.web_root + 'api/data/link-previews/'
    }));
}
