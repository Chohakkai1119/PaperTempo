const START_LEAD_SECONDS = 0.04;
const LOOKAHEAD_SECONDS = 0.25;
const SCHEDULE_INTERVAL_MS = 25;

function passageNotes(events, startBeat, endBeat, bpm) {
  const secondsPerBeat = 60 / bpm;
  const notes = [];
  for (const note of events) {
    if (!Number.isFinite(note.beat) || !Number.isFinite(note.duration) || note.duration <= 0
      || !Number.isInteger(note.midi) || note.midi < 0 || note.midi > 127) continue;
    const start = Math.max(note.beat, startBeat);
    const end = Math.min(note.beat + note.duration, endBeat);
    if (end > start) {
      notes.push({ note, start: (start - startBeat) * secondsPerBeat, end: (end - startBeat) * secondsPerBeat });
    }
  }
  return notes.sort((a, b) => a.start - b.start);
}

function audioContext() {
  if (!globalThis.AudioContext) throw new Error('Score playback needs a browser with Web Audio support.');
  return new AudioContext();
}

export function createPlayback({
  onNote,
  onEnd,
  createContext = audioContext,
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
    for (const { oscillator, gain } of voices) {
      oscillator.onended = null;
      oscillator.disconnect();
      gain.disconnect();
      oscillator.stop();
    }
    voices.clear();
  }

  function stop() {
    revision += 1;
    passage = null;
    clearScheduledAudio();
    highlight(null);
  }

  function sound(note, start, end) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const duration = end - start;
    oscillator.type = 'triangle';
    oscillator.frequency.value = 440 * 2 ** ((note.midi - 69) / 12);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.14, start + Math.min(0.009, duration * 0.2));
    gain.gain.linearRampToValueAtTime(0.075, end - Math.min(0.045, duration * 0.35));
    gain.gain.linearRampToValueAtTime(0, end);
    oscillator.connect(gain).connect(context.destination);
    const voice = { oscillator, gain };
    voices.add(voice);
    oscillator.onended = () => {
      voices.delete(voice);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(start);
    oscillator.stop(end);
  }

  async function start(current) {
    const token = ++revision;
    current.phase = 'starting';
    try {
      context ??= createContext();
      await context.resume();
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
    let nextCursor = nextSound;

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
        const { note, start, end } = current.notes[nextSound++];
        const scheduledStart = Math.max(audibleStart, current.anchor + start, now);
        const scheduledEnd = current.anchor + end;
        if (scheduledEnd > scheduledStart) sound(note, scheduledStart, scheduledEnd);
      }
    }

    function showCursor() {
      if (token !== revision) return;
      const position = context.currentTime - current.anchor;
      while (nextCursor < current.notes.length && current.notes[nextCursor].end <= position) nextCursor += 1;
      const event = current.notes[nextCursor];
      highlight(event && event.start <= position ? event.note : null);
      if (token === revision) frame = requestFrame(showCursor);
    }

    scheduleSounds();
    scheduler = scheduleInterval(scheduleSounds, SCHEDULE_INTERVAL_MS);
    frame = requestFrame(showCursor);
    return true;
  }

  function play(events, { startBeat, endBeat, bpm }) {
    stop();
    if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || endBeat <= startBeat
      || !Number.isFinite(bpm) || bpm <= 0) return Promise.resolve(false);
    const notes = passageNotes(events, startBeat, endBeat, bpm);
    if (!notes.length) return Promise.resolve(false);
    passage = { notes, duration: (endBeat - startBeat) * 60 / bpm, position: 0 };
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
