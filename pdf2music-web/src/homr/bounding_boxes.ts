import * as constants from "./constants";
import { crop_image } from "./image_utils";

declare const cv: any;

type NDArray = any;
type Contour = number[][];
type RotatedRect = {
  center: [number, number];
  size: [number, number];
  angle: number;
};

function rectFromCV(r: any): RotatedRect {
  return {
    center: [r.center.x, r.center.y],
    size: [r.size.width, r.size.height],
    angle: r.angle,
  };
}

function rectToCV(rect: RotatedRect): any {
  return {
    center: { x: rect.center[0], y: rect.center[1] },
    size: { width: rect.size[0], height: rect.size[1] },
    angle: rect.angle,
  };
}

function contourToMat(contour: Contour): any {
  const flat: number[] = [];
  for (const p of contour) {
    flat.push(p[0], p[1]);
  }
  return cv.matFromArray(contour.length, 1, cv.CV_32SC2, flat);
}

function matToContour(mat: any): Contour {
  const contour: Contour = [];
  const data = mat.data32S;
  for (let i = 0; i < data.length; i += 2) {
    contour.push([data[i], data[i + 1]]);
  }
  return contour;
}

function boxPointsToPolygon(rect: RotatedRect): Contour {
  // opencv.js returns a plain array of points here rather than a Mat.
  const points = cv.boxPoints(rectToCV(rect)) as { x: number; y: number }[];
  return points.map((p) => [Math.round(p.x), Math.round(p.y)]);
}

function ellipse2Poly(
  center: [number, number],
  axes: [number, number],
  angle: number
): Contour {
  const points: Contour = [];
  const cosA = Math.cos((angle * Math.PI) / 180);
  const sinA = Math.sin((angle * Math.PI) / 180);
  for (let deg = 0; deg < 360; deg++) {
    const rad = (deg * Math.PI) / 180;
    const x0 = axes[0] * Math.cos(rad);
    const y0 = axes[1] * Math.sin(rad);
    points.push([
      Math.round(center[0] + x0 * cosA - y0 * sinA),
      Math.round(center[1] + x0 * sinA + y0 * cosA),
    ]);
  }
  return points;
}

function calculate_edges_of_rotated_rectangle(
  box: RotatedRect
): [[number, number], [number, number], [number, number], [number, number]] {
  const halfW = box.size[0] / 2;
  const halfH = box.size[1] / 2;
  const cx = box.center[0];
  const cy = box.center[1];
  const topLeft: [number, number] = [cx - halfW, cy - halfH];
  const bottomLeft: [number, number] = [cx - halfW, cy + halfH];
  const topRight: [number, number] = [cx + halfW, cy - halfH];
  const bottomRight: [number, number] = [cx + halfW, cy + halfH];
  return [topLeft, bottomLeft, topRight, bottomRight];
}

function do_polygons_overlap(poly1: Contour, poly2: Contour): boolean {
  const mat2 = contourToMat(poly2);
  let overlap = false;
  for (const point of poly1) {
    if (cv.pointPolygonTest(mat2, new cv.Point(point[0], point[1]), false) >= 0) {
      overlap = true;
      break;
    }
  }
  if (!overlap) {
    const mat1 = contourToMat(poly1);
    for (const point of poly2) {
      if (cv.pointPolygonTest(mat1, new cv.Point(point[0], point[1]), false) >= 0) {
        overlap = true;
        break;
      }
    }
    mat1.delete();
  }
  mat2.delete();
  return overlap;
}

export abstract class DebugDrawable {
  draw_onto_image(
    img: NDArray,
    color: [number, number, number]
  ): void {}
}

export class AnyPolygon extends DebugDrawable {
  polygon: Contour;

  constructor(polygon: Contour) {
    super();
    this.polygon = polygon;
  }

  draw_onto_image(
    img: NDArray,
    color: [number, number, number] = [0, 0, 255]
  ): void {}
}

export class BoundingBox extends AnyPolygon {
  debug_id: number;
  contours: Contour;
  box: [number, number, number, number];
  center: [number, number];
  size: [number, number];
  rotated_box: RotatedRect;

  constructor(
    box: [number, number, number, number],
    contours: Contour,
    debug_id: number = 0
  ) {
    const center: [number, number] = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    const size: [number, number] = [box[2] - box[0], box[3] - box[1]];
    const rotated_box: RotatedRect = { center, size, angle: 0 };
    super(boxPointsToPolygon(rotated_box));
    this.debug_id = debug_id;
    this.contours = contours;
    this.box = box;
    this.center = center;
    this.size = size;
    this.rotated_box = rotated_box;
  }

  draw_onto_image(
    img: NDArray,
    color: [number, number, number] = [0, 0, 255]
  ): void {}

  extract(img: NDArray): NDArray {
    return crop_image(img, this.box[0], this.box[1], this.box[2] + 1, this.box[3] + 1);
  }

  blank_everything_outside_of_box(img: NDArray): NDArray {
    const [x1, y1, x2, y2] = this.box;
    const white = new cv.Mat(
      img.rows,
      img.cols,
      img.type(),
      new cv.Scalar(255, 255, 255, 255)
    );
    const rect = new cv.Rect(x1, y1, x2 - x1, y2 - y1);
    const sub = img.roi(rect);
    const dst = white.roi(rect);
    sub.copyTo(dst);
    sub.delete();
    dst.delete();
    return white;
  }

  increase_size_in_each_dimension(
    increase: number,
    image_size: [number, number]
  ): BoundingBox {
    return new BoundingBox(
      [
        Math.max(this.box[0] - increase, 0),
        Math.max(this.box[1] - increase, 0),
        Math.min(this.box[2] + increase, image_size[1]),
        Math.min(this.box[3] + increase, image_size[0]),
      ],
      this.contours,
      this.debug_id
    );
  }
}

export abstract class AngledBoundingBox extends AnyPolygon {
  debug_id: number;
  contours: Contour;
  box: RotatedRect;
  center: [number, number];
  size: [number, number];
  angle: number;
  top_left: [number, number];
  bottom_left: [number, number];
  top_right: [number, number];
  bottom_right: [number, number];

  constructor(
    inputBox: RotatedRect,
    contours: Contour,
    polygon: Contour,
    debug_id: number = 0
  ) {
    super(polygon);
    this.debug_id = debug_id;
    this.contours = contours;
    const angle0 = inputBox.angle;
    let box: RotatedRect;
    if (angle0 > 135) {
      box = {
        center: [inputBox.center[0], inputBox.center[1]],
        size: [inputBox.size[0], inputBox.size[1]],
        angle: angle0 - 180,
      };
    } else if (angle0 < -135) {
      box = {
        center: [inputBox.center[0], inputBox.center[1]],
        size: [inputBox.size[0], inputBox.size[1]],
        angle: angle0 + 180,
      };
    } else if (angle0 > 45) {
      box = {
        center: [inputBox.center[0], inputBox.center[1]],
        size: [inputBox.size[1], inputBox.size[0]],
        angle: angle0 - 90,
      };
    } else if (angle0 < -45) {
      box = {
        center: [inputBox.center[0], inputBox.center[1]],
        size: [inputBox.size[1], inputBox.size[0]],
        angle: angle0 + 90,
      };
    } else {
      box = {
        center: [inputBox.center[0], inputBox.center[1]],
        size: [inputBox.size[0], inputBox.size[1]],
        angle: angle0,
      };
    }
    this.box = box;
    this.center = box.center;
    this.size = box.size;
    this.angle = box.angle;
    const [tl, bl, tr, br] = calculate_edges_of_rotated_rectangle(box);
    this.top_left = tl;
    this.bottom_left = bl;
    this.top_right = tr;
    this.bottom_right = br;
    this.polygon = polygon;
  }

  is_overlapping(other: AnyPolygon): boolean {
    if (!this._can_shapes_possibly_touch(other)) {
      return false;
    }
    return do_polygons_overlap(this.polygon, other.polygon);
  }

  is_overlapping_with_any(others: AngledBoundingBox[]): boolean {
    for (const other of others) {
      if (this.is_overlapping(other)) {
        return true;
      }
    }
    return false;
  }

  _can_shapes_possibly_touch(other: AnyPolygon): boolean {
    const center1 = this.box.center;
    const axes1 = this.box.size;
    let center2: [number, number];
    let axes2: [number, number];
    if (other instanceof BoundingBox) {
      center2 = other.rotated_box.center;
      axes2 = other.rotated_box.size;
    } else if (other instanceof AngledBoundingBox) {
      center2 = other.box.center;
      axes2 = other.box.size;
    } else {
      throw new Error(`Unknown type ${typeof other}`);
    }
    const major_axis1 = Math.max(axes1[0], axes1[1]);
    const major_axis2 = Math.max(axes2[0], axes2[1]);
    const distance = Math.sqrt(
      (center1[0] - center2[0]) ** 2 + (center1[1] - center2[1]) ** 2
    );
    if (distance > major_axis1 + major_axis2) {
      return false;
    }
    return true;
  }

  draw_onto_image(
    img: NDArray,
    color: [number, number, number] = [0, 0, 255]
  ): void {}
}

export class RotatedBoundingBox extends AngledBoundingBox {
  constructor(box: RotatedRect, contours: Contour, debug_id: number = 0) {
    super(box, contours, boxPointsToPolygon(box), debug_id);
  }

  draw_onto_image(
    img: NDArray,
    color: [number, number, number] = [0, 0, 255]
  ): void {}

  is_intersecting(other: RotatedBoundingBox): boolean {
    if (!this._can_shapes_possibly_touch(other)) {
      return false;
    }
    const intersectingRegion = new cv.Mat();
    const retval = cv.rotatedRectangleIntersection(
      rectToCV(this.box),
      rectToCV(other.box),
      intersectingRegion
    );
    intersectingRegion.delete();
    return retval !== cv.INTERSECT_NONE;
  }

  ensure_min_dimension(min_width: number, min_height: number): RotatedBoundingBox {
    return new RotatedBoundingBox(
      {
        center: [this.box.center[0], this.box.center[1]],
        size: [
          Math.max(this.box.size[0], min_width),
          Math.max(this.box.size[1], min_height),
        ],
        angle: this.box.angle,
      },
      this.contours,
      this.debug_id
    );
  }

  make_box_thicker(thickness: number): RotatedBoundingBox {
    if (thickness <= 0) {
      return this;
    }
    return new RotatedBoundingBox(
      {
        center: [this.box.center[0], this.box.center[1]],
        size: [this.box.size[0] + thickness, this.box.size[1] + thickness],
        angle: this.box.angle,
      },
      this.contours,
      this.debug_id
    );
  }

  move_to_x_horizontal_by(x_delta: number): RotatedBoundingBox {
    const new_x = this.center[0] + x_delta;
    return new RotatedBoundingBox(
      {
        center: [new_x, this.center[1]],
        size: this.box.size,
        angle: this.box.angle,
      },
      this.contours,
      this.debug_id
    );
  }

  make_box_taller(thickness: number): RotatedBoundingBox {
    return new RotatedBoundingBox(
      {
        center: [this.box.center[0], this.box.center[1]],
        size: [this.box.size[0], this.box.size[1] + thickness],
        angle: this.box.angle,
      },
      this.contours,
      this.debug_id
    );
  }

  make_box_taller_keep_center(thickness: number): RotatedBoundingBox {
    return new RotatedBoundingBox(
      {
        center: [this.box.center[0], this.box.center[1] - Math.floor(thickness / 2)],
        size: [this.box.size[0], this.box.size[1] + thickness],
        angle: this.box.angle,
      },
      this.contours,
      this.debug_id
    );
  }

  get_center_extrapolated(x: number): number {
    return (
      (x - this.box.center[0]) * Math.tan((this.box.angle / 180) * Math.PI) +
      this.box.center[1]
    );
  }

  is_overlapping_extrapolated(
    other: RotatedBoundingBox,
    unit_size: number
  ): boolean {
    let left: RotatedBoundingBox;
    let right: RotatedBoundingBox;
    if (this.box.center[0] > other.box.center[0]) {
      left = other;
      right = this;
    } else {
      left = this;
      right = other;
    }
    const center_x = (left.center[0] + right.center[0]) * 0.5;
    const tolerance = constants.tolerance_for_staff_line_detection(unit_size);
    const max_gap = constants.max_line_gap_size(unit_size);
    if (
      center_x - left.center[0] - Math.floor(left.size[0] / 2) > max_gap ||
      right.center[0] - center_x - Math.floor(right.size[0] / 2) > max_gap
    ) {
      return false;
    }
    const left_angle = Math.tan((left.box.angle * Math.PI) / 180.0);
    const right_angle = Math.tan((right.box.angle * Math.PI) / 180.0);
    const left_y = (center_x - left.box.center[0]) * left_angle + left.box.center[1];
    const right_y = (center_x - right.box.center[0]) * right_angle + right.box.center[1];
    return Math.abs(left_y - right_y) <= tolerance;
  }

  to_bounding_box(): BoundingBox {
    return new BoundingBox(
      [
        Math.floor(this.top_left[0]),
        Math.floor(this.top_left[1]),
        Math.floor(this.bottom_right[0]),
        Math.floor(this.bottom_right[1]),
      ],
      this.contours,
      this.debug_id
    );
  }
}

export class BoundingEllipse extends AngledBoundingBox {
  constructor(box: RotatedRect, contours: Contour, debug_id: number = 0) {
    const polygon = ellipse2Poly(
      [Math.trunc(box.center[0]), Math.trunc(box.center[1])],
      [Math.trunc(box.size[0] / 2), Math.trunc(box.size[1] / 2)],
      Math.trunc(box.angle)
    );
    super(box, contours, polygon, debug_id);
  }

  draw_onto_image(
    img: NDArray,
    color: [number, number, number] = [0, 0, 255]
  ): void {}

  make_box_thicker(thickness: number): BoundingEllipse {
    return new BoundingEllipse(
      {
        center: [this.box.center[0], this.box.center[1]],
        size: [this.box.size[0] + thickness, this.box.size[1] + thickness],
        angle: this.box.angle,
      },
      this.contours,
      this.debug_id
    );
  }

  make_box_taller(thickness: number): RotatedBoundingBox {
    return new RotatedBoundingBox(
      {
        center: [this.box.center[0], this.box.center[1]],
        size: [this.box.size[0], this.box.size[1] + thickness],
        angle: this.box.angle,
      },
      this.contours,
      this.debug_id
    );
  }
}

function _has_box_valid_size(box: RotatedRect): boolean {
  return (
    !Number.isNaN(box.size[0]) &&
    !Number.isNaN(box.size[1]) &&
    box.size[0] > 0 &&
    box.size[1] > 0
  );
}

export function create_rotated_bounding_boxes(
  img: any,
  skip_merging: boolean = false,
  min_size: [number, number] | null = null,
  max_size: [number, number] | null = null,
  thicken_boxes: number | null = null
): RotatedBoundingBox[] {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(img, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
  const boxes: RotatedBoundingBox[] = [];
  for (let i = 0; i < contours.size(); i++) {
    const contourMat = contours.get(i);
    const fitBox = rectFromCV(cv.minAreaRect(contourMat));
    if (!_has_box_valid_size(fitBox)) {
      contourMat.delete();
      continue;
    }
    const contour = matToContour(contourMat);
    const box = new RotatedBoundingBox(fitBox, contour, i);
    if (min_size !== null && (box.size[0] < min_size[0] || box.size[1] < min_size[1])) {
      contourMat.delete();
      continue;
    }
    if (max_size !== null) {
      if (max_size[0] > 0 && box.size[0] > max_size[0]) {
        contourMat.delete();
        continue;
      }
      if (max_size[1] > 0 && box.size[1] > max_size[1]) {
        contourMat.delete();
        continue;
      }
    }
    boxes.push(box);
    contourMat.delete();
  }
  contours.delete();
  hierarchy.delete();
  if (skip_merging) {
    return boxes;
  }
  let result = boxes;
  if (thicken_boxes !== null) {
    result = result.map((b) => b.make_box_thicker(thicken_boxes));
  }
  return _get_box_for_whole_group(merge_overlaying_bounding_boxes(result));
}

export function create_rotated_bounding_box(
  contour: Contour,
  debug_id: number
): RotatedBoundingBox {
  const mat = contourToMat(contour);
  const box = rectFromCV(cv.minAreaRect(mat));
  mat.delete();
  return new RotatedBoundingBox(box, contour, debug_id);
}

export function create_lines(
  img: any,
  threshold: number = 100,
  min_line_length: number = 100,
  max_line_gap: number = 10,
  skip_merging: boolean = false
): RotatedBoundingBox[] {
  const lines = cv.HoughLinesP(
    img,
    1,
    Math.PI / 180,
    threshold,
    min_line_length,
    max_line_gap
  );
  const boxes: RotatedBoundingBox[] = [];
  if (lines && lines.rows > 0) {
    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.data32F[i * 4];
      const y1 = lines.data32F[i * 4 + 1];
      const x2 = lines.data32F[i * 4 + 2];
      const y2 = lines.data32F[i * 4 + 3];
      const contour: Contour = [
        [x1, y1],
        [x2, y2],
      ];
      const mat = contourToMat(contour);
      const box = rectFromCV(cv.minAreaRect(mat));
      mat.delete();
      if (box.size[0] > box.size[1]) {
        boxes.push(new RotatedBoundingBox(box, contour, i));
      }
    }
  }
  if (lines) lines.delete();
  if (skip_merging) {
    return boxes;
  }
  return _get_box_for_whole_group(merge_overlaying_bounding_boxes(boxes));
}

export function create_bounding_ellipses(
  img: any,
  skip_merging: boolean = false,
  min_size: [number, number] | null = null,
  max_size: [number, number] | null = null
): BoundingEllipse[] {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(img, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
  const boxes: BoundingEllipse[] = [];
  for (let i = 0; i < contours.size(); i++) {
    const contourMat = contours.get(i);
    const min_length_to_fit_ellipse = 5;
    if (contourMat.rows < min_length_to_fit_ellipse) {
      contourMat.delete();
      continue;
    }
    const fitBox = rectFromCV(cv.fitEllipse(contourMat));
    if (!_has_box_valid_size(fitBox)) {
      contourMat.delete();
      continue;
    }
    const contour = matToContour(contourMat);
    const box = new BoundingEllipse(fitBox, contour, i);
    if (min_size !== null && (box.size[0] < min_size[0] || box.size[1] < min_size[1])) {
      contourMat.delete();
      continue;
    }
    if (max_size !== null && (box.size[0] > max_size[0] || box.size[1] > max_size[1])) {
      contourMat.delete();
      continue;
    }
    boxes.push(box);
    contourMat.delete();
  }
  contours.delete();
  hierarchy.delete();
  if (skip_merging) {
    return boxes;
  }
  return _get_ellipse_for_whole_group(merge_overlaying_bounding_boxes(boxes));
}

function _do_groups_overlap(
  group1: AngledBoundingBox[],
  group2: AngledBoundingBox[]
): boolean {
  for (const box1 of group1) {
    for (const box2 of group2) {
      if (box1.is_overlapping(box2)) {
        return true;
      }
    }
  }
  return false;
}

function _merge_groups_recursive(
  groups: AngledBoundingBox[][],
  step: number
): AngledBoundingBox[][] {
  const step_limit = 10;
  if (step > step_limit) {
    console.warn("Too many steps in _merge_groups_recursive, giving back current results");
    return groups;
  }
  let number_of_changes = 0;
  const merged: AngledBoundingBox[][] = [];
  const used_groups = new Set<number>();
  for (let i = 0; i < groups.length; i++) {
    let match_found = false;
    if (used_groups.has(i)) {
      continue;
    }
    const group = groups[i];
    for (let j = i + 1; j < groups.length; j++) {
      if (used_groups.has(j)) {
        continue;
      }
      const other_group = groups[j];
      if (_do_groups_overlap(group, other_group)) {
        merged.push(group.concat(other_group));
        number_of_changes += 1;
        used_groups.add(j);
        match_found = true;
        break;
      }
    }
    if (!match_found) {
      merged.push(group);
    }
  }
  if (number_of_changes === 0) {
    return merged;
  } else {
    return _merge_groups_recursive(merged, step + 1);
  }
}

function _get_ellipse_for_whole_group(
  groups: AngledBoundingBox[][]
): BoundingEllipse[] {
  const result: BoundingEllipse[] = [];
  for (const group of groups) {
    const complete: Contour = [];
    for (const box of group) {
      for (const p of box.contours) {
        complete.push(p);
      }
    }
    const mat = contourToMat(complete);
    const box = new BoundingEllipse(rectFromCV(cv.minAreaRect(mat)), complete);
    result.push(box);
    mat.delete();
  }
  return result;
}

function _get_box_for_whole_group(
  groups: AngledBoundingBox[][]
): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = [];
  for (const group of groups) {
    const complete: Contour = [];
    for (const box of group) {
      for (const p of box.contours) {
        complete.push(p);
      }
    }
    const mat = contourToMat(complete);
    const box = new RotatedBoundingBox(rectFromCV(cv.minAreaRect(mat)), complete);
    result.push(box);
    mat.delete();
  }
  return result;
}

export class UnionFind {
  parent: number[];
  rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array(n).fill(0);
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }

  union(x: number, y: number): void {
    const rootX = this.find(x);
    const rootY = this.find(y);
    if (rootX !== rootY) {
      if (this.rank[rootX] > this.rank[rootY]) {
        this.parent[rootY] = rootX;
      } else if (this.rank[rootX] < this.rank[rootY]) {
        this.parent[rootX] = rootY;
      } else {
        this.parent[rootY] = rootX;
        this.rank[rootX] += 1;
      }
    }
  }
}

function _merge_groups_optimized(
  groups: AngledBoundingBox[][]
): AngledBoundingBox[][] {
  const n = groups.length;
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (_do_groups_overlap(groups[i], groups[j])) {
        uf.union(i, j);
      }
    }
  }
  const merged_groups: Map<number, AngledBoundingBox[]> = new Map();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!merged_groups.has(root)) {
      merged_groups.set(root, []);
    }
    merged_groups.get(root)!.push(...groups[i]);
  }
  return Array.from(merged_groups.values());
}

export function merge_overlaying_bounding_boxes(
  boxes: AngledBoundingBox[]
): AngledBoundingBox[][] {
  const initial_groups: AngledBoundingBox[][] = [];
  for (const box of boxes) {
    initial_groups.push([box]);
  }
  return _merge_groups_optimized(initial_groups);
}
