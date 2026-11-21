export function find_peaks(
  x: number[],
  height: number | null = null,
  distance: number | null = null,
  prominence: number | null = null
): [number[], Record<string, any>] {
  if (x.length < 3) {
    return [[], {}];
  }

  const peaksList: number[] = [];
  let i = 1;
  while (i < x.length - 1) {
    if (x[i] > x[i - 1]) {
      let j = i;
      while (j < x.length - 1 && x[j] === x[j + 1]) {
        j += 1;
      }
      if (j < x.length - 1 && x[j] > x[j + 1]) {
        const peakIdx = Math.floor((i + j) / 2);
        peaksList.push(peakIdx);
        i = j + 1;
      } else {
        i = j + 1;
      }
    } else if (x[i] === x[i - 1]) {
      let j = i;
      while (j < x.length - 1 && x[j] === x[j + 1]) {
        j += 1;
      }
      if (j < x.length - 1 && x[j] > x[j + 1]) {
        const peakIdx = Math.floor((i + j) / 2);
        peaksList.push(peakIdx);
      }
      i = j + 1;
    } else {
      i += 1;
    }
  }

  let peaks = peaksList;

  if (peaks.length === 0) {
    return [[], {}];
  }

  if (height !== null) {
    peaks = peaks.filter((p) => x[p] >= height);
  }

  if (peaks.length === 0) {
    return [[], {}];
  }

  if (prominence !== null) {
    const valid: number[] = [];
    for (const peak of peaks) {
      let leftMin = x[peak];
      for (let k = peak - 1; k >= 0; k--) {
        if (x[k] > x[peak]) break;
        leftMin = Math.min(leftMin, x[k]);
      }
      let rightMin = x[peak];
      for (let k = peak + 1; k < x.length; k++) {
        if (x[k] > x[peak]) break;
        rightMin = Math.min(rightMin, x[k]);
      }
      const peakProminence = x[peak] - Math.max(leftMin, rightMin);
      if (peakProminence >= prominence) {
        valid.push(peak);
      }
    }
    peaks = valid;
  }

  if (peaks.length === 0) {
    return [[], {}];
  }

  if (distance !== null && peaks.length > 1) {
    const sortedByHeight = [...peaks].sort((a, b) => x[b] - x[a]);
    const keep: number[] = [];
    for (const peak of sortedByHeight) {
      if (keep.length === 0 || keep.every((k) => Math.abs(k - peak) >= distance)) {
        keep.push(peak);
      }
    }
    peaks = keep.sort((a, b) => a - b);
  }

  return [peaks, {}];
}
