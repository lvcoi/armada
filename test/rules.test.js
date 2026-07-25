import test from 'node:test';
import assert from 'node:assert/strict';

import { GRID, CELLS, FLEET, FLEET_CELLS } from '../shared/constants.js';
import { toIndex, toXY, label, fromLabel, shipCells } from '../shared/coords.js';
import { TERRAIN_IDS, TERRAIN, isLand, landCells, isSymmetric } from '../shared/terrain.js';
import { validateFleet, randomFleet, completeFleet, legalDirections } from '../shared/placement.js';

test('coords round-trip', () => {
  for (let i = 0; i < CELLS; i++) {
    const { x, y } = toXY(i);
    assert.equal(toIndex(x, y), i);
  }
  assert.equal(label(0), 'A1');
  assert.equal(label(CELLS - 1), 'O15');
  assert.equal(fromLabel('A1'), 0);
  assert.equal(fromLabel('O15'), CELLS - 1);
  assert.equal(fromLabel('P1'), null);
});

test('ships do not wrap around row edges', () => {
  // Anchored on the last column, a horizontal ship must fail rather than wrap.
  assert.equal(shipCells(toIndex(GRID - 1, 0), 'h', 2), null);
  assert.deepEqual(shipCells(toIndex(GRID - 2, 0), 'h', 2), [GRID - 2, GRID - 1]);
  // Same for the bottom row vertically.
  assert.equal(shipCells(toIndex(0, GRID - 1), 'v', 2), null);
});

test('every terrain layout is well formed and 180-degree symmetric', () => {
  assert.ok(TERRAIN_IDS.length >= 4, 'want a few layouts to choose between');
  for (const id of TERRAIN_IDS) {
    assert.ok(isSymmetric(id), `${id} is not rotationally symmetric`);
    for (const cell of TERRAIN[id]) {
      assert.ok(cell >= 0 && cell < CELLS, `${id} has an out-of-range cell`);
    }
    // Land should stay a garnish, not eat the board.
    assert.ok(landCells(id).length <= 40, `${id} has too much land`);
  }
});

test('a full fleet always places on every layout', () => {
  for (const id of TERRAIN_IDS) {
    for (let trial = 0; trial < 200; trial++) {
      const ships = randomFleet(id);
      const check = validateFleet(
        ships.map(({ type, anchor, dir }) => ({ type, anchor, dir })),
        id,
      );
      assert.ok(check.ok, `${id}: ${check.error}`);
      const cells = new Set(ships.flatMap((s) => s.cells));
      assert.equal(cells.size, FLEET_CELLS, `${id}: fleet overlaps itself`);
      for (const c of cells) assert.ok(!isLand(id, c), `${id}: ship sits on land`);
    }
  }
});

test('validateFleet rejects overlaps, land, duplicates and off-grid ships', () => {
  const id = 'atoll';
  const ok = randomFleet(id).map(({ type, anchor, dir }) => ({ type, anchor, dir }));
  assert.ok(validateFleet(ok, id).ok);

  // Two ships on the same anchor overlap.
  const overlap = [
    { type: 'carrier', anchor: 0, dir: 'h' },
    { type: 'battleship', anchor: 0, dir: 'h' },
    { type: 'cruiser', anchor: toIndex(0, 2), dir: 'h' },
    { type: 'submarine', anchor: toIndex(0, 3), dir: 'h' },
    { type: 'destroyer', anchor: toIndex(0, 4), dir: 'h' },
  ];
  assert.equal(validateFleet(overlap, id).ok, false);

  // A ship laid across the atoll's land must be rejected.
  const land = [...TERRAIN[id]][0];
  const onLand = [
    { type: 'carrier', anchor: land, dir: 'h' },
    { type: 'battleship', anchor: toIndex(0, 0), dir: 'h' },
    { type: 'cruiser', anchor: toIndex(0, 2), dir: 'h' },
    { type: 'submarine', anchor: toIndex(0, 3), dir: 'h' },
    { type: 'destroyer', anchor: toIndex(0, 4), dir: 'h' },
  ];
  assert.equal(validateFleet(onLand, id).ok, false);

  // Missing a ship type.
  assert.equal(validateFleet(ok.slice(1), id).ok, false);

  // Duplicate type.
  const dup = [...ok.slice(0, 4), { ...ok[3] }];
  assert.equal(validateFleet(dup, id).ok, false);
});

test('completeFleet keeps valid placements and fills the rest', () => {
  const id = 'crossroads';
  const full = randomFleet(id);
  const partial = full.slice(0, 2).map(({ type, anchor, dir }) => ({ type, anchor, dir }));

  const done = completeFleet(partial, id);
  assert.equal(done.length, FLEET.length);

  // The two the player had already placed survive untouched.
  for (const kept of partial) {
    const match = done.find((s) => s.type === kept.type);
    assert.equal(match.anchor, kept.anchor);
    assert.equal(match.dir, kept.dir);
  }

  const check = validateFleet(done.map(({ type, anchor, dir }) => ({ type, anchor, dir })), id);
  assert.ok(check.ok, check.error);
});

test('completeFleet discards a placement that is no longer legal', () => {
  const id = 'atoll';
  const land = [...TERRAIN[id]][0];
  const done = completeFleet([{ type: 'carrier', anchor: land, dir: 'h' }], id);
  const carrier = done.find((s) => s.type === 'carrier');
  assert.ok(carrier.cells.every((c) => !isLand(id, c)));
});

test('legalDirections greys out what will not fit', () => {
  const id = 'atoll';
  const corner = toIndex(GRID - 1, GRID - 1);
  assert.deepEqual(legalDirections(corner, 2, id, new Set()), []);
  assert.deepEqual(legalDirections(toIndex(0, 0), 2, id, new Set()).sort(), ['h', 'v']);
});
