import test from 'node:test';
import assert from 'node:assert/strict';

import { FLEET, FLEET_CELLS, GRID_FOR_PLAYERS, gridFor } from '../shared/constants.js';
import { toIndex, toXY, label, fromLabel, shipCells } from '../shared/coords.js';
import { TERRAIN_IDS, TERRAIN_GRIDS, TERRAIN, isLand, landCells, isSymmetric } from '../shared/terrain.js';
import { validateFleet, randomFleet, completeFleet, legalDirections } from '../shared/placement.js';

const GRIDS = TERRAIN_GRIDS; // [10, 12, 15]

test('board size follows the player count', () => {
  assert.equal(gridFor(2), 10);
  assert.equal(gridFor(3), 12);
  assert.equal(gridFor(4), 15);
  // Out-of-range counts clamp rather than explode.
  assert.equal(gridFor(1), 10);
  assert.equal(gridFor(9), 15);
  assert.deepEqual(Object.keys(GRID_FOR_PLAYERS).map(Number), [2, 3, 4]);
});

test('coords round-trip at every grid size', () => {
  for (const g of GRIDS) {
    for (let i = 0; i < g * g; i++) {
      const { x, y } = toXY(i, g);
      assert.equal(toIndex(x, y, g), i);
    }
    assert.equal(label(0, g), 'A1');
  }
  assert.equal(label(10 * 10 - 1, 10), 'J10');
  assert.equal(label(12 * 12 - 1, 12), 'L12');
  assert.equal(label(15 * 15 - 1, 15), 'O15');
  assert.equal(fromLabel('A1', 15), 0);
  assert.equal(fromLabel('O15', 15), 15 * 15 - 1);
  assert.equal(fromLabel('P1', 15), null);
  // A column that exists at 15 but not at 10 must not resolve on the small board.
  assert.equal(fromLabel('K1', 10), null);
  assert.equal(fromLabel('K1', 12), 10);
});

test('ships do not wrap around row edges', () => {
  for (const g of GRIDS) {
    // Anchored on the last column, a horizontal ship must fail rather than wrap.
    assert.equal(shipCells(toIndex(g - 1, 0, g), 'h', 2, g), null);
    assert.deepEqual(shipCells(toIndex(g - 2, 0, g), 'h', 2, g), [g - 2, g - 1]);
    // Same for the bottom row vertically.
    assert.equal(shipCells(toIndex(0, g - 1, g), 'v', 2, g), null);
  }
});

test('every terrain layout is well formed and 180-degree symmetric at every size', () => {
  assert.ok(TERRAIN_IDS.length >= 4, 'want a few layouts to choose between');
  for (const g of GRIDS) {
    assert.deepEqual(Object.keys(TERRAIN[g]).sort(), [...TERRAIN_IDS].sort(),
      `grid ${g} must offer every motif`);
    for (const id of TERRAIN_IDS) {
      assert.ok(isSymmetric(id, g), `${id}@${g} is not rotationally symmetric`);
      for (const cell of TERRAIN[g][id]) {
        assert.ok(cell >= 0 && cell < g * g, `${id}@${g} has an out-of-range cell`);
      }
      // Land should stay a garnish, not eat the board.
      assert.ok(landCells(id, g).length <= 40, `${id}@${g} has too much land`);
    }
  }
});

test('a full fleet always places on every layout at every size', () => {
  for (const g of GRIDS) {
    for (const id of TERRAIN_IDS) {
      for (let trial = 0; trial < 100; trial++) {
        const ships = randomFleet(id, g);
        const check = validateFleet(
          ships.map(({ type, anchor, dir }) => ({ type, anchor, dir })),
          id, g,
        );
        assert.ok(check.ok, `${id}@${g}: ${check.error}`);
        const cells = new Set(ships.flatMap((s) => s.cells));
        assert.equal(cells.size, FLEET_CELLS, `${id}@${g}: fleet overlaps itself`);
        for (const c of cells) assert.ok(!isLand(id, c, g), `${id}@${g}: ship sits on land`);
      }
    }
  }
});

test('validateFleet rejects overlaps, land, duplicates and off-grid ships', () => {
  const id = 'atoll';
  const G = 15;
  const ok = randomFleet(id, G).map(({ type, anchor, dir }) => ({ type, anchor, dir }));
  assert.ok(validateFleet(ok, id, G).ok);

  // Two ships on the same anchor overlap.
  const overlap = [
    { type: 'carrier', anchor: 0, dir: 'h' },
    { type: 'battleship', anchor: 0, dir: 'h' },
    { type: 'cruiser', anchor: toIndex(0, 2, G), dir: 'h' },
    { type: 'submarine', anchor: toIndex(0, 3, G), dir: 'h' },
    { type: 'destroyer', anchor: toIndex(0, 4, G), dir: 'h' },
  ];
  assert.equal(validateFleet(overlap, id, G).ok, false);

  // A ship laid across the atoll's land must be rejected.
  const land = [...TERRAIN[G][id]][0];
  const onLand = [
    { type: 'carrier', anchor: land, dir: 'h' },
    { type: 'battleship', anchor: toIndex(0, 0, G), dir: 'h' },
    { type: 'cruiser', anchor: toIndex(0, 2, G), dir: 'h' },
    { type: 'submarine', anchor: toIndex(0, 3, G), dir: 'h' },
    { type: 'destroyer', anchor: toIndex(0, 4, G), dir: 'h' },
  ];
  assert.equal(validateFleet(onLand, id, G).ok, false);

  // Missing a ship type.
  assert.equal(validateFleet(ok.slice(1), id, G).ok, false);

  // Duplicate type.
  const dup = [...ok.slice(0, 4), { ...ok[3] }];
  assert.equal(validateFleet(dup, id, G).ok, false);

  // Legal on a 15 board, off the edge of a 10 board.
  const wide = [
    { type: 'carrier', anchor: toIndex(8, 0, 10), dir: 'h' }, // runs to x=12 on a 10 grid
    { type: 'battleship', anchor: toIndex(0, 1, 10), dir: 'h' },
    { type: 'cruiser', anchor: toIndex(0, 2, 10), dir: 'h' },
    { type: 'submarine', anchor: toIndex(0, 3, 10), dir: 'h' },
    { type: 'destroyer', anchor: toIndex(0, 4, 10), dir: 'h' },
  ];
  assert.equal(validateFleet(wide, id, 10).ok, false);
});

test('completeFleet keeps valid placements and fills the rest', () => {
  for (const g of GRIDS) {
    const id = 'crossroads';
    const full = randomFleet(id, g);
    const partial = full.slice(0, 2).map(({ type, anchor, dir }) => ({ type, anchor, dir }));

    const done = completeFleet(partial, id, g);
    assert.equal(done.length, FLEET.length);

    // The two the player had already placed survive untouched.
    for (const kept of partial) {
      const match = done.find((s) => s.type === kept.type);
      assert.equal(match.anchor, kept.anchor);
      assert.equal(match.dir, kept.dir);
    }

    const check = validateFleet(done.map(({ type, anchor, dir }) => ({ type, anchor, dir })), id, g);
    assert.ok(check.ok, check.error);
  }
});

test('completeFleet discards a placement that is no longer legal', () => {
  const id = 'atoll';
  const G = 12;
  const land = [...TERRAIN[G][id]][0];
  const done = completeFleet([{ type: 'carrier', anchor: land, dir: 'h' }], id, G);
  const carrier = done.find((s) => s.type === 'carrier');
  assert.ok(carrier.cells.every((c) => !isLand(id, c, G)));
});

test('legalDirections greys out what will not fit', () => {
  const id = 'atoll';
  for (const g of GRIDS) {
    const corner = toIndex(g - 1, g - 1, g);
    assert.deepEqual(legalDirections(corner, 2, id, new Set(), g), []);
    assert.deepEqual(legalDirections(toIndex(0, 0, g), 2, id, new Set(), g).sort(), ['h', 'v']);
  }
});
