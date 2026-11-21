import * as constants from "./constants";
import {
  BoundingEllipse,
  DebugDrawable,
  RotatedBoundingBox,
} from "./bounding_boxes";
import { Note, Staff, StemDirection } from "./model";

declare const cv: any;

type NDArray = any;
type Rect = [number, number, number, number];

function eprint(...args: any[]): void {
  console.warn(...args);
}

export class NoteheadWithStem extends DebugDrawable {
  notehead: BoundingEllipse;
  stem: RotatedBoundingBox | null;
  stem_direction: StemDirection | null;

  constructor(
    notehead: BoundingEllipse,
    stem: RotatedBoundingBox | null,
    stem_direction: StemDirection | null = null
  ) {
    super();
    this.notehead = notehead;
    this.stem = stem;
    this.stem_direction = stem_direction;
  }

  draw_onto_image(
    img: NDArray,
    color: [number, number, number] = [255, 0, 0]
  ): void {
    this.notehead.draw_onto_image(img, color);
    if (this.stem !== null) {
      this.stem.draw_onto_image(img, color);
    }
  }
}

function _rows_where_nonzero(region: NDArray): number[] {
  const ys: number[] = [];
  for (let r = 0; r < region.rows; r++) {
    let rowHasNonZero = false;
    for (let c = 0; c < region.cols; c++) {
      if (region.ucharPtr(r, c)[0] > 0) {
        rowHasNonZero = true;
        break;
      }
    }
    if (rowHasNonZero) {
      ys.push(r);
    }
  }
  return ys;
}

export function adjust_bbox(bbox: Rect, noteheads: NDArray): Rect {
  const x1 = Math.max(0, bbox[0]);
  const y1 = Math.max(0, bbox[1]);
  const x2 = Math.min(noteheads.cols, bbox[2]);
  const y2 = Math.min(noteheads.rows, bbox[3]);
  if (x2 <= x1 || y2 <= y1) {
    return bbox;
  }
  const region = noteheads.roi(new cv.Rect(x1, y1, x2 - x1, y2 - y1));
  const ys = _rows_where_nonzero(region);
  region.delete();
  if (ys.length === 0) {
    return bbox;
  }
  const top = Math.min(...ys) + bbox[1] - 1;
  const bottom = Math.max(...ys) + bbox[1] + 1;
  return [bbox[0], Math.floor(top), bbox[2], Math.floor(bottom)];
}

export function get_center(bbox: Rect): [number, number] {
  const cen_y = Math.round((bbox[1] + bbox[3]) / 2);
  const cen_x = Math.round((bbox[0] + bbox[2]) / 2);
  return [cen_x, cen_y];
}

export function check_bbox_size(
  bbox: Rect,
  noteheads: NDArray,
  unit_size: number
): Rect[] {
  const w = bbox[2] - bbox[0];
  const h = bbox[3] - bbox[1];
  const [cen_x, _] = get_center(bbox);
  const note_w = constants.NOTEHEAD_SIZE_RATIO * unit_size;
  const note_h = unit_size;

  let new_bbox: Rect[] = [];
  if (Math.abs(w - note_w) > Math.abs(w - note_w * 2)) {
    const left_box: Rect = [bbox[0], bbox[1], cen_x, bbox[3]];
    const right_box: Rect = [cen_x, bbox[1], bbox[2], bbox[3]];

    const adjusted_left = adjust_bbox(left_box, noteheads);
    const adjusted_right = adjust_bbox(right_box, noteheads);

    new_bbox.push(...check_bbox_size(adjusted_left, noteheads, unit_size));
    new_bbox.push(...check_bbox_size(adjusted_right, noteheads, unit_size));
  }

  if (new_bbox.length > 0) {
    const tmp_new: Rect[] = [];
    for (const box of new_bbox) {
      tmp_new.push(...check_bbox_size(box, noteheads, unit_size));
    }
    new_bbox = tmp_new;
  } else {
    const num_notes = Math.round(h / note_h);
    if (num_notes > 0) {
      const sub_h = Math.floor(h / num_notes);
      for (let i = 0; i < num_notes; i++) {
        const sub_box: Rect = [
          bbox[0],
          Math.round(bbox[1] + i * sub_h),
          bbox[2],
          Math.round(bbox[1] + (i + 1) * sub_h),
        ];
        new_bbox.push(sub_box);
      }
    }
  }

  return new_bbox;
}

export function split_clumps_of_noteheads(
  notehead: NoteheadWithStem,
  noteheads: NDArray,
  staff: Staff
): NoteheadWithStem[] {
  const bbox: Rect = [
    Math.floor(notehead.notehead.top_left[0]),
    Math.floor(notehead.notehead.top_left[1]),
    Math.floor(notehead.notehead.bottom_right[0]),
    Math.floor(notehead.notehead.bottom_right[1]),
  ];
  const split_boxes = check_bbox_size(bbox, noteheads, staff.averageUnitSize);
  if (split_boxes.length <= 1) {
    return [notehead];
  }
  const result: NoteheadWithStem[] = [];
  const contours = notehead.notehead.contours;
  const debug_id = notehead.notehead.debug_id;
  const stem = notehead.stem;
  const stem_direction = notehead.stem_direction;
  for (const box of split_boxes) {
    const center = get_center(box);
    const size: [number, number] = [box[2] - box[0], box[3] - box[1]];
    const newNotehead = new NoteheadWithStem(
      new BoundingEllipse(
        { center, size, angle: 0 },
        contours,
        debug_id
      ),
      stem,
      stem_direction
    );
    result.push(newNotehead);
  }
  return result;
}

export function combine_noteheads_with_stems(
  noteheads: BoundingEllipse[],
  stems: RotatedBoundingBox[]
): NoteheadWithStem[] {
  const result: NoteheadWithStem[] = [];
  const sorted = [...noteheads].sort(
    (a, b) => a.box.center[1] - b.box.center[1]
  );
  const used_stems: Set<RotatedBoundingBox> = new Set();
  for (const notehead of sorted) {
    const thickened_notehead = notehead.make_box_thicker(15);
    let found_stem = false;
    for (const stem of stems) {
      if (stem.is_overlapping(thickened_notehead)) {
        const is_stem_above = stem.center[1] < notehead.center[1];
        const direction = is_stem_above ? StemDirection.UP : StemDirection.DOWN;
        result.push(new NoteheadWithStem(notehead, stem, direction));
        used_stems.add(stem);
        found_stem = true;
        break;
      }
    }
    if (!found_stem) {
      result.push(new NoteheadWithStem(notehead, null, null));
    }
  }
  return result;
}

export function add_notes_to_staffs(
  staffs: Staff[],
  noteheads: NoteheadWithStem[],
  symbols: NDArray,
  notehead_pred: NDArray
): Note[] {
  const result: Note[] = [];
  for (const staff of staffs) {
    for (const notehead_chunk of noteheads) {
      if (!staff.isOnStaffZone(notehead_chunk.notehead)) {
        continue;
      }
      const center = notehead_chunk.notehead.center;
      let point = staff.getAt(center[0]);
      if (point === null) {
        continue;
      }
      if (
        notehead_chunk.notehead.size[0] < 0.5 * point.averageUnitSize ||
        notehead_chunk.notehead.size[1] < 0.5 * point.averageUnitSize
      ) {
        continue;
      }
      for (const notehead of split_clumps_of_noteheads(
        notehead_chunk,
        notehead_pred,
        staff
      )) {
        point = staff.getAt(center[0]);
        if (point === null) {
          continue;
        }
        if (
          notehead.notehead.size[0] < 0.5 * point.averageUnitSize ||
          notehead.notehead.size[0] > 3 * point.averageUnitSize ||
          notehead.notehead.size[1] < 0.5 * point.averageUnitSize ||
          notehead.notehead.size[1] > 2 * point.averageUnitSize
        ) {
          continue;
        }
        const position = point.findPositionInUnitSizes(notehead.notehead);
        const note = new Note(
          notehead.notehead,
          position,
          notehead.stem,
          notehead.stem_direction
        );
        result.push(note);
        staff.addSymbol(note);
      }
    }
  }
  let number_of_notes = 0;
  for (const staff of staffs) {
    number_of_notes += staff.getNotes().length;
  }
  eprint("Found", number_of_notes, "notes during segmentation");
  return result;
}
