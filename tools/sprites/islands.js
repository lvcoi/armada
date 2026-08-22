// 16-variant island autotile set.
//
// `mask` says which orthogonal neighbours are ALSO land (N=1 E=2 S=4 W=8). Where a
// neighbour is land the tile runs flush to that edge so the two fuse; where it is water
// the tile grows an organic coastline inset from the edge — foam, sand, rock, canopy.
//
// Seamlessness is the whole trick, so it is engineered rather than eyeballed:
//
//   * Every open edge uses ONE profile per compass direction, built only from ODD
//     harmonics (sin πt, sin 3πt, sin 5πt). Odd harmonics are symmetric about t=0.5,
//     so inset(t) === inset(1-t) exactly — the last column of one tile and the first
//     column of its neighbour evaluate to the same number, to the bit.
//   * Every profile is anchored: all terms vanish at t=0 and t=1, so neighbouring
//     coastlines always meet at the same depth. No gaps, no doubled beach.
//   * The organic wobble comes from value noise that is PERIODIC over one tile, so it
//     tiles across the whole map as one continuous field instead of restarting per cell.
//   * Banding is driven purely by that signed distance field, so a flush edge (distance
//     = FAR) simply never grows sand or foam — interiors stay solid vegetation.
//
// Only the interior detail dabs are mask-seeded, and they are kept clear of the tile
// border so they can never be clipped by a neighbour.

import { Raster } from './raster.js';

const N = 1;
const E = 2;
const S = 4;
const W = 8;
const FAR = 1e6;

/* ---------------------------------------------------------------- palette ---- */
// Warm land against cold water: the sand band is the thing that makes an island read
// as an island on a near-black blue board, so it is the brightest note in the tile.
const INK = '#182730';
const FOAM_OUT = '#5fa9c8';
const FOAM_MID = '#b5e4f4';
const FOAM_IN = '#eafbff';
const SAND_WET = '#a97a4a';
const SAND = '#ddb374';
const SAND_HI = '#f4dfab';
const ROCK_DK = '#4c4739';
const ROCK = '#7d7460';
const ROCK_HI = '#9d937a';
const CANOPY = '#24563a';
const GRASS = '#3d8a42';
const GRASS_HI = '#63b755';
const GRASS_DK = '#2f6b38';
const TRUNK = '#7a4f2b';
const TRUNK_DK = '#3f2614';
const LEAF_DK = '#123a25'; // near-black green: the ink that makes a dab read as an object
const LEAF = '#2f7d3d';
const LEAF_HI = '#7ad063';
const STONE_DK = '#413b30';
const STONE = '#7f7561';
const STONE_HI = '#b3a68a';

/* ------------------------------------------------------------------ maths ---- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Value noise on a g x g lattice that WRAPS, so sampling u,v in [0,1) tiles perfectly.
 * Fixed seed: the field is map-global, identical in every tile, and continuous across
 * every tile boundary — which is exactly what keeps coastlines from stair-stepping.
 */
function periodicNoise(g, seed) {
  const rnd = mulberry32(seed);
  const v = new Float64Array(g * g);
  for (let i = 0; i < v.length; i++) v[i] = rnd();
  return (u, w) => {
    const gx = u * g;
    const gy = w * g;
    const i0 = Math.floor(gx);
    const j0 = Math.floor(gy);
    const fx = gx - i0;
    const fy = gy - j0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const ia = ((i0 % g) + g) % g;
    const ib = (ia + 1) % g;
    const ja = ((j0 % g) + g) % g;
    const jb = (ja + 1) % g;
    const top = v[ja * g + ia] + (v[ja * g + ib] - v[ja * g + ia]) * sx;
    const bot = v[jb * g + ia] + (v[jb * g + ib] - v[jb * g + ia]) * sx;
    return top + (bot - top) * sy;
  };
}

const SHORE_A = periodicNoise(4, 0x1a2b3c4d);
const SHORE_B = periodicNoise(8, 0x51ff00d5);
const TEX_A = periodicNoise(8, 0x2f9ab117);
const TEX_B = periodicNoise(16, 0x7c3e91a0);

/** -1..1, seamless across tiles. */
function shoreWobble(u, w) {
  return (SHORE_A(u, w) - 0.5) * 1.35 + (SHORE_B(u, w) - 0.5) * 0.65;
}

// Per-compass wobble, ODD harmonics only so each profile is symmetric about its middle.
// [amp(sin 3πt), amp(sin 5πt)] — index 0..3 is N, E, S, W.
const EDGE_WOBBLE = [
  [-0.62, 0.34],
  [0.48, 0.30],
  [-0.44, -0.36],
  [0.58, -0.26],
];

const BASE_INSET = 6.9; // depth of the coast at a tile corner, in 32px units
const BULGE = 3.6; // how far the middle of an edge pushes back out into the water
const CORNER_R = 6.0; // radius that rounds two open edges into each other

/** Depth of water-side inset along one open edge. t runs 0..1 across that edge. */
function coastInset(t, s, edge) {
  const [a3, a5] = EDGE_WOBBLE[edge];
  return (
    BASE_INSET * s
    - BULGE * s * Math.sin(Math.PI * t)
    - a3 * s * Math.sin(3 * Math.PI * t)
    - a5 * s * Math.sin(5 * Math.PI * t)
  );
}

/** Intersection of two half-planes with a rounded inside corner. */
function roundMin(a, b, r) {
  if (a >= r || b >= r) return a < b ? a : b;
  const u = r - a;
  const v = r - b;
  return r - Math.sqrt(u * u + v * v);
}

/**
 * Signed distance into the land, in pixels. >= 0 is land, negative is open water.
 * Flush edges contribute FAR, which is what makes interior tiles solid.
 */
function landField(mask, TILE, s) {
  const out = new Float32Array(TILE * TILE);
  const r = CORNER_R * s;
  const openN = !(mask & N);
  const openE = !(mask & E);
  const openS = !(mask & S);
  const openW = !(mask & W);

  for (let y = 0; y < TILE; y++) {
    const py = y + 0.5;
    const ty = py / TILE;
    const dW0 = openW ? coastInset(ty, s, 3) : 0;
    const dE0 = openE ? coastInset(ty, s, 1) : 0;
    for (let x = 0; x < TILE; x++) {
      const px = x + 0.5;
      const tx = px / TILE;
      const dN = openN ? py - coastInset(tx, s, 0) : FAR;
      const dS = openS ? TILE - py - coastInset(tx, s, 2) : FAR;
      const dW = openW ? px - dW0 : FAR;
      const dE = openE ? TILE - px - dE0 : FAR;
      const d = Math.min(
        roundMin(dN, dW, r),
        roundMin(dN, dE, r),
        roundMin(dS, dW, r),
        roundMin(dS, dE, r),
      );
      out[y * TILE + x] = d >= FAR ? FAR : d + shoreWobble(tx, ty) * 1.15 * s;
    }
  }
  return out;
}

/* ------------------------------------------------------------------- dabs ---- */

// Every dab is built the same way — near-black base, mid body, bright top-left cap.
// Three tones is the least that still reads as a solid object on top of the canopy.

function palm(r, x, y, k) {
  r.rect(x - k, y - 3 * k, 3 * k, 6 * k, TRUNK_DK); // trunk, inked
  r.rect(x - k, y - 3 * k, 2 * k, 5 * k, TRUNK);
  r.ellipse(x, y - 3.4 * k, 5 * k, 2.8 * k, LEAF_DK); // canopy shadow
  r.ellipse(x, y - 4.2 * k, 4.2 * k, 2.2 * k, LEAF);
  r.ellipse(x - 0.9 * k, y - 5 * k, 2.4 * k, 1.2 * k, LEAF_HI);
}

function bush(r, x, y, k, big) {
  const rx = (big ? 3.6 : 2.8) * k;
  const ry = (big ? 2.8 : 2.2) * k;
  r.ellipse(x, y, rx, ry, LEAF_DK);
  r.ellipse(x, y - 0.7 * k, rx * 0.86, ry * 0.82, LEAF);
  r.ellipse(x - 0.8 * k, y - 1.3 * k, rx * 0.5, ry * 0.42, LEAF_HI);
}

function boulder(r, x, y, k, big) {
  const rx = (big ? 2.8 : 2.0) * k;
  const ry = (big ? 2.1 : 1.6) * k;
  r.ellipse(x, y, rx, ry, INK);
  r.ellipse(x, y - 0.5 * k, rx * 0.88, ry * 0.82, STONE_DK);
  r.ellipse(x - 0.2 * k, y - 0.8 * k, rx * 0.66, ry * 0.6, STONE);
  r.ellipse(x - 0.7 * k, y - 1.1 * k, rx * 0.34, ry * 0.3, STONE_HI);
}

/* ------------------------------------------------------------------ paint ---- */

/**
 * Render one island autotile.
 * @param {number} mask bitmask of land neighbours: N=1, E=2, S=4, W=8 (0..15)
 * @param {number} TILE side length in device pixels (art is authored for 32)
 * @returns {Raster} TILE x TILE RGBA, transparent everywhere the tile is water
 */
export function drawIsland(mask, TILE = 32) {
  const m = mask & 15;
  const s = TILE / 32;
  const r = new Raster(TILE, TILE);
  const d = landField(m, TILE, s);

  // Band edges measured inward from the shoreline, in 32px units.
  const INK_D = 1.0 * s;
  const WET_D = 2.0 * s;
  const SAND_D = 3.9 * s;
  const ROCK_D = 5.3 * s;
  const CANOPY_D = 6.4 * s;
  const FOAM_1 = -1.25 * s;
  const FOAM_2 = -2.45 * s;

  for (let y = 0; y < TILE; y++) {
    const ty = (y + 0.5) / TILE;
    for (let x = 0; x < TILE; x++) {
      const tx = (x + 0.5) / TILE;
      const dv = d[y * TILE + x];
      const n1 = TEX_A(tx, ty);
      const n2 = TEX_B(tx, ty);

      if (dv < 0) {
        // Surf fringe. Kept translucent so the board's water still shows through.
        if (dv >= FOAM_1) {
          r.set(x, y, FOAM_IN, 0.88);
        } else if (dv >= FOAM_2) {
          r.set(x, y, n1 > 0.45 ? FOAM_MID : FOAM_OUT, 0.62);
        } else if (dv >= FOAM_2 - 1.2 * s && n2 > 0.58) {
          r.set(x, y, FOAM_OUT, 0.34);
        }
        continue;
      }

      if (dv < INK_D) {
        r.set(x, y, INK);
      } else if (dv < WET_D) {
        r.set(x, y, n1 > 0.62 ? SAND : SAND_WET);
      } else if (dv < SAND_D) {
        r.set(x, y, n2 > 0.66 ? SAND_HI : SAND);
      } else if (dv < ROCK_D) {
        r.set(x, y, n1 > 0.58 ? ROCK_HI : n1 < 0.34 ? ROCK_DK : ROCK);
      } else if (dv < CANOPY_D) {
        r.set(x, y, n2 > 0.7 ? GRASS_DK : CANOPY);
      } else {
        // Interior canopy. Texture is noise-only — never distance-driven past this
        // point, or flush edges (distance = FAR) would band differently to their
        // neighbours and draw a grid line straight down the seam.
        const t = n1 * 0.65 + n2 * 0.35;
        r.set(x, y, t > 0.62 ? GRASS_HI : t < 0.38 ? GRASS_DK : GRASS);
      }
    }
  }

  scatter(r, m, TILE, s, d);
  return r;
}

/**
 * Interior clutter. Seeded off the mask so the 16 variants differ from each other, and
 * off a constant so every rebuild is byte-identical. Dabs are held a full dab-width
 * away from the tile border, so a neighbour can never slice one in half.
 */
function scatter(r, mask, TILE, s, d) {
  const rnd = mulberry32((0x9e3779b9 ^ Math.imul(mask + 1, 0x85ebca6b)) >>> 0);
  // Dab geometry has a 1px floor, so below TILE=32 the dabs stop shrinking with the
  // tile. The keep-out border has to follow the dab size, not the scale, or a palm
  // crown spills over an open edge and puts land back on a water border.
  const k = Math.max(1, Math.round(s));
  const pad = Math.max(Math.round(7 * s), 7 * k);
  const span = TILE - pad * 2;
  if (span <= 0) return;
  const at = (x, y) => d[y * TILE + x];

  // Canopy dabs: only well inside the vegetation, so no tree ever straddles the beach.
  const spots = [];
  const want = 2 + Math.floor(rnd() * 3);
  for (let guard = 0; guard < 300 && spots.length < want; guard++) {
    const x = pad + Math.floor(rnd() * span);
    const y = pad + Math.floor(rnd() * span);
    if (at(x, y) < 8.0 * s) continue;
    let clear = true;
    for (const p of spots) {
      if (Math.abs(p.x - x) < 8 * s && Math.abs(p.y - y) < 7 * s) clear = false;
    }
    if (!clear) continue;
    spots.push({ x, y, kind: rnd() });
  }
  // Draw back-to-front so overlapping crowns stack the way a top-down view would.
  spots.sort((a, b) => a.y - b.y);
  for (const p of spots) {
    if (p.kind > 0.55) palm(r, p.x, p.y, k);
    else bush(r, p.x, p.y, k, p.kind > 0.26);
  }

  // A boulder or two out on the bright sand, where a dark stone actually shows.
  for (let guard = 0, placed = 0; guard < 220 && placed < 2; guard++) {
    const x = pad + Math.floor(rnd() * span);
    const y = pad + Math.floor(rnd() * span);
    const dv = at(x, y);
    if (dv < 2.4 * s || dv > 5.2 * s) continue;
    boulder(r, x, y, k, rnd() > 0.55);
    placed++;
  }
}

export default drawIsland;
