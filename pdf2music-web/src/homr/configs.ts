import { Vocabulary } from "./vocabulary";

const MODEL_NAME = "pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903";

export class FilePaths {
  encoder_path: string;
  decoder_path: string;
  encoder_path_fp16: string;
  decoder_path_fp16: string;
  rhythmtokenizer: string;
  lifttokenizer: string;
  pitchtokenizer: string;
  notetokenizer: string;

  constructor() {
    this.encoder_path = `encoder_${MODEL_NAME}.onnx`;
    this.decoder_path = `decoder_${MODEL_NAME}.onnx`;
    this.encoder_path_fp16 = `encoder_${MODEL_NAME}_fp16.onnx`;
    this.decoder_path_fp16 = `decoder_${MODEL_NAME}_fp16.onnx`;
    this.rhythmtokenizer = "tokenizer_rhythm.json";
    this.lifttokenizer = "tokenizer_lift.json";
    this.pitchtokenizer = "tokenizer_pitch.json";
    this.notetokenizer = "tokenizer_note.json";
  }
}

export class Config {
  vocab: Vocabulary;
  filepaths: FilePaths;
  channels = 1;
  patch_size = 16;
  max_height = 256;
  max_width = 1280;
  max_seq_len = 608;
  pad_token = 0;
  bos_token = 1;
  eos_token = 2;
  nonote_token = 0;
  encoder_structure = "convnext";
  encoder_depth = 8;
  backbone_layers = [3, 4, 6, 3];
  encoder_dim = 512;
  encoder_h_dim: number;
  encoder_heads = 8;
  decoder_dim: number;
  decoder_depth = 8;
  decoder_heads = 8;
  use_gpu_inference = false;
  use_coreml_encoder = false;

  lift_vocab: Record<string, number>;
  pitch_vocab: Record<string, number>;
  rhythm_vocab: Record<string, number>;
  articulation_vocab: Record<string, number>;
  slur_vocab: Record<string, number>;
  position_vocab: Record<string, number>;

  constructor() {
    this.vocab = new Vocabulary();
    this.filepaths = new FilePaths();
    this.encoder_h_dim = Math.floor(this.encoder_dim / 3);
    this.decoder_dim = this.encoder_dim;
    this.lift_vocab = this.vocab.lift;
    this.pitch_vocab = this.vocab.pitch;
    this.rhythm_vocab = this.vocab.rhythm;
    this.articulation_vocab = this.vocab.articulation;
    this.slur_vocab = this.vocab.slur;
    this.position_vocab = this.vocab.position;
  }
}

export const default_config = new Config();
