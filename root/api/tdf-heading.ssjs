// tdf-heading.ssjs - render a batch of TDF headings, one font per level.
// GET ?h=[{"tag":"h1","text":"...","color":"#rrggbb"},...]  (JSON, URL-encoded;
//       color optional: recolors the art toward it; fx/fx_play/fx_click
//       optional: avatar effects, see lib/tdf-heading.js)
//     &font=random|name|name:index        (default random)
//     &fonts={"h1":"name",...}            (optional per-level pins)
//     &variants=N                         (first heading in N random fonts)
// -> { fonts: { h1: "name:index", h2: ... }, html: ["<h1 ...>", ...] }
// Used by pages that build their headings in the browser (the wiki), so
// headings of the same level on one document match.

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
        text: String(h && h.text || '').replace(/\s+/g, ' ').trim().substr(0, MAX_TEXT),
        color: /^#[0-9a-f]{6}$/i.test(String(h && h.color || '')) ? String(h.color) : '',
        fx: /^[a-z0-9-]{1,24}$/.test(String(h && h.fx || '')) ? String(h.fx) : '',
        fx_play: h && h.fx_play === 'loop' ? 'loop' : 'hover',
        fx_click: !(h && h.fx_click === false),
        align: h && (h.align === 'center' || h.align === 'right') ? h.align : 'left'
    };
});

/* One font per heading level: every h1 on the document matches, every h2
   matches, and so on, but each level gets its own random font. */
var fixed = http_request.query.font ? String(http_request.query.font[0]) : 'random';
/* &fonts={"h2":"name:idx"} pins levels the caller already has a font for
   (the wiki editor keeps its preview fonts steady while you type). */
var fonts = {};
try {
    var given = JSON.parse(http_request.query.fonts ? http_request.query.fonts[0] : '{}');
    for (var gt in given) {
        if (/^h[1-6]$/.test(gt) && typeof given[gt] === 'string' && given[gt]) fonts[gt] = given[gt];
    }
} catch (e) { /* ignore */ }
list.forEach(function (h) {
    if (fonts[h.tag] !== undefined) return;
    fonts[h.tag] = fixed !== 'random' ? fixed : tdf.tdf_pick_font(list.filter(function (o) {
        return o.tag === h.tag;
    }).map(function (o) { return o.text; }));
});

/* &variants=N: the first heading rendered in N different random fonts, for
   pages that cycle a heading's font client-side (one request per batch). */
var variants = Math.min(12, Math.max(0, parseInt(http_request.query.variants ? http_request.query.variants[0] : '0', 10) || 0));
if (variants && list.length && list[0].text) {
    var first = list[0], seen = {}, out = [];
    for (var v = 0; v < variants * 2 && out.length < variants; v++) {
        var f = tdf.tdf_pick_font([first.text]);
        if (!f || seen[f]) continue;
        seen[f] = true;
        out.push(tdf.tdf_heading(first.text, { tag: first.tag, font: f, align: first.align }));
    }
    write(JSON.stringify({ html: out }));
    exit();
}

write(JSON.stringify({
    fonts: fonts,
    html: list.map(function (h) {
        return h.text ? tdf.tdf_heading(h.text, {
            tag: h.tag, font: fonts[h.tag] || 'random', color: h.color,
            fx: h.fx || undefined, fx_play: h.fx_play, fx_click: h.fx_click, align: h.align
        }) : '';
    })
}));
