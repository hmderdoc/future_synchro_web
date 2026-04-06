(function () {
    'use strict';

    var AVATAR_COLUMNS = 10;
    var AVATAR_ROWS = 6;
    var AVATAR_BYTES = AVATAR_COLUMNS * AVATAR_ROWS * 2;
    var DEFAULT_EDITOR_ZOOM = 5;
    var MIN_EDITOR_ZOOM = 2;
    var MAX_EDITOR_ZOOM = 10;

    function editorToAvatarBase64(editor) {
        var doc = editor && editor.doc ? editor.doc : null;
        var out = '';
        var i;
        var cell;
        var fg;
        var bg;
        if (!doc || doc.columns !== AVATAR_COLUMNS || doc.rows !== AVATAR_ROWS || !doc.data) return '';
        for (i = 0; i < doc.data.length; i++) {
            cell = doc.data[i] || { code: 32, fg: 7, bg: 0 };
            fg = typeof cell.fg === 'number' ? (cell.fg & 0x0f) : 7;
            bg = typeof cell.bg === 'number' ? (cell.bg & 0x07) : 0;
            out += String.fromCharCode((typeof cell.code === 'number' ? cell.code : 32) & 0xff);
            out += String.fromCharCode((bg << 4) | fg);
        }
        return btoa(out);
    }

    function decodeBase64(base64) {
        try {
            return atob(base64);
        } catch (err) {
            return '';
        }
    }

    function loadAvatarIntoEditor(editor, bin) {
        var grid = [];
        var i;
        var attr;

        if (!editor || !editor.doc || typeof editor.doc.replaceAll !== 'function') return false;

        if (bin && bin.length === AVATAR_BYTES) {
            for (i = 0; i < AVATAR_BYTES; i += 2) {
                attr = bin.charCodeAt(i + 1) & 0xff;
                grid.push({
                    code: bin.charCodeAt(i) & 0xff,
                    fg: attr & 0x0f,
                    bg: (attr >> 4) & 0x07
                });
            }
        } else {
            for (i = 0; i < AVATAR_COLUMNS * AVATAR_ROWS; i++) {
                grid.push({ code: 32, fg: 7, bg: 0 });
            }
        }

        editor.doc.replaceAll(grid, AVATAR_COLUMNS, AVATAR_ROWS);
        editor.columns = AVATAR_COLUMNS;
        editor.rows = AVATAR_ROWS;
        if (editor._rebuildCanvas) editor._rebuildCanvas();
        if (editor._moveCursor) editor._moveCursor(0, 0);
        if (editor._updateStatusBar) editor._updateStatusBar();
        return true;
    }

    function primeAvatarEditor(editor, bin) {
        if (!editor) return false;
        loadAvatarIntoEditor(editor, bin);
        if (typeof editor._selectTool === 'function') editor._selectTool('brush');
        if (typeof editor._setBrushMode === 'function') editor._setBrushMode('custom_block');
        if (typeof editor._setFg === 'function') editor._setFg(15);
        if (typeof editor._setBg === 'function') editor._setBg(0);
        return true;
    }

    function clearNode(node) {
        if (!node) return;
        while (node.firstChild) node.removeChild(node.firstChild);
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
        GraphicsConverter.shared().from_bin(bin, AVATAR_COLUMNS, AVATAR_ROWS, function (img) {
            clearNode(target);
            img.className = 'avatar-settings-image';
            target.appendChild(img);
        });
    }

    function createMetaPill(label, value, extraClass) {
        var pill = document.createElement('span');
        pill.className = 'avatar-settings-meta-pill' + (extraClass ? ' ' + extraClass : '');
        pill.textContent = label + ': ' + value;
        return pill;
    }

    function updateAvatarTargets(keys, base64) {
        var bin = decodeBase64(base64);
        if (!bin || !window.GraphicsConverter || !GraphicsConverter.shared) return;
        GraphicsConverter.shared().from_bin(bin, AVATAR_COLUMNS, AVATAR_ROWS, function (img) {
            var dataURL = img.src;
            keys.forEach(function (key) {
                if (!key) return;
                if (window.sbbs && window.sbbs.avatars && window.sbbs.avatars.set) {
                    window.sbbs.avatars.set({
                        user: key,
                        data: base64,
                        dataURL: dataURL
                    });
                }
                document.querySelectorAll('div[data-avatar]').forEach(function (el) {
                    if (el.getAttribute('data-avatar') !== key) return;
                    clearNode(el);
                    el.appendChild(img.cloneNode(true));
                });
            });
        });
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

    function mountAvatarSettings(root) {
        if (!root || root.getAttribute('data-avatar-settings-mounted') === '1') return;
        root.setAttribute('data-avatar-settings-mounted', '1');

        var refs = {
            currentPreview: root.querySelector('[data-avatar-settings-current-preview]'),
            status: root.querySelector('[data-avatar-settings-status]'),
            library: root.querySelector('[data-avatar-settings-library]'),
            draw: root.querySelector('[data-avatar-settings-draw]'),
            input: root.querySelector('[data-avatar-settings-input]'),
            modal: root.querySelector('[data-avatar-settings-modal]'),
            modalClose: root.querySelectorAll('[data-avatar-settings-modal-close]'),
            collectionSelect: root.querySelector('[data-avatar-settings-collection]'),
            collectionMeta: root.querySelector('[data-avatar-settings-collection-meta]'),
            grid: root.querySelector('[data-avatar-settings-grid]'),
            apply: root.querySelector('[data-avatar-settings-apply]')
        };

        var state = {
            mode: root.getAttribute('data-avatar-settings-mode') || 'account',
            emptyLabel: root.getAttribute('data-avatar-settings-empty-label') || 'No avatar saved yet',
            userNumber: String(root.getAttribute('data-avatar-user-number') || ''),
            userAlias: root.getAttribute('data-avatar-user-alias') || '',
            current: null,
            collections: [],
            collection: null,
            collectionLoaded: {},
            selectedIndex: -1,
            modalOpen: false
        };

        function avatarKeys() {
            var keys = [];
            if (state.userNumber) keys.push(state.userNumber);
            if (state.userAlias && keys.indexOf(state.userAlias) < 0) keys.push(state.userAlias);
            return keys;
        }

        function setStatus(message, tone) {
            if (!refs.status) return;
            refs.status.hidden = !message;
            refs.status.className = 'avatar-settings-status';
            if (tone) refs.status.classList.add('is-' + tone);
            refs.status.textContent = message || '';
        }

        function setCurrentAvatar(avatar) {
            state.current = avatar && avatar.data ? avatar : null;
            if (refs.input) refs.input.value = state.current ? state.current.data : '';
            renderAvatarPreview(
                refs.currentPreview,
                state.current ? state.current.data : '',
                state.emptyLabel
            );
            if (state.current && state.mode !== 'registration') {
                updateAvatarTargets(avatarKeys(), state.current.data);
            }
        }

        function renderCollectionMeta() {
            clearNode(refs.collectionMeta);
            if (!state.collection) return;
            refs.collectionMeta.appendChild(createMetaPill('Author', state.collection.author || 'Unknown'));
            refs.collectionMeta.appendChild(createMetaPill('Group', state.collection.group || 'Unknown', 'is-group'));
            refs.collectionMeta.appendChild(createMetaPill('Avatars', String(state.collection.count || 0), 'is-count'));
        }

        function updateApplyButton() {
            refs.apply.disabled = !(state.collection && state.collection.avatars && state.selectedIndex >= 0);
        }

        function renderCollectionGrid() {
            clearNode(refs.grid);
            if (!state.collection || !state.collection.avatars || !state.collection.avatars.length) {
                refs.grid.appendChild((function () {
                    var empty = document.createElement('div');
                    empty.className = 'avatar-settings-placeholder';
                    empty.textContent = 'No avatars found in this collection.';
                    return empty;
                })());
                updateApplyButton();
                return;
            }

            state.collection.avatars.forEach(function (avatar, index) {
                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'avatar-settings-tile';
                if (index === state.selectedIndex) button.classList.add('is-selected');
                button.addEventListener('click', function () {
                    state.selectedIndex = index;
                    renderCollectionGrid();
                    updateApplyButton();
                });

                var preview = document.createElement('div');
                preview.className = 'avatar-settings-tile-preview';
                renderAvatarPreview(preview, avatar.data, 'No preview');

                var number = document.createElement('div');
                number.className = 'avatar-settings-tile-index';
                number.textContent = '#' + (index + 1);

                button.appendChild(preview);
                if (avatar.label && !/^Avatar\s+\d+$/i.test(avatar.label)) {
                    var label = document.createElement('div');
                    label.className = 'avatar-settings-tile-label';
                    label.textContent = avatar.label;
                    button.appendChild(label);
                }
                button.appendChild(number);
                refs.grid.appendChild(button);
            });

            updateApplyButton();
        }

        function populateCollections() {
            clearNode(refs.collectionSelect);
            if (!state.collections.length) {
                var none = document.createElement('option');
                none.value = '';
                none.textContent = 'No shared collections';
                refs.collectionSelect.appendChild(none);
                refs.collectionSelect.disabled = true;
                return;
            }
            refs.collectionSelect.disabled = false;
            state.collections.forEach(function (collection) {
                var option = document.createElement('option');
                option.value = collection.id;
                option.textContent = collection.title + ' (' + collection.count + ')';
                refs.collectionSelect.appendChild(option);
            });
        }

        function openModal() {
            state.modalOpen = true;
            refs.modal.hidden = false;
            document.body.classList.add('avatar-settings-modal-open');
        }

        function closeModal() {
            state.modalOpen = false;
            refs.modal.hidden = true;
            document.body.classList.remove('avatar-settings-modal-open');
        }

        async function loadCollection(collectionId) {
            if (!collectionId) return;
            refs.collectionSelect.disabled = true;
            refs.apply.disabled = true;
            clearNode(refs.grid);
            refs.grid.appendChild((function () {
                var loading = document.createElement('div');
                loading.className = 'avatar-settings-placeholder';
                loading.textContent = 'Loading shared avatars...';
                return loading;
            })());

            var payload = await v4_get('./api/system.ssjs?call=avatar-collection&collection=' + encodeURIComponent(collectionId));
            refs.collectionSelect.disabled = false;

            if (!payload || payload.success === false || !payload.avatars) {
                state.collection = null;
                renderCollectionMeta();
                renderCollectionGrid();
                setStatus(payload && payload.error ? payload.error : 'Unable to load avatar collection.', 'error');
                return;
            }

            state.collectionLoaded[payload.id] = payload;
            state.collection = payload;
            state.selectedIndex = typeof payload.previewIndex === 'number' ? payload.previewIndex : 0;
            refs.collectionSelect.value = payload.id;
            renderCollectionMeta();
            renderCollectionGrid();
            setStatus('', '');
        }

        async function ensureCollectionLoaded(collectionId) {
            if (!collectionId) return;
            if (state.collectionLoaded[collectionId]) {
                state.collection = state.collectionLoaded[collectionId];
                refs.collectionSelect.value = collectionId;
                state.selectedIndex = typeof state.collection.previewIndex === 'number' ? state.collection.previewIndex : 0;
                renderCollectionMeta();
                renderCollectionGrid();
                return;
            }
            await loadCollection(collectionId);
        }

        async function openLibraryModal() {
            if (!state.collections.length) {
                setStatus('No shared avatar collections are available right now.', 'error');
                return;
            }
            openModal();
            await ensureCollectionLoaded(refs.collectionSelect.value || state.collections[0].id);
        }

        async function saveSelectedCollectionAvatar() {
            if (!state.collection || state.selectedIndex < 0) return;
            var selectedAvatar = state.collection.avatars[state.selectedIndex] || null;
            if (state.mode === 'registration') {
                if (!selectedAvatar || !selectedAvatar.data) {
                    setStatus('Unable to use selected avatar.', 'error');
                    return;
                }
                setCurrentAvatar({ data: selectedAvatar.data });
                closeModal();
                setStatus('', '');
                return;
            }
            refs.apply.disabled = true;

            var payload = await v4_post('./api/system.ssjs', {
                call: 'set-avatar-collection',
                collection: state.collection.id,
                index: state.selectedIndex
            });

            if (!payload || !payload.success || !payload.avatar || !payload.avatar.data) {
                refs.apply.disabled = false;
                setStatus(payload && payload.error ? payload.error : 'Unable to save selected avatar.', 'error');
                return;
            }

            setCurrentAvatar(payload.avatar);
            closeModal();
            setStatus('', '');
        }

        async function saveDrawnAvatar(base64) {
            if (state.mode === 'registration') {
                setCurrentAvatar({ data: base64 });
                setStatus('', '');
                return;
            }
            var payload = await v4_post('./api/system.ssjs', {
                call: 'set-avatar-data',
                data: base64
            });
            if (!payload || !payload.success || !payload.avatar || !payload.avatar.data) {
                setStatus(payload && payload.error ? payload.error : 'Unable to save drawn avatar.', 'error');
                return;
            }
            setCurrentAvatar(payload.avatar);
            setStatus('', '');
        }

        function openEditor() {
            if (!window.AnsiEditorModal) {
                setStatus('ANSI editor is not available on this page.', 'error');
                return;
            }

            // Safari appears more sensitive to stacked fixed overlays than Chromium.
            // Ensure the page-owned avatar library modal is fully out of the way
            // before we open the separate ANSI editor modal.
            closeModal();

            var currentBase64 = state.current && state.current.data ? state.current.data : '';
            var currentBin = decodeBase64(currentBase64);
            var seedBin = state.mode === 'account' ? '' : currentBin;

            AnsiEditorModal.open({
                title: 'Avatar Editor',
                className: 'ae-modal-avatar',
                columns: AVATAR_COLUMNS,
                rows: AVATAR_ROWS,
                width: 900,
                height: 620,
                minWidth: 900,
                minHeight: 620,
                fontUrl: './fonts/ansi-editor/IBM VGA.F16',
                onReady: function (editor) {
                    var modalEl = document.querySelector('.ae-modal-window.ae-modal-avatar');
                    primeAvatarEditor(editor, seedBin);
                    createEditorZoomControls(editor, modalEl);
                },
                onDone: function (editor) {
                    var base64 = editorToAvatarBase64(editor);
                    if (!base64 || decodeBase64(base64).length !== AVATAR_BYTES) {
                        setStatus('Avatar editor must stay on a strict 10 x 6 canvas.', 'error');
                        return;
                    }
                    saveDrawnAvatar(base64);
                },
                onCancel: function () {}
            });
        }

        function handleKeydown(event) {
            if (event.key === 'Escape' && state.modalOpen) closeModal();
        }

        async function init() {
            refs.library.disabled = true;
            refs.draw.disabled = true;
            setStatus('', '');

            var payload = await v4_get('./api/system.ssjs?call=avatar-settings-init');
            refs.draw.disabled = false;

            if (!payload || !payload.collections) {
                setStatus('Unable to load avatar settings.', 'error');
                return;
            }

            state.collections = payload.collections || [];
            populateCollections();
            if (refs.input && refs.input.value) {
                setCurrentAvatar({ data: refs.input.value });
            } else {
                setCurrentAvatar(payload.current || null);
            }
            refs.library.disabled = !state.collections.length;
        }

        refs.collectionSelect.addEventListener('change', function () {
            loadCollection(this.value);
        });
        refs.apply.addEventListener('click', saveSelectedCollectionAvatar);
        refs.draw.addEventListener('click', openEditor);
        refs.library.addEventListener('click', openLibraryModal);
        refs.modalClose.forEach(function (node) {
            node.addEventListener('click', closeModal);
        });
        document.addEventListener('keydown', handleKeydown);

        init();
    }

    function initAvatarSettingsWidgets(scope) {
        (scope || document).querySelectorAll('[data-avatar-settings]').forEach(function (root) {
            mountAvatarSettings(root);
        });
    }

    window.AvatarSettings = {
        mount: mountAvatarSettings,
        initAll: initAvatarSettingsWidgets
    };
    window.initAvatarSettingsWidgets = initAvatarSettingsWidgets;

})();
