import * as ort from "onnxruntime-web";
import type { InferenceSession, Tensor } from "onnxruntime-web";

export interface ExtractResult {
  original: Float32Array;
  staff: Uint8Array;
  symbols: Uint8Array;
  stems_rests: Uint8Array;
  notehead: Uint8Array;
  clefs_keys: Uint8Array;
  width: number;
  height: number;
}

const WIN_SIZE = 320;

function extractPatch(
  image: Float32Array,
  y: number,
  x: number,
  winSize: number,
  c: number,
  h: number,
  w: number
): Float32Array {
  const patch = new Float32Array(c * winSize * winSize).fill(255);
  const y0 = Math.max(y, 0);
  const x0 = Math.max(x, 0);
  const y1 = Math.min(y + winSize, h);
  const x1 = Math.min(x + winSize, w);
  const ph = y1 - y0;
  const pw = x1 - x0;

  for (let ch = 0; ch < c; ch++) {
    for (let py = 0; py < ph; py++) {
      for (let px = 0; px < pw; px++) {
        patch[ch * winSize * winSize + py * winSize + px] =
          image[ch * h * w + (y0 + py) * w + (x0 + px)];
      }
    }
  }
  return patch;
}

function mergePatches(
  patches: Int32Array[],
  imageShape: [number, number],
  winSize: number,
  stepSize: number
): Float32Array {
  const [imgH, imgW] = imageShape;
  const reconstructed = new Float32Array(imgH * imgW);
  const weight = new Float32Array(imgH * imgW);

  let idx = 0;
  for (let iy = 0; iy < imgH; iy += stepSize) {
    const y = Math.min(iy, imgH - winSize);
    const y0 = Math.max(y, 0);
    const y1 = Math.min(y + winSize, imgH);
    const ph = y1 - y0;

    for (let ix = 0; ix < imgW; ix += stepSize) {
      const x = Math.min(ix, imgW - winSize);
      const x0 = Math.max(x, 0);
      const x1 = Math.min(x + winSize, imgW);
      const pw = x1 - x0;

      const patch = patches[idx];
      for (let py = 0; py < ph; py++) {
        for (let px = 0; px < pw; px++) {
          reconstructed[(y0 + py) * imgW + (x0 + px)] += patch[py * winSize + px];
          weight[(y0 + py) * imgW + (x0 + px)] += 1;
        }
      }
      idx++;
    }
  }

  for (let i = 0; i < reconstructed.length; i++) {
    if (weight[i] === 0) weight[i] = 1;
    reconstructed[i] /= weight[i];
  }

  return reconstructed;
}

export class Segnet {
  private session: InferenceSession;
  private inputName: string;
  fp16: boolean;

  constructor(session: InferenceSession, fp16: boolean) {
    this.session = session;
    this.fp16 = fp16;
    this.inputName = session.inputNames[0];
  }

  async run(inputData: Float32Array, batchSize: number): Promise<Int32Array[]> {
    const dataType = this.fp16 ? "float16" : "float32";
    const tensor = new ort.Tensor(dataType, inputData, [batchSize, 3, WIN_SIZE, WIN_SIZE]);
    const results = await this.session.run({ [this.inputName]: tensor });
    const outputName = this.session.outputNames[0];
    const output = results[outputName] as Tensor;
    const outData = output.data as Float32Array | Uint16Array;

    const results_arr: Int32Array[] = [];
    const numClasses = output.dims[1];
    const spatialSize = output.dims[2] * output.dims[3];

    for (let b = 0; b < batchSize; b++) {
      const argmax = new Int32Array(spatialSize);
      for (let i = 0; i < spatialSize; i++) {
        let maxVal = -Infinity;
        let maxIdx = 0;
        for (let c = 0; c < numClasses; c++) {
          const val = outData[b * numClasses * spatialSize + c * spatialSize + i];
          if (val > maxVal) {
            maxVal = val;
            maxIdx = c;
          }
        }
        argmax[i] = maxIdx;
      }
      results_arr.push(argmax);
    }
    return results_arr;
  }
}

export async function segnetInference(
  model: Segnet,
  grayImage: Uint8Array,
  height: number,
  width: number,
  stepSize: number = 320,
  batchSize: number = 8
): Promise<ExtractResult> {
  const winSize = WIN_SIZE;

  const c = 3;
  const image = new Float32Array(c * height * width);
  for (let ch = 0; ch < c; ch++) {
    for (let i = 0; i < height * width; i++) {
      image[ch * height * width + i] = grayImage[i];
    }
  }

  const data: Int32Array[] = [];
  let batch: Float32Array[] = [];

  const yLoops: number[] = [];
  const xLoops: number[] = [];
  for (let yLoop = 0; yLoop < Math.max(height, winSize); yLoop += stepSize) {
    yLoops.push(yLoop);
  }
  for (let xLoop = 0; xLoop < Math.max(width, winSize); xLoop += stepSize) {
    xLoops.push(xLoop);
  }

  for (const yLoop of yLoops) {
    const y = Math.min(yLoop, height - winSize);
    for (const xLoop of xLoops) {
      const x = Math.min(xLoop, width - winSize);
      const hop = extractPatch(image, y, x, winSize, c, height, width);
      batch.push(hop);

      if (batch.length === batchSize) {
        const stacked = new Float32Array(batchSize * 3 * winSize * winSize);
        for (let b = 0; b < batch.length; b++) {
          stacked.set(batch[b], b * 3 * winSize * winSize);
        }
        const batchOut = await model.run(stacked, batchSize);
        for (const out of batchOut) data.push(out);
        batch = [];
      }
    }
  }

  if (batch.length > 0) {
    const bs = batch.length;
    const stacked = new Float32Array(bs * 3 * winSize * winSize);
    for (let b = 0; b < batch.length; b++) {
      stacked.set(batch[b], b * 3 * winSize * winSize);
    }
    const batchOut = await model.run(stacked, bs);
    for (const out of batchOut) data.push(out);
  }

  const merged = mergePatches(data, [height, width], winSize, stepSize);

  const staff = new Uint8Array(height * width);
  const symbols = new Uint8Array(height * width);
  const stemsRests = new Uint8Array(height * width);
  const notehead = new Uint8Array(height * width);
  const clefsKeys = new Uint8Array(height * width);

  for (let i = 0; i < merged.length; i++) {
    const val = merged[i];
    stemsRests[i] = val === 1 ? 1 : 0;
    notehead[i] = val === 2 ? 1 : 0;
    clefsKeys[i] = val === 3 ? 1 : 0;
    staff[i] = val === 4 ? 1 : 0;
    symbols[i] = val === 5 ? 1 : 0;
  }

  return {
    original: new Float32Array(0),
    staff,
    symbols,
    stems_rests: stemsRests,
    notehead,
    clefs_keys: clefsKeys,
    width,
    height,
  };
}
