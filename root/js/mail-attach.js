/* mail-attach.js — attachments for the web mail composer (new message and reply).
 *
 * Files come from the "browse" picker or are dropped anywhere on the compose
 * box. Each one starts uploading straight away, sliced into base64 chunks
 * posted to api/mail-attach.ssjs (the server only sees request bodies up to
 * 4 MiB). The finished staging ids ride along with the send
 * (forum.ssjs?call=post / post-reply, `attach=`), and the server MIME-encodes
 * them into the message.
 *
 *   var ctl = MailAttach.mount(boxEl);   // adds the attach strip to boxEl
 *   ctl.busy()  -> true while anything is still uploading
 *   ctl.ids()   -> staging ids of the finished uploads
 */
(function () {
    'use strict';
    if (window.MailAttach) return;

    var ENDPOINT = './api/mail-attach.ssjs';
    var MAX_TOTAL_MB = 10;        /* mirrors lib/mail-attach-lib.js */
    var MAX_FILES = 10;

    function formatBytes(bytes) {
        var value = Number(bytes) || 0;
        if (value >= 1048576) return (value / 1048576).toFixed(1) + ' MB';
        if (value >= 1024) return Math.round(value / 1024) + ' KB';
        return value + ' B';
    }

    function csrfToken() {
        return (window.sbbsConfig && window.sbbsConfig.csrfToken)
            ? String(window.sbbsConfig.csrfToken) : '';
    }

    function call(query, body) {
        return fetch(ENDPOINT + '?' + query, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'x-csrf-token': csrfToken()
            },
            body: body === undefined ? '' : body
        }).then(function (response) { return response.json(); });
    }

    /* Chunked so String.fromCharCode.apply never sees a multi-megabyte
       argument list. */
    function bytesToBase64(bytes) {
        var STEP = 0x8000;
        var parts = [];
        for (var i = 0; i < bytes.length; i += STEP) {
            parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + STEP)));
        }
        return btoa(parts.join(''));
    }

    function sliceToBase64(file, start, end) {
        var blob = file.slice(start, end);
        if (blob.arrayBuffer) {
            return blob.arrayBuffer().then(function (buffer) {
                return bytesToBase64(new Uint8Array(buffer));
            });
        }
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(bytesToBase64(new Uint8Array(reader.result))); };
            reader.onerror = function () { reject(reader.error); };
            reader.readAsArrayBuffer(blob);
        });
    }

    function hasFiles(evt) {
        var types = evt.dataTransfer && evt.dataTransfer.types;
        if (!types) return false;
        for (var i = 0; i < types.length; i += 1) {
            if (types[i] === 'Files') return true;
        }
        return false;
    }

    function mount(box) {
        var items = [];
        var dragDepth = 0;

        var strip = document.createElement('div');
        strip.className = 'mail-attach';
        strip.innerHTML =
            '<div class="mail-attach-drop">' +
                '<span class="mail-attach-label">Attachments:</span> ' +
                'drop files here or <button type="button" class="mail-attach-browse">browse&hellip;</button>' +
                '<span class="mail-attach-hint">up to ' + MAX_TOTAL_MB + ' MB total</span>' +
            '</div>' +
            '<input type="file" class="mail-attach-input" multiple hidden>' +
            '<ul class="mail-attach-list"></ul>' +
            '<div class="mail-attach-error" hidden></div>';
        var input = strip.querySelector('.mail-attach-input');
        var list = strip.querySelector('.mail-attach-list');
        var errorEl = strip.querySelector('.mail-attach-error');

        /* Sits just above the Submit button. */
        var submit = box.querySelector('input[type="submit"], button[type="submit"], .btn-primary');
        var anchor = submit;
        while (anchor && anchor.parentNode !== box) anchor = anchor.parentNode;
        box.insertBefore(strip, anchor || null);

        function showError(msg) {
            errorEl.textContent = msg || '';
            errorEl.hidden = !msg;
        }

        function totalBytes() {
            return items.reduce(function (sum, it) { return it.state === 'error' ? sum : sum + it.file.size; }, 0);
        }

        function render(it) {
            it.el.setAttribute('data-state', it.state);
            it.el.querySelector('.mail-attach-size').textContent =
                it.state === 'uploading'
                    ? formatBytes(it.sent) + ' / ' + formatBytes(it.file.size)
                    : formatBytes(it.file.size);
            it.el.querySelector('.mail-attach-fill').style.width =
                (it.state === 'done' ? 100 : Math.round(100 * it.sent / Math.max(1, it.file.size))) + '%';
            it.el.querySelector('.mail-attach-msg').textContent = it.state === 'error' ? it.error : '';
        }

        function remove(it) {
            it.cancelled = true;
            if (it.id) call('action=abort&id=' + encodeURIComponent(it.id)).catch(function () { });
            items = items.filter(function (x) { return x !== it; });
            if (it.el.parentNode) it.el.parentNode.removeChild(it.el);
        }

        function upload(it) {
            call('action=begin&name=' + encodeURIComponent(it.file.name) + '&size=' + it.file.size)
                .then(function (res) {
                    if (!res || !res.ok) throw new Error((res && res.error) || 'Upload refused.');
                    if (it.cancelled) {
                        call('action=abort&id=' + encodeURIComponent(res.id)).catch(function () { });
                        return;
                    }
                    it.id = res.id;
                    if (res.name) it.el.querySelector('.mail-attach-name').textContent = res.name;
                    var size = res.chunkSize;
                    var seq = 0;
                    function next() {
                        if (it.cancelled) return null;
                        var start = seq * size;
                        if (start >= it.file.size) return null;
                        var end = Math.min(it.file.size, start + size);
                        return sliceToBase64(it.file, start, end).then(function (b64) {
                            if (it.cancelled) return null;
                            return call('action=chunk&id=' + encodeURIComponent(it.id) + '&seq=' + seq, b64);
                        }).then(function (r) {
                            if (r === null) return null;
                            if (!r || !r.ok) throw new Error((r && r.error) || 'Upload failed.');
                            it.sent = r.received;
                            seq += 1;
                            render(it);
                            return next();
                        });
                    }
                    return next();
                })
                .then(function () {
                    if (it.cancelled) return;
                    it.state = 'done';
                    render(it);
                })
                .catch(function (err) {
                    if (it.cancelled) return;
                    it.state = 'error';
                    it.error = err && err.message ? err.message : 'Upload failed.';
                    it.id = null;
                    render(it);
                });
        }

        function add(fileList) {
            showError('');
            for (var i = 0; i < fileList.length; i += 1) {
                var file = fileList[i];
                if (items.length >= MAX_FILES) {
                    showError('At most ' + MAX_FILES + ' attachments per message.');
                    break;
                }
                if (!file.size) {
                    showError(file.name + ' is empty (folders cannot be attached).');
                    continue;
                }
                if (totalBytes() + file.size > MAX_TOTAL_MB * 1048576) {
                    showError(file.name + ' would put this message over the ' + MAX_TOTAL_MB + ' MB limit.');
                    continue;
                }
                var li = document.createElement('li');
                li.className = 'mail-attach-item';
                li.innerHTML =
                    '<div class="mail-attach-head">' +
                        '<span class="mail-attach-name"></span>' +
                        '<span class="mail-attach-size"></span>' +
                        '<button type="button" class="mail-attach-remove" title="Remove">&times;</button>' +
                    '</div>' +
                    '<div class="mail-attach-bar"><div class="mail-attach-fill"></div></div>' +
                    '<div class="mail-attach-msg"></div>';
                li.querySelector('.mail-attach-name').textContent = file.name;
                var it = { file: file, el: li, state: 'uploading', sent: 0, id: null, error: '' };
                li.querySelector('.mail-attach-remove').addEventListener('click', remove.bind(null, it));
                items.push(it);
                list.appendChild(li);
                render(it);
                upload(it);
            }
        }

        strip.querySelector('.mail-attach-browse').addEventListener('click', function () { input.click(); });
        input.addEventListener('change', function () {
            add(input.files);
            input.value = '';
        });

        /* The whole compose box is the drop target. */
        box.addEventListener('dragenter', function (evt) {
            if (!hasFiles(evt)) return;
            evt.preventDefault();
            dragDepth += 1;
            box.classList.add('mail-attach-dragover');
        });
        box.addEventListener('dragover', function (evt) {
            if (!hasFiles(evt)) return;
            evt.preventDefault();
            evt.dataTransfer.dropEffect = 'copy';
        });
        box.addEventListener('dragleave', function (evt) {
            if (!hasFiles(evt)) return;
            dragDepth = Math.max(0, dragDepth - 1);
            if (!dragDepth) box.classList.remove('mail-attach-dragover');
        });
        box.addEventListener('drop', function (evt) {
            if (!hasFiles(evt)) return;
            evt.preventDefault();
            dragDepth = 0;
            box.classList.remove('mail-attach-dragover');
            add(evt.dataTransfer.files);
        });

        return {
            busy: function () {
                return items.some(function (it) { return it.state === 'uploading'; });
            },
            failed: function () {
                return items.some(function (it) { return it.state === 'error'; });
            },
            ids: function () {
                return items.filter(function (it) { return it.state === 'done' && it.id; })
                    .map(function (it) { return it.id; });
            },
            showError: showError
        };
    }

    window.MailAttach = { mount: mount };
})();
