import Delaunator from "delaunator";
import { Debug } from "./debug";
import { Staff } from "./model";

declare const cv: any;

type NDArray = any;
type Pt = [number, number];

function eprint(...args: any[]): void {
  console.warn(...args);
}

function npMean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function argmin(values: number[]): number {
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < best) {
      best = values[i];
      idx = i;
    }
  }
  return idx;
}

function pointsToMat(points: Pt[]): any {
  const flat: number[] = [];
  for (const p of points) {
    flat.push(p[0], p[1]);
  }
  return cv.matFromArray(points.length, 1, cv.CV_32SC2, flat);
}

function pointsToMat32F(points: Pt[]): any {
  const flat: number[] = [];
  for (const p of points) {
    flat.push(p[0], p[1]);
  }
  return cv.matFromArray(points.length, 1, cv.CV_32FC2, flat);
}

export class DelaunayTriangulation {
  points: Pt[];
  simplices: number[][] | null;

  constructor(points: Pt[]) {
    this.points = points.map((p) => [p[0], p[1]]);
    this.simplices = null;
    this._triangulate();
  }

  _triangulate(): void {
    if (this.points.length < 3) {
      throw new Error("Need at least 3 points for triangulation");
    }

    // opencv.js does not expose Subdiv2D, so the triangulation is done in JS.
    // Delaunator returns indices into the input points, which is exactly the
    // simplex representation scipy.spatial.Delaunay gives the Python version.
    const coords = new Float64Array(this.points.length * 2);
    for (let i = 0; i < this.points.length; i++) {
      coords[i * 2] = this.points[i][0];
      coords[i * 2 + 1] = this.points[i][1];
    }

    const { triangles } = new Delaunator(coords);
    const simplices: number[][] = [];
    for (let i = 0; i < triangles.length; i += 3) {
      simplices.push([triangles[i], triangles[i + 1], triangles[i + 2]]);
    }
    this.simplices = simplices;
  }

  _find_point_index(point: Pt, tolerance: number = 1e-3): number | null {
    let minIdx = 0;
    let minDist = Infinity;
    for (let i = 0; i < this.points.length; i++) {
      const dx = this.points[i][0] - point[0];
      const dy = this.points[i][1] - point[1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < minDist) {
        minDist = d;
        minIdx = i;
      }
    }
    if (minDist < tolerance) {
      return minIdx;
    }
    return null;
  }

  find_simplex(points: Pt[]): number[] {
    if (this.simplices === null) {
      return new Array(points.length).fill(-1);
    }

    const result = new Array(points.length).fill(-1);
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      for (let j = 0; j < this.simplices.length; j++) {
        const simplex = this.simplices[j];
        const triangle: Pt[] = [
          this.points[simplex[0]],
          this.points[simplex[1]],
          this.points[simplex[2]],
        ];
        if (this._point_in_triangle(point, triangle)) {
          result[i] = j;
          break;
        }
      }
    }
    return result;
  }

  _point_in_triangle(point: Pt, triangle: Pt[]): boolean {
    const x = point[0];
    const y = point[1];
    const x0 = triangle[0][0];
    const y0 = triangle[0][1];
    const x1 = triangle[1][0];
    const y1 = triangle[1][1];
    const x2 = triangle[2][0];
    const y2 = triangle[2][1];

    const denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(denom) < 1e-10) {
      return false;
    }

    const a = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / denom;
    const b = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / denom;
    const c = 1 - a - b;

    return a >= -1e-10 && b >= -1e-10 && c >= -1e-10;
  }
}

function getAffineTransformCV(srcTri: Pt[], dstTri: Pt[]): any {
  const srcMat = cv.matFromArray(3, 1, cv.CV_32FC2, [
    srcTri[0][0], srcTri[0][1],
    srcTri[1][0], srcTri[1][1],
    srcTri[2][0], srcTri[2][1],
  ]);
  const dstMat = cv.matFromArray(3, 1, cv.CV_32FC2, [
    dstTri[0][0], dstTri[0][1],
    dstTri[1][0], dstTri[1][1],
    dstTri[2][0], dstTri[2][1],
  ]);
  const mat = cv.getAffineTransform(srcMat, dstMat);
  srcMat.delete();
  dstMat.delete();
  return mat;
}

export class PiecewiseAffineTransform {
  src_points: Pt[] | null = null;
  dst_points: Pt[] | null = null;
  triangulation: DelaunayTriangulation | null = null;
  affine_matrices: (any | null)[] = [];

  estimate(src: Pt[], dst: Pt[]): void {
    this.src_points = src.map((p) => [p[0], p[1]]);
    this.dst_points = dst.map((p) => [p[0], p[1]]);

    this.triangulation = new DelaunayTriangulation(this.src_points);

    this.affine_matrices = [];
    if (this.triangulation.simplices !== null) {
      for (const simplex of this.triangulation.simplices) {
        const srcTri = simplex.map((idx) => this.src_points![idx]);
        const dstTri = simplex.map((idx) => this.dst_points![idx]);

        if (
          PiecewiseAffineTransform._is_degenerate_triangle(srcTri) ||
          PiecewiseAffineTransform._is_degenerate_triangle(dstTri)
        ) {
          this.affine_matrices.push(null);
          continue;
        }

        try {
          const mat = getAffineTransformCV(srcTri, dstTri);
          this.affine_matrices.push(mat);
        } catch (e) {
          this.affine_matrices.push(null);
        }
      }
    }
  }

  transform_point(point: Pt): Pt {
    if (this.triangulation === null) {
      return point;
    }

    const simplexIdx = this.triangulation.find_simplex([point])[0];

    if (simplexIdx === -1 || simplexIdx >= this.affine_matrices.length) {
      return point;
    }

    const mat = this.affine_matrices[simplexIdx];
    if (mat === null) {
      return point;
    }

    const data = mat.data64F;
    const x = data[0] * point[0] + data[1] * point[1] + data[2];
    const y = data[3] * point[0] + data[4] * point[1] + data[5];
    return [x, y];
  }

  warp_image(image: NDArray, fill_color: number = 1, order: number = 1): NDArray {
    if (
      this.triangulation === null ||
      this.triangulation.simplices === null ||
      this.src_points === null ||
      this.dst_points === null
    ) {
      return image;
    }

    const srcPoints = this.src_points;
    const dstPoints = this.dst_points;

    const height = image.rows;
    const width = image.cols;
    const channels = image.channels();
    const output = new cv.Mat(
      height,
      width,
      image.type(),
      new cv.Scalar(fill_color, fill_color, fill_color, fill_color)
    );

    const interpolation = order === 0 ? cv.INTER_NEAREST : cv.INTER_LINEAR;

    for (let s = 0; s < this.triangulation.simplices.length; s++) {
      if (this.affine_matrices[s] === null) {
        continue;
      }

      const simplex = this.triangulation.simplices[s];
      const srcTri = simplex.map((idx) => srcPoints[idx]);
      const dstTri = simplex.map((idx) => dstPoints[idx]);

      if (
        PiecewiseAffineTransform._is_degenerate_triangle(srcTri) ||
        PiecewiseAffineTransform._is_degenerate_triangle(dstTri)
      ) {
        continue;
      }

      const srcMat = pointsToMat32F(srcTri);
      const dstMat = pointsToMat32F(dstTri);
      const srcRect = cv.boundingRect(srcMat);
      const dstRect = cv.boundingRect(dstMat);
      srcMat.delete();
      dstMat.delete();

      if (srcRect.width <= 0 || srcRect.height <= 0 || dstRect.width <= 0 || dstRect.height <= 0) {
        continue;
      }

      // A triangle can reach past the edge of the image, so the source
      // rectangle has to be clipped before it can be used as an ROI. The
      // triangle coordinates below are taken relative to the clipped rect, so
      // the affine transform stays correct.
      const srcX1 = Math.max(0, srcRect.x);
      const srcY1 = Math.max(0, srcRect.y);
      const srcX2 = Math.min(image.cols, srcRect.x + srcRect.width);
      const srcY2 = Math.min(image.rows, srcRect.y + srcRect.height);
      if (srcX2 <= srcX1 || srcY2 <= srcY1) {
        continue;
      }
      srcRect.x = srcX1;
      srcRect.y = srcY1;
      srcRect.width = srcX2 - srcX1;
      srcRect.height = srcY2 - srcY1;

      const srcTriCropped: Pt[] = srcTri.map((p) => [
        p[0] - srcRect.x,
        p[1] - srcRect.y,
      ]);
      const dstTriCropped: Pt[] = dstTri.map((p) => [
        p[0] - dstRect.x,
        p[1] - dstRect.y,
      ]);

      if (
        PiecewiseAffineTransform._is_degenerate_triangle(srcTriCropped) ||
        PiecewiseAffineTransform._is_degenerate_triangle(dstTriCropped)
      ) {
        continue;
      }

      let warpMat: any;
      try {
        warpMat = getAffineTransformCV(srcTriCropped, dstTriCropped);
      } catch (e) {
        continue;
      }

      const srcRectCV = new cv.Rect(srcRect.x, srcRect.y, srcRect.width, srcRect.height);
      const srcCropped = image.roi(srcRectCV);
      if (srcCropped.rows === 0 || srcCropped.cols === 0) {
        srcCropped.delete();
        warpMat.delete();
        continue;
      }

      const dstCropped = new cv.Mat();
      const borderValue = new cv.Scalar(fill_color, fill_color, fill_color, fill_color);
      cv.warpAffine(
        srcCropped,
        dstCropped,
        warpMat,
        new cv.Size(dstRect.width, dstRect.height),
        { interpolation, borderMode: cv.BORDER_CONSTANT, borderValue }
      );

      const triangleMask = new cv.Mat(
        dstRect.height,
        dstRect.width,
        cv.CV_8UC1,
        new cv.Scalar(0)
      );
      const dstTriCroppedInt = cv.matFromArray(
        3,
        1,
        cv.CV_32SC2,
        [
          dstTriCropped[0][0], dstTriCropped[0][1],
          dstTriCropped[1][0], dstTriCropped[1][1],
          dstTriCropped[2][0], dstTriCropped[2][1],
        ]
      );
      cv.fillConvexPoly(triangleMask, dstTriCroppedInt, new cv.Scalar(255, 255, 255, 255));
      dstTriCroppedInt.delete();

      const y1 = dstRect.y;
      const y2 = dstRect.y + dstRect.height;
      const x1 = dstRect.x;
      const x2 = dstRect.x + dstRect.width;
      const y1Clip = Math.max(0, y1);
      const y2Clip = Math.min(height, y2);
      const x1Clip = Math.max(0, x1);
      const x2Clip = Math.min(width, x2);

      if (y2Clip > y1Clip && x2Clip > x1Clip) {
        const dy1 = y1Clip - y1;
        const dy2 = y2Clip - y1;
        const dx1 = x1Clip - x1;
        const dx2 = x2Clip - x1;

        const dstRectCV = new cv.Rect(x1Clip, y1Clip, x2Clip - x1Clip, y2Clip - y1Clip);
        const outputROI = output.roi(dstRectCV);

        const maskRectCV = new cv.Rect(dx1, dy1, dx2 - dx1, dy2 - dy1);
        const maskROI = triangleMask.roi(maskRectCV);
        const croppedRectCV = new cv.Rect(dx1, dy1, dx2 - dx1, dy2 - dy1);
        const dstCroppedROI = dstCropped.roi(croppedRectCV);

        const masked = new cv.Mat();
        cv.bitwise_and(dstCroppedROI, dstCroppedROI, masked, maskROI);
        const invMask = new cv.Mat();
        cv.bitwise_not(maskROI, invMask);
        const maskedOutput = new cv.Mat();
        cv.bitwise_and(outputROI, outputROI, maskedOutput, invMask);
        cv.add(maskedOutput, masked, outputROI);

        masked.delete();
        invMask.delete();
        maskedOutput.delete();
        maskROI.delete();
        dstCroppedROI.delete();
        outputROI.delete();
      }

      srcCropped.delete();
      dstCropped.delete();
      triangleMask.delete();
      warpMat.delete();
    }

    return output;
  }

  static _is_degenerate_triangle(triangle: Pt[]): boolean {
    const v1: Pt = [
      triangle[1][0] - triangle[0][0],
      triangle[1][1] - triangle[0][1],
    ];
    const v2: Pt = [
      triangle[2][0] - triangle[0][0],
      triangle[2][1] - triangle[0][1],
    ];
    const area = Math.abs(v1[0] * v2[1] - v1[1] * v2[0]) / 2.0;
    return area < 1e-6;
  }

  static _triangle_area(triangle: Pt[]): number {
    const v1: Pt = [
      triangle[1][0] - triangle[0][0],
      triangle[1][1] - triangle[0][1],
    ];
    const v2: Pt = [
      triangle[2][0] - triangle[0][0],
      triangle[2][1] - triangle[0][1],
    ];
    return Math.abs(v1[0] * v2[1] - v1[1] * v2[0]) / 2.0;
  }
}

export class StaffDewarping {
  tform: PiecewiseAffineTransform | null;

  constructor(tform: PiecewiseAffineTransform | null) {
    this.tform = tform;
  }

  dewarp(image: NDArray, fill_color: number = 1, order: number = 1): NDArray {
    if (this.tform === null) {
      return image;
    }
    return this.tform.warp_image(image, fill_color, order);
  }

  dewarp_point(point: Pt): Pt {
    if (this.tform === null) {
      return point;
    }
    return this.tform.transform_point(point);
  }
}

export function is_point_on_image(pts: Pt, image: NDArray): boolean {
  const height = image.rows;
  const width = image.cols;
  const margin = 10;
  if (pts[0] < margin || pts[0] > width - margin || pts[1] < margin || pts[1] > height - margin) {
    return false;
  }
  return true;
}

export function calculate_span_and_optimal_points(
  staff: Staff,
  image: NDArray
): [Pt[][], Pt[][]] {
  const spanPoints: Pt[][] = [];
  const optimalPoints: Pt[][] = [];
  let firstYOffset: number | null = null;
  const numberOfYIntervals = 6;

  const imageHeight = image.rows;
  const imageWidth = image.cols;

  if (Math.floor(imageHeight / numberOfYIntervals) === 0) {
    return [spanPoints, optimalPoints];
  }

  for (
    let y = 2;
    y < imageHeight - 2;
    y += Math.floor(imageHeight / numberOfYIntervals)
  ) {
    const linePoints: Pt[] = [];
    for (let x = 2; x < imageWidth; x += 80) {
      const yValues = staff.getAt(x);
      if (yValues !== null) {
        const yOffset = yValues.y[2];
        if (firstYOffset === null) {
          firstYOffset = yOffset;
        }
        const yDelta = Math.floor(yOffset - firstYOffset);
        const point: Pt = [x, y + yDelta];
        if (is_point_on_image(point, image)) {
          linePoints.push(point);
        }
      }
    }

    const minimumNumberOfPoints = 2;
    if (linePoints.length > minimumNumberOfPoints) {
      let sum = 0;
      for (const p of linePoints) sum += p[1];
      const averageY = sum / linePoints.length;
      spanPoints.push(linePoints);
      optimalPoints.push(linePoints.map((p) => [p[0], Math.floor(averageY)] as Pt));
    }
  }

  return [spanPoints, optimalPoints];
}

export function calculate_dewarp_transformation(
  image: NDArray,
  source: Pt[][],
  destination: Pt[][]
): StaffDewarping {
  const addImageEdgesToLines = (lines: Pt[][]): Pt[][] => {
    const result: Pt[][] = [
      [[0, 0], [image.cols, 0]] as Pt[],
      ...lines,
      [[0, image.rows], [image.cols, image.rows]] as Pt[],
    ];
    return result;
  };

  const addFirstAndLastPointToEveryLine = (lines: Pt[][]): Pt[][] => {
    for (const line of lines) {
      line.unshift([0, line[0][1]]);
      line.push([image.cols, line[line.length - 1][1]]);
    }
    return lines;
  };

  source = addFirstAndLastPointToEveryLine(source);
  destination = addFirstAndLastPointToEveryLine(destination);

  source = addImageEdgesToLines(source);
  destination = addImageEdgesToLines(destination);

  const sourceConc: Pt[] = [];
  for (const line of source) sourceConc.push(...line);
  const destinationConc: Pt[] = [];
  for (const line of destination) destinationConc.push(...line);

  const tform = new PiecewiseAffineTransform();
  tform.estimate(sourceConc, destinationConc);
  return new StaffDewarping(tform);
}

export function dewarp_staff_image(
  image: NDArray,
  staff: Staff,
  index: number,
  debug: Debug
): StaffDewarping {
  try {
    const [spanPoints, optimalPoints] = calculate_span_and_optimal_points(staff, image);

    if (debug.debug) {
      const debugImg = image.clone();
      for (const line of spanPoints) {
        for (const point of line) {
          cv.circle(
            debugImg,
            new cv.Point(Math.floor(point[0]), Math.floor(point[1])),
            5,
            new cv.Scalar(0, 0, 255, 255),
            -1
          );
        }
      }
      for (const line of optimalPoints) {
        for (const point of line) {
          cv.circle(
            debugImg,
            new cv.Point(Math.floor(point[0]), Math.floor(point[1])),
            5,
            new cv.Scalar(255, 0, 0, 255),
            -1
          );
        }
      }
      debug.write_image_with_fixed_suffix(`_staff-${index}_debug_span_points.png`, debugImg);
      debugImg.delete();
    }

    return calculate_dewarp_transformation(image, spanPoints, optimalPoints);
  } catch (e) {
    eprint("Dewarping failed for staff", index, "with error", e);
    return new StaffDewarping(null);
  }
}

export function warp_image_randomly(image: NDArray): NDArray {
  const warpAlgo = Math.floor(Math.random() * 2);
  if (warpAlgo === 0) {
    return warp_image_array_randomly(image);
  } else {
    return warp_image_array_randomly2(image);
  }
}

export function warp_image_array_randomly(image: NDArray): NDArray {
  const center = [Math.floor(image.cols / 2), Math.floor(image.rows / 2)];
  const numPoints = 5;
  const upper: Pt[] = [];
  const source: Pt[] = [];
  const lower: Pt[] = [];
  for (let i = 0; i < numPoints; i++) {
    upper.push([Math.floor((i * image.cols) / numPoints), 0]);
    source.push([Math.floor((i * image.cols) / numPoints), center[1]]);
    lower.push([Math.floor((i * image.cols) / numPoints), image.rows]);
  }
  const maxRandomOffset = 20;
  const destination: Pt[] = [];
  for (let i = 0; i < numPoints; i++) {
    destination.push([
      Math.floor((i * image.cols) / numPoints),
      center[1] + Math.floor(Math.random() * (2 * maxRandomOffset) - maxRandomOffset),
    ]);
  }
  const result = calculate_dewarp_transformation(image, [upper, source, lower], [upper, destination, lower]).dewarp(
    image,
    255,
    3
  );
  const finalResult = new cv.Mat();
  result.convertTo(finalResult, cv.CV_8U);
  return finalResult;
}

export function warp_image_array_randomly2(image: NDArray): NDArray {
  const height = image.rows;
  const width = image.cols;

  const gridW = 5;
  const gridH = 2;

  const alpha = 5 + Math.random() * 20;
  const dyRow: number[] = [];
  for (let i = 0; i < gridW; i++) {
    dyRow.push(Math.random() * 2 - 1);
  }
  dyRow[0] = 0;
  dyRow[dyRow.length - 1] = 0;

  const dySmall = new cv.Mat(gridH, gridW, cv.CV_32FC1);
  for (let r = 0; r < gridH; r++) {
    for (let c = 0; c < gridW; c++) {
      dySmall.floatPtr(r, c)[0] = dyRow[c] * alpha;
    }
  }
  const dxSmall = new cv.Mat(gridH, gridW, cv.CV_32FC1, new cv.Scalar(0));

  const dx = new cv.Mat();
  const dy = new cv.Mat();
  cv.resize(dxSmall, dx, new cv.Size(width, height), 0, 0, cv.INTER_CUBIC);
  cv.resize(dySmall, dy, new cv.Size(width, height), 0, 0, cv.INTER_CUBIC);

  const mapX = new cv.Mat(height, width, cv.CV_32FC1);
  const mapY = new cv.Mat(height, width, cv.CV_32FC1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      mapX.floatPtr(y, x)[0] = x + dx.floatPtr(y, x)[0];
      mapY.floatPtr(y, x)[0] = y + dy.floatPtr(y, x)[0];
    }
  }

  const result = new cv.Mat();
  cv.remap(
    image,
    result,
    mapX,
    mapY,
    cv.INTER_LINEAR,
    cv.BORDER_CONSTANT,
    new cv.Scalar(255, 255, 255, 255)
  );

  const finalResult = new cv.Mat();
  result.convertTo(finalResult, cv.CV_8U);

  dxSmall.delete();
  dySmall.delete();
  dx.delete();
  dy.delete();
  mapX.delete();
  mapY.delete();
  result.delete();
  return finalResult;
}
