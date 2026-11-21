declare const cv: any;

type NDArray = any;

export function autocrop(img: NDArray): NDArray {
  const gray = new cv.Mat();
  cv.cvtColor(img, gray, cv.COLOR_BGR2GRAY);

  const srcVec = new cv.MatVector();
  srcVec.push_back(img);
  const hist = new cv.Mat();
  const mask = new cv.Mat();
  const channels = [0];
  const histSize = [256];
  const ranges = [0, 256];
  cv.calcHist(srcVec, channels, mask, hist, histSize, ranges, false);
  srcVec.delete();
  mask.delete();

  const histData = hist.data32F;
  let dominant_color_gray_scale = 0;
  let maxVal = -Infinity;
  for (let i = 0; i < histData.length; i++) {
    if (histData[i] > maxVal) {
      maxVal = histData[i];
      dominant_color_gray_scale = i;
    }
  }
  hist.delete();

  const thresh = new cv.Mat();
  cv.threshold(
    gray,
    thresh,
    dominant_color_gray_scale - 30,
    255,
    cv.THRESH_BINARY
  );
  gray.delete();

  const kernel1 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
  const morph = new cv.Mat();
  cv.morphologyEx(thresh, morph, cv.MORPH_CLOSE, kernel1);
  thresh.delete();
  kernel1.delete();

  const kernel2 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9));
  const morph2 = new cv.Mat();
  cv.morphologyEx(morph, morph2, cv.MORPH_ERODE, kernel2);
  morph.delete();
  kernel2.delete();

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(
    morph2,
    contours,
    hierarchy,
    cv.RETR_EXTERNAL,
    cv.CHAIN_APPROX_SIMPLE
  );
  morph2.delete();
  hierarchy.delete();

  let area_thresh = 0.0;
  let big_contour: any = null;
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area > area_thresh) {
      area_thresh = area;
      big_contour = c;
    } else {
      c.delete();
    }
  }

  if (big_contour === null) {
    contours.delete();
    return img;
  }

  const rect = cv.boundingRect(big_contour);
  const x = rect.x;
  const y = rect.y;
  const w = rect.width;
  const h = rect.height;
  big_contour.delete();
  contours.delete();

  const page_width = img.cols;
  const page_height = img.rows;
  const is_full_page_view =
    x < page_width * 0.25 || y < page_height * 0.25;
  if (is_full_page_view) {
    return img;
  }

  const roi = img.roi(new cv.Rect(x, y, w, h));
  return roi;
}
