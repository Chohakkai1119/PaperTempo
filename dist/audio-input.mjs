import { createPitchAnalyzer } from './pitch-analysis.mjs';

export const INPUT_BLOCK_MS = 12;
const MIN_RMS = 0.00015;

function levels(samples) {
  let sum = 0;
  let squares = 0;
  let peak = 0;
  for (const sample of samples) {
    sum += sample;
    squares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return { rms: Math.sqrt(Math.max(0, squares / samples.length - (sum / samples.length) ** 2)), peak };
}

// A long spectrum is useful for resolving fundamentals, but its center
// often lags the attack of an individual chord tone. Recheck the discovered
// frequency and its first partials in shorter windows around the attack.
function spectralAttack(samples, sampleRate, frequencyHz) {
  const length = Math.round(sampleRate * Math.min(0.05, Math.max(0.012, 5 / frequencyHz)));
  const hop = Math.round(sampleRate * 0.006);
  const lookback = Math.min(samples.length, Math.round(sampleRate * 0.156));
  const first = samples.length - lookback;
  const envelope = new Float64Array(Math.floor((lookback - length) / hop) + 1);
  const stride = frequencyHz * 3 < sampleRate * 0.2 ? 2 : 1;
  let maximum = 0;
  for (let partial = 1; partial <= 3 && frequencyHz * partial < sampleRate * 0.48; partial += 1) {
    const step = 2 * Math.PI * partial * frequencyHz / sampleRate;
    const weightsReal = new Float64Array(length);
    const weightsImag = new Float64Array(length);
    for (let index = 0; index < length; index += stride) {
      const taper = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / length);
      weightsReal[index] = Math.cos(step * index) * taper;
      weightsImag[index] = Math.sin(step * index) * taper;
    }
    for (let window = 0; window < envelope.length; window += 1) {
      const start = first + window * hop;
      let real = 0;
      let imaginary = 0;
      for (let index = 0; index < length; index += stride) {
        const sample = samples[start + index];
        real += sample * weightsReal[index];
        imaginary += sample * weightsImag[index];
      }
      envelope[window] += Math.hypot(real, imaginary) / partial;
      maximum = Math.max(maximum, envelope[window]);
    }
  }
  const crossing = envelope.findIndex((value) => value >= maximum * 0.25);
  // No onset was located when support is already present at the beginning.
  return maximum > 0 && crossing > 0 ? first + crossing * hop + length * 0.4 - samples.length : null;
}

export function createInputAnalysis({ sampleRate, profile, onSignal, onNote }) {
  const analyzer = createPitchAnalyzer(sampleRate, profile);
  const historySeconds = profile.polyphonic ? 0.15 : profile.minFrequencyHz < 48 ? 0.12 : 0.07;
  const length = 2 ** Math.ceil(Math.log2(sampleRate * historySeconds));
  const history = new Float32Array(Math.max(length, Math.ceil(sampleRate * 0.225)));
  const pitches = new Map();
  const frames = (ms) => sampleRate * ms / 1000;
  let lastEnd = null;
  let noiseFloor = MIN_RMS / 4;
  let signalStart = null;
  let quietSince = null;
  let previousLevel = 0;
  let recentRise = -Infinity;
  let lastAttack = -Infinity;

  function reset() {
    history.fill(0);
    pitches.clear();
    lastEnd = null;
    signalStart = null;
    quietSince = null;
    previousLevel = 0;
    recentRise = -Infinity;
    lastAttack = -Infinity;
  }

  function push(samples, firstSampleFrame) {
    if (!samples.length) return;
    const dropped = lastEnd !== null && firstSampleFrame !== lastEnd;
    if (dropped) reset();
    const frame = firstSampleFrame + samples.length;
    lastEnd = frame;
    const tail = samples.subarray(Math.max(0, samples.length - history.length));
    history.copyWithin(0, tail.length);
    history.set(tail, history.length - tail.length);
    const { rms, peak } = levels(samples);
    const signal = rms > 0.00001;
    const gate = Math.max(MIN_RMS, 2.7 * noiseFloor);
    const rising = rms >= gate && rms >= Math.max(MIN_RMS, previousLevel * 1.35);
    if (rising && firstSampleFrame - recentRise >= frames(35)) recentRise = firstSampleFrame;
    previousLevel = rms;
    if (rms >= gate) {
      signalStart ??= firstSampleFrame;
      quietSince = null;
    } else {
      quietSince ??= firstSampleFrame;
      if (frame - quietSince >= frames(35)) signalStart = null;
    }

    // Short analysis windows respond to legato changes sooner. Longer windows
    // resolve low notes and overlapping fundamentals.
    const stability = profile.stabilityMs;
    const analysisLength = profile.polyphonic ? length : Math.min(length,
      Math.max(Math.round(sampleRate * 0.036), Math.ceil(3.1 * sampleRate / profile.minFrequencyHz)));
    const aboveGate = rms >= gate || (signalStart !== null && rms >= gate * 0.65);
    const detected = aboveGate && frame - signalStart >= frames(18)
      ? analyzer.analyze(history.subarray(history.length - analysisLength), { noiseFloor })
      : { pitches: [], reason: aboveGate ? 'building-window' : 'quiet' };
    // Follow changing ambient noise slowly, without learning a sustained musical
    // note as background. Downward changes adapt faster.
    if (!detected.pitches.length) {
      const target = Math.max(MIN_RMS / 4, rms);
      const step = target < noiseFloor ? 0.08 : 0.006;
      noiseFloor += step * (target - noiseFloor);
    }

    const seen = new Set();
    const attacks = [];
    for (const pitch of detected.pitches) {
      const { midi } = pitch;
      if (seen.has(midi)) continue;
      seen.add(midi);
      const strength = pitch.strength ?? rms;
      let voice = pitches.get(midi);
      if (!voice) {
        // Reuse a recent energy rise only when a note has not already claimed it.
        // For a legato change the centre of the supporting window is the best
        // estimate available when there is no distinct amplitude transient.
        const lookback = frames(profile.polyphonic ? 85 : 45);
        const newPhrase = signalStart !== null && signalStart > lastAttack && frame - signalStart <= frames(144);
        const at = newPhrase ? signalStart : recentRise > lastAttack && frame - recentRise <= lookback
          ? recentRise : Math.max(signalStart ?? 0, frame - analysisLength / (profile.polyphonic ? 4 : 2));
        voice = { since: frame, at, lastSeen: frame, peak: strength, trough: strength,
          rmsPeak: rms, rmsTrough: rms, sounding: false };
        pitches.set(midi, voice);
      }
      voice.lastSeen = frame;
      voice.peak = Math.max(strength, voice.peak * 0.987);
      voice.trough = Math.min(strength, voice.trough * 1.012);
      voice.rmsPeak = Math.max(rms, voice.rmsPeak * 0.987);
      voice.rmsTrough = Math.min(rms, voice.rmsTrough * 1.012);
      const energyResets = !profile.polyphonic
        || (voice.rmsTrough < voice.rmsPeak * 0.45 && rms >= 2.2 * voice.rmsTrough);
      const reattack = voice.sounding && energyResets && frame - voice.at >= frames(75)
        && voice.trough < voice.peak * 0.56 && strength >= voice.trough * profile.reattackRatio
        && rms > gate && frame - recentRise <= frames(45)
        && recentRise - voice.at >= frames(55);
      if (reattack) {
        voice = { since: frame, at: firstSampleFrame, lastSeen: frame, peak: strength, trough: strength,
          rmsPeak: rms, rmsTrough: rms, sounding: false, reattack: true };
        pitches.set(midi, voice);
      }
      if (!voice.sounding && frame - voice.since >= frames(stability)) {
        voice.sounding = true;
        if (profile.polyphonic && !voice.reattack && Number.isFinite(pitch.frequencyHz)) {
          const endFrame = Math.min(frame, voice.since + Math.round(frames(INPUT_BLOCK_MS)));
          const evidence = history.subarray(0, history.length - (frame - endFrame));
          const offset = spectralAttack(evidence, sampleRate, pitch.frequencyHz);
          if (offset !== null) {
            voice.at = Math.max(signalStart ?? 0, Math.round(endFrame + offset));
          }
        }
        // Bound backtracking by the amount of audio held before score assignment.
        voice.at = Math.max(voice.at, Math.round(frame - frames(178)));
        lastAttack = Math.max(lastAttack, voice.at);
        attacks.push({ pitch, frame: voice.at });
      }
    }

    for (const [midi, voice] of pitches) {
      if (!seen.has(midi) && (!voice.sounding || frame - voice.lastSeen >= frames(profile.releaseMs ?? 48)
        || (quietSince !== null && frame - quietSince >= frames(32)))) pitches.delete(midi);
    }
    attacks.sort((a, b) => a.frame - b.frame);
    for (const { pitch, frame: at } of attacks) {
      onNote({ frame: at, midi: pitch.midi, pitches: [pitch], inputLevel: rms, instrument: profile.id });
    }
    const accepted = detected.pitches.some(({ midi }) => pitches.get(midi)?.sounding);
    const acquiring = signalStart !== null && frame - signalStart < frames(profile.polyphonic ? 105 : 65);
    const reason = detected.pitches.length ? (accepted ? 'accepted' : 'waiting-for-onset')
      : acquiring && aboveGate ? 'building-window' : detected.reason;
    onSignal({
      frame, rms, peak, noiseFloor, gate, signal, dropped,
      clipping: peak >= 0.985,
      pitches: detected.pitches, accepted,
      reason,
    });
  }

  return { push, reset };
}
