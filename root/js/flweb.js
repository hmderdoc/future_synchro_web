(function () {
    'use strict';

    /* Sound is handled by the APC audio path in the terminal iframe
       (js/ansi-music.js), not here. The flweb audio verbs - audio.play,
       audio.stop, audio.zzt.note, audio.zzt.drum, audio.zzt.stop - and
       their Web Audio machinery were removed deliberately; flweb is no
       longer a sound protocol. Doors still emitting those verbs are
       no-ops: the payloads are still stripped from the display stream,
       they just don't play anything. */

    var MAX_TOASTS = 4;
    var TOAST_DURATION = 5000;

    function clampNumber(value, min, max, fallback) {
        var num = parseFloat(value);
        if (isNaN(num)) return fallback;
        if (num < min) return min;
        if (num > max) return max;
        return num;
    }

    function normalizeActionName(mode) {
        switch (String(mode || '').toLowerCase()) {
            case 'keyboard': return 'showKeyboard';
            case 'fn': return 'showFn';
            case 'dpad': return 'showDpad';
            case 'dismiss':
            case 'off':
            case 'hidden':
                return 'dismiss';
            default:
                return '';
        }
    }

    function buildAssetUrl(asset) {
        var params;

        if (!asset) return '';
        if (typeof asset === 'string') return asset;
        if (typeof asset.url === 'string' && asset.url) return asset.url;
        if (!asset.scope || !asset.path) return '';

        params = new URLSearchParams();
        params.set('scope', String(asset.scope));
        params.set('path', String(asset.path));
        if (asset.code) params.set('code', String(asset.code));

        return './api/flweb-assets.ssjs?' + params.toString();
    }

    function removeToast(el) {
        if (!el || !el.parentNode) return;
        el.classList.add('chat-toast-exit');
        setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
        }, 400);
    }

    function showToast(payload, ctx) {
        var container;
        var toast;
        var content;
        var title;
        var text;
        var closeBtn;
        var duration;

        payload = payload || {};
        if (payload.hiddenOnly && ctx && ctx.terminalVisible) return false;

        container = document.getElementById('chat-toasts');
        if (!container) return false;

        while (container.children.length >= MAX_TOASTS) {
            container.removeChild(container.lastChild);
        }

        toast = document.createElement('div');
        toast.className = 'chat-toast chat-toast-enter';

        content = document.createElement('div');
        content.className = 'chat-toast-content';

        title = document.createElement('div');
        title.className = 'chat-toast-sender';
        title.textContent = payload.title || 'Terminal';

        text = document.createElement('div');
        text.className = 'chat-toast-text';
        text.textContent = payload.text || payload.message || '';

        content.appendChild(title);
        content.appendChild(text);
        toast.appendChild(content);

        closeBtn = document.createElement('button');
        closeBtn.className = 'chat-toast-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            removeToast(toast);
        });
        toast.appendChild(closeBtn);

        container.insertBefore(toast, container.firstChild);

        requestAnimationFrame(function () {
            toast.classList.remove('chat-toast-enter');
        });

        duration = clampNumber(payload.duration, 1000, 60000, TOAST_DURATION);
        setTimeout(function () {
            removeToast(toast);
        }, duration);

        return true;
    }

    function openUrl(payload, ctx) {
        var url;
        var target;
        var popup;

        payload = payload || {};
        url = payload.url || payload.href || '';
        if (!url) return false;

        try {
            url = new URL(String(url), window.location.href).toString();
        } catch (_) {
            url = String(url);
        }

        target = String(payload.target || '_blank');

        if (target === '_self') {
            window.location.assign(url);
            return true;
        }

        try {
            popup = window.open(url, target, 'noopener,noreferrer');
            if (popup) {
                try { popup.opener = null; } catch (_) {}
                return true;
            }
        } catch (_) {}

        return showToast({
            title: payload.title || 'Open Link',
            text: (payload.text || 'Popup blocked. Open this URL manually:') + ' ' + url,
            duration: clampNumber(payload.duration, 3000, 60000, 9000),
            hiddenOnly: false
        }, ctx);
    }

    function say(payload) {
        var utter;
        var voices;
        var i;
        var voiceMatch;
        var candidates;
        var j;

        payload = payload || {};
        if (!window.speechSynthesis || !payload.text) return false;
        if (payload.interrupt !== false) {
            try { window.speechSynthesis.cancel(); } catch (_) {}
        }

        utter = new SpeechSynthesisUtterance(String(payload.text));
        if (payload.lang) utter.lang = String(payload.lang);
        utter.rate = clampNumber(payload.rate, 0.1, 10, 1);
        utter.pitch = clampNumber(payload.pitch, 0, 2, 1);
        utter.volume = clampNumber(payload.volume, 0, 1, 1);

        voices = window.speechSynthesis.getVoices();
        voiceMatch = null;

        candidates = [];
        if (payload.voice) {
            candidates.push(String(payload.voice));
        }
        if (payload.voiceCandidates && payload.voiceCandidates.length) {
            for (j = 0; j < payload.voiceCandidates.length; j += 1) {
                candidates.push(String(payload.voiceCandidates[j]));
            }
        }

        for (j = 0; j < candidates.length && !voiceMatch; j += 1) {
            for (i = 0; i < voices.length; i += 1) {
                if (voices[i].name.toLowerCase().indexOf(candidates[j].toLowerCase()) !== -1) {
                    voiceMatch = voices[i];
                    break;
                }
            }    
        }

        if (!voiceMatch && utter.lang) {
            for (i = 0; i < voices.length; i += 1) {
                if (String(voices[i].lang || '').toLowerCase().indexOf(String(utter.lang).toLowerCase()) === 0) {
                    voiceMatch = voices[i];
                    break;
                }
            }
        }

        if (voiceMatch) utter.voice = voiceMatch;

        window.speechSynthesis.speak(utter);
        return true;
    }

    function handleController(action, payload, ctx) {
        var modeAction;

        payload = payload || {};
        if (!ctx || typeof ctx.sendToIframe !== 'function') return false;

        if (action === 'controller.mode') {
            modeAction = normalizeActionName(payload.mode);
            if (!modeAction) return false;
            ctx.sendToIframe({ cmd: 'mobileInput', action: modeAction });
            return true;
        }

        if (action === 'controller.mapping') {
            if (!payload.mapping) return false;
            ctx.sendToIframe({
                cmd: 'mobileInput',
                action: 'setMapping',
                mapping: String(payload.mapping)
            });
            return true;
        }

        if (action === 'controller.profile') {
            if (payload.mapping) {
                ctx.sendToIframe({
                    cmd: 'mobileInput',
                    action: 'setMapping',
                    mapping: String(payload.mapping)
                });
            }
            if (payload.mode) {
                modeAction = normalizeActionName(payload.mode);
                if (modeAction) {
                    ctx.sendToIframe({ cmd: 'mobileInput', action: modeAction });
                }
            }
            return true;
        }

        return false;
    }

    function handleRadioPlay(payload) {
        var file = payload && (payload.file || payload.filename);
        if (!file) {
            console.warn('[flweb] radio.play: no file specified');
            return false;
        }
        if (!window.sbbsRadio) {
            console.warn('[flweb] radio.play: sbbsRadio not available');
            showToast({ title: 'Radio', text: 'Radio player not loaded yet. Open the radio first.' });
            return false;
        }
        if (typeof window.sbbsRadio.playByFile === 'function') {
            window.sbbsRadio.playByFile(file);
            return true;
        }
        console.warn('[flweb] radio.play: playByFile not available on sbbsRadio');
        return false;
    }

    function handleRadioStop() {
        if (window.sbbsRadio && typeof window.sbbsRadio.togglePlay === 'function' && window.sbbsRadio.isPlaying) {
            window.sbbsRadio.togglePlay();
            return true;
        }
        return false;
    }

    function handleTerminalUi(msg, ctx) {
        var action = msg && msg.action;
        var payload = msg && msg.payload ? msg.payload : msg;

        switch (action) {
            case 'alert':
                window.alert((msg && msg.message) || (payload && payload.message) || 'sent from terminal');
                return true;
            case 'toast.show':
                return showToast(payload, ctx);
            case 'speech.say':
                return say(payload);
            case 'url.open':
                return openUrl(payload, ctx);
            case 'controller.mode':
            case 'controller.mapping':
            case 'controller.profile':
                return handleController(action, payload, ctx);
            case 'radio.play':
                return handleRadioPlay(payload);
            case 'radio.stop':
                return handleRadioStop();
            case 'bridge.probe':
                /* Handled in terminal-iframe.html via WebSocket I/O.
                   The parent gets a copy of the postMessage for logging only. */
                console.log('[flweb] bridge.probe received (handled by iframe)');
                return true;
            default:
                console.warn('[flweb] unhandled terminal-ui action:', action, payload);
                return false;
        }
    }

    window.FLWeb = {
        buildAssetUrl: buildAssetUrl,
        handleTerminalUi: handleTerminalUi,
        openUrl: openUrl,
        showToast: showToast,
        say: say
    };
})();
