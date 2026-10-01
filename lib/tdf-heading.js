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

function _tdfPickFont(lib, spec, text) {
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
        var cols = _tdfLayout(lib, font, text).cols;
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

/* Lay the text out as a cells grid: { cols, rows, bin, fallbacks: [{x, w, ch}] } */
function _tdfLayout(lib, font, text) {
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

function tdf_heading(text, opts) {
    opts = opts || {};
    text = String(text);
    var tag = /^(h[1-6]|div|span|p)$/.test(opts.tag || '') ? opts.tag : 'h1';
    var attrs = ' class="tdf-heading' + (opts.cls ? ' ' + _tdfEsc(opts.cls) : '') + '"';
    if (opts.id) attrs += ' id="' + _tdfEsc(opts.id) + '"';

    var lib = _tdfLib();
    var font = _tdfPickFont(lib, opts.font || 'random', text);
    var layout = font ? _tdfLayout(lib, font, text) : null;
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
