export const MIN_TIMED_MATCHES = 3;
const MAX_QUEUED_ATTACKS = 128;

export function timingTolerance(bpm) {
  return Math.min(140, Math.max(70, 0.2 * 60_000 / bpm));
}

export function createTake(notes, startIndex, startBeat, bpm, downbeat, endIndex = notes.length, {
  following, endBeat, groupWindowMs = 65, strumAllowanceMs = 0, assessPerformance = false, reorderAttacks = false,
} = {}) {
  return {
    notes, startIndex, endIndex, startBeat, bpm, downbeat, following, endBeat, cursor: startIndex,
    finished: false, closed: false,
    earlier: null, matched: [], missed: [], extras: [],
    assessPerformance, groupWindowMs, strumAllowanceMs,
    revision: 0, results: new Map(), groupMatches: [],
    reorderAttacks, attackQueue: [], watermark: -Infinity,
    chord: null, waitBest: null, wrongBySlot: new Map(),
    inputHealth: { observed: false, signalSeen: false, issue: null, uncertainty: new Map() },
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
  if (take.assessPerformance) return advancePerformance(take, at, { complete, finish: true });
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
  if (take.assessPerformance || take.notes[take.cursor]?.pitches?.length > 1) {
    return acceptPerformance(take, { onsetMs: at, pitches: [{ midi }] });
  }
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
  const { notes, cursor } = take;
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
  if (!take.following) updateTempoEstimate(take, note, at);
  return { type: 'matched', ...match };
}

function updateTempoEstimate(take, note, at) {
  const { earlier } = take;
  const beatGap = earlier ? note.beat - earlier.note.beat : 0;
  const measured = beatGap > 0 ? (at - earlier.at) / beatGap : 0;
  let msPerBeat = earlier?.msPerBeat ?? null;
  if (measured >= 150 && measured <= 1800) msPerBeat = msPerBeat ? 0.65 * msPerBeat + 0.35 * measured : measured;
  take.earlier = { note, at, msPerBeat };
}

const tonesOf = (note) => note.pitches?.length ? note.pitches : [note];
const toneKey = (index, note, ordinal) => note.occurrenceId ?? `${index}:${ordinal}`;

function slotDeadline(take, index) {
  return Math.min(continuousEndTime(take), onsetTime(take, take.notes[index]) + slotRadius(take, index, 1));
}

function inSlot(take, index, at) {
  return index < take.endIndex && at >= onsetTime(take, take.notes[index]) - slotRadius(take, index, -1);
}

/** Supply capture evidence independently of the pitch detector's accepted events. */
export function updateInputHealth(take, at, { available = true, signal = false, uncertain = false, issue } = {}) {
  take.assessPerformance = true;
  const health = take.inputHealth;
  health.observed = true;
  if (!available) health.issue ??= issue || 'The selected microphone became unavailable.';
  if (available && signal) health.signalSeen = true;
  if (!uncertain || !available || !signal) return;
  let index = take.cursor;
  if (take.following === 'continuous') {
    while (index < take.endIndex && at >= slotDeadline(take, index)) index += 1;
    if (!inSlot(take, index, at)) return;
  }
  if (index >= take.endIndex) return;
  const previous = health.uncertainty.get(index);
  const start = previous && at - previous.at <= 75 ? previous.start : at;
  health.uncertainty.set(index, { start, at, ambiguous: previous?.ambiguous || at - start >= 70 });
}

function setToneResult(take, index, ordinal, fields) {
  const note = tonesOf(take.notes[index])[ordinal];
  const key = toneKey(index, note, ordinal);
  const result = { key, note, index, ...fields };
  take.results.set(key, result);
  take.revision += 1;
  return result;
}

function closestSlot(take, at) {
  const { notes, cursor, startIndex, endIndex } = take;
  const next = cursor < endIndex ? notes[cursor] : null;
  const previous = cursor > startIndex ? notes[cursor - 1] : null;
  return previous && (!next || Math.abs(at - onsetTime(take, previous)) <= Math.abs(at - onsetTime(take, next)))
    ? previous : next;
}

function performanceExtras(take, group, index, pitches) {
  for (const pitch of pitches) {
    const result = recordExtra(take, group, pitch.midi, pitch.at, index);
    const previous = take.wrongBySlot.get(index);
    const target = Number.isFinite(take.downbeat) ? onsetTime(take, group) : pitch.at;
    if (index !== undefined && (!previous || take.following === 'wait'
      || Math.abs(pitch.at - target) < Math.abs(previous.at - target))) take.wrongBySlot.set(index, result);
    take.revision += 1;
  }
}

function unmatchedStatus(take, index, tones, observedPitches) {
  const heard = take.wrongBySlot.get(index);
  if (tones.length === 1 && heard) return { status: 'wrong', heardMidi: heard.midi, at: heard.at };
  const { observed, issue, signalSeen, uncertainty } = take.inputHealth;
  if (issue || (observed && !signalSeen) || (observedPitches < 2 && uncertainty.get(index)?.ambiguous)) {
    return { status: 'unassessable' };
  }
  return { status: 'missed' };
}

function commitGroup(take, index, heardPitches, { advance = true } = {}) {
  const group = take.notes[index];
  const tones = tonesOf(group);
  const accepted = tones.map(({ midi }) => heardPitches.get(midi));
  const onsets = accepted.filter(Boolean).map(({ at }) => at);
  const at = onsets.length ? Math.min(...onsets) : null;
  if (at !== null && take.bpm && !Number.isFinite(take.downbeat)) {
    take.downbeat = at - (group.beat - take.startBeat) * 60_000 / take.bpm;
  }
  const target = take.bpm && Number.isFinite(take.downbeat) ? onsetTime(take, group) : null;
  const tolerance = target === null ? null : timingTolerance(take.bpm);
  const missing = unmatchedStatus(take, index, tones, heardPitches.size);
  accepted.forEach((pitch, ordinal) => {
    if (!pitch) {
      const result = setToneResult(take, index, ordinal, missing);
      if (missing.status === 'missed' || missing.status === 'wrong') take.missed.push(result.note);
      return;
    }
    const delta = target === null ? null : pitch.at - target;
    const allowance = Math.min(take.strumAllowanceMs, pitch.at - at);
    const gradedDelta = delta === null || delta <= 0 ? delta : Math.max(0, delta - allowance);
    const status = gradedDelta !== null && Math.abs(gradedDelta) > tolerance ? 'timing' : 'correct';
    const result = setToneResult(take, index, ordinal, {
      status, at: pitch.at, delta, gradedDelta, chordOnsetMs: at,
      heardMidi: pitch.midi, confidence: pitch.confidence, frequencyHz: pitch.frequencyHz, cents: pitch.cents,
    });
    take.matched.push(result);
  });
  if (advance) take.cursor = index + 1;
  if (at === null) return { type: missing.status, note: group, index };
  const delta = target === null ? null : at - target;
  const match = { note: group, index, at, delta };
  take.groupMatches.push(match);
  if (!take.following) updateTempoEstimate(take, group, at);
  return { type: 'matched', ...match };
}

function closeChord(take) {
  const { index, heard } = take.chord;
  take.chord = null;
  const group = take.notes[index];
  const expected = new Set(tonesOf(group).map(({ midi }) => midi));
  const extras = [...heard.values()].filter(({ midi }) => !expected.has(midi));
  performanceExtras(take, group, index, extras);
  const count = [...expected].filter((midi) => heard.has(midi)).length;
  if (take.following === 'wait' && count < expected.size) {
    if (!take.waitBest || take.waitBest.count < count) take.waitBest = { index, count, heard };
    take.revision += 1;
    return { type: 'pending', note: group, index };
  }
  take.waitBest = null;
  return commitGroup(take, index, heard);
}

function advanceSlots(take, at, complete = false) {
  if (take.chord && (complete || at >= take.chord.deadline)) closeChord(take);
  if (take.following !== 'continuous') return;
  while (take.cursor < take.endIndex && (complete || at >= slotDeadline(take, take.cursor))) {
    commitGroup(take, take.cursor, new Map());
  }
}

function drainAttacks(take, through) {
  if (!take.attackQueue.length) return;
  take.attackQueue.sort((a, b) => a.at - b.at);
  let index = 0;
  while (index < take.attackQueue.length && take.attackQueue[index].at <= through) {
    const { at, pitches } = take.attackQueue[index];
    index += 1;
    // Several voices can report the same sample frame in separate messages.
    // Treat those as simultaneous evidence before moving the score cursor.
    while (take.attackQueue[index]?.at === at) {
      pitches.push(...take.attackQueue[index].pitches);
      index += 1;
    }
    acceptOrderedAttack(take, at, pitches);
  }
  take.attackQueue.splice(0, index);
}

/** Advance timed score slots after the caller has allowed for audio delivery latency. */
export function advancePerformance(take, at, { complete = false, finish = false } = {}) {
  take.assessPerformance = true;
  const before = take.revision;
  const previousCursor = take.cursor;
  if (take.closed) return { changed: false, previousCursor, cursor: previousCursor };
  if (take.reorderAttacks) {
    if (Number.isFinite(at)) take.watermark = Math.max(take.watermark, at);
    drainAttacks(take, finish || complete ? Infinity : take.watermark);
    at = take.watermark;
  }
  if (finish && take.chord) closeChord(take);
  advanceSlots(take, at, complete);
  if (take.following !== 'continuous' && finish && take.cursor < take.endIndex) {
    if (take.waitBest || take.wrongBySlot.has(take.cursor)) {
      commitGroup(take, take.cursor, take.waitBest?.heard ?? new Map(), { advance: false });
    }
  }
  if (complete) take.finished = true;
  if (finish || complete) take.closed = true;
  return { changed: before !== take.revision, previousCursor, cursor: take.cursor };
}

/**
 * Assign observed pitch attacks to score slots. A set of distinct acoustic
 * pitches may cover several written heads, including unisons across voices.
 */
export function acceptPerformance(take, event) {
  take.assessPerformance = true;
  const at = event.onsetMs ?? event.at;
  const pitches = (event.pitches ?? [{ midi: event.midi }])
    .filter(({ midi, ambiguous }) => Number.isInteger(midi) && midi >= 0 && midi <= 127 && !ambiguous)
    .map((pitch) => ({ ...pitch, at: pitch.onsetMs ?? pitch.at ?? at }))
    .filter((pitch) => Number.isFinite(pitch.at));
  if (!pitches.length || take.finished || take.closed || !Number.isFinite(at)
    || (take.bpm && Number.isFinite(take.downbeat) && at < take.downbeat - 140)
    || (take.following === 'continuous' && !(at < continuousEndTime(take)))) return { type: 'ignored' };
  take.inputHealth.signalSeen = true;
  if (take.reorderAttacks) {
    if (at <= take.watermark || take.attackQueue.length >= MAX_QUEUED_ATTACKS) {
      take.inputHealth.issue ??= 'Microphone audio arrived too late to assess reliably.';
      return { type: 'ignored' };
    }
    take.attackQueue.push({ at, pitches });
    return { type: 'pending' };
  }
  return acceptOrderedAttack(take, at, pitches);
}

function acceptOrderedAttack(take, at, pitches) {
  const heard = new Map(pitches.map((pitch) => [pitch.midi, pitch]));
  advanceSlots(take, at);
  if (take.chord) {
    for (const pitch of heard.values()) {
      if (!take.chord.heard.has(pitch.midi)) take.chord.heard.set(pitch.midi, pitch);
    }
    return { type: 'pending', note: take.notes[take.chord.index], index: take.chord.index };
  }

  const { notes, cursor, endIndex, following } = take;
  if (following === 'continuous' && !inSlot(take, cursor, at)) {
    const note = closestSlot(take, at);
    if (!note) return { type: 'ignored' };
    performanceExtras(take, note, undefined, heard.values());
    return { type: 'extra', note };
  }
  if (cursor >= endIndex) return { type: 'ignored' };
  const hasMatch = (index) => tonesOf(notes[index]).some(({ midi }) => heard.has(midi));
  let index = cursor;
  if (!hasMatch(index) && !following) {
    for (let next = index + 1; next <= Math.min(cursor + 2, endIndex - 1); next += 1) {
      if (hasMatch(next) && lookaheadInTime(take, notes[next], at)) {
        while (take.cursor < next) commitGroup(take, take.cursor, new Map());
        index = next;
        break;
      }
    }
  }
  const group = notes[index];
  if (!hasMatch(index)) {
    performanceExtras(take, group, index, heard.values());
    // Wait mode can show a wrong-pitch attempt immediately and recover on a retry.
    if (following === 'wait' && tonesOf(group).length === 1) {
      const heard = take.wrongBySlot.get(index);
      setToneResult(take, index, 0, { status: 'wrong', heardMidi: heard.midi, at: heard.at });
    }
    return { type: 'extra', note: group, index, midi: pitches[0].midi };
  }
  const expected = new Set(tonesOf(group).map(({ midi }) => midi));
  if (expected.size === 1) {
    performanceExtras(take, group, index, [...heard.values()].filter(({ midi }) => !expected.has(midi)));
    return commitGroup(take, index, heard);
  }
  const deadline = following === 'continuous' ? slotDeadline(take, index) : Infinity;
  take.chord = { index, heard, deadline: Math.min(at + take.groupWindowMs, deadline) };
  return { type: 'pending', note: group, index };
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
  if (take.assessPerformance) return summarizePerformance(take);
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
  return addTimingGrades(summary, { matched, bpm, following, graded: attempted, pitchRatio });
}

function addTimingGrades(summary, { matched, groupMatches = matched, bpm, following, graded, pitchRatio }) {
  const tolerance = timingTolerance(bpm);
  let onTime = 0;
  let timingCredit = 0;
  for (const { delta, gradedDelta } of matched) {
    const distance = Math.abs(gradedDelta ?? delta);
    if (distance <= tolerance) onTime += 1;
    timingCredit += Math.max(0, 1 - distance / (2 * tolerance));
  }
  // Missed notes earn no timing credit and still count in the attempted passage.
  const beatRatio = timingCredit / graded;
  let rhythmRatio = beatRatio;
  if (following) {
    const intervals = matchedIntervals(groupMatches, bpm);
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

function captureIssue(take) {
  const { observed, signalSeen, issue } = take.inputHealth;
  if (issue) return issue;
  return observed && !signalSeen ? 'No microphone signal was confirmed during this take.' : null;
}

/** All selected written noteheads, in performed score order, plus per-bar evidence. */
export function reviewTake(take) {
  const results = [];
  const bars = new Map();
  let chords = 0;
  let completeChords = 0;
  let expectedChordTones = 0;
  let matchedChordTones = 0;
  const barFor = (measure) => {
    if (!bars.has(measure)) {
      bars.set(measure, { measure, expected: 0, correct: 0, onTime: 0, early: 0, late: 0,
        wrong: 0, missed: 0, extra: 0, unassessed: 0, unattempted: 0 });
    }
    return bars.get(measure);
  };
  const hasCaptureIssue = captureIssue(take);
  for (let index = take.startIndex; index < take.endIndex; index += 1) {
    const tones = tonesOf(take.notes[index]);
    let matched = 0;
    tones.forEach((note, ordinal) => {
      const key = toneKey(index, note, ordinal);
      const stored = take.results.get(key);
      const result = stored ?? { key, note, index, status: 'unattempted' };
      const { status, delta } = result;
      const bar = barFor(note.measure);
      results.push(result);
      bar.expected += 1;
      if (status === 'correct' || status === 'timing') {
        matched += 1;
        bar.correct += 1;
        if (status === 'timing') bar[delta < 0 ? 'early' : 'late'] += 1;
        else if (Number.isFinite(delta)) bar.onTime += 1;
      } else if (status === 'unassessable') bar.unassessed += 1;
      else bar[status] += 1;
    });
    if (new Set(tones.map(({ midi }) => midi)).size > 1) {
      chords += 1;
      completeChords += Number(matched === tones.length);
      expectedChordTones += tones.length;
      matchedChordTones += matched;
    }
  }
  for (const extra of take.extras) barFor(extra.note?.measure).extra += 1;
  const perBar = [...bars.values()].map((bar) => ({
    ...bar, mistakes: bar.early + bar.late + bar.wrong + bar.missed + bar.extra,
  }));
  const largestTimingErrors = results.filter(({ delta }) => Number.isFinite(delta))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5);
  return {
    results, bars: perBar, largestTimingErrors, captureIssue: hasCaptureIssue,
    chords: { total: chords, complete: completeChords, expectedTones: expectedChordTones,
      matchedTones: matchedChordTones },
  };
}

function summarizePerformance(take) {
  const { matched, extras, downbeat, bpm, following } = take;
  const report = reviewTake(take);
  const count = (field) => report.bars.reduce((sum, bar) => sum + bar[field], 0);
  const expected = count('expected');
  const attempted = expected - count('unattempted');
  const unassessed = count('unassessed');
  const graded = attempted - unassessed;
  const unassessable = Boolean(report.captureIssue || (unassessed > 0 && !graded));
  const pitchOpportunities = graded + (following ? extras.length : 0);
  const pitchRatio = !unassessable && pitchOpportunities ? matched.length / pitchOpportunities : null;
  const enoughTiming = !unassessable && Number.isFinite(bpm) && bpm > 0 && Number.isFinite(downbeat)
    && (following ? graded > 0 : matched.length >= MIN_TIMED_MATCHES);
  const summary = {
    ...report, attempted, expected, graded, unassessed, unassessable,
    correct: matched.length, early: count('early'), late: count('late'), onTime: count('onTime'),
    wrong: count('wrong'), missed: count('missed'), extra: extras.length,
    pitch: pitchRatio === null ? null : Math.round(pitchRatio * 100),
    timing: null, rhythm: null, overall: null, enoughTiming,
    beatTiming: null, spacing: null, intervals: [],
  };
  if (!enoughTiming) return summary;
  return addTimingGrades(summary, { matched, groupMatches: take.groupMatches, bpm, following, graded, pitchRatio });
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

export function completedTakeSummary(take, { pitch, timing, rhythm, overall, beatTiming, spacing, unassessable, unassessed, missed }) {
  if (unassessable || unassessed || take.cursor !== take.endIndex
    || (take.following === 'continuous' && !take.finished)) return null;
  return {
    startBar: take.startBar, endBar: finalBar(take), startIndex: take.startIndex,
    endIndex: take.endIndex, startBeat: take.startBeat, bpm: take.bpm, following: take.following,
    pitch, timing, rhythm, overall, beatTiming, spacing, missed: missed ?? take.missed.length,
  };
}

export function samePracticePassage(a, b) {
  return a.startBar === b.startBar && a.endBar === b.endBar
    && a.startIndex === b.startIndex && a.endIndex === b.endIndex
    && a.startBeat === b.startBeat && a.bpm === b.bpm && a.following === b.following;
}
