/* radio.js - BBS Radio Station persistent MP3 player
 *
 * Lives in the navbar shell, persists across SPA navigation.
 * Uses Web Audio API DynamicsCompressorNode as a broadcast-style
 * brick-wall limiter so "hot" tracks don't blast eardrums.
 *
 * UI: Single-pane modal with two modes:
 *   - "Add Tracks" — browse/search the master library, add to active playlist
 *   - "Playlist"   — view/reorder/remove tracks in the active playlist
 */
(function () {
    'use strict';

    // --- Configuration ---
    var DIR_CODE = 'originalcontent_mp3s';
    var API_URL  = './api/files.ssjs?call=list-files&dir=' + DIR_CODE;
    var FILE_URL = './radio-stream/';
    var META_RANGE_BYTES = 262144;
    var PANEL_PREFS_KEY = 'sbbs-radio-library-prefs-v1';
    var SAVED_PLAYLISTS_KEY = 'sbbs-radio-library-playlists-v1';
    var LIBRARY_ALL_ID = '__all__';

    // Broadcast limiter: brick-wall at -6 dBFS
    var LIM_THRESHOLD = -6;
    var LIM_KNEE      = 0;
    var LIM_RATIO     = 20;
    var LIM_ATTACK    = 0.003;
    var LIM_RELEASE   = 0.25;

    // --- State ---
    var playlist  = [];   // [{name, desc, added, tags, artURL}, ...]
    var queue     = [];   // indices into playlist, ordered or shuffled
    var queuePos  = -1;
    var isPlaying = false;
    var audioCtx  = null;
    var compressor = null;
    var analyser  = null;
    var audio     = null;
    var gainNode  = null;
    var inputGain = null;
    var vizRAF    = null;
    var _pendingPlay = false;
    var FADE_IN_S   = 0.30;
    var _loadGen = 0;
    var _decodedBuffer = null;
    var _bufferSource  = null;
    var _playStartCtx  = 0;
    var _playOffset    = 0;
    var _trackEnded    = false;
    var savedPlaylists = [];
    var playMode = 'shuffle';
    var libraryPanelOpen = false;
    var libraryBackdrop = null;
    var metadataHydrateToken = 0;
    var metadataHydrateTimer = 0;
    var trackIndexByName = {};
    var playlistDragPos = -1;
    var panelFrame = { width: 0, height: 0, left: 0, top: 0 };

    // UI mode: 'add' (library browser) or 'playlist' (queue editor)
    var panelMode = 'add';

    var libraryView = {
        search: '',
        playlistId: LIBRARY_ALL_ID,
        artist: '',
        composer: '',
        genre: '',
        playlistSearch: ''
    };

    // --- DOM refs (set in init) ---
    var elPlay, elPrev, elNext, elTrack, elViz, elVolume;
    var elPanel, elContainer;
    var elPanelClose, elPanelShell, elPanelResizeHandle;
    // New single-pane refs
    var elModeAdd, elModePlaylist;
    var elContextBar, elContextName, elContextCount, elContextPlay, elContextChange;
    var elSearch, elFilterArtist, elFilterGenre, elFilterComposer;
    var elModeShuffle, elModeOrdered, elPlayView, elClearFilters;
    var elMainList, elSummary;
    var elCreateBar, elCreateInput, elCreateBtn;
    var vizW, vizH, vizCtx;

    // =========================================================
    //  Helpers (unchanged)
    // =========================================================
    function lcdUpdate(text, flash) {
        if (!elTrack) return;
        elTrack.title = text;
        elTrack.innerHTML = '';
        var span = document.createElement('span');
        span.className = 'lcd-scroll';
        span.textContent = text;
        elTrack.appendChild(span);
        if (flash) {
            span.classList.add('lcd-flash');
            return;
        }
        setTimeout(function() {
            var containerW = elTrack.clientWidth;
            var textW = span.scrollWidth;
            if (textW > containerW) {
                var shift = textW - containerW + 12;
                var dur = Math.max(4, shift / 16);
                span.style.setProperty('--lcd-shift', '-' + shift + 'px');
                span.style.setProperty('--lcd-duration', dur + 's');
                span.classList.add('scrolling');
            }
        }, 50);
    }

    function escHtml(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function filenameTitle(name) {
        return String(name || '')
            .replace(/\.mp3$/i, '')
            .replace(/_/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function trackTitle(track) {
        var tags = track && track.tags ? track.tags : null;
        return String((tags && tags.title) || track.desc || filenameTitle(track.name) || 'Unknown Track');
    }

    function trackArtist(track) {
        return String((track.tags && track.tags.artist) || '');
    }

    function trackComposer(track) {
        return String((track.tags && track.tags.composer) || '');
    }

    function trackGenre(track) {
        return String((track.tags && track.tags.genre) || '');
    }

    function trackAlbum(track) {
        return String((track.tags && track.tags.album) || '');
    }

    function trackYear(track) {
        return String((track.tags && track.tags.year) || '');
    }

    function trackDisplayLabel(track) {
        var title = trackTitle(track);
        var artist = trackArtist(track);
        return artist ? (title + ' - ' + artist) : title;
    }

    function normalizeTrack(item) {
        return {
            name: item && item.name ? String(item.name) : '',
            desc: item && item.desc ? String(item.desc) : '',
            added: item && item.added ? item.added : 0,
            tags: {},
            artURL: '',
            metaLoaded: false,
            metaLoading: false
        };
    }

    function currentTrackIndex() {
        return (queuePos >= 0 && queuePos < queue.length) ? queue[queuePos] : -1;
    }

    function currentTrack() {
        var idx = currentTrackIndex();
        return idx >= 0 ? playlist[idx] : null;
    }

    function rebuildTrackIndexLookup() {
        trackIndexByName = {};
        for (var i = 0; i < playlist.length; i++) {
            if (playlist[i] && playlist[i].name) trackIndexByName[playlist[i].name] = i;
        }
    }

    function readJSON(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function writeJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (_) {}
    }

    function loadLibraryPrefs() {
        var stored = readJSON(PANEL_PREFS_KEY, null);
        if (!stored || typeof stored !== 'object') return;
        if (stored.playMode === 'ordered' || stored.playMode === 'shuffle') playMode = stored.playMode;
        if (typeof stored.playlistId === 'string') libraryView.playlistId = stored.playlistId;
        if (typeof stored.artist === 'string') libraryView.artist = stored.artist;
        if (typeof stored.genre === 'string') libraryView.genre = stored.genre;
        if (typeof stored.panelMode === 'string') panelMode = stored.panelMode === 'playlist' ? 'playlist' : 'add';
        if (typeof stored.panelWidth === 'number' && isFinite(stored.panelWidth) && stored.panelWidth > 0) {
            panelFrame.width = Math.round(stored.panelWidth);
        }
        if (typeof stored.panelHeight === 'number' && isFinite(stored.panelHeight) && stored.panelHeight > 0) {
            panelFrame.height = Math.round(stored.panelHeight);
        }
        if (typeof stored.panelLeft === 'number' && isFinite(stored.panelLeft) && stored.panelLeft >= 0) {
            panelFrame.left = Math.round(stored.panelLeft);
        }
        if (typeof stored.panelTop === 'number' && isFinite(stored.panelTop) && stored.panelTop >= 0) {
            panelFrame.top = Math.round(stored.panelTop);
        }
    }

    function persistLibraryPrefs() {
        writeJSON(PANEL_PREFS_KEY, {
            playMode: playMode,
            playlistId: libraryView.playlistId,
            artist: libraryView.artist,
            genre: libraryView.genre,
            panelMode: panelMode,
            panelWidth: panelFrame.width || 0,
            panelHeight: panelFrame.height || 0,
            panelLeft: panelFrame.left || 0,
            panelTop: panelFrame.top || 0
        });
    }

    function loadSavedPlaylists() {
        var stored = readJSON(SAVED_PLAYLISTS_KEY, []);
        savedPlaylists = Array.isArray(stored) ? stored.filter(function (entry) {
            return entry && typeof entry.name === 'string' && Array.isArray(entry.trackNames);
        }) : [];
    }

    function persistSavedPlaylists() {
        writeJSON(SAVED_PLAYLISTS_KEY, savedPlaylists);
    }

    // =========================================================
    //  Panel markup — single-pane redesign
    // =========================================================
    function ensureLibraryBackdrop() {
        if (libraryBackdrop) return libraryBackdrop;
        libraryBackdrop = document.createElement('button');
        libraryBackdrop.type = 'button';
        libraryBackdrop.className = 'radio-playlist-backdrop';
        libraryBackdrop.setAttribute('aria-label', 'Dismiss track library');
        libraryBackdrop.addEventListener('click', closeLibraryPanel);
        document.body.appendChild(libraryBackdrop);
        return libraryBackdrop;
    }

    function buildLibraryPanelMarkup() {
        return [
            '<div class="rl-shell">',

            // === Header ===
            '<div class="rl-head">',
              '<div class="rl-head-left" title="Drag window">',
                '<span class="rl-drag-indicator" aria-hidden="true"></span>',
                '<div class="rl-brand">Futureland Records</div>',
              '</div>',
              '<div class="rl-head-right">',
                '<div class="rl-mode-tabs" role="tablist">',
                  '<button type="button" class="rl-mode-tab" id="rl-mode-add" role="tab" aria-selected="true">Add Tracks</button>',
                  '<button type="button" class="rl-mode-tab" id="rl-mode-playlist" role="tab" aria-selected="false">Playlist</button>',
                '</div>',
                '<button type="button" class="rl-close" id="rl-close" aria-label="Close">\u2715</button>',
              '</div>',
            '</div>',

            // === Playlist context bar ===
            '<div class="rl-context" id="rl-context">',
              '<div class="rl-context-info">',
                '<span class="rl-context-label">Editing</span>',
                '<select class="rl-context-select" id="rl-context-change" aria-label="Choose playlist"></select>',
                '<span class="rl-context-count" id="rl-context-count"></span>',
              '</div>',
              '<div class="rl-context-actions">',
                '<button type="button" class="rl-btn rl-btn-play" id="rl-context-play">\u25B6 Play</button>',
              '</div>',
            '</div>',

            // === Create-playlist bar (shown when no playlist selected) ===
            '<div class="rl-create" id="rl-create">',
              '<span class="rl-create-prompt">Create a playlist to get started</span>',
              '<input type="text" class="rl-create-input" id="rl-create-input" placeholder="Playlist name\u2026" maxlength="80">',
              '<button type="button" class="rl-btn rl-btn-go" id="rl-create-btn">Create</button>',
            '</div>',

            // === Toolbar (search + filters — only in Add mode) ===
            '<div class="rl-toolbar" id="rl-toolbar">',
              '<input type="text" class="rl-search" id="rl-search" placeholder="Search tracks, artists, genres\u2026">',
              '<select class="rl-filter" id="rl-filter-artist"><option value="">All artists</option></select>',
              '<select class="rl-filter" id="rl-filter-genre"><option value="">All genres</option></select>',
              '<select class="rl-filter" id="rl-filter-composer"><option value="">All composers</option></select>',
              '<div class="rl-toolbar-right">',
                '<div class="rl-playmode" role="group" aria-label="Playback order">',
                  '<button type="button" class="rl-playmode-btn" id="rl-mode-shuffle">Shuffle</button>',
                  '<button type="button" class="rl-playmode-btn" id="rl-mode-ordered">In Order</button>',
                '</div>',
                '<button type="button" class="rl-btn" id="rl-play-view">\u25B6 Play All</button>',
                '<button type="button" class="rl-btn rl-btn-dim" id="rl-clear-filters">Clear</button>',
              '</div>',
            '</div>',

            // === Track list (single pane, switches content based on mode) ===
            '<div class="rl-list" id="rl-list"></div>',

            // === Summary footer (sticky) ===
            '<div class="rl-summary" id="rl-summary"></div>',

            '<div class="rl-resize-handle" id="rl-resize-handle" aria-hidden="true"></div>',
            '</div>'
        ].join('');
    }

    function mountLibraryPanel() {
        if (!elPanel) return;
        if (elPanel.parentNode !== document.body) {
            document.body.appendChild(elPanel);
        }
        elPanel.innerHTML = buildLibraryPanelMarkup();
        elPanelShell      = elPanel.querySelector('.rl-shell');

        elPanelClose     = document.getElementById('rl-close');
        elModeAdd        = document.getElementById('rl-mode-add');
        elModePlaylist   = document.getElementById('rl-mode-playlist');
        elContextBar     = document.getElementById('rl-context');
        elContextChange  = document.getElementById('rl-context-change');
        elContextCount   = document.getElementById('rl-context-count');
        elContextPlay    = document.getElementById('rl-context-play');
        elCreateBar      = document.getElementById('rl-create');
        elCreateInput    = document.getElementById('rl-create-input');
        elCreateBtn      = document.getElementById('rl-create-btn');
        elSearch         = document.getElementById('rl-search');
        elFilterArtist   = document.getElementById('rl-filter-artist');
        elFilterGenre    = document.getElementById('rl-filter-genre');
        elFilterComposer = document.getElementById('rl-filter-composer');
        elModeShuffle    = document.getElementById('rl-mode-shuffle');
        elModeOrdered    = document.getElementById('rl-mode-ordered');
        elPlayView       = document.getElementById('rl-play-view');
        elClearFilters   = document.getElementById('rl-clear-filters');
        elSummary        = document.getElementById('rl-summary');
        elMainList       = document.getElementById('rl-list');
        elPanelResizeHandle = document.getElementById('rl-resize-handle');

        ensureLibraryBackdrop();
        applyPanelDimensions();
        initPanelDrag();
        initPanelResize();
    }

    function clamp(n, min, max) {
        return Math.max(min, Math.min(max, n));
    }

    function hasStoredPanelPosition() {
        return panelFrame.left > 0 || panelFrame.top > 0;
    }

    function isDesktopPanelLayout() {
        return window.innerWidth >= 600;
    }

    function getPanelSizeBounds() {
        var maxWidth = Math.max(360, Math.min(window.innerWidth - 24, 980));
        var minWidth = Math.min(480, maxWidth);
        var maxHeight = Math.max(360, Math.min(window.innerHeight - 24, 900));
        var minHeight = Math.min(420, maxHeight);
        return {
            minWidth: minWidth,
            maxWidth: maxWidth,
            minHeight: minHeight,
            maxHeight: maxHeight
        };
    }

    function applyPanelDimensions() {
        if (!elPanel) return;
        if (!isDesktopPanelLayout()) {
            elPanel.style.width = '';
            elPanel.style.height = '';
            if (elPanelShell) {
                elPanelShell.style.height = '';
                elPanelShell.style.maxHeight = '';
            }
            return;
        }

        var bounds = getPanelSizeBounds();
        var nextWidth = panelFrame.width ? clamp(panelFrame.width, bounds.minWidth, bounds.maxWidth) : 0;
        var nextHeight = panelFrame.height ? clamp(panelFrame.height, bounds.minHeight, bounds.maxHeight) : 0;

        if (nextWidth !== panelFrame.width || nextHeight !== panelFrame.height) {
            panelFrame.width = nextWidth;
            panelFrame.height = nextHeight;
            persistLibraryPrefs();
        }

        elPanel.style.width = nextWidth ? nextWidth + 'px' : '';
        elPanel.style.height = nextHeight ? nextHeight + 'px' : '';
        if (elPanelShell) {
            elPanelShell.style.height = nextHeight ? '100%' : '';
            elPanelShell.style.maxHeight = nextHeight ? 'none' : '';
        }
    }

    function applyStoredPanelPosition() {
        if (!elPanel) return;
        if (!isDesktopPanelLayout()) {
            elPanel.style.left = '';
            elPanel.style.top = '';
            elPanel.style.transform = '';
            return;
        }
        if (!hasStoredPanelPosition()) {
            elPanel.style.left = '';
            elPanel.style.top = '';
            elPanel.style.transform = '';
            return;
        }
        elPanel.style.left = panelFrame.left + 'px';
        elPanel.style.top = panelFrame.top + 'px';
        elPanel.style.transform = 'none';
    }

    function normalizePanelPosition() {
        if (!elPanel) return;
        var rect = elPanel.getBoundingClientRect();
        elPanel.style.left = rect.left + 'px';
        elPanel.style.top = rect.top + 'px';
        elPanel.style.transform = 'none';
    }

    function savePanelPlacement() {
        if (!elPanel || !isDesktopPanelLayout()) return;
        var hasCustomPlacement = elPanel.style.transform === 'none' || !!elPanel.style.left || !!elPanel.style.top;
        if (!hasCustomPlacement) {
            if (hasStoredPanelPosition()) {
                panelFrame.left = 0;
                panelFrame.top = 0;
                persistLibraryPrefs();
            }
            return;
        }
        var rect = elPanel.getBoundingClientRect();
        panelFrame.left = Math.round(rect.left);
        panelFrame.top = Math.round(rect.top);
        persistLibraryPrefs();
    }

    function clampPanelToViewport() {
        if (!elPanel || !libraryPanelOpen || !isDesktopPanelLayout()) return;
        if (elPanel.style.transform !== 'none' && !elPanel.style.left && !elPanel.style.top) return;

        var rect = elPanel.getBoundingClientRect();
        var margin = 12;
        var maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
        var maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
        var nextLeft = clamp(rect.left, margin, maxLeft);
        var nextTop = clamp(rect.top, margin, maxTop);

        if (nextLeft !== rect.left || nextTop !== rect.top) {
            elPanel.style.left = nextLeft + 'px';
            elPanel.style.top = nextTop + 'px';
            elPanel.style.transform = 'none';
            panelFrame.left = Math.round(nextLeft);
            panelFrame.top = Math.round(nextTop);
            persistLibraryPrefs();
        }
    }

    function handleViewportResize() {
        applyPanelDimensions();
        if (!elPanel) return;
        if (!isDesktopPanelLayout()) {
            elPanel.style.left = '';
            elPanel.style.top = '';
            elPanel.style.transform = '';
            return;
        }
        applyStoredPanelPosition();
        clampPanelToViewport();
    }

    // =========================================================
    //  Init
    // =========================================================
    function init() {
        elContainer = document.getElementById('radio-container');
        elPlay      = document.getElementById('radio-play');
        elPrev      = document.getElementById('radio-prev');
        elNext      = document.getElementById('radio-next');
        elTrack     = document.getElementById('radio-track');
        elViz       = document.getElementById('radio-viz');
        elPanel     = document.getElementById('radio-playlist-panel');
        elVolume    = document.getElementById('radio-volume');

        if (!elPlay) return;

        syncPlayButtonState();

        loadLibraryPrefs();
        loadSavedPlaylists();
        mountLibraryPanel();

        lcdUpdate('INSERT DISC', true);

        audio = document.createElement('audio');
        audio.preload = 'none';
        audio.muted = true;
        audio.volume = 0;
        document.body.appendChild(audio);

        // --- Transport ---
        elPlay.addEventListener('click', togglePlay);
        elPrev.addEventListener('click', prevTrack);
        elNext.addEventListener('click', nextTrack);

        // Volume slider
        if (elVolume) {
            elVolume.addEventListener('input', function () {
                var vol = parseFloat(elVolume.value);
                if (gainNode && audioCtx) {
                    gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
                    gainNode.gain.setValueAtTime(Math.max(vol, 0.001), audioCtx.currentTime);
                } else if (gainNode) {
                    gainNode.gain.value = vol;
                }
            });

            var volWrap = elVolume.closest('.radio-vol-wrap');
            var volTimer = null;
            function showVol() {
                if (volWrap) volWrap.classList.add('vol-visible');
                clearTimeout(volTimer);
                volTimer = setTimeout(function() {
                    if (volWrap) volWrap.classList.remove('vol-visible');
                }, 2500);
            }
            if (volWrap) {
                volWrap.addEventListener('pointerenter', showVol);
                elVolume.addEventListener('input', showVol);
                elVolume.addEventListener('touchstart', showVol, { passive: true });
            }
        }

        // Panel open/close
        elTrack.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleLibraryPanel();
        });
        if (elPanel) {
            elPanel.addEventListener('click', function (e) { e.stopPropagation(); });
        }
        if (elPanelClose) {
            elPanelClose.addEventListener('click', closeLibraryPanel);
        }
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && libraryPanelOpen) closeLibraryPanel();
        });
        document.addEventListener('radio:togglelibrary', function () {
            toggleLibraryPanel();
        });
        document.addEventListener('viz:picktrack', function (e) {
            var name = e.detail && e.detail.name;
            if (!name) return;
            playTrackByName(name, true);
        });
        document.addEventListener('viz:playlistopen', function () {
            openLibraryPanel();
        });
        window.addEventListener('resize', handleViewportResize);

        // --- Mode tabs ---
        if (elModeAdd) {
            elModeAdd.addEventListener('click', function () { setPanelMode('add'); });
        }
        if (elModePlaylist) {
            elModePlaylist.addEventListener('click', function () { setPanelMode('playlist'); });
        }

        // --- Context bar ---
        if (elContextChange) {
            elContextChange.addEventListener('change', function () {
                var val = this.value;
                if (val === '__new__') {
                    // Switch to create flow
                    libraryView.playlistId = LIBRARY_ALL_ID;
                    persistLibraryPrefs();
                    renderPanel();
                    if (elCreateInput) { elCreateInput.focus(); }
                    return;
                }
                libraryView.playlistId = val || LIBRARY_ALL_ID;
                persistLibraryPrefs();
                renderPanel();
            });
        }
        if (elContextPlay) {
            elContextPlay.addEventListener('click', function () {
                playSelectedPlaylist();
            });
        }

        // --- Create bar ---
        if (elCreateInput) {
            elCreateInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    createNewPlaylist();
                }
            });
        }
        if (elCreateBtn) {
            elCreateBtn.addEventListener('click', createNewPlaylist);
        }

        // --- Search + filters ---
        if (elSearch) {
            elSearch.addEventListener('input', function () {
                libraryView.search = elSearch.value.trim();
                renderPanel();
            });
        }
        if (elFilterArtist) {
            elFilterArtist.addEventListener('change', function () {
                libraryView.artist = this.value || '';
                persistLibraryPrefs();
                renderPanel();
            });
        }
        if (elFilterGenre) {
            elFilterGenre.addEventListener('change', function () {
                libraryView.genre = this.value || '';
                persistLibraryPrefs();
                renderPanel();
            });
        }
        if (elFilterComposer) {
            elFilterComposer.addEventListener('change', function () {
                libraryView.composer = this.value || '';
                persistLibraryPrefs();
                renderPanel();
            });
        }
        if (elModeShuffle) {
            elModeShuffle.addEventListener('click', function () { setPlayMode('shuffle'); });
        }
        if (elModeOrdered) {
            elModeOrdered.addEventListener('click', function () { setPlayMode('ordered'); });
        }
        if (elPlayView) {
            elPlayView.addEventListener('click', playCurrentView);
        }
        if (elClearFilters) {
            elClearFilters.addEventListener('click', clearLibraryFilters);
        }

        // --- Main list delegation ---
        if (elMainList) {
            elMainList.addEventListener('click', onMainListClick);
            elMainList.addEventListener('dragstart', onPlaylistDragStart);
            elMainList.addEventListener('dragover', onPlaylistDragOver);
            elMainList.addEventListener('dragleave', onPlaylistDragLeave);
            elMainList.addEventListener('drop', onPlaylistDrop);
            elMainList.addEventListener('dragend', onPlaylistDragEnd);
        }

        // Visualizer canvas
        vizW   = elViz.width;
        vizH   = elViz.height;
        vizCtx = elViz.getContext('2d');
        startViz();

        // Expose internals for visualizer + FLWeb bridge
        function playByFile(filename) {
            if (!filename) return false;
            var idx = trackIndexByName[filename];
            if (idx === undefined || idx < 0) {
                console.warn('[radio] playByFile: track not found:', filename);
                return false;
            }
            /* build a one-track queue and play */
            queue = [idx];
            queuePos = 0;
            loadTrack(idx);
            doPlay();
            console.log('[radio] playByFile: playing', filename);
            return true;
        }

        window.sbbsRadio = {
            get audioCtx()        { return audioCtx; },
            get analyserNode()    { return analyser; },
            get gainNode()        { return gainNode; },
            get audioEl()         { return audio; },
            get currentTrackFile(){ return currentTrack() ? currentTrack().name : ''; },
            get currentTrackTitle(){ return currentTrack() ? trackDisplayLabel(currentTrack()) : ''; },
            get isPlaying()       { return isPlaying; },
            get dirCode()         { return DIR_CODE; },
            playByFile: playByFile,
            toggleLibraryPanel: toggleLibraryPanel,
            openLibraryPanel: openLibraryPanel,
            closeLibraryPanel: closeLibraryPanel,
            get currentTime() {
                if (!isPlaying || !audioCtx || !_bufferSource) return _playOffset;
                return _playOffset + (audioCtx.currentTime - _playStartCtx);
            },
            get duration() {
                return _decodedBuffer ? _decodedBuffer.duration : 0;
            }
        };

        renderPanel();
        fetchPlaylist();
    }

    // =========================================================
    //  Audio context + compressor (lazy, on first user gesture)
    // =========================================================
    function ensureAudioCtx() {
        if (audioCtx) {
            if (audioCtx.state === 'suspended') return audioCtx.resume();
            return Promise.resolve();
        }

        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            inputGain = audioCtx.createGain();
            inputGain.gain.value = 0.35;

            compressor = audioCtx.createDynamicsCompressor();
            compressor.threshold.setValueAtTime(LIM_THRESHOLD, audioCtx.currentTime);
            compressor.knee.setValueAtTime(LIM_KNEE, audioCtx.currentTime);
            compressor.ratio.setValueAtTime(LIM_RATIO, audioCtx.currentTime);
            compressor.attack.setValueAtTime(LIM_ATTACK, audioCtx.currentTime);
            compressor.release.setValueAtTime(LIM_RELEASE, audioCtx.currentTime);

            analyser        = audioCtx.createAnalyser();
            analyser.fftSize = 64;

            gainNode = audioCtx.createGain();
            gainNode.gain.value = elVolume ? parseFloat(elVolume.value) : 0.8;

            inputGain.connect(compressor);
            compressor.connect(gainNode);
            gainNode.connect(analyser);
            analyser.connect(audioCtx.destination);

            audioCtx.addEventListener('statechange', function () {
                console.log('[radio] AudioContext state changed to:', audioCtx.state);
                if (audioCtx.state === 'suspended' && isPlaying) {
                    console.log('[radio] attempting auto-resume...');
                    audioCtx.resume().catch(function () {});
                }
                if (audioCtx.state === 'running' && isPlaying && !_bufferSource && _decodedBuffer) {
                    console.log('[radio] context resumed but source lost — restarting playback');
                    _pendingPlay = true;
                    _startBufferPlayback();
                }
            });

            console.log('[radio] AudioContext created (decodeAudioData mode), state:', audioCtx.state);

            setInterval(function () {
                if (!isPlaying || !audioCtx || audioCtx.state !== 'running') return;
                if (!_bufferSource || !analyser) return;
                var testData = new Uint8Array(analyser.frequencyBinCount);
                analyser.getByteFrequencyData(testData);
                var sum = 0;
                for (var i = 0; i < testData.length; i++) sum += testData[i];
                if (sum > 0 && !document.hidden && audioCtx._lastHealthKick) {
                    var elapsed = performance.now() - audioCtx._lastHealthKick;
                    if (elapsed > 30000) {
                        audioCtx._lastHealthKick = performance.now();
                        audioCtx.suspend().then(function () {
                            return audioCtx.resume();
                        }).catch(function () {});
                    }
                } else if (sum > 0) {
                    audioCtx._lastHealthKick = performance.now();
                }
            }, 5000);

            if (audioCtx.state === 'suspended') return audioCtx.resume();
            return Promise.resolve();
        } catch (e) {
            console.error('[radio] AudioContext failed:', e);
            audioCtx = null;
            return Promise.resolve();
        }
    }

    // =========================================================
    //  Playlist fetch
    // =========================================================
    function fetchPlaylist() {
        fetch(API_URL)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.error) {
                    console.warn('[radio] API error:', data.error);
                    lcdUpdate('INSERT DISC', true);
                    return;
                }
                if (!Array.isArray(data) || data.length === 0) {
                    lcdUpdate('INSERT DISC', true);
                    return;
                }
                playlist = data.map(normalizeTrack).filter(function (track) {
                    return !!track.name;
                });
                rebuildTrackIndexLookup();
                buildQueueFromIndices(getDefaultQueueIndices(), -1);
                renderPanel();
                hydrateTrackMetadata();
                lcdUpdate('INSERT DISC', true);
                console.log('[radio] playlist loaded:', playlist.length, 'tracks');
            })
            .catch(function (err) {
                console.error('[radio] fetch error:', err);
                lcdUpdate('INSERT DISC', true);
            });
    }

    function refreshPlaylist() {
        fetch(API_URL)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!Array.isArray(data) || data.length === 0) return;
                var known = {};
                for (var i = 0; i < playlist.length; i++) {
                    known[playlist[i].name] = true;
                }
                var added = 0;
                for (var j = 0; j < data.length; j++) {
                    if (!known[data[j].name]) {
                        playlist.push(normalizeTrack(data[j]));
                        added++;
                    }
                }
                if (added > 0) {
                    rebuildTrackIndexLookup();
                    console.log('[radio] refreshed: ' + added + ' new track(s), ' + playlist.length + ' total');
                    renderPanel();
                    hydrateTrackMetadata();
                    if (!isPlaying && queuePos < 0) {
                        lcdUpdate('INSERT DISC', true);
                    }
                } else {
                    console.log('[radio] refresh: no new tracks');
                }
            })
            .catch(function (err) {
                console.warn('[radio] refresh error:', err);
            });
    }

    // =========================================================
    //  Library state + queue management
    // =========================================================
    function findSavedPlaylist(id) {
        for (var i = 0; i < savedPlaylists.length; i++) {
            if (savedPlaylists[i].id === id) return savedPlaylists[i];
        }
        return null;
    }

    function selectedPlaylistEntry() {
        if (libraryView.playlistId === LIBRARY_ALL_ID) return null;
        return findSavedPlaylist(libraryView.playlistId);
    }

    function allTrackIndices() {
        var indices = [];
        for (var i = 0; i < playlist.length; i++) indices.push(i);
        return indices;
    }

    function playlistHasTrack(entry, trackName) {
        return !!(entry && entry.trackNames && entry.trackNames.indexOf(trackName) >= 0);
    }

    function getSelectedPlaylistIndices() {
        var indices = [];
        var saved = selectedPlaylistEntry();
        if (!saved) return indices;
        for (var i = 0; i < saved.trackNames.length; i++) {
            var idx = typeof trackIndexByName[saved.trackNames[i]] === 'number' ? trackIndexByName[saved.trackNames[i]] : -1;
            if (idx >= 0) indices.push(idx);
        }
        return indices;
    }

    function trackMatchesSearchValue(track, searchValue) {
        if (!searchValue) return true;
        var haystack = [
            trackTitle(track),
            trackArtist(track),
            trackComposer(track),
            trackGenre(track),
            trackAlbum(track),
            trackYear(track),
            track.name
        ].join(' ').toLowerCase();
        return haystack.indexOf(String(searchValue).toLowerCase()) >= 0;
    }

    function trackMatchesLibraryFilters(track, ignoreKey) {
        if (!trackMatchesSearchValue(track, libraryView.search)) return false;
        if (ignoreKey !== 'artist' && libraryView.artist && trackArtist(track) !== libraryView.artist) return false;
        if (ignoreKey !== 'genre' && libraryView.genre && trackGenre(track) !== libraryView.genre) return false;
        if (ignoreKey !== 'composer' && libraryView.composer && trackComposer(track) !== libraryView.composer) return false;
        return true;
    }

    function getLibraryFilteredTrackIndices(ignoreKey) {
        var selected = selectedPlaylistEntry();
        return allTrackIndices().filter(function (idx) {
            if (!trackMatchesLibraryFilters(playlist[idx], ignoreKey || '')) return false;
            return true;
        });
    }

    function getSelectedPlaylistFilteredIndices() {
        return getSelectedPlaylistIndices().filter(function (idx) {
            return trackMatchesSearchValue(playlist[idx], libraryView.playlistSearch);
        });
    }

    function uniqueFilterValues(indices, getter) {
        var map = {};
        var out = [];
        indices.forEach(function (idx) {
            var value = getter(playlist[idx]).trim();
            if (!value) return;
            var key = value.toLowerCase();
            if (map[key]) return;
            map[key] = true;
            out.push(value);
        });
        out.sort(function (a, b) { return a.localeCompare(b); });
        return out;
    }

    function fillFilterSelect(selectEl, label, value, options) {
        var html = '<option value="">All ' + label + '</option>';
        options.forEach(function (option) {
            html += '<option value="' + escHtml(option) + '">' + escHtml(option) + '</option>';
        });
        selectEl.innerHTML = html;
        selectEl.value = value || '';
        if (selectEl.value !== (value || '')) selectEl.value = '';
    }

    function uniquePlaylistName(baseName, excludeId) {
        var base = String(baseName || '').trim() || 'New Playlist';
        var next = base;
        var suffix = 2;
        function hasConflict(name) {
            for (var i = 0; i < savedPlaylists.length; i++) {
                if (excludeId && savedPlaylists[i].id === excludeId) continue;
                if (savedPlaylists[i].name.toLowerCase() === name.toLowerCase()) return true;
            }
            return false;
        }
        while (hasConflict(next)) {
            next = base + ' ' + suffix;
            suffix++;
        }
        return next;
    }

    // =========================================================
    //  Playlist CRUD
    // =========================================================
    function createNewPlaylist() {
        var name = elCreateInput ? elCreateInput.value.trim() : '';
        if (!name) name = 'Futureland Mix';
        var resolved = uniquePlaylistName(name, null);
        var entry = {
            id: 'playlist-' + Date.now().toString(36),
            name: resolved,
            trackNames: []
        };
        savedPlaylists.push(entry);
        libraryView.playlistId = entry.id;
        if (elCreateInput) elCreateInput.value = '';
        persistSavedPlaylists();
        persistLibraryPrefs();
        setPanelMode('add');
        renderPanel();
    }

    function createPlaylistEntry(name, makeSelected) {
        var entry = {
            id: 'playlist-' + Date.now().toString(36),
            name: uniquePlaylistName(name, null),
            trackNames: []
        };
        savedPlaylists.push(entry);
        if (makeSelected !== false) {
            libraryView.playlistId = entry.id;
        }
        persistSavedPlaylists();
        persistLibraryPrefs();
        return entry;
    }

    function ensureSelectedPlaylist() {
        var selected = selectedPlaylistEntry();
        if (selected) return selected;
        return createPlaylistEntry('Futureland Mix', true);
    }

    function addTrackToPlaylistEntry(entry, trackName) {
        if (!entry || !trackName || playlistHasTrack(entry, trackName)) return false;
        entry.trackNames.push(trackName);
        persistSavedPlaylists();
        persistLibraryPrefs();
        renderPanel();
        return true;
    }

    function addTrackToSelectedPlaylist(trackName) {
        var selected = ensureSelectedPlaylist();
        addTrackToPlaylistEntry(selected, trackName);
    }

    function removeTrackFromSelectedPlaylist(pos) {
        var selected = selectedPlaylistEntry();
        if (!selected || pos < 0 || pos >= selected.trackNames.length) return;
        selected.trackNames.splice(pos, 1);
        persistSavedPlaylists();
        renderPanel();
    }

    function removeTrackByNameFromSelectedPlaylist(trackName) {
        var selected = selectedPlaylistEntry();
        if (!selected) return;
        var pos = selected.trackNames.indexOf(trackName);
        if (pos === -1) return;
        selected.trackNames.splice(pos, 1);
        persistSavedPlaylists();
        renderPanel();
    }

    function removeTrackByNameFromSelectedPlaylist(trackName) {
        var selected = selectedPlaylistEntry();
        if (!selected) return;
        var pos = selected.trackNames.indexOf(trackName);
        if (pos === -1) return;
        selected.trackNames.splice(pos, 1);
        persistSavedPlaylists();
        renderPanel();
    }

    function moveTrackInSelectedPlaylist(fromPos, toPos) {
        var selected = selectedPlaylistEntry();
        if (!selected) return;
        if (fromPos === toPos || fromPos < 0 || toPos < 0) return;
        if (fromPos >= selected.trackNames.length || toPos >= selected.trackNames.length) return;
        var moved = selected.trackNames.splice(fromPos, 1)[0];
        selected.trackNames.splice(toPos, 0, moved);
        persistSavedPlaylists();
        renderPanel();
    }

    function deleteSelectedPlaylist() {
        var target = selectedPlaylistEntry();
        if (!target) return;
        if (!window.confirm('Delete playlist "' + target.name + '"?')) return;
        savedPlaylists = savedPlaylists.filter(function (entry) {
            return entry.id !== target.id;
        });
        libraryView.playlistId = LIBRARY_ALL_ID;
        libraryView.playlistSearch = '';
        persistSavedPlaylists();
        persistLibraryPrefs();
        renderPanel();
    }

    // =========================================================
    //  Panel mode + open/close
    // =========================================================
    function setPanelMode(mode) {
        panelMode = mode === 'playlist' ? 'playlist' : 'add';
        persistLibraryPrefs();
        renderPanel();
        // Focus the right input
        if (panelMode === 'add' && elSearch) {
            setTimeout(function () { elSearch.focus(); }, 30);
        }
    }

    function openLibraryPanel() {
        if (!elPanel) return;
        refreshPlaylist();
        libraryPanelOpen = true;
        ensureLibraryBackdrop().classList.add('show');
        elPanel.classList.add('show');
        document.body.classList.add('radio-library-open');
        applyPanelDimensions();
        applyStoredPanelPosition();
        clampPanelToViewport();
        renderPanel();
        if (panelMode === 'add' && elSearch) {
            setTimeout(function () { elSearch.focus(); elSearch.select(); }, 30);
        }
    }

    function closeLibraryPanel() {
        onPanelDragEnd();
        onPanelResizeEnd();
        savePanelPlacement();

        if (!elPanel) return;
        libraryPanelOpen = false;
        if (libraryBackdrop) libraryBackdrop.classList.remove('show');
        elPanel.classList.remove('show');
        document.body.classList.remove('radio-library-open');
    }

    function toggleLibraryPanel() {
        if (libraryPanelOpen) closeLibraryPanel();
        else openLibraryPanel();
    }

    // =========================================================
    //  Queue helpers
    // =========================================================
    function getDefaultQueueIndices() {
        var indices = getSelectedPlaylistFilteredIndices();
        if (indices.length) return indices;
        indices = getLibraryFilteredTrackIndices();
        if (indices.length) return indices;
        return allTrackIndices();
    }

    function shuffleIndices(indices) {
        var out = indices.slice();
        for (var i = out.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var temp = out[i];
            out[i] = out[j];
            out[j] = temp;
        }
        return out;
    }

    function buildQueueFromIndices(indices, startIdx) {
        var hasStart = typeof startIdx === 'number' && startIdx >= 0;
        if (!indices || !indices.length) {
            queue = [];
            queuePos = -1;
            return false;
        }
        queue = playMode === 'shuffle' ? shuffleIndices(indices) : indices.slice();
        queuePos = hasStart ? queue.indexOf(startIdx) : -1;
        if (hasStart && queuePos < 0) queuePos = 0;
        return true;
    }

    function setPlayMode(mode) {
        if (mode !== 'shuffle' && mode !== 'ordered') return;
        if (playMode === mode) return;
        playMode = mode;
        var currentIdx = currentTrackIndex();
        if (currentIdx >= 0) {
            var scope = queue.length ? queue.slice() : getDefaultQueueIndices();
            if (scope.indexOf(currentIdx) < 0) scope = getDefaultQueueIndices();
            buildQueueFromIndices(scope, currentIdx);
        } else {
            buildQueueFromIndices(getDefaultQueueIndices(), -1);
        }
        persistLibraryPrefs();
        renderPanel();
    }

    function playTrackByIndex(idx, autoplay, scopeIndices) {
        var scope = scopeIndices && scopeIndices.length ? scopeIndices.slice() : getDefaultQueueIndices();
        if (scope.indexOf(idx) < 0) scope.unshift(idx);
        buildQueueFromIndices(scope, idx);
        loadTrack(idx);
        if (autoplay !== false) doPlay();
    }

    function playTrackByName(name, autoplay) {
        var idx = typeof trackIndexByName[name] === 'number' ? trackIndexByName[name] : -1;
        if (idx < 0) {
            playlist.push(normalizeTrack({ name: name }));
            rebuildTrackIndexLookup();
            idx = trackIndexByName[name];
        }
        playTrackByIndex(idx, autoplay !== false, getLibraryFilteredTrackIndices());
    }

    function playCurrentView() {
        var indices = getLibraryFilteredTrackIndices();
        var idx = indices.length ? indices[0] : -1;
        var currentIdx = currentTrackIndex();
        if (!indices.length) {
            window.alert('No tracks match the current filters.');
            return;
        }
        if (currentIdx >= 0 && indices.indexOf(currentIdx) >= 0) idx = currentIdx;
        playTrackByIndex(idx, true, indices);
        closeLibraryPanel();
    }

    function playSelectedPlaylist() {
        var selected = selectedPlaylistEntry();
        var indices = getSelectedPlaylistFilteredIndices();
        var idx = indices.length ? indices[0] : -1;
        var currentIdx = currentTrackIndex();
        if (!selected) {
            window.alert('Choose or create a playlist first.');
            return;
        }
        if (!indices.length) {
            window.alert('This playlist is empty.');
            return;
        }
        if (currentIdx >= 0 && indices.indexOf(currentIdx) >= 0) idx = currentIdx;
        playTrackByIndex(idx, true, indices);
        closeLibraryPanel();
    }

    function clearLibraryFilters() {
        libraryView.search = '';
        libraryView.artist = '';
        libraryView.genre = '';
        libraryView.composer = '';
        libraryView.composer = '';
        if (elSearch) elSearch.value = '';
        persistLibraryPrefs();
        renderPanel();
    }

    // =========================================================
    //  Metadata hydration
    // =========================================================
    function applyTrackTags(track, tags) {
        track.tags = tags || {};
        track.metaLoaded = true;
        track.metaLoading = false;
        if (!track.artURL && tags && tags.picture && tags.picture.blob) {
            track.artURL = URL.createObjectURL(tags.picture.blob);
        }
        if (currentTrack() && currentTrack().name === track.name) {
            var display = trackDisplayLabel(track);
            lcdUpdate(display, false);
            updateMediaSession(track);
            document.dispatchEvent(new CustomEvent('radio:trackchange', {
                detail: { filename: track.name, display: display }
            }));
        }
    }

    function scheduleLibraryRender() {
        clearTimeout(metadataHydrateTimer);
        metadataHydrateTimer = setTimeout(function () {
            renderPanel();
        }, 40);
    }

    function hydrateTrackMetadata() {
        if (typeof window.parseID3v2 !== 'function' || !playlist.length) return;
        var pending = playlist.filter(function (track) {
            return !track.metaLoaded && !track.metaLoading;
        });
        var token = ++metadataHydrateToken;
        var workers = Math.min(3, pending.length);
        function nextFetch() {
            var track = pending.shift();
            if (!track || token !== metadataHydrateToken) return Promise.resolve();
            track.metaLoading = true;
            return fetch(FILE_URL + encodeURIComponent(track.name), {
                headers: { Range: 'bytes=0-' + (META_RANGE_BYTES - 1) }
            })
                .then(function (response) {
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    return response.arrayBuffer();
                })
                .then(function (buffer) {
                    var tags = {};
                    try { tags = window.parseID3v2(buffer) || {}; } catch (_) { tags = {}; }
                    applyTrackTags(track, tags);
                })
                .catch(function () {
                    track.metaLoaded = true;
                    track.metaLoading = false;
                })
                .then(function () {
                    scheduleLibraryRender();
                    return nextFetch();
                });
        }
        if (!workers) return;
        while (workers-- > 0) nextFetch();
    }

    // =========================================================
    //  Transport controls
    // =========================================================
    function syncPlayButtonState() {
        var label;

        if (!elPlay) return;

        label = isPlaying ? 'Pause BBS Radio' : 'Play BBS Radio';
        elPlay.classList.toggle('is-playing', !!isPlaying);
        elPlay.title = label;
        elPlay.setAttribute('aria-label', label);
    }

    function togglePlay() {
        if (playlist.length === 0) return;
        if (isPlaying) {
            if (audioCtx && _bufferSource) {
                _playOffset += audioCtx.currentTime - _playStartCtx;
            }
            _stopSource();
            isPlaying = false;
            _pendingPlay = false;
            document.dispatchEvent(new CustomEvent('radio:statechange', { detail: { playing: false } }));
            syncPlayButtonState();
        } else {
            if (queuePos < 0 || !queue.length) {
                if (!buildQueueFromIndices(getDefaultQueueIndices(), -1)) return;
                queuePos = 0;
                loadTrack(queue[queuePos]);
            }
            doPlay();
        }
    }

    function nextTrack() {
        if (playlist.length === 0) return;
        if (!queue.length && !buildQueueFromIndices(getDefaultQueueIndices(), -1)) return;
        queuePos++;
        if (queuePos >= queue.length) {
            var scope = queue.slice();
            queue = playMode === 'shuffle' ? shuffleIndices(scope) : scope.slice();
            queuePos = 0;
        }
        var wasPlaying = isPlaying || _trackEnded;
        _trackEnded = false;
        loadTrack(queue[queuePos]);
        if (wasPlaying) doPlay();
    }

    function prevTrack() {
        if (playlist.length === 0) return;
        if (!queue.length && !buildQueueFromIndices(getDefaultQueueIndices(), -1)) return;
        var pos = _playOffset + (isPlaying && audioCtx ? audioCtx.currentTime - _playStartCtx : 0);
        if (pos > 3 && _decodedBuffer) {
            _stopSource();
            _playOffset = 0;
            doPlay();
            return;
        }
        queuePos--;
        if (queuePos < 0) queuePos = queue.length - 1;
        loadTrack(queue[queuePos]);
        if (isPlaying) doPlay();
    }

    function doPlay() {
        _pendingPlay = true;
        ensureAudioCtx().then(function () {
            if (_pendingPlay && _decodedBuffer) _startBufferPlayback();
        });
    }

    function _stopSource() {
        if (_bufferSource) {
            _bufferSource.onended = null;
            try { _bufferSource.stop(); } catch (e) {}
            try { _bufferSource.disconnect(); } catch (e) {}
            _bufferSource = null;
        }
    }

    function _startBufferPlayback() {
        if (!_pendingPlay) return;
        if (!_decodedBuffer || !audioCtx || !inputGain) return;
        _pendingPlay = false;

        _stopSource();

        _bufferSource = audioCtx.createBufferSource();
        _bufferSource.buffer = _decodedBuffer;
        _bufferSource.connect(inputGain);

        var mySource = _bufferSource;
        _bufferSource.onended = function () {
            if (_bufferSource !== mySource) return;
            console.log('[radio] buffer ended, advancing');
            _trackEnded = true;
            isPlaying = false;
            nextTrack();
        };

        var targetVol = elVolume ? parseFloat(elVolume.value) : 0.8;
        var now = audioCtx.currentTime;
        gainNode.gain.cancelScheduledValues(now);
        gainNode.gain.setValueAtTime(0.001, now);
        gainNode.gain.exponentialRampToValueAtTime(
            Math.max(targetVol, 0.001),
            now + FADE_IN_S
        );

        _playStartCtx = now;
        _bufferSource.start(0, _playOffset);

        isPlaying = true;
        document.dispatchEvent(new CustomEvent('radio:statechange', { detail: { playing: true } }));
        syncPlayButtonState();
        startViz();

        if (!_firstPlayFired) {
            _firstPlayFired = true;
            if (!sessionStorage.getItem('radioPlayed')) {
                sessionStorage.setItem('radioPlayed', '1');
                if (window.sbbsVisualizer && window.sbbsVisualizer.show) {
                    setTimeout(function () { window.sbbsVisualizer.show(); }, 300);
                }
            }
        }
    }

    function loadTrack(idx) {
        var t = playlist[idx];
        if (!t) return;

        _pendingPlay = false;
        _trackEnded  = false;
        _loadGen++;
        var myGen = _loadGen;

        _stopSource();
        _decodedBuffer = null;
        _playOffset    = 0;

        if (gainNode && audioCtx) {
            gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
            gainNode.gain.setValueAtTime(0.001, audioCtx.currentTime);
        }
        var display = trackDisplayLabel(t);
        lcdUpdate('\u266B LOADING\u2026', false);
        highlightCurrent(idx);

        var url = FILE_URL + encodeURIComponent(t.name);
        console.log('[radio] fetching track:', t.name, url);

        fetch(url)
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.arrayBuffer();
            })
            .then(function (arrayBuf) {
                if (myGen !== _loadGen) return;
                if (typeof window.parseID3v2 === 'function') {
                    try {
                        applyTrackTags(t, window.parseID3v2(arrayBuf) || {});
                        display = trackDisplayLabel(t);
                    } catch (_) {}
                }
                return ensureAudioCtx().then(function () {
                    if (!audioCtx) throw new Error('No AudioContext');
                    return audioCtx.decodeAudioData(arrayBuf);
                });
            })
            .then(function (audioBuffer) {
                if (!audioBuffer) return;
                if (myGen !== _loadGen) return;
                _decodedBuffer = audioBuffer;
                console.log('[radio] decoded:', t.name,
                    (audioBuffer.duration | 0) + 's',
                    audioBuffer.sampleRate + 'Hz',
                    audioBuffer.numberOfChannels + 'ch');

                lcdUpdate(display);
                elTrack.title = display;
                updateMediaSession(t);

                try {
                    document.dispatchEvent(new CustomEvent('radio:trackchange', {
                        detail: { filename: t.name, display: display }
                    }));
                } catch(e) {}

                if (_pendingPlay) _startBufferPlayback();
            })
            .catch(function (err) {
                if (myGen !== _loadGen) return;
                console.warn('[radio] load/decode error:', err);
                lcdUpdate('LOAD ERROR', true);
                var wantPlay = _pendingPlay || isPlaying;
                setTimeout(function () {
                    if (myGen !== _loadGen) return;
                    if (wantPlay) _trackEnded = true;
                    nextTrack();
                }, 1500);
            });
    }

    // =========================================================
    //  Media Session API
    // =========================================================
    function updateMediaSession(track) {
        var display = track ? trackTitle(track) : 'BBS Radio';
        var artist = track ? (trackArtist(track) || 'futureland.today') : 'futureland.today';
        var album = track ? (trackAlbum(track) || 'BBS Radio') : 'BBS Radio';
        if (!('mediaSession' in navigator)) return;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: display || 'BBS Radio',
                artist: artist,
                album: album
            });
            navigator.mediaSession.setActionHandler('play', function() { doPlay(); });
            navigator.mediaSession.setActionHandler('pause', function() {
                if (audioCtx && _bufferSource) {
                    _playOffset += audioCtx.currentTime - _playStartCtx;
                }
                _stopSource();
                isPlaying = false;
                _pendingPlay = false;
                document.dispatchEvent(new CustomEvent('radio:statechange', { detail: { playing: false } }));
                syncPlayButtonState();
            });
            navigator.mediaSession.setActionHandler('previoustrack', function() { prevTrack(); });
            navigator.mediaSession.setActionHandler('nexttrack', function() { nextTrack(); });
        } catch(e) {
            console.warn('[radio] mediaSession error:', e);
        }
    }

    // =========================================================
    //  Mini wireframe head (navbar viz mode 2)
    // =========================================================
    var _miniHeadRot = 0;
    var _MINI_GREEN = '51,255,51';
    var _MINI_PROFILE = [
        [0.00, -0.80], [0.22, -0.70], [0.38, -0.58],
        [0.48, -0.42], [0.52, -0.25], [0.50, -0.08],
        [0.46,  0.08], [0.44,  0.22], [0.42,  0.36],
        [0.37,  0.48], [0.28,  0.58], [0.15,  0.65],
        [0.00,  0.68]
    ];
    var _MINI_RING_N = 10;

    function drawMiniHead(overlay) {
        if (!vizCtx) return;
        var W = vizW, H = vizH;
        if (!overlay) {
            vizCtx.clearRect(0, 0, W, H);
            vizCtx.fillStyle = '#000a00';
            vizCtx.fillRect(0, 0, W, H);
        }
        if (overlay) vizCtx.globalAlpha = 0.35;

        var cx = W / 2, cy = H * 0.46;
        var S = Math.min(W, H) * 0.38;
        _miniHeadRot += 0.012;

        var cosY = Math.cos(_miniHeadRot), sinY = Math.sin(_miniHeadRot);
        var cosX = Math.cos(0.15), sinX = Math.sin(0.15);
        var FL = 4.0;

        function proj(x, y, z) {
            var rx = x * cosY - z * sinY;
            var rz = x * sinY + z * cosY;
            var ry2 = y * cosX - rz * sinX;
            var rz2 = y * sinX + rz * cosX;
            var d = FL / (FL + rz2);
            return { x: cx + rx * S * d, y: cy - ry2 * S * d };
        }

        var rings = [];
        for (var p = 0; p < _MINI_PROFILE.length; p++) {
            var ring = [];
            var rad = _MINI_PROFILE[p][0], yy = _MINI_PROFILE[p][1];
            for (var s = 0; s < _MINI_RING_N; s++) {
                var a = (s / _MINI_RING_N) * Math.PI * 2;
                ring.push(proj(rad * Math.cos(a), yy, rad * Math.sin(a)));
            }
            rings.push(ring);
        }

        vizCtx.lineCap = vizCtx.lineJoin = 'round';
        vizCtx.shadowBlur = 4;
        vizCtx.shadowColor = 'rgb(' + _MINI_GREEN + ')';
        vizCtx.strokeStyle = 'rgba(' + _MINI_GREEN + ',0.5)';
        vizCtx.lineWidth = 0.8;

        for (var r = 0; r < rings.length; r++) {
            vizCtx.beginPath();
            for (var i = 0; i < rings[r].length; i++) {
                var pt = rings[r][i];
                i === 0 ? vizCtx.moveTo(pt.x, pt.y) : vizCtx.lineTo(pt.x, pt.y);
            }
            vizCtx.closePath();
            vizCtx.stroke();
        }

        vizCtx.strokeStyle = 'rgba(' + _MINI_GREEN + ',0.25)';
        vizCtx.lineWidth = 0.5;
        for (var s2 = 0; s2 < _MINI_RING_N; s2 += 2) {
            vizCtx.beginPath();
            for (var r2 = 0; r2 < rings.length; r2++) {
                var pt2 = rings[r2][s2];
                r2 === 0 ? vizCtx.moveTo(pt2.x, pt2.y) : vizCtx.lineTo(pt2.x, pt2.y);
            }
            vizCtx.stroke();
        }

        vizCtx.shadowBlur = 6;
        vizCtx.shadowColor = 'rgb(' + _MINI_GREEN + ')';
        vizCtx.fillStyle = 'rgba(' + _MINI_GREEN + ',0.8)';
        var lEye = proj(-0.18, -0.05, 0.45);
        var rEye = proj(0.18, -0.05, 0.45);
        vizCtx.beginPath(); vizCtx.arc(lEye.x, lEye.y, 1.8, 0, Math.PI * 2); vizCtx.fill();
        vizCtx.beginPath(); vizCtx.arc(rEye.x, rEye.y, 1.8, 0, Math.PI * 2); vizCtx.fill();

        vizCtx.shadowBlur = 0;
        if (overlay) vizCtx.globalAlpha = 1.0;
    }

    // =========================================================
    //  Panel rendering — single-pane
    // =========================================================
    function renderPanel() {
        if (!elMainList) return;

        var selected = selectedPlaylistEntry();
        var hasPlaylist = !!selected;

        // --- Mode tabs ---
        if (elModeAdd) {
            elModeAdd.classList.toggle('is-active', panelMode === 'add');
            elModeAdd.setAttribute('aria-selected', panelMode === 'add' ? 'true' : 'false');
        }
        if (elModePlaylist) {
            elModePlaylist.classList.toggle('is-active', panelMode === 'playlist');
            elModePlaylist.setAttribute('aria-selected', panelMode === 'playlist' ? 'true' : 'false');
            // Show track count badge on Playlist tab
            if (selected && selected.trackNames.length) {
                elModePlaylist.textContent = 'Playlist (' + selected.trackNames.length + ')';
            } else {
                elModePlaylist.textContent = 'Playlist';
            }
        }

        // --- Context bar vs. Create bar ---
        if (elContextBar) elContextBar.style.display = hasPlaylist ? '' : 'none';
        if (elCreateBar) elCreateBar.style.display = hasPlaylist ? 'none' : '';

        // --- Context bar: fill playlist picker ---
        if (elContextChange && hasPlaylist) {
            var ctxHtml = '';
            savedPlaylists.forEach(function (entry) {
                ctxHtml += '<option value="' + escHtml(entry.id) + '">' + escHtml(entry.name) + '</option>';
            });
            ctxHtml += '<option value="__new__">+ New Playlist</option>';
            elContextChange.innerHTML = ctxHtml;
            elContextChange.value = libraryView.playlistId;
        }
        if (elContextCount && hasPlaylist) {
            elContextCount.textContent = selected.trackNames.length + ' track' + (selected.trackNames.length === 1 ? '' : 's');
        }
        if (elContextPlay) {
            elContextPlay.disabled = !hasPlaylist || !selected || !selected.trackNames.length;
        }

        // --- Toolbar visibility (only in Add mode) ---
        var toolbarEl = document.getElementById('rl-toolbar');
        if (toolbarEl) toolbarEl.style.display = panelMode === 'add' ? '' : 'none';

        // --- Populate filters ---
        if (panelMode === 'add') {
            var artistOptions = uniqueFilterValues(getLibraryFilteredTrackIndices('artist'), trackArtist);
            var genreOptions = uniqueFilterValues(getLibraryFilteredTrackIndices('genre'), trackGenre);
            if (elFilterArtist) {
                fillFilterSelect(elFilterArtist, 'artists', libraryView.artist, artistOptions);
                libraryView.artist = elFilterArtist.value || '';
            }
            if (elFilterGenre) {
                fillFilterSelect(elFilterGenre, 'genres', libraryView.genre, genreOptions);
                libraryView.genre = elFilterGenre.value || '';
            }
            var composerOptions = uniqueFilterValues(getLibraryFilteredTrackIndices('composer'), trackComposer);
            if (elFilterComposer) {
                fillFilterSelect(elFilterComposer, 'composers', libraryView.composer, composerOptions);
                libraryView.composer = elFilterComposer.value || '';
            }
            if (elSearch && elSearch.value !== libraryView.search) elSearch.value = libraryView.search;
        }

        // --- Playmode buttons ---
        if (elModeShuffle) elModeShuffle.classList.toggle('is-active', playMode === 'shuffle');
        if (elModeOrdered) elModeOrdered.classList.toggle('is-active', playMode === 'ordered');

        // --- Summary ---
        if (panelMode === 'add') {
            renderAddMode();
        } else {
            renderPlaylistMode();
        }

        persistLibraryPrefs();
    }

    function renderAddMode() {
        var indices = getLibraryFilteredTrackIndices();
        var selected = selectedPlaylistEntry();

        // Summary
        if (elSummary) {
            var artists = {};
            indices.forEach(function (idx) {
                var a = trackArtist(playlist[idx]);
                if (a) artists[a.toLowerCase()] = true;
            });
            var parts = [indices.length + ' track' + (indices.length === 1 ? '' : 's')];
            var artistCount = Object.keys(artists).length;
            if (artistCount > 0) parts.push(artistCount + ' artist' + (artistCount === 1 ? '' : 's'));
            if (selected && selected.trackNames.length) parts.push(selected.trackNames.length + ' already in ' + selected.name);
            parts.push(playMode === 'shuffle' ? 'Shuffle' : 'In order');
            elSummary.textContent = parts.join(' \u00B7 ');
        }

        // Track list
        elMainList.innerHTML = '';
        if (!indices.length) {
            elMainList.innerHTML = '<div class="rl-empty">No tracks match the current filters.</div>';
            return;
        }

        var frag = document.createDocumentFragment();
        indices.forEach(function (idx) {
            var track = playlist[idx];
            var item = document.createElement('div');
            item.className = 'rl-track';
            if (currentTrackIndex() === idx) item.classList.add('is-current');
            item.setAttribute('data-idx', String(idx));

            // Art
            var art = document.createElement('div');
            art.className = 'rl-track-art';
            if (track.artURL) {
                var img = document.createElement('img');
                img.src = track.artURL;
                img.alt = '';
                art.appendChild(img);
            } else {
                art.textContent = '\u266B';
            }
            item.appendChild(art);

            // Body
            var body = document.createElement('div');
            body.className = 'rl-track-body';

            var title = document.createElement('div');
            title.className = 'rl-track-title';
            title.textContent = trackTitle(track);
            body.appendChild(title);

            var artist = trackArtist(track);
            if (artist) {
                var sub = document.createElement('div');
                sub.className = 'rl-track-artist';
                sub.textContent = artist;
                body.appendChild(sub);
            }

            var genre = trackGenre(track);
            if (genre) {
                var chip = document.createElement('span');
                chip.className = 'rl-track-chip';
                chip.textContent = genre;
                body.appendChild(chip);
            }

            item.appendChild(body);

            // Actions
            var actions = document.createElement('div');
            actions.className = 'rl-track-actions';

            // Add/Remove toggle button (primary, fixed width)
            if (selected) {
                var alreadyAdded = playlistHasTrack(selected, track.name);
                var addBtn = document.createElement('button');
                addBtn.type = 'button';
                addBtn.className = 'rl-action rl-action-add' + (alreadyAdded ? ' is-added' : '');
                addBtn.setAttribute('data-action', alreadyAdded ? 'unadd' : 'add');
                addBtn.setAttribute('data-idx', String(idx));
                addBtn.textContent = alreadyAdded ? '\u2713 Added' : '+ Add';
                actions.appendChild(addBtn);
            }

            // Play button (secondary, small — at end)
            var playBtn = document.createElement('button');
            playBtn.type = 'button';
            playBtn.className = 'rl-action rl-action-play';
            playBtn.setAttribute('data-action', 'play');
            playBtn.setAttribute('data-idx', String(idx));
            playBtn.textContent = currentTrackIndex() === idx ? '\u25A0' : '\u25B6';
            playBtn.title = 'Play now';
            actions.appendChild(playBtn);

            item.appendChild(actions);
            frag.appendChild(item);
        });

        elMainList.appendChild(frag);
    }

    function renderPlaylistMode() {
        var selected = selectedPlaylistEntry();

        // Summary
        if (elSummary) {
            if (!selected) {
                elSummary.textContent = 'No playlist selected.';
            } else {
                elSummary.textContent = selected.trackNames.length + ' track' + (selected.trackNames.length === 1 ? '' : 's')
                    + ' in ' + selected.name;
            }
        }

        elMainList.innerHTML = '';

        if (!selected) {
            elMainList.innerHTML = '<div class="rl-empty">Create or choose a playlist to get started.</div>';
            return;
        }

        if (!selected.trackNames.length) {
            elMainList.innerHTML = '<div class="rl-empty">This playlist is empty. Switch to <strong>Add Tracks</strong> to find songs.</div>';
            return;
        }

        var frag = document.createDocumentFragment();
        var plIndices = getSelectedPlaylistIndices();

        plIndices.forEach(function (idx) {
            var track = playlist[idx];
            var pos = selected.trackNames.indexOf(track.name);
            var item = document.createElement('div');
            item.className = 'rl-track rl-track-pl';
            if (currentTrackIndex() === idx) item.classList.add('is-current');
            item.setAttribute('data-idx', String(idx));
            item.setAttribute('data-pos', String(pos));
            item.draggable = true;

            // Drag handle
            var drag = document.createElement('div');
            drag.className = 'rl-drag';
            drag.textContent = '\u2630';
            item.appendChild(drag);

            // Position badge
            var badge = document.createElement('div');
            badge.className = 'rl-track-pos';
            badge.textContent = String(pos + 1);
            item.appendChild(badge);

            // Art
            var art = document.createElement('div');
            art.className = 'rl-track-art';
            if (track.artURL) {
                var img = document.createElement('img');
                img.src = track.artURL;
                img.alt = '';
                art.appendChild(img);
            } else {
                art.textContent = '\u266B';
            }
            item.appendChild(art);

            // Body
            var body = document.createElement('div');
            body.className = 'rl-track-body';

            var title = document.createElement('div');
            title.className = 'rl-track-title';
            title.textContent = trackTitle(track);
            body.appendChild(title);

            var artist = trackArtist(track);
            if (artist) {
                var sub = document.createElement('div');
                sub.className = 'rl-track-artist';
                sub.textContent = artist;
                body.appendChild(sub);
            }

            item.appendChild(body);

            // Actions
            var actions = document.createElement('div');
            actions.className = 'rl-track-actions';

            var playBtn = document.createElement('button');
            playBtn.type = 'button';
            playBtn.className = 'rl-action rl-action-play';
            playBtn.setAttribute('data-action', 'play-pl');
            playBtn.setAttribute('data-idx', String(idx));
            playBtn.textContent = currentTrackIndex() === idx ? '\u25A0' : '\u25B6';
            playBtn.title = 'Play now';
            actions.appendChild(playBtn);

            var removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'rl-action rl-action-remove';
            removeBtn.setAttribute('data-action', 'remove');
            removeBtn.setAttribute('data-pos', String(pos));
            removeBtn.textContent = '\u2715';
            removeBtn.title = 'Remove from playlist';
            actions.appendChild(removeBtn);

            item.appendChild(actions);
            frag.appendChild(item);
        });

        // Delete playlist button at bottom
        var deleteRow = document.createElement('div');
        deleteRow.className = 'rl-delete-row';
        var deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'rl-btn rl-btn-danger';
        deleteBtn.setAttribute('data-action', 'delete-playlist');
        deleteBtn.textContent = 'Delete Playlist';
        deleteRow.appendChild(deleteBtn);
        frag.appendChild(deleteRow);

        elMainList.appendChild(frag);
    }

    function highlightCurrent(idx) {
        if (!elMainList) return;
        var items = elMainList.querySelectorAll('.rl-track[data-idx]');
        for (var i = 0; i < items.length; i++) {
            var ii = parseInt(items[i].getAttribute('data-idx'), 10);
            items[i].classList.toggle('is-current', ii === idx);
            var playBtn = items[i].querySelector('.rl-action-play');
            if (playBtn) playBtn.textContent = ii === idx ? '\u25A0' : '\u25B6';
        }
    }

    // =========================================================
    //  Event delegation for the single list
    // =========================================================
    function onMainListClick(e) {
        var actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;

        var action = actionEl.getAttribute('data-action');
        var idx = parseInt(actionEl.getAttribute('data-idx'), 10);
        var pos = parseInt(actionEl.getAttribute('data-pos'), 10);

        switch (action) {
        case 'play':
            if (!isNaN(idx) && playlist[idx]) {
                playTrackByIndex(idx, true, getLibraryFilteredTrackIndices());
                if (!document.body.classList.contains('viz-open')) {
                    closeLibraryPanel();
                    try { document.dispatchEvent(new Event('viz:open')); } catch (_) {}
                } else {
                    renderPanel();
                }
            }
            return;
        case 'add':
            if (!isNaN(idx) && playlist[idx]) {
                addTrackToSelectedPlaylist(playlist[idx].name);
            }
            return;
        case 'unadd':
            if (!isNaN(idx) && playlist[idx]) {
                removeTrackByNameFromSelectedPlaylist(playlist[idx].name);
            }
            return;
        
        case 'play-pl':
            if (!isNaN(idx) && playlist[idx]) {
                playTrackByIndex(idx, true, getSelectedPlaylistFilteredIndices());
                if (!document.body.classList.contains('viz-open')) {
                    closeLibraryPanel();
                    try { document.dispatchEvent(new Event('viz:open')); } catch (_) {}
                } else {
                    renderPanel();
                }
            }
            return;
        case 'remove':
            if (!isNaN(pos)) removeTrackFromSelectedPlaylist(pos);
            return;
        case 'delete-playlist':
            deleteSelectedPlaylist();
            return;
        }
    }

    // =========================================================
    //  Drag/drop for playlist reorder
    // =========================================================
    function clearPlaylistDropTargets(includeDragging) {
        if (!elMainList) return;
        Array.prototype.forEach.call(elMainList.querySelectorAll('.is-drop-target' + (includeDragging ? ', .is-dragging' : '')), function (node) {
            node.classList.remove('is-drop-target');
            if (includeDragging) node.classList.remove('is-dragging');
        });
    }

    function onPlaylistDragStart(e) {
        var row = e.target.closest('.rl-track-pl');
        if (!row) return;
        playlistDragPos = parseInt(row.getAttribute('data-pos'), 10);
        row.classList.add('is-dragging');
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', String(playlistDragPos)); } catch (_) {}
            // Safari generates a drag ghost from the full element + surroundings,
            // which picks up panel backdrop artifacts.  Give it a clean clone instead.
            try {
                var ghost = row.cloneNode(true);
                ghost.style.cssText = 'position:absolute;top:-9999px;left:-9999px;'
                    + 'width:' + row.offsetWidth + 'px;background:rgba(10,15,34,0.95);'
                    + 'border:1px solid rgba(85,255,255,0.4);border-radius:7px;'
                    + 'pointer-events:none;';
                document.body.appendChild(ghost);
                e.dataTransfer.setDragImage(ghost, 20, row.offsetHeight / 2);
                setTimeout(function () { document.body.removeChild(ghost); }, 0);
            } catch (_) {}
        }
    }

    function onPlaylistDragOver(e) {
        var row = e.target.closest('.rl-track-pl');
        if (!row) return;
        e.preventDefault();
        clearPlaylistDropTargets(false);
        row.classList.add('is-drop-target');
    }

    function onPlaylistDragLeave(e) {
        var row = e.target.closest('.rl-track-pl');
        if (!row) return;
        if (row.contains(e.relatedTarget)) return;
        row.classList.remove('is-drop-target');
    }

    function onPlaylistDrop(e) {
        var row = e.target.closest('.rl-track-pl');
        if (!row) return;
        e.preventDefault();
        var targetPos = parseInt(row.getAttribute('data-pos'), 10);
        clearPlaylistDropTargets(true);
        if (!isNaN(playlistDragPos) && !isNaN(targetPos)) {
            moveTrackInSelectedPlaylist(playlistDragPos, targetPos);
        }
        playlistDragPos = -1;
    }

    function onPlaylistDragEnd() {
        playlistDragPos = -1;
        clearPlaylistDropTargets(true);
    }

    // =========================================================
    //  Panel drag-to-move (desktop only)
    // =========================================================
    var _panelDrag = { active: false, startX: 0, startY: 0, panelX: 0, panelY: 0 };
    var _panelResize = { active: false, startX: 0, startY: 0, panelW: 0, panelH: 0, panelLeft: 0, panelTop: 0 };

    function initPanelDrag() {
        var handle = elPanel ? elPanel.querySelector('.rl-head-left') : null;
        if (!handle) return;
        handle.addEventListener('mousedown', onPanelDragStart);
    }

    function onPanelDragStart(e) {
        // Only primary button, skip on narrow screens
        if (e.button !== 0 || !isDesktopPanelLayout()) return;
        var panel = elPanel;
        if (!panel || !panel.classList.contains('show')) return;

        e.preventDefault();
        normalizePanelPosition();
        _panelDrag.active = true;

        var rect = panel.getBoundingClientRect();
        _panelDrag.panelX = rect.left;
        _panelDrag.panelY = rect.top;
        _panelDrag.startX = e.clientX;
        _panelDrag.startY = e.clientY;

        panel.classList.add('is-dragging-panel');
        document.addEventListener('mousemove', onPanelDragMove);
        document.addEventListener('mouseup', onPanelDragEnd);
    }

    function onPanelDragMove(e) {
        if (!_panelDrag.active) return;
        var dx = e.clientX - _panelDrag.startX;
        var dy = e.clientY - _panelDrag.startY;
        var rect = elPanel.getBoundingClientRect();
        var margin = 12;
        var nx = clamp(_panelDrag.panelX + dx, margin, Math.max(margin, window.innerWidth - rect.width - margin));
        var ny = clamp(_panelDrag.panelY + dy, margin, Math.max(margin, window.innerHeight - rect.height - margin));
        elPanel.style.left = nx + 'px';
        elPanel.style.top = ny + 'px';
        elPanel.style.transform = 'none';
    }

    function onPanelDragEnd() {
        if (!_panelDrag.active) return;
        _panelDrag.active = false;
        elPanel.classList.remove('is-dragging-panel');
        document.removeEventListener('mousemove', onPanelDragMove);
        document.removeEventListener('mouseup', onPanelDragEnd);
        savePanelPlacement();
    }

    function initPanelResize() {
        if (!elPanelResizeHandle) return;
        elPanelResizeHandle.addEventListener('mousedown', onPanelResizeStart);
    }

    function onPanelResizeStart(e) {
        if (e.button !== 0 || !isDesktopPanelLayout()) return;
        var panel = elPanel;
        if (!panel || !panel.classList.contains('show')) return;

        e.preventDefault();
        e.stopPropagation();
        normalizePanelPosition();

        var rect = panel.getBoundingClientRect();
        _panelResize.active = true;
        _panelResize.startX = e.clientX;
        _panelResize.startY = e.clientY;
        _panelResize.panelW = rect.width;
        _panelResize.panelH = rect.height;
        _panelResize.panelLeft = rect.left;
        _panelResize.panelTop = rect.top;

        panel.classList.add('is-resizing-panel');
        document.addEventListener('mousemove', onPanelResizeMove);
        document.addEventListener('mouseup', onPanelResizeEnd);
    }

    function onPanelResizeMove(e) {
        if (!_panelResize.active || !elPanel) return;

        var bounds = getPanelSizeBounds();
        var dx = e.clientX - _panelResize.startX;
        var dy = e.clientY - _panelResize.startY;
        var maxWidthByPosition = Math.max(bounds.minWidth, window.innerWidth - _panelResize.panelLeft - 12);
        var maxHeightByPosition = Math.max(bounds.minHeight, window.innerHeight - _panelResize.panelTop - 12);

        panelFrame.width = Math.round(clamp(
            _panelResize.panelW + dx,
            bounds.minWidth,
            Math.min(bounds.maxWidth, maxWidthByPosition)
        ));
        panelFrame.height = Math.round(clamp(
            _panelResize.panelH + dy,
            bounds.minHeight,
            Math.min(bounds.maxHeight, maxHeightByPosition)
        ));

        applyPanelDimensions();
    }

    function onPanelResizeEnd() {
        if (!_panelResize.active) return;
        _panelResize.active = false;
        if (elPanel) elPanel.classList.remove('is-resizing-panel');
        document.removeEventListener('mousemove', onPanelResizeMove);
        document.removeEventListener('mouseup', onPanelResizeEnd);
        savePanelPlacement();
        persistLibraryPrefs();
    }

    // =========================================================
    //  Visualizer (frequency bars on <canvas>)
    // =========================================================
    function startViz() {
        if (vizRAF) return;
        drawViz();
    }

    function stopViz() {
        if (vizRAF) { cancelAnimationFrame(vizRAF); vizRAF = null; }
        if (vizCtx) vizCtx.clearRect(0, 0, vizW, vizH);
    }

    var karaokeFrame = 0;
    var vizCycleTime = 0;
    var vizShowA = true;
    var VIZ_DUR_A = 20000;
    var VIZ_DUR_B = 15000;
    var KARAOKE_COLORS = ['#5555FF', '#55FF55', '#FFFF55'];
    var _firstPlayFired = false;

    var vizLastHiddenDraw = 0;

    function drawViz() {
        vizRAF = requestAnimationFrame(drawViz);
        var now;
        if (document.hidden) {
            now = performance.now();
            if (now - vizLastHiddenDraw < 500) return;
            vizLastHiddenDraw = now;
        }
        now = performance.now();

        if (!isPlaying || !analyser) {
            drawMiniHead();
            drawMiniEQ();
            return;
        }

        drawEqualizer();
        drawMiniEQ();
    }

    function drawEqualizer() {
        var bins = analyser.frequencyBinCount;
        var data = new Uint8Array(bins);
        analyser.getByteFrequencyData(data);

        vizCtx.clearRect(0, 0, vizW, vizH);

        for (var i = 0; i < bins; i++) {
            var v    = data[i] / 255;
            var barH = v * vizH;
            var x    = Math.round(i * vizW / bins);
            var w    = Math.round((i + 1) * vizW / bins) - x;

            var r, g, b;
            if (v < 0.33)      { r = 0;   g = (85 + v * 3 * 170) | 0; b = 255; }
            else if (v < 0.66) { r = ((v - 0.33) * 3 * 170) | 0; g = (255 - (v - 0.33) * 3 * 100) | 0; b = 255; }
            else               { r = 170 + ((v - 0.66) * 3 * 85) | 0; g = (155 + (v - 0.66) * 3 * 100) | 0; b = 255; }

            vizCtx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
            vizCtx.fillRect(x, vizH - barH, w, barH);
        }

        drawMiniHead(true);
    }

    function drawMiniEQ() {
        var miniCanvas = document.getElementById('mobile-mini-eq');
        if (!miniCanvas || miniCanvas.style.display === 'none') return;
        var ctx = miniCanvas.getContext('2d');
        if (!ctx || !analyser) return;

        var bins = analyser.frequencyBinCount;
        var data = new Uint8Array(bins);
        analyser.getByteFrequencyData(data);

        var w = miniCanvas.width, h = miniCanvas.height;
        ctx.clearRect(0, 0, w, h);

        var barCount = 4;
        var barW = (w - 4) / barCount;
        for (var i = 0; i < barCount; i++) {
            var idx = Math.floor((i / barCount) * bins);
            var v = data[idx] / 255;
            var barH = v * (h - 2);
            ctx.fillStyle = '#55FFFF';
            ctx.fillRect(1 + i * barW, h - 1 - barH, barW - 1, barH);
        }
    }

    function drawKaraokeSign() {
        karaokeFrame++;
        vizCtx.fillStyle = '#000022';
        vizCtx.fillRect(0, 0, vizW, vizH);

        var cx = vizW / 2;
        var cy = vizH / 2;

        var numDots = 28;
        var rx = vizW * 0.48;
        var ry = vizH * 0.42;
        var dotSize = 1.2;

        for (var i = 0; i < numDots; i++) {
            var angle = (i / numDots) * Math.PI * 2;
            var x = cx + Math.cos(angle) * rx;
            var y = cy + Math.sin(angle) * ry;
            var colorIdx = Math.floor((i + karaokeFrame * 0.12) / 4) % KARAOKE_COLORS.length;
            vizCtx.fillStyle = KARAOKE_COLORS[colorIdx];
            vizCtx.shadowColor = KARAOKE_COLORS[colorIdx];
            vizCtx.shadowBlur = 2;
            vizCtx.beginPath();
            vizCtx.arc(x, y, dotSize, 0, Math.PI * 2);
            vizCtx.fill();
        }
        vizCtx.shadowBlur = 0;

        vizCtx.font = 'bold 9px sans-serif';
        vizCtx.textAlign = 'center';
        vizCtx.textBaseline = 'middle';
        vizCtx.fillStyle = '#FF5555';
        vizCtx.shadowColor = '#FF5555';
        vizCtx.shadowBlur = 3;
        vizCtx.fillText('\u266B', cx, cy);
        vizCtx.shadowBlur = 0;
    }

    // =========================================================
    //  Tab visibility recovery
    // =========================================================
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && audioCtx && isPlaying) {
            console.log('[radio] tab visible, ensuring audio context is active');
            if (audioCtx.state === 'suspended') {
                audioCtx.resume().then(function () {
                    console.log('[radio] resumed after visibility change');
                    if (!_bufferSource && _decodedBuffer) {
                        _pendingPlay = true;
                        _startBufferPlayback();
                    }
                }).catch(function () {});
            } else if (audioCtx.state === 'running' && !_bufferSource && _decodedBuffer) {
                console.log('[radio] source lost while hidden, restarting');
                _pendingPlay = true;
                _startBufferPlayback();
            }
        }
    });

    // =========================================================
    //  Boot
    // =========================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
