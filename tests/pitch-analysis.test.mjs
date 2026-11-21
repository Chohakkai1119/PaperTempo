import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputAnalysis, INPUT_BLOCK_MS } from '../dist/audio-input.mjs';
import { INPUT_PROFILES, midiFrequency, resolveInputProfile } from '../dist/input-profiles.mjs';
import { createPitchAnalyzer } from '../dist/pitch-analysis.mjs';
import { createAudioFixture, fixtureDefinitions } from '../scripts/audio-fixtures.mjs';

test('input profiles affect analysis and use score pitches only as range guidance', () => {
  const violin = resolveInputProfile('violin', { expectedMidis: [40], tuningA4Hz: 442, preferMonophonic: true });
  assert.ok(violin.minFrequencyHz < midiFrequency(40, 442));
  assert.equal(violin.polyphonic, false);
  assert.equal(violin.tuningA4Hz, 442);
  assert.equal(resolveInputProfile('flute', { requiresPolyphony: true }).polyphonic, true);
  assert.equal(resolveInputProfile('unknown', { tuningA4Hz: 100 }).tuningA4Hz, 440);
  assert.ok(INPUT_PROFILES.guitar.groupingMs > INPUT_PROFILES.piano.groupingMs);
});

function toneFrame(sampleRate, notes, { amplitude = 0.05, a4 = 440, ratios = [1] } = {}) {
  return Float32Array.from({ length: Math.round(sampleRate * 0.15) }, (_, i) =>
    notes.reduce((sum, midi) => sum + ratios.reduce((mix, weight, index) =>
      mix + weight * amplitude * Math.sin(2 * Math.PI * midiFrequency(midi, a4) * (index + 1) * i / sampleRate),
    0), 0));
}

test('periodicity estimates quiet tones and cents at browser sample rates', () => {
  for (const rate of [16000, 44100, 48000, 96000]) {
    const profile = resolveInputProfile('general', { tuningA4Hz: 442, preferMonophonic: true });
    const detector = createPitchAnalyzer(rate, profile);
    const data = toneFrame(rate, [60], { amplitude: 0.002, a4: 446, ratios: [1, 0.36, 0.28] });
    const [pitch] = detector.analyze(data).pitches;
    assert.equal(pitch.midi, 60);
    assert.ok(Math.abs(pitch.frequencyHz - midiFrequency(60, 446)) < 0.5);
    assert.ok(Math.abs(pitch.cents - 1200 * Math.log2(446 / 442)) < 4);
  }
});

test('spectral analysis roots pitches in the audio and suppresses common partials', () => {
  const sampleRate = 48000;
  const profile = resolveInputProfile('piano', { expectedMidis: [60, 64, 67] });
  const detector = createPitchAnalyzer(sampleRate, profile);
  for (const midi of [[60, 64, 67], [60, 64, 69], [60, 67], [60]]) {
    const data = toneFrame(sampleRate, midi, { ratios: [1, 0.65, 0.35, 0.2] });
    assert.deepEqual(detector.analyze(data).pitches.map((p) => p.midi), midi);
  }
});

const recordedChords = ['piano-C-major', 'piano-C-minor', 'piano-substituted-tone', 'piano-missing-tone'];

test('recorded-note mixtures retain major, minor, substituted and missing chord tones', () => {
  for (const name of recordedChords) {
    const fixture = fixtureDefinitions.find((item) => item.name === name);
    const { samples, sampleRate, notes } = createAudioFixture(fixture);
    const end = Math.round((notes[0].onset + 210) * sampleRate / 1000);
    const detector = createPitchAnalyzer(sampleRate, resolveInputProfile('piano'));
    const frame = samples.subarray(end - 8192, end);
    assert.deepEqual(detector.analyze(frame).pitches.map((p) => p.midi), notes.map(({ midi }) => midi), name);
  }
});

test('FFT and periodicity leave seeded broadband noise and digital silence without a pitch', () => {
  for (const name of ['digital-silence', 'background-noise']) {
    const { samples, sampleRate } = createAudioFixture(fixtureDefinitions.find((fixture) => fixture.name === name));
    const detector = createPitchAnalyzer(sampleRate);
    const pcm = samples.subarray(8192, 16384);
    assert.equal(detector.analyze(pcm, { polyphonic: false }).pitches.length, 0);
    assert.equal(detector.analyze(pcm).pitches.length, 0);
  }
});

test('live PCM processing emits the right pitches and groups recorded piano attacks', () => {
  for (const name of recordedChords) {
    const fixture = fixtureDefinitions.find((item) => item.name === name);
    const { samples, sampleRate, notes } = createAudioFixture(fixture);
    const events = [];
    const profile = resolveInputProfile('piano');
    const analysis = createInputAnalysis({
      sampleRate, profile, onSignal() {},
      onNote: (event) => events.push(event),
    });
    const hop = Math.round(sampleRate * INPUT_BLOCK_MS / 1000);
    for (let i = 0; i < samples.length; i += hop) analysis.push(samples.subarray(i, i + hop), i);
    const pitches = events.map(({ midi }) => midi).sort((a, b) => a - b);
    assert.deepEqual(pitches, notes.map(({ midi }) => midi), name);
    for (const { frame } of events) {
      assert.ok(Math.abs(frame * 1000 / sampleRate - notes[0].onset) <= 50, name);
    }
    const frames = events.map(({ frame }) => frame);
    assert.ok((Math.max(...frames) - Math.min(...frames)) * 1000 / sampleRate < profile.groupingMs, name);
  }
});
