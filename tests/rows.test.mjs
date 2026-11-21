// Scrolling 4-row window (dist/rows.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { VISIBLE_ROWS, clampWindowTop, windowRows, windowTopForRow } from '../dist/rows.mjs';

test('the window shows 4 rows', () => {
  assert.equal(VISIBLE_ROWS, 4);
});

test('Morning Lines (6 rows): scrolls when the player reaches row 3, then once more, then stops', () => {
  const rows = 6;
  // Rows are 0-based here: row 0 = bars 1–3, row 2 = bars 7–9, row 3 = bars 10–12.
  const tops = [0, 1, 2, 3, 4, 5].map((row) => windowTopForRow(row, rows));
  assert.deepEqual(tops, [0, 0, 1, 2, 2, 2]);
  assert.deepEqual(windowRows(tops[0], rows), { first: 0, last: 3 }); // start: rows 1–4
  assert.deepEqual(windowRows(tops[2], rows), { first: 1, last: 4 }); // bar 7: rows 2–5
  assert.deepEqual(windowRows(tops[3], rows), { first: 2, last: 5 }); // bar 10: rows 3–6 (end)
});

test('while scrolling, the current row is second from the top', () => {
  const rows = 20;
  for (let row = 1; row <= rows - 3; row++) assert.equal(row - windowTopForRow(row, rows), 1);
});

test('short scores never scroll', () => {
  for (const rows of [1, 2, 3, 4]) {
    for (let row = 0; row < rows; row++) assert.equal(windowTopForRow(row, rows), 0);
    assert.deepEqual(windowRows(0, rows), { first: 0, last: rows - 1 });
  }
});

test('manual scrolling is clamped to the score', () => {
  assert.equal(clampWindowTop(-3, 10), 0);
  assert.equal(clampWindowTop(99, 10), 6);
  assert.equal(clampWindowTop(Infinity, 10), 6);
  assert.equal(clampWindowTop(Infinity, 3), 0);
});
