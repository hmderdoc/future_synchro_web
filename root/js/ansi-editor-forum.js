/**
 * ANSI Editor <-> Forum integration
 *
 * Adds an "ANSI Art" toggle button next to compose textareas.
 * When active, replaces the textarea with the full ANSI editor.
 * On Done, base64-encodes the raw CP437 ANSI bytes and puts the
 * result in the textarea.  The server decodes and stores raw bytes
 * — no Unicode, no UTF-8 charset headers — just like a BBS post.
 */

(function () {
    'use strict';

    /**
     * Convert ANSI byte array (Uint8Array) to a base64 string.
     * Raw CP437 bytes go in; pure ASCII base64 comes out.
     * No Unicode anywhere in the pipeline.
     */
    function ansiBytesToBase64(bytes) {
        // btoa() works on Latin-1 strings (charCode 0-255)
        var str = '';
        // Process in chunks to avoid call-stack limits on large arrays
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
     * Toggle ANSI editor for a given textarea element.
     * Creates a container div that swaps in/out with the textarea.
     */
    function launchAnsiEditor(textarea, onFinish) {
        if (!window.AnsiEditor) {
            console.error('AnsiEditor not loaded');
            return;
        }

        // Save original textarea content
        var originalText = textarea.value;

        // Create editor container
        var container = document.createElement('div');
        container.className = 'ansi-editor-container';
        container.style.cssText = 'width:100%;height:480px;border:1px solid #45475a;border-radius:4px;overflow:hidden;margin:0.5em 0;';

        // Hide the textarea, insert editor container
        textarea.style.display = 'none';
        textarea.parentNode.insertBefore(container, textarea);

        // Find the ANSI art toggle button and update its state
        var toggleBtn = textarea.parentNode.querySelector('.ansi-editor-toggle');
        if (toggleBtn) {
            toggleBtn.textContent = 'Text Mode';
            toggleBtn.classList.add('btn-warning');
            toggleBtn.classList.remove('btn-default');
        }

        AnsiEditor.create({
            container: container,
            columns: 80,
            rows: 25,
            fontUrl: './fonts/ansi-editor/IBM VGA.F16',
            onDone: function (ansiBytes) {
                // Base64-encode the raw CP437 bytes for transport.
                // The server will base64_decode() and store raw bytes
                // without UTF-8 headers.
                var base64 = ansiBytesToBase64(ansiBytes);
                textarea.value = base64;
                // Mark this textarea as containing base64 ANSI data
                textarea.dataset.ansi = '1';
                container.remove();
                textarea.style.display = '';
                if (toggleBtn) {
                    toggleBtn.textContent = 'ANSI Art';
                    toggleBtn.classList.remove('btn-warning');
                    toggleBtn.classList.add('btn-default');
                }
                if (onFinish) onFinish(true, base64);
            },
            onCancel: function () {
                textarea.value = originalText;
                delete textarea.dataset.ansi;
                container.remove();
                textarea.style.display = '';
                if (toggleBtn) {
                    toggleBtn.textContent = 'ANSI Art';
                    toggleBtn.classList.remove('btn-warning');
                    toggleBtn.classList.add('btn-default');
                }
                if (onFinish) onFinish(false);
            }
        }).catch(function (err) {
            console.error('ANSI Editor error:', err);
            container.remove();
            textarea.style.display = '';
        });
    }

    // Expose to global scope for onclick handlers
    window.launchAnsiEditor = launchAnsiEditor;

})();
