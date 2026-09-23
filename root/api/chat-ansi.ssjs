/* chat-ansi.ssjs — render an uploaded ANSI attachment for a chat embed.
 *
 * Browsers have no CP437/ANSI renderer, so the art is converted to HTML here
 * with the same Graphic-based path the gallery uses (lib/ansi-viewer.js), and
 * the embed card injects the result.
 *
 * The `file` parameter is matched against the exact shape chat-upload.ssjs
 * generates — date folder plus a 24-hex id — so this can never be walked out of
 * the chat media directory and into the rest of the web root.
 */
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };

load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');
var request = require({}, settings.web_lib + 'request.js', 'request');
var ansi_viewer = load({}, settings.web_lib + 'ansi-viewer.js');

var MEDIA_DIR = backslash(settings.web_root) + 'chatmedia/';
var SAFE_FILE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}\/[a-f0-9]{24}\.(ans|asc)$/;

http_reply.header['Content-Type'] = 'application/json; charset=utf-8';
http_reply.header['Cache-Control'] = 'no-store';

var name = request.has_param('file') ? String(request.get_param('file')) : '';

if (!SAFE_FILE.test(name)) {
    write(JSON.stringify({ ok: false, error: 'bad file' }));
    exit();
}

var path = MEDIA_DIR + name;

/* Attachments are purged after a week, so a missing file is the expected
   end state rather than an error — the card says so instead of breaking. */
if (!file_exists(path)) {
    write(JSON.stringify({ ok: false, expired: true }));
    exit();
}

var rendered = ansi_viewer.render_file_html(path);

write(JSON.stringify({
    ok: !!rendered.ok,
    html: rendered.ok ? rendered.html : '',
    error: rendered.ok ? '' : (rendered.message || 'render failed')
}));
