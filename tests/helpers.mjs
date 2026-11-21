// Shared helpers for PaperTempo's Node tests (no browser needed).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function midi(name) {
  const m = name.match(/^([A-G])(#|b)?(-?\d)$/);
  return 12 * (+m[3] + 1) + STEP[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}

/**
 * Expected notes from the Morning Lines sample, in the same shape score.mjs builds
 * ({ midi, beat, measure, page }). score.mjs needs DOMParser, so this is a small
 * regex reader for the sample only. Page 2 starts at the <print new-page="yes"/> bar.
 */
export function sampleNotes() {
  const xml = readFileSync(resolve(root, 'dist/assets/morning-lines.musicxml'), 'utf8');
  const divisions = +xml.match(/<divisions>(\d+)<\/divisions>/)[1];
  const notes = [];
  let beat = 0;
  let page = 1;
  [...xml.matchAll(/<measure\b[^>]*number="([^"]+)"[^>]*>([\s\S]*?)<\/measure>/g)].forEach(([, label, body], measure) => {
    if (/<print[^>]*new-page="yes"/.test(body)) page++;
    for (const [, n] of body.matchAll(/<note\b[^>]*>([\s\S]*?)<\/note>/g)) {
      const dur = +n.match(/<duration>(\d+)<\/duration>/)[1] / divisions;
      const p = n.match(/<step>([A-G])<\/step>\s*(?:<alter>(-?\d+)<\/alter>\s*)?<octave>(\d)<\/octave>/);
      if (p) notes.push({ midi: (+p[3] + 1) * 12 + STEP[p[1]] + +(p[2] ?? 0), beat, measure, bar: label, page });
      beat += dur;
    }
  });
  return notes;
}

/**
 * Synthesise a mono signal from segments: { midi | null (silence), dur (s), amp, attack, release, decay }.
 * A few harmonics so it looks like an instrument rather than a pure sine.
 */
export function synth(segments, sampleRate = 48000, noise = 0.002) {
  const total = Math.round(segments.reduce((s, x) => s + x.dur, 0) * sampleRate);
  const out = new Float32Array(total);
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  let i0 = 0;
  for (const seg of segments) {
    const n = Math.round(seg.dur * sampleRate);
    const f = seg.midi == null ? 0 : 440 * 2 ** ((seg.midi - 69) / 12);
    const amp = seg.amp ?? 0.3;
    const attack = seg.attack ?? 0.015;
    const release = seg.release ?? 0.01;
    for (let k = 0; k < n; k++) {
      const t = k / sampleRate;
      let env = 1;
      if (t < attack) env = t / attack;
      if (seg.dur - t < release) env = Math.min(env, (seg.dur - t) / release);
      if (seg.decay) env *= Math.exp(-t / seg.decay);
      const v = f ? Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t) : 0;
      out[i0 + k] = (amp * env * v) / 1.75 + noise * rand();
    }
    i0 += n;
  }
  return out;
}
