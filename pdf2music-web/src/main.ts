import { musicxmlToMidi } from "./homr/midi_convert";
import { inferTies } from "./homr/tie_inference";
import { startBackdrop } from "./ui/backdrop";
import { startParticles } from "./ui/particles";

/* ---------------------------------------------------------------- DOM */

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const embedded = window.parent !== window;

const views = {
  intro: $("viewIntro"),
  work: $("viewWork"),
  done: $("viewDone"),
  error: $("viewError"),
};

const fileInput = $<HTMLInputElement>("fileInput");
const portal = $<HTMLButtonElement>("portal");
const enginePill = $("enginePill");
const engineText = $("engineText");

const previewCanvas = $<HTMLCanvasElement>("preview");
const scanEmpty = $("scanEmpty");
const meter = document.querySelector<HTMLElement>(".meter")!;
const meterFill = $<SVGCircleElement & HTMLElement>("meterFill");
const meterPct = $("meterPct");
const meterName = $("meterName");
const workTitle = $("workTitle");
const workStatus = $("workStatus");
const logList = $<HTMLOListElement>("log");

const doneTitle = $("doneTitle");
const downloads = $("downloads");
const againBtn = $<HTMLButtonElement>("againBtn");
const retryBtn = $<HTMLButtonElement>("retryBtn");
const errText = $("errText");

const veil = $("veil");

/* ------------------------------------------------------------ backdrop */

const backdrop = embedded
  ? { setEnergy: (_value: number) => {} }
  : startBackdrop($<HTMLCanvasElement>("bg-gl"));
if (!embedded) startParticles($<HTMLCanvasElement>("bg-particles"));

/* --------------------------------------------------------------- state */

type View = keyof typeof views;

let busy = false;
let modelsReady = false;
let outputStem = "score";
let modelLoadError = "";
let embedRequestId = "";
const objectUrls: string[] = [];

function tellParent(type: string, payload: Record<string, unknown> = {}) {
  if (embedded && embedRequestId) {
    window.parent.postMessage({ type, requestId: embedRequestId, ...payload }, location.origin);
  }
}

const ENERGY: Record<View, number> = { intro: 0.12, work: 0.85, done: 0.5, error: 0.15 };

function show(view: View) {
  for (const [name, el] of Object.entries(views)) {
    if (name === view) el.setAttribute("data-active", "");
    else el.removeAttribute("data-active");
  }
  backdrop.setEnergy(ENERGY[view]);
}

function setEngine(state: "loading" | "ready" | "error", text: string) {
  enginePill.setAttribute("data-state", state);
  engineText.textContent = text;
}

/* ------------------------------------------------------- work feedback */

// The worker reports free-form progress strings. These map the ones we know
// onto a friendlier headline and a rough share of the whole job.
const STAGES: Array<[RegExp, string, number]> = [
  [/opencv/i, "Warming up", 0.02],
  [/segnet model|downloading segnet/i, "Fetching the vision model", 0.08],
  [/encoder/i, "Fetching the encoder", 0.16],
  [/decoder/i, "Fetching the decoder", 0.24],
  [/inference sessions|models loaded/i, "Models ready", 0.3],
  [/rendering|pdf/i, "Rendering the page", 0.36],
  [/autocrop|resizing|clahe/i, "Cleaning up the scan", 0.44],
  [/segnet inference/i, "Finding ink on the page", 0.55],
  [/noise/i, "Filtering noise", 0.62],
  [/symbol/i, "Detecting symbols", 0.68],
  [/notehead|stem/i, "Pairing noteheads with stems", 0.74],
  [/transformer/i, "Reading the music", 0.9],
  [/staff/i, "Tracing the staves", 0.8],
  [/musicxml/i, "Writing the score", 0.97],
];

let lastLog = "";

function reportProgress(message: string, pct: number | null) {
  tellParent("papertempo:pdf-progress", { message, progress: pct });
  const match = STAGES.find(([re]) => re.test(message));
  if (match) workTitle.textContent = match[1];
  workStatus.textContent = message;

  if (message !== lastLog) {
    lastLog = message;
    const li = document.createElement("li");
    li.textContent = message;
    logList.appendChild(li);
    while (logList.children.length > 40) logList.removeChild(logList.firstChild!);
    logList.scrollTop = logList.scrollHeight;
  }

  const value = pct ?? (match ? match[2] : null);
  setMeter(value);
}

const CIRCUMFERENCE = 2 * Math.PI * 52;

function setMeter(value: number | null) {
  if (value === null) {
    meter.classList.add("indeterminate");
    meterPct.textContent = "···";
    return;
  }
  meter.classList.remove("indeterminate");
  const v = Math.max(0, Math.min(1, value));
  meterFill.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - v));
  meterPct.textContent = `${Math.round(v * 100)}%`;
}

/* -------------------------------------------------------------- worker */

let worker: Worker | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;

  worker = new Worker(new URL("./worker/worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent) => {
    const { type, ...payload } = e.data;
    switch (type) {
      case "cv_ready":
        setEngine("loading", "loading models");
        worker!.postMessage({ type: "load_models" });
        break;

      case "models_loaded":
        modelsReady = true;
        setEngine("ready", "engine ready");
        if (!busy) setMeter(null);
        break;

      case "progress":
        if (!modelsReady) setEngine("loading", shortEngine(payload.message));
        if (busy || views.work.hasAttribute("data-active")) {
          reportProgress(payload.message, payload.progress ?? null);
        }
        break;

      case "image_ready":
        showPreview(
          new ImageData(
            new Uint8ClampedArray(payload.data.imageData),
            payload.data.width,
            payload.data.height
          )
        );
        break;

      case "done":
        finish(payload.musicxml);
        break;

      case "error":
        if (payload.stack) console.error(payload.stack);
        if (!modelsReady) modelLoadError = payload.error || "The recognition models could not be loaded.";
        fail(payload.error);
        break;
    }
  };

  worker.onerror = (e) => fail(e.message || "the conversion worker failed to start");

  worker.postMessage({ type: "init" });
  setEngine("loading", "starting engine");
  return worker;
}

function shortEngine(message: string): string {
  if (/downloading/i.test(message)) return "downloading models";
  if (/loading/i.test(message)) return "loading models";
  return "starting engine";
}

/* ------------------------------------------------------------- outputs */

function showPreview(image: ImageData) {
  previewCanvas.width = image.width;
  previewCanvas.height = image.height;
  previewCanvas.getContext("2d")!.putImageData(image, 0, 0);
  previewCanvas.classList.add("visible");
  scanEmpty.classList.add("gone");
}

function icon(kind: "midi" | "xml"): string {
  return kind === "midi"
    ? `<path d="M9 18.5a2.5 2.5 0 1 0 2.5-2.5V6l8-2v9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="17" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>`
    : `<path d="M6 3.5h8L19 9v11.5H6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M13.5 3.5V9H19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 12.5l2.2 4M11.2 12.5L9 16.5m4.6-4h2.6m-2.6 4h2.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/>`;
}

function addDownload(
  data: BlobPart,
  mime: string,
  filename: string,
  label: string,
  kind: "midi" | "xml",
  blurb: string
) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  objectUrls.push(url);

  const a = document.createElement("a");
  a.className = `dl ${kind}`;
  a.href = url;
  a.download = filename;
  a.innerHTML = `
    <span class="dl-ico"><svg viewBox="0 0 24 24" aria-hidden="true">${icon(kind)}</svg></span>
    <span class="dl-txt"><b>${label}</b><span>${blurb}</span></span>
    <span class="dl-arrow"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v14m0 0l-5-5m5 5l5-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  a.addEventListener("pointermove", (e) => {
    const r = a.getBoundingClientRect();
    a.style.setProperty("--mx", `${e.clientX - r.left}px`);
    a.style.setProperty("--my", `${e.clientY - r.top}px`);
  });
  downloads.appendChild(a);
}

function finish(rawMusicxml: string) {
  busy = false;
  clearOutputs();

  // Both of these need DOMParser, which only exists on the main thread.
  let musicxml = rawMusicxml;
  try {
    musicxml = inferTies(rawMusicxml);
  } catch (err) {
    console.error("tie inference failed, using the raw output", err);
  }

  if (embedded) return void tellParent("papertempo:pdf-done", { musicxml });

  let midi: ArrayBuffer | null = null;
  try {
    midi = musicxmlToMidi(musicxml);
  } catch (err) {
    console.error("MIDI conversion failed", err);
  }

  if (midi) {
    addDownload(midi, "audio/midi", `${outputStem}.mid`, "MIDI", "midi", "Play it in any DAW");
  }
  addDownload(
    musicxml,
    "application/xml",
    `${outputStem}.musicxml`,
    "MusicXML",
    "xml",
    "Edit in MuseScore or Sibelius"
  );

  doneTitle.textContent = midi
    ? `“${outputStem}” is ready.`
    : `“${outputStem}” transcribed — MusicXML only.`;

  show("done");
}

function clearOutputs() {
  downloads.innerHTML = "";
  for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);
}

function fail(message: string) {
  busy = false;
  tellParent("papertempo:pdf-error", { error: message });
  errText.textContent = message;
  show("error");
}

/* ---------------------------------------------------------------- flow */

/** "path/My Score.pdf" -> "My Score" */
function stemOf(filename: string): string {
  const base = filename.replace(/^.*[\\/]/, "");
  return base.replace(/\.[^.]+$/, "") || "score";
}

async function handleFile(file: File) {
  if (busy) return;

  if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    fail(`“${file.name}” isn’t a PDF. Drop a PDF of a printed score.`);
    return;
  }

  busy = true;
  outputStem = stemOf(file.name);
  clearOutputs();

  // Reset the working view for a fresh run.
  previewCanvas.classList.remove("visible");
  scanEmpty.classList.remove("gone");
  logList.innerHTML = "";
  lastLog = "";
  // The ring label is a narrow, centre-aligned slot: clip long names here
  // rather than letting CSS overflow chew off both ends.
  meterName.textContent = outputStem.length > 18 ? outputStem.slice(0, 17) + "…" : outputStem;
  meterName.title = outputStem;
  workTitle.textContent = modelsReady ? "Reading the PDF" : "Warming up";
  workStatus.textContent = modelsReady
    ? "Opening your score"
    : "Fetching the recognition models — this only happens once";
  setMeter(null);
  views.work.setAttribute("data-busy", "");
  show("work");

  const w = ensureWorker();
  try {
    const pdfData = await file.arrayBuffer();
    w.postMessage({ type: "process_pdf", data: { pdfData } }, [pdfData]);
  } catch (err: any) {
    fail(err?.message || String(err));
  }
}

/* --------------------------------------------------- input: click/drop */

portal.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) handleFile(fileInput.files[0]);
  fileInput.value = "";
});

if (embedded) {
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.type !== "papertempo:pdf-convert" || !(message.file instanceof File)
      || typeof message.requestId !== "string" || busy) return;
    embedRequestId = message.requestId;
    if (modelLoadError) {
      fail(modelLoadError);
      return;
    }
    handleFile(message.file);
  });
}

againBtn.addEventListener("click", () => show("intro"));
retryBtn.addEventListener("click", () => show("intro"));

// The whole viewport is the drop target. `dragenter`/`dragleave` fire for
// every element underneath the cursor, so count them instead of toggling.
let dragDepth = 0;

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

function endDrag() {
  dragDepth = 0;
  document.body.classList.remove("dragging");
  backdrop.setEnergy(
    ENERGY[(Object.keys(views) as View[]).find((v) => views[v].hasAttribute("data-active")) ?? "intro"]
  );
}

window.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dragging");
  backdrop.setEnergy(1);
});

window.addEventListener("dragover", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) endDrag();
});

window.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  endDrag();
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

// A stray drop outside the window leaves the veil up; clear it on focus loss.
window.addEventListener("blur", endDrag);

// Paste a PDF straight from the clipboard.
window.addEventListener("paste", (e) => {
  const file = Array.from(e.clipboardData?.files ?? [])[0];
  if (file) handleFile(file);
});

/* --------------------------------------------------------------- boot */

// Touch devices have nothing to drag from, so speak their language instead.
if (!window.matchMedia("(hover: hover)").matches) {
  portal.querySelector("strong")!.textContent = "Choose a PDF";
  portal.querySelector("small")!.textContent = "tap to browse";
  const lede = document.querySelector(".lede");
  if (lede) {
    lede.textContent =
      "Pick a PDF of a printed score. Everything \u2014 rendering, recognition, transcription \u2014 happens on your own device. Nothing is uploaded, ever.";
  }
}

if (import.meta.env.DEV) {
  (window as any).__dev = { finish, show };
  // `?demo` renders the finished state from a canned score, so the result
  // view can be worked on without running a 30-second transcription.
  if (new URLSearchParams(location.search).has("demo")) {
    void import("./ui/demo").then((m) => {
      outputStem = "Prelude in C";
      finish(m.DEMO_MUSICXML);
    });
  }
}


show("intro");
veil.setAttribute("aria-hidden", "true");

// Start fetching OpenCV and the models right away; conversion requests are
// queued in the worker until they are ready.
ensureWorker();
