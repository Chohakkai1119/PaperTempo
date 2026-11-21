import * as constants from "./constants";
import { Debug } from "./debug";
import { InputPredictions } from "./model";

declare const cv: any;

type NDArray = any;

function eprint(...args: any[]): void {
  console.warn(...args);
}

export function estimate_noise(gray: NDArray): number {
  const H = gray.rows;
  const W = gray.cols;
  const M = cv.matFromArray(3, 3, cv.CV_64F, [
    1, -2, 1, -2, 4, -2, 1, -2, 1,
  ]);
  const filtered = new cv.Mat();
  cv.filter2D(gray, filtered, cv.CV_64F, M);
  let sigma = 0;
  const data = filtered.data64F;
  for (let i = 0; i < data.length; i++) {
    sigma += Math.abs(data[i]);
  }
  sigma = sigma / (H * W);
  M.delete();
  filtered.delete();
  return sigma;
}

export function create_noise_grid(
  gray: NDArray,
  debug: Debug
): NDArray | null {
  const imgheight = gray.rows;
  const imgwidth = gray.cols;
  const M = Math.floor(imgheight / 20);
  const N = Math.floor(imgwidth / 20);

  const debug_image = new cv.Mat();
  cv.cvtColor(gray, debug_image, cv.COLOR_GRAY2BGR);
  const mask = new cv.Mat(
    gray.rows,
    gray.cols,
    cv.CV_8U,
    new cv.Scalar(0)
  );

  const grid = create_grid(gray, M, N);
  const [filtered_cells, total_cells] = apply_noise_filter(
    grid,
    mask,
    debug_image,
    M,
    N
  );

  if (debug.debug) {
    debug.write_image("noise_crop", debug_image);
  }

  debug_image.delete();
  return handle_filter_results(filtered_cells, total_cells, mask);
}

export function create_grid(gray: NDArray, M: number, N: number): NDArray {
  const imgheight = gray.rows;
  const imgwidth = gray.cols;
  const rows = Math.ceil(imgheight / M);
  const cols = Math.ceil(imgwidth / N);
  const grid = new cv.Mat(rows, cols, cv.CV_8U, new cv.Scalar(0));

  let i = 0;
  for (let y1 = 0; y1 < imgheight; y1 += M, i++) {
    let j = 0;
    for (let x1 = 0; x1 < imgwidth; x1 += N, j++) {
      const y2 = y1 + M;
      const x2 = x1 + N;
      const tile = gray.roi(
        new cv.Rect(
          x1,
          y1,
          Math.min(N, imgwidth - x1),
          Math.min(M, imgheight - y1)
        )
      );
      const noise = estimate_noise(tile);
      grid.ucharPtr(i, j)[0] = noise;
      tile.delete();
    }
  }

  return grid;
}

export function apply_noise_filter(
  grid: NDArray,
  mask: NDArray,
  debug_image: NDArray,
  M: number,
  N: number
): [number, number] {
  const imgheight = mask.rows;
  const imgwidth = mask.cols;
  let filtered_cells = 0;
  let total_cells = 0;

  let i = 0;
  for (let y1 = 0; y1 < imgheight; y1 += M, i++) {
    let j = 0;
    for (let x1 = 0; x1 < imgwidth; x1 += N, j++) {
      const y2 = y1 + M;
      const x2 = x1 + N;
      const noise = grid.ucharPtr(i, j)[0];
      const neighbors = get_neighbors(grid, i, j);
      const any_neighbor_above_limit = neighbors.some(
        (n) => n > constants.image_noise_limit
      );

      if (noise > constants.image_noise_limit && any_neighbor_above_limit) {
        cv.rectangle(
          debug_image,
          new cv.Point(x1, y1),
          new cv.Point(x2, y2),
          new cv.Scalar(0, 255, 255, 255)
        );
        filtered_cells += 1;
      } else {
        const maskRoi = mask.roi(
          new cv.Rect(
            x1,
            y1,
            Math.min(N, imgwidth - x1),
            Math.min(M, imgheight - y1)
          )
        );
        maskRoi.setTo(new cv.Scalar(255));
        maskRoi.delete();
        cv.rectangle(
          debug_image,
          new cv.Point(x1, y1),
          new cv.Point(x2, y2),
          new cv.Scalar(0, 255, 0, 255)
        );
      }

      cv.putText(
        debug_image,
        `${noise.toFixed(2)}`,
        new cv.Point(x1 + Math.floor(N / 2), y1 + Math.floor(M / 2)),
        cv.FONT_HERSHEY_PLAIN,
        1,
        new cv.Scalar(0, 0, 255, 255)
      );
      total_cells += 1;
    }
  }

  return [filtered_cells, total_cells];
}

export function get_neighbors(
  grid: NDArray,
  i: number,
  j: number
): number[] {
  const neighbors: number[] = [];
  if (i > 0) {
    neighbors.push(grid.ucharPtr(i - 1, j)[0]);
  }
  if (j > 0) {
    neighbors.push(grid.ucharPtr(i, j - 1)[0]);
  }
  if (i < grid.rows - 1) {
    neighbors.push(grid.ucharPtr(i + 1, j)[0]);
  }
  if (j < grid.cols - 1) {
    neighbors.push(grid.ucharPtr(i, j + 1)[0]);
  }
  return neighbors;
}

export function handle_filter_results(
  filtered_cells: number,
  total_cells: number,
  mask: NDArray
): NDArray | null {
  const half = 0.5;
  if (filtered_cells / total_cells > half) {
    eprint(
      `Would filter more than 50% of the image with ${filtered_cells} of ${total_cells} ` +
        "cells, skipping noise filtering"
    );
    return null;
  } else if (filtered_cells > 0) {
    eprint(`Filtered ${filtered_cells} of ${total_cells} cells`);
    return mask;
  }
  return null;
}

export function filter_predictions(
  prediction: InputPredictions,
  debug: Debug
): InputPredictions {
  const scaled = new cv.Mat();
  prediction.staff.convertTo(scaled, cv.CV_8U, 255, 0);
  const mask = create_noise_grid(scaled, debug);
  if (mask === null) {
    scaled.delete();
    return prediction;
  }

  const original = new cv.Mat();
  cv.bitwise_and(prediction.original, prediction.original, original, mask);
  const preprocessed = new cv.Mat();
  cv.bitwise_and(
    prediction.preprocessed,
    prediction.preprocessed,
    preprocessed,
    mask
  );
  const notehead = new cv.Mat();
  cv.bitwise_and(prediction.notehead, prediction.notehead, notehead, mask);
  const symbols = new cv.Mat();
  cv.bitwise_and(prediction.symbols, prediction.symbols, symbols, mask);
  const staff = new cv.Mat();
  cv.bitwise_and(prediction.staff, prediction.staff, staff, mask);
  const clefs_keys = new cv.Mat();
  cv.bitwise_and(prediction.clefs_keys, prediction.clefs_keys, clefs_keys, mask);
  const stems_rest = new cv.Mat();
  cv.bitwise_and(
    prediction.stems_rest,
    prediction.stems_rest,
    stems_rest,
    mask
  );

  scaled.delete();
  mask.delete();

  return new InputPredictions(
    original,
    preprocessed,
    notehead,
    symbols,
    staff,
    clefs_keys,
    stems_rest
  );
}
