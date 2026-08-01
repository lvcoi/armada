// Board effects: the five item icons, the hurricane loop, and the shell burst.
//
// These used to be hand-coded SVG glyphs and vector particles, which read as a
// different game to the chunky ships and islands sitting next to them. Everything here
// is authored with the same rules as ships.js: flat blocks, a hard top-left light, a
// 1px near-black ink border so the art separates from near-black water, and no detail
// finer than the smallest size it actually ships at.
//
// Three jobs, three techniques:
//
//   ICONS  — authored pixel-exact at 32 and nearest-neighbour resampled, like ships.js.
//            They appear twice: as a ~22px chip in the item tray and on the board when
//            radar reveals what is buried in a square. 22px is the real size, so every
//            icon is one bold silhouette with one unmistakable cue and nothing else:
//              mine     spiked sphere on a chain      (dark + threat red)
//              radar    scope face with a sweep wedge (HUD cyan + a phosphor blip)
//              extra    a pointed brass shell         (amber)
//              repair   a double open-end wrench      (green)
//              recharge a 3/4-view plank crate        (wood — never an X across it,
//                                                      an X reads as a sealed envelope)
//
//   STORM  — an analytic polar field, like flags.js is analytic in (w, h). The whole
//            hurricane is a function of SOURCE-space coordinates only, and frame N
//            samples that function through a -N*45deg rotation. That makes frame N
//            exactly frame 0 turned 45N degrees, so the eight frames loop with no seam
//            and no drift. Cloud density is posterised into five steps, which is what
//            keeps a smooth field looking like pixel art instead of an airbrush.
//
//   BOOM   — nested lobe clusters, drawn opaque outermost-first so overlapping shells
//            stay flat instead of muddying, then the finished frame's alpha channel is
//            scaled once for the fade. Frames are hand-tuned rather than interpolated:
//            0 is a small white ignition, 3-4 peak, 7 is nearly gone.
//
// Deterministic: every "random" number comes from a fixed-seed mulberry32 evaluated at
// module load, so two builds are byte-identical.

import { Raster } from './raster.js';

const ICON_BASE = 32; // icons and storm are authored per 32px board cell
const BOOM_BASE = 48; // the burst is authored 48 square

export const ICON_KINDS = ['mine', 'radar', 'extra', 'repair', 'recharge'];
export const STORM_FRAMES = 8;
export const BOOM_FRAMES = 8;

// ---------------------------------------------------------------------------
// palette — the CSS custom properties at the top of client/styles.css, plus the
// neutral ramps the icons need. Accents are used at full strength and only once per
// icon, so the tray reads as five different colours rather than five grey objects.
// ---------------------------------------------------------------------------

const INK = '#04090f';

const THREAT = '#ff5031';
const THREAT_HI = '#ffb59f';
const THREAT_DEEP = '#7e1f0c';
const HUD = '#5cc9ec';
const AMBER = '#ffb547';
const GOOD = '#3ddc97';
const PHOS = '#39f0c3';

// Cold steel, shared by the mine's horns and its chain.
const STEEL_HI = '#93a8b6';
const STEEL = '#5b6d7a';
const STEEL_DK = '#2b3843';
const STEEL_INK = '#0d151c';

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Wrapping value noise on a g x g lattice; u,v are taken modulo 1. */
function valueNoise(g, seed) {
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

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Nearest-neighbour resample — same contract as ships.js, exact output size. */
function resample(src, w, h) {
  const out = new Raster(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.h - 1, Math.floor((y * src.h) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.w - 1, Math.floor((x * src.w) / w));
      const si = (sy * src.w + sx) * 4;
      const di = (y * w + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

/** Scale the whole alpha channel. Used to fade a finished burst frame in one pass. */
function fade(r, f) {
  if (f >= 1) return r;
  for (let i = 3; i < r.data.length; i += 4) r.data[i] = Math.round(r.data[i] * f);
  return r;
}

/** Rows y0..y1 of a disc — a band that follows the sphere instead of cutting a slab. */
function discBand(r, cx, cy, rad, y0, y1, hex, a = 1) {
  for (let y = Math.round(y0); y <= Math.round(y1); y++) {
    const dy = (y - cy) / rad;
    if (Math.abs(dy) > 1) continue;
    const half = rad * Math.sqrt(1 - dy * dy);
    for (let x = Math.ceil(cx - half); x <= Math.floor(cx + half); x++) r.set(x, y, hex, a);
  }
}

/** Pie slice from a0 to a1 radians (0 = +x, negative = up). */
function wedge(r, cx, cy, rad, a0, a1, hex, a = 1) {
  const pts = [[cx, cy]];
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const t = a0 + ((a1 - a0) * i) / steps;
    pts.push([cx + Math.cos(t) * rad, cy + Math.sin(t) * rad]);
  }
  r.poly(pts, hex, a);
}

/**
 * A slice of an annulus, from a0 to a1 radians. Pixels are collected before they are
 * written: walking the arc hits the same pixel several times, and blending a
 * translucent colour onto itself would leave the curve mottled.
 */
function arc(r, cx, cy, rad, thick, a0, a1, hex, a = 1) {
  const steps = Math.max(8, Math.ceil(Math.abs(a1 - a0) * rad * 2.2));
  const seen = new Set();
  for (let i = 0; i <= steps; i++) {
    const t = a0 + ((a1 - a0) * i) / steps;
    const dx = Math.cos(t);
    const dy = Math.sin(t);
    for (let k = -thick / 2; k <= thick / 2; k += 0.5) {
      seen.add(`${Math.round(cx + dx * (rad + k))},${Math.round(cy + dy * (rad + k))}`);
    }
  }
  for (const key of seen) {
    const [x, y] = key.split(',');
    r.set(Number(x), Number(y), hex, a);
  }
}

// ---------------------------------------------------------------------------
// icons
// ---------------------------------------------------------------------------

/**
 * One tapered spike, measured in degrees clockwise from straight up. Drawn as three
 * stacked polygons — ink, body, lit edge — because a spike thinner than its own ink
 * border disappears at 22px, and a spike with no ink border merges into the sphere.
 */
function horn(r, cx, cy, deg, r0, r1, w0, w1) {
  const t = (deg * Math.PI) / 180;
  const dx = Math.sin(t);
  const dy = -Math.cos(t);
  const px = Math.cos(t);
  const py = Math.sin(t);

  const quad = (a0, a1, b0, b1) => [
    [cx + dx * a0 + px * b0, cy + dy * a0 + py * b0],
    [cx + dx * a0 - px * b0, cy + dy * a0 - py * b0],
    [cx + dx * a1 - px * b1, cy + dy * a1 - py * b1],
    [cx + dx * a1 + px * b1, cy + dy * a1 + py * b1],
  ];

  r.poly(quad(r0 - 1, r1 + 0.6, w0 + 0.8, w1 + 0.8), STEEL_INK);
  r.poly(quad(r0, r1, w0, w1), STEEL);

  // Lit edge on whichever flank faces up-left.
  const s = px + py < 0 ? 1 : -1;
  r.line(
    cx + dx * r0 + px * s * (w0 - 0.7), cy + dy * r0 + py * s * (w0 - 0.7),
    cx + dx * (r1 - 1) + px * s * (w1 - 0.3), cy + dy * (r1 - 1) + py * s * (w1 - 0.3),
    STEEL_HI,
  );

  // Threat-red cap. This is the whole reason a mine reads as dangerous at 22px, so it
  // is a blob rather than a pixel.
  const tx = cx + dx * (r1 - 1.4);
  const ty = cy + dy * (r1 - 1.4);
  r.ellipse(tx, ty, 1.9, 1.9, THREAT_DEEP);
  r.ellipse(tx, ty, 1.35, 1.35, THREAT);
  r.ellipse(tx - 0.5, ty - 0.5, 0.7, 0.7, THREAT_HI);
}

function drawMine(r) {
  const cx = 16;
  const cy = 15;
  const rad = 8.4;

  // Mooring chain: two links, wide then narrow, so it reads as chain and not as a peg.
  r.ellipse(cx, 25.2, 3.6, 2.4, STEEL_INK);
  r.ellipse(cx, 25.0, 3.0, 1.8, STEEL);
  r.ellipse(cx - 0.8, 24.4, 1.7, 0.9, STEEL_HI);
  r.ellipse(cx, 28.2, 2.4, 2.6, STEEL_INK);
  r.ellipse(cx, 28.0, 1.7, 2.0, STEEL_DK);
  r.ellipse(cx - 0.4, 27.4, 0.9, 0.9, '#6f8391');

  // Five horns at 60deg, leaving the bottom clear for the chain. Five chunky spikes
  // survive the downscale where eight thin ones turn into a fuzzy halo.
  for (const deg of [-120, -60, 0, 60, 120]) horn(r, cx, cy, deg, 5, 13, 2.1, 1.25);

  // Sphere. The lightest tone is the OUTER disc, so the casing keeps a rim of reflected
  // light on its lower right — without it a near-black ball on near-black water is a
  // hole rather than an object.
  r.ellipse(cx, cy, rad, rad, '#40525f');
  r.ellipse(cx - 0.6, cy - 0.8, rad - 0.9, rad - 0.9, '#101922');
  r.ellipse(cx - 1.4, cy - 1.8, rad - 2.6, rad - 2.6, '#243039');
  r.ellipse(cx - 2.6, cy - 3.1, rad - 4.8, rad - 4.8, '#3d4f5d');
  r.ellipse(cx - 3.5, cy - 3.9, 1.7, 1.5, '#93abbb');

  // Warning band just below the equator, clipped to the sphere so it curves.
  discBand(r, cx, cy, rad - 1.1, cy + 1, cy + 2, THREAT);
  discBand(r, cx, cy, rad - 1.1, cy + 3, cy + 3, THREAT_DEEP);

  // Filler cap on top of the casing.
  r.ellipse(cx - 0.5, cy - 6.2, 2.2, 1.4, '#0b1218');
  r.ellipse(cx - 0.5, cy - 6.4, 1.5, 0.9, '#4e6270');
}

function drawRadar(r) {
  const cx = 16;
  const cy = 16;

  // Bezel, then the scope face inside it: a flat 3px cyan ring is the one part
  // guaranteed to survive the downscale, so it carries the identity. Flat on purpose —
  // a lit highlight on the rim turns the whole thing into a glass marble.
  r.ellipse(cx, cy, 14, 14, '#1d5f7c');
  r.ellipse(cx, cy, 13.4, 13.4, HUD);
  r.ellipse(cx + 0.7, cy + 0.9, 13.4, 13.4, '#2b86ab');
  r.ellipse(cx, cy, 11.1, 11.1, '#04202e');

  // One range ring, no cross hairs: at 22px hairlines are dirt, not information.
  r.ellipse(cx, cy, 6.8, 6.8, '#0f4d64');
  r.ellipse(cx, cy, 5.9, 5.9, '#04202e');

  // Sweep: a decaying tail that ends in a near-white leading edge. The brightness ramp
  // across the wedge is what makes one still frame read as something rotating.
  const D = Math.PI / 180;
  const lead = -26 * D;
  wedge(r, cx, cy, 11, -128 * D, lead, '#0c536e');
  wedge(r, cx, cy, 11, -96 * D, lead, '#127a9c');
  wedge(r, cx, cy, 11, -68 * D, lead, '#2495bb');
  wedge(r, cx, cy, 11, -44 * D, lead, '#63cfef');
  wedge(r, cx, cy, 11, -30 * D, lead, '#b6efff');
  r.line(cx, cy, cx + Math.cos(lead) * 11.2, cy + Math.sin(lead) * 11.2, '#eafcff');

  // Contact blip, in phosphor green — the game's own radar colour, and the only
  // warm-side note on the icon, so the eye lands on it first.
  const bx = cx + Math.cos(-64 * D) * 7.2;
  const by = cy + Math.sin(-64 * D) * 7.2;
  r.ellipse(bx, by, 3.2, 3.2, '#0c6252');
  r.ellipse(bx, by, 2.1, 2.1, PHOS);
  r.ellipse(bx - 0.5, by - 0.5, 1.0, 1.0, '#dcfff4');

  // Hub.
  r.ellipse(cx, cy, 2.2, 2.2, '#07303f');
  r.ellipse(cx, cy, 1.4, 1.4, '#bdeeff');
}

function drawExtra(r) {
  const cx = 16;
  const TOP = 3; // nose tip
  const SHOULDER = 13; // where the ogive meets the case
  const BASE = 27; // top of the base rim
  const BOT = 29;
  const HB = 6; // case half-beam

  // Brass ramp across the barrel, left-lit. Sampled by fraction so the 2px-wide rows
  // near the tip still get a lit pixel and a shaded pixel.
  const CASE = ['#ffeec0', '#ffd583', AMBER, AMBER, '#e09a2e', '#a9631a', '#6d3c0c'];
  // The projectile is a different metal to the case; that seam is what says "shell"
  // rather than "bullet".
  const NOSE = ['#f3d6a6', '#e0ab63', '#c98a34', '#a86a22', '#7c4614', '#4e2a08'];

  const row = (y, half, ramp) => {
    const x0 = Math.round(cx - half);
    const x1 = Math.round(cx + half);
    const span = x1 - x0;
    for (let x = x0; x <= x1; x++) {
      const f = span === 0 ? 0 : (x - x0) / span;
      r.set(x, y, ramp[Math.round(f * (ramp.length - 1))]);
    }
  };

  // Ogive: a pure ellipse reads as a thumb, so the profile is a power curve pulled in
  // to a point.
  for (let y = TOP; y < SHOULDER; y++) {
    const t = (y - TOP + 0.5) / (SHOULDER - TOP);
    row(y, HB * Math.pow(t, 0.55), NOSE);
  }
  for (let y = SHOULDER; y < BASE; y++) row(y, HB, CASE);
  for (let y = BASE; y <= BOT; y++) row(y, HB + 1, CASE);

  // Case mouth: the projectile sits in the case, so there is a bright rim under the
  // shoulder and a dark seam above it.
  r.rect(cx - HB, SHOULDER - 1, HB * 2 + 1, 1, '#5e340c');
  row(SHOULDER, HB, ['#fff3d2', '#ffe09a', '#ffc667', '#ffb547', '#cf8a24', '#8f5312']);

  // Driving band + head stamp, two dark rings that stop the case looking like a tube.
  r.rect(cx - HB, 21, HB * 2 + 1, 1, '#8a5514');
  r.rect(cx - HB, 22, HB * 2 + 1, 1, '#5e340c');
  r.rect(cx - HB, BASE - 1, HB * 2 + 1, 1, '#5e340c');
  r.rect(cx - HB - 1, BOT, HB * 2 + 3, 1, '#4a2707');

  // Specular streak down the lit side of the case.
  r.rect(cx - HB + 1, SHOULDER + 2, 1, 8, '#fff1c9', 0.75);
}

function drawRepair(r) {
  // A double open-end wrench laid corner to corner. Built as a membership test in a
  // rotated frame rather than drawn and then rotated: a 45deg resample of pixel art
  // shreds the jaws, an analytic test keeps them crisp.
  const cx = 16;
  const cy = 16;
  const ca = Math.SQRT1_2; // cos(-45)
  const sa = -Math.SQRT1_2; // sin(-45)

  const HEADS = [
    { uh: 9.0, hu: 4.9, hv: 5.4, jaw: 2.5, dir: 1 },
    { uh: -9.2, hu: 4.1, hv: 4.5, jaw: 2.0, dir: -1 },
  ];

  const inside = new Uint8Array(ICON_BASE * ICON_BASE);
  for (let y = 0; y < ICON_BASE; y++) {
    for (let x = 0; x < ICON_BASE; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = dx * ca + dy * sa;
      const v = -dx * sa + dy * ca;

      let solid = Math.abs(u) <= 9.6 && Math.abs(v) <= 2.9;
      let cut = false;
      for (const h of HEADS) {
        const du = Math.abs((u - h.uh) / h.hu);
        const dv = Math.abs(v / h.hv);
        // Superellipse: a circle head looks like a lollipop, a rectangle looks like a
        // spanner from a flat-pack diagram. 2.6 lands between the two.
        if (du ** 2.6 + dv ** 2.6 <= 1) solid = true;
        const past = h.dir > 0 ? u - h.uh > -0.5 : u - h.uh < 0.5;
        if (past && Math.abs(v) <= h.jaw) cut = true;
      }
      if (solid && !cut) inside[y * ICON_BASE + x] = 1;
    }
  }

  const at = (x, y) => (x < 0 || y < 0 || x >= ICON_BASE || y >= ICON_BASE
    ? 0 : inside[y * ICON_BASE + x]);

  for (let y = 0; y < ICON_BASE; y++) {
    for (let x = 0; x < ICON_BASE; x++) {
      if (!at(x, y)) continue;
      const up = !at(x, y - 1);
      const dn = !at(x, y + 1);
      const lf = !at(x - 1, y);
      const rt = !at(x + 1, y);
      let col = '#2f9f74';
      if (dn || rt) col = '#125240';
      if (up || lf) col = '#a8ffd8';
      r.set(x, y, col);
    }
  }

  // A lit spine down the shaft so the middle of the tool is not a flat green slab.
  for (let y = 0; y < ICON_BASE; y++) {
    for (let x = 0; x < ICON_BASE; x++) {
      if (!at(x, y)) continue;
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = dx * ca + dy * sa;
      const v = -dx * sa + dy * ca;
      if (Math.abs(u) < 9.2 && v > -1.6 && v < 0.4 && at(x, y - 1) && at(x, y + 1)) {
        r.set(x, y, GOOD);
      }
    }
  }
}

function drawRecharge(r) {
  // Three-quarter view. A flat rectangle with plank lines is a door; the top face is
  // what makes it a box you could carry.
  const FX0 = 4;
  const FX1 = 23; // front face, inclusive
  const FY0 = 12;
  const FY1 = 28;
  const DEP = 6; // depth offset, up and to the right

  const WOOD = '#a9763a';
  const WOOD_HI = '#cf9a55';
  const WOOD_TOP = '#d7a769';
  const WOOD_SIDE = '#734c22';
  const SEAM = '#4a2f13';
  const SEAM_DK = '#33200c';
  const BATTEN = '#8a5c28';

  // Top face and right face first, so the front face draws over their shared edges.
  r.poly([[FX0, FY0], [FX0 + DEP, FY0 - DEP], [FX1 + DEP, FY0 - DEP], [FX1, FY0]], WOOD_TOP);
  r.poly([[FX1, FY0], [FX1 + DEP, FY0 - DEP], [FX1 + DEP, FY1 - DEP], [FX1, FY1]], WOOD_SIDE);

  // Top-face planks run the same way as the front planks, seen in perspective.
  for (const sx of [10, 17]) {
    r.line(sx, FY0, sx + DEP, FY0 - DEP, '#6b4620');
    r.line(sx + 1, FY0, sx + 1 + DEP, FY0 - DEP, '#e6bd82');
  }
  // Right-face plank seam, vertical like the front ones.
  r.line(FX1 + 3, FY0 - 3, FX1 + 3, FY1 - 3, SEAM_DK);
  r.line(FX1 + 4, FY0 - 4, FX1 + 4, FY1 - 4, '#8b5c29');

  r.rect(FX0, FY0, FX1 - FX0 + 1, FY1 - FY0 + 1, WOOD);

  // Vertical planks: a dark seam with a lit edge on its right, so each plank looks
  // like a separate board rather than a stripe.
  for (const sx of [10, 17]) {
    r.rect(sx, FY0, 1, FY1 - FY0 + 1, SEAM);
    r.rect(sx + 1, FY0, 1, FY1 - FY0 + 1, WOOD_HI);
  }

  // Battens across the top and bottom — the classic crate frame.
  r.rect(FX0, FY0, FX1 - FX0 + 1, 3, BATTEN);
  r.rect(FX0, FY0, FX1 - FX0 + 1, 1, '#e0b271');
  r.rect(FX0, FY0 + 3, FX1 - FX0 + 1, 1, SEAM_DK);
  r.rect(FX0, FY1 - 3, FX1 - FX0 + 1, 4, BATTEN);
  r.rect(FX0, FY1 - 3, FX1 - FX0 + 1, 1, '#d4a463');
  r.rect(FX0, FY1, FX1 - FX0 + 1, 1, SEAM_DK);

  // Corner posts, and a shaded right edge where the front meets the side face.
  r.rect(FX0, FY0, 2, FY1 - FY0 + 1, BATTEN);
  r.rect(FX0, FY0, 1, FY1 - FY0 + 1, '#c9954f');
  r.rect(FX1 - 1, FY0, 2, FY1 - FY0 + 1, '#8a5c28');
  r.rect(FX1, FY0, 1, FY1 - FY0 + 1, '#5c3a17');
}

const ICON_DRAW = {
  mine: drawMine,
  radar: drawRadar,
  extra: drawExtra,
  repair: drawRepair,
  recharge: drawRecharge,
};

/**
 * Draw one item icon.
 *
 * @param {'mine'|'radar'|'extra'|'repair'|'recharge'} kind
 * @param {number} TILE device pixels per board cell (art is authored at 32)
 * @returns {Raster} a TILE x TILE raster, transparent outside the icon
 */
export function drawIcon(kind, TILE) {
  const fn = ICON_DRAW[kind];
  if (!fn) throw new Error(`drawIcon: unknown icon kind "${kind}"`);

  const base = new Raster(ICON_BASE, ICON_BASE);
  fn(base);
  base.outline(INK, 0.95);

  const t = Math.max(1, Math.round(TILE));
  return t === ICON_BASE ? base : resample(base, t, t);
}

// ---------------------------------------------------------------------------
// storm
// ---------------------------------------------------------------------------

const STORM_N1 = valueNoise(9, 0x51057a11);
const STORM_N2 = valueNoise(19, 0x9c10ed42);

// Radii in 32px board-cell units, measured from the centre of the tile.
const EYE_R = 3.0; // clear air inside the eye
const WALL_R = 5.2; // outside of the eye wall, before the spiral hook is added
const CDO_R = 10.0; // outside of the solid central overcast
const ARM_R = 21.5; // where the last wisp of the outer rainbands dies
const TWIST = 3.0; // spiral tightness; higher wraps the arms further per turn

// Five posterised cloud steps, dimmest first. Alpha stays inside the window the board
// can still be read through; only the eye wall goes near-opaque.
const CLOUD = ['#6f92a8', '#93b4c8', '#bcd6e5', '#e6f3fa', '#ffffff'];
const CLOUD_A = [0.42, 0.53, 0.62, 0.69, 0.75];

/**
 * The hurricane as a field in fixed source space. Returns [hex, alpha] or null for
 * clear sky. Nothing in here depends on the frame — the frame is applied by rotating
 * the sample point, which is what guarantees the loop.
 *
 * Three zones, because a real cyclone is not one uniform disc and a uniform disc is
 * exactly what a single density function gives you: a clear eye, a near-solid central
 * overcast around it, and trailing rainbands with genuine holes between them. The holes
 * matter most — they are what makes it read as a spiral rather than as a cloud, and
 * they are what lets the player still see their own ships underneath.
 */
function stormSample(sx, sy) {
  const rr = Math.hypot(sx, sy);
  if (rr > ARM_R) return null;

  const th = Math.atan2(sy, sx);
  // Two-armed logarithmic spiral: constant phase traces theta = c - K*ln(r), so the
  // arms trail outward the way a cyclone's do.
  const phase = 2 * th + TWIST * Math.log(Math.max(rr, 1) / EYE_R);
  const arm = 0.5 + 0.5 * Math.cos(phase);

  // Eye: dark and deliberately thin, so ships underneath stay visible through it.
  if (rr < EYE_R) return ['#0a2231', 0.10 + (rr / EYE_R) * 0.16];

  // Eye wall. Its outer edge follows the spiral, so the ring hooks into the arms
  // instead of sitting inside the storm as a drawn-compass circle.
  const wallR = WALL_R + 1.3 * arm;
  if (rr < wallR) {
    const lit = 0.5 + 0.5 * arm;
    return [lit > 0.78 ? '#ffffff' : lit > 0.58 ? '#eaf6fc' : '#c6dcea', 0.86 + 0.09 * lit];
  }

  const n = STORM_N1(sx / 52 + 0.5, sy / 52 + 0.5) * 0.72
    + STORM_N2(sx / 52 + 0.5, sy / 52 + 0.5) * 0.28;

  // Central dense overcast: nearly solid, only lightly modulated by the arms.
  const cdo = clamp((CDO_R - rr) / 4.2, 0, 1);
  // Rainbands: raised to a power so the gaps between them open up wide.
  const fall = clamp((ARM_R - rr) / 11.0, 0, 1);
  const bands = fall * Math.pow(arm, 1.45);

  let d = Math.max(cdo * (0.74 + 0.26 * arm), bands) + 0.11 * (n - 0.5);
  if (d < 0.26) return null;

  d = clamp(d, 0, 1);
  const lvl = clamp(Math.floor((d - 0.26) * 6.2), 0, 4);
  return [CLOUD[lvl], CLOUD_A[lvl]];
}

/**
 * One frame of the hurricane loop.
 *
 * Frame N is frame 0 turned by exactly N * 360/STORM_FRAMES degrees, so the eight
 * frames cycle forever with no pop.
 *
 * @param {number} frame 0..STORM_FRAMES-1
 * @param {number} TILE  device pixels per board cell (art is authored at 32)
 * @returns {Raster} a TILE x TILE raster, transparent where the sky is clear
 */
export function drawStorm(frame, TILE) {
  const t = Math.max(1, Math.round(TILE));
  const r = new Raster(t, t);
  const s = t / ICON_BASE;
  const c = t / 2;

  const phi = (((frame % STORM_FRAMES) + STORM_FRAMES) % STORM_FRAMES)
    * ((Math.PI * 2) / STORM_FRAMES);
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);

  for (let y = 0; y < t; y++) {
    const dy = (y + 0.5 - c) / s;
    for (let x = 0; x < t; x++) {
      const dx = (x + 0.5 - c) / s;
      // Rotate the sample point back into source space: the field turns forward by phi.
      const sample = stormSample(dx * cp + dy * sp, -dx * sp + dy * cp);
      if (sample) r.set(x, y, sample[0], sample[1]);
    }
  }
  return r;
}

// ---------------------------------------------------------------------------
// boom
// ---------------------------------------------------------------------------

/** A ring of lobes at fixed angles with fixed jitter — the shape of every shell. */
function lobes(n, seed, dMin, dMax, sMin, sMax) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (rnd() - 0.5) * 0.95;
    out.push({
      a,
      d: dMin + rnd() * (dMax - dMin),
      s: sMin + rnd() * (sMax - sMin),
      q: rnd(),
    });
  }
  return out;
}

const FIRE_LOBES = lobes(10, 0x1f17e5, 0.26, 0.50, 0.34, 0.54);
const SMOKE_LOBES = lobes(8, 0x5c0a1e, 0.30, 0.58, 0.26, 0.42);

const EMBERS = (() => {
  const rnd = mulberry32(0xe3b1a7);
  const out = [];
  for (let i = 0; i < 16; i++) {
    out.push({
      a: (i / 16) * Math.PI * 2 + (rnd() - 0.5) * 0.7,
      spd: 0.55 + rnd() * 0.6,
      big: rnd() > 0.55,
      tone: Math.floor(rnd() * 3),
    });
  }
  return out;
})();

const EMBER_TONE = ['#fff6d0', '#ffd24a', '#ff8a1f'];
const SMOKE_TONE = ['#4b403a', '#2c2422', '#5d4f47'];

// Hot white core out to charred rim. Drawn outermost first, all opaque.
const SHELL = ['#2a0d06', '#a3260e', THREAT, '#ff8a1f', '#ffd24a', '#fff6d0', '#ffffff'];

// Per frame: outer radius, one scale per SHELL entry, smoke amount + radius, and the
// alpha the finished frame is faded to. Hand-tuned: 0 ignites, 3-4 peak, 7 is embers.
const BOOM_F = [
  { R: 8, k: [1.10, 1.00, 0.92, 0.80, 0.66, 0.48, 0.30], sm: 0.0, sR: 0, a: 1.0 },
  { R: 13, k: [1.08, 1.00, 0.90, 0.76, 0.60, 0.40, 0.22], sm: 0.0, sR: 0, a: 1.0 },
  { R: 17, k: [1.06, 1.00, 0.88, 0.72, 0.54, 0.32, 0.15], sm: 0.35, sR: 15, a: 1.0 },
  { R: 20, k: [1.05, 1.00, 0.86, 0.66, 0.46, 0.22, 0.0], sm: 0.6, sR: 18, a: 0.98 },
  { R: 21, k: [1.04, 1.00, 0.82, 0.58, 0.34, 0.10, 0.0], sm: 0.8, sR: 20, a: 0.92 },
  { R: 20, k: [1.02, 0.96, 0.74, 0.46, 0.20, 0.0, 0.0], sm: 1.0, sR: 21, a: 0.76 },
  { R: 17, k: [0.98, 0.86, 0.58, 0.28, 0.0, 0.0, 0.0], sm: 1.0, sR: 22, a: 0.50 },
  { R: 13, k: [0.92, 0.70, 0.34, 0.0, 0.0, 0.0, 0.0], sm: 1.0, sR: 21, a: 0.24 },
];

const EMBER_A = [0, 0.35, 0.9, 1.0, 1.0, 0.9, 0.62, 0.32];
const SHOCK_A = [0, 0.5, 0.34, 0.18, 0, 0, 0, 0];

/**
 * One shell of the burst: a central blob plus its ring of lobes, all one flat colour.
 * `spin` rotates the whole cluster a little per frame, so the fireball churns as it
 * grows instead of looking like one circle being scaled up.
 */
function shellPass(r, cx, cy, rad, list, hex, spin, tint) {
  if (rad <= 0.4) return;
  r.ellipse(cx, cy, rad * 0.62, rad * 0.60, hex);
  for (const L of list) {
    const a = L.a + spin;
    r.ellipse(
      cx + Math.cos(a) * L.d * rad,
      cy + Math.sin(a) * L.d * rad,
      L.s * rad,
      L.s * rad * 0.95,
      tint ? tint(L) : hex,
    );
  }
}

/**
 * One frame of the shell burst, played once.
 *
 * @param {number} frame 0..BOOM_FRAMES-1
 * @param {number} SIZE  side length in device pixels (art is authored at 48)
 * @returns {Raster} a SIZE x SIZE raster, transparent outside the blast
 */
export function drawBoom(frame, SIZE) {
  const n = clamp(Math.round(frame), 0, BOOM_FRAMES - 1);
  const f = BOOM_F[n];
  const px = Math.max(1, Math.round(SIZE));
  const r = new Raster(px, px);
  const s = px / BOOM_BASE;
  const c = px / 2;

  const spin = n * 0.23; // radians of churn per frame

  // Smoke first: it is the outer envelope, and the fireball covers whatever of it is
  // still burning.
  if (f.sm > 0) {
    shellPass(r, c, c, f.sR * s, SMOKE_LOBES, SMOKE_TONE[0], -spin * 1.6, (L) => SMOKE_TONE[
      L.q > 0.66 ? 2 : L.q > 0.33 ? 1 : 0
    ]);
  }

  // Fireball, outermost shell first so nothing has to blend.
  for (let i = 0; i < SHELL.length; i++) {
    shellPass(r, c, c, f.R * f.k[i] * s, FIRE_LOBES, SHELL[i], spin * (1 + i * 0.16));
  }

  // Ignition: frame 0 only, and short. A long cross through the middle of a fireball
  // plus a ring around it reads as a rifle scope, not as a shell going off.
  if (n === 0) {
    const len = f.R * 1.7 * s;
    const w = Math.max(1, Math.round(1.3 * s));
    r.rect(c - len, c - w / 2, len * 2, w, '#fff6d0', 0.7);
    r.rect(c - w / 2, c - len, w, len * 2, '#fff6d0', 0.7);
  }

  fade(r, f.a);

  // Blast front and embers ride on top of the fade with their own alpha. The front is
  // three broken arcs rather than a ring, for the same reason: closed circles around a
  // target read as UI. The embers outlive the fireball, which is what makes the tail of
  // the animation read as debris rather than as a dissolve.
  if (SHOCK_A[n] > 0) {
    for (const a0 of [-0.35, 1.9, 3.9]) {
      arc(r, c, c, f.R * 1.28 * s, Math.max(1, 1.4 * s), a0 + spin, a0 + spin + 1.15,
        '#ffe9a8', SHOCK_A[n]);
    }
  }
  if (EMBER_A[n] > 0) {
    const t = 0.18 + (n / (BOOM_FRAMES - 1)) * 0.95;
    for (const e of EMBERS) {
      const d = e.spd * 17 * t * s;
      const ex = c + Math.cos(e.a) * d;
      const ey = c + Math.sin(e.a) * d;
      const sz = Math.max(1, Math.round((e.big ? 2 : 1) * s));
      r.rect(ex - sz / 2, ey - sz / 2, sz, sz, EMBER_TONE[e.tone], EMBER_A[n]);
    }
  }

  return r;
}

export default drawIcon;
