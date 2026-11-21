import { MultiStaff, Staff } from "./model";

function get_center_min_max_y(staff: Staff): [number, number] {
  return [staff.minY, staff.maxY];
}

export class StaffRegions {
  centers: [number, number][];

  constructor(staffs: MultiStaff[]) {
    const centers: [number, number][] = [];
    for (const ms of staffs) {
      for (const s of ms.staffs) {
        centers.push(get_center_min_max_y(s));
      }
    }
    this.centers = centers;
  }

  get_start_of_closest_staff_above(y: number): number {
    const staffsAbove = this.centers.filter((c) => c[0] < y).map((c) => c[1]);
    if (staffsAbove.length === 0) {
      return 0;
    }
    return Math.max(...staffsAbove);
  }

  get_start_of_closest_staff_below(y: number): number {
    const staffsBelow = this.centers.filter((c) => c[1] > y).map((c) => c[0]);
    if (staffsBelow.length === 0) {
      return 1e12;
    }
    return Math.min(...staffsBelow);
  }
}
