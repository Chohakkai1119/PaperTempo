// Deterministic choice of the bar to practise. This is our decision, not the LLM's.

const EPSILON_MS = 1e-6;

export function meanAbsOffset(offsets) {
  if (!offsets.length) return 0;
  return offsets.reduce((sum, x) => sum + Math.abs(x), 0) / offsets.length;
}

export function meanOffset(offsets) {
  if (!offsets.length) return 0;
  return offsets.reduce((sum, x) => sum + x, 0) / offsets.length;
}

/**
 * Picks the bar with the worst mean absolute timing offset; ties are broken by the
 * most missed notes, then by the earliest bar in the input order.
 * Bars without timing offsets count as a mean offset of 0 ms.
 *
 * @param {{bar, label, missedNotes, timingOffsetsMs:number[]}[]} bars validated bars
 * @returns {null | {bar, label, missedNotes, timingOffsetsMs, meanAbsOffsetMs, meanOffsetMs}}
 */
export function pickTargetBar(bars) {
  let best = null;
  for (const entry of bars) {
    const candidate = {
      ...entry,
      label: entry.label ?? String(entry.bar),
      meanAbsOffsetMs: meanAbsOffset(entry.timingOffsetsMs),
      meanOffsetMs: meanOffset(entry.timingOffsetsMs),
    };
    if (!best) {
      best = candidate;
      continue;
    }
    const diff = candidate.meanAbsOffsetMs - best.meanAbsOffsetMs;
    if (diff > EPSILON_MS || (Math.abs(diff) <= EPSILON_MS && candidate.missedNotes > best.missedNotes)) {
      best = candidate;
    }
  }
  return best;
}
