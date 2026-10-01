/* tdf-heading.js - TheDraw-font (TDF) headings that stay real text.
 *
 * tdf_heading(text, opts) returns HTML for a heading whose visible face is
 * TDF art but whose text content is the plain string, so search engines and
 * screen readers read "futureland.today", not a picture. The art is a
 * cell grid (CP437 char + attr pairs, base64) that js/tdf-heading.js draws
 * with GraphicsConverter; css/tdf-heading.css scales it to the container.
 *
 * Characters the font lacks are reserved as blank cells and overlaid with
 * the same character in a regular system font, sized to the font height.
 *
 * opts:
 *   tag     element name (default 'h1')
 *   font    'random' (default), 'name', or 'name:index' for multi-font files
 *   id      id attribute
 *   cls     extra class names
 *   max_h   CSS length capping the art height (default per heading level)
 *   max_w   CSS length capping the art width (default per heading level)
 *   align   'left' (default), 'center' or 'right'
 *   color   '#rrggbb' (or a CGA index 0-15): recolor the art toward it, see
 *           _tdfRecolor
 */

var _tdf_scope = null;

function _tdfLib() {
    if (_tdf_scope === null) {
        _tdf_scope = { opt: {} };
        load(_tdf_scope, 'tdfonts_lib.js');
    }
    return _tdf_scope;
}

var _TDF_CGA = ['#000000', '#0000AA', '#00AA00', '#00AAAA', '#AA0000', '#AA00AA', '#AA5500', '#AAAAAA',
    '#555555', '#5555FF', '#55FF55', '#55FFFF', '#FF5555', '#FF55FF', '#FFFF55', '#FFFFFF'];

/* Random picks to try per request; the one missing the fewest of the
   text's characters wins. Picks whose art comes out wider than
   _TDF_MAX_ASPECT (pixel width / height) are skipped so a random heading
   keeps a similar footprint whatever the font height. */
var _TDF_RANDOM_TRIES = 24;
var _TDF_MAX_ASPECT = 10;

function _tdfEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* Many old fonts carry a credit or BBS ad ("Like this font? Call ...") in
   place of a punctuation glyph. Ads read as prose: two vowel-bearing words
   separated by one blank on the same row, or a lone real word. Letter-built
   ASCII art ("888", "Yb boodP", "ooooo") doesn't. Tuned against every font in ctrl/tdfonts. */
function _tdfDistinct(w) {
    var d = {}, n = 0;
    for (var i = 0; i < w.length; i++) {
        var c = w[i].toLowerCase();
        if (!d[c]) { d[c] = true; n++; }
    }
    return n;
}

function _tdfIsAdGlyph(g) {
    for (var y = 0; y < g.height; y++) {
        var line = '';
        for (var x = 0; x < g.width; x++) {
            var cell = g.cell[y * g.width + x];
            line += cell ? cell.utfchar : ' ';
        }
        line = line.replace(/0/g, 'o');
        var re = /([A-Za-z]{2,})[ \xff\x00]([A-Za-z]{2,})/g, m;
        while ((m = re.exec(line)) !== null) {
            if (m[1].length + m[2].length >= 5
                && /[aeiou]/i.test(m[1]) && /[aeiou]/i.test(m[2])
                && _tdfDistinct(m[1]) >= 2 && _tdfDistinct(m[2]) >= 2)
                return true;
            re.lastIndex = m.index + m[1].length + 1;
        }
        /* A lone real word ("period." standing in for '.'): lowercase or
           capitalized, a vowel besides 'o' and no triple letters, which
           keeps round letter-art like "bood" and "oeeeggs" out. */
        var re1 = /(^|[^A-Za-z])([A-Z]?[a-z]{4,})(?=[^A-Za-z]|$)/g, w;
        while ((w = re1.exec(line)) !== null) {
            if (/[aeiu]/i.test(w[2]) && _tdfDistinct(w[2]) >= 3 && !/(.)\1\1/i.test(w[2]))
                return true;
        }
    }
    return false;
}

function _tdfLoadFont(lib, name, index) {
    lib.opt = { index: index || 0 };
    var font;
    try {
        font = lib.loadfont(name);
    } catch (e) {
        return null;
    }
    if (!font || !font.height) return null;
    font.file_label = name + (font.index ? ':' + font.index : '');
    /* Ad glyphs become "missing", so they get the system-font fallback. */
    font.has_ads = false;
    for (var i = 0; i < font.glyphs.length; i++) {
        if (font.glyphs[i] && _tdfIsAdGlyph(font.glyphs[i])) {
            font.glyphs[i] = null;
            font.charlist[i] = 0xffff;
            font.has_ads = true;
        }
    }
    return font;
}

function _tdfMissing(lib, font, text) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
        if (text[i] !== ' ' && lib.lookupchar(text[i], font) === -1) n++;
    }
    return n;
}

function _tdfPickFont(lib, spec, text, shape_text) {
    if (shape_text === undefined) shape_text = text;
    if (spec && spec !== 'random') {
        var parts = String(spec).split(':');
        return _tdfLoadFont(lib, parts[0].replace(/[^a-zA-Z0-9_\-!#]/g, ''), parseInt(parts[1], 10) || 0);
    }
    lib.opt = {};
    var files = lib.getlist();
    var best = null;
    var best_missing = Infinity;
    for (var t = 0; t < _TDF_RANDOM_TRIES && files.length; t++) {
        var name = file_getname(files[random(files.length)]).replace(/\.tdf$/i, '');
        var count = 1;
        try { count = lib.getcount(name); } catch (e) { continue; }
        var font = _tdfLoadFont(lib, name, random(count));
        if (!font || font.has_ads) continue;
        var cols = _tdfLayout(lib, font, shape_text).cols;
        if (cols * 8 > font.height * 16 * _TDF_MAX_ASPECT) continue;
        var missing = _tdfMissing(lib, font, text);
        if (missing < best_missing) {
            best = font;
            best_missing = missing;
            if (missing === 0) break;
        }
    }
    return best;
}

/* Recoloring toward a target color. CGA's chromatic colors form six hue
   families in wheel order, each with a normal and a bright shade:
   red(4,12) brown/yellow(6,14) green(2,10) cyan(3,11) blue(1,9) magenta(5,13).
   The art's dominant family is rotated onto the target's family and every
   other chromatic color rotates with it, keeping each cell's brightness, so
   shading and highlights survive. Where gray outweighs color (block and
   outline fonts are all gray) the grays are tinted too: gray -> target
   normal, white -> target bright, dark gray stays as shadow. A gray target
   desaturates instead. */
var _TDF_FAMILIES = [[4, 12], [6, 14], [2, 10], [3, 11], [1, 9], [5, 13]];

function _tdfFamily(c) {
    for (var f = 0; f < _TDF_FAMILIES.length; f++) {
        if (_TDF_FAMILIES[f][0] === c) return { fam: f, bright: 0 };
        if (_TDF_FAMILIES[f][1] === c) return { fam: f, bright: 1 };
    }
    return null;
}

function _tdfNearestCga(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex));
    if (!m) return -1;
    var r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    var best = -1, bestD = Infinity;
    for (var i = 0; i < 16; i++) {
        var c = parseInt(_TDF_CGA[i].substr(1), 16);
        var dr = r - (c >> 16), dg = g - ((c >> 8) & 255), db = b - (c & 255);
        var d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (d < bestD) { bestD = d; best = i; }
    }
    return best;
}

/* Returns a function mapping a CGA color index to its recolored index. */
function _tdfRecolor(columns, target) {
    var counts = [0, 0, 0, 0, 0, 0];
    var chromatic = 0, grays = 0;
    columns.forEach(function (col) {
        col.forEach(function (pair) {
            if (pair[0] === 32 || pair[0] === 0 || pair[0] === 255) return;
            [pair[1] & 15, (pair[1] >> 4) & 15].forEach(function (c) {
                var f = _tdfFamily(c);
                if (f) { counts[f.fam]++; chromatic++; }
                else if (c === 7 || c === 15) grays++;
            });
        });
    });
    var t = _tdfFamily(target);
    if (!t) {
        /* Gray target: desaturate, keeping light/dark. */
        var dark = target === 0 || target === 8;
        return function (c) {
            var f = _tdfFamily(c);
            if (!f) return c;
            return f.bright ? (dark ? 7 : 15) : (dark ? 8 : 7);
        };
    }
    /* Mostly-gray art (any font whose gray outweighs its color) gets its
       grays tinted too, so the heading reads as the target color rather
       than just having its accents shifted. */
    var tintGray = grays >= chromatic;
    var dom = 0;
    for (var i = 1; i < 6; i++) if (counts[i] > counts[dom]) dom = i;
    var shift = chromatic ? (t.fam - dom + 6) % 6 : 0;
    return function (c) {
        var f = _tdfFamily(c);
        if (f) return _TDF_FAMILIES[(f.fam + shift) % 6][f.bright];
        if (tintGray && c === 7) return _TDF_FAMILIES[t.fam][0];
        if (tintGray && c === 15) return _TDF_FAMILIES[t.fam][1];
        return c;
    };
}

/* Lay the text out as a cells grid: { cols, rows, bin, fallbacks: [{x, w, ch}] } */
function _tdfLayout(lib, font, text, target) {
    var rows = font.height;
    var columns = [];       /* each column: array of rows of [char, attr] */
    var fallbacks = [];
    var widths = 0, glyphs = 0;

    function blankCols(n) {
        for (var b = 0; b < n; b++) {
            var col = [];
            for (var r = 0; r < rows; r++) col.push([32, 7]);
            columns.push(col);
        }
    }

    font.glyphs.forEach(function (g) { if (g) { widths += g.width; glyphs++; } });
    var avg_w = glyphs ? widths / glyphs : rows;

    for (var i = 0; i < text.length; i++) {
        var c = text[i];
        if (c === ' ') {
            blankCols(Math.max(2, Math.round(avg_w * 0.6)));
        } else {
            var idx = lib.lookupchar(c, font);
            if (idx === -1) {
                var fw = Math.max(2, Math.round(rows * 0.9));
                fallbacks.push({ x: columns.length, w: fw, ch: c });
                blankCols(fw);
            } else {
                var g = font.glyphs[idx];
                for (var x = 0; x < g.width; x++) {
                    var col = [];
                    for (var y = 0; y < rows; y++) {
                        var cell = g.cell[y * g.width + x];
                        var ch = cell ? cell.utfchar.charCodeAt(0) : 32;
                        if (!ch || ch !== ch) ch = 32;
                        col.push([ch, cell ? cell.color & 0xff : 7]);
                    }
                    columns.push(col);
                }
            }
        }
        if (i < text.length - 1 && font.spacing) blankCols(font.spacing);
    }

    if (target !== undefined && target >= 0) {
        var map = _tdfRecolor(columns, target);
        columns.forEach(function (col) {
            col.forEach(function (pair) {
                pair[1] = (map((pair[1] >> 4) & 15) << 4) | map(pair[1] & 15);  /* iCE: 4-bit bg */
            });
        });
    }

    var bin = '';
    var fg_count = {};
    for (var row = 0; row < rows; row++) {
        for (var cx = 0; cx < columns.length; cx++) {
            var pair = columns[cx][row];
            bin += String.fromCharCode(pair[0]) + String.fromCharCode(pair[1]);
            if (pair[0] !== 32 && pair[0] !== 0 && pair[0] !== 255) {
                var fg = pair[1] & 15;
                fg_count[fg] = (fg_count[fg] || 0) + 1;
            }
        }
    }
    var main_fg = 7, main_n = -1;
    for (var k in fg_count) {
        if (fg_count[k] > main_n && Number(k) !== 0) { main_fg = Number(k); main_n = fg_count[k]; }
    }
    return { cols: columns.length, rows: rows, bin: bin, fallbacks: fallbacks, color: _TDF_CGA[main_fg] };
}

/* Pick one font for a set of headings (so they all match) and return its
   'name' or 'name:index' label, or '' if none loaded. Character coverage
   is judged on all the texts; the width limit on the first (the title),
   since a long joined string would exceed it in every font. */
function tdf_pick_font(texts) {
    texts = [].concat(texts).map(String);
    var font = _tdfPickFont(_tdfLib(), 'random', texts.join(' '), texts[0] || '');
    return font ? font.file_label : '';
}

function tdf_heading(text, opts) {
    opts = opts || {};
    text = String(text);
    var tag = /^(h[1-6]|div|span|p)$/.test(opts.tag || '') ? opts.tag : 'h1';
    var attrs = ' class="tdf-heading' + (opts.cls ? ' ' + _tdfEsc(opts.cls) : '') + '"';
    if (opts.id) attrs += ' id="' + _tdfEsc(opts.id) + '"';

    var lib = _tdfLib();
    var font = _tdfPickFont(lib, opts.font || 'random', text);
    var target = -1;
    if (typeof opts.color === 'number') target = opts.color;
    else if (opts.color) target = _tdfNearestCga(opts.color);
    var layout = font ? _tdfLayout(lib, font, text, target) : null;
    if (!layout || !layout.cols) {
        /* No usable font: a plain heading is still a correct heading. */
        return '<' + tag + attrs + '>' + _tdfEsc(text) + '</' + tag + '>';
    }

    var style = '--tdf-ar:' + (layout.cols * 8) + ' / ' + (layout.rows * 16) + ';';
    if (opts.max_h) style += '--tdf-max-h:' + _tdfEsc(opts.max_h) + ';';
    if (opts.max_w) style += '--tdf-max-w:' + _tdfEsc(opts.max_w) + ';';
    var justify = { center: 'center', right: 'flex-end' }[opts.align] || 'flex-start';
    style += '--tdf-justify:' + justify + ';';

    var html = '<' + tag + attrs + ' data-tdf-font="' + _tdfEsc(font.file_label) + '">';
    html += '<span class="tdf-text">' + _tdfEsc(text) + '</span>';
    html += '<span class="tdf-art" aria-hidden="true" style="' + style + '">';
    html += '<span class="tdf-art-inner">';
    html += '<span class="tdf-art-cells" data-tdf-cells="' + base64_encode(layout.bin) + '"'
        + ' data-tdf-w="' + layout.cols + '" data-tdf-h="' + layout.rows + '"></span>';
    layout.fallbacks.forEach(function (f) {
        html += '<span class="tdf-fallback" style="left:' + (f.x / layout.cols * 100).toFixed(3) + '%;'
            + 'width:' + (f.w / layout.cols * 100).toFixed(3) + '%;color:' + layout.color + '">'
            + _tdfEsc(f.ch) + '</span>';
    });
    html += '</span></span></' + tag + '>';
    return html;
}

this;
