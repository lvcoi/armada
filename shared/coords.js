// Cells are a flat index 0..224. Column letters A..O, row numbers 1..15.

import { GRID, CELLS } from './constants.js';

const LETTERS = 'ABCDEFGHIJKLMNO';

export const toIndex = (x, y) => y * GRID + x;
export const toXY = (i) => ({ x: i % GRID, y: Math.floor(i / GRID) });

export const inBounds = (x, y) => x >= 0 && x < GRID && y >= 0 && y < GRID;
export const isCell = (i) => Number.isInteger(i) && i >= 0 && i < CELLS;

/** 0 -> "A1", 224 -> "O15" */
export function label(i) {
  const { x, y } = toXY(i);
  return `${LETTERS[x]}${y + 1}`;
}

export function fromLabel(str) {
  const m = /^([A-O])(\d{1,2})$/i.exec(String(str).trim());
  if (!m) return null;
  const x = LETTERS.indexOf(m[1].toUpperCase());
  const y = Number(m[2]) - 1;
  return inBounds(x, y) ? toIndex(x, y) : null;
}

export const columnLetters = () => LETTERS.split('');

/**
 * Cells a ship would occupy, or null if it runs off the grid.
 * `dir` is 'h' (east) or 'v' (south) from the anchor.
 */
export function shipCells(anchor, dir, len) {
  if (!isCell(anchor)) return null;
  const { x, y } = toXY(anchor);
  const out = [];
  for (let n = 0; n < len; n++) {
    const cx = dir === 'h' ? x + n : x;
    const cy = dir === 'v' ? y + n : y;
    if (!inBounds(cx, cy)) return null;
    out.push(toIndex(cx, cy));
  }
  return out;
}
