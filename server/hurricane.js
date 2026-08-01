// The storm. Pure rule functions, like game.js — no sockets, no timers, no turn state.
// The Room decides WHEN to call these; this module only answers "where is the storm"
// and "what does it do to one board".
//
// Once a game a vertical band walks west to east across EVERY player's board. Any ship
// it touches is picked up and dropped somewhere else legal, keeping its damage, and the
// whole strip of shot marks is wiped. That wipe is the point: a scattered ship goes
// invisible again, so the storm resets everyone's intel instead of just shuffling wood.

import {
  SHOT, MAX_GRID,
  HURRICANE_BAND, HURRICANE_STEP, HURRICANE_START_ROUND, HURRICANE_WARNING_ROUNDS,
} from '../shared/constants.js';
import { canPlace } from '../shared/placement.js';

/** Rounds played when the band first covers column 0. */
const LANDFALL_ROUND = HURRICANE_START_ROUND + HURRICANE_WARNING_ROUNDS;

/**
 * Where the storm is after `roundsPlayed` full rounds:
 *
 *   null                                  nothing announced yet
 *   { phase:'warning', roundsLeft }       counting down to landfall, everyone sees it
 *   { phase:'active', leadColumn, band }  band is {from,to} inclusive columns, ready to sweep
 *   { phase:'passed' }                    blown off the east edge, never comes back
 *
 * `grid` decides when the band runs out of board, so it is passed in like everywhere
 * else. It defaults to MAX_GRID because reporting 'passed' too EARLY would silently skip
 * a real sweep, while reporting it late costs nothing — a band past the edge sweeps zero
 * cells.
 */
export function hurricaneState(roundsPlayed, grid = MAX_GRID) {
  if (!Number.isFinite(roundsPlayed)) return null;
  const played = Math.floor(roundsPlayed);

  if (played < HURRICANE_START_ROUND) return null;
  if (played < LANDFALL_ROUND) {
    return { phase: 'warning', roundsLeft: LANDFALL_ROUND - played };
  }

  const from = (played - LANDFALL_ROUND) * HURRICANE_STEP;
  if (from > grid - 1) return { phase: 'passed' };

  // Clamped, so the last sweep of a narrow board is a real band and not a phantom
  // column sitting off the edge.
  const to = Math.min(from + HURRICANE_BAND - 1, grid - 1);
  return { phase: 'active', leadColumn: to, band: { from, to } };
}

/**
 * Apply one round of the storm to ONE player's board.
 *
 * `band` is {from, to} inclusive column indices — take it from hurricaneState().
 * Returns { moved, cleared, stuck }: ships relocated, shot marks wiped, and ships the
 * storm could not find a legal berth for (left exactly where they were — a corrupt board
 * is worse than a ship that rode it out).
 */
export function sweepBoard(player, band, grid, terrainId, rng = Math.random) {
  const from = Math.max(0, band?.from ?? 0);
  const to = Math.min(grid - 1, band?.to ?? -1);
  if (!player || from > to) return { moved: 0, cleared: 0, stuck: 0 };

  const inBand = (cell) => {
    const x = cell % grid;
    return x >= from && x <= to;
  };

  // Wipe the strip first: cells the storm just scrubbed then count as unsearched water,
  // which is exactly where we want the scattered ships to prefer to hide.
  let cleared = 0;
  for (let y = 0; y < grid; y++) {
    for (let x = from; x <= to; x++) {
      const cell = y * grid + x;
      if (player.incoming[cell] !== SHOT.NONE) {
        player.incoming[cell] = SHOT.NONE;
        cleared++;
      }
    }
  }

  // Wrecks do not sail, and a ship the band missed stays put — both just hold their water.
  const movers = [];
  const occupied = new Set();
  for (const ship of player.ships) {
    if (!ship.sunk && ship.cells.some(inBand)) movers.push(ship);
    else ship.cells.forEach((c) => occupied.add(c));
  }

  // Longest first, same reason as randomFleet: the big hulls are the hard fit.
  movers.sort((a, b) => b.len - a.len);

  let moved = 0;
  let stuck = 0;
  for (const ship of movers) {
    const spot = pickBerth(ship, terrainId, occupied, player.incoming, grid, rng);
    if (!spot) {
      ship.cells.forEach((c) => occupied.add(c));
      stuck++;
      continue;
    }

    // Any mark left under the new hull has to go. A cell that still reads "already fired"
    // can never be fired at again, and an armoured hull could never be sunk — that would
    // hang the game, not just look odd.
    for (const c of spot.cells) {
      if (player.incoming[c] !== SHOT.NONE) {
        player.incoming[c] = SHOT.NONE;
        cleared++;
      }
    }

    relocate(ship, spot);
    spot.cells.forEach((c) => occupied.add(c));
    moved++;
  }

  // Rebuild the lookup from the ships themselves, so it can't drift out of step with them.
  player.shipAt.fill(-1);
  player.ships.forEach((ship, idx) => {
    ship.cells.forEach((c) => { player.shipAt[c] = idx; });
  });

  return { moved, cleared, stuck };
}

/**
 * Pick somewhere legal for a scattered ship. Untouched water is preferred over water the
 * enemy has already shot at, so a moved ship really does vanish; the shot-at options are
 * only a fallback for a crowded board. The ship's current placement is excluded — the
 * storm moves it or reports it stuck, it never pretends.
 */
function pickBerth(ship, terrainId, occupied, incoming, grid, rng) {
  const fresh = [];
  const searched = [];

  for (let anchor = 0; anchor < grid * grid; anchor++) {
    for (const dir of ['h', 'v']) {
      if (anchor === ship.anchor && dir === ship.dir) continue;
      const cells = canPlace(anchor, dir, ship.len, terrainId, occupied, grid);
      if (!cells) continue;
      const spot = { anchor, dir, cells };
      (cells.every((c) => incoming[c] === SHOT.NONE) ? fresh : searched).push(spot);
    }
  }

  const pool = fresh.length ? fresh : searched;
  if (!pool.length) return null;
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * Damage rides along with the hull: the same offsets down the ship stay hit, so a ship
 * comes out of the storm with exactly the hits it went in with — never more than it has
 * cells, never fewer than it earned.
 */
function relocate(ship, spot) {
  const offsets = ship.hits
    .map((c) => ship.cells.indexOf(c))
    .filter((i) => i >= 0);

  ship.anchor = spot.anchor;
  ship.dir = spot.dir;
  ship.cells = spot.cells;
  ship.hits = offsets.map((i) => spot.cells[i]);
}
