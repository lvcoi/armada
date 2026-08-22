// Top-down warship sprites, authored at TILE = 32 device pixels per board cell.
//
// Every ship is drawn bow-RIGHT (+x) in a (len * TILE) x TILE raster; the client
// rotates the sprite 90deg in CSS for vertical placement. The board underneath is
// near-black blue water, so hulls are light cool grey with a very dark ink outline
// and a hard top-left light source: lit edge along the top, shadow along the bottom.
//
// The five classes have to be told apart at a glance on a phone, so each one leans on
// one unmistakable silhouette cue:
//   carrier    - full-length flat deck, port sponson bulge, starboard island
//   battleship - broad hull, three big barbettes with twin barrels, pagoda bridge
//   cruiser    - slimmer, two small turrets, one funnel, a mast you can see
//   submarine  - dark cigar, no turrets, sail with fairwater planes, awash in foam
//   destroyer  - tiny needle bow, one turret, one funnel, torpedo tubes amidships
//
// Deterministic: the only "randomness" is a fixed-seed mulberry32 used for deck grain,
// so two builds are byte-identical.

import { Raster } from './raster.js';

const BASE = 32; // authoring tile size

// ---------------------------------------------------------------------------
// palette
// ---------------------------------------------------------------------------

const INK = '#04090f';

const P = {
  wetT: '#9db2c0', // wet hull side, lit
  hi: '#e8f0f5', // deck edge highlight (top-left light)
  lt: '#c6d4dd',
  deck: '#8b9ba7',
  md: '#71818d',
  sh: '#57666f',
  dk: '#3f4d57',
  wetB: '#26333d', // waterline band in shadow
  steel: '#4b5a66',
  dark: '#232e37',
  black: '#141c23',
  white: '#f4f9fb', // deck markings
  glass: '#7fd8c8', // bridge windows, the one warm-ish accent
};

// Hull cross-section ramp, top -> bottom. Columns of any height sample this evenly,
// so a 2px bow tip still gets a lit top pixel and a dark bottom pixel.
const RAMP = [
  P.wetT, P.hi, P.lt, P.deck, P.deck, P.deck, P.deck, P.deck, P.deck, P.deck,
  P.deck, P.deck, P.deck, P.deck, P.deck, P.md, P.md, P.sh, P.dk, P.wetB,
];

// Submarine: same shape language, much darker, so it reads as sitting lower.
const SUB_RAMP = [
  '#4e6272', '#708595', '#4b5d6c', '#3b4854', '#3b4854', '#3b4854', '#374450', '#374450',
  '#33404b', '#33404b', '#2f3b46', '#2f3b46', '#2a3540', '#2a3540', '#26303a', '#212a33',
  '#1c242c', '#171e25', '#12181e', '#0d1319',
];

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

/**
 * Per-column half-beam for a hull: an array of { x, top, bot } rows to fill.
 * Bow is at the +x end. `bowExp` > 1 gives a concave needle bow, < 1 a full bluff bow.
 */
function hullProfile(W, o) {
  const {
    hb,
    bowLen,
    bowExp = 1,
    sternLen = 6,
    sternFrac = 0.85,
    sternRound = false,
    x0 = 2,
    x1 = W - 3,
    cy = BASE / 2,
    minH = 1.35, // columns thinner than this are dropped: a 1px whisker bow looks broken
  } = o;

  const cols = [];
  for (let x = x0; x <= x1; x++) {
    let h = hb;
    const fromBow = x1 - x;
    const fromStern = x - x0;

    if (fromBow < bowLen) {
      const t = (fromBow + 0.5) / bowLen;
      h = Math.min(h, hb * Math.pow(t, bowExp));
    }
    if (fromStern < sternLen) {
      const t = (fromStern + 0.5) / sternLen;
      const s = sternRound
        ? Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)))
        : sternFrac + (1 - sternFrac) * t;
      h = Math.min(h, hb * s);
    }
    if (h < minH) continue;

    const top = Math.round(cy - h);
    const bot = Math.round(cy + h) - 1;
    if (bot < top) continue;
    cols.push({ x, top, bot });
  }
  return cols;
}

/** Fill a profile with the cross-section ramp, then add deck plating + grain. */
function paintHull(r, cols, opt = {}) {
  const ramp = opt.ramp || RAMP;
  const deck = opt.deck || null; // override for the mid-band (flight deck etc.)
  const last = ramp.length - 1;

  for (const c of cols) {
    const span = c.bot - c.top;
    for (let y = c.top; y <= c.bot; y++) {
      const f = span === 0 ? 0 : (y - c.top) / span;
      const i = Math.round(f * last);
      let col = ramp[i];
      if (deck && col === P.deck) col = deck;
      r.set(c.x, y, col);
    }
  }

  // Deck plating: transverse seams plus two longitudinal seams inside the edges.
  const seam = opt.seam ?? 0.14;
  if (seam > 0) {
    for (const c of cols) {
      if (c.bot - c.top < 7) continue;
      if (c.x % 9 === 0) {
        for (let y = c.top + 3; y <= c.bot - 4; y++) r.set(c.x, y, P.dk, seam);
      }
      r.set(c.x, c.top + 3, P.dk, seam * 0.8);
      r.set(c.x, c.bot - 4, P.dk, seam * 0.8);
    }
  }

  // Fixed-seed grain so plating does not look like flat vinyl.
  const rnd = mulberry32(opt.seed ?? 0x5eed);
  for (const c of cols) {
    for (let y = c.top + 2; y <= c.bot - 3; y++) {
      const v = rnd();
      if (v < 0.05) r.set(c.x, y, P.dk, 0.16);
      else if (v > 0.965) r.set(c.x, y, P.hi, 0.14);
    }
  }
}

/**
 * Superstructure box. r.outline() only inks the outside of the whole sprite, so every
 * deck feature carries its own 1px dark border or it dissolves into the deck.
 */
function box(r, x, y, w, h, base = P.lt) {
  r.rect(x - 1, y - 1, w + 2, h + 2, P.black, 0.9);
  r.rect(x, y, w, h, base);
  r.rect(x, y, w, 1, P.hi);
  r.rect(x, y + h - 1, w, 1, P.dk);
  r.rect(x, y + 1, 1, h - 2, P.hi);
  r.rect(x + w - 1, y + 1, 1, h - 2, P.sh);
}

/** Circular barbette + turret face + twin barrels pointing along `dir` (+1 = bow). */
function turret(r, cx, cy, rad, barrel, dir = 1) {
  r.ellipse(cx, cy, rad + 2, rad + 2, P.black, 0.9); // ink ring
  r.ellipse(cx, cy, rad + 1.2, rad + 1.2, P.sh); // barbette
  r.ellipse(cx, cy, rad, rad, P.md); // turret face
  r.ellipse(cx - 0.6, cy - 0.9, rad - 1.2, rad - 1.2, P.lt);
  r.ellipse(cx - rad * 0.35, cy - rad * 0.45, rad * 0.42, rad * 0.36, P.hi); // lit corner

  // Barrels last, so they sit on top of the turret face and read as guns. No ink box
  // around them: at 2px apart the borders would merge into one dark slab.
  const off = 2;
  const len = Math.round(rad + barrel);
  const bx = dir > 0 ? cx : cx - len;
  for (const by of [cy - off - 1, cy + off - 1]) {
    r.rect(bx, by, len, 2, P.black);
    r.rect(bx, by, len, 1, P.dark);
    r.rect(dir > 0 ? bx + len - 1 : bx, by, 1, 2, P.black);
  }
}

/** Funnel: dark oval with a lit rim — the easiest thing to read from directly above. */
function funnel(r, cx, cy, rx, ry) {
  r.ellipse(cx, cy, rx + 2.2, ry + 2.2, P.black, 0.9);
  r.ellipse(cx, cy, rx + 1.4, ry + 1.4, P.lt);
  r.ellipse(cx + 0.4, cy + 0.6, rx + 1.4, ry + 1.4, P.sh);
  r.ellipse(cx, cy, rx, ry, P.dark);
  r.ellipse(cx, cy + 0.3, rx - 1.1, ry - 1.1, P.black);
}

/** Mast: a yard laid across the beam with a small light platform at the step. */
function mast(r, cx, cy, span) {
  r.rect(cx - 2, cy - span - 1, 4, span * 2 + 3, P.black, 0.8);
  r.rect(cx - 1, cy - span, 2, span * 2 + 1, P.steel);
  r.rect(cx - 1, cy - span, 2, 1, P.lt);
  r.rect(cx - 3, cy - 2, 6, 5, P.lt);
  r.rect(cx - 3, cy - 2, 6, 1, P.hi);
  r.rect(cx - 1, cy - 1, 2, 3, P.dark);
}

/**
 * Parked aircraft, nose +x. Built in its own little raster so r.outline() can ink the
 * whole silhouette, then blitted onto the deck. The wing sits well forward of centre
 * and the fuselage is half again as long as the span — keep that ratio or it reads as
 * the letter H rather than an aeroplane.
 */
function plane(r, cx, cy, body = '#e3ecf2') {
  const p = new Raster(17, 11); // 1px margin all round so outline() has somewhere to go
  p.rect(1, 4, 14, 3, body); // fuselage
  p.rect(8, 1, 3, 9, body); // main wing, forward of centre
  p.rect(1, 3, 2, 5, body); // tailplane
  p.rect(8, 1, 3, 1, P.hi); // lit leading edge
  p.rect(8, 9, 3, 1, P.sh);
  p.rect(12, 4, 2, 1, P.dark); // canopy
  p.set(14, 5, P.steel); // spinner
  p.outline(P.black, 0.85);
  r.blit(p, Math.round(cx) - 8, Math.round(cy) - 5);
}

// ---------------------------------------------------------------------------
// classes
// ---------------------------------------------------------------------------

function drawCarrier(r, W) {
  const cy = BASE / 2;
  const FLIGHT = '#4f5d69';

  const cols = hullProfile(W, {
    hb: 9,
    bowLen: W * 0.085,
    bowExp: 0.35,
    sternLen: 4,
    sternFrac: 0.94,
  });

  // Port-side angled-deck sponson: the deck bulges 3px past the hull amidships.
  const a = W * 0.26;
  const b = W * 0.82;
  for (const c of cols) {
    const f = (c.x - a) / (b - a);
    if (f < 0 || f > 1) continue;
    const ramp = Math.min(1, Math.min(f, 1 - f) * 7);
    c.top -= Math.round(3 * ramp);
  }
  // Starboard sponson under the island.
  const isX = Math.round(W * 0.57);
  const isW = Math.max(14, Math.round(W * 0.1));
  for (const c of cols) {
    if (c.x >= isX - 1 && c.x <= isX + isW) c.bot += 3;
  }

  paintHull(r, cols, { deck: FLIGHT, seam: 0.1, seed: 0xa17c });

  const bottomOf = (x) => {
    const c = cols.find((k) => k.x === Math.round(x));
    return c ? c.bot : cy + 9;
  };
  const topOf = (x) => {
    const c = cols.find((k) => k.x === Math.round(x));
    return c ? c.top : cy - 9;
  };

  // ---- deck markings -------------------------------------------------------
  const W1 = P.white;

  // Angled landing strip: two solid rails and a fat dashed centreline running from
  // the aft-starboard quarter up to the port bow. This crossing pattern is the single
  // clearest "this is a carrier" cue from directly above.
  const ax0 = Math.round(W * 0.08);
  const ax1 = Math.round(W * 0.62);
  const ay0 = cy + 5;
  const ay1 = cy - 4;
  for (let x = ax0; x <= ax1; x++) {
    const t = (x - ax0) / (ax1 - ax0);
    const y = Math.round(ay0 + (ay1 - ay0) * t);
    // darker asphalt inside the rails so the runway reads as a strip, not stray marks
    for (let yy = y - 4; yy <= y + 4; yy++) r.set(x, yy, '#2b3540', 0.55);
    r.set(x, y - 5, W1, 0.75);
    r.set(x, y + 5, W1, 0.75);
    if (x % 12 < 7) {
      r.set(x, y, W1, 0.95);
      r.set(x, y + 1, W1, 0.95);
    }
  }
  // Piano keys across the aft threshold.
  for (let i = 0; i < 4; i++) {
    const x = ax0 + 1 + i * 3;
    for (let y = ay0 - 4; y <= ay0 + 4; y++) r.set(x, y, W1, 0.8);
  }

  // Bow catapult track along the port side.
  for (let x = Math.round(W * 0.64); x < W * 0.93; x++) {
    if (x % 10 < 6) {
      r.set(x, cy - 4, W1, 0.9);
      r.set(x, cy - 3, W1, 0.5);
    }
  }

  // Deck edge elevators (light plates notching the deck edge).
  const elevator = (ex, ey, ew, eh) => {
    r.rect(ex - 1, ey - 1, ew + 2, eh + 2, P.black, 0.75);
    r.rect(ex, ey, ew, eh, '#8395a1');
    r.rect(ex, ey, ew, 1, P.hi);
    r.rect(ex, ey + eh - 1, ew, 1, P.dk);
  };
  elevator(Math.round(W * 0.3), bottomOf(W * 0.3) - 4, Math.round(W * 0.1), 5);
  elevator(Math.round(W * 0.68), topOf(W * 0.7) + 1, Math.round(W * 0.09), 5);

  // ---- parked aircraft -----------------------------------------------------
  // Forward deck park only: the aft half is the landing area and stays clear.
  plane(r, Math.round(W * 0.74), cy + 3);
  plane(r, Math.round(W * 0.87), cy + 3);

  // ---- island (starboard) --------------------------------------------------
  const isY = cy + 2;
  const isH = 9;
  box(r, isX, isY, isW, isH, P.md);
  r.rect(isX + 1, isY + 2, isW - 2, 2, P.glass, 0.75); // bridge windows
  r.rect(isX + 1, isY + 5, isW - 2, 1, P.dk); // deck seam
  funnel(r, isX + isW - 5, isY + isH - 4, 1.6, 1.6);
  r.rect(isX + 2, isY + 6, 2, 2, P.dark); // lattice mast
}

function drawBattleship(r, W) {
  const cy = BASE / 2;
  const cols = hullProfile(W, {
    hb: 10,
    bowLen: W * 0.15,
    bowExp: 0.6,
    sternLen: 7,
    sternFrac: 0.86,
  });
  paintHull(r, cols, { seed: 0xb417 });

  const u = (f) => Math.round(W * f);

  // Stern quarterdeck plate.
  r.rect(u(0.03), cy - 4, u(0.05), 9, P.sh);
  r.rect(u(0.03), cy - 4, u(0.05), 1, P.lt);

  // Aft turret, trained aft.
  turret(r, u(0.155), cy, 6.5, Math.round(W * 0.075), -1);

  // Aft deckhouse + funnel.
  box(r, u(0.23), cy - 5, u(0.06), 11, P.md);
  funnel(r, u(0.36), cy, 4.5, 6);

  // Pagoda bridge tower: nested plates read as height from directly above.
  const bx = u(0.42);
  const bw = Math.max(12, u(0.12));
  box(r, bx, cy - 7, bw, 15, P.md);
  box(r, bx + 2, cy - 5, bw - 4, 11, P.lt);
  r.rect(bx + 3, cy - 4, bw - 6, 2, P.glass, 0.7);
  box(r, bx + 4, cy - 3, bw - 8, 7, P.hi);
  r.rect(bx + 5, cy - 1, bw - 10, 2, P.dark); // director cap

  // Forward turrets, superfiring, both trained forward.
  turret(r, u(0.6), cy, 6.5, Math.round(W * 0.055), 1);
  turret(r, u(0.78), cy, 6, Math.round(W * 0.095), 1);

  // Anchor deck detail at the bow.
  r.set(u(0.92), cy - 2, P.dark);
  r.set(u(0.92), cy + 2, P.dark);

  // Secondary AA tubs down both sides amidships.
  for (const f of [0.29, 0.33, 0.47, 0.52]) {
    const x = u(f);
    const c = cols.find((k) => k.x === x);
    if (!c) continue;
    r.ellipse(x, c.top + 2, 1.7, 1.7, P.black, 0.8);
    r.ellipse(x, c.top + 2, 1.1, 1.1, P.lt);
    r.ellipse(x, c.bot - 2, 1.7, 1.7, P.black, 0.8);
    r.ellipse(x, c.bot - 2, 1.1, 1.1, P.md);
  }
}

function drawCruiser(r, W) {
  const cy = BASE / 2;
  const cols = hullProfile(W, {
    hb: 8,
    bowLen: W * 0.19,
    bowExp: 0.72,
    sternLen: 6,
    sternFrac: 0.74,
  });
  paintHull(r, cols, { seed: 0xc0de });

  const u = (f) => Math.round(W * f);

  // Aft turret, trained aft.
  turret(r, u(0.19), cy, 5, Math.round(W * 0.085), -1);

  // Aft deckhouse, funnel, bridge.
  box(r, u(0.28), cy - 4, u(0.055), 9, P.md);
  funnel(r, u(0.44), cy, 4, 5.5);
  const bx = u(0.55);
  const bw = Math.max(9, u(0.11));
  box(r, bx, cy - 5, bw, 11, P.md);
  box(r, bx + 2, cy - 3, bw - 4, 7, P.lt);
  r.rect(bx + 2, cy - 2, bw - 4, 2, P.glass, 0.65);

  // Tripod mast between funnel and bridge — the cruiser's signature.
  mast(r, u(0.51), cy, 7);

  // Forward turret, trained forward.
  turret(r, u(0.72), cy, 5, Math.round(W * 0.085), 1);

  // Side boat davits.
  for (const f of [0.33, 0.38]) {
    const x = u(f);
    const c = cols.find((k) => k.x === x);
    if (!c) continue;
    r.rect(x - 1, c.top + 1, 3, 3, P.black, 0.8);
    r.rect(x, c.top + 2, 2, 2, P.lt);
    r.rect(x - 1, c.bot - 3, 3, 3, P.black, 0.8);
    r.rect(x, c.bot - 3, 2, 2, P.md);
  }
}

function drawSubmarine(r, W) {
  const cy = BASE / 2;
  const cols = hullProfile(W, {
    hb: 7,
    bowLen: W * 0.22,
    bowExp: 0.5,
    sternLen: Math.round(W * 0.12),
    sternRound: true,
  });
  paintHull(r, cols, { ramp: SUB_RAMP, seam: 0.08, seed: 0x5ba1 });

  const u = (f) => Math.round(W * f);

  // Deck casing: a slightly lighter spine down the axis.
  for (const c of cols) {
    if (c.bot - c.top < 6) continue;
    r.set(c.x, cy - 1, '#5c6f7d', 0.5);
    r.set(c.x, cy, '#52646f', 0.5);
  }

  // Sail / conning tower amidships — the one part well clear of the water, so it is
  // the lightest thing on the sprite and carries its own ink border.
  const sx = u(0.44);
  const sail = (dx, dy, hx, hy) => [
    [sx - hx, cy - hy + dy], [sx + hx - 2, cy - hy + dy], [sx + hx + dx, cy + dy],
    [sx + hx - 2, cy + hy + dy], [sx - hx, cy + hy + dy], [sx - hx - 1, cy + dy],
  ];
  r.poly(sail(2, 0, 9, 6), P.black, 0.9);
  r.poly(sail(1, 0, 8, 5), '#5d7080');
  r.poly(sail(1, -1, 7, 3), '#8398a7');
  r.rect(sx - 6, cy - 3, 11, 1, '#a2b6c3'); // lit top edge
  r.rect(sx + 4, cy - 1, 2, 3, P.black); // periscope
  r.rect(sx - 4, cy, 4, 1, P.dark, 0.8);

  // Fairwater planes: tabs breaking the silhouette either side of the sail.
  r.rect(sx - 3, cy - 10, 7, 5, '#4b5c68');
  r.rect(sx - 3, cy - 10, 7, 1, '#7f94a2');
  r.rect(sx - 3, cy + 6, 7, 5, '#33404b');
  r.rect(sx - 3, cy + 10, 7, 1, '#1d262e');

  // Stern planes / rudder tabs.
  r.rect(u(0.06), cy - 10, 5, 4, '#4a5b67');
  r.rect(u(0.06), cy - 10, 5, 1, '#768996');
  r.rect(u(0.06), cy + 7, 5, 4, '#2f3b45');
  r.rect(u(0.06), cy + 10, 5, 1, '#1d262e');

  // Awash: one soft, wavy water band draped across the hull fore and aft of the sail.
  for (const c of cols) {
    for (const [c0, w0] of [[u(0.17), W * 0.1], [u(0.73), W * 0.09]]) {
      const d = Math.abs(c.x - c0) / w0;
      if (d >= 1) continue;
      const a = 0.34 * (1 - d * d);
      const wob = Math.round(Math.sin(c.x * 0.7) * 1.5);
      for (let y = c.top + 1 + wob; y <= c.bot - 1 + wob; y++) r.set(c.x, y, '#0a2f45', a);
    }
  }

  r.outline(INK, 0.95);

  // Foam goes on AFTER the ink pass so it does not get outlined into a halo. Scattered
  // with a fixed seed — an even dash pattern reads as a selection marquee, not water.
  const foam = '#cdeef8';
  const rnd = mulberry32(0xf0a3);
  for (const c of cols) {
    const nearEnd = Math.min(c.x - cols[0].x, cols[cols.length - 1].x - c.x) < W * 0.3;
    const p = nearEnd ? 0.5 : 0.18;
    if (rnd() < p) r.set(c.x, c.top - 1, foam, 0.1 + rnd() * 0.16);
    if (rnd() < p) r.set(c.x, c.bot + 1, foam, 0.08 + rnd() * 0.12);
    if (rnd() < p * 0.4) r.set(c.x, c.top - 2, foam, 0.08);
  }
  // Bow wave chevrons.
  const bx = cols[cols.length - 1].x;
  for (let i = 1; i <= 5; i++) {
    r.set(bx - i * 2, cy - 3 - i, foam, 0.2);
    r.set(bx - i * 2 - 1, cy - 3 - i, foam, 0.12);
    r.set(bx - i * 2, cy + 3 + i, foam, 0.16);
  }
  return true; // already inked
}

function drawDestroyer(r, W) {
  const cy = BASE / 2;
  const cols = hullProfile(W, {
    hb: 7,
    bowLen: W * 0.26,
    bowExp: 0.85,
    sternLen: 5,
    sternFrac: 0.66,
  });
  paintHull(r, cols, { seed: 0xd357, seam: 0.1 });

  const u = (f) => Math.round(W * f);

  // Depth charge racks at the transom.
  for (const s of [-1, 1]) {
    r.rect(u(0.04), cy + s * 4 - 1, 4, 3, P.black, 0.85);
    r.rect(u(0.04) + 1, cy + s * 4, 3, 2, P.dark);
  }

  // Torpedo tubes amidships: a mount with three tubes trained across the beam.
  const tx = u(0.22);
  r.rect(tx - 6, cy - 7, 12, 15, P.black, 0.85);
  r.rect(tx - 5, cy - 6, 10, 13, P.sh);
  r.rect(tx - 5, cy - 6, 10, 1, P.hi);
  for (let i = 0; i < 3; i++) {
    const bx = tx - 4 + i * 3;
    r.rect(bx, cy - 5, 2, 11, P.dark);
    r.rect(bx, cy - 5, 2, 1, P.steel);
  }

  // Funnel + bridge.
  funnel(r, u(0.39), cy, 3, 4.4);
  const bx = u(0.485);
  const bw = Math.max(7, u(0.11));
  box(r, bx, cy - 4, bw, 9, P.md);
  box(r, bx + 2, cy - 2, bw - 4, 5, P.lt);
  r.rect(bx + 2, cy - 1, bw - 4, 1, P.glass, 0.65);

  // Single forward turret.
  turret(r, u(0.69), cy, 4.2, Math.round(W * 0.08), 1);
}

const DRAW = {
  carrier: drawCarrier,
  battleship: drawBattleship,
  cruiser: drawCruiser,
  submarine: drawSubmarine,
  destroyer: drawDestroyer,
};

// ---------------------------------------------------------------------------
// nearest-neighbour resample, so a non-32 TILE still returns an exact-size raster
// ---------------------------------------------------------------------------

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

/**
 * Draw one warship, bow pointing +x.
 *
 * @param {'carrier'|'battleship'|'cruiser'|'submarine'|'destroyer'} type
 * @param {number} len   length in board cells
 * @param {number} TILE  device pixels per cell (art is authored at 32)
 * @returns {Raster} a (len * TILE) x TILE raster, transparent outside the hull
 */
export function drawShip(type, len, TILE) {
  const fn = DRAW[type];
  if (!fn) throw new Error(`drawShip: unknown ship type "${type}"`);
  const cells = Math.max(1, Math.round(len));
  const W = cells * BASE;

  const base = new Raster(W, BASE);
  const inked = fn(base, W) === true;
  if (!inked) base.outline(INK, 0.95);

  const tile = Math.max(1, Math.round(TILE));
  if (tile === BASE) return base;
  return resample(base, cells * tile, tile);
}

export default drawShip;
