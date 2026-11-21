// OpenCV.js loader.
//
// The homr modules all reference OpenCV through the global `cv` (matching the
// Python source they were ported from), so this installs the initialised
// module on `globalThis` before anything else runs.
//
// @techstark/opencv-js ships the emscripten build with the wasm inlined, so it
// works inside a module worker and needs no network access at runtime.
import cvModule from "@techstark/opencv-js";

let ready: Promise<any> | null = null;

export function loadOpenCV(): Promise<any> {
  if (ready) return ready;
  ready = (async () => {
    const mod: any = await (cvModule as any);
    // Older builds resolve immediately but finish initialising asynchronously.
    if (typeof mod.Mat !== "function") {
      await new Promise<void>((resolve) => {
        mod.onRuntimeInitialized = () => resolve();
      });
    }
    (globalThis as any).cv = mod;
    return mod;
  })();
  return ready;
}

/**
 * OpenCV.js throws raw wasm exception pointers, which surface as meaningless
 * numbers. This turns them back into the underlying C++ message.
 */
export function describeError(err: any): string {
  const cv = (globalThis as any).cv;
  if (typeof err === "number" && cv?.exceptionFromPtr) {
    try {
      const e = cv.exceptionFromPtr(err);
      return `OpenCV error: ${e.msg || e.what || err}`;
    } catch {
      return `OpenCV error (code ${err})`;
    }
  }
  return err?.message || String(err);
}
