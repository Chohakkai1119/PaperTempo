// Validation and normalisation for practice-result payloads sent by the browser.
// Only small numeric summaries are accepted — never audio.
//
// Real takes are messy (late starts, bars without timing, odd bar labels), so this
// normalises wherever it safely can. It only rejects genuinely malformed requests:
// not an object, no bars, or values of the wrong type.

export const LIMITS = Object.freeze({
  maxBodyBytes: 64 * 1024, // abuse guard; a real take is a few hundred bytes
  maxPieceLength: 120, // longer names are truncated
  maxBars: 1000, // abuse guard
  maxBarLabelLength: 16, // longer labels are truncated
  maxOffsetsPerBar: 256, // extra values are ignored
});

/** Offsets beyond ±this are a late start (player came in long after the count-in), not a timing error. */
export const LATE_START_MS = 2000;
export const DEFAULT_PIECE = 'Untitled score';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(error) {
  return { ok: false, error };
}

// Printable text only; the piece name and bar labels end up in an LLM prompt.
function cleanText(value, max) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

const missing = (value) => value === undefined || value === null;

/**
 * Validates and normalises a POST /api/drill body:
 *   { piece?: string, bars: [{ bar: string|number, missedNotes?: number, timingOffsetsMs?: number[] }] }
 *
 * Returns { ok: true, value: { piece, bars } } where each bar is
 *   { bar, label, missedNotes, timingOffsetsMs (within ±2000 ms), lateStarts }
 * or { ok: false, error } for malformed input.
 */
export function validateDrillRequest(input) {
  if (!isPlainObject(input)) return fail('The request body must be a JSON object.');

  let piece = DEFAULT_PIECE;
  if (!missing(input.piece)) {
    if (typeof input.piece !== 'string') return fail('"piece" must be a string.');
    piece = cleanText(input.piece, LIMITS.maxPieceLength) || DEFAULT_PIECE;
  }

  const { bars } = input;
  if (!Array.isArray(bars)) return fail('"bars" must be an array.');
  if (bars.length === 0) return fail('"bars" must contain at least one bar.');
  if (bars.length > LIMITS.maxBars) return fail(`"bars" can contain at most ${LIMITS.maxBars} entries.`);

  const byLabel = new Map();
  for (const [i, entry] of bars.entries()) {
    const where = `bars[${i}]`;
    if (!isPlainObject(entry)) return fail(`${where} must be an object.`);

    const { bar } = entry;
    if (!(typeof bar === 'string' || (typeof bar === 'number' && Number.isFinite(bar)))) {
      return fail(`${where}.bar must be a bar number or label.`);
    }
    const label = cleanText(bar, LIMITS.maxBarLabelLength);
    if (!label) return fail(`${where}.bar must not be empty.`);

    let missedNotes = 0;
    if (!missing(entry.missedNotes)) {
      if (typeof entry.missedNotes !== 'number' || !Number.isFinite(entry.missedNotes)) {
        return fail(`${where}.missedNotes must be a number.`);
      }
      missedNotes = Math.max(0, Math.round(entry.missedNotes));
    }

    const timingOffsetsMs = [];
    let lateStarts = 0;
    if (!missing(entry.timingOffsetsMs)) {
      if (!Array.isArray(entry.timingOffsetsMs)) return fail(`${where}.timingOffsetsMs must be an array of numbers.`);
      for (const offset of entry.timingOffsetsMs.slice(0, LIMITS.maxOffsetsPerBar)) {
        if (typeof offset !== 'number' || !Number.isFinite(offset)) {
          return fail(`${where}.timingOffsetsMs must contain only numbers.`);
        }
        if (Math.abs(offset) > LATE_START_MS) lateStarts += 1; // clamped: counted, not a timing error
        else timingOffsetsMs.push(offset);
      }
    }

    // Some scores reuse bar numbers; merge rather than reject.
    const existing = byLabel.get(label);
    if (existing) {
      existing.missedNotes += missedNotes;
      existing.timingOffsetsMs.push(...timingOffsetsMs);
      existing.lateStarts += lateStarts;
    } else {
      byLabel.set(label, { bar, label, missedNotes, timingOffsetsMs, lateStarts });
    }
  }

  return { ok: true, value: { piece, bars: [...byLabel.values()] } };
}
