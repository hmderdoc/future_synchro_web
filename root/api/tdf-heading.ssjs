// tdf-heading.ssjs - render a batch of TDF headings in one shared font.
// GET ?h=[{"tag":"h1","text":"..."},...]  (JSON, URL-encoded)
//     &font=random|name|name:index        (default random)
// -> { font: "name:index", html: ["<h1 ...>", ...] }
// Used by pages that build their headings in the browser (the wiki), so
// every heading on one document matches.

var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
var tdf = load({}, settings.web_lib + 'tdf-heading.js');

var MAX_HEADINGS = 40;
var MAX_TEXT = 80;

http_reply.header['Content-Type'] = 'application/json';
http_reply.header['Cache-Control'] = 'no-store';

var list = [];
try {
    list = JSON.parse(http_request.query.h ? http_request.query.h[0] : '[]');
} catch (e) {
    list = [];
}
if (!Array.isArray(list)) list = [];
list = list.slice(0, MAX_HEADINGS).map(function (h) {
    var tag = String(h && h.tag || 'h2').toLowerCase();
    return {
        tag: /^h[1-6]$/.test(tag) ? tag : 'h2',
        text: String(h && h.text || '').replace(/\s+/g, ' ').trim().substr(0, MAX_TEXT)
    };
});

var font = http_request.query.font ? String(http_request.query.font[0]) : 'random';
if (font === 'random') {
    font = tdf.tdf_pick_font(list.map(function (h) { return h.text; }));
}

write(JSON.stringify({
    font: font,
    html: list.map(function (h) {
        return h.text ? tdf.tdf_heading(h.text, { tag: h.tag, font: font || 'random' }) : '';
    })
}));
