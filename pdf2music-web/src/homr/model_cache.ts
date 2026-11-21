const DB_NAME = "pdf2music-cache";
const STORE_NAME = "models";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCachedModel(name: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(name);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function setCachedModel(name: string, data: ArrayBuffer): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(data, name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// GitHub release assets are served without CORS headers, so they cannot be
// fetched cross-origin from the browser. The models are therefore requested
// from this origin; local PaperTempo development and its Vercel deployment
// proxy "/models/" through to the homr release.
const MODEL_BASE_URL = import.meta.env.VITE_MODEL_BASE_URL || "/models/";

const SEGNET_MODEL = "segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f";
const TRANSFORMER_MODEL = "pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903";

export interface ModelUrls {
  segnet: string;
  encoder: string;
  decoder: string;
}

export function getModelUrls(): ModelUrls {
  return {
    segnet: MODEL_BASE_URL + SEGNET_MODEL + ".zip",
    encoder: MODEL_BASE_URL + "encoder_" + TRANSFORMER_MODEL + ".zip",
    decoder: MODEL_BASE_URL + "decoder_" + TRANSFORMER_MODEL + ".zip",
  };
}

// The fp32 segnet is the one that is downloaded and the one the wasm
// execution provider runs (Segnet is constructed with fp16 = false).
export const MODEL_NAMES = {
  segnet: `${SEGNET_MODEL}.onnx`,
  encoder: `encoder_${TRANSFORMER_MODEL}.onnx`,
  decoder: `decoder_${TRANSFORMER_MODEL}.onnx`,
};

export async function fetchModel(
  name: string,
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  cache = true
): Promise<ArrayBuffer> {
  const cached = cache ? await getCachedModel(name) : null;
  if (cached) return cached;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${name}: ${response.status}`);

  const total = parseInt(response.headers.get("content-length") || "0");
  const reader = response.body?.getReader();
  if (!reader) {
    const buf = await response.arrayBuffer();
    if (cache) await setCachedModel(name, buf);
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }

  const buf = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.length;
  }
  const result = buf.buffer;
  if (cache) await setCachedModel(name, result);
  return result;
}

export async function fetchModelFromZip(
  name: string,
  zipUrl: string,
  expectedEntry: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<ArrayBuffer> {
  const cached = await getCachedModel(name);
  if (cached) return cached;

  // The zip is only an intermediate, so it is never written to the cache.
  const zipBuf = await fetchModel("__zip_" + name, zipUrl, onProgress, false);
  const { unzipEntry } = await import("./unzip");
  const data = unzipEntry(new Uint8Array(zipBuf), expectedEntry);
  await setCachedModel(name, data);
  return data;
}
