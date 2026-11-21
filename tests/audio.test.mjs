// Note-on detection (dist/audio.mjs) fed with synthesised audio, framed the way
// openMicrophone() does it: a 4096-sample window every ~13 ms, level from the last 1024 samples.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measurePitch, createOnsetTracker, signalLevel } from '../dist/audio.mjs';
import { synth, midi } from './helpers.mjs';

const SR = 48000;
const FRAME = 4096;

function detect(signal) {
  const events = [];
  const track = createOnsetTracker((ev) => events.push(ev));
  const hop = Math.round(SR * 0.013);
  for (let end = FRAME; end <= signal.length; end += hop) {
    const frame = signal.subarray(end - FRAME, end);
    const level = signalLevel(frame.subarray(frame.length - 1024));
    track(measurePitch(frame, SR, level), level, (end / SR) * 1000);
  }
  return events;
}
const names = (evs) => evs.map((e) => e.midi);

test('measurePitch finds C4, A4 and G5', () => {
  for (const m of [60, 69, 79]) {
    const buf = synth([{ midi: m, dur: 0.2 }], SR, 0).subarray(1000, 1000 + FRAME);
    assert.equal(measurePitch(buf, SR)?.midi, m);
  }
});

test('silence and quiet noise give no pitch and no events', () => {
  const sig = synth([{ midi: null, dur: 2 }], SR, 0.005);
  assert.equal(measurePitch(sig.subarray(0, FRAME), SR), null);
  assert.deepEqual(detect(sig), []);
});

test('Bar 9 phrase E4 D4 C4 gives three events', () => {
  const sig = synth([{ midi: null, dur: 0.3 }, { midi: midi('E4'), dur: 0.45 }, { midi: midi('D4'), dur: 0.45 }, { midi: midi('C4'), dur: 0.8 }, { midi: null, dur: 0.3 }]);
  assert.deepEqual(names(detect(sig)), [midi('E4'), midi('D4'), midi('C4')]);
});

test('a held note gives one event', () => {
  const sig = synth([{ midi: null, dur: 0.3 }, { midi: midi('C4'), dur: 3 }, { midi: null, dur: 0.3 }]);
  assert.deepEqual(names(detect(sig)), [midi('C4')]);
});

test('a decaying (piano-like) held note gives one event', () => {
  const sig = synth([{ midi: null, dur: 0.3 }, { midi: midi('C4'), dur: 2, amp: 0.5, decay: 0.8 }, { midi: null, dur: 0.3 }]);
  assert.deepEqual(names(detect(sig)), [midi('C4')]);
});

test('the same pitch played twice with a short gap gives two events', () => {
  const sig = synth([{ midi: null, dur: 0.3 }, { midi: midi('E4'), dur: 0.4 }, { midi: null, dur: 0.08 }, { midi: midi('E4'), dur: 0.4 }, { midi: null, dur: 0.3 }]);
  assert.deepEqual(names(detect(sig)), [midi('E4'), midi('E4')]);
});

test('the same pitch re-attacked legato (volume dip, no silence) gives two events', () => {
  const sig = synth([
    { midi: null, dur: 0.3 },
    { midi: midi('E4'), dur: 0.45, amp: 0.4, release: 0.001 },
    { midi: midi('E4'), dur: 0.06, amp: 0.06, attack: 0.001, release: 0.001 },
    { midi: midi('E4'), dur: 0.45, amp: 0.4, attack: 0.01 },
    { midi: null, dur: 0.3 },
  ]);
  assert.deepEqual(names(detect(sig)), [midi('E4'), midi('E4')]);
});

test('note-on time is close to the true onset (before the latency shift the browser loop applies)', () => {
  const sig = synth([{ midi: null, dur: 0.5 }, { midi: midi('A4'), dur: 0.6 }]);
  const [ev] = detect(sig);
  // Window end is used as "now"; the app subtracts ~32 ms of window latency.
  assert.ok(ev.at - 500 >= 0 && ev.at - 500 < 90, `onset at ${ev.at} ms`);
});
