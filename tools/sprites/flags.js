// National flags for the eight playable navies, authored at 48x32 (TILE * 1.5 by TILE).
//
// These render as a badge beside a player name — roughly 24x16 CSS px — so every flag is
// built from bold blocks and nothing else. Where a real flag carries detail that cannot
// survive at that size (50 stars, Arabic script, a full coat of arms) it is simplified
// down to the one cue that still identifies the country, rather than approximated into
// mud: the US canton becomes a blue block with a star field, China keeps the big star
// plus four pips, Iran keeps a symmetrical red emblem.
//
// Every flag finishes with a 1px dark ink border, because the UI behind these is
// near-black and the dark half of the Union Jack / German flag would otherwise bleed
// straight into the background.
//
// Geometry is parametric in (w, h) rather than authored pixel-by-pixel and resampled,
// so a non-32 TILE gets stripe boundaries computed at the real size instead of a
// nearest-neighbour smear across 13 stripes.
//
// Deterministic: no randomness anywhere.

import { Raster } from './raster.js';

const INK = '#050a10';
const WHITE = '#f6f8fa';

// Real flag colours, nudged only where a pure value would vanish against the ink border.
const C = {
  usRed: '#b22234',
  usBlue: '#3c3b6e',
  ukBlue: '#012169',
  ukRed: '#c8102e',
  jpRed: '#bc002d',
  deBlack: '#1b1b20', // lifted off pure black so the ink border still reads as an edge
  deRed: '#dd0000',
  deGold: '#ffce00',
  ruBlue: '#0039a6',
  ruRed: '#d52b1e',
  cnRed: '#de2910',
  cnGold: '#ffde00',
  irGreen: '#239f40',
  irRed: '#da0000',
  esRed: '#aa151b',
  esGold: '#f1bf00',
};

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

/**
 * Horizontal bands from a [colour, weight] list. Boundaries are rounded off the
 * running total rather than per-band, so the bands always tile the full height with
 * no seam and no overshoot however the weights divide.
 */
function bands(r, x, y, w, h, list) {
  const total = list.reduce((s, b) => s + b[1], 0);
  let acc = 0;
  for (const [hex, weight] of list) {
    const top = y + Math.round((acc / total) * h);
    acc += weight;
    const bot = y + Math.round((acc / total) * h);
    r.rect(x, top, w, bot - top, hex);
  }
}

/** Five-pointed star, one point up. Concave but simple, so even-odd poly fill is exact. */
function star(r, cx, cy, rad, hex) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? rad * 0.42 : rad;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  r.poly(pts, hex);
}

/** A star too small to have points: a 3px plus still reads as a star, a blob does not. */
function pip(r, cx, cy, hex) {
  const px = Math.round(cx);
  const py = Math.round(cy);
  r.rect(px - 1, py, 3, 1, hex);
  r.rect(px, py - 1, 1, 3, hex);
}

/** Paint a '#'/'.' bitmap, top-left anchored. Used for glyphs that must be exact. */
function stamp(r, x, y, rows, hex) {
  for (let ry = 0; ry < rows.length; ry++) {
    for (let rx = 0; rx < rows[ry].length; rx++) {
      if (rows[ry][rx] === '#') r.set(x + rx, y + ry, hex);
    }
  }
}

// ---------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------

function drawUS(r, x, y, w, h) {
  const N = 13;
  for (let i = 0; i < N; i++) {
    const top = y + Math.round((i * h) / N);
    const bot = y + Math.round(((i + 1) * h) / N);
    r.rect(x, top, w, bot - top, i % 2 ? WHITE : C.usRed);
  }

  const cw = Math.round(w * 0.4);
  const ch = Math.round((7 * h) / N);
  r.rect(x, y, cw, ch, C.usBlue);

  // 6/5 alternating rows of single pixels. Fifty stars is a texture at this size; the
  // honest version is a regular field dense enough to say "stars" and nothing more.
  const rows = 5;
  const cols = 6;
  const dx = cw / (cols + 1);
  const dy = ch / (rows + 1);
  for (let ry = 0; ry < rows; ry++) {
    const odd = ry % 2 === 1;
    const n = odd ? cols - 1 : cols;
    for (let cx = 0; cx < n; cx++) {
      r.set(x + dx * (cx + 1 + (odd ? 0.5 : 0)), y + dy * (ry + 1), WHITE);
    }
  }
}

function drawUK(r, x, y, w, h) {
  r.rect(x, y, w, h, C.ukBlue);

  const uw = w - 1;
  const uh = h - 1;
  const armW = h * 0.155; // white saltire, half-thickness measured vertically
  const redW = h * 0.135; // red saltire thickness
  const fim = Math.max(1, h * 0.035); // white left outside the red on the offset side

  // The saltire is measured vertically, which is how the Union Flag actually stretches:
  // the arms stay corner-to-corner whatever the aspect ratio.
  //
  // St Patrick's red is counterchanged, not centred — offset to one side of the white so
  // the BROAD white sits above the red in the top-left. Getting this backwards is the
  // classic upside-down Union Jack. The offset flips sign at mid-width, which gives the
  // pinwheel: red meets the hoist edge below the top corner, the top edge left of the
  // fly corner, and so on round.
  const lo = armW - fim - redW;
  const hi = armW - fim;
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const su = (px - x) / uw;
      const sv = (py - y) / uh;
      const d1 = (sv - su) * uh;
      const d2 = (sv - (1 - su)) * uh;
      let col = null;
      if (Math.abs(d1) <= armW || Math.abs(d2) <= armW) col = WHITE;
      const sign = su < 0.5 ? 1 : -1;
      const r1 = sign * d1;
      const r2 = sign * d2;
      if ((r1 >= lo && r1 <= hi) || (r2 >= lo && r2 <= hi)) col = C.ukRed;
      if (col) r.set(px, py, col);
    }
  }

  // St George's cross last: it overlays the saltire, fimbriation and all.
  const fw = Math.max(3, Math.round(h / 3));
  const rw = Math.max(1, Math.round(h / 5));
  r.rect(x + Math.round((w - fw) / 2), y, fw, h, WHITE);
  r.rect(x, y + Math.round((h - fw) / 2), w, fw, WHITE);
  r.rect(x + Math.round((w - rw) / 2), y, rw, h, C.ukRed);
  r.rect(x, y + Math.round((h - rw) / 2), w, rw, C.ukRed);
}

function drawJP(r, x, y, w, h) {
  r.rect(x, y, w, h, WHITE);
  r.ellipse(x + (w - 1) / 2, y + (h - 1) / 2, h * 0.3, h * 0.3, C.jpRed);
}

function drawDE(r, x, y, w, h) {
  bands(r, x, y, w, h, [[C.deBlack, 1], [C.deRed, 1], [C.deGold, 1]]);
}

function drawRU(r, x, y, w, h) {
  bands(r, x, y, w, h, [[WHITE, 1], [C.ruBlue, 1], [C.ruRed, 1]]);
}

function drawCN(r, x, y, w, h) {
  r.rect(x, y, w, h, C.cnRed);

  // Official layout is specified on a 30x20 grid; keeping that mapping means the stars
  // stay in the correct upper-hoist cluster at any size.
  const gx = (u) => x + (u / 30) * (w - 1);
  const gy = (v) => y + (v / 20) * (h - 1);
  star(r, gx(5), gy(5), h * 0.17, C.cnGold);
  for (const [u, v] of [[10, 2], [12.5, 4.5], [12.5, 8], [10, 10.5]]) {
    pip(r, gx(u), gy(v), C.cnGold);
  }
}

// Five strokes under a bar, closed by a base: the emblem's symmetry is what makes it
// recognisable at 9px, so it is stamped rather than drawn from curves.
const IR_EMBLEM = [
  '....#....',
  '..#####..',
  '..#.#.#..',
  '#.#.#.#.#',
  '#.#.#.#.#',
  '#.#.#.#.#',
  '.#.#.#.#.',
  '.#######.',
];

function drawIR(r, x, y, w, h) {
  bands(r, x, y, w, h, [[C.irGreen, 1], [WHITE, 1], [C.irRed, 1]]);
  const gw = IR_EMBLEM[0].length;
  const gh = IR_EMBLEM.length;
  if (w >= gw + 4 && h >= gh + 2) {
    stamp(r, x + Math.round((w - gw) / 2), y + Math.round((h - gh) / 2), IR_EMBLEM, C.irRed);
  }
}

// The arms at 7x9: quartered shield under a crown. Not the real charges — at this size
// nothing survives but the shape — so it reads as "there is a device here", which is the
// only thing that separates Spain from a plain red-gold-red tricolour.
const ES_ARMS = [
  '..###..',
  '.#####.',
  '#ABBBA#',
  '#ABBBA#',
  '#ABBBA#',
  '#BAAAB#',
  '#BAAAB#',
  '.#BBB#.',
  '..###..',
];

function drawES(r, x, y, w, h) {
  bands(r, x, y, w, h, [[C.esRed, 1], [C.esGold, 2], [C.esRed, 1]]);

  const gw = ES_ARMS[0].length;
  const gh = ES_ARMS.length;
  if (w < gw + 8 || h < gh + 6) return;
  const ax = x + Math.round(w / 3) - Math.floor(gw / 2);
  const ay = y + Math.round((h - gh) / 2);
  for (let ry = 0; ry < gh; ry++) {
    for (let rx = 0; rx < gw; rx++) {
      const ch = ES_ARMS[ry][rx];
      if (ch === '.') continue;
      r.set(ax + rx, ay + ry, ch === '#' ? '#3a1417' : ch === 'A' ? C.esRed : C.esGold);
    }
  }
}

const DRAW = {
  us: drawUS,
  uk: drawUK,
  jp: drawJP,
  de: drawDE,
  ru: drawRU,
  cn: drawCN,
  ir: drawIR,
  es: drawES,
};

/**
 * Draw one national flag.
 *
 * @param {'us'|'uk'|'jp'|'de'|'ru'|'cn'|'ir'|'es'} id  a COUNTRY_IDS entry
 * @param {number} TILE  device pixels per board cell (32 on the sheet)
 * @returns {Raster} a round(TILE * 1.5) x TILE raster, fully opaque, ink-bordered
 */
export function drawFlag(id, TILE) {
  const fn = DRAW[id];
  if (!fn) throw new Error(`drawFlag: unknown country "${id}"`);

  const h = Math.max(4, Math.round(TILE));
  const w = Math.max(6, Math.round(h * 1.5));
  const r = new Raster(w, h);

  fn(r, 1, 1, w - 2, h - 2);

  // Cloth, not a sticker: one lit row along the top, one shaded row along the bottom.
  // Kept under 0.14 so it never competes with the flag's own blocks of colour.
  r.rect(1, 1, w - 2, 1, '#ffffff', 0.13);
  r.rect(1, h - 2, w - 2, 1, '#000000', 0.14);

  // Ink border, drawn last so nothing paints over it.
  r.rect(0, 0, w, 1, INK);
  r.rect(0, h - 1, w, 1, INK);
  r.rect(0, 0, 1, h, INK);
  r.rect(w - 1, 0, 1, h, INK);

  return r;
}

export default drawFlag;
