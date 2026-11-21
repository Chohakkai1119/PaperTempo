export const TIMING_TOLERANCE = 120;
export const MIN_TIMED_MATCHES = 3;

export function createTake(notes, startIndex, startBeat, bpm, downbeat) {
  return {
    notes, startIndex, startBeat, bpm, downbeat, cursor: startIndex,
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
  const { notes, cursor, earlier } = take;
  if (cursor >= notes.length || (take.bpm && at < take.downbeat - 140)) return { type: 'ignored' };
  const expected = notes[cursor];
  let matchIndex = midi === expected.midi ? cursor : -1;
  if (matchIndex < 0) {
    for (let index = cursor + 1; index <= Math.min(cursor + 2, notes.length - 1); index += 1) {
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
  const enoughTiming = Boolean(bpm && downbeat && matched.length >= MIN_TIMED_MATCHES);
  return {
    attempted,
    pitch: attempted ? Math.round(matched.length / attempted * 100) : null,
    timing: enoughTiming ? Math.round(matched.filter(({ delta }) => Math.abs(delta) <= TIMING_TOLERANCE).length / matched.length * 100) : null,
    enoughTiming,
  };
}
