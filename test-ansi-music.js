'use strict';

var assert = require('assert');
var music = require('./root/js/ansi-music.js');

var played = [];
var filter = new music.Filter(function (mml) { played.push(mml); });

assert.strictEqual(filter.feed('plain\x1b[31mred'), 'plain\x1b[31mred');
assert.strictEqual(filter.feed('\x1b['), '');
assert.strictEqual(filter.feed('|BT120O4L8CD'), '');
assert.strictEqual(filter.feed('EF\x0etail'), 'tail');
assert.deepStrictEqual(played, ['T120O4L8CDEF']);

assert.strictEqual(filter.feed('a\x1b[Mnot music'), 'a');
assert.strictEqual(filter.feed('\x1b[2Jb'), '\x1b[Mnot music\x1b[2Jb');

filter.feed('\x1b[12NT100N40\x0e');
assert.strictEqual(played[1], 'T100N40');
filter.feed('\x1b[MT90L8ABC\x0e');
assert.strictEqual(played[2], 'T90L8ABC');

var notes = music.parseMml('T120O4L4C. R8 >C');
assert.ok(notes.length >= 4);
assert.ok(Math.abs(notes.reduce(function (sum, event) { return sum + event.duration; }, 0) - 1.5) < 0.0001);
assert.ok(notes[0].frequency > 250 && notes[0].frequency < 270);

var started = 0, stopped = 0;
global.AudioContext = function () {
    this.state = 'running'; this.currentTime = 1; this.destination = {};
};
global.AudioContext.prototype.resume = function () { return Promise.resolve(); };
global.AudioContext.prototype.createGain = function () {
    return { gain: {
        setValueAtTime: function () {}, linearRampToValueAtTime: function () {}
    }, connect: function () {} };
};
global.AudioContext.prototype.createOscillator = function () {
    return {
        frequency: { setValueAtTime: function () {} }, connect: function () {},
        start: function () { started++; }, stop: function () { stopped++; }
    };
};
var player = new music.Player();
assert.strictEqual(player.play('L4C'), true);
assert.strictEqual(started, 1);
assert.strictEqual(player.play('L4D'), true);
assert.strictEqual(started, 2);
assert.ok(stopped >= 2); // scheduled stop plus cancellation of the previous note
player.stop();

console.log('ANSI music parser tests passed');

/* --- SyncTERM APC audio (the gb door's Store/Load/Queue subset) --- */

// Filter captures ESC_ ... ST payloads and passes the rest through untouched.
var apcPayloads = [];
var apcFilter = new music.Filter(function () {}, {
    onApc: function (p) { apcPayloads.push(p); }
});
assert.strictEqual(
    apcFilter.feed('pre\x1b_SyncTERM:A;Queue;C=2;S=0\x1b\\post'), 'prepost');
assert.deepStrictEqual(apcPayloads, ['SyncTERM:A;Queue;C=2;S=0']);
// payload split across feeds, base64 (with ';'-free body) intact
apcPayloads.length = 0;
assert.strictEqual(apcFilter.feed('x\x1b_Sync'), 'x');
assert.strictEqual(apcFilter.feed('TERM:C;S;g0;QQ==\x1b\\y'), 'y');
assert.deepStrictEqual(apcPayloads, ['SyncTERM:C;S;g0;QQ==']);

// ApcPlayer schedules Store->Load->Queue clips gaplessly on the AC clock.
(function () {
    global.AudioContext = function () {
        this.state = 'running'; this.currentTime = 1; this.destination = {};
    };
    global.AudioContext.prototype.resume = function () { return Promise.resolve(); };
    global.AudioContext.prototype.decodeAudioData = function () {
        return Promise.resolve({ duration: 0.12 });
    };
    var starts = [];
    global.AudioContext.prototype.createBufferSource = function () {
        return { buffer: null, connect: function () {}, start: function (t) { starts.push(t); }, stop: function () {} };
    };
    global.AudioContext.prototype.createGain = function () {
        return { gain: { value: 0 }, connect: function () {} };
    };

    var apc = new music.ApcPlayer({ lead: 0.2 });
    function trip(slot, name) {
        apc.feed('SyncTERM:C;S;' + name + ';QQ==');
        apc.feed('SyncTERM:A;Load;S=' + slot + ';' + name);
        apc.feed('SyncTERM:A;Queue;C=2;S=' + slot);
    }
    trip(0, 'g0');
    setTimeout(function () {
        assert.strictEqual(starts.length, 1);
        assert.ok(Math.abs(starts[0] - 1.2) < 1e-6, 'first clip at currentTime+lead');
        trip(1, 'g1');
        setTimeout(function () {
            assert.strictEqual(starts.length, 2);
            assert.ok(Math.abs(starts[1] - 1.32) < 1e-6, 'second clip gapless after first');
            console.log('APC audio tests passed');
        }, 20);
    }, 20);
})();
