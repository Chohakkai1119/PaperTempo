type NDArray = any;

declare const cv: any;

function _limit_x(image: NDArray, x: number): number {
  return Math.max(0, Math.min(Math.floor(image.cols - 1), Math.round(x)));
}

function _limit_y(image: NDArray, y: number): number {
  return Math.max(0, Math.min(Math.floor(image.rows - 1), Math.round(y)));
}

export function crop_image(
  image: NDArray,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): NDArray {
  const [cropped] = crop_image_and_return_new_top(image, x1, y1, x2, y2);
  return cropped;
}

export function crop_image_and_return_new_top(
  image: NDArray,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): [NDArray, number[]] {
  const x_min = Math.min(x1, x2);
  const x_max = Math.max(x1, x2);
  const y_min = Math.min(y1, y2);
  const y_max = Math.max(y1, y2);
  const x1_limited = _limit_x(image, x_min);
  const y1_limited = _limit_y(image, y_min);
  const x2_limited = _limit_x(image, x_max);
  const y2_limited = _limit_y(image, y_max);
  const new_top_x = [x1_limited, y1_limited];
  const rect = new cv.Rect(
    x1_limited,
    y1_limited,
    x2_limited - x1_limited,
    y2_limited - y1_limited
  );
  return [image.roi(rect), new_top_x];
}
