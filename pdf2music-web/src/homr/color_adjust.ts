declare const cv: any;

type NDArray = any;

export function apply_clahe(image: NDArray): NDArray {
  const gray = new cv.Mat();
  cv.cvtColor(image, gray, cv.COLOR_BGR2GRAY);
  // opencv.js exposes CLAHE as a class rather than through createCLAHE().
  const clahe = new cv.CLAHE(1.0, new cv.Size(8, 8));
  const dst = new cv.Mat();
  clahe.apply(gray, dst);
  clahe.delete();
  gray.delete();
  return dst;
}
