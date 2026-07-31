// Fleet placement rules. Imported by the server (authoritative) and by the client
// (to grey out illegal directions before the player commits) — same code, no duplication.

import { FLEET } from './constants.js';
import { shipCells, isCell } from './coords.js';
import { isLand } from './terrain.js';

/**
 * Validate a full fleet against the grid and terrain.
 * `ships` is [{ type, anchor, dir }] and must contain exactly one of each FLEET type.
 * Returns { ok, error?, ships? } where `ships` gains a resolved `cells` array.
 */
export function validateFleet(ships, terrainId, grid) {
  if (!Array.isArray(ships) || ships.length !== FLEET.length) {
    return { ok: false, error: 'fleet must contain exactly ' + FLEET.length + ' ships' };
  }

  const seen = new Set();
  const occupied = new Set();
  const resolved = [];

  for (const spec of ships) {
    const def = FLEET.find((f) => f.type === spec?.type);
    if (!def) return { ok: false, error: `unknown ship type: ${spec?.type}` };
    if (seen.has(def.type)) return { ok: false, error: `duplicate ship: ${def.type}` };
    seen.add(def.type);

    if (spec.dir !== 'h' && spec.dir !== 'v') {
      return { ok: false, error: `bad direction for ${def.type}` };
    }
    if (!isCell(spec.anchor, grid)) return { ok: false, error: `bad anchor for ${def.type}` };

    const cells = shipCells(spec.anchor, spec.dir, def.len, grid);
    if (!cells) return { ok: false, error: `${def.name} runs off the grid` };

    for (const c of cells) {
      if (isLand(terrainId, c, grid)) return { ok: false, error: `${def.name} overlaps land` };
      if (occupied.has(c)) return { ok: false, error: `${def.name} overlaps another ship` };
      occupied.add(c);
    }

    resolved.push({ type: def.type, len: def.len, anchor: spec.anchor, dir: spec.dir, cells });
  }

  return { ok: true, ships: resolved };
}

/** Can this single ship sit here, given cells already taken? */
export function canPlace(anchor, dir, len, terrainId, occupied, grid) {
  const cells = shipCells(anchor, dir, len, grid);
  if (!cells) return null;
  for (const c of cells) {
    if (isLand(terrainId, c, grid)) return null;
    if (occupied.has(c)) return null;
  }
  return cells;
}

/** Which of 'h'/'v' are legal from this anchor — drives the direction arrows in the UI. */
export function legalDirections(anchor, len, terrainId, occupied, grid) {
  return ['h', 'v'].filter((dir) => canPlace(anchor, dir, len, terrainId, occupied, grid) !== null);
}

/**
 * Generate a complete legal fleet. Longest ships first, with a retry budget —
 * on the layouts we ship this succeeds on the first attempt essentially always.
 */
export function randomFleet(terrainId, grid, rng = Math.random) {
  const cells = grid * grid;
  for (let attempt = 0; attempt < 200; attempt++) {
    const occupied = new Set();
    const ships = [];
    let stuck = false;

    for (const def of FLEET) {
      const options = [];
      for (let anchor = 0; anchor < cells; anchor++) {
        for (const dir of ['h', 'v']) {
          const spot = canPlace(anchor, dir, def.len, terrainId, occupied, grid);
          if (spot) options.push({ anchor, dir, cells: spot });
        }
      }
      if (!options.length) { stuck = true; break; }

      const pick = options[Math.floor(rng() * options.length)];
      pick.cells.forEach((c) => occupied.add(c));
      ships.push({ type: def.type, len: def.len, anchor: pick.anchor, dir: pick.dir, cells: pick.cells });
    }

    if (!stuck) return ships;
  }
  throw new Error(`could not place a fleet on terrain "${terrainId}" at grid ${grid}`);
}

/** Fill in whatever the player never placed — used when the placement timer expires. */
export function completeFleet(partial, terrainId, grid, rng = Math.random) {
  const cells = grid * grid;
  const kept = [];
  const occupied = new Set();

  for (const spec of partial ?? []) {
    const def = FLEET.find((f) => f.type === spec?.type);
    if (!def || kept.some((k) => k.type === def.type)) continue;
    const spot = canPlace(spec.anchor, spec.dir, def.len, terrainId, occupied, grid);
    if (!spot) continue;
    spot.forEach((c) => occupied.add(c));
    kept.push({ type: def.type, len: def.len, anchor: spec.anchor, dir: spec.dir, cells: spot });
  }

  for (const def of FLEET) {
    if (kept.some((k) => k.type === def.type)) continue;
    const options = [];
    for (let anchor = 0; anchor < cells; anchor++) {
      for (const dir of ['h', 'v']) {
        const spot = canPlace(anchor, dir, def.len, terrainId, occupied, grid);
        if (spot) options.push({ anchor, dir, cells: spot });
      }
    }
    if (!options.length) return randomFleet(terrainId, grid, rng); // start over rather than ship a partial fleet
    const pick = options[Math.floor(rng() * options.length)];
    pick.cells.forEach((c) => occupied.add(c));
    kept.push({ type: def.type, len: def.len, anchor: pick.anchor, dir: pick.dir, cells: pick.cells });
  }

  return FLEET.map((def) => kept.find((k) => k.type === def.type));
}
