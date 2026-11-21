// Optional Playwright check, kept outside the dependency-free Node test suite.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium, firefox, webkit } = require(process.env.PAPERTEMPO_PLAYWRIGHT || 'playwright');
const url = process.env.PAPERTEMPO_TEST_URL || 'http://localhost:3000';
const temp = await mkdtemp(join(tmpdir(), 'papertempo-mic-'));

async function toneFile() {
  const sampleRate = 48000;
  const samples = sampleRate * 5;
  const wave = Buffer.alloc(44 + 2 * samples);
  wave.write('RIFF');
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(samples * 2, 40);
  for (let index = sampleRate / 4; index < samples; index += 1) {
    const value = 0.003 * Math.sin(2 * Math.PI * 261.625565 * index / sampleRate);
    wave.writeInt16LE(Math.round(32767 * value), 44 + 2 * index);
  }
  const filename = join(temp, 'quiet-c4.wav');
  await writeFile(filename, wave);
  return filename;
}

async function diagnostics(page, isFallback) {
  await page.goto(url);
  await page.locator('#microphone-diagnostics summary').click();
  await page.locator('#test-microphone').click();
  await page.waitForFunction(() => Number(document.querySelector('#input-meter').value) > 0.06);
  await page.locator('#capture-pitches').getByText(/C4 · 26[12]\./).waitFor();
  assert.match(await page.locator('#capture-engine').textContent(), isFallback ? /fallback/ : /AudioWorklet/);
  assert.match(await page.locator('#capture-track').textContent(), /active stream · live/);
  assert.equal(await page.locator('#capture-permission').textContent(), 'granted');
  await page.locator('#test-microphone').click();
  assert.equal(await page.locator('#input-meter').inputValue().catch(() => page.locator('#input-meter').getAttribute('value')), '0');
}

async function checkRealCaptureAPI() {
  const filename = await toneFile();
  const browser = await chromium.launch({ args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${filename}`,
  ] });
  try {
    const page = await browser.newPage();
    await diagnostics(page, false);
    console.log(`Chromium ${browser.version()}: file-backed getUserMedia, quiet C4 meter, pitch and stop passed`);
    if (process.env.PAPERTEMPO_BASELINE_URL) {
      await page.goto(process.env.PAPERTEMPO_BASELINE_URL);
      await page.locator('#count-in').uncheck();
      await page.locator('#listen').click();
      await page.locator('#listen').getByText(/Stop listening/).waitFor();
      const detected = await page.evaluate(() => new Promise((resolve) => {
        const output = document.querySelector('#detected-note');
        let heard = output.textContent.trim() !== '—';
        const watch = new MutationObserver(() => { heard ||= output.textContent.trim() !== '—'; });
        watch.observe(output, { childList: true, characterData: true, subtree: true });
        setTimeout(() => { watch.disconnect(); resolve(heard); }, 2200);
      }));
      assert.equal(detected, false);
      console.log('Upstream control: no pitch during 2.2 seconds with identical quiet WAV');
    }
  } finally {
    await browser.close();
  }
}

function installStream({ forceFallback }) {
  if (forceFallback) Object.defineProperty(window, 'AudioWorkletNode', { value: undefined });
  navigator.mediaDevices.getUserMedia = async function () {
    const context = new AudioContext();
    await context.resume();
    const destination = context.createMediaStreamDestination();
    let startedAt;
    window.testInput = {
      tone(frequencies, { level = 0.035, duration = 0.38, gap = 0.035, delay = 0.025 } = {}) {
        startedAt = performance.now() + delay * 1000;
        frequencies.forEach((frequency, index) => {
          const at = context.currentTime + delay + index * gap;
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.frequency.value = frequency;
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(level, at + 0.008);
          gain.gain.setValueAtTime(level, at + duration - 0.012);
          gain.gain.linearRampToValueAtTime(0, at + duration);
          oscillator.connect(gain).connect(destination);
          oscillator.start(at);
          oscillator.stop(at + duration + 0.002);
        });
      },
      disconnect: () => destination.stream.getAudioTracks()[0].stop(),
      latency: () => performance.now() - startedAt,
    };
    return destination.stream;
  };
}

function xmlFor(notes) {
  return `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
    <part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time>
    <clef><sign>G</sign><line>2</line></clef></attributes>${notes.map(([step, chord, duration = 1]) =>
      `<note>${chord ? '<chord/>' : ''}<pitch><step>${step}</step><octave>4</octave></pitch><duration>${duration}</duration><type>${duration === 2 ? 'half' : 'quarter'}</type></note>`).join('')}
    </measure></part></score-partwise>`;
}

async function upload(page, notes) {
  await page.locator('#open-upload').click();
  await page.locator('#score-file').setInputFiles({
    name: 'Fixture.musicxml', mimeType: 'text/xml', buffer: Buffer.from(xmlFor(notes)),
  });
  const expected = notes.map(([step]) => `${step}4`).join(' + ');
  await page.locator('#expected-note').getByText(notes[1]?.[1] ? expected : `${notes[0][0]}4`, { exact: true }).waitFor();
}

async function checkStream(browserType, { forceFallback = false, full = false } = {}) {
  const browser = await browserType.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.addInitScript(installStream, { forceFallback });
    await page.goto(url);
    await page.locator('#microphone-diagnostics summary').click();
    await page.locator('#test-microphone').click();
    await page.waitForFunction(() => Boolean(window.testInput));
    await page.evaluate(() => window.testInput.tone([261.625565], { level: 0.003, delay: 0.15, duration: 0.8 }));
    await page.locator('#capture-pitches').getByText(/C4 · 26[12]\./).waitFor();
    // Out-of-range interference should still move the input meter.
    await page.evaluate(() => window.testInput.tone([20], { level: 0.05, delay: 0.9, duration: 0.9 }));
    await page.waitForFunction(() => document.querySelector('#input-meter').value > 0.3
      && document.querySelector('#capture-pitches').textContent === '—');
    assert.match(await page.locator('#capture-engine').textContent(), forceFallback ? /fallback/ : /AudioWorklet/);
    await page.locator('#test-microphone').click();
    if (!full) {
      console.log(`${browserType.name()} ${browser.version()}: meter, rejected pitch, quiet C4 and cleanup passed`);
      return;
    }

    await upload(page, [['C', false], ['E', true], ['G', true]]);
    await page.locator('#input-instrument').selectOption('piano');
    await page.locator('#following-mode').selectOption('wait');
    await page.locator('#practice-mode').selectOption('free');
    await page.locator('#count-in').uncheck();
    await page.locator('#listen').click();
    await page.locator('#listen').getByText(/Stop listening/).waitFor();
    const chordFeedbackMs = await page.evaluate(() => new Promise((resolve, reject) => {
      const host = document.querySelector('#notation');
      const timeout = setTimeout(() => {
        watch.disconnect();
        reject(new Error('Expected three chord verdicts'));
      }, 5000);
      const watch = new MutationObserver(() => {
        if (host.querySelectorAll('[data-verdict="pitch-only"]').length !== 3) return;
        watch.disconnect();
        clearTimeout(timeout);
        resolve(Math.round(window.testInput.latency()));
      });
      watch.observe(host, { childList: true, attributes: true, subtree: true });
      window.testInput.tone([261.625565, 329.6276, 391.9954], { gap: 0 });
    }));
    await page.locator('#results-summary').getByText(/3 pitches matched/).waitFor();
    assert.equal(await page.locator('[data-verdict="pitch-only"]').count(), 3);
    assert.match(await page.locator('#result-counts').textContent(), /1\/1 chords/);

    await page.locator('#retry').click();
    await page.locator('#listen').getByText(/Stop listening/).waitFor();
    await page.evaluate(() => window.testInput.tone([261.625565, 329.6276, 440], { gap: 0 }));
    await page.locator('#live-extra').getByText(/A4/).waitFor();
    await page.locator('#listen').click();
    await page.locator('#results-summary').getByText(/2 pitches matched/).waitFor();
    assert.equal(await page.locator('[data-verdict="pitch-only"]').count(), 2);
    assert.equal(await page.locator('[data-verdict="missed"]').count(), 1);
    assert.match(await page.locator('#result-counts').textContent(), /1 extra/);

    await upload(page, [['C', false], ['D', false, 2], ['E', false], ['G', false]]);
    await page.locator('#following-mode').selectOption('continuous');
    await page.locator('#bpm').fill('120');
    await page.locator('#count-in').check();
    await page.locator('#listen').click();
    await page.locator('#listen').getByText(/Stop listening/).waitFor();
    // A note during the count-in must not start assessment.
    await page.evaluate(() => window.testInput.tone([440], { duration: 0.18 }));
    await page.locator('#mic-status').getByText('Play your first note to begin').waitFor();
    // Wait longer than the scored passage before starting.
    await page.waitForTimeout(2800);
    assert.equal(await page.locator('#passage-progress').getAttribute('value'), '0');
    assert.equal(await page.locator('#expected-note').textContent(), 'C4');
    assert.equal(await page.locator('#results').isVisible(), false);
    await page.evaluate(() => {
      window.testInput.tone([293.664768], { duration: 0.18 });
      window.testInput.tone([293.664768], { duration: 0.18, delay: 0.82 });
      window.testInput.tone([329.627556], { duration: 0.18, delay: 1.52 });
    });
    await page.locator('#mic-status').getByText('Next: D4', { exact: true }).waitFor();
    await page.locator('#results-summary').getByText(/2 pitches matched/).waitFor();
    for (const verdict of ['correct', 'timing', 'wrong', 'missed']) {
      assert.equal(await page.locator(`[data-verdict="${verdict}"]`).count(), 1);
    }
    await page.locator('#result-list button').getByText(/Expected C4, heard D4/).click();
    await page.locator('#score-review-detail').getByText(/Expected C4, heard D4/).waitFor();

    await page.locator('#retry').click();
    await page.locator('#mic-status').getByText('Play your first note to begin').waitFor();
    await page.evaluate(() => {
      [261.625565, 293.664768, 329.6276, 391.9954].forEach((frequency, index) =>
        window.testInput.tone([frequency], { duration: 0.18, delay: [0.02, 0.69, 1.52, 2.02][index] }));
    });
    await page.locator('#results-summary').getByText(/4 pitches matched/).waitFor();
    await page.locator('#comparison-table').waitFor();
    assert.equal(await page.locator('[data-verdict="correct"]').count(), 4);
    const overall = page.locator('#result-metrics').getByText('Overall accuracy', { exact: true }).locator('..');
    assert.equal(await overall.locator('strong').textContent(), '100%');

    await page.locator('#retry').click();
    await page.locator('#listen').getByText(/Stop listening/).waitFor();
    await page.evaluate(() => window.testInput.disconnect());
    await page.locator('#results-summary').getByText(/Unassessable attempt.*disconnected/).waitFor();
    assert.equal(await page.locator('#result-metrics').isVisible(), false);
    console.log(`${browserType.name()} ${browser.version()}: capture, good/wrong triad, wrong opening note after waiting, all scored colours, review, take comparison and disconnect passed; triad → displayed verdict ${chordFeedbackMs} ms`);
  } catch (error) {
    console.error(await page.locator('#capture-message, #capture-engine, #capture-levels, #capture-pitches, #mic-status, #results-summary, #result-list, #upload-error')
      .allTextContents(), errors);
    throw error;
  } finally {
    await browser.close();
  }
}

try {
  await checkRealCaptureAPI();
  await checkStream(chromium, { forceFallback: true, full: true });
  if (process.env.PAPERTEMPO_CROSS_BROWSER) {
    await checkStream(firefox);
    await checkStream(webkit);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
