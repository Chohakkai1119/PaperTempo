// Score following and feedback (dist/practice.mjs) driven by timestamped note-on events.
import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptNote, completedTakeSummary, createTake, MIN_TIMED_MATCHES, summarize, timingTolerance } from '../dist/practice.mjs';
import { sampleNotes, midi } from './helpers.mjs';

const notes = sampleNotes();
const barStart = (label) => notes.findIndex((n) => n.bar === label);

test('sample matches the demo script: 18 bars, Bar 9 = E4 D4 C4, page 2 opens on G4 in Bar 10', () => {
  assert.equal(new Set(notes.map((n) => n.bar)).size, 18);
  assert.deepEqual(notes.filter((n) => n.bar === '9').map((n) => n.midi), [midi('E4'), midi('D4'), midi('C4')]);
  const first2 = notes.find((n) => n.page === 2);
  assert.equal(first2.bar, '10');
  assert.equal(first2.midi, midi('G4'));
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
  const late = take.matched.find((m) => m.delta > timingTolerance(bpm));
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
  assert.equal(s.rhythm, null);
  assert.equal(s.overall, null);
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
  assert.equal(s.rhythm, null);
  assert.equal(s.overall, null);
});

test('timing window scales with tempo and clamps at both ends', () => {
  assert.equal(timingTolerance(60), 140);
  assert.equal(timingTolerance(100), 120);
  assert.equal(timingTolerance(120), 100);
  assert.equal(timingTolerance(180), 70);
  const takeSummary = (bpm) => {
    const take = createTake(notes, 0, 0, bpm, 0, 3);
    for (const note of notes.slice(0, 3)) {
      acceptNote(take, note.midi, note.beat * 60_000 / bpm + 120);
    }
    return summarize(take);
  };
  assert.equal(takeSummary(60).timing, 100);
  assert.equal(takeSummary(60).rhythm, 57);
  assert.equal(takeSummary(180).timing, 0);
  assert.equal(takeSummary(180).rhythm, 14);
});

test('identical pitches lose rhythm credit with onset error, down to zero for a very late note', () => {
  const take = createTake(notes, 0, 0, 120, 1000, 3);
  for (const [index, offset] of [[0, 0], [1, -100], [2, 300]]) {
    const note = notes[index];
    acceptNote(take, note.midi, 1000 + note.beat * 500 + offset);
  }
  assert.deepEqual(summarize(take), {
    attempted: 3, pitch: 100, timing: 67, rhythm: 50, overall: 80, enoughTiming: true,
  });
});

test('a missed note counts in both scores and the completed take retains the new metrics', () => {
  const start = barStart('9');
  const take = {
    ...createTake(notes, start, notes[start].beat, 120, 1000, start + 7),
    startBar: 8,
    endBar: '9',
  };
  for (const [index, note] of notes.slice(start, start + 7).entries()) {
    if (index === 1) continue;
    const offset = index === 2 ? 100 : 0;
    acceptNote(take, note.midi, 1000 + (note.beat - take.startBeat) * 500 + offset);
  }
  const summary = summarize(take);
  assert.deepEqual(summary, { attempted: 7, pitch: 86, timing: 100, rhythm: 79, overall: 83, enoughTiming: true });
  const completed = completedTakeSummary(take, summary);
  assert.equal(completed.rhythm, 79);
  assert.equal(completed.overall, 83);
  assert.equal(completed.missed, 1);
});

test('overall accuracy weights the underlying scores before rounding', () => {
  const melody = Array.from({ length: 6 }, (_, index) => ({ midi: 60 + index, beat: index }));
  const take = createTake(melody, 0, 0, 120, 1000);
  for (const index of [0, 2, 4, 5]) {
    acceptNote(take, melody[index].midi, 1000 + index * 500 + (index === 5 ? 36 : 0));
  }
  const { pitch, rhythm, overall } = summarize(take);
  assert.deepEqual({ pitch, rhythm, overall }, { pitch: 67, rhythm: 64, overall: 65 });
});

test('partial take scores only attempted notes and cannot become a comparison baseline', () => {
  const take = createTake(notes, 0, 0, 120, 1000, 7);
  for (const note of notes.slice(0, 3)) acceptNote(take, note.midi, 1000 + note.beat * 500);
  acceptNote(take, midi('F#4'), 1000 + notes[3].beat * 500);
  const summary = summarize(take);
  assert.deepEqual(summary, { attempted: 4, pitch: 75, timing: 100, rhythm: 75, overall: 75, enoughTiming: true });
  assert.equal(completedTakeSummary(take, summary), null);
});
