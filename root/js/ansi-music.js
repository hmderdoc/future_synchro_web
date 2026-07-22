/* ANSI music (BANSI/PCBoard/CTerm) parser and Web Audio player. */
(function (root, factory) {
    'use strict';
    var api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AnsiMusic = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    var SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

    function parseMml(source) {
        var s = String(source || '').toUpperCase();
        var tempo = 120, octave = 4, defaultLength = 4, gap = 0.125;
        var events = [], i = 0, total = 0;

        function readInt(fallback) {
            var start = i;
            while (i < s.length && s.charCodeAt(i) >= 48 && s.charCodeAt(i) <= 57) i++;
            return i === start ? fallback : parseInt(s.slice(start, i), 10);
        }
        function duration(length, dots) {
            var base = 240 / (tempo * Math.max(1, length));
            var value = base, add = base;
            while (dots-- > 0) { add /= 2; value += add; }
            return value;
        }
        function add(frequency, seconds) {
            if (!(seconds > 0) || events.length >= 512 || total >= 120) return;
            seconds = Math.min(seconds, 120 - total);
            events.push({ frequency: frequency, duration: seconds });
            total += seconds;
        }
        function addNote(frequency, seconds) {
            add(frequency, seconds * (1 - gap));
            if (gap) add(0, seconds * gap);
        }
        function frequency(index) {
            return 16.351597831287414 * Math.pow(2, index / 12);
        }

        while (i < s.length && events.length < 512 && total < 120) {
            var c = s.charAt(i++), value, length, dots, semitone, seconds;
            if (c === ' ' || c === '\t' || c === '|') continue;
            if (c === 'T') { tempo = Math.max(32, readInt(tempo)); continue; }
            if (c === 'O') { octave = Math.max(0, Math.min(6, readInt(octave))); continue; }
            if (c === 'L') { defaultLength = Math.max(1, readInt(defaultLength)); continue; }
            if (c === '>') { octave = Math.min(6, octave + 1); continue; }
            if (c === '<') { octave = Math.max(0, octave - 1); continue; }
            if (c === 'M') {
                if (i < s.length) {
                    gap = { N: 0.125, L: 0, S: 0.25 }[s.charAt(i)] !== undefined
                        ? { N: 0.125, L: 0, S: 0.25 }[s.charAt(i)] : gap;
                    i++;
                }
                continue;
            }
            if (Object.prototype.hasOwnProperty.call(SEMITONES, c)) {
                semitone = SEMITONES[c];
                while (i < s.length && '#+-'.indexOf(s.charAt(i)) !== -1) {
                    semitone += s.charAt(i++) === '-' ? -1 : 1;
                }
                length = readInt(defaultLength); dots = 0;
                while (s.charAt(i) === '.') { dots++; i++; }
                seconds = duration(length, dots);
                addNote(frequency(octave * 12 + semitone), seconds);
                continue;
            }
            if (c === 'P' || c === 'R') {
                length = readInt(defaultLength); dots = 0;
                while (s.charAt(i) === '.') { dots++; i++; }
                add(0, duration(length, dots));
                continue;
            }
            if (c === 'N') {
                value = readInt(0);
                length = readInt(defaultLength);
                seconds = duration(length, 0);
                if (value === 0) add(0, seconds); else addNote(frequency(value), seconds);
            }
        }
        return events;
    }

    function Player(options) {
        options = options || {};
        this.context = null;
        this.nodes = [];
        this.pending = null;
        this.volume = options.volume === undefined ? 0.12 : options.volume;
    }
    Player.prototype._getContext = function () {
        var AudioContextClass = root.AudioContext || root.webkitAudioContext;
        if (!AudioContextClass) return null;
        if (!this.context) this.context = new AudioContextClass();
        return this.context;
    };
    Player.prototype.unlock = function () {
        var self = this, context = this._getContext();
        if (!context) return Promise.resolve(false);
        return Promise.resolve(context.resume()).then(function () {
            if (self.pending) {
                var mml = self.pending; self.pending = null; self.play(mml);
            }
            return true;
        }).catch(function () { return false; });
    };
    Player.prototype.stop = function () {
        this.nodes.forEach(function (node) { try { node.stop(); } catch (_) {} });
        this.nodes = [];
        this.pending = null;
    };
    Player.prototype.play = function (mml) {
        var context = this._getContext();
        var events = parseMml(mml);
        this.stop();
        if (!context || !events.length) return false;
        if (context.state !== 'running') {
            this.pending = mml;
            this.unlock();
            return false;
        }
        var when = context.currentTime + 0.005;
        var self = this;
        events.forEach(function (event) {
            if (event.frequency > 0) {
                var oscillator = context.createOscillator();
                var gain = context.createGain();
                var fade = Math.min(0.005, event.duration / 4);
                oscillator.type = 'square';
                oscillator.frequency.setValueAtTime(event.frequency, when);
                gain.gain.setValueAtTime(0, when);
                gain.gain.linearRampToValueAtTime(self.volume, when + fade);
                gain.gain.setValueAtTime(self.volume, Math.max(when + fade, when + event.duration - fade));
                gain.gain.linearRampToValueAtTime(0, when + event.duration);
                oscillator.connect(gain); gain.connect(context.destination);
                oscillator.start(when); oscillator.stop(when + event.duration);
                self.nodes.push(oscillator);
            }
            when += event.duration;
        });
        return true;
    };

    function Filter(onMusic, options) {
        options = options || {};
        this.onMusic = typeof onMusic === 'function' ? onMusic : function () {};
        // APC strings (ESC _ ... ST) carry SyncTERM audio (Store/Load/Queue).
        this.onApc = typeof options.onApc === 'function' ? options.onApc : function () {};
        this.maxLength = options.maxLength || 1024;
        this.apcMax = options.apcMax || (1 << 20); // base64 audio chunks are ~KBs
        this.state = 'data'; this.csi = ''; this.music = ''; this.apc = '';
        this.intro = '\x1b[M'; this.stripFlag = false;
    }
    Filter.prototype.feed = function (chunk) {
        var input = String(chunk || ''), output = '', i = 0, c, code;
        while (i < input.length) {
            c = input.charAt(i++); code = c.charCodeAt(0);
            if (this.state === 'data') {
                if (c === '\x1b') this.state = 'esc'; else output += c;
            } else if (this.state === 'esc') {
                if (c === '[') { this.state = 'csi'; this.csi = '\x1b['; }
                else if (c === '_') { this.state = 'apc'; this.apc = ''; }
                else { output += '\x1b' + c; this.state = 'data'; }
            } else if (this.state === 'csi') {
                this.csi += c;
                if (code >= 0x40 && code <= 0x7e) {
                    if (this.csi === '\x1b[M' || c === '|' || c === 'N') {
                        this.state = 'music'; this.music = ''; this.intro = this.csi;
                        this.stripFlag = c === '|';
                    } else { output += this.csi; this.state = 'data'; }
                }
            } else if (this.state === 'music') {
                if (this.stripFlag) {
                    this.stripFlag = false;
                    if (c === 'B' || c === 'F') continue;
                }
                if (c === '\x0e') {
                    this.onMusic(this.music); this.music = ''; this.state = 'data';
                } else if (c === '\x1b' || this.music.length >= this.maxLength) {
                    output += this.intro + this.music; this.music = ''; this.state = 'data'; i--;
                } else this.music += c;
            } else if (this.state === 'apc') {
                // Capture the APC payload until the ST terminator (ESC \).
                if (c === '\x1b') this.state = 'apc_esc';
                else if (this.apc.length >= this.apcMax) { this.apc = ''; this.state = 'data'; }
                else this.apc += c;
            } else if (this.state === 'apc_esc') {
                if (c === '\\') { this.onApc(this.apc); this.apc = ''; this.state = 'data'; }
                else if (c === '\x1b') { this.apc += '\x1b'; } // stay, ESC was literal
                else { this.apc += '\x1b' + c; this.state = 'apc'; }
            }
        }
        return output;
    };
    Filter.prototype.reset = function () {
        this.state = 'data'; this.csi = ''; this.music = ''; this.apc = ''; this.stripFlag = false;
    };

    /* Minimal SyncTERM APC audio player — exactly what the Game Boy door emits:
       Store (cache a base64 WAV by name), Load (bind slot -> name), Queue
       (schedule that clip). One channel, mono PCM. Synth/Copy/Flush/Volume/
       Wait/Update and multi-channel mixing are intentionally ignored. Clips are
       scheduled back-to-back on the AudioContext clock for gapless playback,
       with a small lead as the jitter cushion. */
    function ApcPlayer(options) {
        options = options || {};
        this.context = null;
        this.cache = {};   // name -> { promise: Promise<AudioBuffer> }
        this.slots = {};   // slot id -> name
        this.sources = [];
        this.nextTime = 0;
        this.tail = Promise.resolve();   // serializes scheduling under async decode
        this.lead = options.lead === undefined ? 0.2 : options.lead;
        this.volume = options.volume === undefined ? 0.8 : options.volume;
        // Closed-loop protocol state (fl_records streaming + sink detection):
        this.onNotify = typeof options.onNotify === 'function' ? options.onNotify : null;
        this.armed = {};       // channel -> Update one-shot armed
        this.pending = {};     // channel -> clips scheduled and not yet ended
        this.chainDepth = 0;   // Queues accepted but not yet scheduled (decoding)
        this.gen = 0;          // bumped by Flush: orphans stale onended callbacks
        this.masterGain = null;
    }
    ApcPlayer.prototype._getContext = function () {
        var AudioContextClass = root.AudioContext || root.webkitAudioContext;
        if (!AudioContextClass) return null;
        if (!this.context) this.context = new AudioContextClass();
        return this.context;
    };
    ApcPlayer.prototype.unlock = function () {
        var context = this._getContext();
        if (!context) return Promise.resolve(false);
        return Promise.resolve(context.resume()).then(function () { return true; })
            .catch(function () { return false; });
    };
    // Whether an audio sink is available, WITHOUT opening the device. A door
    // probes this before streaming; opening an AudioContext here would grab
    // the hardware for a session that may never play a sound (and browsers
    // start it suspended anyway). Constructibility is the honest answer.
    ApcPlayer.prototype.available = function () {
        return !!(root.AudioContext || root.webkitAudioContext);
    };
    // Is this channel still playing (scheduled clips outstanding, or queues
    // accepted but not yet scheduled)? Matches _checkDrain's idle test.
    ApcPlayer.prototype._channelRunning = function (ch) {
        return (this.pending[ch] || 0) > 0 || this.chainDepth > 0;
    };
    // Reply for a CSI = 7 [; channel] n audio-state poll, mirroring SyncTERM's
    // audio_apc.c: CSI = 7 [; id ; state]... n, state 1 = running 0 = stopped.
    // channel -1 means "all", and lists every running channel.
    ApcPlayer.prototype.audioStateReply = function (channel) {
        if (channel >= 0) {
            return '\x1b[=7;' + channel + ';' + (this._channelRunning(channel) ? 1 : 0) + 'n';
        }
        var pairs = '';
        for (var ch in this.pending) {
            if (this.pending.hasOwnProperty(ch) && this._channelRunning(parseInt(ch, 10))) {
                pairs += ';' + ch + ';1';
            }
        }
        return '\x1b[=7' + pairs + 'n';
    };
    // Parse one APC payload (the bytes between ESC_ and ST) and act on it.
    // Returns a reply string to send back to the server, or undefined.
    ApcPlayer.prototype.feed = function (payload) {
        if (payload.indexOf('SyncTERM:') !== 0) return;
        var body = payload.slice(9);           // after "SyncTERM:"
        // Feature query: Q;<feature>. Answered from capability, not by opening
        // the device. Unknown features stay silent, as SyncTERM does.
        if (body.indexOf('Q;') === 0) {
            var feature = body.slice(2);
            if (feature === 'libsndfile') {
                return '\x1b[=7;100;' + (this.available() ? 1 : 0) + 'n';
            }
            return;
        }
        var parts = body.split(';');
        if (parts[0] === 'C' && parts[1] === 'S') {
            // Store: C;S;<name>;<base64-wav>  (base64 contains no ';')
            this._store(parts[2], parts.slice(3).join(';'));
            return;
        }
        if (parts[0] !== 'A') return;
        var cmd = parts[1], kv = {}, pos = [];
        for (var k = 2; k < parts.length; k++) {
            var eq = parts[k].indexOf('=');
            if (eq > 0) kv[parts[k].slice(0, eq)] = parts[k].slice(eq + 1);
            else if (parts[k]) pos.push(parts[k]);
        }
        var ch = kv.C === undefined ? 2 : parseInt(kv.C, 10);
        if (cmd === 'Load') this.slots[parseInt(kv.S, 10)] = pos[0];
        else if (cmd === 'Queue') this._queue(parseInt(kv.S, 10), ch);
        else if (cmd === 'Update') this.armed[ch] = true;
        else if (cmd === 'Flush') this._flush(ch);
        else if (cmd === 'Volume') this._volume(kv.V, kv.T);
        // Synth/Copy/Wait: not needed by the doors we serve.
    };
    // Canonical SyncTERM volume: bare number = 0..100 linear percent,
    // 'NdB' = decibels. Returns a linear gain multiplier.
    ApcPlayer.prototype._parseVolume = function (value) {
        var s = String(value === undefined ? '100' : value).trim();
        if (/db$/i.test(s)) {
            var db = parseFloat(s.slice(0, -2));
            return isNaN(db) ? 1 : Math.pow(10, db / 20);
        }
        var v = parseFloat(s);
        if (isNaN(v)) return 1;
        if (v <= 0) return 0;
        if (v > 100) v = 100;
        return v / 100;
    };
    ApcPlayer.prototype._getMasterGain = function () {
        var context = this._getContext();
        if (!context) return null;
        if (!this.masterGain) {
            this.masterGain = context.createGain();
            this.masterGain.gain.value = 1;
            this.masterGain.connect(context.destination);
        }
        return this.masterGain;
    };
    ApcPlayer.prototype._volume = function (v, rampMs) {
        var context = this._getContext();
        var master = this._getMasterGain();
        if (!context || !master) return;
        var target = this._parseVolume(v);
        var ramp = parseInt(rampMs, 10);
        try {
            if (!isNaN(ramp) && ramp > 0) {
                master.gain.cancelScheduledValues(context.currentTime);
                master.gain.setValueAtTime(master.gain.value, context.currentTime);
                master.gain.linearRampToValueAtTime(target, context.currentTime + ramp / 1000);
            } else {
                master.gain.value = target;
            }
        } catch (_) { master.gain.value = target; }
    };
    ApcPlayer.prototype._flush = function (ch) {
        // Stop everything scheduled; a bumped generation orphans the stale
        // onended callbacks so they can't corrupt the pending counts.
        this.gen++;
        this.sources.forEach(function (s) { try { s.stop(); } catch (_) {} });
        this.sources = [];
        this.nextTime = 0;
        this.tail = Promise.resolve();
        this.chainDepth = 0;
        var hadPending = this.pending[ch] > 0;
        this.pending = {};
        // Going idle fires an armed one-shot (BBSproxy/SyncTERM edge
        // semantics); the door's flush-grace window absorbs it.
        if (hadPending) this._checkDrain(ch);
    };
    ApcPlayer.prototype._checkDrain = function (ch) {
        if (!this.armed[ch]) return;
        if ((this.pending[ch] || 0) > 0 || this.chainDepth > 0) return;
        this.armed[ch] = false;
        if (this.onNotify) {
            try { this.onNotify(ch); } catch (_) {}
        }
    };
    ApcPlayer.prototype._store = function (name, b64) {
        var context = this._getContext();
        if (!context || !name) return;
        var binary;
        try { binary = root.atob ? root.atob(b64) : Buffer.from(b64, 'base64').toString('binary'); }
        catch (_) { return; }
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        // decodeAudioData is async; cache the promise so a Queue can await it.
        var decoded = context.decodeAudioData(bytes.buffer);
        this.cache[name] = { promise: Promise.resolve(decoded) };
    };
    ApcPlayer.prototype._queue = function (slot, ch) {
        var self = this, name = this.slots[slot];
        if (name === undefined) return;
        var entry = this.cache[name];
        if (!entry) return;
        // Chain so clips schedule in arrival order despite out-of-order
        // decodes; chainDepth keeps drain detection honest while decoding.
        this.chainDepth++;
        var gen = this.gen;
        this.tail = this.tail.then(function () {
            return entry.promise.then(function (buffer) {
                self.chainDepth = Math.max(0, self.chainDepth - 1);
                if (gen === self.gen) self._schedule(buffer, ch);
                else self._checkDrain(ch);
            });
        }).catch(function () {
            self.chainDepth = Math.max(0, self.chainDepth - 1);
            self._checkDrain(ch);
        });
    };
    ApcPlayer.prototype._schedule = function (buffer, ch) {
        var self = this;
        var context = this._getContext();
        if (!context || !buffer) return;
        var gen = this.gen;
        var done = function () {
            if (gen !== self.gen) return;   // flushed since: already accounted
            self.pending[ch] = Math.max(0, (self.pending[ch] || 0) - 1);
            self._checkDrain(ch);
        };
        this.pending[ch] = (this.pending[ch] || 0) + 1;
        if (context.state !== 'running') {
            // Autoplay-locked: no audio yet, but the closed loop must keep
            // breathing (the door's sink DETECTION rides the drain notify) —
            // simulate the clip's playout on a timer.
            setTimeout(done, Math.max(20, buffer.duration * 1000 + 30));
            return;
        }
        var src = context.createBufferSource();
        src.buffer = buffer;
        var gain = context.createGain();
        gain.gain.value = this.volume;
        src.connect(gain); gain.connect(this._getMasterGain() || context.destination);
        var now = context.currentTime;
        // (Re)prime the lead if we've fallen behind or are starting fresh.
        if (this.nextTime < now + 0.02) this.nextTime = now + this.lead;
        src.onended = done;
        src.start(this.nextTime);
        this.nextTime += buffer.duration;
        this.sources.push(src);
        if (this.sources.length > 64) this.sources.shift();
    };
    ApcPlayer.prototype.stop = function () {
        this.gen++;
        this.sources.forEach(function (s) { try { s.stop(); } catch (_) {} });
        this.sources = []; this.nextTime = 0; this.tail = Promise.resolve();
        this.cache = {}; this.slots = {};
        this.armed = {}; this.pending = {}; this.chainDepth = 0;
    };
    ApcPlayer.prototype.reset = ApcPlayer.prototype.stop;

    return { Filter: Filter, Player: Player, ApcPlayer: ApcPlayer, parseMml: parseMml };
}));
