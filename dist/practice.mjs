export const MIN_TIMED_MATCHES = 3;

export function timingTolerance(bpm) {
  return Math.min(140, Math.max(70, 0.2 * 60_000 / bpm));
}

export function createTake(notes, startIndex, startBeat, bpm, downbeat, endIndex = notes.length) {
  return {
    notes, startIndex, endIndex, startBeat, bpm, downbeat, cursor: startIndex,
    earlier: null, matched: [], missed: [], extras: [],
  };
}

function lookaheadInTime(take, candidate, at) {
  const { earlier, bpm, downbeat, startBeat } = take;
  if (bpm) {
    const target = downbeat + (candidate.beat - startBeat) * 60_000 / bpm;
    return Math.abs(at - target) <= Math.max(360, 60_000 / bpm * 0.8);
  }
  if (!earlier) return false;
  const beatGap = candidate.beat - earlier.note.beat;
  const estimate = earlier.msPerBeat;
  if (estimate) return Math.abs(at - earlier.at - beatGap * estimate) <= Math.max(420, estimate * 1.5);
  return at - earlier.at >= 190 && at - earlier.at <= Math.max(1100, beatGap * 1050);
}

export function acceptNote(take, midi, at) {
  const { notes, cursor, earlier, endIndex } = take;
  if (cursor >= endIndex || (take.bpm && at < take.downbeat - 140)) return { type: 'ignored' };
  const expected = notes[cursor];
  let matchIndex = midi === expected.midi ? cursor : -1;
  if (matchIndex < 0) {
    for (let index = cursor + 1; index <= Math.min(cursor + 2, endIndex - 1); index += 1) {
      const candidate = notes[index];
      if (candidate.midi === midi && lookaheadInTime(take, candidate, at)) {
        matchIndex = index;
        break;
      }
    }
  }
  if (matchIndex < 0) {
    const extra = { note: expected, midi, at };
    take.extras.push(extra);
    return { type: 'extra', ...extra };
  }
  const note = notes[matchIndex];
  take.missed.push(...notes.slice(cursor, matchIndex));
  const delta = take.bpm ? at - take.downbeat - (note.beat - take.startBeat) * 60_000 / take.bpm : null;
  const match = { note, at, delta };
  take.matched.push(match);
  take.cursor = matchIndex + 1;
  const beatGap = earlier ? note.beat - earlier.note.beat : 0;
  const measured = beatGap > 0 ? (at - earlier.at) / beatGap : 0;
  let msPerBeat = earlier?.msPerBeat ?? null;
  if (measured >= 150 && measured <= 1800) msPerBeat = msPerBeat ? 0.65 * msPerBeat + 0.35 * measured : measured;
  take.earlier = { note, at, msPerBeat };
  return { type: 'matched', ...match };
}

export function summarize(take) {
  const { matched, missed, extras, downbeat, bpm } = take;
  const attempted = matched.length + missed.length + (extras.some((item) => item.note === take.notes[take.cursor]) ? 1 : 0);
  const pitchRatio = attempted ? matched.length / attempted : null;
  const enoughTiming = Number.isFinite(bpm) && bpm > 0 && Number.isFinite(downbeat) && matched.length >= MIN_TIMED_MATCHES;
  const summary = {
    attempted,
    pitch: pitchRatio === null ? null : Math.round(pitchRatio * 100),
    timing: null,
    rhythm: null,
    overall: null,
    enoughTiming,
  };
  if (!enoughTiming) return summary;

  const tolerance = timingTolerance(bpm);
  let onTime = 0;
  let timingCredit = 0;
  for (const { delta } of matched) {
    const distance = Math.abs(delta);
    if (distance <= tolerance) onTime += 1;
    timingCredit += Math.max(0, 1 - distance / (2 * tolerance));
  }
  // Missed notes earn no timing credit and still count in the attempted passage.
  const rhythmRatio = timingCredit / attempted;
  return {
    ...summary,
    timing: Math.round(onTime / matched.length * 100),
    rhythm: Math.round(rhythmRatio * 100),
    overall: Math.round((0.6 * pitchRatio + 0.4 * rhythmRatio) * 100),
  };
}

function finalBar(take) {
  return take.endBar === '' ? take.notes.at(-1).measure : Number(take.endBar);
}

export function mistakePassage(take, measure) {
  const lastBar = finalBar(take);
  const startBar = Math.max(take.startBar, Math.min(measure, lastBar - 1));
  return { startBar, endBar: Math.min(lastBar, startBar + 1) };
}

export function completedTakeSummary(take, { pitch, timing, rhythm, overall }) {
  if (take.cursor !== take.endIndex) return null;
  return {
    startBar: take.startBar, endBar: finalBar(take), startIndex: take.startIndex,
    endIndex: take.endIndex, startBeat: take.startBeat, bpm: take.bpm,
    pitch, timing, rhythm, overall, missed: take.missed.length,
  };
}

export function samePracticePassage(a, b) {
  return a.startBar === b.startBar && a.endBar === b.endBar
    && a.startIndex === b.startIndex && a.endIndex === b.endIndex
    && a.startBeat === b.startBeat && a.bpm === b.bpm;
}
