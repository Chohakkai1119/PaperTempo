import { readFileSync } from 'node:fs';
import { midiFrequency } from '../dist/input-profiles.mjs';

// The bundled, edited mono recordings are reused as input, independently of
// the detector. See dist/assets/instruments/CREDITS.txt for per-file provenance.
export function readPcm16MonoWav(path) {
  const data = readFileSync(path);
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Expected a RIFF WAV file');
  }
  let sampleRate;
  for (let chunk = 12; chunk + 8 <= data.length;) {
    const id = data.toString('ascii', chunk, chunk + 4);
    const size = data.readUInt32LE(chunk + 4);
    const start = chunk + 8;
    if (id === 'fmt ') {
      if (data.readUInt16LE(start) !== 1 || data.readUInt16LE(start + 2) !== 1 || data.readUInt16LE(start + 14) !== 16) {
        throw new Error('Expected mono 16-bit PCM');
      }
      sampleRate = data.readUInt32LE(start + 4);
    }
    if (id === 'data' && sampleRate) {
      const samples = new Float32Array(Math.floor(size / 2));
      for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(start + 2 * i) / 32768;
      return { sampleRate, samples };
    }
    chunk = start + size + size % 2;
  }
  throw new Error('WAV audio data missing');
}

const recordings = new Map();
const recordingsLocation = new URL('../dist/assets/instruments/', import.meta.url);

function noteWave(instrument, { midi, duration, velocity, root = midi }, sampleRate) {
  const output = new Float32Array(Math.round(sampleRate * duration / 1000));
  let asset;
  if (instrument !== 'sine') {
    const path = new URL(`${instrument}/${root}.wav`, recordingsLocation);
    if (!recordings.has(path.href)) recordings.set(path.href, readPcm16MonoWav(path));
    asset = recordings.get(path.href);
  }
  for (let i = 0; i < output.length; i += 1) {
    const release = Math.min(1, (output.length - i) / (sampleRate * 0.012));
    if (!asset) {
      const attack = Math.min(1, i / (sampleRate * 0.006));
      output[i] = velocity * attack * release * Math.sin(2 * Math.PI * midiFrequency(midi) * i / sampleRate);
      continue;
    }
    const index = i * asset.sampleRate / sampleRate * 2 ** ((midi - root) / 12);
    const left = Math.floor(index);
    const mix = index - left;
    output[i] = velocity * release * ((asset.samples[left] ?? 0) * (1 - mix) + (asset.samples[left + 1] ?? 0) * mix);
  }
  return output;
}

function noise(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return 2 * (seed / 4294967296) - 1;
  };
}

function imitatePhone(samples, sampleRate) {
  const highPass = Math.exp(-2 * Math.PI * 360 / sampleRate);
  const lowPass = Math.exp(-2 * Math.PI * 3600 / sampleRate);
  let low = 0;
  let high = 0;
  let previous = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const source = samples[i];
    high = highPass * (high + source - previous);
    previous = source;
    low += (1 - lowPass) * (high - low);
    samples[i] = Math.tanh(low * 1.9) * 0.016;
  }
}

function addRoom(samples, sampleRate) {
  const dry = samples.slice();
  for (const [delayMs, gain] of [[11, 0.38], [31, -0.23], [59, 0.16], [96, 0.11]]) {
    const delay = Math.round(delayMs * sampleRate / 1000);
    for (let i = delay; i < samples.length; i += 1) samples[i] += gain * dry[i - delay];
  }
}

export function createAudioFixture({ notes, instrument, sampleRate = 48000, room = false, phone = false, noiseRms = 0.00016, conversationRms = 0 }) {
  const end = Math.max(conversationRms ? 1700 : 400, ...notes.map(({ onset, duration }) => onset + duration));
  const samples = new Float32Array(Math.round((end + 270) * sampleRate / 1000));
  for (const note of notes) {
    const startFrame = Math.round(note.onset * sampleRate / 1000);
    const wave = noteWave(instrument, note, sampleRate);
    for (let i = 0; i < wave.length; i += 1) samples[startFrame + i] += wave[i];
  }
  if (phone) imitatePhone(samples, sampleRate);
  if (room) addRoom(samples, sampleRate);
  if (conversationRms) {
    const chatter = readPcm16MonoWav(new URL('../tests/fixtures/cafe-conversation.wav', import.meta.url));
    const rms = Math.sqrt(chatter.samples.reduce((sum, value) => sum + value ** 2, 0) / chatter.samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const at = i * chatter.sampleRate / sampleRate;
      samples[i] += (chatter.samples[Math.floor(at)] ?? 0) * (conversationRms / rms);
    }
  }
  const nextNoise = noise(1729);
  for (let i = 0; i < samples.length; i += 1) samples[i] += nextNoise() * noiseRms * Math.sqrt(3);
  return { samples, sampleRate, notes };
}

const note = (midi, onset, duration = 450, velocity = 0.28, root = midi) => ({ midi, onset, duration, velocity, root });
const phrase = (midis) => midis.map((midi, index) => note(midi, 260 + index * 540));
const chord = (midis, { step = 0, roots = midis, velocity = 0.32 } = {}) => (
  midis.map((midi, index) => note(midi, 260 + index * step, 520, velocity, roots[index]))
);

export const fixtureDefinitions = [
  { name: 'quiet-phone-C4-simulation', instrument: 'sine', profile: 'general', phone: true, room: true, notes: [note(60, 260, 620)] },
  { name: 'sine-legato-phrase', instrument: 'sine', profile: 'general', notes: [note(60, 260, 220), note(62, 480, 220), note(64, 700, 220)] },
  { name: 'piano-low-middle-high', instrument: 'piano', notes: phrase([36, 60, 96]) },
  { name: 'nylon-low-middle-high', instrument: 'guitar', notes: phrase([40, 59, 79]) },
  { name: 'steel-low-middle-high', instrument: 'steel-guitar', notes: phrase([40, 64, 83]) },
  { name: 'flute-sustains', instrument: 'flute', notes: phrase([60, 72, 93]) },
  { name: 'violin-vibrato', instrument: 'violin', notes: phrase([55, 64, 91]) },
  { name: 'piano-quiet-repeats', instrument: 'piano', notes: [note(60, 260, 220, 0.01), note(60, 550, 145, 0.01), note(60, 750, 380, 0.011)] },
  { name: 'recorded-piano-phone-simulation', instrument: 'piano', phone: true, room: true, notes: [note(60, 260, 600, 0.35)] },
  { name: 'piano-C-major', instrument: 'piano', notes: chord([60, 64, 67], { roots: [60, 64, 55] }) },
  { name: 'piano-C-minor', instrument: 'piano', notes: chord([60, 63, 67], { roots: [60, 64, 55] }) },
  { name: 'piano-substituted-tone', instrument: 'piano', notes: chord([60, 64, 69]) },
  { name: 'piano-missing-tone', instrument: 'piano', notes: chord([60, 67], { roots: [60, 55] }) },
  { name: 'piano-low-octave-pair', instrument: 'piano', notes: chord([36, 48]) },
  { name: 'nylon-G-major-strum', instrument: 'guitar', notes: chord([43, 50, 55, 59, 67], { step: 22, roots: [40, 50, 55, 59, 67] }) },
  { name: 'steel-E-minor-strum', instrument: 'steel-guitar', notes: chord([40, 47, 55, 59, 64], { step: 24, roots: [40, 45, 55, 59, 64] }) },
  { name: 'piano-reverberant-room-and-noise', instrument: 'piano', room: true, noiseRms: 0.003, notes: phrase([36, 64, 72]) },
  { name: 'cafe-conversation', instrument: 'sine', profile: 'general', conversationRms: 0.01, notes: [] },
  { name: 'piano-with-conversation', instrument: 'piano', conversationRms: 0.01, notes: [note(60, 480, 700, 0.20)] },
  { name: 'background-noise', instrument: 'sine', profile: 'general', noiseRms: 0.007, notes: [] },
  { name: 'digital-silence', instrument: 'sine', profile: 'general', noiseRms: 0, notes: [] },
];
