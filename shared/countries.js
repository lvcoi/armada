// The playable navies. Each is pinned to the era its fleet actually mattered, but the
// flag art is the modern one — this is a family game, not a history exam.
//
// Superpowers are all expressed as a SHAPE plus a per-strike cost, so the client only
// has to know how to preview four shapes rather than eight bespoke weapons.
//
//   block   w x h contiguous rectangle, anchored top-left
//   line    n cells in a straight line, horizontal or vertical
//   free    n cells chosen individually, anywhere on the target's board
//   scatter n cells chosen at random inside a w x h box
//
// Every superpower resolves as ordinary shots against ONE defender, so mines, power-ups
// and the redaction rules all keep working without special cases.

export const POWER_SHAPES = { BLOCK: 'block', LINE: 'line', FREE: 'free', SCATTER: 'scatter' };

/**
 * Every navy gets the SAME total firepower — 18 squares over the whole game — and the
 * only difference is the shape it arrives in. The US spends its 18 as two devastating
 * 3x3 blocks; Japan spends the same 18 one square at a time, as eighteen pilots it can
 * send in any number per turn. That keeps "which navy did you pick" a question of style
 * rather than strength.
 *
 * `volley` is what one strike costs. A navy's number of strikes is simply
 * POWER_BUDGET / volley, and every volley below divides 18 exactly.
 */
export const POWER_BUDGET = 18;

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
      blurb: 'Two 3\u00d73 blocks. Eighteen squares, delivered twice.',
      shape: POWER_SHAPES.BLOCK, w: 3, h: 3, volley: 9,
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
      blurb: 'Three in a line, six broadsides a game.',
      shape: POWER_SHAPES.LINE, n: 3, volley: 3,
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
      blurb: 'Eighteen pilots. Send as many as you like each turn \u2014 one square each.',
      shape: POWER_SHAPES.FREE, n: 1, volley: 1, flexible: true,
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
      blurb: 'Three squares anywhere, six times a game.',
      shape: POWER_SHAPES.FREE, n: 3, volley: 3,
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
      blurb: 'Six in a straight line, three times a game.',
      shape: POWER_SHAPES.LINE, n: 6, volley: 6,
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
      blurb: 'Six hits scattered inside a 3\u00d73 box, three times.',
      shape: POWER_SHAPES.SCATTER, w: 3, h: 3, n: 6, volley: 6,
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
      blurb: 'A two-square strike, nine times a game.',
      shape: POWER_SHAPES.BLOCK, w: 2, h: 1, volley: 2,
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
      blurb: 'A 3\u00d72 wall of fire, three times a game.',
      shape: POWER_SHAPES.BLOCK, w: 3, h: 2, volley: 6,
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
    if (!Array.isArray(picked)) return null;
    // A flexible power (Japan's pilots) lets you commit as many as you like in one
    // turn, so the cap is the budget you have left — the Room enforces that. A fixed
    // free-aim power takes exactly its volley.
    return power.flexible ? picked.slice() : picked.slice(0, power.n);
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
