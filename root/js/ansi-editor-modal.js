/**
 * ANSI Editor Modal — Draggable, Resizable Window
 *
 * Wraps the AnsiEditor in a floating modal that behaves like a
 * desktop window: title bar for dragging, resize handle in the
 * bottom-right corner.  Works for both chat and forum contexts.
 *
 * Usage:
 *   AnsiEditorModal.open({
 *       title:    'ANSI Editor',
 *       fontUrl:  './fonts/ansi-editor/IBM VGA.F16',
 *       columns:  80,
 *       rows:     25,
 *       onDone:   function (editor) { ... },  // editor.doc still valid
 *       onCancel: function () { ... }
 *   });
 *
 *   AnsiEditorModal.close();   // programmatic close
 */

(function () {
    'use strict';

    /* ── State ── */
    var overlay = null;
    var modal = null;
    var editorInstance = null;
    var _onDone = null;
    var _onCancel = null;

    /* ── Geometry defaults ── */
    var DEFAULT_WIDTH  = 980;
    var DEFAULT_HEIGHT = 620;
    var MIN_WIDTH  = 480;
    var MIN_HEIGHT = 360;

    /* ── Public API ── */
    var AnsiEditorModal = {
        open: open,
        close: close,
        get editor() { return editorInstance; },
        get isOpen() { return !!modal; }
    };

    function open(opts) {
        if (modal) close();
        if (!window.AnsiEditor) {
            console.error('AnsiEditor not loaded');
            return;
        }

        opts = opts || {};
        _onDone = opts.onDone || null;
        _onCancel = opts.onCancel || null;

        /* ── Backdrop ── */
        overlay = document.createElement('div');
        overlay.className = 'ae-modal-overlay';
        overlay.addEventListener('mousedown', function (e) {
            if (e.target === overlay) {
                if (modal) modal.classList.add('ae-modal-shake');
                setTimeout(function () {
                    if (modal) modal.classList.remove('ae-modal-shake');
                }, 300);
            }
        });

        /* ── Modal window ── */
        modal = document.createElement('div');
        modal.className = 'ae-modal-window';
        modal.style.width  = DEFAULT_WIDTH + 'px';
        modal.style.height = DEFAULT_HEIGHT + 'px';

        var left = Math.max(0, (window.innerWidth  - DEFAULT_WIDTH)  / 2);
        var top  = Math.max(0, (window.innerHeight - DEFAULT_HEIGHT) / 2);
        modal.style.left = left + 'px';
        modal.style.top  = top  + 'px';

        /* ── Title bar ── */
        var titleBar = document.createElement('div');
        titleBar.className = 'ae-modal-titlebar';

        var titleText = document.createElement('span');
        titleText.className = 'ae-modal-title';
        titleText.textContent = opts.title || 'ANSI Editor';
        titleBar.appendChild(titleText);

        var closeBtn = document.createElement('button');
        closeBtn.className = 'ae-modal-close';
        closeBtn.textContent = '\u2715';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('click', function () { doCancel(); });
        titleBar.appendChild(closeBtn);

        /* ── Editor container ── */
        var editorWrap = document.createElement('div');
        editorWrap.className = 'ae-modal-body';

        /* ── Resize handle ── */
        var resizeHandle = document.createElement('div');
        resizeHandle.className = 'ae-modal-resize';

        /* Assemble */
        modal.appendChild(titleBar);
        modal.appendChild(editorWrap);
        modal.appendChild(resizeHandle);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        /* ── Dragging ── */
        initDrag(titleBar, modal);

        /* ── Resizing ── */
        initResize(resizeHandle, modal);

        /* ── Create the ANSI editor inside ── */
        AnsiEditor.create({
            container: editorWrap,
            columns:  opts.columns || 80,
            rows:     opts.rows    || 25,
            fontUrl:  opts.fontUrl || './fonts/ansi-editor/IBM VGA.F16',
            onDone:   function () { doDone(); },
            onCancel: function () { doCancel(); }
        }).then(function (editor) {
            editorInstance = editor;
        }).catch(function (err) {
            console.error('ANSI Editor modal error:', err);
            close();
        });

        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', onEsc);
    }

    function teardown() {
        document.removeEventListener('keydown', onEsc);
        if (overlay && overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
        overlay = null;
        modal = null;
        document.body.style.overflow = '';
    }

    function close() {
        if (editorInstance) {
            try { editorInstance.destroy(); } catch (e) {}
            editorInstance = null;
        }
        _onDone = null;
        _onCancel = null;
        teardown();
    }

    function doDone() {
        // Grab editor ref BEFORE destroying so the callback can read .doc
        var cb = _onDone;
        var ed = editorInstance;
        // Detach so close() won't destroy the editor (we hand it to the callback)
        editorInstance = null;
        _onDone = null;
        _onCancel = null;
        teardown();
        // Now call back — editor is not yet destroyed, caller can read .doc
        if (cb) cb(ed);
        // Clean up the editor after the callback has used it
        if (ed) { try { ed.destroy(); } catch (e) {} }
    }

    function doCancel() {
        var cb = _onCancel;
        close();
        if (cb) cb();
    }

    function onEsc(e) {
        if (e.key === 'Escape') doCancel();
    }

    /* ── Drag logic ── */
    function initDrag(handle, win) {
        var startX, startY, origLeft, origTop;

        function onMouseDown(e) {
            if (e.target.tagName === 'BUTTON') return;
            e.preventDefault();
            startX = e.clientX;
            startY = e.clientY;
            origLeft = win.offsetLeft;
            origTop  = win.offsetTop;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            handle.style.cursor = 'grabbing';
        }
        function onMouseMove(e) {
            var dx = e.clientX - startX;
            var dy = e.clientY - startY;
            win.style.left = (origLeft + dx) + 'px';
            win.style.top  = (origTop  + dy) + 'px';
        }
        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            handle.style.cursor = '';
        }
        handle.addEventListener('mousedown', onMouseDown);
    }

    /* ── Resize logic ── */
    function initResize(handle, win) {
        var startX, startY, origW, origH;

        function onMouseDown(e) {
            e.preventDefault();
            e.stopPropagation();
            startX = e.clientX;
            startY = e.clientY;
            origW = win.offsetWidth;
            origH = win.offsetHeight;
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        }
        function onMouseMove(e) {
            var w = Math.max(MIN_WIDTH,  origW + (e.clientX - startX));
            var h = Math.max(MIN_HEIGHT, origH + (e.clientY - startY));
            win.style.width  = w + 'px';
            win.style.height = h + 'px';
        }
        function onMouseUp() {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }
        handle.addEventListener('mousedown', onMouseDown);
    }

    /* ── Expose ── */
    window.AnsiEditorModal = AnsiEditorModal;

})();
