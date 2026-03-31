/**
 * bin-avatar-upload.js — AI Definition creator/editor for local-aidefinitions
 *
 * Only loaded on the "local-aidefinitions" sub-board (via 001-forum.xjs).
 * Transforms the standard forum posting UI into a guided AI-definition
 * creator with:
 *   - Subject field re-labelled "Bot Name" with yellow hint
 *   - Dynamic summon/dismiss hint below Subject (CGA-coloured)
 *   - "To" field hidden (defaults to "All")
 *   - Dedicated 10 x 6 avatar controls: upload, shared-library picker, ANSI draw/edit
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
    var DEFAULT_EDITOR_ZOOM = 5;
    var MIN_EDITOR_ZOOM = 2;
    var MAX_EDITOR_ZOOM = 10;
    var avatarLibrary = null;

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

    function binaryStringToUint8Array(bin) {
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
        return bytes;
    }

    function decodeBase64(base64) {
        try {
            return atob(base64 || '');
        } catch (err) {
            return '';
        }
    }

    function clearNode(node) {
        if (!node) return;
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    function createMetaPill(label, value, extraClass) {
        var pill = document.createElement('span');
        pill.className = 'avatar-settings-meta-pill' + (extraClass ? ' ' + extraClass : '');
        pill.textContent = label + ': ' + value;
        return pill;
    }

    function renderAvatarPreview(target, base64, placeholderText) {
        var bin = decodeBase64(base64);
        clearNode(target);
        if (!bin || !window.GraphicsConverter || !GraphicsConverter.shared) {
            var placeholder = document.createElement('div');
            placeholder.className = 'avatar-settings-placeholder';
            placeholder.textContent = placeholderText || 'No avatar';
            target.appendChild(placeholder);
            return;
        }
        GraphicsConverter.shared().from_bin(bin, AVATAR_COLS, AVATAR_ROWS, function (img) {
            clearNode(target);
            img.className = 'avatar-settings-image';
            target.appendChild(img);
        });
    }

    function editorToAvatarBase64(editor) {
        var doc = editor && editor.doc ? editor.doc : null;
        var out = '';
        var i;
        var cell;
        var fg;
        var bg;

        if (!doc || doc.columns !== AVATAR_COLS || doc.rows !== AVATAR_ROWS || !doc.data) return '';
        for (i = 0; i < doc.data.length; i++) {
            cell = doc.data[i] || { code: 32, fg: 7, bg: 0 };
            fg = typeof cell.fg === 'number' ? (cell.fg & 0x0f) : 7;
            bg = typeof cell.bg === 'number' ? (cell.bg & 0x07) : 0;
            out += String.fromCharCode((typeof cell.code === 'number' ? cell.code : 32) & 0xff);
            out += String.fromCharCode((bg << 4) | fg);
        }
        return btoa(out);
    }

    function createEditorZoomControls(editor, modalEl) {
        var titleBar;
        var title;
        var controls;
        var zoomOut;
        var zoomValue;
        var zoomIn;
        var currentZoom = DEFAULT_EDITOR_ZOOM;

        if (!editor || !editor.el || !editor.el.canvasContainer || !modalEl) return;
        titleBar = modalEl.querySelector('.ae-modal-titlebar');
        title = modalEl.querySelector('.ae-modal-title');
        if (!titleBar || !title) return;
        if (titleBar.querySelector('.avatar-editor-zoom')) return;

        controls = document.createElement('div');
        controls.className = 'avatar-editor-zoom';

        zoomOut = document.createElement('button');
        zoomOut.type = 'button';
        zoomOut.className = 'avatar-editor-zoom-btn';
        zoomOut.textContent = '-';

        zoomValue = document.createElement('span');
        zoomValue.className = 'avatar-editor-zoom-value';

        zoomIn = document.createElement('button');
        zoomIn.type = 'button';
        zoomIn.className = 'avatar-editor-zoom-btn';
        zoomIn.textContent = '+';

        controls.appendChild(zoomOut);
        controls.appendChild(zoomValue);
        controls.appendChild(zoomIn);
        titleBar.insertBefore(controls, title.nextSibling);

        function applyZoom(nextZoom) {
            nextZoom = Math.max(MIN_EDITOR_ZOOM, Math.min(MAX_EDITOR_ZOOM, nextZoom));
            currentZoom = nextZoom;
            editor.el.canvasContainer.style.zoom = String(currentZoom);
            zoomValue.textContent = (currentZoom * 100) + '%';
            zoomOut.disabled = currentZoom <= MIN_EDITOR_ZOOM;
            zoomIn.disabled = currentZoom >= MAX_EDITOR_ZOOM;
        }

        zoomOut.addEventListener('click', function () {
            applyZoom(currentZoom - 1);
        });
        zoomIn.addEventListener('click', function () {
            applyZoom(currentZoom + 1);
        });

        applyZoom(DEFAULT_EDITOR_ZOOM);
    }

    function ensureAvatarLibrary() {
        var modal;
        var dialog;
        var header;
        var title;
        var body;
        var toolbar;
        var field;
        var label;
        var select;
        var meta;
        var grid;
        var footer;
        var cancelBtn;
        var applyBtn;

        if (avatarLibrary) return avatarLibrary;

        modal = document.createElement('div');
        modal.className = 'avatar-settings-modal';
        modal.hidden = true;

        var backdrop = document.createElement('div');
        backdrop.className = 'avatar-settings-modal-backdrop';
        modal.appendChild(backdrop);

        dialog = document.createElement('div');
        dialog.className = 'avatar-settings-modal-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-label', 'Avatar Library');

        header = document.createElement('div');
        header.className = 'avatar-settings-modal-header';
        title = document.createElement('h3');
        title.className = 'avatar-settings-heading';
        title.textContent = 'Shared Collections';
        header.appendChild(title);

        body = document.createElement('div');
        body.className = 'avatar-settings-modal-body';
        toolbar = document.createElement('div');
        toolbar.className = 'avatar-settings-modal-toolbar';

        field = document.createElement('label');
        field.className = 'avatar-settings-field';
        label = document.createElement('span');
        label.className = 'avatar-settings-label';
        label.textContent = 'Collection';
        select = document.createElement('select');
        select.className = 'form-select form-select-sm';
        field.appendChild(label);
        field.appendChild(select);

        meta = document.createElement('div');
        meta.className = 'avatar-settings-collection-meta';

        toolbar.appendChild(field);
        toolbar.appendChild(meta);

        grid = document.createElement('div');
        grid.className = 'avatar-settings-grid';

        body.appendChild(toolbar);
        body.appendChild(grid);

        footer = document.createElement('div');
        footer.className = 'avatar-settings-modal-footer';
        cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn btn-default btn-sm';
        cancelBtn.textContent = 'Cancel';
        applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'btn btn-primary btn-sm';
        applyBtn.textContent = 'Use Selected Avatar';
        applyBtn.disabled = true;
        footer.appendChild(cancelBtn);
        footer.appendChild(applyBtn);

        dialog.appendChild(header);
        dialog.appendChild(body);
        dialog.appendChild(footer);
        modal.appendChild(dialog);
        document.body.appendChild(modal);

        avatarLibrary = {
            root: modal,
            select: select,
            meta: meta,
            grid: grid,
            apply: applyBtn,
            collections: [],
            loaded: {},
            collection: null,
            selectedIndex: -1,
            onSelect: null,
            initPromise: null
        };

        function closeLibrary() {
            avatarLibrary.onSelect = null;
            avatarLibrary.root.hidden = true;
            document.body.classList.remove('avatar-settings-modal-open');
        }

        function updateApplyButton() {
            avatarLibrary.apply.disabled = !(
                avatarLibrary.collection &&
                avatarLibrary.collection.avatars &&
                avatarLibrary.selectedIndex >= 0
            );
        }

        function renderCollectionMeta() {
            clearNode(avatarLibrary.meta);
            if (!avatarLibrary.collection) return;
            avatarLibrary.meta.appendChild(createMetaPill('Author', avatarLibrary.collection.author || 'Unknown'));
            avatarLibrary.meta.appendChild(createMetaPill('Group', avatarLibrary.collection.group || 'Unknown', 'is-group'));
            avatarLibrary.meta.appendChild(createMetaPill('Avatars', String(avatarLibrary.collection.count || 0), 'is-count'));
        }

        function renderCollectionGrid() {
            clearNode(avatarLibrary.grid);
            if (!avatarLibrary.collection || !avatarLibrary.collection.avatars || !avatarLibrary.collection.avatars.length) {
                renderAvatarPreview(avatarLibrary.grid, '', 'No avatars found in this collection.');
                updateApplyButton();
                return;
            }

            avatarLibrary.collection.avatars.forEach(function (avatar, index) {
                var button = document.createElement('button');
                var preview = document.createElement('div');
                var number = document.createElement('div');

                button.type = 'button';
                button.className = 'avatar-settings-tile';
                if (index === avatarLibrary.selectedIndex) button.classList.add('is-selected');
                button.addEventListener('click', function () {
                    avatarLibrary.selectedIndex = index;
                    renderCollectionGrid();
                    updateApplyButton();
                });

                preview.className = 'avatar-settings-tile-preview';
                renderAvatarPreview(preview, avatar.data, 'No preview');

                number.className = 'avatar-settings-tile-index';
                number.textContent = '#' + (index + 1);

                button.appendChild(preview);
                if (avatar.label && !/^Avatar\s+\d+$/i.test(avatar.label)) {
                    var tileLabel = document.createElement('div');
                    tileLabel.className = 'avatar-settings-tile-label';
                    tileLabel.textContent = avatar.label;
                    button.appendChild(tileLabel);
                }
                button.appendChild(number);
                avatarLibrary.grid.appendChild(button);
            });

            updateApplyButton();
        }

        function populateCollections() {
            clearNode(avatarLibrary.select);
            if (!avatarLibrary.collections.length) {
                var none = document.createElement('option');
                none.value = '';
                none.textContent = 'No shared collections';
                avatarLibrary.select.appendChild(none);
                avatarLibrary.select.disabled = true;
                return;
            }

            avatarLibrary.select.disabled = false;
            avatarLibrary.collections.forEach(function (collection) {
                var option = document.createElement('option');
                option.value = collection.id;
                option.textContent = collection.title + ' (' + collection.count + ')';
                avatarLibrary.select.appendChild(option);
            });
        }

        async function loadCollection(collectionId) {
            if (!collectionId) return;
            avatarLibrary.select.disabled = true;
            avatarLibrary.apply.disabled = true;
            renderAvatarPreview(avatarLibrary.grid, '', 'Loading shared avatars...');

            var payload = await v4_get('./api/system.ssjs?call=avatar-collection&collection=' + encodeURIComponent(collectionId));
            avatarLibrary.select.disabled = false;

            if (!payload || payload.success === false || !payload.avatars) {
                avatarLibrary.collection = null;
                renderCollectionMeta();
                renderAvatarPreview(
                    avatarLibrary.grid,
                    '',
                    payload && payload.error ? payload.error : 'Unable to load avatar collection.'
                );
                updateApplyButton();
                return;
            }

            avatarLibrary.loaded[payload.id] = payload;
            avatarLibrary.collection = payload;
            avatarLibrary.selectedIndex = typeof payload.previewIndex === 'number' ? payload.previewIndex : 0;
            avatarLibrary.select.value = payload.id;
            renderCollectionMeta();
            renderCollectionGrid();
        }

        async function ensureCollectionLoaded(collectionId) {
            if (!collectionId) return;
            if (avatarLibrary.loaded[collectionId]) {
                avatarLibrary.collection = avatarLibrary.loaded[collectionId];
                avatarLibrary.select.value = collectionId;
                avatarLibrary.selectedIndex = typeof avatarLibrary.collection.previewIndex === 'number'
                    ? avatarLibrary.collection.previewIndex
                    : 0;
                renderCollectionMeta();
                renderCollectionGrid();
                return;
            }
            await loadCollection(collectionId);
        }

        async function initLibrary() {
            if (avatarLibrary.initPromise) return avatarLibrary.initPromise;
            avatarLibrary.initPromise = v4_get('./api/system.ssjs?call=avatar-settings-init')
                .then(function (payload) {
                    avatarLibrary.collections = payload && payload.collections ? payload.collections : [];
                    populateCollections();
                    return avatarLibrary.collections;
                })
                .catch(function () {
                    avatarLibrary.collections = [];
                    populateCollections();
                    return avatarLibrary.collections;
                });
            return avatarLibrary.initPromise;
        }

        avatarLibrary.open = async function (onSelect, onError) {
            var collections = await initLibrary();
            if (!collections.length) {
                if (typeof onError === 'function') {
                    onError('No shared avatar collections are available right now.');
                }
                return;
            }
            avatarLibrary.onSelect = onSelect || null;
            avatarLibrary.root.hidden = false;
            document.body.classList.add('avatar-settings-modal-open');
            await ensureCollectionLoaded(avatarLibrary.select.value || avatarLibrary.collections[0].id);
        };

        avatarLibrary.select.addEventListener('change', function () {
            loadCollection(this.value);
        });
        avatarLibrary.apply.addEventListener('click', function () {
            var selectedAvatar;
            if (!avatarLibrary.collection || avatarLibrary.selectedIndex < 0) return;
            selectedAvatar = avatarLibrary.collection.avatars[avatarLibrary.selectedIndex] || null;
            if (!selectedAvatar || !selectedAvatar.data) return;
            if (typeof avatarLibrary.onSelect === 'function') avatarLibrary.onSelect(selectedAvatar);
            closeLibrary();
        });
        cancelBtn.addEventListener('click', closeLibrary);
        backdrop.addEventListener('click', closeLibrary);
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && avatarLibrary && !avatarLibrary.root.hidden) closeLibrary();
        });

        return avatarLibrary;
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
        label.textContent = 'Drop 10 x 6 .bin avatar here';

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
            removeBtn: removeBtn
        };
    }

    function toggleAvatarRequired(container, hasAvatar) {
        var req = container.querySelector('.aidef-required-indicator');
        if (req) req.style.display = hasAvatar ? 'none' : '';
        if (req && !hasAvatar && req.getAttribute('data-avatar-required') === 'optional') {
            req.style.display = 'none';
        }
    }

    function applyAvatarSelection(parts, state, container, base64) {
        state.avatarB64 = base64 || null;
        if (!state.avatarB64) {
            clearNode(parts.canvas);
            parts.placeholder.style.display = '';
            parts.previewBox.classList.remove('has-avatar');
            parts.removeBtn.style.display = 'none';
            toggleAvatarRequired(container, false);
            return;
        }

        clearNode(parts.canvas);
        renderAvatarPreview(parts.canvas, state.avatarB64, 'No Avatar');
        parts.placeholder.style.display = 'none';
        parts.previewBox.classList.add('has-avatar');
        parts.removeBtn.style.display = '';
        toggleAvatarRequired(container, true);
        clearErrors(container);
    }

    function openAvatarEditor(parts, state, container) {
        var currentBin;

        if (!window.AnsiEditorModal) {
            showErrors(container, ['ANSI editor is not available on this page.']);
            return;
        }

        currentBin = decodeBase64(state.avatarB64 || '');
        AnsiEditorModal.open({
            title: 'Avatar Editor',
            className: 'ae-modal-avatar',
            columns: AVATAR_COLS,
            rows: AVATAR_ROWS,
            width: 900,
            height: 620,
            minWidth: 900,
            minHeight: 620,
            fontUrl: './fonts/ansi-editor/IBM VGA.F16',
            onReady: function (editor) {
                var modalEl = document.querySelector('.ae-modal-window.ae-modal-avatar');
                if (editor && editor.setCanvasSize) editor.setCanvasSize(AVATAR_COLS, AVATAR_ROWS);
                if (currentBin.length === AVATAR_BYTES && editor && editor.loadBytes) {
                    editor.loadBytes(binaryStringToUint8Array(currentBin), 'avatar.bin');
                    if (editor.setCanvasSize && (editor.columns !== AVATAR_COLS || editor.rows !== AVATAR_ROWS)) {
                        editor.setCanvasSize(AVATAR_COLS, AVATAR_ROWS);
                    }
                }
                createEditorZoomControls(editor, modalEl);
            },
            onDone: function (editor) {
                var base64 = editorToAvatarBase64(editor);
                if (!base64 || decodeBase64(base64).length !== AVATAR_BYTES) {
                    showErrors(container, ['Avatar editor must stay on a strict 10 x 6 canvas.']);
                    return;
                }
                applyAvatarSelection(parts, state, container, base64);
            },
            onCancel: function () {}
        });
    }

    function buildAvatarActionRow(container, parts, state) {
        var actionRow = document.createElement('div');
        var libraryBtn = document.createElement('button');
        var drawBtn = container.querySelector('.ansi-editor-toggle');

        actionRow.style.display = 'flex';
        actionRow.style.flexWrap = 'wrap';
        actionRow.style.gap = '0.5rem';
        actionRow.style.margin = '0.65rem 0 1rem';

        libraryBtn.type = 'button';
        libraryBtn.className = 'btn btn-default';
        libraryBtn.textContent = 'Choose from Library';
        libraryBtn.addEventListener('click', function (event) {
            event.preventDefault();
            ensureAvatarLibrary().open(function (selectedAvatar) {
                applyAvatarSelection(parts, state, container, selectedAvatar.data || '');
            }, function (message) {
                showErrors(container, [message]);
            });
        });
        actionRow.appendChild(libraryBtn);

        if (!drawBtn) {
            drawBtn = document.createElement('button');
            drawBtn.type = 'button';
            drawBtn.className = 'btn btn-default ansi-editor-toggle';
        }
        drawBtn.removeAttribute('onclick');
        drawBtn.textContent = 'Draw / Edit Avatar';
        drawBtn.addEventListener('click', function (event) {
            event.preventDefault();
            openAvatarEditor(parts, state, container);
        });
        actionRow.appendChild(drawBtn);

        return actionRow;
    }

    /* ================================================================
     * wireFileHandling — connect file events to avatar state + preview
     * ================================================================ */
    function wireFileHandling(parts, state, container) {
        var fileInput = parts.fileInput;
        var removeBtn = parts.removeBtn;
        var dz = parts.dz;

        function processFile(file) {
            var reader;

            if (!file) return;
            if (!file.name.toLowerCase().endsWith('.bin')) {
                showErrors(container, ['Please select an ANSI .bin file.']);
                return;
            }
            reader = new FileReader();
            reader.onload = function (evt) {
                var buf = stripSAUCE(evt.target.result);
                if (buf.byteLength !== AVATAR_BYTES) {
                    showErrors(container, ['Avatar .bin must be exactly 10 x 6 (120 bytes) after SAUCE removal.']);
                    return;
                }
                applyAvatarSelection(parts, state, container, arrayBufferToBase64(buf));
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
            applyAvatarSelection(parts, state, container, '');
            fileInput.value = '';
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
        avatarReq.setAttribute('data-avatar-required', 'required');
        avatarReq.textContent = '\u26A0 Avatar .bin file required (10 x 6)';

        /* insert after summonHint */
        var insertPoint = summonHint.nextSibling;
        if (!insertPoint) insertPoint = textarea;
        container.insertBefore(avatar.row, insertPoint);
        container.insertBefore(avatarReq, avatar.row.nextSibling);
        container.insertBefore(buildAvatarActionRow(container, avatar, state), avatarReq.nextSibling);

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
        var avatarReq = document.createElement('div');
        avatarReq.className = 'aidef-required-indicator';
        avatarReq.setAttribute('data-avatar-required', 'optional');
        avatarReq.textContent = '\u26A0 Avatar must be 10 x 6 when updating it';
        avatarReq.style.display = 'none';
        container.insertBefore(avatarReq, avatar.row.nextSibling);
        container.insertBefore(buildAvatarActionRow(container, avatar, state), avatarReq.nextSibling);

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
