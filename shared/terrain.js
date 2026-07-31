// Island layouts. All players in a game share one layout, so it is part of the
// shared coordinate space rather than per-player state.
//
// Layouts are hand-authored as string art ('#' = land, '.' = water) in every board
// size the game plays (10, 12, 15 — see GRID_FOR_PLAYERS), and are 180-degree
// rotationally symmetric, so no corner of the map is advantaged. Authoring them by
// hand rather than generating them keeps two guarantees cheap: the fleet always fits
// with room to spare, and the map reads clearly at ~22px cells on a phone.
//
// `npm test` verifies the symmetry and placeability of every layout at every size.

import { toIndex } from './coords.js';

const W10 = '..........';
const W12 = '............';
const W15 = '...............';

const ART = {
  10: {
    atoll: [
      W10, W10, W10,
      '...####...',
      '...#..#...',
      '...#..#...',
      '...####...',
      W10, W10, W10,
    ],
    straits: [
      W10, W10,
      '..#.......',
      '..#.......',
      '..#....#..',
      '..#....#..',
      '.......#..',
      '.......#..',
      W10, W10,
    ],
    archipelago: [
      W10,
      '..#.......',
      '......#...',
      W10,
      '....#.....',
      '.....#....',
      W10,
      '...#......',
      '.......#..',
      W10,
    ],
    crossroads: [
      W10, W10,
      '....##....',
      '....##....',
      '..######..',
      '..######..',
      '....##....',
      '....##....',
      W10, W10,
    ],
    shoals: [
      W10,
      '.##....##.',
      '.#......#.',
      W10, W10, W10, W10,
      '.#......#.',
      '.##....##.',
      W10,
    ],
  },

  12: {
    atoll: [
      W12, W12, W12, W12,
      '....####....',
      '....#..#....',
      '....#..#....',
      '....####....',
      W12, W12, W12, W12,
    ],
    straits: [
      W12, W12,
      '...#........',
      '...#........',
      '...#........',
      '...#........',
      '........#...',
      '........#...',
      '........#...',
      '........#...',
      W12, W12,
    ],
    archipelago: [
      W12,
      '..#.........',
      '.........#..',
      W12,
      '...#........',
      '......#.....',
      '.....#......',
      '........#...',
      W12,
      '..#.........',
      '.........#..',
      W12,
    ],
    crossroads: [
      W12, W12,
      '.....##.....',
      '.....##.....',
      '.....##.....',
      '..########..',
      '..########..',
      '.....##.....',
      '.....##.....',
      '.....##.....',
      W12, W12,
    ],
    shoals: [
      W12,
      '.##......##.',
      '.#........#.',
      W12, W12, W12, W12, W12, W12,
      '.#........#.',
      '.##......##.',
      W12,
    ],
  },

  15: {
    // Open water with a small central atoll — the default "clean" map.
    atoll: [
      W15, W15, W15, W15, W15, W15,
      '......###......',
      '......#.#......',
      '......###......',
      W15, W15, W15, W15, W15, W15,
    ],

    // Two offset walls that break up long straight runs down the board.
    straits: [
      W15, W15, W15,
      '....#..........',
      '....#..........',
      '....#..........',
      '....#..........',
      W15,
      '..........#....',
      '..........#....',
      '..........#....',
      '..........#....',
      W15, W15, W15,
    ],

    // Scattered single cells — barely constrains placement, mostly visual interest.
    archipelago: [
      W15, W15,
      '..#............',
      '...........#...',
      W15,
      '.......#.......',
      '..#............',
      '.....#...#.....',
      '............#..',
      '.......#.......',
      W15,
      '...#...........',
      '............#..',
      W15, W15,
    ],

    // A central cross that forces fleets toward the edges and quadrants.
    crossroads: [
      W15, W15, W15, W15, W15,
      '.......#.......',
      '.......#.......',
      '.....##.##.....',
      '.......#.......',
      '.......#.......',
      W15, W15, W15, W15, W15,
    ],

    // Rocky corners; the middle of the board stays wide open.
    shoals: [
      W15,
      '.##.........##.',
      '.#...........#.',
      W15, W15, W15, W15, W15, W15, W15, W15, W15,
      '.#...........#.',
      '.##.........##.',
      W15,
    ],
  },
};

function parse(rows, grid) {
  if (rows.length !== grid) throw new Error(`layout needs ${grid} rows, got ${rows.length}`);
  const set = new Set();
  rows.forEach((row, y) => {
    if (row.length !== grid) throw new Error(`row ${y} needs ${grid} chars, got ${row.length}`);
    for (let x = 0; x < grid; x++) {
      if (row[x] === '#') set.add(toIndex(x, y, grid));
    }
  });
  return set;
}

/** grid -> id -> Set of land cell indices */
export const TERRAIN = Object.fromEntries(
  Object.entries(ART).map(([grid, motifs]) => [
    grid,
    Object.fromEntries(
      Object.entries(motifs).map(([id, rows]) => [id, parse(rows, Number(grid))]),
    ),
  ]),
);

export const TERRAIN_IDS = Object.keys(ART[15]);
export const TERRAIN_GRIDS = Object.keys(ART).map(Number);

export function isLand(terrainId, cell, grid) {
  const t = TERRAIN[grid]?.[terrainId];
  return t ? t.has(cell) : false;
}

/** Sorted array — what gets serialized to clients. */
export function landCells(terrainId, grid) {
  return [...(TERRAIN[grid]?.[terrainId] ?? [])].sort((a, b) => a - b);
}

export function randomTerrainId(rng = Math.random) {
  return TERRAIN_IDS[Math.floor(rng() * TERRAIN_IDS.length)];
}

/** True when the layout is unchanged by a 180-degree rotation. */
export function isSymmetric(terrainId, grid) {
  const t = TERRAIN[grid]?.[terrainId];
  if (!t) return false;
  const cells = grid * grid;
  for (const cell of t) {
    if (!t.has(cells - 1 - cell)) return false;
  }
  return true;
}
