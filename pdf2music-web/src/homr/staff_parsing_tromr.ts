import { Config } from "./configs";
import { Staff } from "./model";
import { Staff2Score } from "./staff2score";
import { EncodedSymbol } from "./encoded_symbol";

type NDArray = any;

export async function parse_staff_tromr(
  staff: Staff,
  staff_image: NDArray,
  config: Config,
  staff2score: Staff2Score
): Promise<EncodedSymbol[]> {
  return await predict_best(staff_image, staff, config, staff2score);
}

async function predict_best(
  org_image: NDArray,
  staff: Staff,
  _config: Config,
  staff2score: Staff2Score
): Promise<EncodedSymbol[]> {
  const height = org_image.rows;
  const width = org_image.cols;
  const data = org_image.data as Uint8Array;
  const result = await staff2score.predict(data, height, width);
  if (staff.isGrandstaff) {
    return result;
  }
  return result.filter((r) => r.position !== "lower");
}
