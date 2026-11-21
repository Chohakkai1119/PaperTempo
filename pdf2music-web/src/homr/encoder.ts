import * as ort from "onnxruntime-web";
import type { InferenceSession, Tensor } from "onnxruntime-web";
import { Config } from "./configs";

export class Encoder {
  private session: InferenceSession;
  private inputName: string;
  private outputName: string;
  fp16: boolean;

  constructor(session: InferenceSession, fp16: boolean) {
    this.session = session;
    this.fp16 = fp16;
    this.inputName = session.inputNames[0];
    this.outputName = session.outputNames[0];
  }

  async generate(x: Float32Array, dims: number[]): Promise<Tensor> {
    const dataType = this.fp16 ? "float16" : "float32";
    const inputTensor = new ort.Tensor(dataType, x, dims);
    const results = await this.session.run({ [this.inputName]: inputTensor });
    return results[this.outputName];
  }
}

export function createEncoderInput(image: Uint8Array, height: number, width: number): Float32Array {
  const mean = 0.7931;
  const std = 0.1738;
  const result = new Float32Array(1 * 1 * height * width);
  for (let i = 0; i < height * width; i++) {
    result[i] = (image[i] / 255 - mean) / std;
  }
  return result;
}
