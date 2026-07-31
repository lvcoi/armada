// Cells are a flat index 0..grid*grid-1. Column letters A.., row numbers 1..grid.
// Every function takes the grid size explicitly — board size varies by player count,
// so there is deliberately no module-level default to fall back on.

import { MAX_GRID } from './constants.js';

const LETTERS = 'ABCDEFGHIJKLMNO'; // MAX_GRID columns

export const toIndex = (x, y, grid) => y * grid + x;
export const toXY = (i, grid) => ({ x: i % grid, y: Math.floor(i / grid) });

export const inBounds = (x, y, grid) => x >= 0 && x < grid && y >= 0 && y < grid;
export const isCell = (i, grid) => Number.isInteger(i) && i >= 0 && i < grid * grid;

/** 0 -> "A1"; on a 15 grid, 224 -> "O15". */
export function label(i, grid) {
  const { x, y } = toXY(i, grid);
  return `${LETTERS[x]}${y + 1}`;
}

export function fromLabel(str, grid) {
  const m = /^([A-O])(\d{1,2})$/i.exec(String(str).trim());
  if (!m) return null;
  const x = LETTERS.indexOf(m[1].toUpperCase());
  const y = Number(m[2]) - 1;
  return inBounds(x, y, grid) ? toIndex(x, y, grid) : null;
}

export const columnLetters = (grid = MAX_GRID) => LETTERS.slice(0, grid).split('');

/**
 * Cells a ship would occupy, or null if it runs off the grid.
 * `dir` is 'h' (east) or 'v' (south) from the anchor.
 */
export function shipCells(anchor, dir, len, grid) {
  if (!isCell(anchor, grid)) return null;
  const { x, y } = toXY(anchor, grid);
  const out = [];
  for (let n = 0; n < len; n++) {
    const cx = dir === 'h' ? x + n : x;
    const cy = dir === 'v' ? y + n : y;
    if (!inBounds(cx, cy, grid)) return null;
    out.push(toIndex(cx, cy, grid));
  }
  return out;
}
