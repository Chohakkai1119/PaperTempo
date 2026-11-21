const defaults = {
  polyphonic: true,
  releaseMs: 48,
  groupingMs: 65,
  strumAllowanceMs: 0,
  stabilityMs: 25,
  reattackRatio: 1.9,
  minFrequencyHz: 48,
  maxFrequencyHz: 3000,
  candidateConfidence: 0.88,
  tuningA4Hz: 440,
  partialToleranceCents: 32,
};

const profile = (id, label, parameters = {}) => Object.freeze({ ...defaults, id, label, ...parameters });

// Initial engineering settings. Wider sung/written pitches still pass when supported
// by the signal. Use the score's sounding pitches to widen the preferred range.
export const INPUT_PROFILES = Object.freeze({
  general: profile('general', 'Other / General'),
  piano: profile('piano', 'Piano', {
    minFrequencyHz: 27, maxFrequencyHz: 4250, groupingMs: 65, stabilityMs: 24, polyphonicStabilityMs: 48,
    reattackRatio: 1.7, partialToleranceCents: 36,
  }),
  guitar: profile('guitar', 'Nylon-string guitar', {
    minFrequencyHz: 72, maxFrequencyHz: 1450, groupingMs: 135, strumAllowanceMs: 85, stabilityMs: 24, polyphonicStabilityMs: 36,
    reattackRatio: 1.7, partialToleranceCents: 30,
  }),
  'steel-guitar': profile('steel-guitar', 'Steel-string guitar', {
    minFrequencyHz: 72, maxFrequencyHz: 1450, groupingMs: 140, strumAllowanceMs: 90, stabilityMs: 26, polyphonicStabilityMs: 36,
    reattackRatio: 1.85, partialToleranceCents: 34,
  }),
  flute: profile('flute', 'Flute', {
    polyphonic: false, minFrequencyHz: 230, maxFrequencyHz: 2600,
    groupingMs: 30, stabilityMs: 35, reattackRatio: 2.1, candidateConfidence: 0.89,
  }),
  violin: profile('violin', 'Violin', {
    minFrequencyHz: 180, maxFrequencyHz: 3600,
    groupingMs: 50, stabilityMs: 40, reattackRatio: 2.2,
    candidateConfidence: 0.86, partialToleranceCents: 40,
  }),
});

export function midiFrequency(midi, a4 = 440) {
  return a4 * 2 ** ((midi - 69) / 12);
}

export function resolveInputProfile(id, { expectedMidis = [], tuningA4Hz = 440, requiresPolyphony = false, preferMonophonic = false } = {}) {
  const base = Object.hasOwn(INPUT_PROFILES, id) ? INPUT_PROFILES[id] : INPUT_PROFILES.general;
  const a4 = Number(tuningA4Hz);
  const tuning = Number.isFinite(a4) && a4 >= 415 && a4 <= 466 ? a4 : base.tuningA4Hz;
  let minFrequencyHz = base.minFrequencyHz;
  let maxFrequencyHz = base.maxFrequencyHz;
  for (const midi of expectedMidis) {
    if (!Number.isFinite(midi)) continue;
    minFrequencyHz = Math.min(minFrequencyHz, midiFrequency(midi - 2, tuning));
    maxFrequencyHz = Math.max(maxFrequencyHz, midiFrequency(midi + 2, tuning));
  }
  const polyphonic = requiresPolyphony || (base.polyphonic && !preferMonophonic);
  return Object.freeze({
    ...base, minFrequencyHz, maxFrequencyHz, tuningA4Hz: tuning,
    polyphonic, stabilityMs: polyphonic ? base.polyphonicStabilityMs ?? base.stabilityMs : base.stabilityMs,
  });
}
