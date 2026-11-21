import * as ort from "onnxruntime-web";
import type { InferenceSession, Tensor } from "onnxruntime-web";
import { Config } from "./configs";
import { EncodedSymbol } from "./encoded_symbol";

function invertVocab(vocab: Record<string, number>): Map<number, string> {
  const m = new Map<number, string>();
  for (const [k, v] of Object.entries(vocab)) m.set(v, k);
  return m;
}

function detokenize(token: number, vocab: Map<number, string>): string {
  const s = vocab.get(token);
  if (!s || s === "[BOS]" || s === "[EOS]" || s === "[PAD]") return "";
  return s;
}

export class ScoreDecoder {
  private session: InferenceSession;
  fp16: boolean;
  private config: Config;
  private maxSeqLen: number;
  private eosToken: number;
  private invRhythm: Map<number, string>;
  private invPitch: Map<number, string>;
  private invLift: Map<number, string>;
  private invArticulation: Map<number, string>;
  private invSlur: Map<number, string>;
  private invPosition: Map<number, string>;

  private outputNames: string[];
  private kvInputNames: string[];
  private kvOutputNames: string[];

  constructor(session: InferenceSession, fp16: boolean, config: Config) {
    this.session = session;
    this.fp16 = fp16;
    this.config = config;
    this.maxSeqLen = config.max_seq_len;
    this.eosToken = config.eos_token;

    this.invRhythm = invertVocab(config.rhythm_vocab);
    this.invPitch = invertVocab(config.pitch_vocab);
    this.invLift = invertVocab(config.lift_vocab);
    this.invArticulation = invertVocab(config.articulation_vocab);
    this.invSlur = invertVocab(config.slur_vocab);
    this.invPosition = invertVocab(config.position_vocab);

    const baseOutputs = [
      "out_rhythms",
      "out_pitchs",
      "out_lifts",
      "out_positions",
      "out_articulations",
      "out_slurs",
      "attention",
    ];

    this.kvInputNames = [];
    this.kvOutputNames = [];
    for (let i = 0; i < config.decoder_depth * 4; i++) {
      this.kvInputNames.push(`cache_in${i}`);
      this.kvOutputNames.push(`cache_out${i}`);
    }
    this.outputNames = [...baseOutputs, ...this.kvOutputNames];
  }

  async generate(startTokens: BigInt64Array, nonoteTokens: BigInt64Array, context: Tensor): Promise<EncodedSymbol[]> {
    const heads = this.config.decoder_heads;
    const headDim = Math.floor(this.config.decoder_dim / heads);
    const cacheDtype = this.fp16 ? "float16" : "float32";
    // The key/value cache starts out empty: shape (1, heads, 0, head_dim).
    const cacheData = this.fp16 ? new Uint16Array(0) : new Float32Array(0);

    let cache: Tensor[] = [];
    for (let i = 0; i < this.kvInputNames.length; i++) {
      cache.push(new ort.Tensor(cacheDtype, cacheData, [1, heads, 0, headDim]));
    }

    let outRhythm = startTokens;
    let outPitch = nonoteTokens;
    let outLift = nonoteTokens;
    let outArticulations = nonoteTokens;
    let outSlurs = nonoteTokens;

    const symbols: EncodedSymbol[] = [];
    // After the first step only the first context position is passed in, which
    // is what the exported model expects (see the Python decoder).
    const contextDim = context.dims[2];
    const contextReduced = new ort.Tensor(
      context.type,
      (context.data as any).slice(0, contextDim),
      [context.dims[0], 1, contextDim]
    );

    for (let step = 0; step < this.maxSeqLen; step++) {
      const xRhythm = new BigInt64Array(1);
      xRhythm[0] = outRhythm[outRhythm.length - 1];
      const xPitch = new BigInt64Array(1);
      xPitch[0] = outPitch[outPitch.length - 1];
      const xLift = new BigInt64Array(1);
      xLift[0] = outLift[outLift.length - 1];
      const xArticulations = new BigInt64Array(1);
      xArticulations[0] = outArticulations[outArticulations.length - 1];
      const xSlurs = new BigInt64Array(1);
      xSlurs[0] = outSlurs[outSlurs.length - 1];

      const ctx = step === 0 ? context : contextReduced;

      const feeds: Record<string, Tensor> = {
        rhythms: new ort.Tensor("int64", xRhythm, [1, 1]),
        pitchs: new ort.Tensor("int64", xPitch, [1, 1]),
        lifts: new ort.Tensor("int64", xLift, [1, 1]),
        articulations: new ort.Tensor("int64", xArticulations, [1, 1]),
        slurs: new ort.Tensor("int64", xSlurs, [1, 1]),
        context: ctx,
        cache_len: new ort.Tensor("int64", BigInt64Array.from([BigInt(step)]), [1]),
      };
      for (let i = 0; i < this.kvInputNames.length; i++) {
        feeds[this.kvInputNames[i]] = cache[i];
      }

      const outputs = await this.session.run(feeds);

      const rhythmOut = outputs["out_rhythms"].data as Float32Array;
      const pitchOut = outputs["out_pitchs"].data as Float32Array;
      const liftOut = outputs["out_lifts"].data as Float32Array;
      const positionOut = outputs["out_positions"].data as Float32Array;
      const articulationOut = outputs["out_articulations"].data as Float32Array;
      const slurOut = outputs["out_slurs"].data as Float32Array;
      const attention = outputs["attention"].data as Float32Array;

      cache = this.kvOutputNames.map((name) => outputs[name]);

      const rhythmVocabSize = rhythmOut.length;
      const pitchVocabSize = pitchOut.length;
      const liftVocabSize = liftOut.length;
      const articulationVocabSize = articulationOut.length;
      const slurVocabSize = slurOut.length;
      const positionVocabSize = positionOut.length;

      const rhythmSample = argmax(rhythmOut, rhythmVocabSize);
      const pitchSample = argmax(pitchOut, pitchVocabSize);
      const liftSample = argmax(liftOut, liftVocabSize);
      const articulationSample = argmax(articulationOut, articulationVocabSize);
      const slurSample = argmax(slurOut, slurVocabSize);
      const positionSample = argmax(positionOut, positionVocabSize);

      if (rhythmSample === this.eosToken) break;

      const rhythmToken = detokenize(rhythmSample, this.invRhythm);
      const pitchToken = detokenize(pitchSample, this.invPitch);
      const liftToken = detokenize(liftSample, this.invLift);
      const articulationToken = detokenize(articulationSample, this.invArticulation);
      const slurToken = detokenize(slurSample, this.invSlur);
      const positionToken = detokenize(positionSample, this.invPosition);

      const symbol = new EncodedSymbol(
        rhythmToken,
        pitchToken,
        liftToken,
        articulationToken,
        slurToken,
        positionToken,
        attention
      );
      symbols.push(symbol);

      outRhythm = BigInt64Array.from([...outRhythm, BigInt(rhythmSample)]);
      outPitch = BigInt64Array.from([...outPitch, BigInt(pitchSample)]);
      outLift = BigInt64Array.from([...outLift, BigInt(liftSample)]);
      outArticulations = BigInt64Array.from([...outArticulations, BigInt(articulationSample)]);
      outSlurs = BigInt64Array.from([...outSlurs, BigInt(slurSample)]);
    }

    return symbols;
  }
}

function argmax(arr: Float32Array, vocabSize: number): number {
  let maxVal = -Infinity;
  let maxIdx = 0;
  for (let i = 0; i < vocabSize; i++) {
    if (arr[i] > maxVal) {
      maxVal = arr[i];
      maxIdx = i;
    }
  }
  return maxIdx;
}
