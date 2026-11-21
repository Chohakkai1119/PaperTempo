import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createInputAnalysis, INPUT_BLOCK_MS } from '../dist/audio-input.mjs';
import { midiFrequency, resolveInputProfile } from '../dist/input-profiles.mjs';
import { createPitchAnalyzer } from '../dist/pitch-analysis.mjs';
import { createAudioFixture, fixtureDefinitions } from './audio-fixtures.mjs';

const BASELINE = '086f974';
const fixtureDir = process.argv.find((arg) => arg.startsWith('--export='))?.slice('--export='.length);
const external = process.argv.find((arg) => arg.startsWith('--external='))?.slice('--external='.length);
const publishedModel = external ? JSON.parse(readFileSync(external, 'utf8')) : {};
const pyinFile = process.argv.find((arg) => arg.startsWith('--pyin='))?.slice('--pyin='.length);
const pyin = pyinFile ? JSON.parse(readFileSync(pyinFile, 'utf8')) : {};
const baselineSource = execFileSync('git', ['show', `${BASELINE}:dist/audio.mjs`], { cwd: new URL('..', import.meta.url) });
const baseline = await import(`data:text/javascript;base64,${baselineSource.toString('base64')}`);
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
const round = (value) => value == null ? null : Number(value.toFixed(3));

function scoreNotes(expected, detected, tolerance = Infinity) {
  const remaining = new Set(expected);
  const errorsMs = [];
  const senses = { correct: 0, falsePositives: 0, missed: 0, wrongOctave: 0, errorsMs };
  for (const estimate of detected) {
    const sorted = [...remaining].filter((note) => Math.abs(note.onset - estimate.onset) <= tolerance)
      .sort((a, b) => Math.abs(a.onset - estimate.onset) - Math.abs(b.onset - estimate.onset));
    const match = sorted.find((note) => note.midi === estimate.midi);
    if (match) {
      senses.correct += 1;
      errorsMs.push(Math.abs(match.onset - estimate.onset));
      remaining.delete(match);
    } else {
      senses.falsePositives += 1;
      senses.wrongOctave += Number(sorted.some((note) => (note.midi - estimate.midi) % 12 === 0));
    }
  }
  senses.missed = remaining.size;
  return senses;
}

function report(results) {
  const totals = { correct: 0, falsePositives: 0, missed: 0, wrongOctave: 0, errorsMs: [] };
  for (const result of results) {
    for (const key of ['correct', 'falsePositives', 'missed', 'wrongOctave']) totals[key] += result[key];
    totals.errorsMs.push(...result.errorsMs);
  }
  const { correct, missed, falsePositives, wrongOctave, errorsMs } = totals;
  return {
    correct, missed, falsePositives, wrongOctave,
    precision: round(correct / (correct + falsePositives) || 0),
    recall: round(correct / (correct + missed) || 0),
    f1: round(2 * correct / (2 * correct + missed + falsePositives) || 0),
    medianAbsMs: round(percentile(errorsMs, 0.5)), p95AbsMs: round(percentile(errorsMs, 0.95)),
  };
}

function baselineEvents(samples, sampleRate) {
  const events = [];
  const computeMs = [];
  const hop = Math.round(sampleRate * 0.013);
  const offset = 1000 * Math.min(1550, sampleRate * 0.032) / sampleRate;
  const track = baseline.createOnsetTracker(({ midi, at }) => events.push({ midi, onset: at }));
  for (let end = 4096; end <= samples.length; end += hop) {
    const start = performance.now();
    const frame = samples.subarray(end - 4096, end);
    const level = baseline.signalLevel(frame.subarray(3072));
    track(baseline.measurePitch(frame, sampleRate, level), level, end * 1000 / sampleRate - offset);
    computeMs.push(performance.now() - start);
  }
  return { events, computeMs };
}

function liveEvents(samples, sampleRate, profile) {
  const computeMs = [];
  const feedbackMs = [];
  const events = [];
  let framesPassed = 0;
  let signalFrames = 0;
  let droppedBlocks = 0;
  const analysis = createInputAnalysis({
    sampleRate, profile,
    onSignal(signal) {
      if (signal.signal) signalFrames += 1;
      if (signal.dropped) droppedBlocks += 1;
    },
    onNote(event) {
      for (const { midi } of event.pitches) {
        events.push({ midi, onset: event.frame * 1000 / sampleRate });
        feedbackMs.push((framesPassed - event.frame) * 1000 / sampleRate);
      }
    },
  });
  const hop = Math.round(sampleRate * INPUT_BLOCK_MS / 1000);
  for (let i = 0; i < samples.length; i += hop) {
    const start = performance.now();
    framesPassed = Math.min(samples.length, i + hop);
    analysis.push(samples.subarray(i, i + hop), i);
    computeMs.push(performance.now() - start);
  }
  return { events, signalFrames, computeMs, feedbackMs, droppedBlocks };
}

function comparisons(samples, sampleRate, profile, notes, pyinFrames) {
  const analyzer = createPitchAnalyzer(sampleRate, profile);
  const results = { baseline: [], cmndf: [], mpm: [], integrated: [], pyin: [] };
  // Stable reference labels are available between these offsets from the written sample attack.
  for (let time = 180; time < samples.length * 1000 / sampleRate; time += 24) {
    const expected = notes.filter(({ onset, duration }) => time >= onset + 110 && time <= onset + duration - 28);
    if (!expected.length && notes.length) continue;
    const end = Math.round(sampleRate * time / 1000);
    const frame = samples.subarray(end - 8192, end);
    const legacy = baseline.measurePitch(frame.subarray(4096), sampleRate, baseline.signalLevel(frame.subarray(7168)));
    const measurements = { baseline: legacy ? [legacy] : [] };
    for (const method of ['cmndf', 'mpm']) {
      measurements[method] = analyzer.analyze(frame, { method, polyphonic: false }).pitches;
    }
    measurements.integrated = analyzer.analyze(frame).pitches;
    if (pyinFrames) {
      const match = pyinFrames.find(({ at }) => Math.abs(time - at) <= 12);
      measurements.pyin = match ? [match] : [];
    }
    for (const [algorithm, detected] of Object.entries(measurements)) {
      results[algorithm].push({
        ...scoreNotes(expected.map(({ midi }) => ({ midi, onset: 0 })), detected.map(({ midi }) => ({ midi, onset: 0 }))),
        cents: detected.filter(({ midi, frequencyHz }) => frequencyHz && expected.some((note) => note.midi === midi))
          .map(({ midi, frequencyHz }) => 1200 * Math.abs(Math.log2(frequencyHz / midiFrequency(midi)))),
      });
    }
  }
  return results;
}

if (fixtureDir) mkdirSync(fixtureDir, { recursive: true });
const cases = [];
for (const fixture of fixtureDefinitions) {
  const { samples, sampleRate, notes } = createAudioFixture(fixture);
  const chord = notes.some((note, index) => index && note.onset < notes[index - 1].onset + notes[index - 1].duration);
  const profile = resolveInputProfile(fixture.profile ?? fixture.instrument, {
    expectedMidis: notes.map(({ midi }) => midi), requiresPolyphony: chord, preferMonophonic: !chord,
  });
  const legacy = baselineEvents(samples, sampleRate);
  const { events, signalFrames, computeMs, feedbackMs, droppedBlocks } = liveEvents(samples, sampleRate, profile);
  const frames = comparisons(samples, sampleRate, profile, notes, pyin[fixture.name]?.frames);
  if (fixtureDir) writeFileSync(`${fixtureDir}/${fixture.name}.f32`, samples);
  cases.push({
    name: fixture.name, sampleRate, count: samples.length, notes, signalFrames, computeMs, feedbackMs, frames, droppedBlocks,
    baseline: legacy.events, baselineComputeMs: legacy.computeMs, integrated: events, model: publishedModel[fixture.name]?.notes,
    chord,
  });
}
if (fixtureDir) {
  const metadata = cases.map(({ name, sampleRate, count, notes, chord }) => ({ name, sampleRate, count, notes, chord }));
  writeFileSync(`${fixtureDir}/fixtures.json`, JSON.stringify(metadata));
}

for (const type of ['monophonic', 'polyphonic']) {
  const group = cases.filter((item) => item.chord === (type === 'polyphonic'));
  console.log(`${type} frames`);
  for (const method of ['baseline', 'cmndf', 'mpm', 'integrated', ...(pyinFile && type === 'monophonic' ? ['pyin'] : [])]) {
    const results = group.flatMap(({ frames }) => frames[method]);
    const { medianAbsMs, p95AbsMs, ...scores } = report(results);
    console.log(method, { ...scores, medianAbsCents: round(percentile(results.flatMap(({ cents }) => cents), 0.5)) });
  }
  console.log(`${type} event matches within ±50 ms`);
  for (const method of ['baseline', 'integrated', ...(external ? ['model'] : [])]) {
    console.log(method, report(group.map((item) => scoreNotes(item.notes, item[method] ?? [], 50))));
  }
  console.log(`${type} event matches within ±160 ms (diagnostic)`);
  for (const method of ['baseline', 'integrated', ...(external ? ['model'] : [])]) {
    console.log(method, report(group.map((item) => scoreNotes(item.notes, item[method] ?? [], 160))));
  }
}
const compute = cases.flatMap(({ computeMs }) => computeMs);
const legacyCompute = cases.flatMap(({ baselineComputeMs }) => baselineComputeMs);
const feedback = cases.flatMap(({ feedbackMs }) => feedbackMs);
console.log('PCM processor timing (ms)', {
  baselineComputeMedian: round(percentile(legacyCompute, 0.5)), baselineComputeP95: round(percentile(legacyCompute, 0.95)),
  computeMedian: round(percentile(compute, 0.5)), computeP95: round(percentile(compute, 0.95)),
  droppedBlocks: cases.reduce((total, item) => total + item.droppedBlocks, 0),
  eventToEmissionMedian: round(percentile(feedback, 0.5)), eventToEmissionP95: round(percentile(feedback, 0.95)),
});
const eventDetails = process.argv.includes('--events');
const displayNotes = (notes) => notes.map(({ midi, onset }) => eventDetails ? `${midi}@${Math.round(onset)}` : midi).join(',');
console.table(cases.map(({ name, notes, baseline: legacy, integrated, signalFrames }) => ({
  name, signalFrames,
  expected: displayNotes(notes), baseline: displayNotes(legacy), integrated: displayNotes(integrated),
})));
