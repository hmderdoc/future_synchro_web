/* tdf-browser.js — Client-side TDF (TheDraw Font) parser & renderer
 *
 * Ported from Synchronet's exec/load/tdfonts_lib.js for zero-latency
 * FIGlet rendering in the ASCII strobe visualizer.
 *
 * On load: creates window.tdfBrowser and begins fetching the font map
 * + a POOL of random fonts per tier height.  Fonts are parsed in the
 * browser using ArrayBuffer; rendering is fully synchronous after init.
 *
 * API:
 *   tdfBrowser.isReady()              — true after initial fonts loaded
 *   tdfBrowser.render(text, height)   — returns {rows,charBounds,...} or null
 *                                       (picks random font from pool)
 *   tdfBrowser.poolSize(height)       — number of loaded fonts at a height
 */
(function (window) {
    'use strict';

    /* ── CP437 → Unicode lookup (256 entries) ──────────────────────── */
    var CP437 = [];
    // 0x00–0x1F: control-code symbols
    var lo = '\u0000\u263A\u263B\u2665\u2666\u2663\u2660\u2022' +
             '\u25D8\u25CB\u25D9\u2642\u2640\u266A\u266B\u263C' +
             '\u25BA\u25C4\u2195\u203C\u00B6\u00A7\u25AC\u21A8' +
             '\u2191\u2193\u2192\u2190\u221F\u2194\u25B2\u25BC';
    for (var i = 0; i < 32; i++) CP437[i] = lo.charAt(i);
    // 0x20–0x7E: printable ASCII (identity map)
    for (var i = 0x20; i <= 0x7E; i++) CP437[i] = String.fromCharCode(i);
    CP437[0x7F] = '\u2302';
    // 0x80–0xFF: extended Latin, box drawing, Greek, math
    var hi = '\u00C7\u00FC\u00E9\u00E2\u00E4\u00E0\u00E5\u00E7' +
             '\u00EA\u00EB\u00E8\u00EF\u00EE\u00EC\u00C4\u00C5' +
             '\u00C9\u00E6\u00C6\u00F4\u00F6\u00F2\u00FB\u00F9' +
             '\u00FF\u00D6\u00DC\u00A2\u00A3\u00A5\u20A7\u0192' +
             '\u00E1\u00ED\u00F3\u00FA\u00F1\u00D1\u00AA\u00BA' +
             '\u00BF\u2310\u00AC\u00BD\u00BC\u00A1\u00AB\u00BB' +
             '\u2591\u2592\u2593\u2502\u2524\u2561\u2562\u2556' +
             '\u2555\u2563\u2551\u2557\u255D\u255C\u255B\u2510' +
             '\u2514\u2534\u252C\u251C\u2500\u253C\u255E\u255F' +
             '\u255A\u2554\u2569\u2566\u2560\u2550\u256C\u2567' +
             '\u2568\u2564\u2565\u2559\u2558\u2552\u2553\u256B' +
             '\u256A\u2518\u250C\u2588\u2584\u258C\u2590\u2580' +
             '\u03B1\u00DF\u0393\u03C0\u03A3\u03C3\u00B5\u03C4' +
             '\u03A6\u0398\u03A9\u03B4\u221E\u03C6\u03B5\u2229' +
             '\u2261\u00B1\u2265\u2264\u2320\u2321\u00F7\u2248' +
             '\u00B0\u2219\u00B7\u221A\u207F\u00B2\u25A0\u00A0';
    for (var i = 0; i < 128; i++) CP437[0x80 + i] = hi.charAt(i);


    /* ── IndexedDB font cache ──────────────────────────────────────── */
    var IDB_NAME    = 'tdf-font-cache';
    var IDB_VERSION = 1;
    var IDB_STORE   = 'fonts';
    var _idb        = null;   // will hold IDBDatabase once opened

    function _openIDB() {
        return new Promise(function (resolve, reject) {
            if (_idb) { resolve(_idb); return; }
            try {
                var req = indexedDB.open(IDB_NAME, IDB_VERSION);
                req.onupgradeneeded = function (e) {
                    var db = e.target.result;
                    if (!db.objectStoreNames.contains(IDB_STORE))
                        db.createObjectStore(IDB_STORE);
                };
                req.onsuccess = function (e) {
                    _idb = e.target.result;
                    resolve(_idb);
                };
                req.onerror = function () { resolve(null); };
            } catch (err) { resolve(null); }
        });
    }

    function _idbGet(key) {
        return _openIDB().then(function (db) {
            if (!db) return null;
            return new Promise(function (resolve) {
                try {
                    var tx  = db.transaction(IDB_STORE, 'readonly');
                    var st  = tx.objectStore(IDB_STORE);
                    var req = st.get(key);
                    req.onsuccess = function () { resolve(req.result || null); };
                    req.onerror   = function () { resolve(null); };
                } catch (e) { resolve(null); }
            });
        });
    }

    function _idbPut(key, value) {
        return _openIDB().then(function (db) {
            if (!db) return;
            try {
                var tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put(value, key);
            } catch (e) { /* silent */ }
        });
    }

    /* Bulk-read all cached fonts in one transaction */
    function _idbGetAll() {
        return _openIDB().then(function (db) {
            if (!db) return {};
            return new Promise(function (resolve) {
                try {
                    var tx   = db.transaction(IDB_STORE, 'readonly');
                    var st   = tx.objectStore(IDB_STORE);
                    var all  = {};
                    var req  = st.openCursor();
                    req.onsuccess = function (e) {
                        var cursor = e.target.result;
                        if (cursor) {
                            all[cursor.key] = cursor.value;
                            cursor.continue();
                        } else {
                            resolve(all);
                        }
                    };
                    req.onerror = function () { resolve({}); };
                } catch (e) { resolve({}); }
            });
        });
    }


    /* ── Constants ─────────────────────────────────────────────────── */
    var NUM_CHARS    = 94;
    var CHARLIST     = '!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
    var COLOR_FNT    = 2;
    var OUTLN_FNT    = 0;
    var LIGHTGRAY    = 7;
    var MAGIC        = [0x13,0x54,0x68,0x65,0x44,0x72,0x61,0x77,0x20,
                        0x46,0x4F,0x4E,0x54,0x53,0x20,0x66,0x69,0x6C,0x65,0x1A];
    var INIT_POOL    = 3;      // fonts per tier loaded before isReady
    var MAX_POOL     = Infinity; // no cap — cache every available font
    var BG_DELAY     = 120;    // ms between background font fetches

    /* Outline font char substitution map (from TDF spec) */
    var OL = {};
    OL[65]=205; OL[66]=196; OL[67]=179; OL[68]=186;
    OL[69]=213; OL[70]=187; OL[71]=214; OL[72]=191;
    OL[73]=200; OL[74]=190; OL[75]=192; OL[76]=189;
    OL[77]=181; OL[78]=199; OL[79]=32;  OL[64]=32; OL[38]=38;

    /* ── TdfBrowser constructor ────────────────────────────────────── */
    function TdfBrowser() {
        this._fontMap    = null;   // { "3": ["adrknesx",...], "4": [...], ... }
        this._fonts      = {};     // fontName → parsed font object
        this._loading    = {};     // fontName → Promise
        this._tierPool   = {};     // height (int) → [fontName, fontName, ...]
        this._tierLoaded = {};     // height (int) → Set of loaded fontNames
        this._ready      = false;
        this._serveUrl   = './api/tdf-serve.ssjs';
    }

    /* ── Binary TDF parser ─────────────────────────────────────────── */

    TdfBrowser.prototype.parseFont = function (buf) {
        var d = new Uint8Array(buf);
        if (d.length < 233) throw new Error('TDF too small (' + d.length + ')');
        for (var i = 0; i < MAGIC.length; i++) {
            if (d[i] !== MAGIC[i]) throw new Error('Bad TDF magic');
        }

        var font       = {};
        font.namelen   = d[24];
        font.name      = '';
        for (var i = 0; i < font.namelen && i < 16; i++)
            font.name += String.fromCharCode(d[25 + i]);
        font.fonttype  = d[41];
        font.spacing   = d[42];
        font.blocksize = d[43] | (d[44] << 8);

        font.charlist  = new Uint16Array(NUM_CHARS);
        for (var i = 0; i < NUM_CHARS; i++) {
            var o = 45 + i * 2;
            font.charlist[i] = d[o] | (d[o + 1] << 8);
        }

        font._d     = d.subarray(233);   // raw glyph data
        font.height  = 0;

        // Determine max glyph height
        for (var i = 0; i < NUM_CHARS; i++) {
            var off = font.charlist[i];
            if (off !== 0xFFFF && off + 1 < font._d.length) {
                var gh = font._d[off + 1];
                if (gh > font.height) font.height = gh;
            }
        }

        // Parse all glyphs
        font.glyphs = new Array(NUM_CHARS);
        for (var i = 0; i < NUM_CHARS; i++) {
            font.glyphs[i] = (font.charlist[i] !== 0xFFFF)
                ? this._glyph(i, font) : null;
        }

        return font;
    };

    TdfBrowser.prototype._glyph = function (idx, font) {
        var d   = font._d;
        var off = font.charlist[idx];
        if (off + 1 >= d.length) return null;

        var g   = { width: d[off], height: d[off + 1], cell: null };
        var p   = off + 2;
        var sz  = g.width * font.height;
        g.cell  = new Array(sz);
        for (var j = 0; j < sz; j++) g.cell[j] = { ch: ' ', color: 0 };

        var row = 0, col = 0;
        while (p < d.length && d[p] !== 0x00) {
            var ch = d[p++];
            if (ch === 0x0D) { row++; col = 0; continue; }
            if (p >= d.length) break;
            var color = (font.fonttype === COLOR_FNT) ? d[p++] : LIGHTGRAY;
            if (ch < 0x20) ch = 0x20;
            var ci = row * g.width + col;
            if (ci < sz) {
                var fc = (font.fonttype === OUTLN_FNT && OL[ch] !== undefined) ? OL[ch] : ch;
                g.cell[ci] = { ch: CP437[fc] || '?', color: color };
                col++;
            }
        }

        return g;
    };

    /* ── Character lookup (with uppercase fallback) ────────────────── */

    TdfBrowser.prototype._lookup = function (c, font) {
        var code = c.charCodeAt(0);
        for (var i = 0; i < NUM_CHARS; i++) {
            if (CHARLIST.charCodeAt(i) === code)
                return (font.charlist[i] !== 0xFFFF) ? i : -1;
        }
        var up = c.toUpperCase().charCodeAt(0);
        if (up !== code) {
            for (var i = 0; i < NUM_CHARS; i++) {
                if (CHARLIST.charCodeAt(i) === up)
                    return (font.charlist[i] !== 0xFFFF) ? i : -1;
            }
        }
        return -1;
    };

    /* ── Render text → { height, width, fontName, rows[], charBounds[] } ── */
    /* Picks a RANDOM font from the loaded pool at this height.              */

    TdfBrowser.prototype.render = function (text, height) {
        var pool = this._tierPool[height];
        if (!pool || !pool.length) return null;
        var fontName = pool[Math.floor(Math.random() * pool.length)];
        var font = this._fonts[fontName];
        if (!font) return null;
        return this._renderWith(text, font);
    };

    /* Pick a random font NAME from the pool at a given height.
     * Returns the font name string (not the font object).
     * Caller stores this on the particle so the same font persists. */
    TdfBrowser.prototype.pickFontName = function (height) {
        var pool = this._tierPool[height];
        if (!pool || !pool.length) return null;
        return pool[Math.floor(Math.random() * pool.length)];
    };

    /* Render text using a specific named font (no random pick).
     * Returns the same {rows, charBounds, ...} structure as render(). */
    TdfBrowser.prototype.renderWithFont = function (text, fontName) {
        var font = this._fonts[fontName];
        if (!font) return null;
        return this._renderWith(text, font);
    };

    TdfBrowser.prototype._renderWith = function (text, font) {
        var h    = font.height;
        var rows = [];

        for (var r = 0; r < h; r++) {
            var chars  = '';
            var colors = [];
            for (var ci = 0; ci < text.length; ci++) {
                var gi = this._lookup(text[ci], font);
                if (gi === -1) {
                    chars += ' '; colors.push(7);
                    if (ci < text.length - 1)
                        for (var s = 0; s < font.spacing; s++) { chars += ' '; colors.push(0); }
                    continue;
                }
                var g = font.glyphs[gi];
                for (var col = 0; col < g.width; col++) {
                    var cell = g.cell[g.width * r + col];
                    if (cell) { chars += cell.ch; colors.push(cell.color); }
                    else      { chars += ' ';     colors.push(0); }
                }
                if (ci < text.length - 1)
                    for (var s = 0; s < font.spacing; s++) { chars += ' '; colors.push(0); }
            }
            rows.push({ chars: chars, colors: colors });
        }

        var charBounds = [], cx = 0;
        for (var ci = 0; ci < text.length; ci++) {
            var gi = this._lookup(text[ci], font);
            var w  = 1;
            if (gi !== -1 && font.glyphs[gi]) w = font.glyphs[gi].width;
            charBounds.push({ start: cx, width: w, ch: text[ci] });
            cx += w;
            if (ci < text.length - 1) cx += font.spacing;
        }

        return {
            height: h,
            width: rows.length ? rows[0].chars.length : 0,
            fontName: font.name,
            fontType: font.fonttype,
            spacing: font.spacing,
            rows: rows,
            charBounds: charBounds
        };
    };

    /* ── Font loading ──────────────────────────────────────────────── */

    TdfBrowser.prototype._parseB64 = function (b64) {
        var bin = atob(b64);
        var buf = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        return this.parseFont(buf.buffer);
    };

    TdfBrowser.prototype._fetchFont = function (name) {
        if (this._fonts[name]) return Promise.resolve(this._fonts[name]);
        if (this._loading[name]) return this._loading[name];
        var self = this;
        var p = _idbGet(name).then(function (cached) {
            if (cached) {
                // Parse from cached b64 — no network needed
                var font = self._parseB64(cached);
                self._fonts[name] = font;
                delete self._loading[name];
                return font;
            }
            // Cache miss — fetch from server
            return fetch(self._serveUrl + '?font=' + encodeURIComponent(name))
                .then(function (r) {
                    if (!r.ok) throw new Error('HTTP ' + r.status);
                    return r.json();
                })
                .then(function (json) {
                    var font = self._parseB64(json.b64);
                    self._fonts[name] = font;
                    // Persist to IndexedDB for next visit
                    _idbPut(name, json.b64);
                    delete self._loading[name];
                    return font;
                });
        }).catch(function (err) {
            console.warn('[tdf] load failed:', name, String(err));
            delete self._loading[name];
            return null;
        });
        self._loading[name] = p;
        return p;
    };

    /* Pick N unique random items from an array */
    function _pickN(arr, n) {
        var copy = arr.slice();
        var out  = [];
        for (var i = 0; i < n && copy.length; i++) {
            var idx = Math.floor(Math.random() * copy.length);
            out.push(copy[idx]);
            copy.splice(idx, 1);
        }
        return out;
    }

    /* ── Init: fetch map + INIT_POOL fonts per tier ────────────────── */

    TdfBrowser.prototype.init = function () {
        var self = this;
        // Phase 1: fetch font map + bulk-restore from IndexedDB
        return Promise.all([
            fetch(self._serveUrl + '?map').then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            }),
            _idbGetAll()
        ]).then(function (results) {
            var map    = results[0];
            var cached = results[1];
            self._fontMap = map;

            // Parse all cached fonts first (synchronous, no network)
            var cacheHits = 0;
            for (var name in cached) {
                try {
                    self._fonts[name] = self._parseB64(cached[name]);
                    cacheHits++;
                } catch (e) { /* corrupt entry, will re-fetch */ }
            }

            // Build tier pools from whatever is already cached
            for (var h = 3; h <= 12; h++) {
                var pool = map[String(h)];
                if (!pool || !pool.length) continue;
                self._tierPool[h]   = [];
                self._tierLoaded[h] = {};
                for (var i = 0; i < pool.length; i++) {
                    var name = pool[i];
                    if (self._fonts[name]) {
                        self._tierPool[h].push(name);
                        self._tierLoaded[h][name] = true;
                    }
                }
            }

            // If cache was mostly empty, fetch INIT_POOL per tier to be usable quickly
            var proms = [];
            if (cacheHits < 30) {
                for (var h = 3; h <= 12; h++) {
                    var pool = map[String(h)];
                    if (!pool || !pool.length) continue;
                    var picks = _pickN(pool, INIT_POOL);
                    for (var pi = 0; pi < picks.length; pi++) {
                        var name = picks[pi];
                        if (self._tierLoaded[h][name]) continue;
                        self._tierLoaded[h][name] = true;
                        (function (hh, nn) {
                            proms.push(
                                self._fetchFont(nn).then(function (font) {
                                    if (font) self._tierPool[hh].push(nn);
                                })
                            );
                        })(h, name);
                    }
                }
            }
            return Promise.all(proms).then(function () { return cacheHits; });
        }).then(function (cacheHits) {
            self._ready = true;
            var summary = {};
            var total   = 0;
            for (var h in self._tierPool) {
                summary[h] = self._tierPool[h].length;
                total += self._tierPool[h].length;
            }
            console.log('[tdf] ready — ' + total + ' fonts (' + cacheHits +
                        ' from cache) — pool sizes:', JSON.stringify(summary));
            // Background-load remaining fonts into pools
            self._bgLoad();
        }).catch(function (err) {
            console.error('[tdf] init failed:', String(err));
        });
    };

    /* ── Background loader: grow each tier's pool to MAX_POOL ──────── */

    TdfBrowser.prototype._bgLoad = function () {
        var self = this;
        // Defer if visualizer is active — avoid network contention during playback
        if (document.body.classList.contains('viz-open')) {
            setTimeout(function () { self._bgLoad(); }, 2000);
            return;
        }
        // Find a tier that still needs more fonts
        var candidates = [];
        for (var h = 3; h <= 12; h++) {
            var pool   = self._fontMap && self._fontMap[String(h)];
            var loaded = self._tierPool[h];
            if (!pool || !loaded) continue;
            if (loaded.length >= MAX_POOL) continue;
            if (loaded.length >= pool.length) continue;  // exhausted the map
            candidates.push(h);
        }
        if (!candidates.length) {
            console.log('[tdf] all pools full (' + MAX_POOL + ' per tier)');
            return;
        }
        // Round-robin: pick a random tier that needs fonts
        var h    = candidates[Math.floor(Math.random() * candidates.length)];
        var pool = self._fontMap[String(h)];
        // Pick a font not yet loaded for this tier
        var name = null;
        for (var tries = 0; tries < 50; tries++) {
            var pick = pool[Math.floor(Math.random() * pool.length)];
            if (!self._tierLoaded[h][pick]) { name = pick; break; }
        }
        if (!name) {
            // All tried — skip this tier, try again next tick
            setTimeout(function () { self._bgLoad(); }, BG_DELAY);
            return;
        }
        self._tierLoaded[h][name] = true;
        self._fetchFont(name).then(function (font) {
            if (font) {
                self._tierPool[h].push(name);
            }
            setTimeout(function () { self._bgLoad(); }, BG_DELAY);
        });
    };

    TdfBrowser.prototype.isReady  = function () { return this._ready; };
    TdfBrowser.prototype.poolSize = function (h) {
        return this._tierPool[h] ? this._tierPool[h].length : 0;
    };

    /* ── Auto-init on script load ──────────────────────────────────── */
    var inst = new TdfBrowser();
    inst.init();
    window.tdfBrowser = inst;

})(window);
