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
    var elPlay, elPrev, elNext, elTrack, elViz, elVolume;
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
            document.dispatchEvent(new CustomEvent('radio:statechange', { detail: { playing: true } }));
            elPlay.textContent = '\u275A\u275A'; // ❚❚ (pause icon)
            startViz();

            // Auto-open visualizer on the very first play of this session
            if (!_firstPlayFired) {
                _firstPlayFired = true;
                if (!sessionStorage.getItem('radioPlayed')) {
                    sessionStorage.setItem('radioPlayed', '1');
                    if (window.sbbsVisualizer && window.sbbsVisualizer.show) {
                        setTimeout(function () { window.sbbsVisualizer.show(); }, 300);
                    }
                }
            }
        });

        audio.addEventListener('pause', function () {
            if (!audio.ended) {
                isPlaying = false;
                document.dispatchEvent(new CustomEvent('radio:statechange', { detail: { playing: false } }));
                elPlay.textContent = '\u25B6'; // ▶
                // stopViz(); -- keep running for karaoke sign
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

        // Playlist panel toggle (click the song name to open)
        elTrack.addEventListener('click', function (e) {
            e.stopPropagation();
            elPanel.classList.toggle('show');
            if (elPanel.classList.contains('show')) {
                refreshPlaylist();   // fetch latest songs on open
                elSearch.focus();
            }
        });
        document.addEventListener('click', function (e) {
            if (elPanel && !elPanel.contains(e.target) && e.target !== elTrack) {
                // Also exempt clicks inside the viz-panel (transport controls)
                var vizPanel = document.getElementById('viz-panel');
                if (vizPanel && vizPanel.contains(e.target)) return;
                elPanel.classList.remove('show');
            }
        });

        // When visualizer picks a track by filename
        document.addEventListener('viz:picktrack', function (e) {
            var name = e.detail && e.detail.name;
            if (!name) return;
            for (var i = 0; i < playlist.length; i++) {
                if (playlist[i].name === name) {
                    queuePos++;
                    queue.splice(queuePos, 0, i);
                    loadTrack(i);
                    ensureAudioCtx();
                    doPlay();
                    return;
                }
            }
            // Not in playlist yet — add it
            playlist.push({ name: name });
            var idx = playlist.length - 1;
            queue.push(idx);
            queuePos = queue.length - 1;
            loadTrack(idx);
            ensureAudioCtx();
            doPlay();
        });

        // When visualizer opens the playlist panel, refresh data
        document.addEventListener('viz:playlistopen', function () {
            refreshPlaylist();
            renderTrackList(elSearch ? elSearch.value.trim().toLowerCase() : '');
        });

        // Search / filter
        elSearch.addEventListener('input', function () {
            renderTrackList(elSearch.value.trim().toLowerCase());
        });

        // Visualizer canvas
        vizW   = elViz.width;
        vizH   = elViz.height;
        vizCtx = elViz.getContext('2d');
        startViz(); // Start animation immediately for karaoke sign

        // Expose internals for visualizer
        window.sbbsRadio = {
            get audioCtx()        { return audioCtx; },
            get analyserNode()    { return analyser; },
            get gainNode()        { return gainNode; },
            get audioEl()         { return audio; },
            get currentTrackFile(){ return playlist[queue[queuePos]] ? playlist[queue[queuePos]].name : ''  ; },
            get isPlaying()       { return isPlaying; },
            get dirCode()         { return DIR_CODE; }
        };

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
    //  Refresh playlist (on-demand when panel opens)
    //  Merges new songs into the existing playlist without
    //  disrupting the current queue or playback.
    // =========================================================
    function refreshPlaylist() {
        fetch(API_URL)
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (!Array.isArray(data) || data.length === 0) return;

                // Build a set of filenames we already know about
                var known = {};
                for (var i = 0; i < playlist.length; i++) {
                    known[playlist[i].name] = true;
                }

                // Find genuinely new tracks
                var added = 0;
                for (var j = 0; j < data.length; j++) {
                    if (!known[data[j].name]) {
                        playlist.push(data[j]);
                        queue.push(playlist.length - 1);  // append to end of shuffle queue
                        added++;
                    }
                }

                if (added > 0) {
                    console.log('[radio] refreshed: ' + added + ' new track(s), '
                                + playlist.length + ' total');
                    renderTrackList(elSearch.value.trim().toLowerCase());
                    // Update the idle track counter if nothing is playing
                    if (!isPlaying && queuePos < 0) {
                        elTrack.textContent = '\u266B ' + playlist.length + ' tracks';
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
        // Notify visualizer of track change
        try {
            document.dispatchEvent(new CustomEvent('radio:trackchange', {
                detail: { filename: t.name, display: display }
            }));
        } catch(e) {}
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

    function drawMiniHead() {
        if (!vizCtx) return;
        var W = vizW, H = vizH;
        vizCtx.clearRect(0, 0, W, H);

        // Dark background
        vizCtx.fillStyle = '#000a00';
        vizCtx.fillRect(0, 0, W, H);

        var cx = W / 2, cy = H * 0.45;
        var S = Math.min(W, H) * 0.32;
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

        // Generate rings
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

        // Horizontal rings
        for (var r = 0; r < rings.length; r++) {
            vizCtx.beginPath();
            for (var i = 0; i < rings[r].length; i++) {
                var pt = rings[r][i];
                i === 0 ? vizCtx.moveTo(pt.x, pt.y) : vizCtx.lineTo(pt.x, pt.y);
            }
            vizCtx.closePath();
            vizCtx.stroke();
        }

        // Vertical ribs (every other segment)
        vizCtx.strokeStyle = 'rgba(' + _MINI_GREEN + ',0.25)';
        vizCtx.lineWidth = 0.5;
        for (var s = 0; s < _MINI_RING_N; s += 2) {
            vizCtx.beginPath();
            for (var r2 = 0; r2 < rings.length; r2++) {
                var pt2 = rings[r2][s];
                r2 === 0 ? vizCtx.moveTo(pt2.x, pt2.y) : vizCtx.lineTo(pt2.x, pt2.y);
            }
            vizCtx.stroke();
        }

        // Eyes - two small glowing dots
        vizCtx.shadowBlur = 6;
        vizCtx.shadowColor = 'rgb(' + _MINI_GREEN + ')';
        vizCtx.fillStyle = 'rgba(' + _MINI_GREEN + ',0.8)';
        var lEye = proj(-0.18, -0.05, 0.45);
        var rEye = proj(0.18, -0.05, 0.45);
        vizCtx.beginPath(); vizCtx.arc(lEye.x, lEye.y, 1.5, 0, Math.PI * 2); vizCtx.fill();
        vizCtx.beginPath(); vizCtx.arc(rEye.x, rEye.y, 1.5, 0, Math.PI * 2); vizCtx.fill();

        vizCtx.shadowBlur = 0;
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

    // LED Karaoke sign state
    var karaokeFrame = 0;
    var vizCycleTime = 0;        // ms timestamp for cycling
    var vizMode = 0;             // 0=EQ, 1=karaoke, 2=wireframe head
    var VIZ_DURATIONS = [5000, 3000, 4000]; // ms per mode
    var KARAOKE_COLORS = ['#5555FF', '#55FF55', '#FFFF55']; // blue, green, yellow
    var _firstPlayFired = false;  // track first play for auto-open viz

    var vizLastHiddenDraw = 0; // Throttle when tab hidden

    function drawViz() {
        vizRAF = requestAnimationFrame(drawViz);
        var now;

        // Throttle to 2fps when tab is hidden (save CPU)
        if (document.hidden) {
            now = performance.now();
            if (now - vizLastHiddenDraw < 500) return;
            vizLastHiddenDraw = now;
        }
        now = performance.now();

        // If not playing, always show karaoke sign
        if (!isPlaying || !analyser) {
            drawKaraokeSign();
            drawMiniEQ();
            vizCycleTime = now; // reset cycle
            vizMode = 0;        // start with EQ when music resumes
            return;
        }

        // Cycle through modes: EQ -> karaoke -> wireframe head
        var elapsed = now - vizCycleTime;
        if (elapsed > VIZ_DURATIONS[vizMode]) {
            vizMode = (vizMode + 1) % 3;
            vizCycleTime = now;
        }

        if (vizMode === 0) {
            drawEqualizer();
        } else if (vizMode === 1) {
            drawKaraokeSign();
        } else {
            drawMiniHead(now);
        }

        // Also update mobile mini-EQ if visible
        drawMiniEQ();
    }

    function drawEqualizer() {
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

    // Draw mini-EQ on mobile navbar icon
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

        // Draw 4 bars
        var barCount = 4;
        var barW = (w - 4) / barCount;
        for (var i = 0; i < barCount; i++) {
            var idx = Math.floor((i / barCount) * bins);
            var v = data[idx] / 255;
            var barH = v * (h - 2);
            ctx.fillStyle = '#55FF55';
            ctx.fillRect(1 + i * barW, h - 1 - barH, barW - 1, barH);
        }
    }

    function drawKaraokeSign() {
        karaokeFrame++;
        vizCtx.fillStyle = '#000022';
        vizCtx.fillRect(0, 0, vizW, vizH);

        var cx = vizW / 2;
        var cy = vizH / 2;

        // Draw animated border dots in an oval - sized to fill canvas like EQ
        var numDots = 28;
        var rx = vizW * 0.48;  // nearly full width
        var ry = vizH * 0.42;  // nearly full height
        var dotSize = 1.2;

        for (var i = 0; i < numDots; i++) {
            var angle = (i / numDots) * Math.PI * 2;
            var x = cx + Math.cos(angle) * rx;
            var y = cy + Math.sin(angle) * ry;

            // Cycling color based on position + animation
            var colorIdx = Math.floor((i + karaokeFrame * 0.12) / 4) % KARAOKE_COLORS.length;
            vizCtx.fillStyle = KARAOKE_COLORS[colorIdx];

            // Glow effect
            vizCtx.shadowColor = KARAOKE_COLORS[colorIdx];
            vizCtx.shadowBlur = 2;
            vizCtx.beginPath();
            vizCtx.arc(x, y, dotSize, 0, Math.PI * 2);
            vizCtx.fill();
        }
        vizCtx.shadowBlur = 0;

        // Draw "♫" music note in center - red LED style
        vizCtx.font = 'bold 9px sans-serif';
        vizCtx.textAlign = 'center';
        vizCtx.textBaseline = 'middle';
        vizCtx.fillStyle = '#FF5555';
        vizCtx.shadowColor = '#FF5555';
        vizCtx.shadowBlur = 3;
        vizCtx.fillText('♫', cx, cy);
        vizCtx.shadowBlur = 0;
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
