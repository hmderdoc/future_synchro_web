/* chat-upload.js — drag-and-drop media uploads for the web chat.
 *
 * The server can only see a request body up to 4 MiB (MAX_POST_LEN in
 * websrvr.cpp), so a file is sliced here and posted as base64 chunks to
 * api/chat-upload.ssjs, which appends them through File.base64. Chunk size
 * comes from the server's `begin` reply and is a multiple of 3 bytes so the
 * base64 seams decode cleanly.
 *
 * When the upload (and, for video, the conversion) finishes, the resulting URL
 * is handed to the page's `send` callback, which puts it in the compose box so
 * the user can add text around it before sending. The compose box is never
 * blocked while the upload runs — normal typing and sending keep working,
 * which matters because a big video can take the better part of a minute to
 * convert.
 *
 * Only one video may be in flight per user: conversion is the expensive thing
 * this box does, and the server enforces the same rule for the second-tab case.
 */
(function () {
    'use strict';
    if (window.ChatUpload) return;

    var ENDPOINT = './api/chat-upload.ssjs';

    /* Mirrors the server's TYPES table. Checked here only so an obviously wrong
       drop fails instantly instead of after a 100 MB upload; the server's copy
       is the one that actually decides. */
    var KINDS = {
        png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
        mp3: 'audio', m4a: 'audio', ogg: 'audio', oga: 'audio', wav: 'audio', flac: 'audio',
        mp4: 'video', m4v: 'video', mov: 'video', webm: 'video',
        ans: 'ansi', asc: 'ansi', nfo: 'ansi'
    };

    var MAX_BYTES = {
        image: 20 * 1024 * 1024,
        audio: 20 * 1024 * 1024,
        video: 100 * 1024 * 1024,
        ansi: 1 * 1024 * 1024
    };

    var _options = null;
    var _host = null;
    var _queue = [];
    var _active = null;
    var _videoInFlight = false;
    var _seq = 0;

    /* ------------------------------------------------------------- helpers */

    function extOf(name) {
        var match = /\.([A-Za-z0-9]{1,4})$/.exec(String(name || ''));
        return match ? match[1].toLowerCase() : '';
    }

    function kindOf(name) {
        return KINDS[extOf(name)] || '';
    }

    function formatBytes(bytes) {
        var value = Number(bytes) || 0;
        if (value >= 1048576) return (value / 1048576).toFixed(1) + ' MB';
        if (value >= 1024) return Math.round(value / 1024) + ' KB';
        return value + ' B';
    }

    function escapeHtml(str) {
        return String(str === undefined || str === null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function csrfToken() {
        return (window.sbbsConfig && window.sbbsConfig.csrfToken)
            ? String(window.sbbsConfig.csrfToken) : '';
    }

    function postJSON(query, body) {
        return fetch(ENDPOINT + '?' + query, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'x-csrf-token': csrfToken()
            },
            body: body === undefined ? '' : body
        }).then(function (response) {
            return response.json();
        });
    }

    /* Chunked so String.fromCharCode.apply never sees a multi-megabyte
       argument list. */
    function bytesToBase64(bytes) {
        var STEP = 0x8000;
        var parts = [];
        var i;
        for (i = 0; i < bytes.length; i += STEP) {
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

    /* ---------------------------------------------------------- chip in DOM */

    function ensureHost() {
        if (_host && _host.parentNode) return _host;
        if (!_options || !_options.chipHost) return null;
        _host = document.createElement('div');
        _host.className = 'chat-upload-strip';
        _options.chipHost.insertBefore(_host, _options.chipHost.firstChild);
        return _host;
    }

    function makeChip(job) {
        var host = ensureHost();
        var chip = document.createElement('div');
        if (!host) return null;
        chip.className = 'chat-upload-chip';
        chip.setAttribute('data-state', 'queued');
        chip.innerHTML =
            '<div class="chat-upload-chip-head">' +
                '<span class="chat-upload-chip-name"></span>' +
                '<span class="chat-upload-chip-size"></span>' +
                '<button type="button" class="chat-upload-chip-cancel" title="Cancel">&times;</button>' +
            '</div>' +
            '<div class="chat-upload-bar"><div class="chat-upload-bar-fill"></div></div>' +
            '<div class="chat-upload-note"></div>';
        chip.querySelector('.chat-upload-chip-name').textContent = job.file.name;
        chip.querySelector('.chat-upload-chip-size').textContent = formatBytes(job.file.size);
        chip.querySelector('.chat-upload-chip-cancel').addEventListener('click', function () {
            cancelJob(job);
        });
        host.appendChild(chip);
        return chip;
    }

    function setChip(job, state, percent, noteHtml) {
        if (!job.chip) return;
        job.chip.setAttribute('data-state', state);
        if (percent !== null && percent !== undefined) {
            job.chip.querySelector('.chat-upload-bar-fill').style.width = Math.max(0, Math.min(100, percent)) + '%';
        }
        if (noteHtml !== undefined) {
            job.chip.querySelector('.chat-upload-note').innerHTML = noteHtml;
        }
    }

    function removeChip(job, delay) {
        if (!job.chip) return;
        window.setTimeout(function () {
            if (job.chip && job.chip.parentNode) job.chip.parentNode.removeChild(job.chip);
            job.chip = null;
            if (_host && !_host.childNodes.length && _host.parentNode) {
                _host.parentNode.removeChild(_host);
                _host = null;
            }
        }, delay || 0);
    }

    /* The note the user actually reads while a video is converting. It names
       the cost AND the way to avoid it next time, because pre-encoding is
       better for them (instant post) and for this box (no ffmpeg run). */
    var CONVERT_TIP =
        '<em>Converting video&hellip; This one has to be re-encoded before it can post. ' +
        'An MP4 that is already 720p or smaller, H.264 + AAC, and under 15 seconds ' +
        'posts straight away with no conversion at all.</em>';

    function convertedNote(result) {
        var bits = [];
        if (result.reason) bits.push(escapeHtml(result.reason));
        return '<em>Converted' + (bits.length ? ' (' + bits.join('; ') + ')' : '') + '. ' +
            escapeHtml(formatBytes(result.sourceBytes)) + ' &rarr; ' + escapeHtml(formatBytes(result.bytes)) +
            '. Pre-encoding to 720p H.264 next time skips this step.</em>';
    }

    /* --------------------------------------------------------------- upload */

    function cancelJob(job) {
        job.cancelled = true;
        if (job.id) {
            postJSON('action=abort&id=' + encodeURIComponent(job.id)).catch(function () { });
        }
        if (job.kind === 'video') _videoInFlight = false;
        setChip(job, 'error', 0, '<em>Cancelled.</em>');
        removeChip(job, 1500);
        if (_active === job) {
            _active = null;
            pump();
        }
    }

    function failJob(job, message) {
        if (job.kind === 'video') _videoInFlight = false;
        setChip(job, 'error', 100, '<em>' + escapeHtml(message) + '</em>');
        removeChip(job, 6000);
        if (_active === job) {
            _active = null;
            pump();
        }
    }

    function uploadChunks(job) {
        var offset = 0;

        function next() {
            if (job.cancelled) return Promise.resolve(null);
            if (offset >= job.file.size) return Promise.resolve(true);

            var end = Math.min(offset + job.chunkSize, job.file.size);
            var start = offset;

            return sliceToBase64(job.file, start, end).then(function (b64) {
                if (job.cancelled) return null;
                return postJSON(
                    'action=chunk&id=' + encodeURIComponent(job.id) + '&seq=' + job.seq,
                    b64
                );
            }).then(function (reply) {
                if (reply === null || job.cancelled) return null;
                if (!reply || !reply.ok) {
                    throw new Error((reply && reply.error) || 'Upload failed.');
                }
                offset = end;
                job.seq += 1;
                setChip(job, 'uploading', (offset / job.file.size) * 100,
                    '<em>Uploading&hellip; ' + Math.round((offset / job.file.size) * 100) + '%</em>');
                return next();
            });
        }

        return next();
    }

    /* `finish` is refused while both encoder slots are busy. That is a queue,
       not an error, so wait it out rather than losing the upload. */
    var FINISH_RETRIES = 40;
    var FINISH_RETRY_MS = 5000;

    function finishJob(job, attempt) {
        return postJSON('action=finish&id=' + encodeURIComponent(job.id)).then(function (result) {
            if (job.cancelled) return null;
            if (result && !result.ok && result.retry && attempt < FINISH_RETRIES) {
                setChip(job, 'converting', 100, '<em>Waiting for a free encoder slot&hellip;</em>');
                return new Promise(function (resolve) {
                    window.setTimeout(function () {
                        resolve(finishJob(job, attempt + 1));
                    }, FINISH_RETRY_MS);
                });
            }
            return result;
        });
    }

    function runJob(job) {
        job.chip = makeChip(job);
        setChip(job, 'uploading', 0, '<em>Starting&hellip;</em>');

        postJSON('action=begin&name=' + encodeURIComponent(job.file.name) +
                 '&size=' + job.file.size)
            .then(function (reply) {
                if (job.cancelled) return null;
                if (!reply || !reply.ok) throw new Error((reply && reply.error) || 'Upload rejected.');
                job.id = reply.id;
                job.chunkSize = reply.chunkSize;
                job.seq = 0;
                return uploadChunks(job);
            })
            .then(function (done) {
                if (!done || job.cancelled) return null;
                /* Conversion happens inside `finish`, so this request is the
                   slow one for video. The chip explains the wait. */
                setChip(job, job.kind === 'video' ? 'converting' : 'posting', 100,
                    job.kind === 'video' ? CONVERT_TIP : '<em>Finishing&hellip;</em>');
                return finishJob(job, 0);
            })
            .then(function (result) {
                if (result === null || job.cancelled) return;
                if (!result || !result.ok) throw new Error((result && result.error) || 'Upload failed.');

                if (job.kind === 'video') _videoInFlight = false;

                setChip(job, 'done', 100,
                    result.transcoded ? convertedNote(result) : '<em>Ready &mdash; add a message and press Enter.</em>');
                removeChip(job, result.transcoded ? 9000 : 1200);

                if (_options && typeof _options.send === 'function') {
                    _options.send(result.url);
                }

                _active = null;
                pump();
            })
            .catch(function (error) {
                failJob(job, (error && error.message) || 'Upload failed.');
            });
    }

    function pump() {
        if (_active) return;
        /* A job cancelled while it was still queued must not be started: it
           would open an upload on the server that nothing will ever finish. */
        while (_queue.length && _queue[0].cancelled) {
            _queue.shift();
        }
        if (!_queue.length) return;
        _active = _queue.shift();
        runJob(_active);
    }

    /* ---------------------------------------------------------------- entry */

    function enqueue(file) {
        var kind = kindOf(file.name);
        var job;

        if (!kind) {
            notify('"' + file.name + '" is not a type chat can show.');
            return;
        }
        if (file.size > MAX_BYTES[kind]) {
            notify('"' + file.name + '" is ' + formatBytes(file.size) + ' — the limit for ' +
                kind + ' is ' + formatBytes(MAX_BYTES[kind]) + '.');
            return;
        }
        if (kind === 'video' && _videoInFlight) {
            notify('One video at a time — wait for the current one to finish converting.');
            return;
        }
        if (kind === 'video') _videoInFlight = true;

        _seq += 1;
        job = {
            key: _seq,
            file: file,
            kind: kind,
            id: null,
            seq: 0,
            chunkSize: 1998000,
            chip: null,
            cancelled: false
        };
        _queue.push(job);
        pump();
    }

    /* Rejections land as a transient chip in the same strip the uploads use:
       that is where the user is already looking, and it avoids borrowing the
       connection-status bar, whose messages would get clobbered. */
    function notify(message) {
        var host = ensureHost();
        var chip;
        if (_options && typeof _options.notify === 'function') {
            _options.notify(message);
            return;
        }
        if (!host) {
            window.alert(message);
            return;
        }
        chip = document.createElement('div');
        chip.className = 'chat-upload-chip';
        chip.setAttribute('data-state', 'error');
        chip.innerHTML = '<div class="chat-upload-note"></div>';
        chip.querySelector('.chat-upload-note').innerHTML = '<em>' + escapeHtml(message) + '</em>';
        host.appendChild(chip);
        window.setTimeout(function () {
            if (chip.parentNode) chip.parentNode.removeChild(chip);
            if (_host && !_host.childNodes.length && _host.parentNode) {
                _host.parentNode.removeChild(_host);
                _host = null;
            }
        }, 6000);
    }

    function handleFiles(list) {
        var i;
        if (!list) return;
        for (i = 0; i < list.length; i += 1) {
            enqueue(list[i]);
        }
    }

    /* ------------------------------------------------------------ drop zone */

    function bindDropZone(target) {
        var depth = 0;

        function show() {
            target.classList.add('chat-upload-dragover');
        }

        function hide() {
            target.classList.remove('chat-upload-dragover');
        }

        target.addEventListener('dragenter', function (event) {
            /* Ignore text/selection drags — only a real file drag counts. */
            if (!event.dataTransfer || event.dataTransfer.types.indexOf('Files') < 0) return;
            event.preventDefault();
            depth += 1;
            show();
        });

        target.addEventListener('dragover', function (event) {
            if (!event.dataTransfer || event.dataTransfer.types.indexOf('Files') < 0) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        });

        target.addEventListener('dragleave', function () {
            depth -= 1;
            if (depth <= 0) {
                depth = 0;
                hide();
            }
        });

        target.addEventListener('drop', function (event) {
            if (!event.dataTransfer || event.dataTransfer.types.indexOf('Files') < 0) return;
            event.preventDefault();
            depth = 0;
            hide();
            handleFiles(event.dataTransfer.files);
        });
    }

    function init(options) {
        _options = options || {};
        if (_options.dropTarget) bindDropZone(_options.dropTarget);
        if (_options.pasteTarget) {
            _options.pasteTarget.addEventListener('paste', function (event) {
                var items = event.clipboardData && event.clipboardData.files;
                if (!items || !items.length) return;
                event.preventDefault();
                handleFiles(items);
            });
        }
    }

    window.ChatUpload = {
        init: init,
        handleFiles: handleFiles,
        kindOf: kindOf,
        formatBytes: formatBytes
    };
}());
