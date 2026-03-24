/**
 * bin-avatar-upload.js — AI Definition creator/editor for local-aidefinitions
 *
 * Only loaded on the "local-aidefinitions" sub-board (via 001-forum.xjs).
 * Transforms the standard forum posting UI into a guided AI-definition
 * creator with:
 *   - Subject field re-labelled "Bot Name" with yellow hint
 *   - Dynamic summon/dismiss hint below Subject (CGA-coloured)
 *   - "To" field hidden (defaults to "All")
 *   - Dedicated avatar .bin upload (flex row: preview left, dropzone right)
 *   - Separate "AI System Prompt" textarea
 *   - Hidden raw message body assembled from avatar_data block + prompt
 *   - Validation: new post requires avatar + prompt; reply requires at
 *     least one of the two
 *   - Quote button removed on replies
 *   - Signature cleared on initial load
 *   - Submit button reads "Create Bot" for new posts
 */
(function () {

    /* ---- constants ---- */
    var AVATAR_COLS = 10;
    var AVATAR_ROWS = 6;
    var AVATAR_BYTES = AVATAR_COLS * AVATAR_ROWS * 2; // char+attr = 120

    /* ---- low-level helpers ---- */

    function arrayBufferToBase64(buf) {
        var bytes = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    function arrayBufferToBinaryString(buf) {
        var bytes = new Uint8Array(buf);
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return s;
    }

    /** Strip SAUCE (+ optional COMNT block + 0x1A EOF marker) from a .bin */
    function stripSAUCE(buffer) {
        var bytes = new Uint8Array(buffer);
        var len = bytes.length;
        if (len < 128) return buffer;
        var so = len - 128;
        if (bytes[so] === 0x53 && bytes[so+1] === 0x41 &&
            bytes[so+2] === 0x55 && bytes[so+3] === 0x43 && bytes[so+4] === 0x45) {
            var cl = bytes[so + 104];
            var cut = so;
            if (cl > 0) {
                var cs = 5 + cl * 64;
                var co = so - cs;
                if (co >= 0 && bytes[co] === 0x43 && bytes[co+1] === 0x4F &&
                    bytes[co+2] === 0x4D && bytes[co+3] === 0x4E && bytes[co+4] === 0x54) {
                    cut = co;
                }
            }
            if (cut > 0 && bytes[cut - 1] === 0x1A) cut--;
            return buffer.slice(0, cut);
        }
        return buffer;
    }

    /** Build the multi-line avatar_data block (72-char lines for word_wrap safety) */
    function buildAvatarBlock(b64) {
        var lines = [];
        for (var i = 0; i < b64.length; i += 72) lines.push(b64.substring(i, i + 72));
        return 'avatar_data_begin\n' + lines.join('\n') + '\navatar_data_end';
    }

    /** Assemble the hidden message body from avatar + prompt */
    function assembleBody(avatarB64, promptText) {
        var parts = [];
        if (avatarB64) parts.push(buildAvatarBlock(avatarB64));
        if (promptText && promptText.trim()) parts.push(promptText.trim());
        return parts.join('\n');
    }

    /** Hide an element and its immediately following <br> sibling */
    function hideWithBr(el) {
        el.style.display = 'none';
        var sib = el.nextSibling;
        while (sib && sib.nodeType === 3) sib = sib.nextSibling;
        if (sib && sib.tagName === 'BR') sib.style.display = 'none';
    }

    /** Build the CGA-coloured summon/dismiss hint HTML for a given bot name */
    function buildSummonHintHTML(name) {
        var cyan = 'var(--cga-bright-cyan)';
        var white = 'var(--cga-white)';
        var yellow = 'var(--cga-yellow)';
        var red = 'var(--cga-bright-red)';
        return '<span style="color:' + cyan + '">You can summon this bot using </span>' +
            '<span style="color:' + white + '">&ldquo;</span>' +
            '<span style="color:' + yellow + '">$' + name + '</span>' +
            '<span style="color:' + white + '">&rdquo;</span>' +
            '<span style="color:' + cyan + '">. You can dismiss this bot using </span>' +
            '<span style="color:' + white + '">&ldquo;</span>' +
            '<span style="color:' + red + '">%' + name + '</span>' +
            '<span style="color:' + white + '">&rdquo;</span>';
    }

    /* ================================================================
     * buildAvatarRow — flex container: preview (left) | dropzone (right)
     * ================================================================ */
    function buildAvatarRow() {
        var row = document.createElement('div');
        row.className = 'aidef-avatar-row';

        /* -- preview (left) -- */
        var previewBox = document.createElement('div');
        previewBox.className = 'aidef-avatar-preview';

        var canvas = document.createElement('div');
        canvas.className = 'aidef-avatar-canvas';

        var placeholder = document.createElement('div');
        placeholder.className = 'aidef-avatar-placeholder';
        placeholder.textContent = 'No Avatar';

        previewBox.appendChild(canvas);
        previewBox.appendChild(placeholder);

        /* -- dropzone (right) -- */
        var dz = document.createElement('div');
        dz.className = 'aidef-dropzone';

        var inner = document.createElement('div');
        inner.className = 'aidef-dropzone-inner';

        var icon = document.createElement('span');
        icon.className = 'aidef-dropzone-icon';
        icon.innerHTML = '&#x2B07;';

        var label = document.createElement('span');
        label.className = 'aidef-dropzone-label';
        label.textContent = 'Drop .bin avatar here';

        var browseBtn = document.createElement('button');
        browseBtn.type = 'button';
        browseBtn.className = 'btn btn-sm btn-default aidef-browse-btn';
        browseBtn.textContent = 'Browse\u2026';

        var removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn-xs btn-danger aidef-remove-btn';
        removeBtn.textContent = 'Remove';
        removeBtn.style.display = 'none';

        inner.appendChild(icon);
        inner.appendChild(label);
        inner.appendChild(browseBtn);
        inner.appendChild(removeBtn);
        dz.appendChild(inner);

        row.appendChild(previewBox);
        row.appendChild(dz);

        /* File input — lives on document.body so it doesn't pollute
           the form's getElementsByTagName('input') indices. */
        var fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.bin';
        fileInput.style.display = 'none';
        document.body.appendChild(fileInput);

        /* browse button opens the picker */
        browseBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            fileInput.click();
        });

        /* drag visual feedback */
        dz.addEventListener('dragover', function (e) {
            e.preventDefault(); e.stopPropagation();
            dz.classList.add('aidef-dragover');
        });
        dz.addEventListener('dragleave', function (e) {
            e.preventDefault(); e.stopPropagation();
            dz.classList.remove('aidef-dragover');
        });

        return {
            row: row,
            previewBox: previewBox,
            canvas: canvas,
            placeholder: placeholder,
            dz: dz,
            fileInput: fileInput,
            removeBtn: removeBtn,
        };
    }

    /* ================================================================
     * wireFileHandling — connect file events to avatar state + preview
     * ================================================================ */
    function wireFileHandling(parts, state, container) {
        var fileInput = parts.fileInput;
        var removeBtn = parts.removeBtn;
        var canvas = parts.canvas;
        var placeholder = parts.placeholder;
        var previewBox = parts.previewBox;
        var dz = parts.dz;

        function processFile(file) {
            if (!file) return;
            if (!file.name.toLowerCase().endsWith('.bin')) {
                showErrors(container, ['Please select an ANSI .bin file.']);
                return;
            }
            var reader = new FileReader();
            reader.onload = function (evt) {
                var buf = stripSAUCE(evt.target.result);
                var bytes = buf.byteLength;
                var cols, rows;
                if (bytes === AVATAR_BYTES)       { cols = AVATAR_COLS; rows = AVATAR_ROWS; }
                else if (bytes % 20 === 0)        { cols = 10; rows = bytes / 20; }
                else if (bytes % 160 === 0)       { cols = 80; rows = bytes / 160; }
                else                              { cols = 80; rows = Math.ceil(bytes / 160); }

                state.avatarB64 = arrayBufferToBase64(buf);

                canvas.innerHTML = '';
                var gc = GraphicsConverter.shared();
                gc.from_bin(arrayBufferToBinaryString(buf), cols, rows, function (img) {
                    canvas.appendChild(img);
                });

                placeholder.style.display = 'none';
                previewBox.classList.add('has-avatar');
                removeBtn.style.display = '';

                var req = container.querySelector('.aidef-required-indicator');
                if (req) req.style.display = 'none';
                clearErrors(container);
            };
            reader.readAsArrayBuffer(file);
        }

        fileInput.addEventListener('change', function () {
            if (fileInput.files && fileInput.files[0]) processFile(fileInput.files[0]);
        });

        /* drop handler */
        dz.addEventListener('drop', function (e) {
            e.preventDefault(); e.stopPropagation();
            dz.classList.remove('aidef-dragover');
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                processFile(e.dataTransfer.files[0]);
            }
        });

        removeBtn.addEventListener('click', function () {
            state.avatarB64 = null;
            canvas.innerHTML = '';
            placeholder.style.display = '';
            previewBox.classList.remove('has-avatar');
            removeBtn.style.display = 'none';
            fileInput.value = '';
            var req = container.querySelector('.aidef-required-indicator');
            if (req) req.style.display = '';
        });
    }

    /* ---- validation helpers ---- */
    function showErrors(container, msgs) {
        clearErrors(container);
        var div = document.createElement('div');
        div.className = 'aidef-validation-errors';
        msgs.forEach(function (m) {
            var p = document.createElement('p');
            p.textContent = '\u26A0 ' + m;
            div.appendChild(p);
        });
        var btn = container.querySelector('input[type="submit"]');
        if (btn) btn.parentNode.insertBefore(div, btn);
        else container.appendChild(div);
    }

    function clearErrors(container) {
        var el = container.querySelector('.aidef-validation-errors');
        if (el) el.remove();
    }

    /* ================================================================
     * transformNewPostForm  — new thread = new AI definition
     * ================================================================ */
    function transformNewPostForm(container) {
        var inputs = container.getElementsByTagName('input');
        var textarea = container.getElementsByTagName('textarea')[0];
        if (!textarea || inputs.length < 3) return;

        container.classList.add('aidef-form');

        var toField      = inputs[0];
        var subjectField = inputs[1];
        var submitBtn    = inputs[2];

        var state = { avatarB64: null };

        /* 1  Hide "To" and default to All */
        toField.value = 'All';
        hideWithBr(toField);

        /* 2  Clear + hide original textarea (becomes our hidden body) */
        textarea.value = '';
        hideWithBr(textarea);

        /* 3  Yellow bot-name hint above Subject */
        var hint = document.createElement('div');
        hint.className = 'aidef-hint';
        hint.innerHTML =
            'Set the Subject as your bot\u2019s name for summoning. ' +
            'For example, if you wanted a bot named ' +
            '<strong>\u201CJoshua\u201D</strong> set the Subject to ' +
            '<strong>\u201CJoshua\u201D</strong>';
        subjectField.parentNode.insertBefore(hint, subjectField);
        subjectField.setAttribute('placeholder', 'Bot Name (required)');

        /* 3b  Dynamic summon/dismiss hint below Subject (hidden until dirty) */
        var summonHint = document.createElement('div');
        summonHint.className = 'aidef-summon-hint';
        summonHint.style.display = 'none';
        /* insert after the subject field (skip past its trailing <br>) */
        var afterSubject = subjectField.nextSibling;
        while (afterSubject && afterSubject.nodeType === 3) afterSubject = afterSubject.nextSibling;
        if (afterSubject && afterSubject.tagName === 'BR') {
            afterSubject.parentNode.insertBefore(summonHint, afterSubject.nextSibling);
        } else {
            subjectField.parentNode.insertBefore(summonHint, subjectField.nextSibling);
        }

        subjectField.addEventListener('input', function () {
            var name = subjectField.value.trim();
            if (name) {
                summonHint.innerHTML = buildSummonHintHTML(name);
                summonHint.style.display = '';
            } else {
                summonHint.style.display = 'none';
            }
        });

        /* 4  Avatar row (flex: preview | dropzone) */
        var avatar = buildAvatarRow();
        var avatarReq = document.createElement('div');
        avatarReq.className = 'aidef-required-indicator';
        avatarReq.textContent = '\u26A0 Avatar .bin file required';

        /* insert after summonHint */
        var insertPoint = summonHint.nextSibling;
        if (!insertPoint) insertPoint = textarea;
        container.insertBefore(avatar.row, insertPoint);
        container.insertBefore(avatarReq, avatar.row.nextSibling);

        /* 5  Visible prompt textarea */
        var promptLabel = document.createElement('div');
        promptLabel.className = 'aidef-prompt-label';
        promptLabel.textContent = 'AI System Prompt';

        var promptTA = document.createElement('textarea');
        promptTA.className = 'form-control aidef-prompt';
        promptTA.rows = 8;
        promptTA.setAttribute('placeholder',
            'Enter the system prompt for your AI bot\u2026');
        promptTA.onkeydown = function (e) { e.stopImmediatePropagation(); };

        /* place before submit (after the hidden body textarea) */
        container.insertBefore(promptLabel, submitBtn);
        container.insertBefore(promptTA, submitBtn);

        /* 6  Wire file handling */
        wireFileHandling(avatar, state, container);

        /* 7  Change submit button text */
        submitBtn.value = 'Create Bot';

        /* 8  Override submit with validation + assembly */
        var origClick = submitBtn.getAttribute('onclick');
        submitBtn.removeAttribute('onclick');
        submitBtn.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();

            var errs = [];
            if (!subjectField.value.trim()) errs.push('Bot name (Subject) is required.');
            if (!state.avatarB64)           errs.push('Avatar .bin file is required.');
            if (!promptTA.value.trim())     errs.push('AI system prompt is required.');
            if (errs.length) { showErrors(container, errs); return; }
            clearErrors(container);

            textarea.value = assembleBody(state.avatarB64, promptTA.value);

            var m = origClick.match(/postNew\('([^']+)'\)/);
            if (m) postNew(m[1]);
        });
    }

    /* ================================================================
     * transformReplyForm  — reply = update avatar and/or prompt
     * ================================================================ */
    function transformReplyForm(container, replyId) {
        var textarea = container.getElementsByTagName('textarea')[0];
        if (!textarea) return;

        container.classList.add('aidef-form');

        var state = { avatarB64: null };

        /* 1  Remove quote button */
        var quoteBtn = document.getElementById('quote-' + replyId);
        if (quoteBtn) quoteBtn.style.display = 'none';

        /* 2  Clear + hide original textarea */
        textarea.value = '';
        textarea.style.display = 'none';

        /* 3  Hide original "Reply" strong label */
        var ch = container.children;
        for (var i = 0; i < ch.length; i++) {
            if (ch[i].tagName === 'STRONG') { ch[i].style.display = 'none'; break; }
        }

        /* 4  Header + hint */
        var header = document.createElement('div');
        header.className = 'aidef-section-label';
        header.textContent = 'Update AI Definition';

        var replyHint = document.createElement('div');
        replyHint.className = 'aidef-hint aidef-hint-small';
        replyHint.textContent =
            'Update the avatar, the prompt, or both. At least one change is required.';

        container.insertBefore(header, container.firstChild);
        container.insertBefore(replyHint, header.nextSibling);

        /* 5  Avatar row */
        var avatar = buildAvatarRow();
        container.insertBefore(avatar.row, replyHint.nextSibling);

        /* 6  Prompt textarea */
        var promptLabel = document.createElement('div');
        promptLabel.className = 'aidef-prompt-label';
        promptLabel.textContent = 'AI System Prompt';

        var promptTA = document.createElement('textarea');
        promptTA.className = 'form-control aidef-prompt';
        promptTA.rows = 8;
        promptTA.setAttribute('placeholder',
            'Enter updated system prompt (leave empty to keep current)\u2026');
        promptTA.onkeydown = function (e) { e.stopImmediatePropagation(); };

        var submitBtn = document.getElementById('reply-button-' + replyId);
        container.insertBefore(promptLabel, submitBtn || textarea);
        container.insertBefore(promptTA, submitBtn || textarea);

        /* 7  Wire file handling */
        wireFileHandling(avatar, state, container);

        /* 8  Override submit with validation + assembly */
        if (submitBtn) {
            var origClick = submitBtn.getAttribute('onclick');
            submitBtn.removeAttribute('onclick');
            submitBtn.addEventListener('click', function (e) {
                e.preventDefault(); e.stopPropagation();

                if (!state.avatarB64 && !promptTA.value.trim()) {
                    showErrors(container,
                        ['Please upload an avatar or enter a prompt (or both).']);
                    return;
                }
                clearErrors(container);

                textarea.value = assembleBody(state.avatarB64, promptTA.value);

                var m = origClick.match(/postReply\('([^']+)',\s*'([^']+)'\)/);
                if (m) postReply(m[1], m[2]);
            });
        }
    }

    /* ================================================================
     * Hook into addNew / addReply
     * ================================================================ */

    var _origAddNew = window.addNew;
    window.addNew = async function (sub) {
        await _origAddNew(sub);
        var nm = document.getElementById('newmessage');
        if (!nm) return;
        transformNewPostForm(nm);
    };

    var _origAddReply = window.addReply;
    window.addReply = async function (sub, id) {
        await _origAddReply(sub, id);
        var rb = document.getElementById('replybox-' + id);
        if (!rb) return;
        transformReplyForm(rb, id);
    };

})();
