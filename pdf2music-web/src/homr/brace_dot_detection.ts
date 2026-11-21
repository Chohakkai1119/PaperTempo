import * as constants from "./constants";
import { RotatedBoundingBox } from "./bounding_boxes";
import { Debug } from "./debug";
import { MultiStaff, Staff, BarLine, Clef } from "./model";

declare const cv: any;

type NDArray = any;

export function prepare_brace_dot_image(
  symbols: NDArray,
  staff: NDArray
): NDArray {
  const symbolsU8 = new cv.Mat();
  symbols.convertTo(symbolsU8, cv.CV_8U);
  const brace_dot = new cv.Mat();
  cv.subtract(symbolsU8, staff, brace_dot);
  symbolsU8.delete();

  const kernel1 = cv.getStructuringElement(
    cv.MORPH_ELLIPSE,
    new cv.Size(1, 5)
  );
  const out = new cv.Mat();
  cv.erode(brace_dot, out, kernel1);
  brace_dot.delete();
  kernel1.delete();

  const kernel2 = cv.getStructuringElement(
    cv.MORPH_ELLIPSE,
    new cv.Size(5, 35)
  );
  const dst = new cv.Mat();
  cv.dilate(out, dst, kernel2);
  out.delete();
  kernel2.delete();
  return dst;
}

function _filter_for_tall_elements(
  brace_dot: RotatedBoundingBox[],
  staffs: Staff[]
): RotatedBoundingBox[] {
  const rough_unit_size = staffs[0].averageUnitSize;
  const symbols_larger_than_rough_estimate = brace_dot.filter(
    (symbol) =>
      symbol.size[1] >
        constants.min_height_for_brace_rough(rough_unit_size) &&
      symbol.size[0] < constants.max_width_for_brace_rough(rough_unit_size)
  );
  const result: RotatedBoundingBox[] = [];
  for (const symbol of symbols_larger_than_rough_estimate) {
    let closest_staff = staffs[0];
    let best_dist = closest_staff.yDistanceTo(symbol.center);
    for (let i = 1; i < staffs.length; i++) {
      const d = staffs[i].yDistanceTo(symbol.center);
      if (d < best_dist) {
        best_dist = d;
        closest_staff = staffs[i];
      }
    }
    const unit_size = closest_staff.averageUnitSize;
    if (symbol.size[1] > constants.min_height_for_brace(unit_size)) {
      result.push(symbol);
    }
  }
  return result;
}

function _get_connections_between_staffs_at_bar_lines(
  staff1: Staff,
  staff2: Staff,
  brace_dot: RotatedBoundingBox[]
): RotatedBoundingBox[] {
  const bar_lines1 = staff1.getBarLines();
  const bar_lines2 = staff2.getBarLines();
  const result: RotatedBoundingBox[] = [];
  for (const symbol of brace_dot) {
    const symbol_thicker = symbol.make_box_thicker(30);
    const first_overlapping_staff1 = bar_lines1.filter((line: BarLine) =>
      symbol_thicker.is_overlapping(line.box)
    );
    const first_overlapping_staff2 = bar_lines2.filter((line: BarLine) =>
      symbol_thicker.is_overlapping(line.box)
    );
    if (
      first_overlapping_staff1.length >= 1 &&
      first_overlapping_staff2.length >= 1
    ) {
      result.push(symbol);
    }
  }
  return result;
}

function _get_connections_between_staffs_at_clefs(
  staff1: Staff,
  staff2: Staff,
  brace_dot: RotatedBoundingBox[]
): RotatedBoundingBox[] {
  const clefs1 = staff1.getClefs();
  const clefs2 = staff2.getClefs();
  const result: RotatedBoundingBox[] = [];
  for (const symbol of brace_dot) {
    const symbol_thicker = symbol.make_box_thicker(
      constants.tolerance_for_staff_at_any_point(staff1.averageUnitSize)
    );
    const first_overlapping_staff1 = clefs1.filter((clef: Clef) =>
      symbol_thicker.is_overlapping(clef.box)
    );
    const first_overlapping_staff2 = clefs2.filter((clef: Clef) =>
      symbol_thicker.is_overlapping(clef.box)
    );
    if (
      first_overlapping_staff1.length >= 1 &&
      first_overlapping_staff2.length >= 1
    ) {
      result.push(symbol);
    }
  }
  return result;
}

function _get_connections_between_staffs_at_lines(
  staff1: Staff,
  staff2: Staff,
  brace_dot: RotatedBoundingBox[]
): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = [];
  for (const symbol of brace_dot) {
    const symbol_thicker = symbol.make_box_thicker(
      constants.tolerance_for_touching_clefs(staff1.averageUnitSize)
    );
    const point1 = staff1.getAt(symbol.center[0]);
    const point2 = staff2.getAt(symbol.center[0]);
    if (point1 === null || point2 === null) {
      continue;
    }
    if (
      symbol_thicker.is_overlapping(point1.toBoundingBox()) &&
      symbol_thicker.is_overlapping(point2.toBoundingBox())
    ) {
      result.push(symbol);
    }
  }
  return result;
}

function _get_connections_between_staffs(
  staff1: Staff,
  staff2: Staff,
  brace_dot: RotatedBoundingBox[]
): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = [];
  result.push(
    ..._get_connections_between_staffs_at_bar_lines(staff1, staff2, brace_dot)
  );
  result.push(
    ..._get_connections_between_staffs_at_clefs(staff1, staff2, brace_dot)
  );
  result.push(
    ..._get_connections_between_staffs_at_lines(staff1, staff2, brace_dot)
  );
  return result;
}

function _merge_multi_staff_if_they_share_a_staff(
  staffs: MultiStaff[]
): MultiStaff[] {
  const result: MultiStaff[] = [];
  for (const staff of staffs) {
    let any_merged = false;
    for (let idx = 0; idx < result.length; idx++) {
      const existing = result[idx];
      const staffSet = new Set<Staff>(staff.staffs);
      const intersect = existing.staffs.some((s) => staffSet.has(s));
      if (intersect) {
        result.splice(idx, 1);
        result.push(existing.merge(staff));
        any_merged = true;
        break;
      }
    }
    if (!any_merged) {
      result.push(staff);
    }
  }
  return result;
}

function _create_grandstaffs(
  staffs: MultiStaff[],
  brace_dot: RotatedBoundingBox[]
): MultiStaff[] {
  if (staffs.length === 0) {
    return staffs;
  }
  return staffs.map((s) => s.createGrandstaffs(brace_dot));
}

export function find_braces_brackets_and_grand_staff_lines(
  debug: Debug,
  staffs: Staff[],
  brace_dot: RotatedBoundingBox[]
): MultiStaff[] {
  brace_dot = _filter_for_tall_elements(brace_dot, staffs);
  const result: MultiStaff[] = [];
  for (let i = 0; i < staffs.length; i++) {
    const staff = staffs[i];
    const neighbors: Staff[] = [];
    if (i > 0) {
      neighbors.push(staffs[i - 1]);
    }
    if (i < staffs.length - 1) {
      neighbors.push(staffs[i + 1]);
    }
    let any_connected_neighbor = false;
    for (const neighbor of neighbors) {
      const connections = _get_connections_between_staffs(
        staff,
        neighbor,
        brace_dot
      );
      if (
        connections.length >= constants.minimum_connections_to_form_combined_staff
      ) {
        result.push(new MultiStaff([staff, neighbor], connections));
        any_connected_neighbor = true;
      }
    }
    if (!any_connected_neighbor) {
      result.push(new MultiStaff([staff], []));
    }
  }

  return _create_grandstaffs(
    _merge_multi_staff_if_they_share_a_staff(result),
    brace_dot
  );
}
