import { INSTRUMENTS } from './instruments.mjs';

const START_LEAD_SECONDS = 0.04;
const LOOKAHEAD_SECONDS = 0.25;
const SCHEDULE_INTERVAL_MS = 25;
const PLAYBACK_GAIN = 0.65;

export class InstrumentSampleError extends Error {}

async function fetchSample(context, file) {
  const response = await fetch(file);
  if (!response.ok) throw new Error(`Audio sample returned ${response.status}.`);
  return context.decodeAudioData(await response.arrayBuffer());
}

function passageNotes(events, startBeat, endBeat, bpm, samples) {
  const secondsPerBeat = 60 / bpm;
  const notes = [];
  const cursors = [];
  for (const event of events) {
    let cursorStart = Infinity;
    let cursorEnd = -Infinity;
    for (const note of event.pitches ?? [event]) {
      if (!Number.isFinite(note.beat) || !Number.isFinite(note.duration) || note.duration <= 0
        || !Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127) continue;
      const start = (Math.max(note.beat, startBeat) - startBeat) * secondsPerBeat;
      const end = (Math.min(note.beat + note.duration, endBeat) - startBeat) * secondsPerBeat;
      if (end <= start) continue;
      const sample = samples.reduce((nearest, candidate) => (
        Math.abs(candidate.midi - note.midi) < Math.abs(nearest.midi - note.midi) ? candidate : nearest
      ));
      notes.push({ note, sample, onset: (note.beat - startBeat) * secondsPerBeat, start, end });
      cursorStart = Math.min(cursorStart, start);
      cursorEnd = Math.max(cursorEnd, end);
    }
    if (cursorEnd > cursorStart) cursors.push({ note: event, start: cursorStart, end: cursorEnd });
  }
  notes.sort((a, b) => a.start - b.start);
  cursors.sort((a, b) => a.start - b.start || a.note.beat - b.note.beat);
  return { notes, cursors };
}

function passageGain(notes) {
  const edges = notes.flatMap(({ start, end }) => [[start, 1], [end, -1]]);
  edges.sort(([timeA, changeA], [timeB, changeB]) => timeA - timeB || changeA - changeB);
  let playing = 0;
  let maximum = 1;
  for (const [, change] of edges) {
    playing += change;
    maximum = Math.max(maximum, playing);
  }
  return PLAYBACK_GAIN / maximum;
}

function audioContext() {
  if (!globalThis.AudioContext) throw new Error('Score playback needs a browser with Web Audio support.');
  return new AudioContext();
}

export function createPlayback({
  onNote,
  onEnd,
  createContext = audioContext,
  loadSample = fetchSample,
  requestFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (id) => cancelAnimationFrame(id),
  scheduleInterval = (callback, delay) => setInterval(callback, delay),
  cancelInterval = (id) => clearInterval(id),
}) {
  let context;
  let passage = null;
  let revision = 0;
  let highlighted = null;
  let scheduler = null;
  let frame = null;
  const voices = new Set();
  const samples = new Map();

  function highlight(note) {
    if (note === highlighted) return;
    highlighted = note;
    onNote(note);
  }

  function clearScheduledAudio() {
    if (scheduler !== null) cancelInterval(scheduler);
    if (frame !== null) cancelFrame(frame);
    scheduler = null;
    frame = null;
    for (const { source, gain } of voices) {
      source.onended = null;
      source.disconnect();
      gain.disconnect();
      source.stop();
    }
    voices.clear();
  }

  function stop() {
    revision += 1;
    passage = null;
    clearScheduledAudio();
    highlight(null);
  }

  function sampleBuffer(file) {
    if (!samples.has(file)) {
      const pending = Promise.resolve().then(() => loadSample(context, file)).catch((cause) => {
        samples.delete(file);
        throw new InstrumentSampleError('Could not load the instrument audio. Try again.', { cause });
      });
      samples.set(file, pending);
    }
    return samples.get(file);
  }

  function sound(event, buffer, start, end, elapsed, level) {
    const { note, sample } = event;
    const rate = 2 ** ((note.midi - sample.midi) / 12);
    const loop = sample.loop;
    let offset = elapsed * rate;
    if (loop && offset >= loop[1]) {
      offset = loop[0] + (offset - loop[0]) % (loop[1] - loop[0]);
    }
    if (offset >= buffer.duration) return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    if (loop) {
      source.loop = true;
      [source.loopStart, source.loopEnd] = loop;
    }
    const soundEnd = loop ? end : Math.min(end, start + (buffer.duration - offset) / rate);
    const duration = soundEnd - start;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + Math.min(0.004, duration * 0.2));
    gain.gain.setValueAtTime(level, soundEnd - Math.min(0.035, duration * 0.35));
    gain.gain.linearRampToValueAtTime(0, soundEnd);
    source.connect(gain).connect(context.destination);
    const voice = { source, gain };
    voices.add(voice);
    source.onended = () => {
      voices.delete(voice);
      source.disconnect();
      gain.disconnect();
    };
    source.start(start, offset);
    source.stop(soundEnd);
  }

  async function start(current) {
    const token = ++revision;
    current.phase = 'starting';
    let buffers;
    try {
      context ??= createContext();
      await context.resume();
      if (token !== revision) return false;
      const files = new Set(current.notes.map(({ sample }) => sample.file));
      buffers = new Map(await Promise.all([...files].map(async (file) => [file, await sampleBuffer(file)])));
    } catch (error) {
      if (token !== revision) return false;
      stop();
      throw error;
    }
    if (token !== revision) return false;
    current.phase = 'playing';
    const audibleStart = context.currentTime + START_LEAD_SECONDS;
    current.anchor = audibleStart - current.position;
    const first = current.notes.findIndex(({ end }) => end > current.position);
    let nextSound = first < 0 ? current.notes.length : first;
    let cursor = -1;

    function scheduleSounds() {
      if (token !== revision) return;
      const now = context.currentTime;
      if (now >= current.anchor + current.duration) {
        stop();
        onEnd();
        return;
      }
      const horizon = now + LOOKAHEAD_SECONDS;
      while (nextSound < current.notes.length && current.anchor + current.notes[nextSound].start <= horizon) {
        const event = current.notes[nextSound++];
        const scheduledStart = Math.max(audibleStart, current.anchor + event.start, now);
        const scheduledEnd = current.anchor + event.end;
        if (scheduledEnd > scheduledStart) {
          const elapsed = Math.max(0, scheduledStart - (current.anchor + event.onset));
          sound(event, buffers.get(event.sample.file), scheduledStart, scheduledEnd, elapsed, current.gain);
        }
      }
    }

    function showCursor() {
      if (token !== revision) return;
      const position = context.currentTime - current.anchor;
      while (current.cursors[cursor + 1]?.start <= position) cursor += 1;
      const event = current.cursors[cursor];
      highlight(event && position < event.end ? event.note : null);
      if (token === revision) frame = requestFrame(showCursor);
    }

    scheduleSounds();
    scheduler = scheduleInterval(scheduleSounds, SCHEDULE_INTERVAL_MS);
    frame = requestFrame(showCursor);
    return true;
  }

  function play(events, { startBeat, endBeat, bpm, instrument = 'piano' }) {
    stop();
    if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || endBeat <= startBeat
      || !Number.isFinite(bpm) || bpm <= 0) return Promise.resolve(false);
    const profile = Object.hasOwn(INSTRUMENTS, instrument) ? INSTRUMENTS[instrument] : INSTRUMENTS.piano;
    const { notes, cursors } = passageNotes(events, startBeat, endBeat, bpm, profile.samples);
    if (!notes.length) return Promise.resolve(false);
    passage = { notes, cursors, gain: passageGain(notes), duration: (endBeat - startBeat) * 60 / bpm, position: 0 };
    return start(passage);
  }

  function pause() {
    if (!passage || passage.phase === 'paused') return false;
    if (passage.phase === 'playing') {
      passage.position = Math.min(passage.duration, Math.max(passage.position, context.currentTime - passage.anchor));
    }
    revision += 1;
    passage.phase = 'paused';
    clearScheduledAudio();
    return true;
  }

  function resume() {
    return passage?.phase === 'paused' ? start(passage) : Promise.resolve(false);
  }

  return { play, pause, resume, stop };
}
