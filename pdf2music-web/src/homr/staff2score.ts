import * as ort from "onnxruntime-web";
import type { InferenceSession, Tensor } from "onnxruntime-web";
import { Config } from "./configs";
import { Encoder, createEncoderInput } from "./encoder";
import { ScoreDecoder } from "./decoder";
import { EncodedSymbol } from "./encoded_symbol";

export class Staff2Score {
  private encoder: Encoder;
  private decoder: ScoreDecoder;
  private config: Config;

  constructor(encoderSession: InferenceSession, decoderSession: InferenceSession, config: Config) {
    this.config = config;
    this.encoder = new Encoder(encoderSession, false);
    this.decoder = new ScoreDecoder(decoderSession, false, config);
  }

  async predict(image: Uint8Array, height: number, width: number): Promise<EncodedSymbol[]> {
    const x = createEncoderInput(image, height, width);
    const context = await this.encoder.generate(x, [1, 1, height, width]);

    const startToken = BigInt64Array.from([BigInt(1)]);
    const nonoteToken = BigInt64Array.from([BigInt(0)]);

    const out = await this.decoder.generate(startToken, nonoteToken, context);
    return out;
  }
}
