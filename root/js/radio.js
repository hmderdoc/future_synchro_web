/* radio.js - BBS Radio Station persistent MP3 player
 *
 * Lives in the navbar shell, persists across SPA navigation.
 * Uses Web Audio API DynamicsCompressorNode as a broadcast-style
 * brick-wall limiter so "hot" tracks don't blast eardrums.
 */
(function () {
    'use strict';

    // --- Configuration ---
    var DIR_CODE = 'originalcontent_mp3s';
    var API_URL  = './api/files.ssjs?call=list-files&dir=' + DIR_CODE;
    var FILE_URL = './radio-stream/';

    // Broadcast limiter: brick-wall at -6 dBFS
    var LIM_THRESHOLD = -6;
    var LIM_KNEE      = 0;
    var LIM_RATIO     = 20;
    var LIM_ATTACK    = 0.003;
    var LIM_RELEASE   = 0.25;

    // --- State ---
    var playlist  = [];   // [{name, desc, added}, ...]
    var queue     = [];   // shuffled indices into playlist
    var queuePos  = -1;
    var isPlaying = false;
    var audioCtx  = null;
    var compressor = null;
    var analyser  = null;
    var source    = null;
    var audio     = null; // <audio> element
    var gainNode  = null; // volume control
    var vizRAF    = null;

    // --- DOM refs (set in init) ---
    var elPlay, elPrev, elNext, elTrack, elViz, elListBtn, elVolume;
    var elPanel, elSearch, elTracklist, elContainer;
    var vizW, vizH, vizCtx;

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
        elListBtn   = document.getElementById('radio-list-btn');
        elPanel     = document.getElementById('radio-playlist-panel');
        elSearch    = document.getElementById('radio-search');
        elTracklist = document.getElementById('radio-tracklist');
        elVolume    = document.getElementById('radio-volume');

        if (!elPlay) return; // radio HTML not present

        // Hidden <audio> element — NO crossOrigin (same-origin, avoid CORS issues)
        audio = document.createElement('audio');
        audio.preload = 'auto';
        document.body.appendChild(audio);

        // --- Events ---
        elPlay.addEventListener('click', togglePlay);
        elPrev.addEventListener('click', prevTrack);
        elNext.addEventListener('click', nextTrack);

        audio.addEventListener('ended', function () {
            console.log('[radio] track ended, advancing');
            nextTrack();
        });

        audio.addEventListener('error', function () {
            var e = audio.error;
            console.warn('[radio] audio error:', e ? e.code + ' ' + e.message : 'unknown');
            setTimeout(nextTrack, 1200);
        });

        audio.addEventListener('playing', function () {
            console.log('[radio] playing:', audio.src);
            isPlaying = true;
            elPlay.textContent = '\u275A\u275A'; // ❚❚ (pause icon)
            startViz();
        });

        audio.addEventListener('pause', function () {
            if (!audio.ended) {
                isPlaying = false;
                elPlay.textContent = '\u25B6'; // ▶
                stopViz();
            }
        });

        // Volume slider
        if (elVolume) {
            elVolume.addEventListener('input', function () {
                var vol = parseFloat(elVolume.value);
                if (gainNode) gainNode.gain.value = vol;
                audio.volume = vol; // fallback if audio context not yet created
            });
        }

        // Playlist panel toggle
        elListBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            elPanel.classList.toggle('show');
            if (elPanel.classList.contains('show')) {
                elSearch.focus();
            }
        });
        document.addEventListener('click', function (e) {
            if (elPanel && !elPanel.contains(e.target) && e.target !== elListBtn) {
                elPanel.classList.remove('show');
            }
        });

        // Search / filter
        elSearch.addEventListener('input', function () {
            renderTrackList(elSearch.value.trim().toLowerCase());
        });

        // Visualizer canvas
        vizW   = elViz.width;
        vizH   = elViz.height;
        vizCtx = elViz.getContext('2d');

        // Fetch playlist from server
        fetchPlaylist();
    }

    // =========================================================
    //  Audio context + compressor (lazy, on first user gesture)
    // =========================================================
    function ensureAudioCtx() {
        if (audioCtx) {
            if (audioCtx.state === 'suspended') audioCtx.resume();
            return;
        }

        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            compressor = audioCtx.createDynamicsCompressor();
            compressor.threshold.setValueAtTime(LIM_THRESHOLD, audioCtx.currentTime);
            compressor.knee.setValueAtTime(LIM_KNEE, audioCtx.currentTime);
            compressor.ratio.setValueAtTime(LIM_RATIO, audioCtx.currentTime);
            compressor.attack.setValueAtTime(LIM_ATTACK, audioCtx.currentTime);
            compressor.release.setValueAtTime(LIM_RELEASE, audioCtx.currentTime);

            analyser        = audioCtx.createAnalyser();
            analyser.fftSize = 64; // 32 frequency bins — compact

            gainNode = audioCtx.createGain();
            gainNode.gain.value = elVolume ? parseFloat(elVolume.value) : 0.8;

            // source → compressor → gain → analyser → speakers
            source = audioCtx.createMediaElementSource(audio);
            source.connect(compressor);
            compressor.connect(gainNode);
            gainNode.connect(analyser);
            analyser.connect(audioCtx.destination);

            console.log('[radio] AudioContext created, state:', audioCtx.state);
        } catch (e) {
            console.error('[radio] AudioContext failed:', e);
            // Fallback: audio plays without compressor
            audioCtx = null;
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
                    elTrack.textContent = 'Radio offline';
                    return;
                }
                if (!Array.isArray(data) || data.length === 0) {
                    elTrack.textContent = 'No tracks';
                    return;
                }
                playlist = data;
                shuffleQueue();
                renderTrackList('');
                elTrack.textContent = '\u266B ' + playlist.length + ' tracks';
                console.log('[radio] playlist loaded:', playlist.length, 'tracks');
            })
            .catch(function (err) {
                console.error('[radio] fetch error:', err);
                elTrack.textContent = 'Radio offline';
            });
    }

    // =========================================================
    //  Queue management (Fisher-Yates shuffle)
    // =========================================================
    function shuffleQueue() {
        queue = [];
        for (var i = 0; i < playlist.length; i++) queue.push(i);
        for (var j = queue.length - 1; j > 0; j--) {
            var k = Math.floor(Math.random() * (j + 1));
            var t = queue[j]; queue[j] = queue[k]; queue[k] = t;
        }
        queuePos = -1;
    }

    // =========================================================
    //  Transport controls
    // =========================================================
    function togglePlay() {
        if (playlist.length === 0) return;
        ensureAudioCtx();

        if (isPlaying) {
            audio.pause();
            // 'pause' event handler updates UI
        } else {
            if (queuePos < 0) {
                queuePos = 0;
                loadTrack(queue[0]);
            }
            var p = audio.play();
            if (p && typeof p.catch === 'function') {
                p.catch(function (e) {
                    console.warn('[radio] play() rejected:', e.name, e.message);
                });
            }
            // 'playing' event handler updates UI
        }
    }

    function nextTrack() {
        if (playlist.length === 0) return;
        queuePos++;
        if (queuePos >= queue.length) { shuffleQueue(); queuePos = 0; }
        loadTrack(queue[queuePos]);
        if (isPlaying || audio.ended) { doPlay(); }
    }

    function prevTrack() {
        if (playlist.length === 0) return;
        if (audio.currentTime > 3) { audio.currentTime = 0; return; }
        queuePos--;
        if (queuePos < 0) queuePos = queue.length - 1;
        loadTrack(queue[queuePos]);
        if (isPlaying) { doPlay(); }
    }

    function doPlay() {
        ensureAudioCtx();
        var p = audio.play();
        if (p && typeof p.catch === 'function') {
            p.catch(function (e) {
                console.warn('[radio] play() rejected:', e.name, e.message);
            });
        }
    }

    function loadTrack(idx) {
        var t = playlist[idx];
        if (!t) return;
        var url = FILE_URL + encodeURIComponent(t.name);
        console.log('[radio] loading track:', t.name, url);
        audio.src = url;
        var display = t.desc || t.name.replace(/\.mp3$/i, '');
        elTrack.textContent = display;
        elTrack.title       = display;
        highlightCurrent(idx);
    }

    // =========================================================
    //  Playlist panel rendering
    // =========================================================
    function renderTrackList(filter) {
        var html = '';
        for (var i = 0; i < playlist.length; i++) {
            var t    = playlist[i];
            var name = t.desc || t.name.replace(/\.mp3$/i, '');
            if (filter && name.toLowerCase().indexOf(filter) < 0
                       && t.name.toLowerCase().indexOf(filter) < 0) continue;
            var cls = (queue[queuePos] === i) ? ' active' : '';
            html += '<div class="radio-track-item' + cls + '" data-idx="' + i + '">'
                  + esc(name) + '</div>';
        }
        elTracklist.innerHTML = html || '<div class="radio-track-empty">No tracks found</div>';

        // Click handlers
        var items = elTracklist.querySelectorAll('.radio-track-item');
        for (var j = 0; j < items.length; j++) {
            items[j].addEventListener('click', onTrackClick);
        }
    }

    function onTrackClick(e) {
        var idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        queuePos++;
        queue.splice(queuePos, 0, idx);
        loadTrack(idx);
        ensureAudioCtx();
        doPlay();
        elPanel.classList.remove('show');
    }

    function highlightCurrent(idx) {
        var items = elTracklist.querySelectorAll('.radio-track-item');
        for (var i = 0; i < items.length; i++) {
            var ii = parseInt(items[i].getAttribute('data-idx'), 10);
            items[i].classList.toggle('active', ii === idx);
        }
    }

    function esc(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
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

    function drawViz() {
        vizRAF = requestAnimationFrame(drawViz);
        if (!analyser) return;

        var bins = analyser.frequencyBinCount;
        var data = new Uint8Array(bins);
        analyser.getByteFrequencyData(data);

        vizCtx.clearRect(0, 0, vizW, vizH);

        var barW = vizW / bins;
        for (var i = 0; i < bins; i++) {
            var v    = data[i] / 255;
            var barH = v * vizH;

            // CGA palette feel: green → cyan → white
            var r, g, b;
            if (v < 0.33)      { r = 0;   g = 170 + (v * 3 * 85) | 0; b = 0; }
            else if (v < 0.66) { r = 0;   g = 255; b = ((v - 0.33) * 3 * 255) | 0; }
            else               { r = ((v - 0.66) * 3 * 255) | 0; g = 255; b = 255; }

            vizCtx.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
            vizCtx.fillRect(i * barW, vizH - barH, Math.max(barW - 1, 1), barH);
        }
    }

    // =========================================================
    //  Boot
    // =========================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
