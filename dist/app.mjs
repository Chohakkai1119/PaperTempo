import { clearMarks, engrave, markNote, markResult, midiName, musicXMLFromFile, notationElement, shiftMusicXMLOctaves } from './score.mjs';
import { FOLLOW_COUNT_IN, countdownNumber, openMicrophone, scheduleCountIn } from './audio.mjs';
import { INPUT_PROFILES, resolveInputProfile } from './input-profiles.mjs';
import { captureProblem, createMicrophoneDiagnostics } from './microphone-diagnostics.mjs';
import { INSTRUMENTS } from './instruments.mjs';
import { createPlayback, InstrumentSampleError } from './playback.mjs';
import { VISIBLE_ROWS, clampWindowTop, windowRows, windowTopForRow } from './rows.mjs';
import {
  acceptPerformance, advancePerformance, completedTakeSummary, createTake, mistakePassage,
  restartSettings, samePracticePassage, summarize, timingTolerance, updateInputHealth, visibleDownbeat,
} from './practice.mjs';

// An attack may arrive after its sample frame while pitch evidence stabilizes.
const DETECTION_GRACE_MS = 190;
// Allow a slightly early entrance once the last count-in click has finished.
const COUNT_IN_GRACE_MS = 140;

const byId = (id) => document.getElementById(id);
const text = (id, value) => {
  const element = byId(id);
  if (element.textContent !== value) element.textContent = value;
};
const state = {
  score: null, index: 0, page: 1, shownPage: null, shownPreview: null,
  mic: null, opening: false, micRequest: 0, take: null,
  countIn: null, pdfURL: null, musicXMLURL: null, loading: 0, completed: false,
  review: null, completedTakes: [], playbackRun: null, clockPosition: null,
  viewTop: 0, positionRow: null, rowBounds: null, rowWindowShown: false,
  lastTakeSettings: null, renderedResults: null, renderedRevision: null,
  sourceXML: null, sourcePDF: null, convertedXML: null, octaveShift: 0,
};
const notation = byId('notation');
const preview = byId('preview-notation');
const barSelect = byId('start-bar');
const endBarSelect = byId('end-bar');
const modeSelect = byId('practice-mode');
const followingSelect = byId('following-mode');
const passageProgress = byId('passage-progress');
const bpmField = byId('bpm');
const instrumentSelect = byId('playback-instrument');
instrumentSelect.replaceChildren(...Object.entries(INSTRUMENTS).map(([id, { label }]) => new Option(label, id)));
const inputInstrument = byId('input-instrument');
inputInstrument.replaceChildren(...Object.entries(INPUT_PROFILES).map(([id, { label }]) => new Option(label, id)));
inputInstrument.value = 'general';
const tuningInput = byId('input-tuning');
const testMic = byId('test-microphone');
const diagnostics = createMicrophoneDiagnostics({ byId, text });
const listen = byId('listen');
const playbackToggle = byId('playback-toggle');
const playbackStop = byId('playback-stop');
const retry = byId('retry');
const restartTakeButton = byId('restart-take');
const countInToggle = byId('count-in');
const scorePanel = document.querySelector('.score-panel');
const fullscreenButton = byId('fullscreen-toggle');
const practiseMistake = byId('practise-mistake');
const scoreFile = byId('score-file');
const pdfConverterFrame = byId('pdf2music-frame');
const uploadDialog = byId('upload-dialog');
const uploadError = byId('upload-error');
let pdfConversionActive = false;
let pdfConversionSequence = 0;
const dropzone = byId('dropzone');
const playback = createPlayback({
  onNote(note) {
    const run = state.playbackRun;
    if (!run) return;
    run.note = note;
    if (note) {
      run.position = note;
      state.page = note.page;
    }
    refreshScore();
  },
  onEnd() {
    stopPlayback('Playback finished');
  },
});

function barLabel(index) {
  return 'Bar ' + state.score.bars[index].label;
}

function updateOctaveControls() {
  const label = byId('octave-shift-label');
  if (!label) return;
  label.textContent = `Octave ${state.octaveShift > 0 ? '+' : ''}${state.octaveShift}`;
  byId('octave-down').disabled = !state.sourceXML || state.opening || Boolean(state.mic || state.playbackRun) || state.octaveShift <= -3;
  byId('octave-up').disabled = !state.sourceXML || state.opening || Boolean(state.mic || state.playbackRun) || state.octaveShift >= 3;
  byId('octave-reset').disabled = !state.sourceXML || state.opening || Boolean(state.mic || state.playbackRun) || state.octaveShift === 0;
}

async function shiftOctave(amount) {
  if (!state.sourceXML || state.opening || state.mic || state.playbackRun) return;
  const nextShift = state.octaveShift + amount;
  if (nextShift < -3 || nextShift > 3) return;
  state.opening = true;
  updateOctaveControls();
  try {
    const shiftedXML = shiftMusicXMLOctaves(state.sourceXML, nextShift);
    const score = await engrave(shiftedXML, { sample: state.score.sample, name: state.score.title });
    mount(score, state.sourcePDF, state.convertedXML, state.sourceXML, nextShift);
  } catch (error) {
    micLabel(error.message || 'The score could not be shifted.', 'error-dot');
  } finally {
    state.opening = false;
    updateOctaveControls();
    refreshPracticeControls();
  }
}

function loadPageMarkup() {
  const score = state.score;
  if (state.page !== state.shownPage) {
    // The page sits in a track that slides inside a window showing VISIBLE_ROWS rows.
    const frame = document.createElement('div');
    const track = document.createElement('div');
    frame.className = 'row-window';
    track.className = 'row-track';
    track.append(notationElement(score.pages[state.page - 1]));
    frame.append(track);
    notation.replaceChildren(frame);
    notation.scrollLeft = 0;
    state.shownPage = state.page;
    state.renderedRevision = Symbol();
    state.rowBounds = null;
    state.positionRow = null;
    state.rowWindowShown = false;
  }
}

function pageRowInfo() {
  return state.score.pageRows?.[state.page - 1] ?? { first: 0, count: 0 };
}

// Row edges in CSS pixels, measured from the rendered systems (re-measured on resize).
function measureRows() {
  const track = notation.querySelector('.row-track');
  if (!track) return;
  const base = track.getBoundingClientRect().top;
  state.rowBounds = [...track.querySelectorAll('g.system')].map((system) => {
    const box = system.getBoundingClientRect();
    return { top: box.top - base, bottom: box.bottom - base };
  });
  state.trackHeight = track.getBoundingClientRect().height;
}

function applyRowWindow() {
  const frame = notation.querySelector('.row-window');
  const track = frame?.querySelector('.row-track');
  if (!track) return;
  if (!state.rowBounds) measureRows();
  const rows = state.rowBounds;
  const count = rows.length;
  if (!count || !state.trackHeight) return;
  const top = clampWindowTop(state.viewTop, count);
  state.viewTop = top;
  const end = top + VISIBLE_ROWS;
  const from = top === 0 ? 0 : (rows[top - 1].bottom + rows[top].top) / 2;
  const to = end >= count ? state.trackHeight : (rows[end - 1].bottom + rows[end].top) / 2;
  frame.classList.toggle('is-instant', !state.rowWindowShown);
  frame.style.height = `${Math.ceil(to - from)}px`;
  track.style.transform = `translateY(${-from}px)`;
  state.rowWindowShown = true;
}

/** Scroll the window by whole rows; past either end, move to the neighbouring page (long scores). */
function scrollRows(delta) {
  if (!state.score || state.playbackRun || state.clockPosition) return;
  const { count } = pageRowInfo();
  const top = state.viewTop + delta;
  if (top !== clampWindowTop(top, count)) return void goToPage(delta);
  state.viewTop = top;
  refreshScore();
}

let observedWidth = 0;
new ResizeObserver(() => {
  // Only width changes rescale the music; height changes come from the window itself.
  if (notation.clientWidth === observedWidth) return;
  observedWidth = notation.clientWidth;
  if (!state.score || !notation.querySelector('.row-track')) return;
  state.rowBounds = null;
  const shown = state.rowWindowShown;
  state.rowWindowShown = false; // re-fit without animating
  applyRowWindow();
  state.rowWindowShown = shown;
}).observe(notation);

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
  const run = state.playbackRun;
  const index = run ? notes.indexOf(run.position) : state.index;
  const visible = Boolean((run || !state.completed) && initial && nextPage <= pages.length
    && (endBar === '' || initial.measure <= Number(endBar)) && index >= Math.max(0, lastOnPage - 3));
  byId('page-preview').hidden = !visible;
  if (!visible || state.shownPreview === nextPage) return;
  const openingBar = state.score.bars[initial.measure].label;
  text('preview-label', `· Page ${nextPage} · Bar ${openingBar}`);
  preview.replaceChildren(notationElement(pages[nextPage - 1], true));
  state.shownPreview = nextPage;
}

const toneNames = (note) => (note.pitches ?? [note]).map(({ midi }) => midi)
  .sort((a, b) => a - b).map(midiName).join(' + ');

function reviewItem(result) {
  const { note, delta, heardMidi } = result;
  const status = result.status === 'correct' && !Number.isFinite(delta) ? 'pitch-only' : result.status;
  const detail = {
    correct: Number.isFinite(result.gradedDelta) && Math.abs(result.gradedDelta - delta) >= 1
      ? 'Correct pitch within strum allowance' : 'Correct pitch within timing window',
    'pitch-only': 'Correct pitch · timing unscored',
    timing: 'Correct pitch',
    wrong: Number.isFinite(heardMidi) ? `Expected ${midiName(note.midi)}, heard ${midiName(heardMidi)}` : 'Wrong pitch',
    missed: 'Missed',
    unassessable: 'Insufficient audio evidence',
    unattempted: 'Unattempted',
    pending: 'Awaiting evidence',
  }[status] ?? 'Unassessed';
  const timing = Number.isFinite(delta) && ['correct', 'timing'].includes(status)
    ? Math.abs(delta) < 0.5 ? ' · 0 ms' : ` · ${Math.round(Math.abs(delta))} ms ${delta < 0 ? 'early' : 'late'}` : '';
  return { ...result, detail: detail + timing, kind: status };
}

function refreshReview() {
  const review = state.playbackRun ? null : state.review;
  const take = state.playbackRun ? null : state.take;
  const source = take || review;
  const revision = take?.revision ?? review?.selected;
  const changed = state.renderedResults !== source || state.renderedRevision !== revision;
  if (changed) {
    if (state.renderedResults !== source) clearMarks(notation);
    const items = take ? [...take.results.values()].map(reviewItem) : review?.items ?? [];
    // A repeat returns to the same printed notehead. Show its latest occurrence.
    const visible = new Map();
    for (const item of items) {
      if (item.kind === 'unattempted') continue;
      for (const tone of [item.note, ...(item.note.continuations ?? [])]) {
        if (tone.page === state.page) visible.set(tone.id, { ...item, note: tone });
      }
    }
    for (const tone of [review?.selected?.note, ...(review?.selected?.note.continuations ?? [])]) {
      if (tone?.page === state.page && review.selected.kind !== 'unattempted') {
        visible.set(tone.id, { ...review.selected, note: tone, selected: true });
      }
    }
    for (const item of visible.values()) {
      if (item.kind === 'unattempted') continue;
      markResult(notation, { ...item, detail: `${midiName(item.note.midi)} · ${item.detail}` }, item.selected);
    }
    state.renderedResults = source;
    state.renderedRevision = revision;
  }
  const selected = review?.selected;
  byId('score-review').hidden = !selected;
  if (!selected) return;
  const { startBar, endBar } = mistakePassage(review.take, selected.note.measure);
  const { bars } = state.score;
  text('score-review-detail', `${barLabel(selected.note.measure)} · ${midiName(selected.note.midi)} · ${selected.detail}`);
  text('practise-mistake', startBar === endBar
    ? `Practise bar ${bars[startBar].label}`
    : `Practise bars ${bars[startBar].label}–${bars[endBar].label}`);
}

function refreshScore() {
  if (!state.score) return;
  const { notes, pages } = state.score;
  const run = state.playbackRun;
  const clock = state.clockPosition;
  const next = state.completed ? null : notes[state.index];
  const position = run?.position || next || notes[state.index - 1];
  const highlighted = run ? run.note : !clock || clock.noteActive ? next : null;
  loadPageMarkup();
  clearMarks(notation, { results: false });
  refreshReview();
  const heads = highlighted ? (highlighted.pitches ?? [highlighted])
    .filter(({ page }) => page === state.page)
    .map(({ id }) => markNote(notation, id, run ? 'playback' : 'expected')) : [];
  trackNoteVisibility(heads.find(Boolean));

  // Follow the player: when their position moves to another row, re-aim the window so
  // that row is second from the top (it starts moving once they reach the 3rd row).
  // Between row changes the window stays put, so manual row scrolling is respected.
  const rowInfo = pageRowInfo();
  if (position.page === state.page && position.row !== undefined) {
    const localRow = position.row - rowInfo.first;
    if (localRow !== state.positionRow) {
      state.positionRow = localRow;
      state.viewTop = windowTopForRow(localRow, rowInfo.count);
    }
  }
  applyRowWindow();
  const { first, last } = windowRows(state.viewTop, rowInfo.count);
  const rowsText = rowInfo.count <= VISIBLE_ROWS
    ? `${state.score.rowCount} ${state.score.rowCount === 1 ? 'row' : 'rows'}`
    : `Rows ${rowInfo.first + first + 1}–${rowInfo.first + last + 1} of ${state.score.rowCount}`;
  text('page-label', pages.length > 1 ? `${rowsText} · Page ${state.page} of ${pages.length}` : rowsText);
  const beat = clock ? ` · Beat ${clock.beatInBar}` : '';
  text('position', `${barLabel(clock?.measure ?? position.measure)}${beat} · Row ${position.row + 1}`);
  text('expected-note', run ? '—' : highlighted ? toneNames(highlighted) : clock ? 'Rest' : '—');
  passageProgress.hidden = !clock;
  byId('prev-page').disabled = (state.viewTop <= 0 && state.page <= 1) || Boolean(run || clock);
  byId('next-page').disabled = (state.viewTop >= clampWindowTop(Infinity, rowInfo.count) && state.page >= pages.length) || Boolean(run || clock);
  byId('prev-note').disabled = state.index <= 0 || Boolean(state.mic || run);
  byId('next-note').disabled = state.index >= notes.length - 1 || Boolean(state.mic || run);
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

function refreshPracticeControls() {
  const live = Boolean(state.mic);
  const run = state.playbackRun;
  listen.classList.toggle('is-listening', live);
  listen.querySelector('use').setAttribute('href', live ? '#i-stop' : '#i-mic');
  listen.querySelector('span').textContent = live ? 'Stop listening' : 'Start listening';
  listen.disabled = state.opening || !state.score || Boolean(run) || (live && !state.take);
  testMic.disabled = Boolean(run || state.opening || state.take);
  text('test-microphone', live && !state.take ? 'Stop microphone test' : 'Test microphone');
  inputInstrument.disabled = diagnostics.select.disabled = tuningInput.disabled = Boolean(live || state.opening);
  endBarSelect.disabled = live || listen.disabled;
  barSelect.disabled = Boolean(run || live || state.opening);
  bpmField.disabled = Boolean(run || live || state.opening);
  instrumentSelect.disabled = Boolean(run);
  followingSelect.disabled = Boolean(run || live || state.opening);
  modeSelect.disabled = followingSelect.disabled;
  const keepGoing = followingSelect.value === 'continuous';
  byId('wait-scoring').hidden = keepGoing;
  text('following-hint', keepGoing
    ? 'The cursor holds on the first note until you play, then follows the reference tempo.'
    : 'The cursor waits until you play the expected note or chord.');
  retry.disabled = Boolean(run);
  // In full screen the side panel (with Start listening) is out of view, so this button
  // also starts the first take there; otherwise it appears once a take has run.
  const inFullscreen = (document.fullscreenElement || document.webkitFullscreenElement) === scorePanel;
  const hasTake = live || Boolean(state.lastTakeSettings);
  restartTakeButton.hidden = !(hasTake || inFullscreen);
  restartTakeButton.querySelector('span').textContent = hasTake ? 'Restart' : 'Start';
  restartTakeButton.title = hasTake ? 'Restart this take (R)' : 'Start listening (R)';
  restartTakeButton.disabled = state.opening || Boolean(run);
  countInToggle.disabled = live || state.opening;
  playbackToggle.disabled = !state.score || live || state.opening || run?.status === 'starting';
  playbackStop.disabled = !run;
  text('playback-toggle', run?.status === 'paused' ? 'Resume playback'
    : run?.status === 'playing' ? 'Pause playback' : 'Hear this passage');
  updateOctaveControls();
}

function stopPlayback(message = 'Playback stopped') {
  const run = state.playbackRun;
  if (!run) return;
  state.playbackRun = null;
  playback.stop();
  state.page = run.previousPage;
  text('playback-status', message);
  refreshPracticeControls();
  refreshScore();
}

async function togglePlayback() {
  const score = state.score;
  let run = state.playbackRun;
  if (!score || state.mic || state.opening || run?.status === 'starting') return;
  if (run?.status === 'playing') {
    playback.pause();
    run.status = 'paused';
    text('playback-status', 'Playback paused');
    refreshPracticeControls();
    return;
  }

  const resuming = Boolean(run);
  let range;
  if (!run) {
    if (!bpmField.reportValidity()) return;
    const startBar = Number(barSelect.value);
    const position = score.notes.find((note) => note.measure >= startBar);
    if (!position) return;
    const nextBar = endBarSelect.value === '' ? null : score.bars[Number(endBarSelect.value) + 1];
    range = {
      startBeat: score.bars[startBar].beat,
      endBeat: nextBar?.beat ?? score.endBeat,
      bpm: Number(bpmField.value),
      instrument: instrumentSelect.value,
    };
    run = { status: 'starting', previousPage: state.page, position, note: null };
    state.playbackRun = run;
    state.page = position.page;
  }
  run.status = 'starting';
  text('playback-status', 'Starting playback…');
  refreshPracticeControls();
  refreshScore();
  try {
    const started = await (resuming ? playback.resume() : playback.play(score.notes, range));
    if (state.playbackRun !== run) return;
    if (!started) {
      stopPlayback('This passage has no notes to play.');
      return;
    }
    run.status = 'playing';
    text('playback-status', 'Playing passage');
    refreshPracticeControls();
  } catch (error) {
    if (state.playbackRun === run) stopPlayback(error instanceof InstrumentSampleError
      ? error.message
      : 'Playback could not start in this browser.');
  }
}

function showComparison(current) {
  const { completedTakes } = state;
  const previous = current && completedTakes.find((entry) => samePracticePassage(entry, current));
  byId('take-comparison').hidden = completedTakes.length === 0;
  byId('comparison-hint').hidden = Boolean(previous);
  byId('comparison-table').hidden = !previous;
  if (current) state.completedTakes = [current, ...completedTakes].slice(0, 2);
  if (!previous) {
    byId('comparison-metrics').replaceChildren();
    text('comparison-hint', current
      ? 'Use the same passage, tempo, and following mode to compare takes.'
      : 'Finish the passage to compare takes.');
    return;
  }
  const rows = [['Pitch accuracy', `${previous.pitch}%`, `${current.pitch}%`]];
  if (previous.overall !== null && current.overall !== null) {
    rows.unshift(['Overall accuracy', `${previous.overall}%`, `${current.overall}%`]);
    rows.push(['Rhythm', `${previous.rhythm}%`, `${current.rhythm}%`]);
    if (previous.beatTiming !== null && current.beatTiming !== null) {
      rows.push(['Beat timing', `${previous.beatTiming}%`, `${current.beatTiming}%`]);
    }
    if (previous.spacing !== null && current.spacing !== null) {
      rows.push(['Note spacing', `${previous.spacing}%`, `${current.spacing}%`]);
    }
  }
  rows.push(['Missed notes', previous.missed, current.missed]);
  byId('comparison-metrics').replaceChildren(...rows.map(([label, before, after]) => {
    const row = document.createElement('tr');
    const heading = document.createElement('th');
    heading.scope = 'row';
    heading.textContent = label;
    const earlier = document.createElement('td');
    earlier.textContent = String(before);
    const latest = document.createElement('td');
    latest.textContent = String(after);
    row.append(heading, earlier, latest);
    return row;
  }));
}

async function practise({ startIndex, startBar, endBar, bpm, following, countInEnabled }) {
  if (state.opening || state.mic || state.playbackRun) return;
  jumpToIndex(startIndex);
  barSelect.value = String(startBar);
  endBarSelect.value = String(endBar);
  followingSelect.value = following;
  if (typeof countInEnabled === 'boolean') countInToggle.checked = countInEnabled;
  modeSelect.value = bpm === null ? 'free' : 'timed';
  if (bpm !== null) bpmField.value = String(bpm);
  showPreview();
  await startListening();
  if (state.mic) listen.focus();
}

function showResults(take, cancelled) {
  const summary = summarize(take);
  const { bpm } = take;
  const { graded, expected, pitch, rhythm, overall, beatTiming, spacing, unassessable, captureIssue } = summary;
  const awaitingFirstNote = bpm && !Number.isFinite(take.downbeat) && !take.inputHealth.issue;
  const items = cancelled || awaitingFirstNote ? [] : summary.results.map(reviewItem);
  const extraItems = cancelled ? [] : take.extras.map(({ note, midi }) => ({
    note, detail: `Extra pitch · ${midiName(midi)}`, kind: 'extra',
  }));
  const matchedCount = items.filter(({ kind }) => ['correct', 'pitch-only', 'timing'].includes(kind)).length;
  byId('results').hidden = false;
  text('results-summary', cancelled ? 'Count-in cancelled'
    : awaitingFirstNote ? 'No note heard. The take did not start.'
    : unassessable ? `Unassessable attempt. ${captureIssue ?? 'Check the microphone and try again.'}`
    : `${matchedCount} pitches matched · ${graded} assessed · ${expected} expected in passage`);
  const metrics = byId('result-metrics');
  metrics.hidden = cancelled || unassessable || awaitingFirstNote;
  metrics.classList.toggle('has-overall', Boolean(bpm));
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
  const percentage = (value) => value == null ? '—' : `${value}%`;
  if (bpm) metric('Overall accuracy', percentage(overall));
  metric('Pitch accuracy', percentage(pitch));
  if (bpm) {
    metric('Rhythm', percentage(rhythm));
    metric('Beat timing', percentage(beatTiming));
    metric('Note spacing', percentage(spacing));
  }
  byId('timing-detail').hidden = metrics.hidden;
  text('timing-detail', bpm
    ? `Matched notes within ±${Math.round(timingTolerance(bpm))} ms earn full beat-timing credit. Overall weights pitch at 60% and rhythm at 40%.`
    : 'Free tempo grades pitch only.');
  const count = (kind) => items.filter((item) => item.kind === kind).length;
  const early = items.filter(({ kind, delta }) => kind === 'timing' && delta < 0).length;
  const timing = count('timing');
  const chordSets = new Map();
  for (const item of items) {
    const id = item.index;
    const set = chordSets.get(id) ?? [];
    set.push(item);
    chordSets.set(id, set);
  }
  const chords = [...chordSets.values()].filter((tones) => tones.length > 1
    && tones.some(({ kind }) => !['unassessable', 'unattempted'].includes(kind)));
  const completeChords = chords.filter((tones) => tones.every(({ kind }) => ['correct', 'pitch-only', 'timing'].includes(kind))).length;
  const chordDetail = chords.length ? ` · ${completeChords}/${chords.length} chords with every tone matched` : '';
  text('result-counts', metrics.hidden ? '' : `${count('correct') + count('pitch-only')} correct · ${early} early · ${timing - early} late · ${count('wrong')} wrong · ${count('missed')} missed · ${extraItems.length} extra${chordDetail}`);

  const byIdMap = new Map();
  for (const item of items) {
    for (const note of [item.note, ...(item.note.continuations ?? [])]) {
      if (item.kind !== 'unattempted' || !byIdMap.has(note.id)) byIdMap.set(note.id, item);
    }
  }
  state.review = items.length ? { take, items, byId: byIdMap, selected: null } : null;

  function selectItem(item, focus) {
    if (!item.note || !state.review) return;
    const { note } = item;
    state.review.selected = item;
    jumpToIndex(item.index ?? state.score.notes.findIndex((group) => group.beat === note.beat && group.measure === note.measure));
    if (state.page !== note.page) state.page = note.page;
    refreshScore();
    trackNoteVisibility(notation.querySelector(`#${CSS.escape(note.id)}`));
    if (focus) {
      practiseMistake.focus({ preventScroll: true });
      byId('score-review').scrollIntoView({ block: 'nearest' });
    }
  }

  const allItems = [...items, ...extraItems].sort((a, b) => (a.note?.beat ?? Infinity) - (b.note?.beat ?? Infinity));
  byId('result-list').replaceChildren(...allItems.map((item) => {
    const { note, detail, kind } = item;
    const row = document.createElement('li');
    const button = document.createElement('button');
    const name = document.createElement('span');
    const result = document.createElement('span');
    button.type = 'button';
    button.className = `result-${kind}`;
    button.disabled = !note || kind === 'extra';
    name.textContent = note ? `${barLabel(note.measure)}${kind === 'extra' ? '' : ` · ${midiName(note.midi)}`}` : 'Outside note window';
    result.textContent = detail;
    button.append(name, result);
    button.addEventListener('click', () => selectItem(item, true));
    row.append(button);
    return row;
  }));

  const byMeasure = new Map();
  for (const item of allItems) {
    if (!item.note || ['unassessable', 'unattempted'].includes(item.kind)) continue;
    const measure = item.note.measure;
    const bar = byMeasure.get(measure) ?? { assessed: 0, errors: 0, largest: null, item };
    const mistake = ['timing', 'wrong', 'missed', 'extra'].includes(item.kind);
    bar.assessed += Number(item.kind !== 'extra');
    bar.errors += Number(mistake);
    if (mistake && item.kind !== 'extra') bar.item = item;
    if (Number.isFinite(item.delta) && Math.abs(item.delta) > Math.abs(bar.largest?.delta ?? 0)) bar.largest = item;
    byMeasure.set(measure, bar);
  }
  byId('bar-review').hidden = metrics.hidden || !byMeasure.size;
  byId('bar-results').replaceChildren(...[...byMeasure].sort((a, b) => b[1].errors - a[1].errors || a[0] - b[0])
    .map(([measure, bar]) => {
      const row = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const offset = bar.largest ? ` · largest offset ${midiName(bar.largest.note.midi)} ${Math.round(Math.abs(bar.largest.delta))} ms ${bar.largest.delta < 0 ? 'early' : 'late'}` : '';
      button.textContent = `${barLabel(measure)} · ${bar.errors} issues across ${bar.assessed} assessed notes${offset}`;
      button.addEventListener('click', () => selectItem(bar.item, true));
      row.append(button);
      return row;
    }));
  showComparison(cancelled || unassessable ? null : completedTakeSummary(take, summary));
  retry.onclick = () => restartTake();
  setupCoach(take, cancelled || unassessable || awaitingFirstNote);
}

// ---- Practice coach: POST measured numbers (never audio) to /api/drill.
// Agreed shape only: { piece, bars: [{ bar, missedNotes, timingOffsetsMs }] }.
// Extra (wrong) notes are deliberately left out; the server treats offsets
// beyond ±2000 ms as a late start rather than a timing error.

let coachRequest = 0;

function coachPayload(take) {
  const { bars } = state.score;
  const perBar = new Map();
  const entry = (note) => {
    if (!perBar.has(note.measure)) perBar.set(note.measure, { bar: bars[note.measure].label, missedNotes: 0, timingOffsetsMs: [] });
    return perBar.get(note.measure);
  };
  for (const { note, status, delta } of take.results.values()) {
    if (status === 'missed' || status === 'wrong') entry(note).missedNotes += 1;
    if (Number.isFinite(delta) && ['correct', 'timing'].includes(status)) entry(note).timingOffsetsMs.push(Math.round(delta));
  }
  const measures = [...perBar.keys()].sort((a, b) => a - b);
  return {
    piece: (state.score.title || 'Untitled score').slice(0, 120),
    bars: measures.map((measure) => perBar.get(measure)),
  };
}

function setupCoach(take, cancelled) {
  const coach = byId('coach');
  const ask = byId('coach-ask');
  const label = ask.querySelector('span');
  const resultBox = byId('coach-result');
  const errorBox = byId('coach-error');
  const score = state.score;
  coachRequest += 1;
  resultBox.hidden = true;
  errorBox.hidden = true;
  ask.disabled = false;
  ask.removeAttribute('aria-busy');
  label.textContent = 'What should I practise next?';

  const payload = take.bpm && !cancelled ? coachPayload(take) : null;
  coach.hidden = !payload || payload.bars.length === 0;
  if (coach.hidden) return;

  ask.onclick = async () => {
    const request = ++coachRequest;
    ask.disabled = true;
    ask.setAttribute('aria-busy', 'true');
    label.textContent = 'Finding a drill…';
    errorBox.hidden = true;
    resultBox.hidden = true;
    try {
      const response = await fetch('/api/drill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
      const data = await response.json().catch(() => null);
      if (request !== coachRequest || score !== state.score) return;
      if (!response.ok || !data?.drill) {
        throw new Error(response.status === 429
          ? 'You have asked a few times in a row. Wait a minute, then try again.'
          : response.status === 404
            ? 'The practice coach is not running here. Start the site with npm run dev to use it locally.'
            : 'The practice coach could not suggest a drill right now. Please try again.');
      }
      const measure = score.bars.findIndex((bar) => bar.label === String(data.targetBar));
      text('coach-target', `Focus on Bar ${data.targetBar}`);
      text('coach-drill', data.drill);
      text('coach-source', data.source === 'cortex' ? 'Coach (Snowflake Cortex)' : 'Quick tip (coach unavailable)');
      const jump = byId('coach-jump');
      jump.hidden = measure < 0;
      jump.onclick = () => {
        if (state.opening || state.mic || score !== state.score) return;
        jumpToBar(measure);
        const end = [...endBarSelect.options].find((option) => option.value === String(measure));
        if (end && !end.disabled) endBarSelect.value = String(measure);
        showPreview();
        barSelect.focus({ preventScroll: true });
        byId('score-heading').scrollIntoView({ block: 'nearest' });
      };
      resultBox.hidden = false;
    } catch (error) {
      if (request !== coachRequest) return;
      const offline = error?.name === 'TimeoutError' || error instanceof TypeError;
      errorBox.textContent = offline ? 'Could not reach the practice coach. Check your connection and try again.' : error.message;
      errorBox.hidden = false;
    } finally {
      if (request === coachRequest) {
        ask.disabled = false;
        ask.removeAttribute('aria-busy');
        label.textContent = 'What should I practise next?';
      }
    }
  };
}

// ---- Count-in overlay, Restart and full screen.

function showCountdown(number) {
  const overlay = byId('countdown');
  overlay.hidden = number === null;
  if (number !== null) text('countdown-number', String(number));
}

/**
 * Restart: discard the running take (or reuse the last take's settings) and go straight
 * back into the count-in with the same start bar, end bar, mode and tempo.
 */
async function restartTake() {
  if (!state.score || state.opening || state.playbackRun) return;
  const settings = state.take ? restartSettings(state.take) : state.lastTakeSettings;
  if (state.mic) stopListening({ report: false });
  if (!settings) return void startListening();
  await practise(settings);
}

const fullscreen = (() => {
  if (document.fullscreenEnabled && scorePanel.requestFullscreen) {
    return {
      enter: () => scorePanel.requestFullscreen().catch(() => {}),
      exit: () => document.exitFullscreen().catch(() => {}),
      element: () => document.fullscreenElement,
      event: 'fullscreenchange',
    };
  }
  if (document.webkitFullscreenEnabled && scorePanel.webkitRequestFullscreen) {
    return {
      enter: () => scorePanel.webkitRequestFullscreen(),
      exit: () => document.webkitExitFullscreen(),
      element: () => document.webkitFullscreenElement,
      event: 'webkitfullscreenchange',
    };
  }
  return null; // e.g. iPhone Safari: the button stays hidden
})();

function toggleFullscreen() {
  if (!fullscreen) return;
  if (fullscreen.element()) fullscreen.exit();
  else fullscreen.enter();
}

function stopListening({ report = true, complete = false, problem } = {}) {
  const take = state.take;
  const now = performance.now();
  const cancelled = Boolean(state.countIn && now < state.countIn.downbeat && !problem);
  if (take && report && !cancelled) {
    if (problem) updateInputHealth(take, now, { available: false, issue: problem });
    advancePerformance(take, now, { finish: true, complete });
    if (complete) state.index = take.endIndex;
    else barSelect.value = String(take.notes[state.index].measure);
  }
  state.mic?.stop();
  state.mic = null;
  state.take = null;
  state.countIn = null;
  state.clockPosition = null;
  if (complete) {
    state.completed = true;
    barSelect.value = String(take.startBar);
  }
  if (take) updateEndBars(complete ? take.startIndex : state.index);
  byId('count').hidden = true;
  showCountdown(null);
  refreshPracticeControls();
  diagnostics.stop(problem ?? 'Microphone off');
  micLabel(problem ?? (complete ? 'Passage complete' : 'Microphone off'), problem ? 'error-dot' : '');
  text('detected-note', '—');
  if (take && report) showResults(take, cancelled);
  refreshScore();
}

function jumpToIndex(index, keepPage = false) {
  if (!state.score) return;
  stopPlayback();
  if (state.mic) stopListening();
  state.completed = false;
  index = Math.min(state.score.notes.length - 1, Math.max(0, index));
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
  if (!state.score || state.playbackRun) return;
  const page = state.page + delta;
  if (page < 1 || page > state.score.pages.length) return;
  state.page = page;
  const index = state.score.notes.findIndex((note) => note.page === page);
  if (!state.mic && index >= 0) jumpToIndex(index, true);
  else refreshScore();
}

function followClock(now) {
  const { take, clockPosition } = state;
  const downbeat = visibleDownbeat(take);
  if (downbeat === null) return false;
  const duration = take.endBeat - take.startBeat;
  const elapsed = Math.min(duration, Math.max(0, (now - downbeat) * take.bpm / 60_000));
  if (Number.isFinite(take.downbeat) && now >= take.downbeat + duration * 60_000 / take.bpm + DETECTION_GRACE_MS) {
    stopListening({ complete: true });
    return true;
  }

  // Keep the visible position inside the selected passage while pending detections finish.
  const beat = Math.min(take.endBeat - 1e-7, take.startBeat + elapsed);
  const { bars, notes } = state.score;
  let index = state.index;
  while (index + 1 < take.endIndex && notes[index + 1].beat <= beat) index += 1;
  const note = notes[index];
  let measure = clockPosition.measure;
  while (bars[measure + 1]?.beat <= beat) measure += 1;
  const beatInBar = Math.floor(beat - bars[measure].beat + 1e-8) + 1;
  const noteActive = note.beat <= beat && beat < note.beat + note.duration;
  passageProgress.value = elapsed / duration;
  if (state.index !== index || state.page !== note.page || clockPosition.measure !== measure
    || clockPosition.beatInBar !== beatInBar || clockPosition.noteActive !== noteActive) {
    state.index = index;
    state.page = note.page;
    state.clockPosition = { measure, beatInBar, noteActive };
    refreshScore();
  }
  return false;
}

function refreshVerdicts(take) {
  const lastExtra = take.extras.at(-1);
  byId('live-extra').hidden = !lastExtra;
  if (lastExtra) text('live-extra', `Extra pitch · ${midiName(lastExtra.midi)}`);
  if (take.following === 'wait' && state.index !== take.cursor) {
    state.page = take.notes[Math.min(take.cursor, take.endIndex - 1)].page;
    state.index = take.cursor;
    if (take.cursor === take.endIndex) return stopListening({ complete: true });
    barSelect.value = String(take.notes[take.cursor].measure);
  }
  refreshScore();
}

function signalUpdate(pitch, _level, reading) {
  const now = performance.now();
  diagnostics.reading(reading, now);
  const take = state.take;
  text('detected-note', reading.pitches.length ? reading.pitches.map(({ midi }) => midiName(midi)).join(' + ') : '—');
  if (!take) return;
  const number = countdownNumber(state.countIn, now);
  if (number !== null) {
    text('count', String(number));
    showCountdown(number);
    return;
  }
  byId('count').hidden = true;
  showCountdown(null);
  const problem = captureProblem(reading);
  const afterCount = !state.countIn || reading.at >= state.countIn.downbeat;
  const revision = take.revision;
  if (afterCount) updateInputHealth(take, reading.at, {
    available: !problem,
    signal: reading.signal,
    uncertain: reading.clipping || (!pitch && reading.rms >= reading.gate
      && !['building-window', 'waiting-for-onset'].includes(reading.reason)),
  });
  advancePerformance(take, reading.at - DETECTION_GRACE_MS);
  if (take.revision !== revision) refreshVerdicts(take);
  if (state.take !== take || (state.clockPosition && followClock(now))) return;

  const downbeat = visibleDownbeat(take);
  const waitingForFirst = take.bpm && downbeat === null;
  const waiting = take.following === 'wait' ? take.notes[take.cursor] : null;
  const quiet = !reading.signal && !take.inputHealth.signalSeen;
  const second = take.notes[take.startIndex + 1];
  const firstGap = state.clockPosition && downbeat !== null && state.index === take.startIndex
    && take.startIndex + 1 < take.endIndex;
  micLabel(problem ?? (waitingForFirst ? 'Play your first note to begin'
    : quiet ? 'No measurable input · check microphone setup'
    : waiting ? `Waiting for ${toneNames(waiting)}`
    : firstGap ? `Next: ${toneNames(second)}`
    : 'Following the score'), problem || (!waitingForFirst && quiet) ? 'error-dot' : 'active');
}

function receiveNote(attack) {
  const take = state.take;
  if (!take || (state.countIn && attack.at < state.countIn.downbeat - COUNT_IN_GRACE_MS)) return;
  const revision = take.revision;
  acceptPerformance(take, attack);
  if (take.revision !== revision) refreshVerdicts(take);
}

function captureState(status) {
  diagnostics.status(status);
  const problem = captureProblem(status);
  if (!problem) return;
  const take = state.take;
  if (take) updateInputHealth(take, performance.now(), { available: false, issue: problem });
  if (status.trackState === 'ended' || !status.streamActive || status.captureStalled || status.contextState !== 'running') {
    return stopListening({ problem });
  }
  micLabel(problem, 'error-dot');
}

function microphoneError(error) {
  const message = {
    NotAllowedError: 'Microphone permission denied. Allow access and try again.',
    NotFoundError: 'No microphone was found. Check the selected input.',
    NotReadableError: 'The microphone is busy or unavailable.',
    OverconstrainedError: 'The selected microphone is unavailable. Choose another input.',
  }[error.name] || error.message || 'The microphone could not be started.';
  diagnostics.stop(message, error.name === 'NotAllowedError' ? 'denied' : undefined);
  micLabel(message, 'error-dot');
}

async function testMicrophone() {
  if (state.take || state.opening || state.playbackRun) return;
  if (state.mic) return stopListening({ report: false });
  if (!tuningInput.reportValidity()) return;
  const request = ++state.micRequest;
  state.opening = true;
  refreshPracticeControls();
  micLabel('Requesting microphone access…');
  try {
    const profile = resolveInputProfile(inputInstrument.value, { tuningA4Hz: Number(tuningInput.value) });
    const mic = await openMicrophone({ deviceId: diagnostics.select.value, profile });
    if (request !== state.micRequest) return mic.stop();
    state.mic = mic;
    micLabel('Testing microphone', 'active');
    mic.monitor(signalUpdate, () => {}, captureState);
    void diagnostics.refreshDevices();
  } catch (error) {
    if (request === state.micRequest) {
      state.mic?.stop();
      state.mic = null;
      microphoneError(error);
    }
  } finally {
    state.opening = false;
    refreshPracticeControls();
  }
}

async function startListening() {
  if (!state.score || state.opening || state.playbackRun || state.mic) return;
  if (!tuningInput.reportValidity()) return;
  if (state.completed) jumpToBar(Number(barSelect.value));
  const following = followingSelect.value;
  const countInEnabled = countInToggle.checked;
  const timed = following === 'continuous' || modeSelect.value === 'timed';
  if (timed && !bpmField.reportValidity()) return;
  const bpm = timed ? Number(bpmField.value) : null;
  const score = state.score;
  const request = ++state.micRequest;
  state.opening = true;
  text('playback-status', '');
  refreshPracticeControls();
  micLabel('Requesting microphone access…');
  try {
    const current = score.notes[state.index];
    const startBar = score.bars[Number(barSelect.value)];
    const firstOfBar = score.notes.findIndex((note) => note.measure >= startBar.index) === state.index;
    const endBar = endBarSelect.value;
    const firstBeyondEnd = endBar === '' ? -1 : score.notes.findIndex((note) => note.measure > Number(endBar));
    const endIndex = firstBeyondEnd === -1 ? score.notes.length : firstBeyondEnd;
    const passage = score.notes.slice(state.index, endIndex);
    const expectedMidis = passage.flatMap((note) => (note.pitches ?? [note]).map(({ midi }) => midi));
    const requiresPolyphony = passage.some((note) => note.pitches?.length > 1);
    const profile = resolveInputProfile(inputInstrument.value, {
      expectedMidis, tuningA4Hz: Number(tuningInput.value), requiresPolyphony,
      preferMonophonic: !requiresPolyphony,
    });
    const mic = await openMicrophone({ deviceId: diagnostics.select.value, profile });
    if (score !== state.score || request !== state.micRequest) {
      mic.stop();
      micLabel('Microphone off');
      return;
    }
    state.mic = mic;
    state.review = null;
    byId('results').hidden = true;
    byId('live-extra').hidden = true;
    const startBeat = firstOfBar ? startBar.beat : current.beat;
    const endBeat = endBar === '' ? score.endBeat : score.bars[Number(endBar) + 1]?.beat ?? score.endBeat;
    const countIn = !countInEnabled ? null : bpm ? { bpm, beats: 4 } : FOLLOW_COUNT_IN;
    state.countIn = countIn ? scheduleCountIn(mic.context, countIn.bpm, countIn.beats) : null;
    state.take = {
      ...createTake(score.notes, state.index, startBeat, bpm, null, endIndex, {
        following, endBeat, assessPerformance: true, reorderAttacks: true, groupWindowMs: profile.groupingMs, strumAllowanceMs: profile.strumAllowanceMs,
      }),
      startBar: startBar.index,
      endBar,
      countInEnabled,
    };
    state.lastTakeSettings = restartSettings(state.take);
    if (following === 'continuous') {
      state.clockPosition = {
        measure: current.measure,
        beatInBar: Math.floor(current.beat - score.bars[current.measure].beat + 1e-8) + 1,
        noteActive: true,
      };
      passageProgress.value = 0;
    }
    byId('count').hidden = !state.countIn;
    showCountdown(countdownNumber(state.countIn, performance.now()));
    micLabel(state.countIn ? 'Count-in · get ready' : 'Listening · waiting for a note', 'active');
    mic.monitor(signalUpdate, receiveNote, captureState);
    void diagnostics.refreshDevices();
  } catch (error) {
    if (request === state.micRequest) {
      stopListening({ report: false });
      microphoneError(error);
    }
  } finally {
    state.opening = false;
    refreshPracticeControls();
    refreshScore();
  }
}

function mount(score, pdf = null, convertedXML = null, sourceXML = null, octaveShift = 0) {
  stopPlayback();
  text('playback-status', '');
  stopListening({ report: false });
  byId('results').hidden = true;
  retry.onclick = null;
  state.score = score;
  state.sourceXML = sourceXML;
  state.sourcePDF = pdf;
  state.convertedXML = convertedXML;
  state.octaveShift = octaveShift;
  updateOctaveControls();
  state.review = null;
  state.completedTakes = [];
  state.lastTakeSettings = null;
  state.shownPage = null;
  state.shownPreview = null;
  if (state.pdfURL?.startsWith('blob:')) URL.revokeObjectURL(state.pdfURL);
  state.pdfURL = typeof pdf === 'string' ? pdf
    : pdf ? URL.createObjectURL(new Blob([pdf], { type: 'application/pdf' })) : null;
  const pdfLink = byId('original-pdf');
  pdfLink.hidden = !state.pdfURL;
  pdfLink.href = state.pdfURL || '#';
  if (state.musicXMLURL) URL.revokeObjectURL(state.musicXMLURL);
  const downloadableXML = sourceXML ? shiftMusicXMLOctaves(sourceXML, octaveShift) : convertedXML;
  state.musicXMLURL = downloadableXML
    ? URL.createObjectURL(new Blob([downloadableXML], { type: 'application/vnd.recordare.musicxml+xml' }))
    : null;
  const musicXMLLink = byId('download-musicxml');
  musicXMLLink.hidden = !state.musicXMLURL;
  musicXMLLink.href = state.musicXMLURL || '#';
  if (state.musicXMLURL) musicXMLLink.download = `${score.title || 'score'}.musicxml`;
  byId('piece-files').hidden = pdfLink.hidden && musicXMLLink.hidden;
  const label = score.sample ? 'Sample score' : 'Imported score';
  text('score-heading', score.title);
  const count = score.rowCount;
  text('score-meta', `${label} · ${count} ${count === 1 ? 'row' : 'rows'}`);
  const lastBar = score.notes.at(-1).measure;
  const practiceBars = score.bars.slice(0, lastBar + 1);
  barSelect.replaceChildren(...practiceBars.map((bar) => new Option(barLabel(bar.index), bar.index)));
  endBarSelect.replaceChildren(new Option('End of score', ''), ...practiceBars.map((bar) => new Option(barLabel(bar.index), bar.index)));
  jumpToIndex(0);
  refreshPracticeControls();
}

async function loadSample() {
  const request = ++state.loading;
  byId('load-sample').disabled = true;
  try {
    const response = await fetch('./assets/morning-lines.musicxml');
    if (!response.ok) throw new Error('The sample could not be downloaded.');
    const xml = await response.text();
    const score = await engrave(xml, { sample: true });
    if (request === state.loading) mount(score, './assets/morning-lines.pdf', null, xml);
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
  label.textContent = pdf && !musicXML ? 'Preparing PDF recognition…' : 'Opening score…';
  try {
    let xml;
    if (musicXML) {
      xml = await musicXMLFromFile(musicXML);
    } else {
      if (pdf.size > 20 * 1024 * 1024) throw new Error('Choose a PDF smaller than 20 MB.');
      xml = await convertPdfInBrowser(pdf, (message) => {
        label.textContent = message ? `PDF recognition: ${message}` : 'Recognizing PDF…';
      });
      convertedXML = xml;
    }
    const scoreName = musicXML?.name.replace(/\.[^.]+$/, '') || pdf.name.replace(/\.pdf$/i, '');
    const score = await engrave(xml, { name: scoreName });
    if (request !== state.loading) return;
    mount(score, pdf, convertedXML, xml);
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

testMic.addEventListener('click', () => void testMicrophone());
byId('microphone-diagnostics').addEventListener('toggle', () => void diagnostics.refreshDevices());
async function convertPdfInBrowser(file, onProgress) {
  if (pdfConversionActive) throw new Error('A PDF conversion is already running.');
  pdfConversionActive = true;
  try {
    if (pdfConverterFrame.dataset.loaded !== 'true') {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('The PDF recognition engine did not start.')), 30_000);
        pdfConverterFrame.addEventListener('load', () => {
          clearTimeout(timeout);
          pdfConverterFrame.dataset.loaded = 'true';
          resolve();
        }, { once: true });
        pdfConverterFrame.src = new URL('/pdf2music/index.html', location.origin).href;
      });
    }

    const requestId = `pdf-${Date.now()}-${++pdfConversionSequence}`;
    return await new Promise((resolve, reject) => {
      const finish = (callback, value) => {
        clearTimeout(timeout);
        window.removeEventListener('message', receive);
        callback(value);
      };
      const receive = (event) => {
        if (event.origin !== location.origin || event.source !== pdfConverterFrame.contentWindow
          || event.data?.requestId !== requestId) return;
        if (event.data.type === 'papertempo:pdf-progress') {
          onProgress(event.data.message);
        } else if (event.data.type === 'papertempo:pdf-done' && typeof event.data.musicxml === 'string') {
          finish(resolve, event.data.musicxml);
        } else if (event.data.type === 'papertempo:pdf-error') {
          finish(reject, new Error(event.data.error || 'PDF recognition failed.'));
        }
      };
      const timeout = setTimeout(() => finish(reject, new Error('PDF recognition timed out. Try a smaller or clearer score.')), 15 * 60_000);
      window.addEventListener('message', receive);
      pdfConverterFrame.contentWindow.postMessage({ type: 'papertempo:pdf-convert', requestId, file }, location.origin);
    });
  } finally {
    pdfConversionActive = false;
  }
}
listen.addEventListener('click', () => state.mic ? stopListening() : void startListening());
byId('octave-down').addEventListener('click', () => void shiftOctave(-1));
byId('octave-up').addEventListener('click', () => void shiftOctave(1));
byId('octave-reset').addEventListener('click', () => void shiftOctave(-state.octaveShift));
playbackToggle.addEventListener('click', () => void togglePlayback());
playbackStop.addEventListener('click', () => {
  stopPlayback();
  playbackToggle.focus();
});
practiseMistake.addEventListener('click', () => {
  if (!state.review?.selected) return;
  const { take, selected } = state.review;
  const { startBar, endBar } = mistakePassage(take, selected.note.measure);
  const startIndex = take.notes.findIndex((note) => note.measure >= startBar);
  return practise({ ...restartSettings(take), startIndex, startBar, endBar });
});
followingSelect.addEventListener('change', refreshPracticeControls);
barSelect.addEventListener('change', () => jumpToBar(Number(barSelect.value)));
endBarSelect.addEventListener('change', showPreview);
byId('prev-page').addEventListener('click', () => scrollRows(-1));
byId('next-page').addEventListener('click', () => scrollRows(1));
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
function activateNote(event) {
  if (state.mic || state.playbackRun || !state.score) return;
  const id = event.target.closest('.note')?.id;
  const item = state.review?.byId.get(id);
  if (item) {
    state.review.selected = item;
    refreshScore();
    return;
  }
  const index = state.score.notes.findIndex((note) => note.id === id
    || note.pitches?.some((tone) => tone.id === id || tone.continuationIds?.includes(id)));
  if (index >= 0) jumpToIndex(index);
}
notation.addEventListener('click', activateNote);
notation.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (!event.target.closest('.note[tabindex="0"]')) return;
  event.preventDefault();
  activateNote(event);
});
restartTakeButton.addEventListener('click', () => void restartTake());
fullscreenButton.hidden = !fullscreen;
fullscreenButton.addEventListener('click', toggleFullscreen);
if (fullscreen) {
  document.addEventListener(fullscreen.event, () => {
    const on = fullscreen.element() === scorePanel;
    fullscreenButton.querySelector('span').textContent = on ? 'Exit full screen' : 'Full screen';
    fullscreenButton.setAttribute('aria-pressed', String(on));
    refreshPracticeControls();
  });
}
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.closest?.('input, select, textarea, [contenteditable="true"]')) return;
  if (document.querySelector('dialog[open]')) return;
  const key = event.key.toLowerCase();
  if (key === 'r') {
    event.preventDefault();
    void restartTake();
  } else if (key === 'f' && fullscreen) {
    event.preventDefault();
    toggleFullscreen();
  }
});
window.addEventListener('pagehide', () => {
  state.micRequest += 1;
  stopPlayback();
  if (state.mic) stopListening({ report: false });
});
void loadSample();
