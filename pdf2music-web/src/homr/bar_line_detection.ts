import { bar_line_min_height, bar_line_max_width } from "./constants";
import type { RotatedBoundingBox } from "./bounding_boxes";

declare const cv: any;

export function prepareBarLineImage(image: any): any {
  const kernel = cv.Mat.ones(5, 3, cv.CV_8U);
  const result = new cv.Mat();
  cv.dilate(image, result, kernel, new cv.Point(-1, -1), 1);
  kernel.delete();
  return result;
}

export function detectBarLines(
  barLines: RotatedBoundingBox[],
  unitSize: number
): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = [];
  for (const barLine of barLines) {
    if (barLine.size[1] < bar_line_min_height(unitSize)) continue;
    if (barLine.size[0] > bar_line_max_width(unitSize)) continue;
    result.push(barLine);
  }
  return result;
}
