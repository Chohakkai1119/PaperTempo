// Use Playwright's real DOM, SVG getBBox and WebAssembly engraving.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PAPERTEMPO_PLAYWRIGHT || 'playwright');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(process.env.PAPERTEMPO_TEST_URL || 'http://localhost:3000');
  const value = await page.evaluate(async () => {
    const { clearMarks, engrave, markResult, notationElement } = await import('/score.mjs');
    const chordScore = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions><time><beats>2</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
        <transpose><chromatic>0</chromatic><octave-change>-1</octave-change></transpose>
      </attributes>
      <barline location="left"><repeat direction="forward"/></barline>
      <note id="originalC"><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note><chord/><pitch><step>G</step><octave>5</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <note id="tieStart"><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><tie type="start"/><voice>1</voice><type>quarter</type><staff>1</staff><notations><tied type="start"/></notations></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>2</voice><type>half</type><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note id="tieStop"><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><tie type="stop"/><voice>1</voice><type>quarter</type><staff>1</staff><notations><tied type="stop"/></notations></note>
      <note><rest/><duration>2</duration><voice>1</voice><type>quarter</type><staff>1</staff></note>
      <barline location="right"><repeat direction="backward"/></barline>
    </measure>
  </part>
</score-partwise>`;
    const score = await engrave(chordScore);
    const [first, held, replay] = score.notes;
    const panel = document.createElement('div');
    panel.append(notationElement(score.pages[0]));
    document.body.append(panel);
    const counts = [];
    const targets = [];
    const kinds = ['correct', 'timing', 'wrong', 'unassessable'];
    first.pitches.forEach((tone, index) => {
      const target = panel.querySelector(`#${CSS.escape(tone.id)}`);
      const detail = `Tone ${tone.midi}`;
      markResult(panel, { note: tone, kind: kinds[index], detail });
      markResult(panel, { note: tone, kind: kinds[index], detail });
      const head = target.querySelector('.notehead');
      targets.push({
        verdict: head?.dataset.verdict, shape: target.querySelector('.result-mark rect').getAttribute('rx'),
        label: target.getAttribute('aria-label'), focusable: target.getAttribute('tabindex'),
      });
    });
    counts.push(panel.querySelectorAll('.result-mark').length);
    clearMarks(panel, { results: false });
    counts.push(panel.querySelectorAll('.result-mark').length);
    clearMarks(panel);
    counts.push(panel.querySelectorAll('.result-mark, [data-verdict], [data-assessment]').length);
    const sample = await (await fetch('/assets/morning-lines.musicxml')).text();
    const sampleScore = await engrave(sample, { sample: true });
    return {
      pitchSets: score.notes.map(({ pitches }) => pitches.map(({ midi }) => midi)),
      writtenPitch: first.pitches.find(({ id }) => id === 'originalC'),
      measures: score.bars.map(({ beat, label }) => [beat, label]),
      end: score.endBeat,
      tie: held.pitches[0],
      repeatedSource: replay.id === first.id && replay.groupId !== first.groupId
        && replay.pitches[0].occurrenceId !== first.pitches[0].occurrenceId,
      counts,
      targets,
      sample: { bars: sampleScore.bars.length, first: sampleScore.notes[0].midi },
    };
  });
  assert.deepEqual(value.pitchSets, [[67, 64, 60, 55], [57], [67, 64, 60, 55], [57]]);
  assert.deepEqual(value.writtenPitch.writtenPitch, { step: 'C', alter: 0, octave: 5 });
  assert.equal(value.writtenPitch.writtenMidi, 72);
  assert.equal(value.writtenPitch.sourceId, 'originalC');
  assert.ok(value.writtenPitch.page > 0);
  assert.deepEqual(value.measures, [[0, '1'], [2, '2'], [4, '1'], [6, '2']]);
  assert.equal(value.end, 8);
  assert.equal(value.tie.duration, 2);
  assert.deepEqual(value.tie.continuationIds, ['tieStop']);
  assert.equal(value.tie.continuations[0].page, value.tie.page);
  assert.ok(value.repeatedSource);
  assert.deepEqual(value.counts, [4, 4, 0]);
  assert.deepEqual(value.targets.map(({ verdict }) => verdict), ['correct', 'timing', 'wrong', 'unassessable']);
  assert.notEqual(value.targets[0].shape, value.targets[2].shape);
  assert.ok(value.targets.every(({ label, focusable }) => /^Tone \d+$/.test(label) && focusable === '0'));
  assert.deepEqual(value.sample, { bars: 18, first: 60 });
  console.log('Passed Chromium score checks for chord noteheads, transposition, ties, repeats, marker accessibility, and sample score.');
} finally {
  await browser.close();
}
