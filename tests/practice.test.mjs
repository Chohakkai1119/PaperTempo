// Score following and feedback (dist/practice.mjs) driven by timestamped note-on events.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptNote, acceptPerformance, advancePerformance, completedTakeSummary, createTake, finalizeContinuousTake,
  MIN_TIMED_MATCHES, samePracticePassage, summarize, timingTolerance, updateInputHealth,
} from '../dist/practice.mjs';
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

test('keep going recovers from wrong and missing notes, grades extras, and respects the selected end', () => {
  const melody = [60, 62, 64, 65, 67].map((midi, beat) => ({ midi, beat, measure: 0 }));
  const take = createTake(melody, 0, 0, 120, 1000, 4, { following: 'continuous', endBeat: 4 });
  assert.equal(acceptNote(take, 62, 1080).type, 'extra', 'wrong notes cannot take an upcoming slot');
  assert.equal(take.cursor, 0);
  assert.equal(acceptNote(take, 62, 1500).type, 'matched');
  assert.equal(acceptNote(take, 65, 2500).type, 'matched');
  assert.equal(acceptNote(take, 67, 2800).type, 'extra', 'notes during the trailing gap are extras');
  assert.equal(acceptNote(take, 67, 3000).type, 'ignored', 'input after the selected passage is outside the take');
  assert.deepEqual(take.missed, [melody[0], melody[2]]);
  assert.deepEqual(take.matched.map(({ note }) => note), [melody[1], melody[3]]);
  assert.equal(completedTakeSummary(take, summarize(take)), null, 'matching the last note cannot finish the clock');
  finalizeContinuousTake(take, 3000, true);
  const summary = summarize(take);
  assert.equal(summary.attempted, 4);
  assert.equal(summary.pitch, 33, '2 correct of 4 written notes plus 2 extras');
  assert.equal(summary.beatTiming, 50);
  assert.equal(summary.spacing, null, 'does not measure a gap over a missed note');
  assert.equal(summary.rhythm, 50);
  assert.equal(summary.overall, 40);
  assert.equal(completedTakeSummary(take, summary).following, 'continuous');
});

test('keep going assigns a repeated pitch to the closest written onset', () => {
  const melody = [{ midi: 60, beat: 0 }, { midi: 60, beat: 0.5 }, { midi: 60, beat: 1 }];
  const take = createTake(melody, 0, 0, 120, 1000, 3, { following: 'continuous', endBeat: 2 });
  const repeat = acceptNote(take, 60, 1250);
  assert.equal(repeat.type, 'matched');
  assert.equal(repeat.note, melody[1]);
  assert.deepEqual(take.missed, [melody[0]]);
  assert.equal(acceptNote(take, 60, 1290).type, 'extra');
  assert.equal(acceptNote(take, 60, 1510).note, melody[2]);
});

test('constant lateness affects beat timing while preserving the written note spacing', () => {
  const melody = [{ midi: 60, beat: 0 }, { midi: 67, beat: 2 }];
  const take = createTake(melody, 0, 0, 120, 1000, 2, { following: 'continuous', endBeat: 3 });
  acceptNote(take, 60, 1150);
  acceptNote(take, 67, 2150);
  finalizeContinuousTake(take, 2500, true);
  const summary = summarize(take);
  assert.deepEqual(summary.intervals, [{
    previous: melody[0], note: melody[1], expectedMs: 1000, deltaMs: 0, toleranceMs: 140,
  }]);
  assert.equal(summary.beatTiming, 25);
  assert.equal(summary.spacing, 100);
  assert.equal(summary.rhythm, 63);
  assert.equal(summary.overall, 85);
});

test('spacing compares written onsets including rests and uses a tighter window for shorter gaps', () => {
  const melody = [{ midi: 60, beat: 0 }, { midi: 67, beat: 2 }, { midi: 69, beat: 2.5 }];
  const take = createTake(melody, 0, 0, 120, 1000, 3, { following: 'continuous', endBeat: 3 });
  acceptNote(take, 60, 1150);
  acceptNote(take, 67, 1900);
  acceptNote(take, 69, 2250);
  finalizeContinuousTake(take, 2500, true);
  const summary = summarize(take);
  assert.deepEqual(summary.intervals.map(({ expectedMs, deltaMs, toleranceMs }) => (
    [expectedMs, deltaMs, toleranceMs]
  )), [[1000, -250, 140], [250, 100, 50]]);
  assert.equal(summary.spacing, 5);
});

test('a stopped continuous take grades elapsed attempts while silence through the end grades the whole passage', () => {
  const melody = [60, 62, 64].map((midi, beat) => ({ midi, beat, measure: 0 }));
  const take = createTake(melody, 0, 0, 120, 1000, 3, { following: 'continuous', endBeat: 3 });
  finalizeContinuousTake(take, 1340, false);
  const partial = summarize(take);
  assert.equal(partial.attempted, 1);
  assert.equal(partial.overall, 0);
  assert.equal(completedTakeSummary(take, partial), null);
  finalizeContinuousTake(take, 2500, true);
  const full = summarize(take);
  assert.equal(full.attempted, 3);
  assert.equal(full.pitch, 0);
  assert.equal(full.beatTiming, 0);
  assert.equal(full.rhythm, 0);
  assert.equal(full.overall, 0);
  assert.equal(completedTakeSummary(take, full).missed, 3);
});

test('wait for the right note stays on the expected pitch and keeps free tempo playback unscored', () => {
  const melody = [{ midi: 60, beat: 0 }, { midi: 62, beat: 1 }];
  const take = createTake(melody, 0, 0, null, null, 2, { following: 'wait' });
  assert.equal(acceptNote(take, 62, 600).type, 'extra');
  assert.equal(acceptNote(take, 62, 1200).type, 'extra');
  assert.equal(take.cursor, 0);
  assert.equal(acceptNote(take, 60, 5000).type, 'matched');
  assert.equal(acceptNote(take, 62, 8000).type, 'matched');
  const summary = summarize(take);
  assert.equal(take.missed.length, 0);
  assert.equal(summary.pitch, 50);
  assert.equal(summary.spacing, null);
  assert.equal(summary.overall, null);
  const stored = completedTakeSummary(take, summary);
  assert.equal(samePracticePassage(stored, { ...stored, following: 'continuous' }), false);
});

function event(beat, midis, measure = 0) {
  const pitches = midis.map((midi) => ({
    midi, beat, measure, page: 1, id: `printed-${midi}`, occurrenceId: `${beat}-${midi}`,
  }));
  return { ...pitches.at(-1), duration: 1, pitches };
}

function perform(take, at, ...midis) {
  return acceptPerformance(take, { onsetMs: at, pitches: midis.map((midi) => ({ midi })) });
}

test('incorrect three-tone chord credits two written heads, marks the missing tone and reports the extra', () => {
  const notes = [event(0, [60, 64, 67])];
  const take = createTake(notes, 0, 0, 120, 1000, 1, { following: 'continuous', endBeat: 1 });
  assert.equal(perform(take, 1000, 60, 64, 69).type, 'pending');
  assert.equal(advancePerformance(take, 1080).changed, true);
  assert.deepEqual([...take.results.values()].map(({ note, status }) => [note.midi, status]), [
    [60, 'correct'], [64, 'correct'], [67, 'missed'],
  ]);
  assert.deepEqual(take.extras.map(({ midi }) => midi), [69]);
  const summary = summarize(take);
  assert.equal(summary.pitch, 50);
  assert.deepEqual(summary.chords, { total: 1, complete: 0, expectedTones: 3, matchedTones: 2 });
  assert.equal(summary.bars[0].mistakes, 2);
});

test('a strum groups distinct attacks and retains each offset while allowing spread', () => {
  const notes = [event(0, [60, 64, 67]), event(0.75, [69])];
  const take = createTake(notes, 0, 0, 120, 1000, 2,
    { following: 'continuous', endBeat: 2, groupWindowMs: 150, strumAllowanceMs: 130 });
  perform(take, 1000, 60);
  perform(take, 1060, 64);
  perform(take, 1120, 67);
  advancePerformance(take, 1150);
  assert.equal(perform(take, 1375, 69).type, 'matched');
  const summary = summarize(take);
  assert.deepEqual(summary.results.map(({ status, delta, gradedDelta }) => [status, delta, gradedDelta]), [
    ['correct', 0, 0], ['correct', 60, 0], ['correct', 120, 0], ['correct', 0, 0],
  ]);
  assert.equal(summary.spacing, 100);
  assert.equal(summary.chords.complete, 1);
});

test('fast adjacent written onset limits chord grouping and preserves its own attack', () => {
  const notes = [event(0, [60, 64]), event(0.25, [69])];
  const take = createTake(notes, 0, 0, 120, 1000, 2,
    { following: 'continuous', endBeat: 1, groupWindowMs: 150, strumAllowanceMs: 130 });
  perform(take, 1000, 60);
  perform(take, 1033, 64);
  assert.equal(perform(take, 1100, 69).type, 'matched');
  assert.equal(take.extras.length, 0);
  assert.equal(summarize(take).correct, 3);
});

test('late pitch stays yellow, wrong pitch becomes red at slot close and repeated heads grade independently', () => {
  const notes = [event(0, [60]), event(1, [60]), event(2, [67], 1)];
  const take = createTake(notes, 0, 0, 120, 1000, 3, { following: 'continuous', endBeat: 3 });
  perform(take, 1150, 60);
  perform(take, 1500, 60);
  perform(take, 2000, 69);
  assert.equal(take.results.has('2-67'), false);
  advancePerformance(take, 2500, { complete: true });
  const summary = summarize(take);
  assert.deepEqual(summary.results.map(({ status, heardMidi }) => [status, heardMidi]), [
    ['timing', 60], ['correct', 60], ['wrong', 69],
  ]);
  assert.equal(summary.late, 1);
  assert.equal(summary.wrong, 1);
  assert.equal(summary.missed, 0);
  assert.equal(summary.largestTimingErrors[0].delta, 150);
  assert.ok(summary.rhythm < 100);
  assert.equal(summary.bars[1].mistakes, 2);
});

test('wait mode requires a coherent chord and excludes unattempted material from partial grades', () => {
  const notes = [event(0, [60, 64, 67]), event(1, [69])];
  const take = createTake(notes, 0, 0, null, null, 2, { following: 'wait', groupWindowMs: 80 });
  perform(take, 1000, 60);
  perform(take, 1200, 64, 67);
  advancePerformance(take, 1280);
  assert.equal(take.cursor, 0);
  advancePerformance(take, 1300, { finish: true });
  const summary = summarize(take);
  assert.deepEqual(summary.results.map(({ status }) => status), ['missed', 'correct', 'correct', 'unattempted']);
  assert.equal(summary.pitch, 67);
  assert.equal(summary.timing, null);
  assert.equal(summary.attempted, 3);
  assert.equal(summary.expected, 4);
  assert.equal(completedTakeSummary(take, summary), null);
});

test('wait mode retains an extra that matches the next written note when it is inside the chord window', () => {
  const notes = [event(0, [60, 64, 67]), event(0.25, [69])];
  const take = createTake(notes, 0, 0, null, null, 2, { following: 'wait', groupWindowMs: 120 });
  perform(take, 1000, 60, 64, 67);
  assert.equal(perform(take, 1080, 69).type, 'pending');
  advancePerformance(take, 1120);
  assert.equal(take.cursor, 1);
  assert.deepEqual(take.extras.map(({ midi }) => midi), [69]);
  assert.equal(perform(take, 1160, 69).type, 'matched');
  assert.equal(summarize(take).pitch, 80);
});

test('watermark orders separately delivered attacks on opposite sides of a repeated-note boundary', () => {
  const notes = [event(0, [60]), event(0.5, [60]), event(1, [64])];
  const take = createTake(notes, 0, 0, 120, 1000, 3, {
    following: 'continuous', endBeat: 2, reorderAttacks: true,
  });
  perform(take, 1240, 60);
  perform(take, 1030, 60);
  assert.equal(take.cursor, 0);
  assert.deepEqual(advancePerformance(take, 1240), { changed: true, previousCursor: 0, cursor: 2 });
  perform(take, 1500, 64);
  advancePerformance(take, 1530, { finish: true });
  assert.deepEqual(summarize(take).results.map(({ at, status }) => [at, status]), [
    [1030, 'correct'], [1240, 'correct'], [1500, 'correct'],
  ]);
});

test('separate attack messages from one sample frame cannot advance two expected events', () => {
  const notes = [event(0, [60]), event(0.25, [64])];
  const take = createTake(notes, 0, 0, null, null, 2, { following: 'wait', reorderAttacks: true });
  perform(take, 1000, 60);
  perform(take, 1000, 64);
  advancePerformance(take, 1050);
  assert.equal(take.cursor, 1);
  assert.deepEqual(take.extras.map(({ midi }) => midi), [64]);
  assert.equal(summarize(take).results[1].status, 'unattempted');
});

test('attack delivered behind the capture watermark makes the timed take unassessable', () => {
  const notes = [event(0, [60]), event(1, [62])];
  const take = createTake(notes, 0, 0, 120, 1000, 2, {
    following: 'continuous', endBeat: 2, reorderAttacks: true,
  });
  advancePerformance(take, 1210);
  assert.equal(perform(take, 1000, 60).type, 'ignored');
  advancePerformance(take, 2000, { complete: true });
  assert.equal(summarize(take).unassessable, true);
  assert.equal(summarize(take).overall, null);
});

test('unavailable microphone and unconfirmed signal produce no grades', () => {
  const notes = [event(0, [60]), event(1, [62])];
  for (const available of [false, true]) {
    const take = createTake(notes, 0, 0, 120, 1000, 2, { following: 'continuous', endBeat: 2 });
    updateInputHealth(take, 1000, { available, signal: false });
    advancePerformance(take, 2000, { complete: true });
    const summary = summarize(take);
    assert.equal(summary.pitch, null);
    assert.equal(summary.overall, null);
    assert.equal(summary.unassessable, true);
    assert.equal(summary.unassessed, 2);
    assert.equal(completedTakeSummary(take, summary), null);
  }
});

test('a rejected unstable sound near one note remains neutral while verified silence marks a miss', () => {
  const notes = [event(0, [60]), event(1, [62]), event(2, [64])];
  const take = createTake(notes, 0, 0, 120, 1000, 3, { following: 'continuous', endBeat: 3 });
  perform(take, 1000, 60);
  for (const at of [1470, 1495, 1520, 1545]) {
    updateInputHealth(take, at, { available: true, signal: true, uncertain: true });
  }
  advancePerformance(take, 2500, { complete: true });
  const summary = summarize(take);
  assert.deepEqual(summary.results.map(({ status }) => status), ['correct', 'unassessable', 'missed']);
  assert.equal(summary.pitch, 50);
});
