export const MIN_TIMED_MATCHES = 3;

export function timingTolerance(bpm) {
  return Math.min(140, Math.max(70, 0.2 * 60_000 / bpm));
}

export function createTake(notes, startIndex, startBeat, bpm, downbeat, endIndex = notes.length, { following, endBeat } = {}) {
  return {
    notes, startIndex, endIndex, startBeat, bpm, downbeat, following, endBeat, cursor: startIndex,
    finished: false,
    earlier: null, matched: [], missed: [], extras: [],
  };
}

function onsetTime(take, note) {
  return take.downbeat + (note.beat - take.startBeat) * 60_000 / take.bpm;
}

function slotRadius(take, index, direction) {
  const maximum = 2 * timingTolerance(take.bpm);
  const neighbor = index + direction;
  if (neighbor < take.startIndex || neighbor >= take.endIndex) return maximum;
  const beatGap = Math.abs(take.notes[index].beat - take.notes[neighbor].beat);
  return Math.min(maximum, beatGap * 30_000 / take.bpm);
}

function continuousEndTime(take) {
  const last = take.notes[take.endIndex - 1];
  const endBeat = take.endBeat ?? (last ? last.beat + (last.duration || 1) : take.startBeat);
  return take.downbeat + (endBeat - take.startBeat) * 60_000 / take.bpm;
}

export function finalizeContinuousTake(take, at, complete) {
  if (take.following !== 'continuous') return;
  const passageEnd = continuousEndTime(take);
  while (take.cursor < take.endIndex) {
    const note = take.notes[take.cursor];
    const deadline = Math.min(passageEnd, onsetTime(take, note) + slotRadius(take, take.cursor, 1));
    if (!complete && !(at >= deadline)) break;
    take.missed.push(note);
    take.cursor += 1;
  }
  if (complete) take.finished = true;
}

function recordExtra(take, note, midi, at, index) {
  const extra = { note, midi, at };
  if (index !== undefined) extra.index = index;
  take.extras.push(extra);
  return { type: 'extra', ...extra };
}

function acceptContinuous(take, midi, at) {
  if (take.finished || take.startIndex >= take.endIndex || !Number.isFinite(at)
    || at < take.downbeat - 140 || !(at < continuousEndTime(take))) return { type: 'ignored' };
  finalizeContinuousTake(take, at, false);

  const { notes, cursor, endIndex, startIndex } = take;
  const next = cursor < endIndex ? notes[cursor] : null;
  const withinSlot = next && at >= onsetTime(take, next) - slotRadius(take, cursor, -1);
  if (withinSlot) {
    return midi === next.midi ? recordMatch(take, cursor, at) : recordExtra(take, next, midi, at, cursor);
  }

  const previous = cursor > startIndex ? notes[cursor - 1] : null;
  const closest = previous && (!next || Math.abs(at - onsetTime(take, previous)) <= Math.abs(at - onsetTime(take, next)))
    ? previous : next;
  return recordExtra(take, closest, midi, at);
}

function lookaheadInTime(take, candidate, at) {
  const { earlier, bpm, downbeat, startBeat } = take;
  if (bpm && Number.isFinite(downbeat)) {
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
  if (take.following === 'continuous') return acceptContinuous(take, midi, at);
  const { notes, cursor, endIndex } = take;
  if (cursor >= endIndex || (take.bpm && at < take.downbeat - 140)) return { type: 'ignored' };
  const expected = notes[cursor];
  let matchIndex = midi === expected.midi ? cursor : -1;
  if (matchIndex < 0 && take.following !== 'wait') {
    for (let index = cursor + 1; index <= Math.min(cursor + 2, endIndex - 1); index += 1) {
      const candidate = notes[index];
      if (candidate.midi === midi && lookaheadInTime(take, candidate, at)) {
        matchIndex = index;
        break;
      }
    }
  }
  if (matchIndex < 0) {
    return recordExtra(take, expected, midi, at, take.following === 'wait' ? cursor : undefined);
  }
  return recordMatch(take, matchIndex, at);
}

function recordMatch(take, matchIndex, at) {
  const { notes, cursor, earlier } = take;
  const note = notes[matchIndex];
  if (matchIndex > cursor) take.missed.push(...notes.slice(cursor, matchIndex));
  // Scored tempo without a count-in: the first matched note sets the downbeat.
  if (take.bpm && !Number.isFinite(take.downbeat)) {
    take.downbeat = at - (note.beat - take.startBeat) * 60_000 / take.bpm;
  }
  const delta = take.bpm ? at - onsetTime(take, note) : null;
  const match = { note, at, delta };
  if (take.following) match.index = matchIndex;
  take.matched.push(match);
  take.cursor = matchIndex + 1;
  if (!take.following) {
    const beatGap = earlier ? note.beat - earlier.note.beat : 0;
    const measured = beatGap > 0 ? (at - earlier.at) / beatGap : 0;
    let msPerBeat = earlier?.msPerBeat ?? null;
    if (measured >= 150 && measured <= 1800) msPerBeat = msPerBeat ? 0.65 * msPerBeat + 0.35 * measured : measured;
    take.earlier = { note, at, msPerBeat };
  }
  return { type: 'matched', ...match };
}

function matchedIntervals(matched, bpm) {
  const intervals = [];
  for (let i = 1; i < matched.length; i += 1) {
    const previous = matched[i - 1];
    const current = matched[i];
    if (current.index !== previous.index + 1) continue;
    const expectedMs = (current.note.beat - previous.note.beat) * 60_000 / bpm;
    if (expectedMs <= 0) continue;
    const deltaMs = current.at - previous.at - expectedMs;
    const toleranceMs = Math.min(140, Math.max(40, expectedMs * 0.2));
    intervals.push({ previous: previous.note, note: current.note, expectedMs, deltaMs, toleranceMs });
  }
  return intervals;
}

export function summarize(take) {
  const { matched, missed, extras, downbeat, bpm, following } = take;
  const triedCurrentNote = extras.some((item) => following ? item.index === take.cursor : item.note === take.notes[take.cursor]);
  const attempted = matched.length + missed.length + Number(triedCurrentNote);
  const pitchOpportunities = following ? attempted + extras.length : attempted;
  const pitchRatio = pitchOpportunities ? matched.length / pitchOpportunities : null;
  const enoughTiming = Number.isFinite(bpm) && bpm > 0 && Number.isFinite(downbeat)
    && (following ? attempted > 0 : matched.length >= MIN_TIMED_MATCHES);
  const summary = {
    attempted,
    pitch: pitchRatio === null ? null : Math.round(pitchRatio * 100),
    timing: null,
    rhythm: null,
    overall: null,
    enoughTiming,
  };
  if (following) Object.assign(summary, { beatTiming: null, spacing: null, intervals: [] });
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
  const beatRatio = timingCredit / attempted;
  let rhythmRatio = beatRatio;
  if (following) {
    const intervals = matchedIntervals(matched, bpm);
    const spacingRatio = intervals.length
      ? intervals.reduce((sum, { deltaMs, toleranceMs }) => sum + Math.max(0, 1 - Math.abs(deltaMs) / (2 * toleranceMs)), 0) / intervals.length
      : null;
    if (spacingRatio !== null) rhythmRatio = (beatRatio + spacingRatio) / 2;
    Object.assign(summary, {
      beatTiming: Math.round(beatRatio * 100),
      spacing: spacingRatio === null ? null : Math.round(spacingRatio * 100),
      intervals,
    });
  }
  return {
    ...summary,
    timing: matched.length ? Math.round(onTime / matched.length * 100) : 0,
    rhythm: Math.round(rhythmRatio * 100),
    overall: Math.round((0.6 * pitchRatio + 0.4 * rhythmRatio) * 100),
  };
}

function finalBar(take) {
  return take.endBar === '' ? take.notes.at(-1).measure : Number(take.endBar);
}

/**
 * What Restart goes back to: the same passage (start note, start and end bar),
 * the same mode and the same tempo. Nothing from the discarded take is kept.
 */
export function restartSettings(take) {
  return {
    startIndex: take.startIndex,
    startBar: take.startBar,
    endBar: take.endBar,
    bpm: take.bpm ?? null,
    ...(take.following === undefined ? {} : { following: take.following }),
    ...(take.countInEnabled === undefined ? {} : { countInEnabled: take.countInEnabled }),
  };
}

export function mistakePassage(take, measure) {
  const lastBar = finalBar(take);
  const startBar = Math.max(take.startBar, Math.min(measure, lastBar - 1));
  return { startBar, endBar: Math.min(lastBar, startBar + 1) };
}

export function completedTakeSummary(take, { pitch, timing, rhythm, overall, beatTiming, spacing }) {
  if (take.cursor !== take.endIndex || (take.following === 'continuous' && !take.finished)) return null;
  return {
    startBar: take.startBar, endBar: finalBar(take), startIndex: take.startIndex,
    endIndex: take.endIndex, startBeat: take.startBeat, bpm: take.bpm, following: take.following,
    pitch, timing, rhythm, overall, beatTiming, spacing, missed: take.missed.length,
  };
}

export function samePracticePassage(a, b) {
  return a.startBar === b.startBar && a.endBar === b.endBar
    && a.startIndex === b.startIndex && a.endIndex === b.endIndex
    && a.startBeat === b.startBeat && a.bpm === b.bpm && a.following === b.following;
}
