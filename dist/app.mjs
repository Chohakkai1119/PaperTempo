import { clearMarks, engrave, markNote, midiName, musicXMLFromFile, notationElement } from './score.mjs';
import { openMicrophone, scheduleCountIn } from './audio.mjs';
import { acceptNote, createTake, MIN_TIMED_MATCHES, summarize, TIMING_TOLERANCE } from './practice.mjs';

const byId = (id) => document.getElementById(id);
const text = (id, value) => {
  const element = byId(id);
  if (element.textContent !== value) element.textContent = value;
};
const state = {
  score: null, index: 0, page: 1, shownPage: null, shownPreview: null,
  matched: null, matchTimer: null, mic: null, opening: false, take: null,
  countIn: null, lastSignal: 0, pdfURL: null, musicXMLURL: null, loading: 0, completed: false,
};
const notation = byId('notation');
const preview = byId('preview-notation');
const barSelect = byId('start-bar');
const endBarSelect = byId('end-bar');
const modeSelect = byId('practice-mode');
const listen = byId('listen');
const retry = byId('retry');
const scoreFile = byId('score-file');
const uploadDialog = byId('upload-dialog');
const uploadError = byId('upload-error');
const dropzone = byId('dropzone');

function barLabel(index) {
  return 'Bar ' + state.score.bars[index].label;
}

function loadPageMarkup() {
  const score = state.score;
  if (state.page !== state.shownPage) {
    notation.replaceChildren(notationElement(score.pages[state.page - 1]));
    notation.scrollLeft = 0;
    state.shownPage = state.page;
  }
}

function trackNoteVisibility(note) {
  if (!note || notation.scrollWidth <= notation.clientWidth) return;
  const left = note.getBoundingClientRect().left - notation.getBoundingClientRect().left;
  if (left < 18 || left > notation.clientWidth - 32) notation.scrollLeft += left - notation.clientWidth / 2;
}

function showPreview() {
  const { notes, pages } = state.score;
  const nextPage = state.page + 1;
  const initial = notes.find((note) => note.page === nextPage);
  const lastOnPage = notes.findLastIndex((note) => note.page === state.page);
  const endBar = endBarSelect.value;
  const visible = Boolean(!state.completed && initial && nextPage <= pages.length
    && (endBar === '' || initial.measure <= Number(endBar)) && state.index >= Math.max(0, lastOnPage - 3));
  byId('page-preview').hidden = !visible;
  if (!visible || state.shownPreview === nextPage) return;
  const openingBar = state.score.bars[initial.measure].label;
  text('preview-label', `· Page ${nextPage} · Bar ${openingBar}`);
  preview.replaceChildren(notationElement(pages[nextPage - 1], true));
  state.shownPreview = nextPage;
}

function refreshScore() {
  if (!state.score) return;
  const { notes, pages } = state.score;
  const next = state.completed ? null : notes[state.index];
  const position = next || notes[state.index - 1];
  loadPageMarkup();
  clearMarks(notation);
  if (state.matched?.page === state.page) markNote(notation, state.matched.id, 'matched');
  trackNoteVisibility(next?.page === state.page ? markNote(notation, next.id, 'expected') : null);
  text('page-label', `Page ${state.page} of ${pages.length}`);
  text('position', `${barLabel(position.measure)} · Page ${position.page}`);
  text('expected-note', next ? midiName(next.midi) : '—');
  byId('prev-page').disabled = state.page <= 1;
  byId('next-page').disabled = state.page >= pages.length;
  byId('prev-note').disabled = state.index <= 0 || Boolean(state.mic);
  byId('next-note').disabled = state.index >= notes.length - 1 || Boolean(state.mic);
  showPreview();
}

function updateEndBars(startIndex) {
  const firstMeasure = state.score.notes[startIndex].measure;
  for (const option of endBarSelect.options) {
    option.disabled = option.value !== '' && Number(option.value) < firstMeasure;
  }
  if (endBarSelect.selectedOptions[0]?.disabled) endBarSelect.value = '';
}

function micLabel(label, tone = '') {
  if (byId('mic-status').textContent !== label) text('mic-status', label);
  const dot = byId('mic-dot');
  const className = `state-dot ${tone}`.trim();
  if (dot.className !== className) dot.className = className;
}

function showListening() {
  const live = Boolean(state.mic);
  listen.classList.toggle('is-listening', live);
  listen.querySelector('use').setAttribute('href', live ? '#i-stop' : '#i-mic');
  listen.querySelector('span').textContent = live ? 'Stop listening' : 'Start listening';
  listen.disabled = state.opening || !state.score;
  endBarSelect.disabled = live || listen.disabled;
}

function showResults(take, cancelled) {
  const { matched, missed, extras, bpm } = take;
  const { attempted, pitch, timing } = summarize(take);
  byId('results').hidden = false;
  text('results-summary', cancelled ? 'Count-in cancelled' : `${matched.length} of ${attempted} expected notes matched`);
  const metrics = byId('result-metrics');
  metrics.replaceChildren();
  function metric(label, value) {
    const cell = document.createElement('div');
    const name = document.createElement('span');
    const score = document.createElement('strong');
    name.textContent = label;
    score.textContent = value;
    cell.append(name, score);
    metrics.append(cell);
  }
  metric('Pitch accuracy', pitch === null ? '—' : `${pitch}%`);
  if (bpm) metric('On time', timing === null ? '—' : `${timing}%`);
  else metric('Extra notes', String(extras.length));
  byId('timing-detail').hidden = !bpm;
  if (bpm) {
    text('timing-detail', timing === null
      ? `Timing needs at least ${MIN_TIMED_MATCHES} matched notes. ${extras.length} extra.`
      : `Within ±${TIMING_TOLERANCE} ms of the target beat. ${extras.length} extra.`);
  }
  const list = byId('result-list');
  const items = [
    ...missed.map((note) => ({ note, detail: 'Missed' })),
    ...extras.map(({ note, midi }) => ({ note, detail: `Extra · ${midiName(midi)}` })),
    ...matched.map(({ note, delta }) => ({
      note, detail: delta === null ? 'Matched' : (Math.abs(delta) < 0.5 ? 'On beat' : `${Math.round(Math.abs(delta))} ms ${delta < 0 ? 'early' : 'late'}`),
    })),
  ].sort((a, b) => a.note.beat - b.note.beat);
  list.replaceChildren(...items.map(({ note, detail }) => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    const name = document.createElement('span');
    const result = document.createElement('span');
    button.type = 'button';
    name.textContent = `${barLabel(note.measure)} · ${midiName(note.midi)}`;
    result.textContent = detail;
    button.append(name, result);
    button.addEventListener('click', () => {
      jumpToBar(note.measure);
      barSelect.focus({ preventScroll: true });
      byId('score-heading').scrollIntoView({ block: 'nearest' });
    });
    row.append(button);
    return row;
  }));
  retry.onclick = async () => {
    if (state.opening || state.mic) return;
    jumpToIndex(take.startIndex);
    barSelect.value = String(take.startBar);
    endBarSelect.value = take.endBar;
    modeSelect.value = take.bpm === null ? 'free' : 'timed';
    byId('bpm-field').hidden = take.bpm === null;
    if (take.bpm !== null) byId('bpm').value = String(take.bpm);
    await startListening();
    if (state.mic) listen.focus();
  };
}

function stopListening({ report = true, complete = false } = {}) {
  const take = state.take;
  const cancelled = Boolean(state.countIn && performance.now() < state.countIn.downbeat);
  state.mic?.stop();
  state.mic = null;
  state.take = null;
  state.countIn = null;
  if (complete) {
    state.completed = true;
    barSelect.value = String(take.startBar);
  }
  if (take) updateEndBars(complete ? take.startIndex : state.index);
  byId('count').hidden = true;
  showListening();
  micLabel(complete ? 'Passage complete' : 'Microphone off');
  text('detected-note', '—');
  if (take && report) showResults(take, cancelled);
  refreshScore();
}

function jumpToIndex(index, keepPage = false) {
  if (!state.score) return;
  if (state.mic) stopListening();
  clearTimeout(state.matchTimer);
  state.matched = null;
  state.completed = false;
  state.index = index;
  const note = state.score.notes[index];
  if (!keepPage) state.page = note.page;
  barSelect.value = String(note.measure);
  updateEndBars(index);
  refreshScore();
}

function jumpToBar(measure) {
  if (!state.score) return;
  const index = state.score.notes.findIndex((note) => note.measure >= measure);
  if (index < 0) return;
  jumpToIndex(index);
  barSelect.value = String(measure);
}

function goToPage(delta) {
  if (!state.score) return;
  const page = state.page + delta;
  if (page < 1 || page > state.score.pages.length) return;
  state.page = page;
  const index = state.score.notes.findIndex((note) => note.page === page);
  if (!state.mic && index >= 0) jumpToIndex(index, true);
  else refreshScore();
}

function signalUpdate(pitch, level) {
  const now = performance.now();
  const count = state.countIn;
  if (count && now < count.downbeat) {
    text('count', String(Math.max(1, Math.min(4, Math.floor((now - count.start) / count.beatMs) + 1))));
    return;
  }
  byId('count').hidden = true;
  if (pitch) {
    state.lastSignal = now;
    text('detected-note', midiName(pitch.midi));
    micLabel('Listening', 'active');
  } else if (now - state.lastSignal > 250) {
    text('detected-note', '—');
    micLabel(level > 0.015 ? 'Waiting for a clear note' : 'Listening · waiting for a note', 'active');
  }
}

function receiveNote({ midi, at }) {
  const take = state.take;
  if (!take) return;
  const result = acceptNote(take, midi, at);
  if (result.type !== 'matched') return;
  state.matched = result.note;
  state.page = result.note.page;
  state.index = take.cursor;
  clearTimeout(state.matchTimer);
  state.matchTimer = setTimeout(() => {
    state.matched = null;
    refreshScore();
  }, 460);
  if (take.cursor === take.endIndex) {
    stopListening({ complete: true });
  } else {
    barSelect.value = String(take.notes[take.cursor].measure);
    refreshScore();
  }
}

async function startListening() {
  if (!state.score || state.opening) return;
  if (state.completed) jumpToBar(Number(barSelect.value));
  const bpmField = byId('bpm');
  const bpm = modeSelect.value === 'timed' ? Number(bpmField.value) : null;
  if (modeSelect.value === 'timed' && !bpmField.reportValidity()) return;
  const score = state.score;
  state.opening = true;
  showListening();
  micLabel('Requesting microphone access…');
  try {
    const mic = await openMicrophone();
    if (score !== state.score) {
      mic.stop();
      micLabel('Microphone off');
      return;
    }
    state.mic = mic;
    byId('results').hidden = true;
    const current = state.score.notes[state.index];
    const startBar = state.score.bars[Number(barSelect.value)];
    const firstOfBar = state.score.notes.findIndex((note) => note.measure >= startBar.index) === state.index;
    const endBar = endBarSelect.value;
    const firstBeyondEnd = endBar === '' ? -1 : score.notes.findIndex((note) => note.measure > Number(endBar));
    const endIndex = firstBeyondEnd === -1 ? score.notes.length : firstBeyondEnd;
    const startBeat = firstOfBar ? startBar.beat : current.beat;
    state.countIn = bpm ? scheduleCountIn(mic.context, bpm) : null;
    state.take = {
      ...createTake(score.notes, state.index, startBeat, bpm, state.countIn?.downbeat ?? null, endIndex),
      startBar: startBar.index,
      endBar,
    };
    state.lastSignal = 0;
    byId('count').hidden = !bpm;
    micLabel(bpm ? 'Count-in · get ready' : 'Listening · waiting for a note', 'active');
    mic.monitor(signalUpdate, receiveNote);
  } catch (error) {
    const message = {
      NotAllowedError: 'Microphone permission denied. Allow access and try again.',
      NotFoundError: 'No microphone was found.',
      NotReadableError: 'The microphone is busy or unavailable.',
    }[error.name] || error.message || 'The microphone could not be started.';
    micLabel(message, 'error-dot');
  } finally {
    state.opening = false;
    showListening();
    refreshScore();
  }
}

function mount(score, pdf = null, convertedXML = null) {
  stopListening({ report: false });
  byId('results').hidden = true;
  retry.onclick = null;
  state.score = score;
  state.shownPage = null;
  state.shownPreview = null;
  if (state.pdfURL) URL.revokeObjectURL(state.pdfURL);
  state.pdfURL = pdf ? URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' })) : null;
  const pdfLink = byId('original-pdf');
  pdfLink.hidden = !state.pdfURL;
  pdfLink.href = state.pdfURL || '#';
  if (state.musicXMLURL) URL.revokeObjectURL(state.musicXMLURL);
  state.musicXMLURL = convertedXML
    ? URL.createObjectURL(new Blob([convertedXML], { type: 'application/vnd.recordare.musicxml+xml' }))
    : null;
  const musicXMLLink = byId('download-musicxml');
  musicXMLLink.hidden = !state.musicXMLURL;
  musicXMLLink.href = state.musicXMLURL || '#';
  if (convertedXML) musicXMLLink.download = `${score.title || 'score'}.musicxml`;
  const label = score.sample ? 'Sample score' : 'Imported score';
  text('score-heading', score.title);
  text('paper-title', score.title);
  text('paper-subtitle', score.sample ? 'A short study for solo melody' : '');
  const count = score.pages.length;
  text('score-meta', `${label} · ${count} ${count === 1 ? 'page' : 'pages'}`);
  const lastBar = score.notes.at(-1).measure;
  const practiceBars = score.bars.slice(0, lastBar + 1);
  barSelect.replaceChildren(...practiceBars.map((bar) => new Option(barLabel(bar.index), bar.index)));
  endBarSelect.replaceChildren(new Option('End of score', ''), ...practiceBars.map((bar) => new Option(barLabel(bar.index), bar.index)));
  jumpToIndex(0);
  showListening();
}

async function loadSample() {
  const request = ++state.loading;
  byId('load-sample').disabled = true;
  try {
    const response = await fetch('./assets/morning-lines.musicxml');
    if (!response.ok) throw new Error('The sample could not be downloaded.');
    const score = await engrave(await response.text(), { sample: true });
    if (request === state.loading) mount(score);
  } catch (error) {
    if (request !== state.loading) return;
    if (state.score) micLabel('The sample could not be loaded. Please try again.', 'error-dot');
    else notation.querySelector('.score-message').textContent = 'The sample could not be loaded. Select Load sample to try again.';
    console.error(error);
  } finally {
    byId('load-sample').disabled = false;
  }
}

async function importFiles(files) {
  if (!files.length) return;
  const request = ++state.loading;
  const pdf = files.find((file) => /\.pdf$/i.test(file.name));
  let musicXML = files.find((file) => /\.(musicxml|xml|mxl)$/i.test(file.name));
  let convertedXML = null;
  uploadError.hidden = true;
  if (!musicXML && !pdf) {
    uploadError.textContent = 'Choose a MusicXML, XML, MXL or PDF score.';
    uploadError.hidden = false;
    return;
  }
  dropzone.setAttribute('aria-busy', 'true');
  const label = dropzone.querySelector('strong');
  label.textContent = pdf && !musicXML ? 'Uploading and converting PDF…' : 'Opening score…';
  try {
    let xml;
    if (musicXML) {
      xml = await musicXMLFromFile(musicXML);
    } else {
      if (pdf.size > 20 * 1024 * 1024) throw new Error('Choose a PDF smaller than 20 MB.');
      const body = new FormData();
      body.append('file', pdf);
      const response = await fetch('/api/convert', { method: 'POST', body });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'PDF conversion failed.');
      xml = result.musicxml;
      convertedXML = xml;
    }
    const scoreName = musicXML?.name.replace(/\.[^.]+$/, '') || pdf.name.replace(/\.pdf$/i, '');
    const score = await engrave(xml, { name: scoreName });
    if (request !== state.loading) return;
    mount(score, pdf, convertedXML);
    uploadDialog.close();
  } catch (error) {
    if (request !== state.loading) return;
    uploadError.textContent = error.message || 'This score could not be opened.';
    uploadError.hidden = false;
  } finally {
    dropzone.removeAttribute('aria-busy');
    label.textContent = 'Choose a file or drop it here';
  }
}

listen.addEventListener('click', () => state.mic ? stopListening() : void startListening());
barSelect.addEventListener('change', () => jumpToBar(Number(barSelect.value)));
endBarSelect.addEventListener('change', showPreview);
modeSelect.addEventListener('change', () => { byId('bpm-field').hidden = modeSelect.value !== 'timed'; });
byId('prev-page').addEventListener('click', () => goToPage(-1));
byId('next-page').addEventListener('click', () => goToPage(1));
byId('prev-note').addEventListener('click', () => jumpToIndex(state.index - 1));
byId('next-note').addEventListener('click', () => jumpToIndex(state.index + 1));
byId('load-sample').addEventListener('click', () => void loadSample());
for (const button of document.querySelectorAll('[data-help]')) {
  button.addEventListener('click', () => byId('help-dialog').showModal());
}
byId('open-upload').addEventListener('click', () => {
  uploadError.hidden = true;
  uploadDialog.showModal();
});
scoreFile.addEventListener('change', () => {
  void importFiles([...scoreFile.files]);
  scoreFile.value = '';
});
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  void importFiles([...event.dataTransfer.files]);
});
notation.addEventListener('click', (event) => {
  if (state.mic || !state.score) return;
  const id = event.target.closest('.note')?.id;
  const index = state.score.notes.findIndex((note) => note.id === id);
  if (index >= 0) jumpToIndex(index);
});
window.addEventListener('pagehide', () => { if (state.mic) stopListening({ report: false }); });
void loadSample();
