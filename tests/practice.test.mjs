// Score following and feedback (dist/practice.mjs) driven by timestamped note-on events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptNote, createTake, summarize, TIMING_TOLERANCE, MIN_TIMED_MATCHES } from '../dist/practice.mjs';
import { sampleNotes, midi } from './helpers.mjs';

const notes = sampleNotes();
const barStart = (label) => notes.findIndex((n) => n.bar === label);

test('sample matches the demo script: 18 bars, Bar 9 = E4 D4 C4, page 2 opens on G4 in Bar 10', () => {
  assert.equal(new Set(notes.map((n) => n.bar)).size, 18);
  assert.deepEqual(notes.filter((n) => n.bar === '9').map((n) => n.midi), [midi('E4'), midi('D4'), midi('C4')]);
  const first2 = notes.find((n) => n.page === 2);
  assert.equal(first2.bar, '10');
  assert.equal(first2.midi, midi('G4'));
  assert.equal(TIMING_TOLERANCE, 120);
  assert.equal(MIN_TIMED_MATCHES, 3);
});

test('free tempo demo path: Bar 9 E D C, a pause, then G4 matches the first note of page 2', () => {
  const i = barStart('9');
  const take = createTake(notes, i, notes[i].beat, null, null);
  const r = [['E4', 0], ['D4', 700], ['C4', 1400]].map(([n, t]) => acceptNote(take, midi(n), t));
  assert.deepEqual(r.map((x) => x.type), ['matched', 'matched', 'matched']);
  assert.equal(notes[take.cursor].page, 2); // next expected is on page 2; the page has not turned yet
  const g = acceptNote(take, midi('G4'), 1400 + 6000); // after a 6 s pause
  assert.equal(g.type, 'matched');
  assert.equal(g.note.page, 2);
});

test('a skipped note is recovered nearby and recorded as missed', () => {
  const take = createTake(notes, 0, 0, null, null); // Bar 1: C4 D4 E4 G4
  acceptNote(take, midi('C4'), 0);
  acceptNote(take, midi('D4'), 600);
  const r = acceptNote(take, midi('G4'), 1800); // skips E4, arrives when G4 is due
  assert.equal(r.type, 'matched');
  assert.equal(take.missed.length, 1);
  assert.equal(take.missed[0].midi, midi('E4'));
});

test('a stray wrong note does not jump ahead', () => {
  const take = createTake(notes, 0, 0, null, null);
  acceptNote(take, midi('C4'), 0);
  acceptNote(take, midi('D4'), 600);
  const stray = acceptNote(take, midi('G4'), 640); // G4 is two ahead but far too early
  assert.equal(stray.type, 'extra');
  assert.equal(acceptNote(take, midi('E4'), 1200).type, 'matched');
  assert.equal(take.missed.length, 0);
  assert.equal(take.extras.length, 1);
});

test('scored tempo: a late note and a wrong pitch show up at their bars', () => {
  const i = barStart('9');
  const bpm = 80;
  const beatMs = 60000 / bpm;
  const downbeat = 10000;
  const take = createTake(notes, i, notes[i].beat, bpm, downbeat);
  // Bar 9: E4 D4 C4(half) | Bar 10: G4 A4 G4 E4
  const plays = [['E4', 0, 0], ['D4', 1, 0], ['C4', 2, 260], ['G4', 4, 0], ['F#4', 5, 0], ['A4', 5, 20], ['G4', 6, 0], ['E4', 7, -40]];
  for (const [n, beat, off] of plays) acceptNote(take, midi(n), downbeat + beat * beatMs + off);
  const late = take.matched.find((m) => m.delta > TIMING_TOLERANCE);
  assert.equal(late.note.bar, '9');
  assert.equal(Math.round(late.delta), 260);
  assert.equal(take.extras.length, 1);
  assert.equal(take.extras[0].midi, midi('F#4'));
  assert.equal(take.extras[0].note.bar, '10');
  const s = summarize(take);
  assert.equal(s.pitch, 100); // 7 of 7 expected notes matched; the wrong one is listed as an extra
  assert.equal(s.timing, Math.round((6 / 7) * 100));
  assert.ok(s.enoughTiming);
});

test('timing needs at least three matched notes', () => {
  const take = createTake(notes, 0, 0, 80, 5000);
  acceptNote(take, midi('C4'), 5000);
  acceptNote(take, midi('D4'), 5750);
  const s = summarize(take);
  assert.equal(s.timing, null);
  assert.equal(s.enoughTiming, false);
});

test('scored tempo ignores sound before the count-in downbeat (the clicks)', () => {
  const take = createTake(notes, 0, 0, 80, 5000);
  assert.equal(acceptNote(take, midi('C4'), 3000).type, 'ignored');
  assert.equal(acceptNote(take, midi('C4'), 5010).type, 'matched');
});

test('free tempo has pitch only', () => {
  const take = createTake(notes, 0, 0, null, null);
  ['C4', 'D4', 'E4'].forEach((n, k) => acceptNote(take, midi(n), k * 500));
  const s = summarize(take);
  assert.equal(s.pitch, 100);
  assert.equal(s.timing, null);
});
