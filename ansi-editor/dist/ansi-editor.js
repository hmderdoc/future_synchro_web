var AnsiEditorModule = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.js
  var src_exports = {};
  __export(src_exports, {
    AnsiEditor: () => AnsiEditor
  });

  // src/lib/palette.js
  var ega = [
    { r: 0, g: 0, b: 0 },
    // 0  Black
    { r: 0, g: 0, b: 170 },
    // 1  Blue
    { r: 0, g: 170, b: 0 },
    // 2  Green
    { r: 0, g: 170, b: 170 },
    // 3  Cyan
    { r: 170, g: 0, b: 0 },
    // 4  Red
    { r: 170, g: 0, b: 170 },
    // 5  Magenta
    { r: 170, g: 85, b: 0 },
    // 6  Brown
    { r: 170, g: 170, b: 170 },
    // 7  Light Gray
    { r: 85, g: 85, b: 85 },
    // 8  Dark Gray
    { r: 85, g: 85, b: 255 },
    // 9  Light Blue
    { r: 85, g: 255, b: 85 },
    // 10 Light Green
    { r: 85, g: 255, b: 255 },
    // 11 Light Cyan
    { r: 255, g: 85, b: 85 },
    // 12 Light Red
    { r: 255, g: 85, b: 255 },
    // 13 Light Magenta
    { r: 255, g: 255, b: 85 },
    // 14 Yellow
    { r: 255, g: 255, b: 255 }
    // 15 White
  ];
  function rgbString(c) {
    return `rgb(${c.r},${c.g},${c.b})`;
  }

  // src/lib/encodings.js
  var cp437ToUnicode = [
    0,
    9786,
    9787,
    9829,
    9830,
    9827,
    9824,
    8226,
    9688,
    9675,
    9689,
    9794,
    9792,
    9834,
    9835,
    9788,
    9658,
    9668,
    8597,
    8252,
    182,
    167,
    9644,
    8616,
    8593,
    8595,
    8594,
    8592,
    8735,
    8596,
    9650,
    9660,
    32,
    33,
    34,
    35,
    36,
    37,
    38,
    39,
    40,
    41,
    42,
    43,
    44,
    45,
    46,
    47,
    48,
    49,
    50,
    51,
    52,
    53,
    54,
    55,
    56,
    57,
    58,
    59,
    60,
    61,
    62,
    63,
    64,
    65,
    66,
    67,
    68,
    69,
    70,
    71,
    72,
    73,
    74,
    75,
    76,
    77,
    78,
    79,
    80,
    81,
    82,
    83,
    84,
    85,
    86,
    87,
    88,
    89,
    90,
    91,
    92,
    93,
    94,
    95,
    96,
    97,
    98,
    99,
    100,
    101,
    102,
    103,
    104,
    105,
    106,
    107,
    108,
    109,
    110,
    111,
    112,
    113,
    114,
    115,
    116,
    117,
    118,
    119,
    120,
    121,
    122,
    123,
    124,
    125,
    126,
    8962,
    199,
    252,
    233,
    226,
    228,
    224,
    229,
    231,
    234,
    235,
    232,
    239,
    238,
    236,
    196,
    197,
    201,
    230,
    198,
    244,
    246,
    242,
    251,
    249,
    255,
    214,
    220,
    162,
    163,
    165,
    8359,
    402,
    225,
    237,
    243,
    250,
    241,
    209,
    170,
    186,
    191,
    8976,
    172,
    189,
    188,
    161,
    171,
    187,
    9617,
    9618,
    9619,
    9474,
    9508,
    9569,
    9570,
    9558,
    9557,
    9571,
    9553,
    9559,
    9565,
    9564,
    9563,
    9488,
    9492,
    9524,
    9516,
    9500,
    9472,
    9532,
    9566,
    9567,
    9562,
    9556,
    9577,
    9574,
    9568,
    9552,
    9580,
    9575,
    9576,
    9572,
    9573,
    9561,
    9560,
    9554,
    9555,
    9579,
    9578,
    9496,
    9484,
    9608,
    9604,
    9612,
    9616,
    9600,
    945,
    223,
    915,
    960,
    931,
    963,
    181,
    964,
    934,
    920,
    937,
    948,
    8734,
    966,
    949,
    8745,
    8801,
    177,
    8805,
    8804,
    8992,
    8993,
    247,
    8776,
    176,
    8729,
    183,
    8730,
    8319,
    178,
    9632,
    160
  ];
  var _reverse = /* @__PURE__ */ new Map();
  for (let i = 0; i < 256; i++) {
    _reverse.set(cp437ToUnicode[i], i);
  }
  _reverse.set(32, 32);
  function charToCp437(ch) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126)
      return code;
    return _reverse.get(code) || 32;
  }

  // src/lib/font.js
  var Font = class {
    constructor() {
      this.width = 8;
      this.height = 16;
      this.bitmask = null;
      this.palette = null;
    }
    /**
     * Load font data.
     * @param {Object} opts
     * @param {string} [opts.url]     URL to fetch font binary from
     * @param {Uint8Array} [opts.data] Raw font bytes
     * @param {Array} opts.palette     Array of 16 {r,g,b} objects
     */
    async load(opts) {
      this.palette = opts.palette;
      if (opts.data) {
        this.bitmask = opts.data instanceof Uint8Array ? opts.data : new Uint8Array(opts.data);
      } else if (opts.url) {
        const resp = await fetch(opts.url);
        if (!resp.ok)
          throw new Error(`Font fetch failed: ${resp.status} ${opts.url}`);
        this.bitmask = new Uint8Array(await resp.arrayBuffer());
      } else {
        throw new Error("Font.load requires url or data");
      }
      this.height = this.bitmask.length / 256;
      if (this.height !== Math.floor(this.height) || this.height < 1) {
        throw new Error(`Invalid font data: ${this.bitmask.length} bytes`);
      }
    }
    /**
     * Draw a single character cell to a canvas context.
     * @param {CanvasRenderingContext2D} ctx
     * @param {{code:number, fg:number, bg:number}} block
     * @param {number} px  Pixel x position
     * @param {number} py  Pixel y position
     */
    draw(ctx, block, px, py) {
      const fgColor = this.palette[block.fg] || this.palette[7];
      const bgColor = this.palette[block.bg] || this.palette[0];
      const offset = (block.code & 255) * this.height;
      const imageData = ctx.createImageData(this.width, this.height);
      const d = imageData.data;
      for (let row = 0; row < this.height; row++) {
        const byte = this.bitmask[offset + row] || 0;
        for (let col = 0; col < this.width; col++) {
          const bit = byte >> 7 - col & 1;
          const c = bit ? fgColor : bgColor;
          const idx = (row * this.width + col) * 4;
          d[idx] = c.r;
          d[idx + 1] = c.g;
          d[idx + 2] = c.b;
          d[idx + 3] = 255;
        }
      }
      ctx.putImageData(imageData, px, py);
    }
    /**
     * Draw cursor underline.
     */
    drawCursor(ctx, px, py) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(px, py + this.height - 2, this.width, 2);
    }
    getRgb(index) {
      return this.palette[index] || this.palette[0];
    }
  };

  // src/lib/document.js
  var TextDocument = class {
    constructor(columns, rows) {
      this.columns = columns;
      this.rows = rows;
      this.data = [];
      this.undoStack = [];
      this.redoStack = [];
      this._currentUndo = null;
      for (let i = 0; i < columns * rows; i++) {
        this.data.push({ code: 32, fg: 7, bg: 0 });
      }
    }
    at(x, y) {
      if (x < 0 || x >= this.columns || y < 0 || y >= this.rows)
        return null;
      return this.data[y * this.columns + x];
    }
    // ── Editing with undo tracking ──
    startUndo() {
      this._currentUndo = [];
    }
    changeData(x, y, code, fg, bg) {
      if (x < 0 || x >= this.columns || y < 0 || y >= this.rows)
        return null;
      const idx = y * this.columns + x;
      const old = { ...this.data[idx] };
      if (this._currentUndo) {
        this._currentUndo.push({ x, y, old });
      }
      this.data[idx] = { code, fg, bg };
      return { x, y };
    }
    endUndo() {
      if (this._currentUndo && this._currentUndo.length > 0) {
        this.undoStack.push(this._currentUndo);
        this.redoStack = [];
      }
      this._currentUndo = null;
    }
    undo() {
      if (this.undoStack.length === 0)
        return [];
      const changes = this.undoStack.pop();
      const redo = [];
      const affected = [];
      for (const ch of changes) {
        const idx = ch.y * this.columns + ch.x;
        redo.push({ x: ch.x, y: ch.y, old: { ...this.data[idx] } });
        this.data[idx] = { ...ch.old };
        affected.push({ x: ch.x, y: ch.y });
      }
      this.redoStack.push(redo);
      return affected;
    }
    redo() {
      if (this.redoStack.length === 0)
        return [];
      const changes = this.redoStack.pop();
      const undo = [];
      const affected = [];
      for (const ch of changes) {
        const idx = ch.y * this.columns + ch.x;
        undo.push({ x: ch.x, y: ch.y, old: { ...this.data[idx] } });
        this.data[idx] = { ...ch.old };
        affected.push({ x: ch.x, y: ch.y });
      }
      this.undoStack.push(undo);
      return affected;
    }
    // ── Half-block helpers ──
    // Half-block mode divides each character cell vertically into two halves.
    // Uses block characters: 32=space, 219=full, 220=lower, 223=upper.
    getHalfBlock(x, y) {
      const block = this.at(x, y);
      if (!block)
        return null;
      const { code, fg, bg } = block;
      let upperColor, lowerColor;
      switch (code) {
        case 32:
          upperColor = bg;
          lowerColor = bg;
          break;
        case 219:
          upperColor = fg;
          lowerColor = fg;
          break;
        case 220:
          upperColor = bg;
          lowerColor = fg;
          break;
        case 223:
          upperColor = fg;
          lowerColor = bg;
          break;
        default:
          return { isBlocky: false, upperColor: fg, lowerColor: bg, code, fg, bg };
      }
      return { isBlocky: true, upperColor, lowerColor, code, fg, bg };
    }
    /**
     * Set a half-block pixel.
     * @param {number} x       Column
     * @param {number} halfY   Row in half-block coords (0 = top of row 0, 1 = bottom of row 0, etc.)
     * @param {number} color   Palette color index (0-15)
     * @returns {{ x, y }|null} Affected cell coordinates
     */
    setHalfBlock(x, halfY, color) {
      const cellY = Math.floor(halfY / 2);
      const isUpper = halfY % 2 === 0;
      const info = this.getHalfBlock(x, cellY);
      if (!info)
        return null;
      let upper = isUpper ? color : info.upperColor;
      let lower = isUpper ? info.lowerColor : color;
      let newCode, newFg, newBg;
      if (upper === lower) {
        if (upper === 0) {
          newCode = 32;
          newFg = 0;
          newBg = 0;
        } else {
          newCode = 219;
          newFg = upper;
          newBg = 0;
        }
      } else {
        newCode = 223;
        newFg = upper;
        newBg = lower;
      }
      return this.changeData(x, cellY, newCode, newFg, newBg);
    }
    // ── Row operations ──
    insertRow(y) {
      if (y < 0 || y > this.rows)
        return;
      const newRow = [];
      for (let i = 0; i < this.columns; i++) {
        newRow.push({ code: 32, fg: 7, bg: 0 });
      }
      this.data.splice(y * this.columns, 0, ...newRow);
      this.rows++;
    }
    deleteRow(y) {
      if (y < 0 || y >= this.rows || this.rows <= 1)
        return;
      this.data.splice(y * this.columns, this.columns);
      this.rows--;
    }
    eraseLine(y) {
      if (y < 0 || y >= this.rows)
        return;
      const start = y * this.columns;
      for (let i = 0; i < this.columns; i++) {
        this.data[start + i] = { code: 32, fg: 7, bg: 0 };
      }
    }
  };

  // src/lib/renderer.js
  var Renderer = class {
    constructor(doc, font) {
      this.doc = doc;
      this.font = font;
      this.canvas = null;
      this.ctx = null;
      this.width = 0;
      this.height = 0;
    }
    /**
     * Full render of the entire document. Creates the canvas if needed.
     */
    render() {
      this.width = this.font.width * this.doc.columns;
      this.height = this.font.height * this.doc.rows;
      if (!this.canvas) {
        this.canvas = document.createElement("canvas");
      }
      this.canvas.width = this.width;
      this.canvas.height = this.height;
      this.ctx = this.canvas.getContext("2d");
      for (let y = 0, i = 0; y < this.doc.rows; y++) {
        for (let x = 0; x < this.doc.columns; x++, i++) {
          this.font.draw(
            this.ctx,
            this.doc.data[i],
            x * this.font.width,
            y * this.font.height
          );
        }
      }
    }
    /**
     * Re-render a single cell.
     */
    renderAt(x, y) {
      const block = this.doc.at(x, y);
      if (block && this.ctx) {
        this.font.draw(this.ctx, block, x * this.font.width, y * this.font.height);
      }
    }
    /**
     * Re-render a batch of cells.
     * @param {Array<{x:number, y:number}>} cells
     */
    renderCells(cells) {
      if (!this.ctx)
        return;
      for (const { x, y } of cells) {
        const block = this.doc.at(x, y);
        if (block) {
          this.font.draw(this.ctx, block, x * this.font.width, y * this.font.height);
        }
      }
    }
  };

  // src/lib/ansi.js
  function encodeAsAnsi(doc, opts = {}) {
    const iceColors = opts.iceColors || false;
    const out = [];
    let curBold = false;
    let curBlink = false;
    let curFg = 7;
    let curBg = 0;
    function pushBytes(str) {
      for (let i = 0; i < str.length; i++)
        out.push(str.charCodeAt(i));
    }
    function pushSGR(params) {
      out.push(27, 91);
      pushBytes(params.join(";"));
      out.push(109);
    }
    for (let y = 0; y < doc.rows; y++) {
      for (let x = 0; x < doc.columns; x++) {
        const block = doc.data[y * doc.columns + x];
        const wantBold = block.fg >= 8;
        const wantFg = block.fg & 7;
        const wantBlink = iceColors && block.bg >= 8;
        const wantBg = iceColors ? block.bg & 7 : Math.min(block.bg, 7);
        const needReset = curBold && !wantBold || curBlink && !wantBlink;
        if (needReset) {
          const p = [0];
          if (wantBold)
            p.push(1);
          if (wantBlink)
            p.push(5);
          p.push(30 + wantFg);
          if (wantBg !== 0)
            p.push(40 + wantBg);
          pushSGR(p);
          curBold = wantBold;
          curBlink = wantBlink;
          curFg = wantFg;
          curBg = wantBg;
        } else {
          const p = [];
          if (wantBold && !curBold) {
            p.push(1);
            curBold = true;
          }
          if (wantBlink && !curBlink) {
            p.push(5);
            curBlink = true;
          }
          if (wantFg !== curFg) {
            p.push(30 + wantFg);
            curFg = wantFg;
          }
          if (wantBg !== curBg) {
            p.push(40 + wantBg);
            curBg = wantBg;
          }
          if (p.length > 0)
            pushSGR(p);
        }
        out.push(block.code === 0 ? 32 : block.code);
      }
      if (y < doc.rows - 1) {
        out.push(13, 10);
      }
    }
    return new Uint8Array(out);
  }

  // src/editor.css
  var editor_default = "/* \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n   ANSI Editor \u2014 Styles (prefixed with .me- for isolation)\n   \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 */\n\n/* \u2500\u2500\u2500 Root container \u2500\u2500\u2500 */\n.me-editor {\n    display: flex;\n    flex-direction: column;\n    width: 100%;\n    height: 100%;\n    background: #1e1e2e;\n    color: #cdd6f4;\n    font-family: system-ui, -apple-system, sans-serif;\n    font-size: 12px;\n    outline: none;\n    overflow: hidden;\n    user-select: none;\n    position: relative;\n}\n\n/* \u2500\u2500\u2500 Body (sidebar + main) \u2500\u2500\u2500 */\n.me-body {\n    display: flex;\n    flex: 1;\n    min-height: 0;\n}\n\n/* \u2500\u2500\u2500 Sidebar \u2500\u2500\u2500 */\n.me-sidebar {\n    width: 48px;\n    background: #181825;\n    border-right: 1px solid #313244;\n    display: flex;\n    flex-direction: column;\n    align-items: center;\n    padding: 6px 4px;\n    gap: 6px;\n    flex-shrink: 0;\n}\n\n/* Current FG/BG color display */\n.me-current-colors {\n    position: relative;\n    width: 36px;\n    height: 36px;\n    margin-bottom: 4px;\n}\n.me-color-swatch {\n    position: absolute;\n    border: 2px solid #585b70;\n    cursor: pointer;\n}\n.me-color-swatch:hover {\n    border-color: #cdd6f4;\n}\n.me-color-bg {\n    width: 24px;\n    height: 24px;\n    bottom: 0;\n    right: 0;\n    z-index: 0;\n}\n.me-color-fg {\n    width: 24px;\n    height: 24px;\n    top: 0;\n    left: 0;\n    z-index: 1;\n}\n\n/* Palette grid */\n.me-palette {\n    display: grid;\n    grid-template-columns: repeat(2, 1fr);\n    gap: 2px;\n    width: 36px;\n}\n.me-pal-cell {\n    width: 16px;\n    height: 16px;\n    border: 1px solid transparent;\n    cursor: pointer;\n    transition: border-color 0.1s;\n}\n.me-pal-cell:hover {\n    border-color: #cdd6f4;\n}\n.me-pal-fg {\n    border-color: #f5e0dc !important;\n    box-shadow: inset 0 0 0 1px #1e1e2e;\n}\n.me-pal-bg {\n    outline: 2px dashed #a6adc8;\n    outline-offset: -1px;\n}\n\n/* Separator */\n.me-sep {\n    width: 32px;\n    height: 1px;\n    background: #313244;\n    margin: 4px 0;\n}\n\n/* Tool buttons */\n.me-tool-btn {\n    width: 32px;\n    height: 28px;\n    display: flex;\n    align-items: center;\n    justify-content: center;\n    background: #313244;\n    border-radius: 4px;\n    cursor: pointer;\n    font-weight: bold;\n    font-size: 13px;\n    color: #bac2de;\n    margin-bottom: 3px;\n    transition: background 0.15s;\n}\n.me-tool-btn:hover {\n    background: #45475a;\n}\n.me-tool-btn.me-active {\n    background: #89b4fa;\n    color: #1e1e2e;\n}\n\n/* \u2500\u2500\u2500 Main area \u2500\u2500\u2500 */\n.me-main {\n    flex: 1;\n    display: flex;\n    flex-direction: column;\n    min-width: 0;\n}\n\n/* \u2500\u2500\u2500 Toolbar \u2500\u2500\u2500 */\n.me-toolbar {\n    height: 44px;\n    background: #181825;\n    border-bottom: 1px solid #313244;\n    display: flex;\n    align-items: center;\n    padding: 0 8px;\n    gap: 4px;\n    flex-shrink: 0;\n}\n\n.me-fkey-nav {\n    cursor: pointer;\n    padding: 2px 4px;\n    color: #6c7086;\n    font-size: 11px;\n}\n.me-fkey-nav:hover {\n    color: #cdd6f4;\n}\n\n.me-fkey-group {\n    display: flex;\n    gap: 2px;\n}\n.me-fkey {\n    display: flex;\n    flex-direction: column;\n    align-items: center;\n    cursor: pointer;\n    padding: 2px;\n    border-radius: 3px;\n}\n.me-fkey:hover {\n    background: #313244;\n}\n.me-fkey canvas {\n    image-rendering: pixelated;\n    image-rendering: crisp-edges;\n}\n.me-fkey-label {\n    font-size: 8px;\n    color: #6c7086;\n    margin-top: 1px;\n}\n\n.me-toolbar-sep {\n    width: 1px;\n    height: 28px;\n    background: #313244;\n    margin: 0 6px;\n}\n\n.me-brush-modes {\n    display: none;\n    gap: 3px;\n}\n.me-brush-modes.me-visible {\n    display: flex;\n}\n.me-brush-mode {\n    padding: 3px 8px;\n    background: #313244;\n    border-radius: 3px;\n    cursor: pointer;\n    font-size: 11px;\n    color: #bac2de;\n}\n.me-brush-mode:hover {\n    background: #45475a;\n}\n.me-brush-mode.me-active {\n    background: #a6e3a1;\n    color: #1e1e2e;\n}\n\n/* \u2500\u2500\u2500 Viewport \u2500\u2500\u2500 */\n.me-viewport {\n    flex: 1;\n    overflow: auto;\n    background: #11111b;\n    cursor: crosshair;\n    position: relative;\n}\n.me-canvas-container {\n    position: relative;\n    display: inline-block;\n}\n.me-canvas {\n    display: block;\n    image-rendering: pixelated;\n    image-rendering: crisp-edges;\n}\n.me-editing-layer {\n    position: absolute;\n    top: 0;\n    left: 0;\n    pointer-events: none;\n}\n.me-cursor-canvas {\n    position: absolute;\n    image-rendering: pixelated;\n    image-rendering: crisp-edges;\n}\n\n/* Cursor blink animation */\n@keyframes me-blink {\n    0%, 50%  { opacity: 1; }\n    51%, 100% { opacity: 0; }\n}\n.me-cursor-blink {\n    animation: me-blink 1s step-end infinite;\n}\n\n/* \u2500\u2500\u2500 Status bar \u2500\u2500\u2500 */\n.me-statusbar {\n    height: 24px;\n    background: #181825;\n    border-top: 1px solid #313244;\n    display: flex;\n    align-items: center;\n    padding: 0 10px;\n    gap: 16px;\n    font-size: 11px;\n    color: #6c7086;\n    flex-shrink: 0;\n}\n\n/* \u2500\u2500\u2500 Action bar \u2500\u2500\u2500 */\n.me-action-bar {\n    height: 40px;\n    background: #181825;\n    border-top: 1px solid #313244;\n    display: flex;\n    align-items: center;\n    justify-content: flex-end;\n    padding: 0 12px;\n    gap: 8px;\n    flex-shrink: 0;\n}\n.me-btn {\n    padding: 5px 16px;\n    border: 1px solid #45475a;\n    border-radius: 4px;\n    background: #313244;\n    color: #cdd6f4;\n    cursor: pointer;\n    font-size: 12px;\n}\n.me-btn:hover {\n    background: #45475a;\n}\n.me-btn-done {\n    background: #89b4fa;\n    color: #1e1e2e;\n    border-color: #89b4fa;\n    font-weight: bold;\n}\n.me-btn-done:hover {\n    background: #74c7ec;\n}\n\n/* \u2500\u2500\u2500 Attribute overlay (color picker) \u2500\u2500\u2500 */\n.me-backdrop {\n    display: none;\n    position: absolute;\n    inset: 0;\n    background: rgba(0, 0, 0, 0.5);\n    z-index: 100;\n}\n.me-backdrop.me-visible {\n    display: block;\n}\n.me-attr-overlay {\n    display: none;\n    position: absolute;\n    top: 50%;\n    left: 50%;\n    transform: translate(-50%, -50%);\n    background: #1e1e2e;\n    border: 1px solid #45475a;\n    border-radius: 8px;\n    padding: 16px;\n    z-index: 101;\n    min-width: 200px;\n}\n.me-attr-overlay.me-visible {\n    display: block;\n}\n.me-attr-overlay h3 {\n    margin: 0 0 12px 0;\n    font-size: 14px;\n    color: #cdd6f4;\n    text-align: center;\n}\n.me-attr-grid {\n    display: grid;\n    grid-template-columns: repeat(8, 1fr);\n    gap: 4px;\n    margin-bottom: 12px;\n}\n.me-attr-cell {\n    width: 28px;\n    height: 28px;\n    border: 2px solid transparent;\n    border-radius: 3px;\n    cursor: pointer;\n}\n.me-attr-cell:hover {\n    border-color: #cdd6f4;\n}\n.me-attr-cell.me-selected {\n    border-color: #f5e0dc;\n    box-shadow: 0 0 0 2px #f5e0dc40;\n}\n.me-attr-actions {\n    text-align: center;\n}\n\n/* Utility */\n.me-hidden {\n    display: none !important;\n}\n";

  // src/editor.js
  var TOOLS = ["select", "brush", "fill", "sample"];
  var TOOL_LABELS = { select: "K", brush: "B", fill: "F", sample: "\u2299" };
  var TOOL_TIPS = {
    select: "Keyboard Mode (Alt+K)",
    brush: "Brush Mode (Alt+B)",
    fill: "Fill Mode (Alt+F)",
    sample: "Sample Mode (Alt+S)"
  };
  var BRUSH_MODES = ["half_block", "custom_block", "shading"];
  var BRUSH_MODE_LABELS = { half_block: "Half", custom_block: "Char", shading: "Shade" };
  var FKEY_SETS = [
    [218, 191, 192, 217, 196, 179, 195, 180, 193, 194, 32, 32],
    [201, 187, 200, 188, 205, 186, 204, 185, 202, 203, 32, 32],
    [213, 184, 212, 190, 205, 179, 198, 181, 207, 209, 32, 32],
    [214, 183, 211, 189, 196, 186, 199, 182, 208, 210, 32, 32],
    [197, 206, 216, 215, 176, 177, 178, 219, 220, 223, 32, 32],
    [176, 177, 178, 219, 223, 220, 221, 222, 254, 250, 32, 32]
  ];
  var AnsiEditor = class _AnsiEditor {
    static async create(options) {
      const editor = new _AnsiEditor(options);
      await editor.init();
      return editor;
    }
    constructor(options) {
      this.container = options.container;
      this.columns = options.columns || 80;
      this.rows = options.rows || 25;
      this.onDone = options.onDone || (() => {
      });
      this.onCancel = options.onCancel || (() => {
      });
      this.fontUrl = options.fontUrl || "./fonts/IBM VGA.F16";
      this.iceColors = options.iceColors || false;
      this.fg = 7;
      this.bg = 0;
      this.cursorX = 0;
      this.cursorY = 0;
      this.activeTool = "select";
      this.brushMode = "half_block";
      this.customBlockChar = 219;
      this.insertMode = false;
      this.fkeySetIndex = 0;
      this._mouseDown = false;
      this._mouseButton = 0;
      this._lastMouseX = -1;
      this._lastMouseY = -1;
      this._lastMouseHalfY = -1;
      this.font = null;
      this.doc = null;
      this.renderer = null;
      this.el = {};
      this._handlers = {};
    }
    async init() {
      if (!document.getElementById("me-editor-styles")) {
        const style = document.createElement("style");
        style.id = "me-editor-styles";
        style.textContent = editor_default;
        document.head.appendChild(style);
      }
      this.font = new Font();
      await this.font.load({ url: this.fontUrl, palette: ega });
      this.doc = new TextDocument(this.columns, this.rows);
      this.renderer = new Renderer(this.doc, this.font);
      this.renderer.render();
      this._buildDOM();
      this._fullRender();
      this._updateCursor();
      this._updatePalette();
      this._updateStatusBar();
      this._updateToolbar();
      this._selectTool("select");
      this._setupInput();
      this.el.root.focus();
    }
    // ═══ DOM BUILDING ═══
    _buildDOM() {
      const root = document.createElement("div");
      root.className = "me-editor";
      root.tabIndex = 0;
      const body = document.createElement("div");
      body.className = "me-body";
      const sidebar = this._buildSidebar();
      const main = document.createElement("div");
      main.className = "me-main";
      const toolbar = this._buildToolbar();
      const viewport = this._buildViewport();
      const statusbar = this._buildStatusBar();
      main.append(toolbar, viewport, statusbar);
      body.append(sidebar, main);
      const actionBar = document.createElement("div");
      actionBar.className = "me-action-bar";
      const btnCancel = document.createElement("button");
      btnCancel.className = "me-btn";
      btnCancel.textContent = "Cancel";
      btnCancel.onclick = () => this.cancel();
      const btnDone = document.createElement("button");
      btnDone.className = "me-btn me-btn-done";
      btnDone.textContent = "Done";
      btnDone.onclick = () => this.done();
      actionBar.append(btnCancel, btnDone);
      const backdrop = document.createElement("div");
      backdrop.className = "me-backdrop";
      backdrop.onclick = () => this._hideAttributeOverlay();
      const overlay = this._buildAttributeOverlay();
      root.append(body, actionBar, backdrop, overlay);
      this.el.root = root;
      this.el.backdrop = backdrop;
      this.container.innerHTML = "";
      this.container.appendChild(root);
    }
    _buildSidebar() {
      const sidebar = document.createElement("div");
      sidebar.className = "me-sidebar";
      const colors = document.createElement("div");
      colors.className = "me-current-colors";
      const fgSwatch = document.createElement("div");
      fgSwatch.className = "me-color-swatch me-color-fg";
      fgSwatch.title = "Foreground color";
      fgSwatch.onclick = () => this._showAttributeOverlay("fg");
      const bgSwatch = document.createElement("div");
      bgSwatch.className = "me-color-swatch me-color-bg";
      bgSwatch.title = "Background color";
      bgSwatch.onclick = () => this._showAttributeOverlay("bg");
      colors.append(bgSwatch, fgSwatch);
      this.el.fgSwatch = fgSwatch;
      this.el.bgSwatch = bgSwatch;
      const palette = document.createElement("div");
      palette.className = "me-palette";
      this.el.palCells = [];
      for (let i = 0; i < 16; i++) {
        const cell = document.createElement("div");
        cell.className = "me-pal-cell";
        cell.style.backgroundColor = rgbString(ega[i]);
        cell.title = "Color " + i;
        cell.addEventListener("mousedown", (e) => {
          e.preventDefault();
          if (e.button === 0)
            this._setFg(i);
          else if (e.button === 2)
            this._setBg(i);
        });
        cell.addEventListener("contextmenu", (e) => e.preventDefault());
        palette.appendChild(cell);
        this.el.palCells.push(cell);
      }
      const sep = document.createElement("div");
      sep.className = "me-sep";
      const toolBtns = document.createElement("div");
      this.el.toolBtns = {};
      for (const tool of TOOLS) {
        const btn = document.createElement("div");
        btn.className = "me-tool-btn";
        btn.textContent = TOOL_LABELS[tool];
        btn.title = TOOL_TIPS[tool];
        btn.onclick = () => this._selectTool(tool);
        toolBtns.appendChild(btn);
        this.el.toolBtns[tool] = btn;
      }
      sidebar.append(colors, palette, sep, toolBtns);
      return sidebar;
    }
    _buildToolbar() {
      const toolbar = document.createElement("div");
      toolbar.className = "me-toolbar";
      const fkeyLeft = document.createElement("div");
      fkeyLeft.className = "me-fkey-nav";
      fkeyLeft.textContent = "\u25C0";
      fkeyLeft.onclick = () => this._prevFkeySet();
      const fkeyGroup = document.createElement("div");
      fkeyGroup.className = "me-fkey-group";
      this.el.fkeyCanvases = [];
      for (let i = 0; i < 12; i++) {
        const fk = document.createElement("div");
        fk.className = "me-fkey";
        fk.title = "F" + (i + 1);
        const canvas = document.createElement("canvas");
        canvas.width = this.font.width;
        canvas.height = this.font.height;
        canvas.style.width = this.font.width * 2 + "px";
        canvas.style.height = this.font.height * 2 + "px";
        const label = document.createElement("div");
        label.className = "me-fkey-label";
        label.textContent = "F" + (i + 1);
        fk.append(canvas, label);
        fk.onclick = () => this._typeFkey(i);
        fkeyGroup.appendChild(fk);
        this.el.fkeyCanvases.push(canvas);
      }
      const fkeyRight = document.createElement("div");
      fkeyRight.className = "me-fkey-nav";
      fkeyRight.textContent = "\u25B6";
      fkeyRight.onclick = () => this._nextFkeySet();
      const sep1 = document.createElement("div");
      sep1.className = "me-toolbar-sep";
      const brushModes = document.createElement("div");
      brushModes.className = "me-brush-modes";
      this.el.brushModeBtns = {};
      for (const mode of BRUSH_MODES) {
        const btn = document.createElement("div");
        btn.className = "me-brush-mode";
        btn.textContent = BRUSH_MODE_LABELS[mode];
        btn.onclick = () => this._setBrushMode(mode);
        brushModes.appendChild(btn);
        this.el.brushModeBtns[mode] = btn;
      }
      this.el.brushModes = brushModes;
      toolbar.append(fkeyLeft, fkeyGroup, fkeyRight, sep1, brushModes);
      this.el.toolbar = toolbar;
      return toolbar;
    }
    _buildViewport() {
      const viewport = document.createElement("div");
      viewport.className = "me-viewport";
      const container = document.createElement("div");
      container.className = "me-canvas-container";
      const canvas = this.renderer.canvas;
      canvas.className = "me-canvas";
      canvas.style.width = this.renderer.width + "px";
      canvas.style.height = this.renderer.height + "px";
      const editingLayer = document.createElement("div");
      editingLayer.className = "me-editing-layer";
      const cursorCanvas = document.createElement("canvas");
      cursorCanvas.className = "me-cursor-canvas me-cursor-blink";
      cursorCanvas.width = this.font.width;
      cursorCanvas.height = this.font.height;
      cursorCanvas.style.width = this.font.width + "px";
      cursorCanvas.style.height = this.font.height + "px";
      editingLayer.appendChild(cursorCanvas);
      container.append(canvas, editingLayer);
      viewport.appendChild(container);
      this.el.viewport = viewport;
      this.el.canvasContainer = container;
      this.el.canvas = canvas;
      this.el.cursorCanvas = cursorCanvas;
      this.el.editingLayer = editingLayer;
      return viewport;
    }
    _buildStatusBar() {
      const bar = document.createElement("div");
      bar.className = "me-statusbar";
      const pos = document.createElement("span");
      this.el.statusPos = pos;
      const dim = document.createElement("span");
      this.el.statusDim = dim;
      const mode = document.createElement("span");
      this.el.statusMode = mode;
      const tool = document.createElement("span");
      this.el.statusTool = tool;
      bar.append(pos, dim, mode, tool);
      return bar;
    }
    _buildAttributeOverlay() {
      const overlay = document.createElement("div");
      overlay.className = "me-attr-overlay";
      const title = document.createElement("h3");
      title.textContent = "Select Color";
      this.el.attrTitle = title;
      const grid = document.createElement("div");
      grid.className = "me-attr-grid";
      this.el.attrCells = [];
      for (let i = 0; i < 16; i++) {
        const cell = document.createElement("div");
        cell.className = "me-attr-cell";
        cell.style.backgroundColor = rgbString(ega[i]);
        cell.onclick = () => this._onAttrPick(i);
        grid.appendChild(cell);
        this.el.attrCells.push(cell);
      }
      const actions = document.createElement("div");
      actions.className = "me-attr-actions";
      const closeBtn = document.createElement("button");
      closeBtn.className = "me-btn";
      closeBtn.textContent = "Close";
      closeBtn.onclick = () => this._hideAttributeOverlay();
      actions.appendChild(closeBtn);
      overlay.append(title, grid, actions);
      this.el.attrOverlay = overlay;
      this._attrTarget = "fg";
      return overlay;
    }
    // ═══ INPUT ═══
    _setupInput() {
      this._handlers.keydown = (e) => this._handleKeyDown(e);
      this._handlers.mousedown = (e) => this._handleMouseDown(e);
      this._handlers.mousemove = (e) => this._handleMouseMove(e);
      this._handlers.mouseup = (e) => this._handleMouseUp(e);
      this._handlers.contextmenu = (e) => e.preventDefault();
      this.el.root.addEventListener("keydown", this._handlers.keydown);
      this.el.viewport.addEventListener("mousedown", this._handlers.mousedown);
      this.el.viewport.addEventListener("contextmenu", this._handlers.contextmenu);
      document.addEventListener("mousemove", this._handlers.mousemove);
      document.addEventListener("mouseup", this._handlers.mouseup);
    }
    _getCanvasXY(event) {
      const rect = this.el.canvas.getBoundingClientRect();
      const scaleX = this.renderer.width / rect.width;
      const scaleY = this.renderer.height / rect.height;
      const px = (event.clientX - rect.left) * scaleX;
      const py = (event.clientY - rect.top) * scaleY;
      const x = Math.floor(px / this.font.width);
      const y = Math.floor(py / this.font.height);
      const halfY = Math.floor(py / (this.font.height / 2));
      return { x, y, halfY };
    }
    // ── Keyboard ──
    _handleKeyDown(e) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key === "z") {
        e.preventDefault();
        this._undo();
        return;
      }
      if (ctrl && (e.key === "y" || e.shiftKey && e.key === "Z")) {
        e.preventDefault();
        this._redo();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (this.el.attrOverlay.classList.contains("me-visible")) {
          this._hideAttributeOverlay();
        } else {
          this._showAttributeOverlay("fg");
        }
        return;
      }
      if (e.altKey && !ctrl) {
        switch (e.key.toLowerCase()) {
          case "k":
            e.preventDefault();
            this._selectTool("select");
            return;
          case "b":
            e.preventDefault();
            this._selectTool("brush");
            return;
          case "f":
            e.preventDefault();
            this._selectTool("fill");
            return;
          case "s":
            e.preventDefault();
            this._selectTool("sample");
            return;
        }
      }
      var fmatch = e.key.match(/^F(\d+)$/);
      if (fmatch) {
        var num = parseInt(fmatch[1]) - 1;
        if (num >= 0 && num < 12) {
          e.preventDefault();
          this._typeFkey(num);
          return;
        }
      }
      if (this.activeTool === "select") {
        this._handleSelectKey(e);
      }
    }
    _handleSelectKey(e) {
      var ctrl = e.ctrlKey || e.metaKey;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          this._moveCursor(this.cursorX - 1, this.cursorY);
          break;
        case "ArrowRight":
          e.preventDefault();
          this._moveCursor(this.cursorX + 1, this.cursorY);
          break;
        case "ArrowUp":
          e.preventDefault();
          this._moveCursor(this.cursorX, this.cursorY - 1);
          break;
        case "ArrowDown":
          e.preventDefault();
          this._moveCursor(this.cursorX, this.cursorY + 1);
          break;
        case "Home":
          e.preventDefault();
          this._moveCursor(0, this.cursorY);
          break;
        case "End":
          e.preventDefault();
          this._moveCursor(this.columns - 1, this.cursorY);
          break;
        case "PageUp":
          e.preventDefault();
          this._moveCursor(this.cursorX, Math.max(0, this.cursorY - 25));
          break;
        case "PageDown":
          e.preventDefault();
          this._moveCursor(this.cursorX, Math.min(this.rows - 1, this.cursorY + 25));
          break;
        case "Enter":
          e.preventDefault();
          this._moveCursor(0, Math.min(this.rows - 1, this.cursorY + 1));
          break;
        case "Backspace":
          e.preventDefault();
          this._backspace();
          break;
        case "Delete":
          e.preventDefault();
          this._deleteKey();
          break;
        case "Insert":
          e.preventDefault();
          this.insertMode = !this.insertMode;
          this._updateStatusBar();
          break;
        case "Tab":
          e.preventDefault();
          if (e.shiftKey)
            this._moveCursor(Math.max(0, this.cursorX - 8), this.cursorY);
          else
            this._moveCursor(Math.min(this.columns - 1, this.cursorX + 8), this.cursorY);
          break;
        default:
          if (!ctrl && !e.altKey && e.key.length === 1) {
            e.preventDefault();
            var code = charToCp437(e.key);
            this._typeChar(code);
          }
          break;
      }
    }
    // ── Mouse ──
    _handleMouseDown(e) {
      e.preventDefault();
      this.el.root.focus();
      var pos = this._getCanvasXY(e);
      if (pos.x < 0 || pos.x >= this.columns || pos.y < 0 || pos.y >= this.rows)
        return;
      this._mouseDown = true;
      this._mouseButton = e.button;
      this._lastMouseX = pos.x;
      this._lastMouseY = pos.y;
      this._lastMouseHalfY = pos.halfY;
      switch (this.activeTool) {
        case "select":
          this._moveCursor(pos.x, pos.y);
          break;
        case "brush":
          this.doc.startUndo();
          this._brushDraw(pos.x, pos.y, pos.halfY, e.button);
          break;
        case "fill":
          this._doFill(pos.x, pos.halfY, e.button);
          break;
        case "sample":
          this._doSample(pos.x, pos.y);
          break;
      }
    }
    _handleMouseMove(e) {
      if (!this._mouseDown)
        return;
      var pos = this._getCanvasXY(e);
      if (pos.x < 0 || pos.x >= this.columns || pos.y < 0 || pos.y >= this.rows)
        return;
      if (pos.x === this._lastMouseX && pos.halfY === this._lastMouseHalfY)
        return;
      if (this.activeTool === "brush") {
        this._brushDrawLine(this._lastMouseX, this._lastMouseHalfY, pos.x, pos.halfY, this._mouseButton);
      } else if (this.activeTool === "select") {
        this._moveCursor(pos.x, pos.y);
      }
      this._lastMouseX = pos.x;
      this._lastMouseY = pos.y;
      this._lastMouseHalfY = pos.halfY;
    }
    _handleMouseUp(e) {
      if (!this._mouseDown)
        return;
      this._mouseDown = false;
      if (this.activeTool === "brush")
        this.doc.endUndo();
    }
    // ═══ RENDERING ═══
    _fullRender() {
      this.renderer.render();
    }
    _renderCell(x, y) {
      this.renderer.renderAt(x, y);
    }
    _renderCells(cells) {
      this.renderer.renderCells(cells);
    }
    // ═══ CURSOR ═══
    _updateCursor() {
      var cc = this.el.cursorCanvas;
      if (!cc)
        return;
      var ctx = cc.getContext("2d");
      ctx.clearRect(0, 0, cc.width, cc.height);
      var block = this.doc.at(this.cursorX, this.cursorY);
      if (block)
        this.font.draw(ctx, block, 0, 0);
      ctx.globalCompositeOperation = "difference";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, this.font.height - 2, this.font.width, 2);
      ctx.globalCompositeOperation = "source-over";
      cc.style.left = this.cursorX * this.font.width + "px";
      cc.style.top = this.cursorY * this.font.height + "px";
      this._updateStatusBar();
    }
    _moveCursor(x, y, scroll) {
      x = Math.max(0, Math.min(this.columns - 1, x));
      y = Math.max(0, Math.min(this.rows - 1, y));
      this.cursorX = x;
      this.cursorY = y;
      this._updateCursor();
      if (scroll !== false)
        this._scrollToCursor();
    }
    _scrollToCursor() {
      var vp = this.el.viewport;
      var px = this.cursorX * this.font.width;
      var py = this.cursorY * this.font.height;
      if (px < vp.scrollLeft)
        vp.scrollLeft = px;
      if (px + this.font.width > vp.scrollLeft + vp.clientWidth)
        vp.scrollLeft = px + this.font.width - vp.clientWidth;
      if (py < vp.scrollTop)
        vp.scrollTop = py;
      if (py + this.font.height > vp.scrollTop + vp.clientHeight)
        vp.scrollTop = py + this.font.height - vp.clientHeight;
    }
    // ═══ PALETTE ═══
    _setFg(color) {
      this.fg = color;
      this._updatePalette();
    }
    _setBg(color) {
      this.bg = color;
      this._updatePalette();
    }
    _updatePalette() {
      this.el.fgSwatch.style.backgroundColor = rgbString(ega[this.fg]);
      this.el.bgSwatch.style.backgroundColor = rgbString(ega[this.bg]);
      for (var i = 0; i < 16; i++) {
        var cell = this.el.palCells[i];
        cell.classList.toggle("me-pal-fg", i === this.fg);
        cell.classList.toggle("me-pal-bg", i === this.bg);
      }
      this._updateFkeyDisplay();
    }
    // ═══ TOOLS ═══
    _selectTool(name) {
      this.activeTool = name;
      for (var t of TOOLS) {
        this.el.toolBtns[t].classList.toggle("me-active", t === name);
      }
      this.el.brushModes.classList.toggle("me-visible", name === "brush");
      this.el.cursorCanvas.classList.toggle("me-hidden", name !== "select");
      this.el.viewport.style.cursor = name === "select" ? "text" : "crosshair";
      this._updateToolbar();
      this._updateStatusBar();
    }
    // ── Select tool helpers ──
    _typeChar(code) {
      this.doc.startUndo();
      if (this.insertMode) {
        for (var x = this.columns - 1; x > this.cursorX; x--) {
          var prev = this.doc.at(x - 1, this.cursorY);
          if (prev)
            this.doc.changeData(x, this.cursorY, prev.code, prev.fg, prev.bg);
        }
      }
      this.doc.changeData(this.cursorX, this.cursorY, code, this.fg, this.bg);
      this.doc.endUndo();
      for (var rx = this.insertMode ? this.cursorX : this.cursorX; rx < this.columns; rx++) {
        this._renderCell(rx, this.cursorY);
        if (!this.insertMode)
          break;
      }
      this._moveCursor(this.cursorX + 1, this.cursorY);
    }
    _typeFkey(num) {
      var set = FKEY_SETS[this.fkeySetIndex];
      if (set && num < set.length)
        this._typeChar(set[num]);
    }
    _backspace() {
      if (this.cursorX > 0) {
        this._moveCursor(this.cursorX - 1, this.cursorY);
        this.doc.startUndo();
        this.doc.changeData(this.cursorX, this.cursorY, 32, this.fg, this.bg);
        this.doc.endUndo();
        this._renderCell(this.cursorX, this.cursorY);
        this._updateCursor();
      }
    }
    _deleteKey() {
      this.doc.startUndo();
      for (var x = this.cursorX; x < this.columns - 1; x++) {
        var next = this.doc.at(x + 1, this.cursorY);
        if (next)
          this.doc.changeData(x, this.cursorY, next.code, next.fg, next.bg);
      }
      this.doc.changeData(this.columns - 1, this.cursorY, 32, 7, 0);
      this.doc.endUndo();
      for (var rx = this.cursorX; rx < this.columns; rx++)
        this._renderCell(rx, this.cursorY);
      this._updateCursor();
    }
    // ── Brush tool ──
    _brushDraw(x, y, halfY, button) {
      var color = button === 0 ? this.fg : this.bg;
      switch (this.brushMode) {
        case "half_block": {
          var affected = this.doc.setHalfBlock(x, halfY, color);
          if (affected)
            this._renderCell(affected.x, affected.y);
          break;
        }
        case "custom_block": {
          this.doc.changeData(x, y, this.customBlockChar, this.fg, this.bg);
          this._renderCell(x, y);
          break;
        }
        case "shading": {
          var block = this.doc.at(x, y);
          var shades = [32, 176, 177, 178, 219];
          var idx = shades.indexOf(block ? block.code : 32);
          if (idx < 0)
            idx = 0;
          if (button === 0)
            idx = Math.min(idx + 1, shades.length - 1);
          else
            idx = Math.max(idx - 1, 0);
          this.doc.changeData(x, y, shades[idx], this.fg, this.bg);
          this._renderCell(x, y);
          break;
        }
      }
    }
    _brushDrawLine(x0, halfY0, x1, halfY1, button) {
      var dx = Math.abs(x1 - x0);
      var dy = Math.abs(halfY1 - halfY0);
      var sx = x0 < x1 ? 1 : -1;
      var sy = halfY0 < halfY1 ? 1 : -1;
      var err = dx - dy;
      while (true) {
        var y = Math.floor(halfY0 / 2);
        this._brushDraw(x0, y, halfY0, button);
        if (x0 === x1 && halfY0 === halfY1)
          break;
        var e2 = 2 * err;
        if (e2 > -dy) {
          err -= dy;
          x0 += sx;
        }
        if (e2 < dx) {
          err += dx;
          halfY0 += sy;
        }
      }
    }
    _setBrushMode(mode) {
      this.brushMode = mode;
      this._updateToolbar();
    }
    // ── Fill tool ──
    _doFill(x, halfY, button) {
      var cellY = Math.floor(halfY / 2);
      var isUpper = halfY % 2 === 0;
      var info = this.doc.getHalfBlock(x, cellY);
      if (!info)
        return;
      var targetColor = isUpper ? info.upperColor : info.lowerColor;
      var fillColor = button === 0 ? this.fg : this.bg;
      if (targetColor === fillColor)
        return;
      this.doc.startUndo();
      var visited = {};
      var stack = [{ x, halfY }];
      var affected = {};
      while (stack.length > 0) {
        var pt = stack.pop();
        var key = pt.x + "," + pt.halfY;
        if (visited[key])
          continue;
        visited[key] = true;
        var cy = Math.floor(pt.halfY / 2);
        var isUp = pt.halfY % 2 === 0;
        if (pt.x < 0 || pt.x >= this.columns || cy < 0 || cy >= this.rows)
          continue;
        var hb = this.doc.getHalfBlock(pt.x, cy);
        if (!hb)
          continue;
        var currentColor = isUp ? hb.upperColor : hb.lowerColor;
        if (currentColor !== targetColor)
          continue;
        this.doc.setHalfBlock(pt.x, pt.halfY, fillColor);
        affected[pt.x + "," + cy] = { x: pt.x, y: cy };
        stack.push({ x: pt.x - 1, halfY: pt.halfY });
        stack.push({ x: pt.x + 1, halfY: pt.halfY });
        stack.push({ x: pt.x, halfY: pt.halfY - 1 });
        stack.push({ x: pt.x, halfY: pt.halfY + 1 });
      }
      this.doc.endUndo();
      for (var k in affected)
        this._renderCell(affected[k].x, affected[k].y);
    }
    // ── Sample tool ──
    _doSample(x, y) {
      var block = this.doc.at(x, y);
      if (!block)
        return;
      this._setFg(block.fg);
      this._setBg(block.bg);
      this._selectTool("select");
    }
    // ═══ ATTRIBUTE OVERLAY ═══
    _showAttributeOverlay(target) {
      this._attrTarget = target || "fg";
      this.el.attrTitle.textContent = this._attrTarget === "fg" ? "Foreground Color" : "Background Color";
      var selected = this._attrTarget === "fg" ? this.fg : this.bg;
      for (var i = 0; i < 16; i++) {
        this.el.attrCells[i].classList.toggle("me-selected", i === selected);
      }
      this.el.backdrop.classList.add("me-visible");
      this.el.attrOverlay.classList.add("me-visible");
    }
    _hideAttributeOverlay() {
      this.el.backdrop.classList.remove("me-visible");
      this.el.attrOverlay.classList.remove("me-visible");
    }
    _onAttrPick(color) {
      if (this._attrTarget === "fg")
        this._setFg(color);
      else
        this._setBg(color);
      this._hideAttributeOverlay();
    }
    // ═══ UNDO/REDO ═══
    _undo() {
      var affected = this.doc.undo();
      if (affected.length > 0) {
        this._renderCells(affected);
        this._updateCursor();
      }
    }
    _redo() {
      var affected = this.doc.redo();
      if (affected.length > 0) {
        this._renderCells(affected);
        this._updateCursor();
      }
    }
    // ═══ TOOLBAR ═══
    _updateToolbar() {
      for (var mode of BRUSH_MODES) {
        this.el.brushModeBtns[mode].classList.toggle("me-active", mode === this.brushMode);
      }
      this._updateFkeyDisplay();
    }
    _updateFkeyDisplay() {
      var set = FKEY_SETS[this.fkeySetIndex];
      for (var i = 0; i < 12; i++) {
        var canvas = this.el.fkeyCanvases[i];
        var ctx = canvas.getContext("2d");
        canvas.width = this.font.width;
        canvas.height = this.font.height;
        this.font.draw(ctx, { code: set[i], fg: this.fg, bg: this.bg }, 0, 0);
      }
    }
    _nextFkeySet() {
      this.fkeySetIndex = (this.fkeySetIndex + 1) % FKEY_SETS.length;
      this._updateFkeyDisplay();
    }
    _prevFkeySet() {
      this.fkeySetIndex = (this.fkeySetIndex - 1 + FKEY_SETS.length) % FKEY_SETS.length;
      this._updateFkeyDisplay();
    }
    // ═══ STATUS BAR ═══
    _updateStatusBar() {
      this.el.statusPos.textContent = "Ln " + (this.cursorY + 1) + ", Col " + (this.cursorX + 1);
      this.el.statusDim.textContent = this.columns + " \xD7 " + this.rows;
      this.el.statusMode.textContent = this.insertMode ? "INS" : "OVR";
      this.el.statusTool.textContent = TOOL_TIPS[this.activeTool] || "";
    }
    // ═══ PUBLIC API ═══
    getAnsiData() {
      return encodeAsAnsi(this.doc, { iceColors: this.iceColors });
    }
    done() {
      this.onDone(this.getAnsiData());
    }
    cancel() {
      this.onCancel();
    }
    destroy() {
      if (this.el.root)
        this.el.root.removeEventListener("keydown", this._handlers.keydown);
      document.removeEventListener("mousemove", this._handlers.mousemove);
      document.removeEventListener("mouseup", this._handlers.mouseup);
      if (this.container)
        this.container.innerHTML = "";
    }
  };
  return __toCommonJS(src_exports);
})();
if(typeof window!=="undefined")window.AnsiEditor=AnsiEditorModule.AnsiEditor;
//# sourceMappingURL=ansi-editor.js.map
