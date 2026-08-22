// Pure rule functions. No sockets, no timers — everything here is directly testable.

import { SHOT } from '../shared/constants.js';
import { isLand } from '../shared/terrain.js';

/**
 * Resolve one shot against ONE defender.
 *
 * This is the heart of the 4-player rule: the shot is written to `defender.incoming`,
 * which belongs to the defender alone. Firing G7 at Mom touches mom.incoming[g7];
 * firing G7 at Dad touches dad.incoming[g7]. Nothing global is ever consulted or
 * written, so the same coordinate against two different players stays two independent
 * events. Do not introduce a shared shot grid.
 */
export function fireAt(defender, cell) {
  const shipIdx = defender.shipAt[cell];

  if (shipIdx < 0) {
    defender.incoming[cell] = SHOT.MISS;
    return { result: 'miss' };
  }

  defender.incoming[cell] = SHOT.HIT;
  const ship = defender.ships[shipIdx];
  if (!ship.hits.includes(cell)) ship.hits.push(cell);

  if (ship.hits.length >= ship.len) {
    ship.sunk = true;
    return { result: 'sunk', shipType: ship.type };
  }
  return { result: 'hit' };
}

export const fleetSunk = (player) =>
  player.ships.length > 0 && player.ships.every((s) => s.sunk);

export const shipsRemaining = (player) =>
  player.ships.filter((s) => !s.sunk).length;

/** Cells that may still legally be fired at this defender. */
export function openCells(defender, terrainId, grid) {
  const out = [];
  for (let c = 0; c < grid * grid; c++) {
    if (defender.incoming[c] === SHOT.NONE && !isLand(terrainId, c, grid)) out.push(c);
  }
  return out;
}

/** Why this shot is illegal, or null if it is fine. */
export function rejectFire(defender, cell, terrainId, grid) {
  if (!Number.isInteger(cell) || cell < 0 || cell >= grid * grid) return 'bad_cell';
  if (isLand(terrainId, cell, grid)) return 'cell_is_land';
  if (defender.incoming[cell] !== SHOT.NONE) return 'already_fired';
  return null;
}
