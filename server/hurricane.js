// The storm. Pure rule functions, like game.js — no sockets, no timers, no turn state.
// The Room decides WHEN to call these; this module only answers "where is the storm"
// and "what does it do to one board".
//
// Once a game a hurricane crosses EVERY player's board: a 3x3 eye that blows in off a
// random edge and wanders to the far side, one square per round. Any ship it touches is
// picked up and dropped somewhere else legal, keeping its damage, and every shot mark
// under it is wiped. That wipe is the point: a scattered ship goes invisible again, so
// the storm resets everyone's intel instead of just shuffling wood.
//
// The track is rolled ONCE, up front, and the footprint is reported as real cells — the
// client draws the storm from those cells, so what players see and what the sweep hits
// can never drift apart.

import {
  SHOT, MAX_GRID,
  HURRICANE_BAND, HURRICANE_START_ROUND, HURRICANE_WARNING_ROUNDS,
} from '../shared/constants.js';
import { toIndex, inBounds, isCell } from '../shared/coords.js';
import { canPlace } from '../shared/placement.js';

/** Rounds played when the storm reaches its first square on the track. */
const LANDFALL_ROUND = HURRICANE_START_ROUND + HURRICANE_WARNING_ROUNDS;

/** HURRICANE_BAND is the footprint width, so a 3-wide storm reaches 1 cell either side. */
const REACH = Math.max(0, Math.floor((HURRICANE_BAND - 1) / 2));

/** Odds of a sideways jog each step. High enough that the track visibly meanders. */
const DRIFT_CHANCE = 0.6;

/** Headings: [dx, dy] — west->east, east->west, north->south, south->north. */
const HEADINGS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Roll the storm's whole track up front: one 3x3 CENTRE per active round.
 *
 * It enters one cell OFF a randomly chosen edge and leaves one cell off the far edge, so
 * every column (or row) of the board gets a turn under it — that is grid + 2 steps. Each
 * step advances one cell along the crossing axis and may jog one cell sideways, which is
 * what makes it wander instead of running dead straight down a lane.
 *
 * Centres stay in [-1, grid] on the crossing axis, so the 3x3 always overlaps at least one
 * real cell — a step that hit nothing would be a round of storm that silently does nothing.
 * Sideways the eye is held one cell in from the sides and BOUNCES off them rather than
 * being clamped: clamping lets an unlucky walk pin itself to an edge for the whole
 * crossing, which is both a boring track and a storm the players can only half see.
 *
 * Deterministic for a given rng, so a replay of the same seed gets the same weather.
 */
export function hurricanePath(grid, rng = Math.random) {
  const size = Number.isInteger(grid) && grid > 0 ? grid : MAX_GRID;
  const [dx, dy] = HEADINGS[clamp(Math.floor(rng() * HEADINGS.length), 0, HEADINGS.length - 1)];

  // Lanes the eye may wander between. Inset by its reach so the whole 3x3 stays visible,
  // but never past the middle — a board narrower than the storm still has to work.
  const lo = Math.min(REACH, Math.floor((size - 1) / 2));
  const hi = size - 1 - lo;
  const lane = lo + Math.floor(rng() * (hi - lo + 1));

  // Along the crossing axis: start just outside the upwind edge. Across it: that lane.
  let x = dx === 0 ? lane : (dx > 0 ? -1 : size);
  let y = dy === 0 ? lane : (dy > 0 ? -1 : size);

  const path = [];
  for (let step = 0; step < size + 2; step++) {
    path.push({ x, y });

    x = clamp(x + dx, -1, size);
    y = clamp(y + dy, -1, size);

    if (rng() < DRIFT_CHANCE) {
      const jog = rng() < 0.5 ? -1 : 1;
      const across = dx === 0 ? x : y;
      const next = across + jog;
      const bounced = next < lo || next > hi ? across - jog : next;
      if (dx === 0) x = clamp(bounced, lo, hi);
      else y = clamp(bounced, lo, hi);
    }
  }

  // Stamped so hurricaneState can turn centres into flat cell indices without being handed
  // the grid again. Non-enumerable: the array still serializes as a plain list of centres.
  Object.defineProperty(path, 'grid', { value: size, enumerable: false });
  return path;
}

/**
 * Where the storm is after `roundsPlayed` full rounds, given the track from hurricanePath:
 *
 *   null                                     nothing announced yet
 *   { phase:'warning', roundsLeft }          counting down to landfall, everyone sees it
 *   { phase:'active', step, center, cells }  cells = the 3x3 footprint, clipped to the board
 *   { phase:'passed' }                       off the far edge, never comes back
 */
export function hurricaneState(roundsPlayed, path) {
  if (!Number.isFinite(roundsPlayed)) return null;
  const played = Math.floor(roundsPlayed);
  const track = Array.isArray(path) ? path : [];

  if (played < HURRICANE_START_ROUND) return null;
  if (played < LANDFALL_ROUND) {
    return { phase: 'warning', roundsLeft: LANDFALL_ROUND - played };
  }

  const step = played - LANDFALL_ROUND;
  const center = track[step];
  if (!center) return { phase: 'passed' };

  const grid = gridOf(track);
  // Copied, so a caller poking at the reported centre can't rewrite the rolled track.
  return {
    phase: 'active',
    step,
    center: { x: center.x, y: center.y },
    cells: footprint(center, grid),
  };
}

/**
 * Apply one round of the storm to ONE player's board.
 *
 * `cells` is the footprint from hurricaneState() — any set of flat indices works.
 * Returns { moved, cleared, stuck }: ships relocated, shot marks wiped, and ships the
 * storm could not find a legal berth for (left exactly where they were — a corrupt board
 * is worse than a ship that rode it out).
 */
export function sweepCells(player, cells, grid, terrainId, rng = Math.random) {
  const zone = new Set();
  for (const c of cells ?? []) {
    if (isCell(c, grid)) zone.add(c);
  }
  if (!player || !zone.size) return { moved: 0, cleared: 0, stuck: 0 };

  // Wipe the footprint first: cells the storm just scrubbed then count as unsearched water,
  // which is exactly where we want the scattered ships to prefer to hide.
  let cleared = 0;
  for (const cell of zone) {
    if (player.incoming[cell] !== SHOT.NONE) {
      player.incoming[cell] = SHOT.NONE;
      cleared++;
    }
  }

  // Wrecks do not sail, and a ship the storm missed stays put — both just hold their water.
  const movers = [];
  const occupied = new Set();
  for (const ship of player.ships) {
    if (!ship.sunk && ship.cells.some((c) => zone.has(c))) movers.push(ship);
    else ship.cells.forEach((c) => occupied.add(c));
  }

  // Longest first, same reason as randomFleet: the big hulls are the hard fit.
  movers.sort((a, b) => b.len - a.len);

  let moved = 0;
  let stuck = 0;
  for (let i = 0; i < movers.length; i++) {
    const ship = movers[i];

    // Water still under a ship that hasn't been dealt with yet is off limits. A mover that
    // turns out to be stuck stays home, so its home water has to still be there when we get
    // to it — otherwise two hulls end up stacked on the same cells.
    const blocked = new Set(occupied);
    for (let j = i + 1; j < movers.length; j++) {
      movers[j].cells.forEach((c) => blocked.add(c));
    }

    const spot = pickBerth(ship, terrainId, blocked, player.incoming, grid, rng);
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

/** The 3x3 around a centre, clipped to the board. Row-major, so indices come out sorted. */
function footprint(center, grid) {
  const out = [];
  for (let dy = -REACH; dy <= REACH; dy++) {
    for (let dx = -REACH; dx <= REACH; dx++) {
      const x = center.x + dx;
      const y = center.y + dy;
      if (inBounds(x, y, grid)) out.push(toIndex(x, y, grid));
    }
  }
  return out;
}

/**
 * Board size behind a track. hurricanePath stamps it on, which is the exact answer; the
 * fallback reads it off the track itself, since the crossing axis always runs out to
 * `grid` (one cell past the far edge) and nothing else on the track goes higher.
 */
function gridOf(path) {
  if (Number.isInteger(path.grid) && path.grid > 0) return path.grid;
  let max = 1;
  for (const p of path) max = Math.max(max, p?.x ?? 0, p?.y ?? 0);
  return max;
}

// Compared by cells rather than anchor+dir, so a ship can never be reported as moved
// when it landed back on the exact water it started from.
const samePlacement = (a, b) => a.length === b.length && a.every((c, i) => c === b[i]);

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
      const cells = canPlace(anchor, dir, ship.len, terrainId, occupied, grid);
      if (!cells || samePlacement(cells, ship.cells)) continue;
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
