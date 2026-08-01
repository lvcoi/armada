// The playable navies. Each is pinned to the era its fleet actually mattered, but the
// flag art is the modern one — this is a family game, not a history exam.
//
// Superpowers are all expressed as a SHAPE plus a number of uses, so the client only
// has to know how to preview eight shapes rather than eight bespoke weapons.
//
//   block   w x h contiguous rectangle, anchored top-left
//   line    n cells in a straight line, horizontal or vertical
//   free    n cells chosen individually, anywhere on the target's board
//   scatter n cells chosen at random inside a w x h box
//
// Every superpower resolves as ordinary shots against ONE defender, so mines, power-ups
// and the redaction rules all keep working without special cases.

export const POWER_SHAPES = { BLOCK: 'block', LINE: 'line', FREE: 'free', SCATTER: 'scatter' };

export const COUNTRIES = [
  {
    id: 'us',
    name: 'United States',
    short: 'USA',
    flag: 'us',
    era: '1943–45 · Pacific carrier war',
    accent: '#4b7bd4',
    power: {
      name: 'Nuclear Strike',
      blurb: 'Flattens a 3×3 block. One shot, one chance.',
      shape: POWER_SHAPES.BLOCK, w: 3, h: 3, uses: 1,
    },
  },
  {
    id: 'uk',
    name: 'United Kingdom',
    short: 'UK',
    flag: 'uk',
    era: '1805 · Trafalgar',
    accent: '#c8443a',
    power: {
      name: 'Broadside',
      blurb: 'Three shots in a line. Three broadsides a game.',
      shape: POWER_SHAPES.LINE, n: 3, uses: 3,
    },
  },
  {
    id: 'jp',
    name: 'Japan',
    short: 'Japan',
    flag: 'jp',
    era: '1905 · Tsushima',
    accent: '#e0555f',
    power: {
      name: 'Kamikaze',
      blurb: 'Nine squares, anywhere you like. Once only.',
      shape: POWER_SHAPES.FREE, n: 9, uses: 1,
    },
  },
  {
    id: 'de',
    name: 'Germany',
    short: 'Germany',
    flag: 'de',
    era: '1939–41 · U-boat wolfpacks',
    accent: '#d9a441',
    power: {
      name: 'Wolfpack',
      blurb: 'Four squares, anywhere. Twice a game.',
      shape: POWER_SHAPES.FREE, n: 4, uses: 2,
    },
  },
  {
    id: 'ru',
    name: 'Russia',
    short: 'Russia',
    flag: 'ru',
    era: '1970s · Cold War missile fleet',
    accent: '#5b8fd6',
    power: {
      name: 'Missile Salvo',
      blurb: 'Five in a straight line. Twice a game.',
      shape: POWER_SHAPES.LINE, n: 5, uses: 2,
    },
  },
  {
    id: 'cn',
    name: 'China',
    short: 'China',
    flag: 'cn',
    era: '1405–33 · Treasure fleet',
    accent: '#e2b23c',
    power: {
      name: 'Swarm',
      blurb: 'Five random hits inside a 3×3 box. Three times.',
      shape: POWER_SHAPES.SCATTER, w: 3, h: 3, n: 5, uses: 3,
    },
  },
  {
    id: 'ir',
    name: 'Iran',
    short: 'Iran',
    flag: 'ir',
    era: 'Modern · fast attack craft',
    accent: '#3fae74',
    power: {
      name: 'Fast Attack',
      blurb: 'A tight 2×2 strike. Three times a game.',
      shape: POWER_SHAPES.BLOCK, w: 2, h: 2, uses: 3,
    },
  },
  {
    id: 'es',
    name: 'Spain',
    short: 'Spain',
    flag: 'es',
    era: '1588 · The Armada',
    accent: '#d4763a',
    power: {
      name: 'Armada',
      blurb: 'A 3×2 wall of fire. Twice a game.',
      shape: POWER_SHAPES.BLOCK, w: 3, h: 2, uses: 2,
    },
  },
];

export const COUNTRY_IDS = COUNTRIES.map((c) => c.id);
export const byCountry = (id) => COUNTRIES.find((c) => c.id === id) ?? null;

/**
 * Which cells a power would hit, anchored at `anchor`. Returns null when the shape
 * runs off the board. `free` shapes have no geometry — the player picks each cell —
 * so they resolve to the cells they were given.
 */
export function powerCells(power, anchor, grid, picked = null) {
  const x0 = anchor % grid;
  const y0 = Math.floor(anchor / grid);

  if (power.shape === POWER_SHAPES.FREE) {
    return Array.isArray(picked) ? picked.slice(0, power.n) : null;
  }

  if (power.shape === POWER_SHAPES.LINE) {
    // Orientation rides along in `picked` ('h' or 'v') so the caller stays simple.
    const dir = picked === 'v' ? 'v' : 'h';
    const out = [];
    for (let i = 0; i < power.n; i++) {
      const x = dir === 'h' ? x0 + i : x0;
      const y = dir === 'v' ? y0 + i : y0;
      if (x >= grid || y >= grid) return null;
      out.push(y * grid + x);
    }
    return out;
  }

  // BLOCK and SCATTER both start from a rectangle.
  const out = [];
  for (let dy = 0; dy < power.h; dy++) {
    for (let dx = 0; dx < power.w; dx++) {
      const x = x0 + dx;
      const y = y0 + dy;
      if (x >= grid || y >= grid) return null;
      out.push(y * grid + x);
    }
  }
  return out;
}
