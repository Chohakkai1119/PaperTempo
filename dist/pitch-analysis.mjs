import { resolveInputProfile } from './input-profiles.mjs';

const MIN_HZ = 24;
const MAX_HZ = 4600;
const MAX_PARTIALS = 24;
const MAX_PEAKS = 60;
const MAX_PITCHES = 6;
const EPSILON = 1e-12;

function interpolatePeak(left, center, right) {
  const curvature = 2 * (left + right - 2 * center);
  return curvature ? Math.max(-0.5, Math.min(0.5, (left - right) / curvature)) : 0;
}

function pitch(frequencyHz, confidence, profile) {
  const exactMidi = 69 + 12 * Math.log2(frequencyHz / profile.tuningA4Hz);
  const midi = Math.round(exactMidi);
  return { midi, frequencyHz, cents: 100 * (exactMidi - midi), confidence };
}

function preferred(frequencyHz, profile) {
  return frequencyHz >= profile.minFrequencyHz && frequencyHz <= profile.maxFrequencyHz;
}

function createPeriodicity(sampleRate) {
  const averaging = Math.max(1, Math.floor(sampleRate / 12000));
  const rate = sampleRate / averaging;
  const lagLimit = Math.ceil(rate / MIN_HZ) + 1;
  const work = new Float32Array(Math.ceil(rate * 0.155));
  const values = new Float32Array(lagLimit + 1);

  return (samples, profile, method) => {
    const length = Math.min(work.length, Math.floor(samples.length / averaging));
    const start = samples.length - length * averaging;
    // Box average before decimation, retaining enough bandwidth for high notes.
    let mean = 0;
    for (let i = 0; i < length; i += 1) {
      let total = 0;
      for (let j = 0; j < averaging; j += 1) total += samples[start + i * averaging + j];
      work[i] = total / averaging;
      mean += work[i];
    }
    mean /= length;
    for (let i = 0; i < length; i += 1) work[i] -= mean;
    const minLag = Math.max(2, Math.floor(rate / Math.min(MAX_HZ, sampleRate * 0.45)));
    const maxLag = Math.min(lagLimit, Math.floor(length / 2));
    const window = Math.min(Math.ceil(rate * 0.033), length - maxLag);
    if (maxLag <= minLag || window < rate * 0.01) return null;

    // CMNDF uses a fixed comparison window and includes every lag in its running
    // mean. NSDF normalizes the cross-correlation by both lagged signal energies.
    const offset = length - window - maxLag;
    let cumulative = 0;
    values[0] = method === 'mpm' ? 1 : 0;
    for (let lag = 1; lag <= maxLag; lag += 1) {
      let difference = 0;
      let energy = 0;
      for (let i = offset; i < offset + window; i += 1) {
        const current = work[i];
        const shifted = work[i + lag];
        const delta = current - shifted;
        difference += delta * delta;
        energy += current * current + shifted * shifted;
      }
      cumulative += difference;
      values[lag] = method === 'mpm' ? 1 - difference / Math.max(EPSILON, energy)
        : 1 - difference * lag / Math.max(EPSILON, cumulative);
    }
    if (cumulative < EPSILON) return null;

    let best = null;
    let maximum = 0;
    const peaks = [];
    // MPM ignores the initial positive lobe at lag zero. Both methods use local
    // maxima of a high-is-good periodicity function and refine between samples.
    let nonpositive = method !== 'mpm';
    for (let lag = 1; lag < maxLag; lag += 1) {
      const value = values[lag];
      if (value <= 0) nonpositive = true;
      if (!nonpositive || lag < minLag || value <= values[lag - 1] || value < values[lag + 1]) continue;
      const frequency = rate / (lag + interpolatePeak(values[lag - 1], value, values[lag + 1]));
      const threshold = profile.candidateConfidence + (preferred(frequency, profile) ? 0 : 0.045);
      if (frequency < MIN_HZ || frequency > MAX_HZ || value < threshold) continue;
      if (method === 'cmndf') {
        best = { frequencyHz: frequency, confidence: value };
        break;
      }
      if (value > maximum) maximum = value;
      peaks.push({ frequencyHz: frequency, confidence: value });
    }
    if (method === 'mpm') best = peaks.find(({ confidence }) => confidence >= maximum * 0.93);
    return best ? pitch(best.frequencyHz, best.confidence, profile) : null;
  };
}

function createSpectrum(length, sampleRate) {
  const fftSize = 2 ** Math.ceil(Math.log2(length * 2));
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const reverse = new Uint32Array(fftSize);
  const cosines = new Float64Array(fftSize / 2);
  const sines = new Float64Array(fftSize / 2);
  const window = new Float64Array(length);
  const binHz = sampleRate / fftSize;
  const lastBin = Math.floor(Math.min(sampleRate * 0.48, MAX_HZ * 3) / binHz);
  const magnitude = new Float64Array(lastBin + 1);
  let windowSum = 0;
  for (let i = 0; i < length; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (length - 1));
    windowSum += window[i];
  }
  for (let i = 1; i < fftSize; i += 1) reverse[i] = (reverse[i >> 1] >> 1) + ((i & 1) * (fftSize >> 1));
  for (let i = 0; i < fftSize / 2; i += 1) {
    cosines[i] = Math.cos(-2 * Math.PI * i / fftSize);
    sines[i] = Math.sin(-2 * Math.PI * i / fftSize);
  }

  return (samples, noiseFloor) => {
    const offset = samples.length - length;
    let mean = 0;
    for (let i = 0; i < length; i += 1) mean += samples[offset + i];
    mean /= length;
    real.fill(0);
    imaginary.fill(0);
    for (let i = 0; i < length; i += 1) real[reverse[i]] = (samples[offset + i] - mean) * window[i];

    for (let span = 2; span <= fftSize; span *= 2) {
      const half = span >> 1;
      const step = fftSize / span;
      for (let base = 0; base < fftSize; base += span) {
        for (let column = 0; column < half; column += 1) {
          const a = base + column;
          const b = a + half;
          const rotation = step * column;
          const re = real[b] * cosines[rotation] - imaginary[b] * sines[rotation];
          const im = real[b] * sines[rotation] + imaginary[b] * cosines[rotation];
          real[b] = real[a] - re;
          imaginary[b] = imaginary[a] - im;
          real[a] += re;
          imaginary[a] += im;
        }
      }
    }

    let total = 0;
    let acousticPeak = 0;
    const first = Math.max(2, Math.floor(MIN_HZ / binHz));
    for (let i = first; i <= lastBin; i += 1) {
      const value = Math.sqrt(real[i] ** 2 + imaginary[i] ** 2) / windowSum;
      magnitude[i] = value;
      total += value;
      acousticPeak = Math.max(acousticPeak, value);
    }
    // Broadband energy raises the evidence threshold independently of absolute
    // gain. The observed broadband microphone floor also limits narrow spikes.
    const broadband = total / (lastBin - first + 1);
    const floor = Math.max(EPSILON, broadband * 7, noiseFloor * 0.38, acousticPeak * 0.021);
    const peaks = [];
    const shoulder = Math.ceil(fftSize / length * 2);
    for (let i = first; i < lastBin - shoulder; i += 1) {
      const amplitude = magnitude[i];
      const left = magnitude[i - 1];
      const right = magnitude[i + 1];
      if (amplitude < floor || amplitude <= left || amplitude < right) continue;
      const delta = interpolatePeak(Math.log(left + EPSILON), Math.log(amplitude), Math.log(right + EPSILON));
      const frequencyHz = (i + delta) * binHz;
      if (frequencyHz < MIN_HZ) continue;
      const shoulderLevel = (magnitude[Math.max(first, i - shoulder)] + magnitude[i + shoulder]) / 2;
      const prominence = amplitude / Math.max(shoulderLevel, floor / 8);
      peaks.push({ frequencyHz, amplitude, prominence, unexplained: true });
    }
    peaks.sort((a, b) => b.amplitude - a.amplitude);
    peaks.length = Math.min(peaks.length, MAX_PEAKS);
    return { peaks, floor, acousticPeak, binHz };
  };
}

function matchingPartials(frequencyHz, peaks, binHz, tolerance) {
  const partials = [];
  const fractionalTolerance = 2 ** (tolerance / 1200) - 1;
  for (const peak of peaks) {
    const order = Math.round(peak.frequencyHz / frequencyHz);
    if (order < 1 || order > MAX_PARTIALS) continue;
    const target = order * frequencyHz;
    const distance = Math.abs(peak.frequencyHz - target);
    if (distance > Math.max(binHz * 0.75, Math.min(target * fractionalTolerance, frequencyHz * 0.22))) continue;
    const current = partials[order - 1];
    if (!current || distance < Math.abs(current.frequencyHz - target)) partials[order - 1] = peak;
  }
  return partials;
}

function spectralPitches({ peaks, floor, acousticPeak, binHz }, profile, periodic) {
  // Treat measured peaks as fundamental hypotheses. Add a subharmonic only
  // when the independent periodicity detector finds corroborating evidence.
  const hypotheses = peaks.filter(({ frequencyHz }) => frequencyHz <= MAX_HZ)
    .map((peak) => ({ ...peak, partials: matchingPartials(peak.frequencyHz, peaks, binHz, profile.partialToleranceCents) }));
  if (periodic) {
    const partials = matchingPartials(periodic.frequencyHz, peaks, binHz, profile.partialToleranceCents);
    const fundamental = partials[0];
    hypotheses.push({
      frequencyHz: periodic.frequencyHz, amplitude: fundamental?.amplitude ?? 0,
      prominence: fundamental?.prominence ?? 0, partials,
    });
  }

  const heard = [];
  for (let i = 0; i < MAX_PITCHES; i += 1) {
    let best = null;
    let bestScore = 0;
    for (const hypothesis of hypotheses) {
      const { frequencyHz, amplitude, partials, prominence } = hypothesis;
      const support = preferred(frequencyHz, profile) ? 1 : 1.6;
      const fundamental = partials[0]?.unexplained;
      const second = partials[1]?.unexplained;
      const third = partials[2]?.unexplained;
      const direct = fundamental ? amplitude : 0;
      const periodicMatch = periodic && Math.abs(frequencyHz / periodic.frequencyHz - 1) < 0.025;
      const fifthOrSeventh = partials[4]?.unexplained || partials[6]?.unexplained;
      const missing = periodicMatch && !amplitude && second && third && fifthOrSeventh;
      if (heard.some((note) => Math.abs(Math.log2(frequencyHz / note.frequencyHz)) < 1 / 18)) continue;
      const tonal = Math.abs(pitch(frequencyHz, 0, profile).cents) <= 43;
      if (!missing && (direct < Math.max(floor * 1.4, acousticPeak * 0.115) * support
        || prominence < (periodicMatch ? 1.4 : 3) || (!tonal && !periodicMatch))) continue;
      if (frequencyHz < 55 && !periodicMatch && !(second && third && fifthOrSeventh)) continue;
      if (!second && !third && !periodicMatch
        && (direct < Math.max(floor * 3.2, acousticPeak * 0.27) * support || prominence < 6)) continue;
      let harmonicEvidence = 0;
      for (let h = 1; h < partials.length; h += 1) {
        if (!partials[h]?.unexplained) continue;
        harmonicEvidence += partials[h].amplitude / (1 + h * 0.19);
      }
      const score = (direct + harmonicEvidence * 0.72 + (periodicMatch ? acousticPeak * 0.6 : 0)) / support;
      if (score <= bestScore) continue;
      bestScore = score;
      best = hypothesis;
    }
    if (!best) break;
    const confidence = Math.min(0.99, 0.70 + bestScore / Math.max(EPSILON, acousticPeak) * 0.3);
    const estimate = pitch(best.frequencyHz, confidence, profile);
    heard.push({ ...estimate, strength: best.amplitude || best.partials[1]?.amplitude || 0 });
    for (const partial of best.partials) if (partial) partial.unexplained = false;
  }
  return heard.sort((a, b) => a.midi - b.midi);
}

/** Analyze one contiguous PCM window. Confidence describes evidence quality, not
 * a calibrated probability. The profile's score-derived range changes evidence
 * thresholds only. Expected pitches are never supplied as candidate notes. */
export function createPitchAnalyzer(sampleRate, profile = resolveInputProfile('general')) {
  const periodicity = createPeriodicity(sampleRate);
  let spectrum;
  let length;
  return {
    analyze(samples, { noiseFloor = 0, polyphonic = profile.polyphonic, method = 'cmndf' } = {}) {
      const periodic = periodicity(samples, profile, polyphonic ? 'mpm' : method);
      let pitches = periodic ? [periodic] : [];
      if (polyphonic && samples.length >= 256) {
        const available = Math.min(samples.length, Math.ceil(sampleRate * 0.15));
        if (length !== available) {
          length = available;
          spectrum = createSpectrum(length, sampleRate);
        }
        pitches = spectralPitches(spectrum(samples, noiseFloor), profile, periodic);
      }
      return {
        pitches,
        reason: pitches.length === 0 ? 'insufficient-pitch-confidence'
          : pitches.length > 1 ? 'multiple-pitches' : 'pitch-detected',
      };
    },
  };
}
