import { Config, default_config } from "./configs";
import { Debug } from "./debug";
import { crop_image_and_return_new_top } from "./image_utils";
import { MultiStaff, Staff } from "./model";
import { StaffDewarping, dewarp_staff_image } from "./staff_dewarping";
import { parse_staff_tromr } from "./staff_parsing_tromr";
import { StaffRegions } from "./staff_regions";
import { Staff2Score } from "./staff2score";
import { EncodedSymbol, removeDuplicatedSymbols } from "./encoded_symbol";

declare const cv: any;

type NDArray = any;
type Pt = [number, number];

class InvalidStaffRegion extends Error {}

function eprint(...args: any[]): void {
  console.warn(...args);
}

function _have_all_the_same_number_of_staffs(staffs: MultiStaff[]): boolean {
  for (const staff of staffs) {
    if (staff.staffs.length !== staffs[0].staffs.length) {
      return false;
    }
  }
  return true;
}

function _is_close_to_image_top_or_bottom(staff: MultiStaff, image: NDArray): boolean {
  const tolerance = 50.0;
  const closestDistanceToTopOrBottom = staff.staffs.map(
    (s) => Math.min(s.minX, image.rows - s.maxX)
  );
  return Math.min(...closestDistanceToTopOrBottom) < tolerance;
}

function _ensure_same_number_of_staffs(
  staffs: MultiStaff[],
  image: NDArray
): MultiStaff[] {
  if (_have_all_the_same_number_of_staffs(staffs)) {
    return staffs;
  }
  if (staffs.length > 2) {
    if (
      _is_close_to_image_top_or_bottom(staffs[0], image) &&
      _have_all_the_same_number_of_staffs(staffs.slice(1))
    ) {
      eprint("Removing first system from all voices, as it has a different number of staffs");
      return staffs.slice(1);
    }
    if (
      _is_close_to_image_top_or_bottom(staffs[staffs.length - 1], image) &&
      _have_all_the_same_number_of_staffs(staffs.slice(0, -1))
    ) {
      eprint("Removing last system from all voices, as it has a different number of staffs");
      return staffs.slice(0, -1);
    }
  }
  const result: MultiStaff[] = [];
  for (const staff of staffs) {
    result.push(...staff.breakApart());
  }
  return result.sort((a, b) => a.staffs[0].minY - b.staffs[0].minY);
}

function _get_number_of_voices(staffs: MultiStaff[]): number {
  return staffs[0].staffs.length;
}

export const tr_omr_max_height = default_config.max_height;
export const tr_omr_max_width = default_config.max_width;

export function get_tr_omr_canvas_size(
  image_shape: number[],
  margin_top: number = 0,
  margin_bottom: number = 0
): [number, number] {
  const tr_omr_max_height_with_margin =
    tr_omr_max_height - margin_top - margin_bottom;
  const tr_omr_ratio =
    tr_omr_max_height_with_margin / tr_omr_max_width;
  const height = image_shape[0];
  const width = image_shape[1];

  let newShape: [number, number];
  if (height / width > tr_omr_ratio) {
    newShape = [
      Math.floor((width / height) * tr_omr_max_height_with_margin),
      tr_omr_max_height_with_margin,
    ];
  } else {
    newShape = [
      tr_omr_max_width,
      Math.floor((height / width) * tr_omr_max_width),
    ];
  }
  return newShape;
}

export function center_image_on_canvas(
  image: NDArray,
  canvas_size: [number, number],
  margin_top: number = 0,
  margin_bottom: number = 0
): NDArray {
  const isGrayscale = image.channels() === 1;

  const resized = new cv.Mat();
  cv.resize(image, resized, new cv.Size(canvas_size[0], canvas_size[1]));

  let newImage: any;
  if (isGrayscale) {
    newImage = new cv.Mat(
      tr_omr_max_height,
      tr_omr_max_width,
      cv.CV_8UC1,
      new cv.Scalar(255)
    );
  } else {
    newImage = new cv.Mat(
      tr_omr_max_height,
      tr_omr_max_width,
      cv.CV_8UC3,
      new cv.Scalar(255, 255, 255, 255)
    );
  }

  const x_offset = 0;
  const tr_omr_max_height_with_margin =
    tr_omr_max_height - margin_top - margin_bottom;
  const y_offset =
    Math.floor((tr_omr_max_height_with_margin - resized.rows) / 2) + margin_top;

  const rect = new cv.Rect(
    x_offset,
    y_offset,
    resized.cols,
    resized.rows
  );
  const dstRoi = newImage.roi(rect);
  resized.copyTo(dstRoi);
  dstRoi.delete();
  resized.delete();

  return newImage;
}

export function add_image_into_tr_omr_canvas(image: NDArray): NDArray {
  const newShape = get_tr_omr_canvas_size([image.rows, image.cols]);
  const newImage = center_image_on_canvas(image, newShape);
  return newImage;
}

export function remove_black_contours_at_edges_of_image(
  gray: NDArray,
  unit_size: number
): NDArray {
  const thresh = new cv.Mat();
  cv.threshold(gray, thresh, 97, 255, cv.THRESH_BINARY);
  const inverted = new cv.Mat();
  cv.bitwise_not(thresh, inverted);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(inverted, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
  const threshold = 2 * unit_size;
  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const rect = cv.boundingRect(cnt);
    const x = rect.x;
    const y = rect.y;
    const w = rect.width;
    const h = rect.height;
    if (w < threshold || h < threshold) {
      cnt.delete();
      continue;
    }
    const isAtEdgeOfImage =
      x === 0 ||
      y === 0 ||
      x + w === gray.cols ||
      y + h === gray.rows;
    if (!isAtEdgeOfImage) {
      cnt.delete();
      continue;
    }
    const subRect = new cv.Rect(x, y, w, h);
    const sub = inverted.roi(subRect);
    const mean = cv.mean(sub);
    sub.delete();
    const averageGrayIntensity = 127;
    const isMostlyDark = mean[0] < averageGrayIntensity;
    if (isMostlyDark) {
      cnt.delete();
      continue;
    }
    const roiRect = new cv.Rect(x, y, w, h);
    const roi = gray.roi(roiRect);
    roi.setTo(new cv.Scalar(255));
    roi.delete();
    cnt.delete();
  }
  contours.delete();
  hierarchy.delete();
  thresh.delete();
  inverted.delete();
  return gray;
}

function _calculate_region(staff: Staff, regions: StaffRegions): number[] {
  const x_min = staff.minX - 2 * staff.averageUnitSize;
  const x_max = staff.maxX + 2 * staff.averageUnitSize;
  const y_min = Math.max(
    staff.minY - 4 * staff.averageUnitSize,
    regions.get_start_of_closest_staff_above(staff.minY)
  );
  const y_max = Math.min(
    staff.maxY + 4 * staff.averageUnitSize,
    regions.get_start_of_closest_staff_below(staff.maxY)
  );
  return [Math.floor(x_min), Math.floor(y_min), Math.floor(x_max), Math.floor(y_max)];
}

export function prepare_staff_image(
  debug: Debug,
  index: number,
  staff: Staff,
  staff_image: NDArray,
  regions: StaffRegions
): [NDArray, Staff] {
  let region = _calculate_region(staff, regions);
  const regionHeight = Math.floor(region[3] - region[1]);
  const regionWidth = Math.floor(region[2] - region[0]);
  if (!Number.isFinite(regionHeight) || !Number.isFinite(regionWidth) || regionHeight <= 0 || regionWidth <= 0) {
    throw new InvalidStaffRegion(`Detected staff ${index + 1} has empty image bounds.`);
  }
  const imageDimensions = get_tr_omr_canvas_size([regionHeight, regionWidth]);
  if (imageDimensions.some((dimension) => !Number.isFinite(dimension) || dimension <= 0)) {
    throw new InvalidStaffRegion(`Detected staff ${index + 1} cannot be resized.`);
  }
  const scalingFactor = imageDimensions[1] / (region[3] - region[1]);
  const resized = new cv.Mat();
  cv.resize(
    staff_image,
    resized,
    new cv.Size(
      Math.floor(staff_image.cols * scalingFactor),
      Math.floor(staff_image.rows * scalingFactor)
    )
  );
  staff_image = resized;
  region = region.map((r) => Math.round(r * scalingFactor));
  eprint("Dewarping staff", index);
  const regionStep1 = [
    region[0] - 10,
    region[1] - 50,
    region[2] + 10,
    region[3] + 50,
  ];
  let cropResult = crop_image_and_return_new_top(
    staff_image,
    regionStep1[0],
    regionStep1[1],
    regionStep1[2],
    regionStep1[3]
  );
  staff_image = cropResult[0];
  let topLeft: number[] = cropResult[1];
  const regionStep2 = [
    region[0] - topLeft[0],
    region[1] - topLeft[1],
    region[2] - topLeft[0],
    region[3] - topLeft[1],
  ];
  topLeft = topLeft.map((v) => v / scalingFactor);
  staff = _dewarp_staff(staff, null, topLeft, scalingFactor);
  const dewarp = dewarp_staff_image(staff_image, staff, index, debug);
  staff_image = dewarp.dewarp(staff_image);
  cropResult = crop_image_and_return_new_top(
    staff_image,
    regionStep2[0],
    regionStep2[1],
    regionStep2[2],
    regionStep2[3]
  );
  staff_image = cropResult[0];
  topLeft = cropResult[1];
  const finalScalingFactor = 1;

  eprint("Dewarping staff", index, "done");

  staff_image = remove_black_contours_at_edges_of_image(
    staff_image,
    staff.averageUnitSize
  );
  staff_image = center_image_on_canvas(staff_image, imageDimensions);
  debug.write_image_with_fixed_suffix(`_staff-${index}_input.jpg`, staff_image);
  if (debug.debug) {
    const transformedStaff = _dewarp_staff(staff, dewarp, topLeft, finalScalingFactor);
    const transformedStaffImage = staff_image.clone();
    for (const symbol of transformedStaff.symbols) {
      const center = symbol.center;
      cv.circle(
        transformedStaffImage,
        new cv.Point(Math.floor(center[0]), Math.floor(center[1])),
        5,
        new cv.Scalar(0, 0, 255, 255)
      );
      cv.putText(
        transformedStaffImage,
        symbol.constructor.name,
        new cv.Point(Math.floor(center[0]), Math.floor(center[1])),
        cv.FONT_HERSHEY_SIMPLEX,
        0.3,
        new cv.Scalar(0, 0, 255, 255),
        1
      );
    }
    debug.write_image_with_fixed_suffix(
      `_staff-${index}_debug_annotated.jpg`,
      transformedStaffImage
    );
    transformedStaffImage.delete();
  }
  return [staff_image, staff];
}

function _dewarp_staff(
  staff: Staff,
  dewarp: StaffDewarping | null,
  region: number[],
  scaling: number
): Staff {
  const transformCoordinates = (point: Pt): Pt => {
    let x = point[0];
    let y = point[1];
    x -= region[0];
    y -= region[1];
    if (dewarp !== null) {
      [x, y] = dewarp.dewarp_point([x, y]);
    }
    x = x * scaling;
    y = y * scaling;
    return [x, y];
  };

  return staff.transformCoordinates(transformCoordinates);
}

export async function parse_staff_image(
  debug: Debug,
  index: number,
  staff: Staff,
  image: NDArray,
  regions: StaffRegions,
  config: Config,
  staff2score: Staff2Score
): Promise<EncodedSymbol[]> {
  let staffImage: NDArray;
  let transformedStaff: Staff;
  try {
    [staffImage, transformedStaff] = prepare_staff_image(debug, index, staff, image, regions);
  } catch (error) {
    if (error instanceof InvalidStaffRegion) {
      eprint(`Skipping malformed staff ${index + 1}:`, error.message);
      return [];
    }
    throw error;
  }
  eprint("Running TrOmr inference on staff image", index);
  const result = await parse_staff_tromr(
    transformedStaff,
    staffImage,
    config,
    staff2score
  );
  if (debug.debug) {
    const resultImage = staffImage.clone();
    for (let i = 0; i < result.length; i++) {
      const symbol = result[i];
      const center = symbol.coordinates;
      if (center === null || symbol.rhythm.startsWith("chord")) {
        continue;
      }
      if (Number.isNaN(center[0]) || Number.isNaN(center[1])) {
        continue;
      }
      const centerInt = new cv.Point(Math.floor(center[0]), Math.floor(center[1]));
      cv.circle(resultImage, centerInt, 5, new cv.Scalar(0, 0, 255, 255), 2);
      cv.putText(
        resultImage,
        i + ": " + symbol.rhythm,
        new cv.Point(centerInt.x, centerInt.y - 10),
        cv.FONT_HERSHEY_SIMPLEX,
        0.3,
        new cv.Scalar(0, 0, 255, 255),
        1
      );
    }
    debug.write_image_with_fixed_suffix(`_staff-${index}_output.jpg`, resultImage);
    resultImage.delete();
  }
  return result;
}

export async function parse_staffs(
  debug: Debug,
  staffs: MultiStaff[],
  image: NDArray,
  config: Config,
  staff2score: Staff2Score,
  selected_staff: number = -1
): Promise<EncodedSymbol[][]> {
  staffs = _ensure_same_number_of_staffs(staffs, image);
  const numberOfVoices = _get_number_of_voices(staffs);
  let i = 0;
  const voices: EncodedSymbol[][] = [];
  const regions = new StaffRegions(staffs);
  for (let voice = 0; voice < numberOfVoices; voice++) {
    const staffsForVoice = staffs.map((staff) => staff.staffs[voice]);
    const resultForVoice: EncodedSymbol[] = [];
    for (let staffIndex = 0; staffIndex < staffsForVoice.length; staffIndex++) {
      const staff = staffsForVoice[staffIndex];
      if (selected_staff >= 0 && staffIndex !== selected_staff) {
        eprint("Ignoring staff due to selected_staff argument", i);
        i += 1;
        continue;
      }
      const resultStaff = await parse_staff_image(
        debug,
        i,
        staff,
        image,
        regions,
        config,
        staff2score
      );
      if (resultStaff.length === 0) {
        eprint("Skipping empty staff", i);
        i += 1;
        continue;
      }
      resultStaff.push(new EncodedSymbol("newline"));
      resultForVoice.push(...resultStaff);
      i += 1;
    }

    voices.push(removeDuplicatedSymbols(resultForVoice));
  }
  return voices;
}
