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

function extractScore(xml) {
  const document = readXML(xml);
  const root = document.documentElement;
  if (root.localName !== 'score-partwise') throw new Error('Export your score as partwise MusicXML.');
  const parts = [...root.children].filter((element) => element.localName === 'part');
  if (parts.length !== 1 || root.querySelector('chord, backup, grace, unpitched, repeat')) {
    throw new Error('Choose a single melody line without chords, overlapping voices, grace notes or repeats.');
  }
  const rawTitle = root.querySelector('work-title')?.textContent.trim() || root.querySelector('movement-title')?.textContent.trim();
  const bars = [];
  const events = [];
  let divisions = 1;
  let beat = 0;
  let transpose = 0;

  for (const measure of [...parts[0].children].filter((element) => element.localName === 'measure')) {
    const bar = { label: measure.getAttribute('number') || String(bars.length + 1), beat, index: bars.length };
    bars.push(bar);
    for (const element of measure.children) {
      if (element.localName === 'attributes') {
        const nextDivisions = Number(element.querySelector('divisions')?.textContent);
        if (nextDivisions > 0) divisions = nextDivisions;
        const transposition = element.querySelector('transpose');
        if (transposition) {
          transpose = Number(transposition.querySelector('chromatic')?.textContent || 0)
            + 12 * Number(transposition.querySelector('octave-change')?.textContent || 0);
          if (transposition.querySelector('double')) {
            throw new Error('Choose a score for one sounding pitch at a time.');
          }
        }
      }
      if (!['note', 'forward'].includes(element.localName)) continue;
      const duration = Number(element.querySelector('duration')?.textContent) / divisions;
      if (!Number.isFinite(duration) || duration <= 0) throw new Error('A note or rest is missing a valid duration.');
      const id = `pt-note-${events.length + 1}`;
      const event = { id, measure: bar.index, beat, duration, midi: null, tied: false };
      if (element.localName === 'note') {
        element.removeAttributeNS('http://www.w3.org/XML/1998/namespace', 'id');
        element.setAttribute('id', id);
        const pitch = element.querySelector('pitch');
        if (pitch) {
          const step = pitch.querySelector('step')?.textContent;
          const octaveValue = pitch.querySelector('octave')?.textContent;
          const alter = Number(pitch.querySelector('alter')?.textContent || 0);
          event.midi = (Number(octaveValue) + 1) * 12 + pitchClasses[step] + alter + transpose;
          if (!octaveValue || !Number.isInteger(event.midi) || event.midi < 0 || event.midi > 127) {
            throw new Error('This score contains an unsupported pitch.');
          }
          event.tied = Boolean(element.querySelector('tie[type="stop"], tied[type="stop"]'));
        } else if (!element.querySelector('rest')) {
          throw new Error('This score contains a note without a pitch.');
        }
      }
      events.push(event);
      beat += duration;
    }
  }
  const notes = events.filter((event) => event.midi !== null && !event.tied);
  if (!notes.length) throw new Error('No playable notes were found in that score.');
  return { document, rawTitle, bars, events, notes, endBeat: beat };
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
      pageWidth: 1600, pageHeight: 840, adjustPageHeight: true,
      pageMarginLeft: 37, pageMarginRight: 37, pageMarginTop: 22, pageMarginBottom: 15,
      spacingSystem: 9, breaks: sample || data.document.querySelector('print[new-page="yes"]') ? 'encoded' : 'auto',
      header: 'none', footer: 'none', svgViewBox: true, mnumInterval: 1,
    });
    if (!toolkit.loadData(new XMLSerializer().serializeToString(data.document.documentElement))) {
      throw new Error('The score could not be engraved.');
    }
    const totalPages = toolkit.getPageCount();
    if (totalPages > 50) throw new Error('Choose a score with 50 pages or fewer.');
    const pages = Array.from({ length: totalPages }, (_, i) => toolkit.renderToSVG(i + 1));
    for (const event of data.events) event.page = toolkit.getPageWithElement(event.id) || null;
    if (data.notes.some((note) => !note.page)) throw new Error('The notes could not be located on the engraved pages.');
    return { ...data, pages, title: data.rawTitle || name, sample };
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
  svg.setAttribute('role', 'img');
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

export function markResult(container, { note: { id }, kind, detail }, selected) {
  const note = container.querySelector(`#${CSS.escape(id)}`);
  if (!note) return;
  const box = (note.querySelector('.notehead') || note).getBBox();
  const mark = document.createElementNS(svgNS, 'g');
  mark.setAttribute('class', `result-mark ${kind}-mark${selected ? ' is-selected' : ''}`);
  mark.setAttribute('aria-hidden', 'true');
  const outline = document.createElementNS(svgNS, 'rect');
  outline.setAttribute('x', box.x - 85);
  outline.setAttribute('y', box.y - 110);
  outline.setAttribute('width', box.width + 170);
  outline.setAttribute('height', box.height + 220);
  outline.setAttribute('rx', 100);
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

export function clearMarks(container) {
  for (const marker of container.querySelectorAll('.note-focus, .result-mark')) marker.remove();
  for (const note of container.querySelectorAll('.matched, .expected, .playback, .review-on-time')) {
    note.classList.remove('matched', 'expected', 'playback', 'review-on-time');
  }
}
