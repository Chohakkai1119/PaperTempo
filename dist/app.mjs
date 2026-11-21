import { clearMarks, engrave, markNote, markResult, midiName, musicXMLFromFile, notationElement } from './score.mjs';
import { FOLLOW_COUNT_IN, countdownNumber, openMicrophone, scheduleCountIn } from './audio.mjs';
import { INSTRUMENTS } from './instruments.mjs';
import { createPlayback, InstrumentSampleError } from './playback.mjs';
import { VISIBLE_ROWS, clampWindowTop, windowRows, windowTopForRow } from './rows.mjs';
import {
  acceptNote, completedTakeSummary, createTake, MIN_TIMED_MATCHES, mistakePassage,
  restartSettings, samePracticePassage, summarize, timingTolerance,
} from './practice.mjs';

const byId = (id) => document.getElementById(id);
const text = (id, value) => {
  const element = byId(id);
  if (element.textContent !== value) element.textContent = value;
};
const state = {
  score: null, index: 0, page: 1, shownPage: null, shownPreview: null,
  matched: null, matchTimer: null, mic: null, opening: false, take: null,
  countIn: null, lastSignal: 0, pdfURL: null, musicXMLURL: null, loading: 0, completed: false,
  review: null, completedTakes: [], playbackRun: null,
  viewTop: 0, positionRow: null, rowBounds: null, rowWindowShown: false,
  lastTakeSettings: null,
};
// Detections this long before the count-in downbeat are ignored (the clicks themselves).
const COUNT_IN_GRACE_MS = 140;
const notation = byId('notation');
const preview = byId('preview-notation');
const barSelect = byId('start-bar');
const endBarSelect = byId('end-bar');
const modeSelect = byId('practice-mode');
const bpmField = byId('bpm');
const instrumentSelect = byId('playback-instrument');
instrumentSelect.replaceChildren(...Object.entries(INSTRUMENTS).map(([id, { label }]) => new Option(label, id)));
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
const uploadDialog = byId('upload-dialog');
const uploadError = byId('upload-error');
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
  if (!state.score || state.playbackRun) return;
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

function refreshReview() {
  const review = state.playbackRun ? null : state.review;
  byId('score-review').hidden = !review?.selected;
  if (!review) return;
  const { selected } = review;
  for (const note of review.onTime) {
    if (note.page === state.page && !review.mistakes.has(note.id)) {
      notation.querySelector(`#${CSS.escape(note.id)}`)?.classList.add('review-on-time');
    }
  }
  if (!selected) return;
  for (const [id, mistake] of review.mistakes) {
    const isSelected = id === selected.note.id;
    if (mistake.note.page === state.page) markResult(notation, isSelected ? selected : mistake, isSelected);
  }
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
  const next = state.completed ? null : notes[state.index];
  const position = run?.position || next || notes[state.index - 1];
  const highlighted = run ? run.note : next;
  loadPageMarkup();
  clearMarks(notation);
  if (!run && state.matched?.page === state.page) markNote(notation, state.matched.id, 'matched');
  trackNoteVisibility(highlighted?.page === state.page
    ? markNote(notation, highlighted.id, run ? 'playback' : 'expected') : null);
  refreshReview();

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
  text('position', `${barLabel(position.measure)} · Row ${position.row + 1}`);
  text('expected-note', !run && next ? midiName(next.midi) : '—');
  byId('prev-page').disabled = (state.viewTop <= 0 && state.page <= 1) || Boolean(run);
  byId('next-page').disabled = (state.viewTop >= clampWindowTop(Infinity, rowInfo.count) && state.page >= pages.length) || Boolean(run);
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
  listen.disabled = state.opening || !state.score || Boolean(run);
  endBarSelect.disabled = live || listen.disabled;
  barSelect.disabled = Boolean(run);
  bpmField.disabled = Boolean(run);
  instrumentSelect.disabled = Boolean(run);
  modeSelect.disabled = Boolean(run);
  retry.disabled = Boolean(run);
  // In full screen the side panel (with Start listening) is out of view, so this button
  // also starts the first take there; otherwise it appears once a take has run.
  const inFullscreen = (document.fullscreenElement || document.webkitFullscreenElement) === scorePanel;
  const hasTake = live || Boolean(state.lastTakeSettings);
  restartTakeButton.hidden = !(hasTake || inFullscreen);
  restartTakeButton.querySelector('span').textContent = hasTake ? 'Restart' : 'Start';
  restartTakeButton.title = hasTake ? 'Restart this take (R)' : 'Start listening (R)';
  restartTakeButton.disabled = state.opening || Boolean(run);
  countInToggle.disabled = live;
  playbackToggle.disabled = !state.score || live || state.opening || run?.status === 'starting';
  playbackStop.disabled = !run;
  text('playback-toggle', run?.status === 'paused' ? 'Resume playback'
    : run?.status === 'playing' ? 'Pause playback' : 'Hear this passage');
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
    const started = await (resuming ? playback.resume() : playback.play(score.events, range));
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
      ? 'Play the same passage at the same tempo to compare takes.'
      : 'Finish the passage to compare takes.');
    return;
  }
  const rows = [['Pitch accuracy', `${previous.pitch}%`, `${current.pitch}%`]];
  if (previous.overall !== null && current.overall !== null) {
    rows.unshift(['Overall accuracy', `${previous.overall}%`, `${current.overall}%`]);
    rows.push(['Rhythm', `${previous.rhythm}%`, `${current.rhythm}%`]);
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

async function practise({ startIndex, startBar, endBar, bpm }) {
  if (state.opening || state.mic || state.playbackRun) return;
  jumpToIndex(startIndex);
  barSelect.value = String(startBar);
  endBarSelect.value = String(endBar);
  modeSelect.value = bpm === null ? 'free' : 'timed';
  if (bpm !== null) bpmField.value = String(bpm);
  showPreview();
  await startListening();
  if (state.mic) listen.focus();
}

function showResults(take, cancelled) {
  const { matched, missed, extras, bpm } = take;
  const summary = summarize(take);
  const { attempted, pitch, rhythm, overall } = summary;
  const tolerance = bpm ? timingTolerance(bpm) : null;
  byId('results').hidden = false;
  text('results-summary', cancelled ? 'Count-in cancelled' : `${matched.length} of ${attempted} expected notes matched`);
  const metrics = byId('result-metrics');
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
  if (bpm) metric('Overall accuracy', overall === null ? '—' : `${overall}%`);
  metric('Pitch accuracy', pitch === null ? '—' : `${pitch}%`);
  if (bpm) metric('Rhythm', rhythm === null ? '—' : `${rhythm}%`);
  else metric('Extra notes', String(extras.length));
  byId('timing-detail').hidden = !bpm;
  if (bpm) {
    text('timing-detail', rhythm === null
      ? `Rhythm and overall accuracy need at least ${MIN_TIMED_MATCHES} matched notes. ${extras.length} extra.`
      : `Overall is 60% pitch and 40% rhythm. Amber marks are outside ±${Number(tolerance.toFixed(1))} ms. ${extras.length} extra.`);
  }
  const list = byId('result-list');
  const items = [
    ...missed.map((note) => ({ note, detail: 'Missed', kind: 'missed' })),
    ...extras.map(({ note, midi }) => ({ note, detail: `Extra · ${midiName(midi)}` })),
    ...matched.map(({ note, delta }) => ({
      note, detail: delta === null ? 'Matched' : (Math.abs(delta) < 0.5 ? 'On beat' : `${Math.round(Math.abs(delta))} ms ${delta < 0 ? 'early' : 'late'}`),
      kind: delta !== null && Math.abs(delta) > tolerance ? 'timing' : null,
    })),
  ].sort((a, b) => a.note.beat - b.note.beat);
  const mistakes = new Map(items.filter(({ kind }) => kind).map((item) => [item.note.id, item]));
  const selected = mistakes.values().next().value;
  const onTime = matched.filter(({ delta }) => delta !== null && Math.abs(delta) <= tolerance).map(({ note }) => note);
  state.review = selected || onTime.length ? { take, mistakes, selected, onTime } : null;
  list.replaceChildren(...items.map((item) => {
    const { note, detail, kind } = item;
    const row = document.createElement('li');
    const button = document.createElement('button');
    const name = document.createElement('span');
    const result = document.createElement('span');
    button.type = 'button';
    if (kind) button.className = 'mistake-result';
    name.textContent = `${barLabel(note.measure)} · ${midiName(note.midi)}`;
    result.textContent = detail;
    button.append(name, result);
    button.addEventListener('click', () => {
      if (kind) state.review.selected = item;
      jumpToBar(note.measure);
      if (kind) {
        if (state.page !== note.page) {
          state.page = note.page;
          refreshScore();
        }
        trackNoteVisibility(notation.querySelector(`#${CSS.escape(note.id)}`));
        practiseMistake.focus({ preventScroll: true });
        byId('score-review').scrollIntoView({ block: 'nearest' });
        return;
      }
      barSelect.focus({ preventScroll: true });
      byId('score-heading').scrollIntoView({ block: 'nearest' });
    });
    row.append(button);
    return row;
  }));
  showComparison(cancelled ? null : completedTakeSummary(take, summary));
  retry.onclick = () => restartTake();
  setupCoach(take, cancelled);
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
  for (const note of take.missed) entry(note).missedNotes += 1;
  for (const { note, delta } of take.matched) {
    const item = entry(note);
    if (Number.isFinite(delta)) item.timingOffsetsMs.push(Math.round(delta));
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
  showCountdown(null);
  refreshPracticeControls();
  micLabel(complete ? 'Passage complete' : 'Microphone off');
  text('detected-note', '—');
  if (take && report) showResults(take, cancelled);
  refreshScore();
}

function jumpToIndex(index, keepPage = false) {
  if (!state.score) return;
  stopPlayback();
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
  if (!state.score || state.playbackRun) return;
  const page = state.page + delta;
  if (page < 1 || page > state.score.pages.length) return;
  state.page = page;
  const index = state.score.notes.findIndex((note) => note.page === page);
  if (!state.mic && index >= 0) jumpToIndex(index, true);
  else refreshScore();
}

function signalUpdate(pitch, level) {
  const now = performance.now();
  const number = countdownNumber(state.countIn, now);
  if (number !== null) {
    text('count', String(number));
    showCountdown(number);
    return;
  }
  byId('count').hidden = true;
  showCountdown(null);
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
  // Ignore the count-in clicks (Scored tempo also guards this inside acceptNote).
  if (state.countIn && at < state.countIn.downbeat - COUNT_IN_GRACE_MS) return;
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
  if (!state.score || state.opening || state.playbackRun) return;
  if (state.completed) jumpToBar(Number(barSelect.value));
  const bpm = modeSelect.value === 'timed' ? Number(bpmField.value) : null;
  if (modeSelect.value === 'timed' && !bpmField.reportValidity()) return;
  const score = state.score;
  state.opening = true;
  text('playback-status', '');
  refreshPracticeControls();
  micLabel('Requesting microphone access…');
  try {
    const mic = await openMicrophone();
    if (score !== state.score) {
      mic.stop();
      micLabel('Microphone off');
      return;
    }
    state.mic = mic;
    state.review = null;
    byId('results').hidden = true;
    const current = state.score.notes[state.index];
    const startBar = state.score.bars[Number(barSelect.value)];
    const firstOfBar = state.score.notes.findIndex((note) => note.measure >= startBar.index) === state.index;
    const endBar = endBarSelect.value;
    const firstBeyondEnd = endBar === '' ? -1 : score.notes.findIndex((note) => note.measure > Number(endBar));
    const endIndex = firstBeyondEnd === -1 ? score.notes.length : firstBeyondEnd;
    const startBeat = firstOfBar ? startBar.beat : current.beat;
    // Scored tempo counts in 4 beats at the target tempo; Follow (free tempo) uses a short
    // fixed count-in. With the count-in off, Scored tempo anchors timing on the first note.
    const countIn = !countInToggle.checked ? null : bpm ? { bpm, beats: 4 } : FOLLOW_COUNT_IN;
    state.countIn = countIn ? scheduleCountIn(mic.context, countIn.bpm, countIn.beats) : null;
    const downbeat = bpm ? state.countIn?.downbeat ?? null : null;
    state.take = {
      ...createTake(score.notes, state.index, startBeat, bpm, downbeat, endIndex),
      startBar: startBar.index,
      endBar,
    };
    state.lastTakeSettings = restartSettings(state.take);
    state.lastSignal = 0;
    byId('count').hidden = !state.countIn;
    showCountdown(countdownNumber(state.countIn, performance.now()));
    micLabel(state.countIn ? 'Count-in · get ready' : 'Listening · waiting for a note', 'active');
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
    refreshPracticeControls();
    refreshScore();
  }
}

function mount(score, pdf = null, convertedXML = null) {
  stopPlayback();
  text('playback-status', '');
  stopListening({ report: false });
  byId('results').hidden = true;
  retry.onclick = null;
  state.score = score;
  state.review = null;
  state.completedTakes = [];
  state.lastTakeSettings = null;
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
  return practise({ startIndex, startBar, endBar, bpm: take.bpm });
});
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
notation.addEventListener('click', (event) => {
  if (state.mic || state.playbackRun || !state.score) return;
  const id = event.target.closest('.note')?.id;
  const mistake = state.review?.mistakes.get(id);
  if (mistake) {
    state.review.selected = mistake;
    refreshScore();
    return;
  }
  const index = state.score.notes.findIndex((note) => note.id === id);
  if (index >= 0) jumpToIndex(index);
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
  stopPlayback();
  if (state.mic) stopListening({ report: false });
});
void loadSample();
