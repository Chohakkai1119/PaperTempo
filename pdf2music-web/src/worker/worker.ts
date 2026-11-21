import * as ort from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Pipeline } from "../homr/pipeline";
import { loadOpenCV, describeError } from "../homr/opencv";
import { fetchModelFromZip, getModelUrls, MODEL_NAMES } from "../homr/model_cache";

// pdf.js's default canvas factory creates scratch canvases with
// document.createElement, which does not exist inside a worker. PDFs with
// transparency groups need such scratch canvases while rendering, so provide
// an OffscreenCanvas-based factory instead.
class OffscreenCanvasFactory {
  create(width: number, height: number) {
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    const canvas = new OffscreenCanvas(width, height);
    return {
      canvas,
      context: canvas.getContext("2d", { willReadFrequently: true })!,
    };
  }

  reset(
    canvasAndContext: { canvas: OffscreenCanvas | null; context: OffscreenCanvasRenderingContext2D | null },
    width: number,
    height: number
  ) {
    if (!canvasAndContext.canvas) throw new Error("Canvas is not specified");
    if (width <= 0 || height <= 0) throw new Error("Invalid canvas size");
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: { canvas: OffscreenCanvas | null; context: OffscreenCanvasRenderingContext2D | null }) {
    if (!canvasAndContext.canvas) throw new Error("Canvas is not specified");
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

// The page is not cross-origin isolated, so SharedArrayBuffer (and with it
// multi-threaded wasm) is unavailable.
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = { wasm: wasmUrl };

// The "?v=2" is a one-time cache buster: browsers that fetched this module
// while it was (mistakenly) served as application/octet-stream cached that
// response for a year ("immutable"), and module MIME checks fail against the
// cached copy even after the server is fixed. A new URL forces a fresh fetch.
pdfjs.GlobalWorkerOptions.workerSrc =
  new URL(pdfWorkerUrl, self.location.href).href + "?v=2";

// Rendering happens here rather than on the main thread because pdf.js drives
// its render loop with requestAnimationFrame, which is suspended while the tab
// is in the background; an OffscreenCanvas in a worker has no such throttling.
const DPI = 300;
// Rendering below 300 DPI measurably hurts detection (braces and grand staffs
// stop being recognised), so the DPI is only reduced for pages whose canvas
// would otherwise be unreasonably large.
const MAX_PIXELS = 40_000_000;

async function renderPdf(
  data: ArrayBuffer,
  onProgress: (msg: string) => void
): Promise<ImageData> {
  const pdf = await pdfjs.getDocument({
    data,
    // Constructed by pdf.js with `new`; see the factory above.
    CanvasFactory: OffscreenCanvasFactory as never,
  }).promise;

  const pages: ImageData[] = [];
  let maxWidth = 0;
  for (let i = 1; i <= pdf.numPages; i++) {
    onProgress(`Rendering page ${i} of ${pdf.numPages}...`);
    const page = await pdf.getPage(i);
    const unscaled = page.getViewport({ scale: 1 });
    let scale = DPI / 72;
    const pixels = unscaled.width * scale * unscaled.height * scale;
    if (pixels > MAX_PIXELS) {
      scale *= Math.sqrt(MAX_PIXELS / pixels);
    }
    const viewport = page.getViewport({ scale });

    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport } as any).promise;

    pages.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    maxWidth = Math.max(maxWidth, canvas.width);
  }
  if (pages.length === 0) throw new Error("The PDF has no pages");

  // Stack the pages vertically into a single image, as the CLI does.
  const totalHeight = pages.reduce((sum, p) => sum + p.height, 0);
  const stacked = new Uint8ClampedArray(totalHeight * maxWidth * 4).fill(255);
  let yOff = 0;
  for (const page of pages) {
    const leftPad = Math.floor((maxWidth - page.width) / 2);
    for (let y = 0; y < page.height; y++) {
      const srcRow = y * page.width * 4;
      stacked.set(
        page.data.subarray(srcRow, srcRow + page.width * 4),
        (yOff + y) * maxWidth * 4 + leftPad * 4
      );
    }
    yOff += page.height;
  }

  return new ImageData(stacked, maxWidth, totalHeight);
}

let pipeline: Pipeline | null = null;
let modelsLoaded = false;
let modelLoadPromise: Promise<void> | null = null;

function post(message: any, transfer?: Transferable[]) {
  (self as any).postMessage(message, transfer ?? []);
}

async function loadModels(onProgress: (msg: string, pct?: number) => void) {
  const urls = getModelUrls();

  onProgress("Loading segnet model...", 0);
  const segnetData = await fetchModelFromZip(
    MODEL_NAMES.segnet,
    urls.segnet,
    MODEL_NAMES.segnet,
    (loaded, total) =>
      onProgress("Downloading segnet...", total ? loaded / total / 3 : 0)
  );

  onProgress("Loading encoder model...", 0.33);
  const encoderData = await fetchModelFromZip(
    MODEL_NAMES.encoder,
    urls.encoder,
    MODEL_NAMES.encoder,
    (loaded, total) =>
      onProgress("Downloading encoder...", total ? 0.33 + loaded / total / 3 : 0.33)
  );

  onProgress("Loading decoder model...", 0.66);
  const decoderData = await fetchModelFromZip(
    MODEL_NAMES.decoder,
    urls.decoder,
    MODEL_NAMES.decoder,
    (loaded, total) =>
      onProgress("Downloading decoder...", total ? 0.66 + loaded / total / 3 : 0.66)
  );

  onProgress("Creating inference sessions...", 0.95);
  await pipeline!.loadModels(segnetData, encoderData, decoderData);
  modelsLoaded = true;
  onProgress("Models loaded", 1);
}

function ensureModelsLoaded(onProgress: (msg: string, pct?: number) => void): Promise<void> {
  if (modelsLoaded) return Promise.resolve();
  if (!pipeline) return Promise.reject(new Error("The recognition engine has not initialized."));
  if (!modelLoadPromise) {
    modelLoadPromise = loadModels(onProgress).catch((error) => {
      modelLoadPromise = null;
      throw error;
    });
  }
  return modelLoadPromise;
}

async function handle(type: string, data: any) {
  if (type === "init") {
    await loadOpenCV();
    pipeline = new Pipeline();
    post({ type: "cv_ready" });
    return;
  }

  if (type === "load_models") {
    await ensureModelsLoaded((message, progress) => post({ type: "progress", message, progress }));
    post({ type: "models_loaded" });
    return;
  }

  if (type === "process_pdf") {
    await ensureModelsLoaded((message, progress) => post({ type: "progress", message, progress }));
    const onProgress = (message: string) => post({ type: "progress", message });

    const image = await renderPdf(data.pdfData, onProgress);
    const preview = new Uint8Array(image.data).buffer;
    post(
      { type: "image_ready", data: { imageData: preview, width: image.width, height: image.height } },
      [preview]
    );

    const musicxml = await pipeline!.processImage(
      new Uint8Array(image.data.buffer),
      image.width,
      image.height,
      { onProgress }
    );
    post({ type: "done", musicxml });
  }
}

// Messages are handled one at a time: a conversion request may arrive while
// the models are still downloading.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent) => {
  const { type, data } = e.data;
  queue = queue.then(async () => {
    try {
      await handle(type, data);
    } catch (err: any) {
      console.error(err);
      post({ type: "error", error: describeError(err), stack: err?.stack });
    }
  });
};
