import * as constants from "./constants";
import { find_peaks } from "./find_peaks";
import {
  DebugDrawable,
  RotatedBoundingBox,
  create_rotated_bounding_box,
} from "./bounding_boxes";
import { Debug } from "./debug";
import { Staff, StaffPoint } from "./model";

declare const cv: any;

type NDArray = any;
type Color = [number, number, number];

function eprint(...args: any[]): void {
  console.warn(...args);
}

function npMean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function npStd(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = npMean(values);
  let sum = 0;
  for (const v of values) sum += (v - mean) * (v - mean);
  return Math.sqrt(sum / values.length);
}

export function prepare_staff_image(img: NDArray): NDArray {
  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 3));
  const out = new cv.Mat();
  const src = new cv.Mat();
  img.convertTo(src, cv.CV_8U);
  cv.erode(src, out, kernel);
  const kernel2 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 3));
  const dst = new cv.Mat();
  cv.dilate(out, dst, kernel2);
  src.delete();
  out.delete();
  kernel.delete();
  kernel2.delete();
  return dst;
}

export function make_lines_stronger(
  img: NDArray,
  kernel_size: [number, number]
): NDArray {
  const kernel = cv.getStructuringElement(
    cv.MORPH_ELLIPSE,
    new cv.Size(kernel_size[0], kernel_size[1])
  );
  const src = new cv.Mat();
  img.convertTo(src, cv.CV_8U);
  const dilated = new cv.Mat();
  cv.dilate(src, dilated, kernel);
  const dst = new cv.Mat();
  cv.threshold(dilated, dst, 0.1, 1, cv.THRESH_BINARY);
  const result = new cv.Mat();
  dst.convertTo(result, cv.CV_8U);
  src.delete();
  dilated.delete();
  dst.delete();
  kernel.delete();
  return result;
}

export class StaffLineSegment extends DebugDrawable {
  debug_id: number;
  staff_fragments: RotatedBoundingBox[];
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;

  constructor(debug_id: number, staff_fragments: RotatedBoundingBox[]) {
    super();
    this.debug_id = debug_id;
    this.staff_fragments = [...staff_fragments].sort(
      (a, b) => a.box.center[0] - b.box.center[0]
    );
    this.min_x = Math.min(
      ...staff_fragments.map((line) => line.center[0] - line.size[0] / 2)
    );
    this.max_x = Math.max(
      ...staff_fragments.map((line) => line.center[0] + line.size[0] / 2)
    );
    this.min_y = Math.min(
      ...staff_fragments.map((line) => line.center[1] - line.size[1] / 2)
    );
    this.max_y = Math.max(
      ...staff_fragments.map((line) => line.center[1] + line.size[1] / 2)
    );
  }

  merge(other: StaffLineSegment): StaffLineSegment {
    const staffLines: RotatedBoundingBox[] = [...this.staff_fragments];
    for (const fragment of other.staff_fragments) {
      if (!staffLines.includes(fragment)) {
        staffLines.push(fragment);
      }
    }
    return new StaffLineSegment(this.debug_id, staffLines);
  }

  get_at(x: number): RotatedBoundingBox | null {
    const tolerance = constants.staff_line_segment_x_tolerance;
    for (const fragment of this.staff_fragments) {
      if (
        x >= fragment.center[0] - fragment.size[0] / 2 - tolerance &&
        x <= fragment.center[0] + fragment.size[0] / 2 + tolerance
      ) {
        return fragment;
      }
    }
    return null;
  }

  is_overlapping(other: StaffLineSegment): boolean {
    for (const line of this.staff_fragments) {
      for (const otherLine of other.staff_fragments) {
        if (line.is_overlapping(otherLine)) {
          return true;
        }
      }
    }
    return false;
  }

  draw_onto_image(
    img: NDArray,
    color: Color = [255, 0, 0]
  ): void {
    for (const line of this.staff_fragments) {
      line.draw_onto_image(img, color);
    }
    const first = this.staff_fragments[0].box.center;
    cv.putText(
      img,
      String(this.debug_id),
      new cv.Point(Math.floor(first[0]), Math.floor(first[1])),
      cv.FONT_HERSHEY_SIMPLEX,
      1,
      color,
      2,
      cv.LINE_AA
    );
  }
}

export class StaffAnchor extends DebugDrawable {
  staff_lines: StaffLineSegment[];
  unit_sizes: number[];
  average_unit_size: number;
  symbol: RotatedBoundingBox;
  max_y: number;
  min_y: number;
  y_range: number[];
  zone: number[];

  constructor(staff_lines: StaffLineSegment[], symbol: RotatedBoundingBox) {
    super();
    this.staff_lines = staff_lines;
    const yPositions = staff_lines
      .map((line) => line.staff_fragments[0].get_center_extrapolated(symbol.center[0]))
      .sort((a, b) => a - b);
    const yDeltas: number[] = [];
    for (let i = 1; i < yPositions.length; i++) {
      yDeltas.push(Math.abs(yPositions[i] - yPositions[i - 1]));
    }
    this.unit_sizes = yDeltas;
    this.average_unit_size =
      yDeltas.length === 0 ? 0.0 : npMean(yDeltas);
    this.symbol = symbol;
    this.max_y = Math.max(...staff_lines.map((line) => line.max_y));
    this.min_y = Math.min(...staff_lines.map((line) => line.min_y));
    const maxNumberOfLedgerLines = 5;
    const startY = Math.floor(Math.min(...yPositions));
    const endY = Math.floor(Math.max(...yPositions));
    this.y_range = [];
    for (let v = startY; v < endY; v++) this.y_range.push(v);
    this.zone = [];
    const zoneStart = Math.floor(
      this.min_y - maxNumberOfLedgerLines * this.average_unit_size
    );
    const zoneEnd = Math.floor(
      this.max_y + maxNumberOfLedgerLines * this.average_unit_size
    );
    for (let v = zoneStart; v < zoneEnd; v++) this.zone.push(v);
  }

  draw_onto_image(
    img: NDArray,
    color: Color = [0, 255, 0]
  ): void {
    for (const staff of this.staff_lines) {
      staff.draw_onto_image(img, color);
    }
    this.symbol.draw_onto_image(img, color);
    const x = Math.floor(this.symbol.center[0]);
    cv.line(img, new cv.Point(x - 50, this.zone[0]), new cv.Point(x + 50, this.zone[0]), color, 2);
    cv.line(
      img,
      new cv.Point(x - 50, this.zone[this.zone.length - 1] + 1),
      new cv.Point(x + 50, this.zone[this.zone.length - 1] + 1),
      color,
      2
    );
  }
}

function _get_all_contours(lines: StaffLineSegment[]): number[][][] {
  const allFragments: RotatedBoundingBox[] = [];
  for (const line of lines) {
    allFragments.push(...line.staff_fragments);
  }
  const result: number[][][] = [];
  for (const fragment of allFragments) {
    result.push(fragment.contours);
  }
  return result;
}

export class RawStaff extends RotatedBoundingBox {
  staff_id: number;
  lines: StaffLineSegment[];
  anchors: StaffAnchor[];
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;

  constructor(
    staff_id: number,
    lines: StaffLineSegment[],
    anchors: StaffAnchor[]
  ) {
    const allContours = _get_all_contours(lines);
    const flatContours: number[][] = [];
    const flat: number[] = [];
    for (const c of allContours) {
      for (const p of c) {
        flatContours.push([p[0], p[1]]);
        flat.push(p[0], p[1]);
      }
    }
    const pointsMat = cv.matFromArray(
      flatContours.length === 0 ? 0 : flatContours.length,
      1,
      cv.CV_32SC2,
      flat
    );
    const cvRect = cv.minAreaRect(pointsMat);
    pointsMat.delete();
    const box = {
      center: [cvRect.center.x, cvRect.center.y] as [number, number],
      size: [cvRect.size.width, cvRect.size.height] as [number, number],
      angle: cvRect.angle,
    };
    super(box, flatContours, staff_id);
    this.staff_id = staff_id;
    this.lines = lines;
    this.anchors = anchors;
    this.min_x = this.center[0] - this.size[0] / 2;
    this.max_x = this.center[0] + this.size[0] / 2;
    this.min_y = this.center[1] - this.size[1] / 2;
    this.max_y = this.center[1] + this.size[1] / 2;
  }

  merge(other: RawStaff): RawStaff {
    const lines: StaffLineSegment[] = [];
    for (let i = 0; i < this.lines.length; i++) {
      lines.push(other.lines[i].merge(this.lines[i]));
    }
    return new RawStaff(this.staff_id, lines, [...this.anchors, ...other.anchors]);
  }

  draw_onto_image(
    img: NDArray,
    color: Color = [255, 0, 0]
  ): void {
    for (const line of this.lines) {
      line.draw_onto_image(img, color);
    }
  }
}

export function get_staff_for_anchor(
  anchor: StaffAnchor,
  staffs: RawStaff[]
): RawStaff | null {
  for (const staff of staffs) {
    for (let i = 0; i < anchor.staff_lines.length; i++) {
      const anchorLine = anchor.staff_lines[i];
      const lineRequirement = new Set(anchorLine.staff_fragments);
      const staffFragments = new Set(staff.lines[i].staff_fragments);
      let isSubset = true;
      for (const frag of lineRequirement) {
        if (!staffFragments.has(frag)) {
          isSubset = false;
          break;
        }
      }
      if (isSubset) {
        return staff;
      }
    }
  }
  return null;
}

export function find_raw_staffs_by_connecting_line_fragments(
  anchors: StaffAnchor[],
  staff_fragments: RotatedBoundingBox[]
): RawStaff[] {
  const staffs: RawStaff[] = [];
  let staffId = 0;
  for (const anchor of anchors) {
    const existingStaff = get_staff_for_anchor(anchor, staffs);
    const fragments = staff_fragments.filter(
      (fragment) =>
        fragment.center[1] >= anchor.zone[0] &&
        fragment.center[1] <= anchor.zone[anchor.zone.length - 1] + 1
    );
    const connected = connect_staff_lines(fragments, anchor.average_unit_size);
    const staffLines: StaffLineSegment[] = [];
    for (const anchorLine of anchor.staff_lines) {
      const lineRequirement = new Set(anchorLine.staff_fragments);
      const matchingAnchor = connected.filter((line) => {
        const lineFrags = new Set(line.staff_fragments);
        let isSubset = true;
        for (const frag of lineRequirement) {
          if (!lineFrags.has(frag)) {
            isSubset = false;
            break;
          }
        }
        return isSubset;
      });
      if (matchingAnchor.length === 1) {
        staffLines.push(...matchingAnchor);
      } else {
        staffLines.push(anchorLine);
      }
    }
    if (existingStaff) {
      const idx = staffs.indexOf(existingStaff);
      if (idx >= 0) staffs.splice(idx, 1);
      staffs.push(existingStaff.merge(new RawStaff(staffId, staffLines, [anchor])));
    } else {
      staffs.push(new RawStaff(staffId, staffLines, [anchor]));
    }
    staffId += 1;
  }
  return staffs;
}

export function remove_duplicate_staffs(staffs: RawStaff[]): RawStaff[] {
  const result: RawStaff[] = [];
  for (const staff of staffs) {
    const overlapping = result.filter((other) => staff.is_overlapping(other));
    if (overlapping.length === 0) {
      result.push(staff);
      continue;
    }
    const staffDuplicates = 2;
    if (overlapping.length >= staffDuplicates) {
      continue;
    }
    if (overlapping[0].anchors.length < staff.anchors.length) {
      const idx = result.indexOf(overlapping[0]);
      if (idx >= 0) result.splice(idx, 1);
      result.push(staff);
    }
  }
  return result;
}

export function connect_staff_lines(
  staff_lines: RotatedBoundingBox[],
  unit_size: number
): StaffLineSegment[] {
  const sortedByRightToLeft = [...staff_lines].sort(
    (a, b) => b.bottom_left[0] - a.bottom_left[0]
  );
  const result: RotatedBoundingBox[][] = [];
  let activeLinesToCheck: RotatedBoundingBox[][] = [];
  let lastCleanupAtX = 0;
  while (sortedByRightToLeft.length > 0) {
    const currentStaffLine = sortedByRightToLeft.pop()!;
    const x = currentStaffLine.bottom_left[0];

    if (x - lastCleanupAtX > constants.max_line_gap_size(unit_size)) {
      activeLinesToCheck = activeLinesToCheck.filter(
        (item) =>
          x - item[item.length - 1].bottom_right[0] <
          constants.max_line_gap_size(unit_size)
      );
      lastCleanupAtX = x;
    }

    const isShortLine = currentStaffLine.box.size[0] < constants.is_short_line(unit_size);
    if (isShortLine) {
      continue;
    }
    let connected = false;
    for (const activeLine of activeLinesToCheck) {
      if (
        activeLine[activeLine.length - 1].is_overlapping_extrapolated(
          currentStaffLine,
          unit_size
        )
      ) {
        activeLine.push(currentStaffLine);
        connected = true;
      }
    }
    if (!connected) {
      const newList = [currentStaffLine];
      result.push(newList);
      activeLinesToCheck.push(newList);
    }
  }
  const resultTopToBottom = [...result].sort(
    (a, b) => a[0].box.center[1] - b[0].box.center[1]
  );
  const connectedLines = resultTopToBottom.map(
    (staffLines, i) => new StaffLineSegment(i, staffLines)
  );
  return connectedLines;
}

export function are_lines_crossing(lines: StaffLineSegment[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[i].is_overlapping(lines[j])) {
        return true;
      }
    }
  }
  return false;
}

export function are_lines_parallel(
  lines: StaffLineSegment[],
  unit_size: number
): boolean {
  const allAngles: number[] = [];
  const allFragments: RotatedBoundingBox[] = [];
  for (const line of lines) {
    for (const fragment of line.staff_fragments) {
      allAngles.push(fragment.angle);
      allFragments.push(fragment);
    }
  }
  if (allAngles.length === 0) {
    return false;
  }
  const averageAngle = npMean(allAngles);
  for (const fragment of allFragments) {
    if (
      Math.abs(fragment.angle - averageAngle) >
        constants.max_angle_for_lines_to_be_parallel &&
      fragment.size[0] > constants.is_short_connected_line(unit_size)
    ) {
      return false;
    }
  }
  return true;
}

export function begins_or_ends_on_one_staff_line(
  line: RotatedBoundingBox,
  staff_lines: StaffLineSegment[],
  unit_size: number
): boolean {
  for (const staffLine of staff_lines) {
    const fragment = staffLine.get_at(line.center[0]);
    if (fragment === null) {
      continue;
    }
    const staffY = fragment.get_center_extrapolated(line.center[0]);
    if (Math.abs(staffY - line.center[1]) < unit_size) {
      return true;
    }
  }
  return false;
}

export function find_staff_anchors(
  staff_lines: RotatedBoundingBox[],
  anchor_symbols: RotatedBoundingBox[],
  are_clefs: boolean = false
): StaffAnchor[] {
  const result: StaffAnchor[] = [];

  for (const centerSymbol of anchor_symbols) {
    let adjacent: RotatedBoundingBox[];
    if (are_clefs) {
      adjacent = [
        centerSymbol.move_to_x_horizontal_by(-10),
        centerSymbol,
        centerSymbol.move_to_x_horizontal_by(10),
        centerSymbol.move_to_x_horizontal_by(30),
        centerSymbol.move_to_x_horizontal_by(60),
        centerSymbol.move_to_x_horizontal_by(80),
      ];
    } else {
      adjacent = [
        centerSymbol.move_to_x_horizontal_by(-10),
        centerSymbol.move_to_x_horizontal_by(-5),
        centerSymbol,
        centerSymbol.move_to_x_horizontal_by(5),
        centerSymbol.move_to_x_horizontal_by(10),
      ];
    }
    for (const symbol of adjacent) {
      const estimatedUnitSize = Math.round(
        symbol.size[1] / (constants.number_of_lines_on_a_staff - 1)
      );
      const thickenedBarLine = symbol.make_box_taller(estimatedUnitSize);
      const overlappingStaffLines = staff_lines.filter((line) =>
        line.is_intersecting(thickenedBarLine)
      );
      let connectedLines = connect_staff_lines(
        overlappingStaffLines,
        estimatedUnitSize
      );
      if (connectedLines.length > constants.number_of_lines_on_a_staff) {
        connectedLines = connectedLines.filter(
          (line) =>
            line.max_x - line.min_x >
            constants.is_short_connected_line(estimatedUnitSize)
        );
      }
      if (connectedLines.length !== constants.number_of_lines_on_a_staff) {
        continue;
      }
      if (!are_lines_parallel(connectedLines, estimatedUnitSize)) {
        continue;
      }
      if (are_lines_crossing(connectedLines)) {
        continue;
      }
      if (
        !are_clefs &&
        !begins_or_ends_on_one_staff_line(symbol, connectedLines, estimatedUnitSize)
      ) {
        continue;
      }

      result.push(new StaffAnchor(connectedLines, symbol));
    }
  }
  return result;
}

export function* resample_staff_segment(
  anchor: StaffAnchor,
  staff: RawStaff,
  axisRange: Iterable<number>
): Generator<StaffPoint> {
  const xAnchor = anchor.symbol.center[0];
  const lineFragments = anchor.staff_lines.map(
    (line) => line.staff_fragments[0]
  );
  const centers = lineFragments.map((line) => line.get_center_extrapolated(xAnchor));
  let previousPoint = new StaffPoint(
    xAnchor,
    centers,
    npMean(lineFragments.map((line) => line.angle))
  );
  for (const x of axisRange) {
    const lines = staff.lines.map((line) => line.get_at(x));
    const axisCenter: (number | null)[] = lines.map((line) =>
      line === null ? null : line.get_center_extrapolated(x)
    );
    const centerValues = axisCenter.filter(
      (c): c is number => c !== null
    );
    const incomplete = axisCenter.every((c) => c === null);
    if (incomplete) {
      continue;
    }
    const deltas: number[] = [];
    for (let i = 1; i < centerValues.length; i++) {
      deltas.push(centerValues[i] - centerValues[i - 1]);
    }
    const nonParallel = deltas.map((delta) => delta < 0.5 * anchor.average_unit_size);
    for (let i = 0; i < nonParallel.length; i++) {
      if (nonParallel[i]) {
        axisCenter[i] = null;
        axisCenter[i + 1] = null;
      }
    }

    for (let i = 0; i < previousPoint.y.length; i++) {
      const previousY = previousPoint.y[i];
      const centerValue = axisCenter[i];
      if (
        centerValue !== null &&
        Math.abs(centerValue - previousY) > 0.5 * anchor.average_unit_size
      ) {
        axisCenter[i] = null;
      }
    }

    let prevCenter = -1;
    const idxList: number[] = [];
    for (let i = 0; i < axisCenter.length; i++) idxList.push(i);
    const idxReversed: number[] = [];
    for (let i = axisCenter.length - 1; i >= 0; i--) idxReversed.push(i);
    const order = [...idxList, ...idxReversed];
    for (const i of order) {
      if (axisCenter[i] !== null) {
        prevCenter = i;
      } else if (prevCenter >= 0) {
        const centerValue = axisCenter[prevCenter];
        if (centerValue !== null) {
          axisCenter[i] =
            centerValue + anchor.average_unit_size * (i - prevCenter);
        }
      }
    }
    const incompleteAny = axisCenter.some((c) => c === null);
    if (incompleteAny) {
      continue;
    }
    const validLines = lines.filter((l): l is RotatedBoundingBox => l !== null);
    const angle = npMean(validLines.map((line) => line.angle));
    previousPoint = new StaffPoint(
      x,
      axisCenter.filter((c): c is number => c !== null),
      angle
    );
    yield previousPoint;
  }
}

export function resample_staff(staff: RawStaff): Staff {
  const anchorsLeftToRight = [...staff.anchors].sort(
    (a, b) => a.symbol.center[0] - b.symbol.center[0]
  );
  const staffDensity = 10;

  const roundToDensity = (x: number): number =>
    Math.round(x / staffDensity) * staffDensity;

  const start = Math.floor(staff.min_x / staffDensity) * staffDensity;
  const stop =
    (Math.floor(staff.max_x / staffDensity) + 1) * staffDensity;

  const grid: StaffPoint[] = [];
  let x = start;
  for (let i = 0; i < anchorsLeftToRight.length; i++) {
    const anchor = anchorsLeftToRight[i];
    const toLeftStart = roundToDensity(x);
    const toLeftStop = roundToDensity(anchor.symbol.center[0]);
    const toLeft: number[] = [];
    for (let v = toLeftStart; v < toLeftStop; v += staffDensity) toLeft.push(v);
    let toRight: number[];
    if (i < anchorsLeftToRight.length - 1) {
      const startR = Math.floor(anchor.symbol.center[0]);
      const endR = Math.floor(
        (anchor.symbol.center[0] +
          anchorsLeftToRight[i + 1].symbol.center[0]) /
          2
      );
      toRight = [];
      for (let v = startR; v < endR; v += staffDensity) toRight.push(v);
    } else {
      const startR = roundToDensity(anchor.symbol.center[0]);
      const endR = roundToDensity(stop);
      toRight = [];
      for (let v = startR; v < endR; v += staffDensity) toRight.push(v);
    }
    x = toRight.length > 0 ? toRight[toRight.length - 1] + staffDensity : x;

    const reversedLeft = [...toLeft].reverse();
    const leftGen = Array.from(resample_staff_segment(anchor, staff, reversedLeft));
    leftGen.reverse();
    grid.push(...leftGen);
    grid.push(...Array.from(resample_staff_segment(anchor, staff, toRight)));
  }

  return new Staff(grid);
}

export function resample_staffs(staffs: RawStaff[]): Staff[] {
  const result: Staff[] = [];
  for (const staff of staffs) {
    result.push(resample_staff(staff));
  }
  return result;
}

export function filter_edge_of_vision(
  staffs: Staff[],
  image_shape: number[]
): Staff[] {
  const staffWidths = staffs.map((s) => s.maxX - s.minX);
  const usualWidth = npMean(staffWidths);

  const result: Staff[] = [];
  for (const staff of staffs) {
    const beyondBottom = staff.maxY >= image_shape[0];
    const beyondTop = staff.minY < 0;
    if (beyondBottom || beyondTop) {
      continue;
    }

    const staffWidth = staff.maxX - staff.minX;
    const shorterThanUsual = staffWidth < usualWidth / 2;
    const beyondLeft = staff.minX < 0.01 * image_shape[1];
    const beyondRight = staff.maxX > 0.99 * image_shape[1];

    if ((beyondLeft || beyondRight) && shorterThanUsual) {
      continue;
    }

    result.push(staff);
  }
  return result;
}

export function sort_staffs_top_to_bottom(staffs: Staff[]): Staff[] {
  return [...staffs].sort((a, b) => a.minY - b.minY);
}

export function filter_unusual_anchors(anchors: StaffAnchor[]): StaffAnchor[] {
  if (anchors.length === 0) {
    return anchors;
  }
  const unitSizes = anchors.map((anchor) => anchor.average_unit_size);
  const averageUnitSize = npMean(unitSizes);
  const unitSizeDeviation = npStd(unitSizes);
  const result: StaffAnchor[] = [];
  for (const anchor of anchors) {
    if (
      Math.abs(anchor.average_unit_size - averageUnitSize) >
      3 * unitSizeDeviation
    ) {
      continue;
    }
    result.push(anchor);
  }
  return result;
}

export function init_zone(
  clef_anchors: StaffAnchor[],
  image_shape: number[]
): [number, number][] {
  const makeRange = (start: number, stop: number): [number, number] => [
    Math.max(Math.floor(start), 0),
    Math.min(Math.floor(stop), image_shape[1]),
  ];

  const marginRight = 10;
  let ranges = clef_anchors.map((c) =>
    makeRange(c.symbol.bottom_left[0], c.symbol.top_right[0] + marginRight)
  );
  ranges = ranges.sort((a, b) => a[0] - b[0]);
  const result: [number, number][] = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (i === 0) {
      result.push(r);
    } else {
      const overlapsWithTheLast = r[0] < result[result.length - 1][1];
      if (overlapsWithTheLast) {
        result[result.length - 1] = [
          result[result.length - 1][0],
          r[1],
        ];
      } else {
        result.push(r);
      }
    }
  }
  return result;
}

export function filter_line_peaks(
  peaks: number[],
  norm: number[],
  max_gap_ratio: number = 1.5
): [boolean[], number[]] {
  const validPeaks = new Array(peaks.length).fill(true);

  for (let idx = 0; idx < peaks.length; idx++) {
    const p = peaks[idx];
    const maxPeakHeight = 15;
    if (norm[p] > maxPeakHeight) {
      validPeaks[idx] = false;
    }
  }

  const gaps: number[] = [];
  for (let i = 1; i < peaks.length; i++) {
    gaps.push(peaks[i] - peaks[i - 1]);
  }
  const count = Math.max(5, Math.round(peaks.length * 0.2));
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const approxUnit =
    sortedGaps.slice(0, count).length === 0
      ? 0
      : npMean(sortedGaps.slice(0, count));
  const maxGap = approxUnit * max_gap_ratio;

  const extPeaks: number[] = [peaks[0] - maxGap - 1, ...peaks];
  const groups: number[] = [];
  let group = -1;
  for (let i = 1; i < extPeaks.length; i++) {
    if (extPeaks[i] - extPeaks[i - 1] > maxGap) {
      group += 1;
    }
    groups.push(group);
  }

  groups.push(groups[groups.length - 1] + 1);
  let curG = groups[0];
  let count2 = 1;
  for (let idx = 1; idx < groups.length; idx++) {
    const g = groups[idx];
    if (g === curG) {
      count2 += 1;
      continue;
    }

    if (count2 < constants.number_of_lines_on_a_staff) {
      for (let k = idx - count2; k < idx; k++) validPeaks[k] = false;
    } else if (count2 > constants.number_of_lines_on_a_staff) {
      const candPeaks = peaks.slice(idx - count2, idx);
      const headPart = candPeaks.slice(0, constants.number_of_lines_on_a_staff);
      const tailPart = candPeaks.slice(
        candPeaks.length - constants.number_of_lines_on_a_staff
      );
      let headSum = 0;
      for (const p of headPart) headSum += norm[p];
      let tailSum = 0;
      for (const p of tailPart) tailSum += norm[p];
      if (headSum > tailSum) {
        for (
          let k = idx - count2 + constants.number_of_lines_on_a_staff;
          k < idx;
          k++
        )
          validPeaks[k] = false;
      } else {
        for (
          let k = idx - count2;
          k < idx - constants.number_of_lines_on_a_staff;
          k++
        )
          validPeaks[k] = false;
      }
    }

    curG = g;
    count2 = 1;
  }
  return [validPeaks, groups.slice(0, groups.length - 1)];
}

export function find_horizontal_lines(
  image: NDArray,
  unit_size: number,
  line_threshold: number = 0.0
): number[][] {
  const height = image.rows;
  const width = image.cols;
  const countArr = new Array(height).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (image.ucharAt(y, x) > 0) {
        countArr[y] += 1;
      }
    }
  }

  const countPadded = [0, ...countArr, 0];
  const mean = npMean(countPadded);
  const std = npStd(countPadded);
  const norm = countPadded.map((c) => (std === 0 ? 0 : (c - mean) / std));
  let [centers, _props] = find_peaks(
    norm,
    line_threshold,
    unit_size,
    1
  );
  centers = centers.map((c) => c - 1);
  const normSliced = norm.slice(1, norm.length - 1);
  const [_validCenters, groups] = filter_line_peaks(centers, normSliced);
  const groupedCenters: Map<number, number[]> = new Map();
  for (let i = 0; i < centers.length; i++) {
    const center = centers[i];
    const groupNumber = groups[i];
    if (!groupedCenters.has(groupNumber)) {
      groupedCenters.set(groupNumber, []);
    }
    groupedCenters.get(groupNumber)!.push(center);
  }
  const completeGroups: number[][] = [];
  for (const groupedCenter of groupedCenters.values()) {
    if (groupedCenter.length === constants.number_of_lines_on_a_staff) {
      completeGroups.push([...groupedCenter].sort((a, b) => a - b));
    }
  }
  return completeGroups;
}

export function predict_other_anchors_from_clefs(
  clef_anchors: StaffAnchor[],
  image: NDArray
): RotatedBoundingBox[] {
  if (clef_anchors.length === 0) {
    return [];
  }
  const averageUnitSize = npMean(
    clef_anchors.map((anchor) => anchor.average_unit_size)
  );
  const anchorSymbols = clef_anchors.map((anchor) => anchor.symbol);
  const clefZones = init_zone(clef_anchors, [image.rows, image.cols]);
  const result: RotatedBoundingBox[] = [];
  for (const zone of clefZones) {
    const rect = new cv.Rect(zone[0], 0, zone[1] - zone[0], image.rows);
    const verticalSlice = image.roi(rect);
    const linesGroups = find_horizontal_lines(verticalSlice, averageUnitSize);
    verticalSlice.delete();
    for (const group of linesGroups) {
      const minY = Math.min(...group);
      const maxY = Math.max(...group);
      const centerY = (minY + maxY) / 2;
      const centerX = zone[0] + (zone[1] - zone[0]) / 2;
      const box = {
        center: [Math.floor(centerX), Math.floor(centerY)] as [number, number],
        size: [zone[1] - zone[0], Math.floor(maxY - minY)] as [number, number],
        angle: 0,
      };
      result.push(new RotatedBoundingBox(box, [], 0));
    }
  }
  return result.filter((r) => !r.is_overlapping_with_any(anchorSymbols));
}

export function break_wide_fragments(
  fragments: RotatedBoundingBox[],
  limit: number = 100
): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = [];
  for (const fragment of fragments) {
    let remainingFragment = fragment;
    while (remainingFragment.size[0] > limit) {
      const minX = Math.min(
        ...remainingFragment.contours.map((c) => c[0])
      );
      const contoursLeft = remainingFragment.contours.filter(
        (c) => c[0] < minX + limit
      );
      const contoursRight = remainingFragment.contours.filter(
        (c) => c[0] >= minX + limit
      );
      const sortedLeft = [...contoursLeft].sort((a, b) => a[0] - b[0]);
      const sortedRight = [...contoursRight].sort((a, b) => a[0] - b[0]);
      if (sortedLeft.length === 0 || sortedRight.length === 0) {
        break;
      }
      sortedLeft.push(sortedRight[0]);
      sortedRight.push(sortedLeft[sortedLeft.length - 1]);
      result.push(
        create_rotated_bounding_box(sortedLeft, remainingFragment.debug_id)
      );
      remainingFragment = create_rotated_bounding_box(
        sortedRight,
        remainingFragment.debug_id
      );
    }
    result.push(remainingFragment);
  }
  return result;
}

export function detect_staff(
  debug: Debug,
  image: NDArray,
  staff_fragments: RotatedBoundingBox[],
  clefs_keys: RotatedBoundingBox[],
  likely_bar_or_rests_lines: RotatedBoundingBox[]
): Staff[] {
  let staffAnchors = find_staff_anchors(staff_fragments, clefs_keys, true);
  eprint("Found " + staffAnchors.length + " clefs");

  const possibleOtherClefs = predict_other_anchors_from_clefs(staffAnchors, image);
  eprint("Found " + possibleOtherClefs.length + " possible other clefs");
  staffAnchors = staffAnchors.concat(
    find_staff_anchors(staff_fragments, possibleOtherClefs, true)
  );

  staffAnchors = staffAnchors.concat(
    find_staff_anchors(staff_fragments, likely_bar_or_rests_lines, false)
  );

  staffAnchors = filter_unusual_anchors(staffAnchors);
  eprint("Found " + staffAnchors.length + " staff anchors");
  debug.write_bounding_boxes_alternating_colors("staff_anchors", staffAnchors);

  const rawStaffsWithPossibleDuplicates =
    find_raw_staffs_by_connecting_line_fragments(staffAnchors, staff_fragments);
  eprint(
    "Found " + rawStaffsWithPossibleDuplicates.length + " staffs"
  );
  const rawStaffs = remove_duplicate_staffs(rawStaffsWithPossibleDuplicates);
  if (rawStaffsWithPossibleDuplicates.length !== rawStaffs.length) {
    eprint(
      "Removed " +
        (rawStaffsWithPossibleDuplicates.length - rawStaffs.length) +
        " duplicate staffs"
    );
  }
  debug.write_bounding_boxes_alternating_colors(
    "raw_staffs",
    (rawStaffs as RotatedBoundingBox[]).concat(likely_bar_or_rests_lines).concat(clefs_keys)
  );

  let staffs = resample_staffs(rawStaffs);

  staffs = filter_edge_of_vision(staffs, [image.rows, image.cols]);

  staffs = sort_staffs_top_to_bottom(staffs);

  return staffs;
}
