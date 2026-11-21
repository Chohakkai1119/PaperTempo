import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

// Optional comparator. Install these exact dependencies into a temporary prefix:
// npm install --prefix /tmp/papertempo-model @spotify/basic-pitch@1.0.1 @tensorflow/tfjs@3.21.0 esbuild@0.25.12 playwright-core@1.59.1
const [prefix, data, executablePath, output] = process.argv.slice(2);
if (!output) throw new Error('Pass npm prefix, exported fixture directory, Chromium executable, and output JSON path.');
const require = createRequire(join(resolve(prefix), 'package.json'));
const { build } = require('esbuild');
const { chromium } = require('playwright-core');
const modelDir = join(resolve(prefix), 'node_modules/@spotify/basic-pitch/model');
const tmp = mkdtempSync(join(tmpdir(), 'papertempo-model-'));
let browser;

try {
  const path = join(tmp, 'benchmark.js');
  const result = await build({
    bundle: true, minify: true, outfile: path,
    stdin: {
      resolveDir: resolve(prefix),
      contents: `
import * as tf from '@tensorflow/tfjs';
import { BasicPitch, outputToNotesPoly, noteFramesToTime } from '@spotify/basic-pitch';

window.run = async () => {
  await tf.ready();
  const metadata = await fetch('/fixtures.json').then((res) => res.json());
  const loadStart = performance.now();
  const model = new BasicPitch('/model.json');
  const graph = await model.model;
  const loadMs = performance.now() - loadStart;
  const results = { metadata: { backend: tf.getBackend(), loadMs, browser: navigator.userAgent } };

  for (const fixture of metadata) {
    const source = new Float32Array(await fetch('/' + fixture.name + '.f32').then((res) => res.arrayBuffer()));
    const offline = new OfflineAudioContext(1, Math.ceil(source.length * 22050 / fixture.sampleRate), 22050);
    const buffer = offline.createBuffer(1, source.length, fixture.sampleRate);
    buffer.copyToChannel(source, 0);
    const input = offline.createBufferSource();
    input.buffer = buffer;
    input.connect(offline.destination);
    input.start();
    const resampled = (await offline.startRendering()).getChannelData(0);
    const start = performance.now();
    const frames = [], onsets = [];
    let peakTensorBytes = tf.memory().numBytes;
    await model.evaluateModel(resampled, (f, o) => {
      frames.push(...f);
      onsets.push(...o);
      peakTensorBytes = Math.max(peakTensorBytes, tf.memory().numBytes);
    }, () => {});
    const notes = noteFramesToTime(outputToNotesPoly(frames, onsets, 0.25, 0.25, 5));
    results[fixture.name] = {
      notes: notes.map((n) => ({ midi: n.pitchMidi, onset: n.startTimeSeconds * 1000 }))
        .sort((a, b) => a.onset - b.onset),
      elapsedMs: performance.now() - start, clipMs: source.length * 1000 / fixture.sampleRate,
      peakTensorBytes,
    };
  }
  graph.dispose();
  return results;
};`,
    },
  });
  if (result.errors.length) throw new Error('Failed to bundle Basic Pitch');
  const assets = { 'model.json': join(modelDir, 'model.json'), 'group1-shard1of1.bin': join(modelDir, 'group1-shard1of1.bin'), 'benchmark.js': path };
  browser = await chromium.launch({ executablePath, args: ['--enable-webgl', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.route('http://localhost/**', async (route) => {
    const name = basename(new URL(route.request().url()).pathname);
    if (!name) {
      await route.fulfill({ contentType: 'text/html', body: '<script src="/benchmark.js"></script>' });
      return;
    }
    const path = assets[name] ?? join(data, name);
    try {
      await route.fulfill({ path, contentType: name.endsWith('.json') ? 'application/json'
        : name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    } catch {
      await route.fulfill({ status: 404 });
    }
  });
  await page.goto('http://localhost/');
  await page.waitForFunction(() => typeof window.run === 'function');
  const measurements = await page.evaluate(() => window.run());
  measurements.metadata.modelBytes = statSync(assets['model.json']).size + statSync(assets['group1-shard1of1.bin']).size;
  measurements.metadata.bundleBytes = statSync(path).size;
  writeFileSync(output, JSON.stringify(measurements));
  console.log(measurements.metadata);
  console.table(Object.entries(measurements).filter(([name]) => name !== 'metadata')
    .map(([name, { elapsedMs, clipMs, peakTensorBytes }]) => ({ name, elapsedMs, clipMs, peakTensorBytes })));
} finally {
  await browser?.close();
  rmSync(tmp, { recursive: true, force: true });
}
