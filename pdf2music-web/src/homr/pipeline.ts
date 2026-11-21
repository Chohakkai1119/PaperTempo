import * as ort from "onnxruntime-web";
import type { InferenceSession } from "onnxruntime-web";
import { Config } from "./configs";
import { Segnet, segnetInference } from "./segnet";
import { Staff2Score } from "./staff2score";
import { EncodedSymbol, removeDuplicatedSymbols } from "./encoded_symbol";
import { generate_xml, XmlGeneratorArguments } from "./music_xml_generator";
import { autocrop } from "./autocrop";
import { resize_image } from "./resize";
import { apply_clahe } from "./color_adjust";
import { filter_predictions } from "./noise_filtering";
import { create_bounding_ellipses, create_rotated_bounding_boxes } from "./bounding_boxes";
import { prepareBarLineImage, detectBarLines } from "./bar_line_detection";
import { break_wide_fragments } from "./staff_detection";
import { make_lines_stronger } from "./staff_detection";
import { detect_staff } from "./staff_detection";
import { combine_noteheads_with_stems, add_notes_to_staffs } from "./note_detection";
import { find_braces_brackets_and_grand_staff_lines, prepare_brace_dot_image } from "./brace_dot_detection";
import { parse_staffs } from "./staff_parsing";
import { Debug } from "./debug";
import { InputPredictions } from "./model";

declare const cv: any;

export interface PipelineCallbacks {
  onProgress: (msg: string) => void;
}

// cv.matFromArray() goes through a plain JS array, which is far too slow for
// full page sized masks, so the buffer is copied into the Mat directly.
function matFromU8(rows: number, cols: number, data: Uint8Array) {
  const mat = new cv.Mat(rows, cols, cv.CV_8U);
  mat.data.set(data);
  return mat;
}

export class Pipeline {
  private segnetSession: InferenceSession | null = null;
  private encoderSession: InferenceSession | null = null;
  private decoderSession: InferenceSession | null = null;
  private staff2score: Staff2Score | null = null;
  private config: Config;

  constructor() {
    this.config = new Config();
  }

  async loadModels(
    segnetData: ArrayBuffer,
    encoderData: ArrayBuffer,
    decoderData: ArrayBuffer
  ): Promise<void> {
    this.segnetSession = await ort.InferenceSession.create(segnetData, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });

    this.encoderSession = await ort.InferenceSession.create(encoderData, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });

    this.decoderSession = await ort.InferenceSession.create(decoderData, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });

    this.staff2score = new Staff2Score(this.encoderSession, this.decoderSession, this.config);
  }

  async processImage(
    imageData: Uint8Array,
    width: number,
    height: number,
    callbacks: PipelineCallbacks
  ): Promise<string> {
    if (!this.segnetSession || !this.staff2score) {
      throw new Error("Models not loaded");
    }

    const debug = new Debug();

    // Convert to cv.Mat (BGR)
    const src = cv.matFromImageData(
      new ImageData(
        new Uint8ClampedArray(imageData),
        width,
        height
      )
    );
    cv.cvtColor(src, src, cv.COLOR_RGBA2BGR);
    let image = src;

    // Autocrop
    callbacks.onProgress("Autocropping image...");
    image = autocrop(image);

    // Resize
    callbacks.onProgress("Resizing image...");
    image = resize_image(image);

    // Preprocess (CLAHE)
    callbacks.onProgress("Applying CLAHE...");
    const preprocessed = apply_clahe(image);

    // Segnet inference
    callbacks.onProgress("Running segnet inference...");
    const segnet = new Segnet(this.segnetSession!, false);

    // segnet runs on the CLAHE-preprocessed grayscale image; it expands it to
    // three identical channels itself.
    const imgHeight = preprocessed.rows;
    const imgWidth = preprocessed.cols;
    const grayData = new Uint8Array(preprocessed.data);

    const segnetResult = await segnetInference(segnet, grayData, imgHeight, imgWidth, 320, 8);

    // Create predictions
    const { height: segH, width: segW } = segnetResult;
    const staffMat = matFromU8(segH, segW, segnetResult.staff);
    const symbolsMat = matFromU8(segH, segW, segnetResult.symbols);
    const noteheadMat = matFromU8(segH, segW, segnetResult.notehead);
    const clefsKeysMat = matFromU8(segH, segW, segnetResult.clefs_keys);
    const stemsRestMat = matFromU8(segH, segW, segnetResult.stems_rests);

    // Resize original and preprocessed to match staff size
    const originalResized = new cv.Mat();
    cv.resize(image, originalResized, new cv.Size(segnetResult.width, segnetResult.height));
    const preprocessedResized = new cv.Mat();
    cv.resize(preprocessed, preprocessedResized, new cv.Size(segnetResult.width, segnetResult.height));

    let predictions = new InputPredictions(
      originalResized,
      preprocessedResized,
      noteheadMat,
      symbolsMat,
      staffMat,
      clefsKeysMat,
      stemsRestMat
    );

    // Noise filtering
    callbacks.onProgress("Filtering noise...");
    predictions = filter_predictions(predictions, debug);

    // Make lines stronger
    predictions.staff = make_lines_stronger(predictions.staff, [1, 2]);

    // Predict symbols
    callbacks.onProgress("Detecting symbols...");
    const noteheads = create_bounding_ellipses(predictions.notehead, false, [4, 4]);
    const staffFragments = create_rotated_bounding_boxes(
      predictions.staff,
      true,
      [5, 1],
      [10000, 100]
    );
    const clefsKeys = create_rotated_bounding_boxes(
      predictions.clefs_keys,
      false,
      [20, 40],
      [1000, 1000]
    );
    const stemsRest = create_rotated_bounding_boxes(predictions.stems_rest);
    const barLineImg = prepareBarLineImage(predictions.stems_rest);
    // (1, 5) is the *minimum* size here, as in main.py; passing it as max_size
    // threw away every bar line taller than 5px, i.e. all of them.
    const barLinesRaw = create_rotated_bounding_boxes(barLineImg, true, [1, 5]);

    // Break wide fragments
    const brokenFragments = break_wide_fragments(staffFragments);

    // Combine noteheads with stems
    callbacks.onProgress("Combining noteheads with stems...");
    const noteheadsWithStems = combine_noteheads_with_stems(noteheads, stemsRest);
    if (noteheadsWithStems.length === 0) throw new Error("No noteheads found");

    // Average note head height
    const heights = noteheadsWithStems.map((n) => n.notehead.size[1]);
    heights.sort((a: number, b: number) => a - b);
    const averageNoteHeadHeight = heights[Math.floor(heights.length / 2)] || 1;

    // Filter bar lines
    const allNoteheads = noteheadsWithStems.map((n) => n.notehead);
    const allStems = noteheadsWithStems
      .filter((n) => n.stem)
      .map((n) => n.stem!);
    const barLinesOrRests = barLinesRaw.filter(
      (line) =>
        !line.is_overlapping_with_any(allNoteheads) &&
        !line.is_overlapping_with_any(allStems)
    );
    const barLineBoxes = detectBarLines(barLinesOrRests, averageNoteHeadHeight);

    // Detect staffs
    callbacks.onProgress("Detecting staffs...");
    const staffs = detect_staff(
      debug,
      predictions.staff,
      brokenFragments,
      clefsKeys,
      barLineBoxes
    );
    if (staffs.length === 0) throw new Error("No staffs found");

    // Brace/dot detection
    const braceDotImg = prepare_brace_dot_image(predictions.symbols, predictions.staff);
    const braceDot = create_rotated_bounding_boxes(braceDotImg, true, undefined, [100, -1]);

    // Add notes to staffs
    const notes = add_notes_to_staffs(
      staffs,
      noteheadsWithStems,
      predictions.symbols,
      predictions.notehead
    );

    // Find braces and grand staffs
    const multiStaffs = find_braces_brackets_and_grand_staff_lines(debug, staffs, braceDot);

    // Parse staffs (run transformer)
    callbacks.onProgress("Running transformer inference on staffs...");
    const resultStaffs = await parse_staffs(
      debug,
      multiStaffs,
      predictions.preprocessed,
      this.config,
      this.staff2score!,
      -1
    );

    // Generate MusicXML
    callbacks.onProgress("Generating MusicXML...");
    const xmlArgs = new XmlGeneratorArguments(false, null, null);
    const musicxml = generate_xml(xmlArgs, resultStaffs, "");

    // Cleanup. Mats can alias each other (resize_image returns its input when
    // the image is already the target width) and the filtering stages take
    // ownership of some of the masks, so freeing is best effort.
    for (const mat of [
      src,
      image,
      preprocessed,
      staffMat,
      symbolsMat,
      noteheadMat,
      clefsKeysMat,
      stemsRestMat,
      originalResized,
      preprocessedResized,
    ]) {
      try {
        if (!mat.isDeleted()) mat.delete();
      } catch {
        // already released
      }
    }

    return musicxml;
  }
}
