// Count-in timing, Restart settings and title stripping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FOLLOW_COUNT_IN, countInTiming, countdownNumber } from '../dist/audio.mjs';
import { acceptNote, createTake, restartSettings, summarize } from '../dist/practice.mjs';
import { stripTitles } from '../dist/score.mjs';
import { midi, root, sampleNotes } from './helpers.mjs';

const notes = sampleNotes();

// ---- count-in timing

test('Scored tempo count-in: 4 beats at the BPM, timing starts on the downbeat after the count', () => {
  const t = countInTiming({ contextNow: 2, perfNow: 10_000, bpm: 80, beats: 4 });
  assert.equal(t.beatMs, 750);
  assert.equal(t.firstClick, 2.12); // first click 120 ms after scheduling (AudioContext clock)
  assert.equal(t.start, 10_120); // same moment on the performance.now() clock
  assert.equal(t.downbeat, 10_120 + 4 * 750); // the take's timing reference
});

test('count-in timing is unchanged from before for the default 4 beats', () => {
  // The previous implementation: start = now + 120 ms, downbeat = start + 4 beats.
  for (const bpm of [40, 72, 88, 120, 200]) {
    const t = countInTiming({ contextNow: 0, perfNow: 5000, bpm });
    assert.equal(t.downbeat, 5000 + 120 + 4 * (60_000 / bpm));
  }
});

test('Follow mode uses a short fixed count-in', () => {
  assert.deepEqual({ ...FOLLOW_COUNT_IN }, { beats: 3, bpm: 90 });
  const t = countInTiming({ contextNow: 0, perfNow: 0, ...FOLLOW_COUNT_IN });
  assert.ok(t.downbeat > 1500 && t.downbeat < 2500, `${t.downbeat} ms`);
});

test('countdown shows 4, 3, 2, 1 in sync with the clicks, then nothing', () => {
  const t = countInTiming({ contextNow: 0, perfNow: 0, bpm: 60, beats: 4 }); // clicks at 120, 1120, 2120, 3120 ms
  const at = (ms) => countdownNumber(t, ms);
  assert.equal(at(0), 4); // before the first click
  assert.equal(at(120), 4);
  assert.equal(at(1119), 4);
  assert.equal(at(1120), 3);
  assert.equal(at(2120), 2);
  assert.equal(at(3120), 1);
  assert.equal(at(4119), 1);
  assert.equal(at(4120), null); // downbeat: listening begins
  assert.equal(countdownNumber(null, 0), null); // count-in off
  const follow = countInTiming({ contextNow: 0, perfNow: 0, ...FOLLOW_COUNT_IN });
  assert.equal(countdownNumber(follow, 0), 3);
});

test('Scored take with a count-in still measures from the downbeat', () => {
  const i = notes.findIndex((n) => n.bar === '9');
  const t = countInTiming({ contextNow: 0, perfNow: 0, bpm: 80 });
  const take = createTake(notes, i, notes[i].beat, 80, t.downbeat);
  assert.equal(acceptNote(take, midi('E4'), t.downbeat - 1000).type, 'ignored'); // during the count-in
  const late = acceptNote(take, midi('E4'), t.downbeat + 200);
  assert.equal(Math.round(late.delta), 200);
});

// ---- count-in off: Scored tempo anchors on the first note

test('Scored tempo without a count-in: the first matched note sets the downbeat', () => {
  const take = createTake(notes, 0, 0, 80, null); // Bar 1: C4 D4 E4 G4, quarter notes
  const first = acceptNote(take, midi('C4'), 5000);
  assert.equal(first.type, 'matched');
  assert.equal(first.delta, 0);
  assert.equal(take.downbeat, 5000);
  assert.equal(Math.round(acceptNote(take, midi('D4'), 5750 + 30).delta), 30);
  assert.equal(Math.round(acceptNote(take, midi('E4'), 6500 - 50).delta), -50);
  const s = summarize(take);
  assert.equal(s.enoughTiming, true);
  assert.equal(s.timing, 100);
});

// ---- Restart

test('Restart resets to the same passage, mode and tempo and keeps nothing from the take', () => {
  const i = notes.findIndex((n) => n.bar === '9');
  const take = { ...createTake(notes, i, notes[i].beat, 80, 1000, notes.findIndex((n) => n.bar === '11')), startBar: 8, endBar: '9' };
  acceptNote(take, midi('E4'), 1000);
  acceptNote(take, midi('F#4'), 1700);
  const settings = restartSettings(take);
  assert.deepEqual(settings, { startIndex: i, startBar: 8, endBar: '9', bpm: 80 });
  // A fresh take from these settings starts clean.
  const again = createTake(notes, settings.startIndex, notes[settings.startIndex].beat, settings.bpm, 9000);
  assert.equal(again.cursor, i);
  assert.deepEqual([again.matched.length, again.missed.length, again.extras.length], [0, 0, 0]);
});

test('Restart keeps Follow mode (no tempo) and an open-ended passage', () => {
  const take = { ...createTake(notes, 3, 0, null, null), startBar: 0, endBar: '' };
  assert.deepEqual(restartSettings(take), { startIndex: 3, startBar: 0, endBar: '', bpm: null });
});

// ---- title stripping

test('stripTitles removes title, composer and credits but keeps every note', () => {
  const xml = readFileSync(`${root}/dist/assets/morning-lines.musicxml`, 'utf8');
  const out = stripTitles(xml);
  for (const tag of ['<work>', '<work-title>', '<creator', 'Morning Lines']) assert.ok(!out.includes(tag), tag);
  assert.equal((out.match(/<note>/g) || []).length, (xml.match(/<note>/g) || []).length);
  assert.ok(out.includes('<identification>')); // the container stays; only its creator is removed
});

test('stripTitles handles credits, movement titles and look-alike tags', () => {
  const xml = [
    '<score-partwise>',
    '<work><work-number>Op. 1</work-number><work-title>Piece</work-title></work>',
    '<movement-number>2</movement-number><movement-title>Allegro</movement-title>',
    '<identification><creator type="composer">A. Composer</creator><rights>(c) Someone</rights><encoding><software>X</software></encoding></identification>',
    '<credit page="1"><credit-type>title</credit-type><credit-words justify="center">Piece</credit-words></credit>',
    '<credit page="1"/>',
    '<part-list><score-part id="P1"><part-name>Workhorse</part-name></score-part></part-list>',
    '</score-partwise>',
  ].join('');
  const out = stripTitles(xml);
  assert.equal(out, '<score-partwise><identification><encoding><software>X</software></encoding></identification><part-list><score-part id="P1"><part-name>Workhorse</part-name></score-part></part-list></score-partwise>');
});
