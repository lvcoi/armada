// Hidden pickups. They sit on open water, invisible to everyone, and are revealed only
// by being shot at — there is no "collect" move, you find them by aiming somewhere.
//
// Two rules shape this whole file. First, scatter is PER DEFENDER: every player's board
// gets its own map, so B4 can be a mine on one board and empty water on another and no
// one can infer anything by comparing notes. Second, resolution returns a DESCRIPTION,
// not a mutation — resolvePowerup hands back effects and the Room decides when to apply
// them, so the turn machinery stays in one place and this module tests without a socket.

import {
  POWERUP, POWERUP_WEIGHTS, POWERUP_DENSITY, RADAR_RADIUS, SHOT,
} from '../shared/constants.js';
import { toXY, toIndex } from '../shared/coords.js';
import { isLand } from '../shared/terrain.js';
import { fireAt } from './game.js';

/** Public log lines. Everyone learns THAT a pickup fired and which kind — never whose ship. */
const NOTES = {
  [POWERUP.MINE]: 'struck a mine',
  [POWERUP.RADAR]: 'found a radar buoy',
  [POWERUP.EXTRA]: 'found a spare shell',
  [POWERUP.REPAIR]: 'found a repair crew',
  [POWERUP.RECHARGE]: 'found a supply crate',
};

const WEIGHT_TOTAL = POWERUP_WEIGHTS.reduce((n, [, w]) => n + w, 0);

/** Clamped so an rng that can return exactly 1 (test doubles do) can't index off the end. */
const randInt = (rng, n) => Math.min(n - 1, Math.max(0, Math.floor(rng() * n)));

function drawType(rng) {
  let roll = rng() * WEIGHT_TOTAL;
  for (const [type, weight] of POWERUP_WEIGHTS) {
    roll -= weight;
    if (roll < 0) return type;
  }
  return POWERUP_WEIGHTS[POWERUP_WEIGHTS.length - 1][0];
}

/**
 * Lay this defender's pickups. `occupiedByShips` is the set of cells their fleet sits on —
 * a pickup under a ship could never be shot without hitting the ship first, so it would
 * just be dead weight.
 *
 * @returns Map<cell, POWERUP type>
 */
export function scatterPowerups(terrainId, grid, occupiedByShips, rng = Math.random) {
  const taken = occupiedByShips instanceof Set
    ? occupiedByShips
    : new Set(occupiedByShips ?? []);
  const cells = grid * grid;

  const water = [];
  for (let c = 0; c < cells; c++) {
    if (!isLand(terrainId, c, grid) && !taken.has(c)) water.push(c);
  }

  // Density is per board cell, so a bigger ocean carries proportionally more.
  const want = Math.min(Math.round(cells * POWERUP_DENSITY), water.length);

  // Partial Fisher-Yates: draws `want` DISTINCT cells without shuffling the whole board,
  // which is what guarantees we never stack two pickups on one square.
  const out = new Map();
  for (let i = 0; i < want; i++) {
    const j = i + randInt(rng, water.length - i);
    [water[i], water[j]] = [water[j], water[i]];
    out.set(water[i], drawType(rng));
  }
  return out;
}

/**
 * Work out what one triggered pickup should do. Pure — nothing here is written to state.
 *
 * @param ctx { attacker, defender, cell, grid, terrainId }
 *            `cell` is the square that was shot, which is where radar centres itself.
 * @returns { effects, logNote, privateTo }
 *            `privateTo` is a player id when the effect carries detail only the finder
 *            may see, or null when there is nothing to hide.
 */
export function resolvePowerup(type, ctx, rng = Math.random) {
  const { attacker, defender, cell, grid, terrainId } = ctx ?? {};
  const logNote = NOTES[type] ?? null;
  if (!attacker) return { effects: [], logNote, privateTo: null };

  switch (type) {
    case POWERUP.MINE:
      return mine(attacker, logNote, rng);

    case POWERUP.RADAR:
      return radar(attacker, defender, cell, grid, terrainId, logNote);

    case POWERUP.EXTRA:
      return {
        effects: [{ kind: 'extraShot', playerId: attacker.id }],
        logNote,
        privateTo: null, // an extra shot announces itself the moment it is fired
      };

    case POWERUP.REPAIR:
      return repair(attacker, logNote, rng);

    case POWERUP.RECHARGE:
      return {
        effects: [{ kind: 'recharge', playerId: attacker.id }],
        logNote,
        privateTo: null,
      };

    default:
      return { effects: [], logNote: null, privateTo: null };
  }
}

/**
 * A mine is the price of a bad guess: it damages the ATTACKER's own fleet, and it can
 * finish off a ship that was already one hit from gone. `sinks` rides along so the Room
 * can announce the loss without re-deriving it.
 */
function mine(attacker, logNote, rng) {
  const priv = { logNote, privateTo: attacker.id };
  const ship = pickShip(attacker, (s) => !s.sunk && s.hits.length < s.len, rng);
  if (!ship) return { effects: [], ...priv }; // nothing left to damage; still a public bang

  const open = ship.cells.filter((c) => !ship.hits.includes(c));
  if (!open.length) return { effects: [], ...priv };

  const cell = open[randInt(rng, open.length)];
  return {
    effects: [{
      kind: 'selfHit',
      playerId: attacker.id,
      cell,
      shipType: ship.type,
      sinks: ship.hits.length + 1 >= ship.len,
    }],
    ...priv,
  };
}

/** Undo one hit. An undamaged fleet gets nothing — no effect, no error. */
function repair(attacker, logNote, rng) {
  const priv = { logNote, privateTo: attacker.id };
  const ship = pickShip(attacker, (s) => !s.sunk && s.hits.length > 0, rng);
  if (!ship) return { effects: [], ...priv };

  const cell = ship.hits[randInt(rng, ship.hits.length)];
  return {
    effects: [{ kind: 'heal', playerId: attacker.id, cell, shipType: ship.type }],
    ...priv,
  };
}

function radar(attacker, defender, cell, grid, terrainId, logNote) {
  const priv = { logNote, privateTo: attacker.id };
  if (!defender || !Number.isInteger(cell) || !grid) return { effects: [], ...priv };

  const { x, y } = toXY(cell, grid);
  const cells = [];
  for (let dy = -RADAR_RADIUS; dy <= RADAR_RADIUS; dy++) {
    for (let dx = -RADAR_RADIUS; dx <= RADAR_RADIUS; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= grid || ny < 0 || ny >= grid) continue; // clipped at the edges
      const c = toIndex(nx, ny, grid);
      if (isLand(terrainId, c, grid)) continue; // land can never hide a ship
      cells.push(c);
    }
  }

  return {
    effects: [{ kind: 'reveal', playerId: attacker.id, targetId: defender.id, cells }],
    ...priv,
  };
}

function pickShip(player, ok, rng) {
  const options = (player.ships ?? []).filter(ok);
  return options.length ? options[randInt(rng, options.length)] : null;
}

function findPlayer(room, id) {
  if (!room) return null;
  if (typeof room.byId === 'function') return room.byId(id);
  return (room.players ?? []).find((p) => p.id === id) ?? null;
}

function shipAtCell(player, cell) {
  if (!player || !Number.isInteger(cell)) return null;
  if (cell < 0 || cell >= (player.shipAt?.length ?? 0)) return null;
  const idx = player.shipAt[cell];
  return idx >= 0 ? (player.ships?.[idx] ?? null) : null;
}

/**
 * Apply one effect to real player state.
 *
 * Only the two that touch a fleet are ours. `reveal`, `extraShot` and `recharge` are the
 * Room's business — it owns sockets, turns and superpower charges — so they come back
 * false, which is the signal to the caller that it still has work to do.
 *
 * @returns true when this function handled the effect.
 */
export function applyEffect(effect, room) {
  if (!effect || !room) return false;

  switch (effect.kind) {
    case 'selfHit': {
      const victim = findPlayer(room, effect.playerId);
      const ship = shipAtCell(victim, effect.cell);
      if (!ship || ship.sunk) return false; // never re-shell a wreck
      // Same code path as an enemy shot, so the damage, the sunk flag and the defender's
      // own `incoming` all end up exactly as they would from a normal hit.
      const outcome = fireAt(victim, effect.cell);
      effect.sinks = outcome.result === 'sunk';
      return true;
    }

    case 'heal': {
      const owner = findPlayer(room, effect.playerId);
      const ship = shipAtCell(owner, effect.cell);
      // Refusing to heal a wreck keeps a sunk fleet sunk — un-sinking a ship would
      // resurrect an eliminated player mid-game.
      if (!ship || ship.sunk) return false;
      const i = ship.hits.indexOf(effect.cell);
      if (i < 0) return false; // nothing to undo
      ship.hits.splice(i, 1);
      owner.incoming[effect.cell] = SHOT.NONE; // the square opens back up for the enemy
      return true;
    }

    default:
      return false;
  }
}
