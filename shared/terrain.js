// Island layouts. All players in a game share one layout, so it is part of the
// shared coordinate space rather than per-player state.
//
// Layouts are hand-authored as 15x15 string art ('#' = land, '.' = water) and are
// 180-degree rotationally symmetric, so no corner of the map is advantaged. Authoring
// them by hand rather than generating them keeps two guarantees cheap: the fleet always
// fits with room to spare, and the map reads clearly at 21px cells on a phone.
//
// `npm test` verifies the symmetry and placeability of every layout below.

import { GRID, CELLS } from './constants.js';
import { toIndex } from './coords.js';

const W = '...............';

const ART = {
  // Open water with a small central atoll — the default "clean" map.
  atoll: [
    W, W, W, W, W, W,
    '......###......',
    '......#.#......',
    '......###......',
    W, W, W, W, W, W,
  ],

  // Two offset walls that break up long straight runs down the board.
  straits: [
    W, W, W,
    '....#..........',
    '....#..........',
    '....#..........',
    '....#..........',
    W,
    '..........#....',
    '..........#....',
    '..........#....',
    '..........#....',
    W, W, W,
  ],

  // Scattered single cells — barely constrains placement, mostly visual interest.
  archipelago: [
    W, W,
    '..#............',
    '...........#...',
    W,
    '.......#.......',
    '..#............',
    '.....#...#.....',
    '............#..',
    '.......#.......',
    W,
    '...#...........',
    '............#..',
    W, W,
  ],

  // A central cross that forces fleets toward the edges and quadrants.
  crossroads: [
    W, W, W, W, W,
    '.......#.......',
    '.......#.......',
    '.....##.##.....',
    '.......#.......',
    '.......#.......',
    W, W, W, W, W,
  ],

  // Rocky corners; the middle of the board stays wide open.
  shoals: [
    W,
    '.##.........##.',
    '.#...........#.',
    W, W, W, W, W, W, W, W, W,
    '.#...........#.',
    '.##.........##.',
    W,
  ],
};

function parse(rows) {
  if (rows.length !== GRID) throw new Error(`layout needs ${GRID} rows, got ${rows.length}`);
  const set = new Set();
  rows.forEach((row, y) => {
    if (row.length !== GRID) throw new Error(`row ${y} needs ${GRID} chars, got ${row.length}`);
    for (let x = 0; x < GRID; x++) {
      if (row[x] === '#') set.add(toIndex(x, y));
    }
  });
  return set;
}

/** id -> Set of land cell indices */
export const TERRAIN = Object.fromEntries(
  Object.entries(ART).map(([id, rows]) => [id, parse(rows)]),
);

export const TERRAIN_IDS = Object.keys(TERRAIN);

export function isLand(terrainId, cell) {
  const t = TERRAIN[terrainId];
  return t ? t.has(cell) : false;
}

/** Sorted array — what gets serialized to clients. */
export function landCells(terrainId) {
  return [...(TERRAIN[terrainId] ?? [])].sort((a, b) => a - b);
}

export function randomTerrainId(rng = Math.random) {
  return TERRAIN_IDS[Math.floor(rng() * TERRAIN_IDS.length)];
}

/** True when the layout is unchanged by a 180-degree rotation. */
export function isSymmetric(terrainId) {
  const t = TERRAIN[terrainId];
  for (const cell of t) {
    if (!t.has(CELLS - 1 - cell)) return false;
  }
  return true;
}
