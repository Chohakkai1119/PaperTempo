declare const cv: any;

type NDArray = any;

export function calc_target_image_size(
  width: number,
  height: number
): [number, number] {
  const target_width = 1920;

  if (width === target_width) {
    return [width, height];
  }

  const ratio = target_width / width;
  const tar_w = target_width;
  const tar_h = Math.round(height * ratio);

  return [tar_w, tar_h];
}

export function resize_image(imageArr: NDArray): NDArray {
  const width = imageArr.cols;
  const height = imageArr.rows;
  const [tar_w, tar_h] = calc_target_image_size(width, height);
  if (tar_w === width && tar_h === height) {
    return imageArr;
  }
  const dst = new cv.Mat();
  cv.resize(imageArr, dst, new cv.Size(tar_w, tar_h));
  return dst;
}
