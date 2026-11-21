import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlayback } from '../dist/playback.mjs';

function note(id, beat, duration, midi = 60, page = 1) {
  return { id, beat, duration, midi, page };
}

function createClock() {
  let nextHandle = 0;
  let contextCreations = 0;
  let naturalEnds = 0;
  const frames = new Map();
  const intervals = new Map();
  const oscillators = [];
  const highlights = [];
  const context = {
    currentTime: 100,
    destination: {},
    resume: async () => {},
    createOscillator() {
      const oscillator = {
        frequency: {},
        stops: [],
        connect: (target) => target,
        disconnect() { this.disconnected = true; },
        start(time) { this.startAt = time; },
        stop(time) { this.stops.push(time); },
      };
      oscillators.push(oscillator);
      return oscillator;
    },
    createGain() {
      return {
        gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
        connect() {},
        disconnect() {},
      };
    },
  };
  const playback = createPlayback({
    onNote: (current) => highlights.push(current),
    onEnd: () => { naturalEnds += 1; },
    createContext: () => { contextCreations += 1; return context; },
    requestFrame: (callback) => { const handle = nextHandle++; frames.set(handle, callback); return handle; },
    cancelFrame: (handle) => frames.delete(handle),
    scheduleInterval: (callback) => { const handle = nextHandle++; intervals.set(handle, callback); return handle; },
    cancelInterval: (handle) => intervals.delete(handle),
  });
  return {
    playback, context, oscillators, highlights,
    get naturalEnds() { return naturalEnds; },
    get contextCreations() { return contextCreations; },
    advance(time, { frame = true, schedule = true } = {}) {
      context.currentTime = time;
      if (schedule) for (const callback of [...intervals.values()]) callback();
      if (frame) for (const [handle, callback] of [...frames]) {
        frames.delete(handle);
        callback();
      }
    },
  };
}

function approximately(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `expected ${expected}, got ${actual}`);
}

test('playback uses the audio clock for notes and preserves rests and the page cursor', async () => {
  const clock = createClock();
  const early = note('outside', 1, 1);
  const first = note('first', 3, 0.5, 69);
  const second = note('second', 5, 1, 72, 2);
  const late = note('outside', 8, 1);
  const settings = { startBeat: 2, endBeat: 8, bpm: 60 };

  assert.equal(await clock.playback.play([early, first, second, late], settings), true);
  assert.equal(clock.oscillators.length, 0, 'leading rest is silent');
  clock.advance(100.84, { frame: false });
  assert.equal(clock.oscillators.length, 1, 'the scheduler advances without an animation frame');
  approximately(clock.oscillators[0].startAt, 101.04);
  approximately(clock.oscillators[0].stops[0], 101.54);
  assert.equal(clock.oscillators[0].frequency.value, 440);
  assert.deepEqual(clock.highlights, []);
  clock.advance(101.05);
  clock.advance(101.55);
  clock.advance(102.84);
  approximately(clock.oscillators[1].startAt, 103.04);
  clock.advance(103.05);
  clock.advance(104.05);
  assert.deepEqual(clock.highlights, [first, null, second, null]);
  assert.equal(clock.naturalEnds, 0, 'does not finish until trailing rest has elapsed');
  clock.advance(106.05);
  clock.advance(106.10);
  assert.equal(clock.naturalEnds, 1);
  assert.equal(clock.oscillators.length, 2);
});

test('pausing stops audio and resumes the remaining sustain at the original tempo', async () => {
  const clock = createClock();
  const first = note('first', 0, 2);
  const second = note('second', 2, 1);
  const settings = { startBeat: 0, endBeat: 3, bpm: 60 };

  assert.equal(await clock.playback.play([first, second], settings), true);
  clock.advance(100.54);
  assert.deepEqual(clock.highlights, [first]);
  assert.equal(clock.playback.pause(), true);
  assert.equal(clock.oscillators[0].disconnected, true);
  clock.advance(110);
  assert.equal(clock.oscillators.length, 1);
  assert.deepEqual(clock.highlights, [first], 'pause holds the score cursor');
  assert.equal(await clock.playback.resume(), true);
  assert.equal(clock.contextCreations, 1, 'resumes using the same AudioContext');
  approximately(clock.oscillators[1].startAt, 110.04);
  approximately(clock.oscillators[1].stops[0], 111.54);
  clock.advance(111.32);
  approximately(clock.oscillators[2].startAt, 111.54);
  clock.advance(111.55);
  assert.deepEqual(clock.highlights, [first, second]);
  clock.playback.stop();
  assert.equal(await clock.playback.resume(), false);
  clock.advance(115);
  assert.equal(clock.naturalEnds, 0, 'stopping does not emit a natural finish');
  assert.deepEqual(clock.highlights, [first, second, null]);
  assert.ok(clock.oscillators.every((oscillator) => oscillator.disconnected));
});

test('manual stop cancels a pending start before any sound is created', async () => {
  const clock = createClock();
  let allowStart;
  clock.context.resume = () => new Promise((resolve) => { allowStart = resolve; });
  const pending = clock.playback.play([note('first', 0, 1)], { startBeat: 0, endBeat: 1, bpm: 120 });
  clock.playback.stop();
  allowStart();
  assert.equal(await pending, false);
  clock.advance(105);
  assert.deepEqual(clock.oscillators, []);
  assert.deepEqual(clock.highlights, []);
  assert.equal(clock.naturalEnds, 0);
});

test('a new passage supersedes a pending AudioContext resume from the old passage', async () => {
  const clock = createClock();
  let rejectOldRequest;
  clock.context.resume = () => new Promise((_, reject) => { rejectOldRequest = reject; });
  const oldPassage = clock.playback.play([note('first', 0, 1)], { startBeat: 0, endBeat: 1, bpm: 120 });

  const second = note('second', 1, 1, 69);
  clock.context.resume = async () => {};
  assert.equal(await clock.playback.play([second], { startBeat: 1, endBeat: 2, bpm: 120 }), true);
  rejectOldRequest(new Error('Old resume failed'));
  assert.equal(await oldPassage, false);
  clock.advance(100.1);
  assert.equal(clock.oscillators.length, 1);
  assert.equal(clock.oscillators[0].frequency.value, 440);
  approximately(clock.oscillators[0].stops[0], 100.54);
  assert.deepEqual(clock.highlights, [second]);
});

test('a delayed scheduler skips elapsed notes instead of playing a burst after the delay', async () => {
  const clock = createClock();
  const notes = [note('elapsed', 1, 0.2), note('current', 2, 1, 69), note('future', 3, 1)];
  assert.equal(await clock.playback.play(notes, { startBeat: 0, endBeat: 4, bpm: 60 }), true);
  clock.advance(102.4);
  assert.equal(clock.oscillators.length, 1);
  assert.equal(clock.oscillators[0].frequency.value, 440);
  approximately(clock.oscillators[0].startAt, 102.4);
  approximately(clock.oscillators[0].stops[0], 103.04);
  assert.deepEqual(clock.highlights, [notes[1]]);
});

test('range limits clip sustaining notes and invalid or silent ranges need no context', async () => {
  const clock = createClock();
  const clipped = note('clipped', 1, 2);
  const outside = note('outside', 2.5, 1);
  assert.equal(await clock.playback.play([clipped], { startBeat: 3, endBeat: 4, bpm: 60 }), false);
  assert.equal(await clock.playback.play([clipped], { startBeat: 2, endBeat: 2, bpm: 60 }), false);
  assert.equal(await clock.playback.play([clipped], { startBeat: 2, endBeat: 3, bpm: 0 }), false);
  assert.equal(clock.contextCreations, 0);
  assert.equal(await clock.playback.play([clipped, outside], { startBeat: 2, endBeat: 2.5, bpm: 60 }), true);
  approximately(clock.oscillators[0].startAt, 100.04);
  approximately(clock.oscillators[0].stops[0], 100.54);
  clock.advance(100.1);
  assert.deepEqual(clock.highlights, [clipped]);
  clock.advance(100.55);
  assert.equal(clock.oscillators.length, 1);
  assert.equal(clock.naturalEnds, 1);
});
