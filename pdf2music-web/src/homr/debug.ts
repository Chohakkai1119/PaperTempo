type NDArray = any;

export class Debug {
  debug = false;

  constructor(..._args: any[]) {}

  write_image(..._args: any[]): void {}

  write_threshold_image(..._args: any[]): void {}

  write_bounding_boxes(..._args: any[]): void {}

  write_bounding_boxes_alternating_colors(..._args: any[]): void {}

  write_all_bounding_boxes_alternating_colors(..._args: any[]): void {}

  write_teaser(..._args: any[]): void {}

  write_image_with_fixed_suffix(..._args: any[]): void {}

  clean_debug_files_from_previous_runs(): void {}
}
