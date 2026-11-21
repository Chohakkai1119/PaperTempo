const FRAME_SIZE = 4096;
const VOLUME_FLOOR = 0.008;

export function signalLevel(samples) {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return Math.sqrt(energy / samples.length);
}

export function measurePitch(samples, sampleRate, level = signalLevel(samples)) {
  if (level < VOLUME_FLOOR) return null;
  const minLag = Math.max(2, Math.floor(sampleRate / 1800));
  const maxLag = Math.min(Math.ceil(sampleRate / 55), samples.length / 2 - 1);
  const window = Math.min(1344, samples.length - maxLag);
  const offset = samples.length - maxLag - window;
  const normalized = new Float32Array(maxLag + 1);
  normalized[0] = 1;
  let total = 0;
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let difference = 0;
    for (let i = offset; i < offset + window; i += 2) {
      const delta = samples[i] - samples[i + lag];
      difference += delta * delta;
    }
    total += difference;
    normalized[lag] = total ? difference * lag / total : 1;
  }
  let best = minLag;
  for (let lag = minLag; lag < maxLag; lag += 1) {
    if (normalized[lag] < normalized[best]) best = lag;
    if (normalized[lag] < 0.14) {
      while (lag < maxLag && normalized[lag + 1] < normalized[lag]) lag += 1;
      best = lag;
      break;
    }
  }
  const confidence = 1 - normalized[best];
  if (confidence < 0.85 || best >= maxLag) return null;
  const before = normalized[best - 1];
  const middle = normalized[best];
  const after = normalized[best + 1];
  const curvature = 2 * (before + after - 2 * middle);
  const period = best + (curvature ? (before - after) / curvature : 0);
  const floatingMidi = 69 + 12 * Math.log2(sampleRate / period / 440);
  const midi = Math.round(floatingMidi);
  if (Math.abs(floatingMidi - midi) > 0.44) return null;
  return { midi, confidence };
}

export function createOnsetTracker(emit) {
  let sounding = null;
  let candidate = null;
  let previousOnset = -Infinity;
  let peak = 0;
  let trough = 0;
  let absentSince = null;

  return (pitch, level, now) => {
    if (!pitch) {
      absentSince ??= now;
      if (now - absentSince > 48 || level < VOLUME_FLOOR * 0.65) {
        sounding = null;
        candidate = null;
        peak = 0;
        trough = 0;
      }
      return;
    }
    absentSince = null;
    const same = pitch.midi === sounding;
    peak = Math.max(level, peak * 0.993);
    trough = trough ? Math.min(level, trough * 1.012) : level;
    const reattack = same && now - previousOnset > 150 && trough < peak * 0.56 && level > trough * 2.4;
    if (same && !reattack && !candidate?.reattack) {
      candidate = null;
      return;
    }
    if (candidate?.midi !== pitch.midi) candidate = { midi: pitch.midi, at: now, count: 0, reattack };
    candidate.count += 1;
    if (candidate.count < 3 || now - previousOnset < 90) return;
    sounding = pitch.midi;
    previousOnset = candidate.at;
    peak = level;
    trough = level;
    emit({ midi: sounding, at: candidate.at });
    candidate = null;
  };
}

export async function openMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) throw new Error('Microphone access needs a supported browser over HTTPS.');
  const context = new AudioContext();
  let stream;
  let source;
  let request;
  let stopped = false;
  try {
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    const analyser = context.createAnalyser();
    analyser.fftSize = FRAME_SIZE;
    source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    const samples = new Float32Array(FRAME_SIZE);
    return {
      context,
      monitor(onSignal, onNote) {
        const detectOnset = createOnsetTracker(onNote);
        let previous = -Infinity;
        function frame(now) {
          if (stopped) return;
          if (now - previous >= 13) {
            previous = now;
            analyser.getFloatTimeDomainData(samples);
            const level = signalLevel(samples.subarray(samples.length - 1024));
            const pitch = measurePitch(samples, context.sampleRate, level);
            onSignal(pitch, level);
            detectOnset(pitch, level, performance.now() - 1000 * Math.min(1550, context.sampleRate * .032) / context.sampleRate);
          }
          request = requestAnimationFrame(frame);
        }
        request = requestAnimationFrame(frame);
      },
      stop() {
        stopped = true;
        cancelAnimationFrame(request);
        source.disconnect();
        for (const track of stream.getTracks()) track.stop();
        void context.close().catch(() => {});
      },
    };
  } catch (error) {
    for (const track of stream?.getTracks() || []) track.stop();
    void context.close().catch(() => {});
    throw error;
  }
}

// Follow (free tempo) mode has no target tempo, so it uses a short fixed count-in.
export const FOLLOW_COUNT_IN = Object.freeze({ beats: 3, bpm: 90 });
const COUNT_IN_LEAD_SECONDS = 0.12;

/**
 * Count-in timing on both clocks: `firstClick` on the AudioContext clock (for scheduling
 * the clicks) and `start` / `downbeat` in performance.now() milliseconds (the clock the
 * note detector timestamps with). The take's timing starts on `downbeat`, the beat
 * straight after the last click.
 */
export function countInTiming({ contextNow, perfNow, bpm, beats = 4, lead = COUNT_IN_LEAD_SECONDS }) {
  const beatMs = 60_000 / bpm;
  const start = perfNow + lead * 1000;
  return { firstClick: contextNow + lead, start, downbeat: start + beats * beatMs, beatMs, beats };
}

/** Number to show during the count-in (beats … 1), or null once the downbeat has arrived. */
export function countdownNumber(countIn, now) {
  if (!countIn || now >= countIn.downbeat) return null;
  const elapsed = Math.max(0, Math.floor((now - countIn.start) / countIn.beatMs));
  return Math.max(1, countIn.beats - elapsed);
}

export function scheduleCountIn(context, bpm, beats = 4) {
  const timing = countInTiming({ contextNow: context.currentTime, perfNow: performance.now(), bpm, beats });
  const beat = 60 / bpm;
  const first = timing.firstClick;
  for (let index = 0; index < beats; index += 1) {
    const time = first + index * beat;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = index === 0 ? 920 : 690;
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(0.1, time + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.055);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(time);
    oscillator.stop(time + 0.06);
  }
  return timing;
}
