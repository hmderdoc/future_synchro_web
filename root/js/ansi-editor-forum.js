/**
 * ANSI Editor <-> Forum integration
 *
 * Adds an "ANSI Art" toggle button next to compose textareas.
 * When active, opens the ANSI Editor in a draggable/resizable modal.
 * On Done, base64-encodes the raw CP437 ANSI bytes and puts the
 * result in the textarea.  The server decodes and stores raw bytes
 * — no Unicode, no UTF-8 charset headers — just like a BBS post.
 */

(function () {
    'use strict';

    function setToggleButtonState(toggleBtn, active) {
        if (!toggleBtn) return;
        toggleBtn.textContent = active ? 'Text Mode' : 'ANSI Art';
        toggleBtn.classList.toggle('btn-warning', !!active);
        toggleBtn.classList.toggle('btn-default', !active);
    }

    /**
     * Convert ANSI byte array (Uint8Array) to a base64 string.
     * Raw CP437 bytes go in; pure ASCII base64 comes out.
     */
    function ansiBytesToBase64(bytes) {
        var str = '';
        var CHUNK = 8192;
        for (var i = 0; i < bytes.length; i += CHUNK) {
            var end = Math.min(i + CHUNK, bytes.length);
            for (var j = i; j < end; j++) {
                str += String.fromCharCode(bytes[j]);
            }
        }
        return btoa(str);
    }

    /**
     * Toggle ANSI editor modal for a given textarea element.
     * Opens the editor in a draggable/resizable window.
     */
    function launchAnsiEditor(textarea, onFinish) {
        if (!window.AnsiEditorModal) {
            console.error('AnsiEditorModal not loaded');
            return;
        }

        // If modal is already open, close it (toggle behaviour)
        if (AnsiEditorModal.isOpen) {
            AnsiEditorModal.close();
            var toggleBtn = textarea.parentNode.querySelector('.ansi-editor-toggle');
            setToggleButtonState(toggleBtn, false);
            return;
        }

        var originalText = textarea.value;
        var originalWasAnsi = textarea.dataset.ansi === '1';
        var toggleBtn = textarea.parentNode.querySelector('.ansi-editor-toggle');
        setToggleButtonState(toggleBtn, true);

        AnsiEditorModal.open({
            title: 'ANSI Art Editor',
            columns: 79,
            rows: 25,
            fontUrl: './fonts/ansi-editor/IBM VGA.F16',
            onDone: function (editor) {
                if (editor && editor.doc) {
                    // Get raw ANSI bytes from the document
                    var ansiBytes = editor.doc.toAnsi ? editor.doc.toAnsi() : null;
                    if (ansiBytes) {
                        var base64 = ansiBytesToBase64(ansiBytes);
                        textarea.value = base64;
                        textarea.dataset.ansi = '1';
                    }
                }
                setToggleButtonState(toggleBtn, false);
                if (typeof onFinish === 'function') onFinish(true, textarea.value);
            },
            onCancel: function () {
                // Restore original state
                textarea.value = originalText;
                if (originalWasAnsi) {
                    textarea.dataset.ansi = '1';
                } else {
                    delete textarea.dataset.ansi;
                }
                setToggleButtonState(toggleBtn, false);
                if (typeof onFinish === 'function') onFinish(false);
            }
        });
    }

    // Expose to global scope for onclick handlers
    window.launchAnsiEditor = launchAnsiEditor;

})();
