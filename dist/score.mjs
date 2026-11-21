const pitchClasses = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const pitchNames = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const svgNS = 'http://www.w3.org/2000/svg';
let modulePromise;

export function midiName(midi) {
  return `${pitchNames[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function readXML(text) {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('This file is not valid MusicXML.');
  return document;
}

export async function musicXMLFromFile(file) {
  if (file.size > 8 * 1024 * 1024) throw new Error('Choose a score smaller than 8 MB.');
  if (!/\.mxl$/i.test(file.name)) return file.text();
  const { unzipSync, strFromU8 } = await import('./vendor/fflate.mjs');
  const archive = new Uint8Array(await file.arrayBuffer());
  const containerPath = 'META-INF/container.xml';
  const container = unzipSync(archive, {
    filter: (entry) => entry.name === containerPath && entry.originalSize < 64 * 1024,
  })[containerPath];
  const path = container && readXML(strFromU8(container)).querySelector('rootfile')?.getAttribute('full-path');
  const unpacked = path && unzipSync(archive, {
    filter: (entry) => entry.name === path && entry.originalSize <= 8 * 1024 * 1024,
  });
  const score = unpacked && Object.hasOwn(unpacked, path) && unpacked[path];
  if (!score) throw new Error('The MXL archive does not contain a readable MusicXML score.');
  return strFromU8(score);
}

export function shiftMusicXMLOctaves(xml, octaves) {
  if (!Number.isInteger(octaves)) throw new TypeError('Octave shift must be a whole number.');
  const document = readXML(xml);
  for (const pitch of document.querySelectorAll('pitch')) {
    const octave = pitch.querySelector('octave');
    const shifted = Number(octave?.textContent) + octaves;
    if (!octave || !Number.isInteger(shifted) || shifted < 0 || shifted > 9) {
      throw new Error('That octave shift would move notes outside the supported range.');
    }
    octave.textContent = String(shifted);
  }
  for (const unpitched of document.querySelectorAll('unpitched')) {
    const octave = unpitched.querySelector('display-octave');
    if (!octave) continue;
    const shifted = Number(octave.textContent) + octaves;
    if (!Number.isInteger(shifted) || shifted < 0 || shifted > 9) {
      throw new Error('That octave shift would move notes outside the supported range.');
    }
    octave.textContent = String(shifted);
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}

const onsetEpsilon = 1e-8;

function childrenNamed(element, name) {
  return [...element.children].filter((child) => child.localName === name);
}

function childText(element, name) {
  return childrenNamed(element, name)[0]?.textContent.trim();
}

function readMeasures(sourceMeasures, noteId) {
  let divisions = 1;
  let partTranspose = 0;
  const staffTransposes = new Map();
  return sourceMeasures.map((measure, sourceIndex) => {
    const tones = [];
    let cursor = 0;
    let furthest = 0;
    let previousOnset = 0;
    for (const element of measure.children) {
      const type = element.localName;
      if (type === 'attributes') {
        const nextDivisions = Number(childText(element, 'divisions'));
        if (nextDivisions > 0) divisions = nextDivisions;
        for (const transposition of childrenNamed(element, 'transpose')) {
          const staff = transposition.getAttribute('number');
          const semitones = Number(childText(transposition, 'chromatic') ?? 0)
            + 12 * Number(childText(transposition, 'octave-change') ?? 0);
          if (childrenNamed(transposition, 'double').length) {
            throw new Error('Parts with octave doubling are not supported.');
          }
          if (staff) staffTransposes.set(staff, semitones);
          else {
            partTranspose = semitones;
            staffTransposes.clear();
          }
        }
        continue;
      }
      const duration = Number(childText(element, 'duration') ?? 0) / divisions;
      if (type === 'backup' || type === 'forward') {
        cursor += type === 'backup' ? -duration : duration;
        furthest = Math.max(furthest, cursor);
        continue;
      }
      if (type !== 'note' || childrenNamed(element, 'grace').length) continue;
      const chord = childrenNamed(element, 'chord').length > 0;
      const onset = chord ? previousOnset : cursor;
      if (!chord) {
        previousOnset = onset;
        cursor += duration;
      }
      furthest = Math.max(furthest, cursor, onset + duration);
      const pitch = childrenNamed(element, 'pitch')[0];
      if (!pitch || !(duration > 0)) continue;
      const step = childText(pitch, 'step');
      const octave = Number(childText(pitch, 'octave'));
      const alter = Number(childText(pitch, 'alter') ?? 0);
      const writtenMidi = (octave + 1) * 12 + pitchClasses[step] + alter;
      const staff = childText(element, 'staff') ?? '1';
      const voice = childText(element, 'voice') ?? '1';
      const midi = writtenMidi + (staffTransposes.get(staff) ?? partTranspose);
      if (!Number.isInteger(writtenMidi) || !Number.isInteger(midi) || midi < 0 || midi > 127) {
        throw new Error('This score contains an unsupported pitch.');
      }
      const sourceId = element.getAttribute('id');
      const id = noteId(element);
      const tieStart = Boolean(element.querySelector('tie[type="start"], tied[type="start"]'));
      const tieStop = Boolean(element.querySelector('tie[type="stop"], tied[type="stop"]'));
      tones.push({
        id, sourceId, onset, duration, midi, writtenMidi, writtenPitch: { step, alter, octave },
        chord, voice, staff, tieStart, tieStop,
      });
    }
    return {
      sourceIndex,
      label: measure.getAttribute('number') || String(sourceIndex + 1),
      length: furthest,
      tones: tones.sort((a, b) => a.onset - b.onset || b.midi - a.midi),
      forwardRepeat: Boolean(measure.querySelector('barline repeat[direction="forward"]')),
      backwardRepeat: Boolean(measure.querySelector('barline repeat[direction="backward"]')),
    };
  });
}

// All parts, staves and voices contribute notes. Simultaneous notes are grouped
// into chords, ties preserve one attack, and simple written repeats are expanded.
export function extractScore(xml) {
  const document = readXML(xml);
  const root = document.documentElement;
  if (root.localName !== 'score-partwise') throw new Error('Export your score as partwise MusicXML.');
  const parts = childrenNamed(root, 'part');
  if (!parts.length) throw new Error('This score does not contain a part.');
  const rawTitle = root.querySelector('work-title')?.textContent.trim() || root.querySelector('movement-title')?.textContent.trim();
  const usedIds = new Set([...root.querySelectorAll('[id]')].map((element) => element.getAttribute('id')));
  let nextSourceId = 1;
  const partMeasures = parts.map((part, partIndex) => readMeasures(childrenNamed(part, 'measure'), (note) => {
    const original = note.getAttribute('id');
    if (original) return original;
    let id;
    do { id = `pt-note-${nextSourceId++}`; } while (usedIds.has(id));
    usedIds.add(id);
    note.setAttribute('id', id);
    return id;
  }).map((measure) => ({ ...measure, tones: measure.tones.map((tone) => ({ ...tone, part: partIndex })) })));
  const measureCount = Math.max(...partMeasures.map((measures) => measures.length));
  const sourceMeasures = Array.from({ length: measureCount }, (_, sourceIndex) => {
    const measures = partMeasures.map((list) => list[sourceIndex]).filter(Boolean);
    return {
      sourceIndex, label: measures[0]?.label || String(sourceIndex + 1),
      length: Math.max(0, ...measures.map((measure) => measure.length)),
      tones: measures.flatMap((measure) => measure.tones).sort((a, b) => a.onset - b.onset || b.midi - a.midi),
      forwardRepeat: measures.some((measure) => measure.forwardRepeat),
      backwardRepeat: measures.some((measure) => measure.backwardRepeat),
    };
  });
  const expandedMeasures = [];
  let repeatStart = 0;
  for (const measure of sourceMeasures) {
    if (measure.forwardRepeat) repeatStart = measure.sourceIndex;
    expandedMeasures.push(measure);
    if (measure.backwardRepeat) {
      expandedMeasures.push(...sourceMeasures.slice(repeatStart, measure.sourceIndex + 1));
      repeatStart = measure.sourceIndex + 1;
    }
  }

  const bars = [];
  const events = [];
  const notes = [];
  const activeTies = new Map();
  let beat = 0;
  let previousSourceIndex = -1;
  for (const measure of expandedMeasures) {
    const index = bars.length;
    bars.push({ label: measure.label, beat, index });
    if (measure.sourceIndex !== previousSourceIndex + 1) activeTies.clear();
    previousSourceIndex = measure.sourceIndex;
    for (const { onset, ...source } of measure.tones) {
      const attack = beat + onset;
      const tone = {
        ...source, beat: attack, measure: index, occurrenceId: `pt-tone-${index}-${source.id}`,
        continuationIds: [], continuations: [],
      };
      const tieKey = JSON.stringify([tone.part, tone.voice, tone.staff, tone.midi]);
      if (tone.tieStop) {
        const previous = activeTies.get(tieKey);
        if (previous && Math.abs(previous.beat + previous.duration - attack) < onsetEpsilon) {
          previous.duration = attack + tone.duration - previous.beat;
          previous.continuationIds.push(tone.id);
          previous.continuations.push(tone);
        }
        if (!tone.tieStart) activeTies.delete(tieKey);
        continue;
      }
      if (tone.tieStart) activeTies.set(tieKey, tone);
      else activeTies.delete(tieKey);
      const last = notes.at(-1);
      if (last?.measure === index && Math.abs(last.beat - attack) < onsetEpsilon) {
        last.pitches.push(tone);
      } else {
        notes.push({
          id: tone.id, groupId: `pt-event-${notes.length + 1}`, midi: tone.midi,
          measure: index, beat: attack, tied: false, pitches: [tone],
        });
      }
      events.push(tone);
    }
    beat += measure.length;
  }
  if (!notes.length) throw new Error('No playable notes were found in that score.');
  for (const note of notes) note.duration = Math.max(...note.pitches.map((tone) => tone.duration));
  return { document, rawTitle, bars, events, notes, endBeat: beat };
}

// Elements that print a title, composer or credits on the engraved page. The app shows the
// piece name in its own header, so these are removed before rendering. `(?=[\s>/])` stops
// `<work` matching `<work-title` and `<credit` matching `<credit-words`.
const TITLE_ELEMENTS = ['credit', 'work', 'movement-title', 'movement-number', 'creator', 'rights'];

/** Removes title, composer and credit elements from MusicXML text (notes are untouched). */
export function stripTitles(xml) {
  let out = xml;
  for (const name of TITLE_ELEMENTS) {
    out = out
      .replace(new RegExp(`<${name}(?=[\\s>/])[^>]*/>`, 'g'), '')
      .replace(new RegExp(`<${name}(?=[\\s>/])[^>]*>[\\s\\S]*?</${name}>`, 'g'), '');
  }
  return out;
}

export async function engrave(xml, { sample = false, name = 'Imported score' } = {}) {
  const data = extractScore(xml);
  if (!modulePromise) {
    modulePromise = import('./vendor/verovio-module.mjs')
      .then(({ default: init }) => init())
      .catch((error) => {
        modulePromise = undefined;
        throw error;
      });
  }
  const [module, { VerovioToolkit }] = await Promise.all([modulePromise, import('./vendor/verovio.mjs')]);
  const toolkit = new VerovioToolkit(module);
  try {
    toolkit.setOptions({
      // One continuous, very tall page: the app shows it through a scrolling 4-row window.
      // 'line' keeps the score's own row (system) breaks but ignores its page breaks.
      pageWidth: 1600, pageHeight: 60000, adjustPageHeight: true,
      pageMarginLeft: 37, pageMarginRight: 37, pageMarginTop: 22, pageMarginBottom: 15,
      spacingSystem: 9, breaks: sample || data.document.querySelector('print[new-page="yes"]') ? 'line' : 'auto',
      header: 'none', footer: 'none', svgViewBox: true, mnumInterval: 1,
    });
    if (!toolkit.loadData(stripTitles(new XMLSerializer().serializeToString(data.document.documentElement)))) {
      throw new Error('The score could not be engraved.');
    }
    const totalPages = toolkit.getPageCount();
    if (totalPages > 50) throw new Error('Choose a score with 50 pages or fewer.');
    const pages = Array.from({ length: totalPages }, (_, i) => toolkit.renderToSVG(i + 1));
    // Resolve every attack and tie continuation against the engraved page and system.
    const positionById = new Map();
    const pageRows = [];
    let rowCount = 0;
    for (const [pageIndex, markup] of pages.entries()) {
      const systems = new DOMParser().parseFromString(markup, 'image/svg+xml').querySelectorAll('g.system');
      systems.forEach((system, i) => {
        for (const element of system.querySelectorAll('g.note[id]')) {
          positionById.set(element.id, { page: pageIndex + 1, row: rowCount + i });
        }
      });
      pageRows.push({ first: rowCount, count: systems.length });
      rowCount += systems.length;
    }
    for (const event of data.events) {
      const position = positionById.get(event.id);
      if (!position) throw new Error('The notes could not be located on the engraved pages.');
      Object.assign(event, position);
      for (const continuation of event.continuations) {
        Object.assign(continuation, positionById.get(continuation.id));
      }
    }
    for (const note of data.notes) {
      const { page, row } = note.pitches[0];
      Object.assign(note, { page, row });
    }
    return { ...data, pages, pageRows, rowCount, title: data.rawTitle || name, sample };
  } finally {
    toolkit.destroy();
  }
}

export function notationElement(markup, preview = false) {
  const document = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = document.documentElement;
  if (svg.localName !== 'svg') throw new Error('The engraved score could not be displayed.');
  const allowed = new Set([
    'svg', 'desc', 'defs', 'g', 'use', 'path', 'rect', 'ellipse', 'circle',
    'line', 'polyline', 'polygon', 'text', 'tspan', 'title',
  ]);
  const prefix = preview ? 'preview-' : '';
  for (const node of [svg, ...svg.querySelectorAll('*')]) {
    if (node.namespaceURI !== svgNS || !allowed.has(node.localName)) {
      node.remove();
      continue;
    }
    for (const attr of [...node.attributes]) {
      if (attr.localName === 'href') {
        if (/^#[\w.-]+$/.test(attr.value)) {
          node.setAttributeNS(attr.namespaceURI, attr.name, `#${prefix}${attr.value.slice(1)}`);
        } else node.removeAttributeNode(attr);
      } else if (/^on/i.test(attr.name) || attr.name === 'style' || /url\s*\(/i.test(attr.value)) {
        node.removeAttributeNode(attr);
      }
    }
    if (node.id) node.id = prefix + node.id;
  }
  svg.setAttribute('role', preview ? 'img' : 'group');
  svg.setAttribute('aria-label', preview ? 'Opening bars of the next page' : 'Engraved sheet music');
  svg.removeAttribute('overflow');
  if (preview) {
    const [x, y, width, height] = svg.getAttribute('viewBox').split(/\s+/).map(Number);
    svg.setAttribute('viewBox', `${x} ${y} ${width} ${Math.min(height, 285)}`);
  }
  return svg;
}

export function markNote(container, id, status) {
  if (!id) return null;
  const note = container.querySelector(`#${CSS.escape(id)}`);
  if (!note) return null;
  const head = note.querySelector('.notehead') || note;
  const box = head.getBBox();
  const marker = document.createElementNS(svgNS, 'rect');
  marker.setAttribute('x', box.x - 85);
  marker.setAttribute('y', box.y - 110);
  marker.setAttribute('width', box.width + 170);
  marker.setAttribute('height', box.height + 220);
  marker.setAttribute('rx', 55);
  marker.setAttribute('class', `note-focus ${status}-focus`);
  note.classList.add(status);
  note.prepend(marker);
  return note;
}

export function markResult(container, { note: { id }, kind, detail }, selected = false) {
  const note = container.querySelector(`#${CSS.escape(id)}`);
  if (!note) return;
  const status = `${kind}${selected ? ' selected' : ''}`;
  if (note.dataset.assessment === status && note.getAttribute('aria-label') === detail) return;
  note.querySelector(':scope > .result-mark')?.remove();
  note.querySelector(':scope > .result-title')?.remove();
  note.dataset.assessment = status;
  note.setAttribute('aria-label', detail);
  note.setAttribute('role', 'button');
  note.setAttribute('tabindex', '0');
  const title = document.createElementNS(svgNS, 'title');
  title.setAttribute('class', 'result-title');
  title.textContent = detail;
  note.prepend(title);

  const head = note.querySelector('.notehead') || note;
  head.dataset.verdict = kind;
  const box = head.getBBox();
  const mark = document.createElementNS(svgNS, 'g');
  mark.setAttribute('class', `result-mark ${kind}-mark${selected ? ' is-selected' : ''}`);
  mark.setAttribute('aria-hidden', 'true');
  const outline = document.createElementNS(svgNS, 'rect');
  outline.setAttribute('x', box.x - 85);
  outline.setAttribute('y', box.y - 110);
  outline.setAttribute('width', box.width + 170);
  outline.setAttribute('height', box.height + 220);
  outline.setAttribute('rx', kind === 'wrong' || kind === 'missed' ? 0 : 100);
  mark.append(outline);
  if (selected) {
    const label = document.createElementNS(svgNS, 'text');
    label.setAttribute('x', box.x + box.width / 2);
    label.setAttribute('y', box.y - 175);
    label.setAttribute('text-anchor', 'middle');
    label.textContent = detail;
    mark.append(label);
  }
  note.append(mark);
}

export function clearMarks(container, { results = true } = {}) {
  for (const marker of container.querySelectorAll('.note-focus')) marker.remove();
  for (const note of container.querySelectorAll('.matched, .expected, .playback, .review-on-time')) {
    note.classList.remove('matched', 'expected', 'playback', 'review-on-time');
  }
  if (!results) return;
  for (const mark of container.querySelectorAll('.result-mark, .result-title')) mark.remove();
  for (const head of container.querySelectorAll('[data-verdict]')) delete head.dataset.verdict;
  for (const note of container.querySelectorAll('[data-assessment]')) {
    delete note.dataset.assessment;
    for (const attr of ['aria-label', 'role', 'tabindex']) note.removeAttribute(attr);
  }
}
