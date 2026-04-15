// figlet.ssjs — Render text using TDF FIGlet fonts for the ASCII visualizer
// Returns JSON: { height, width, fontName, rows: [{chars,colors}], charBounds }
// Query: ?text=HELLO&font=brndamgx    (specific font)
//        ?text=HELLO&height=7          (random font at height 7)

load('sbbsdefs.js');
var settings = load('modopts.js', 'web') || { web_directory: '../webv4' };
load(settings.web_directory + '/lib/init.js');
load(settings.web_lib + 'auth.js');

var tdf = load({}, 'tdfonts_lib.js');
tdf.opt = { ansi: false, utf8: true, width: 400 };

http_reply.header['Content-Type'] = 'application/json';
http_reply.header['Cache-Control'] = 'public, max-age=3600';

var qs = http_request.query;
var text = String(qs.text || '').toUpperCase().replace(/[^\x20-\x7E]/g, '').substring(0, 40);
var fontName = String(qs.font || '').replace(/[^a-zA-Z0-9_\-!#]/g, '');
var requestedHeight = parseInt(qs.height) || 0;

if (!text) {
    write(JSON.stringify({ error: 'missing text param' }));
    exit();
}

// If height requested (no specific font), pick random font at that height
if (!fontName && requestedHeight > 0) {
    try {
        var mapFile = new File(system.data_dir + 'figlet_font_map.json');
        if (mapFile.open('r')) {
            var fontMap = JSON.parse(mapFile.read());
            mapFile.close();
            var pool = fontMap[String(requestedHeight)];
            if (pool && pool.length) {
                fontName = pool[Math.floor(Math.random() * pool.length)];
            }
        }
    } catch (e) {
        // Fall through to default
    }
}

if (!fontName) fontName = 'brndamgx';

try {
    var font = tdf.loadfont(fontName);
    if (typeof font === 'string') throw new Error(font);

    var height = font.height;
    var rows = [];

    for (var row = 0; row < height; row++) {
        var chars = '';
        var colors = [];

        for (var ci = 0; ci < text.length; ci++) {
            var charIdx = tdf.lookupchar(text[ci], font);
            if (charIdx === -1) {
                chars += ' ';
                colors.push(7);
                if (ci < text.length - 1) {
                    for (var s = 0; s < font.spacing; s++) {
                        chars += ' ';
                        colors.push(0);
                    }
                }
                continue;
            }
            var g = font.glyphs[charIdx];
            for (var col = 0; col < g.width; col++) {
                var cellIdx = g.width * row + col;
                if (cellIdx < g.cell.length) {
                    var cell = g.cell[cellIdx];
                    chars += cell.utfchar;
                    colors.push(cell.color);
                } else {
                    chars += ' ';
                    colors.push(0);
                }
            }
            if (ci < text.length - 1) {
                for (var s = 0; s < font.spacing; s++) {
                    chars += ' ';
                    colors.push(0);
                }
            }
        }
        rows.push({ chars: chars, colors: colors });
    }

    var charBounds = [];
    var cx = 0;
    for (var ci = 0; ci < text.length; ci++) {
        var charIdx = tdf.lookupchar(text[ci], font);
        var w = 1;
        if (charIdx !== -1 && font.glyphs[charIdx]) {
            w = font.glyphs[charIdx].width;
        }
        charBounds.push({ start: cx, width: w, ch: text[ci] });
        cx += w;
        if (ci < text.length - 1) cx += font.spacing;
    }

    write(JSON.stringify({
        height: height,
        width: rows.length ? rows[0].chars.length : 0,
        fontName: font.name || fontName,
        fontType: font.fonttype,
        spacing: font.spacing,
        rows: rows,
        charBounds: charBounds
    }));
} catch (e) {
    write(JSON.stringify({ error: String(e), fontName: fontName }));
}
