// Scrolling row window: show VISIBLE_ROWS rows (systems) of the score at a time.
// Once the player reaches the 3rd visible row, the window moves up one row, so the
// current row sits second from the top with two rows of look-ahead below it.

export const VISIBLE_ROWS = 4;

/** Clamp a window's top row so it never runs past the start or the end of the score. */
export function clampWindowTop(top, rowCount, visible = VISIBLE_ROWS) {
  return Math.max(0, Math.min(top, rowCount - visible));
}

/** Top row of the window for a player whose current position is on `row` (0-based). */
export function windowTopForRow(row, rowCount, visible = VISIBLE_ROWS) {
  return clampWindowTop(row - 1, rowCount, visible);
}

/** 0-based first and last rows shown for a window starting at `top`. */
export function windowRows(top, rowCount, visible = VISIBLE_ROWS) {
  const first = clampWindowTop(top, rowCount, visible);
  return { first, last: Math.min(rowCount, first + visible) - 1 };
}
