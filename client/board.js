// The sonar-plot board renderer, shared by every screen. Board size varies by player
// count. The board is a stack of paint layers (water, caustics, grid lines, radar
// sweep, ship sprites) with a grid of TRANSPARENT tap-target buttons on top — so all
// tap/swipe handling keys off `[data-cell]` exactly as before, while the art lives
// underneath and never intercepts a touch.
//
// Ship and island art comes from client/sprites.png via the generated sprite-map.
// Rebuild both with `npm run sprites` after editing anything in tools/sprites/.

import { SHOT } from '/shared/constants.js';
import { label } from '/shared/coords.js';
import {
  SHEET, SHEET_W, SHEET_H, TILE, SHIPS, ISLAND_Y, ISLAND_COUNT, FLAGS, ICONS, STORM, BOOM,
} from '/sprite-map.js';

// Player names reach this module (board and cell labels) and the server only caps them
// at 16 characters — it does not strip markup. Escaping happens here, at the sink that
// actually builds the HTML, so no caller can forget it.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --------------------------------------------------------------------- sprites

/**
 * A sprite region is shown by over-sizing the whole sheet inside a clipping box and
 * sliding it so the wanted region lands on the box. Percentages are relative to the
 * box, so this stays exact at every board size without knowing any pixel dimensions.
 */
function spriteIMG(region, cls = '') {
  const w = (SHEET_W / region.w) * 100;
  const h = (SHEET_H / region.h) * 100;
  const l = (-region.x / region.w) * 100;
  const t = (-region.y / region.h) * 100;
  return `<img class="sprite ${cls}" src="${SHEET}" alt="" draggable="false"
    style="width:${w}%;height:${h}%;left:${l}%;top:${t}%">`;
}

/** Background offsets for one island autotile, addressed by neighbour mask. */
function islandStyle(mask) {
  const bx = ISLAND_COUNT > 1 ? (mask / (ISLAND_COUNT - 1)) * 100 : 0;
  const by = SHEET_H > TILE ? (ISLAND_Y / (SHEET_H - TILE)) * 100 : 0;
  return `background-image:url(${SHEET});`
    + `background-size:${(SHEET_W / TILE) * 100}% ${(SHEET_H / TILE) * 100}%;`
    + `background-position:${bx}% ${by}%;`;
}

/**
 * Position one ship over its cells. Vertical ships reuse the horizontal sprite,
 * rotated 90° around the ANCHOR CELL's center — `calc(50%/var(--len))` is that pivot
 * for any length, so the hull lands exactly down the column.
 */
function hullDiv(ship, grid, idx = 0) {
  const cells = ship.cells;
  const len = cells.length;
  const r = Math.floor(cells[0] / grid);
  const c = cells[0] % grid;
  const horiz = len === 1 || cells[1] === cells[0] + 1;
  const region = SHIPS[ship.type];

  const cls = ['hull'];
  if (!horiz) cls.push('vert');
  if (ship.sunk) cls.push('sunk');
  if (ship.ghost) cls.push('ghost');
  if (ship.bad) cls.push('bad');

  // A "won't fit here" preview is only ever one cell wide, so the ship sprite would
  // be squashed — show a plain marker instead. Same fallback for unknown types.
  const art = (region && !ship.bad)
    ? spriteIMG(region)
    : '<span class="hull-fallback"></span>';

  return `<div class="${cls.join(' ')}" style="left:calc(100%*${c}/${grid});top:calc(100%*${r}/${grid});width:calc(100%*${len}/${grid});height:calc(100%/${grid});--len:${len};--i:${idx}">${art}</div>`;
}

// --------------------------------------------------------------------- board

/** Spoken description of a cell, so the board is usable without sight. */
function cellLabel(c, grid, { isLand, shot, ship, order }) {
  const parts = [label(c, grid)];
  if (isLand) parts.push('land');
  else if (shot === SHOT.HIT) parts.push(ship?.sunk ? 'sunk' : 'hit');
  else if (shot === SHOT.MISS) parts.push('miss');
  else if (ship) parts.push('your ship');
  else parts.push('open water');
  if (order) parts.push(`queued ${order}`);
  return parts.join(', ');
}

/**
 * Build one board.
 *
 * @param opts.grid      board side length (10, 12 or 15)
 * @param opts.land      array of land cell indices
 * @param opts.incoming  the DEFENDER's own shot record — never a global grid
 * @param opts.ships     [{cells, sunk, type}] to draw (own board, or sunk enemy ships)
 * @param opts.selected  cell to outline with the targeting reticle
 * @param opts.ghost     { cells, bad, type } placement preview
 * @param opts.premoves  Map cell -> 1-based queue position, shown as order badges
 * @param opts.lastShot  newest log entry's cell on THIS board — the only cell that
 *                       animates on render (innerHTML rebuilds must not replay history)
 * @param opts.plop      one-shot: ships play a staggered arrival pop (after a shuffle)
 * @param opts.name      accessible name for the whole plot
 * @param opts.disabled  dim and ignore taps
 */
export function boardHTML(opts = {}) {
  const {
    grid = 15, land = [], incoming = [], ships = [], selected = null,
    ghost = null, premoves = null, lastShot = null, plop = false,
    scan = null, selfDamage = null, aim = null, storm = null,
    name = 'Battle plot', disabled = false,
  } = opts;

  const hidden = new Set(selfDamage ?? []);
  const eye = new Set(storm ?? []);

  const landSet = new Set(land);
  const shipAt = new Map();
  for (const s of ships) {
    if (!s?.cells) continue;
    for (const c of s.cells) shipAt.set(c, s);
  }

  const hulls = ships
    .filter((s) => s?.cells?.length)
    .map((s, i) => hullDiv(s, grid, i))
    .join('');
  const ghostHull = ghost?.cells?.length
    ? hullDiv({ cells: ghost.cells, type: ghost.type, ghost: true, bad: ghost.bad }, grid)
    : '';

  // The first playable cell is the board's single tab stop; arrow keys move from there
  // (see the keyboard handler in app.js). 225 tab stops would be unusable.
  let tabStop = null;

  let cells = '';
  for (let c = 0; c < grid * grid; c++) {
    const cls = ['cell'];
    const isLand = landSet.has(c);
    let style = '';

    if (isLand) {
      cls.push('land');
      // Which orthogonal neighbours are also land: N=1 E=2 S=4 W=8. Adjacent tiles
      // pick complementary coastlines and fuse into one landmass.
      const mask = (landSet.has(c - grid) ? 1 : 0)
        | ((c + 1) % grid !== 0 && landSet.has(c + 1) ? 2 : 0)
        | (landSet.has(c + grid) ? 4 : 0)
        | (c % grid !== 0 && landSet.has(c - 1) ? 8 : 0);
      style = islandStyle(mask);
    }

    const ship = shipAt.get(c);
    if (ship) {
      cls.push('ship');
      if (ship.sunk) cls.push('sunk');
    }

    const shot = incoming[c] ?? SHOT.NONE;
    if (shot === SHOT.MISS) cls.push('miss');
    if (shot === SHOT.HIT) {
      cls.push('hit');
      if (ship?.sunk) cls.push('sunk');
    }

    if (c === selected) cls.push('sel');

    const order = premoves?.get(c);
    if (order) cls.push('queued');

    // Private intel: what radar found, and mine damage that is deliberately absent
    // from the public shot grid.
    const found = scan?.get(c);
    if (found) {
      cls.push('scanned');
      if (found.ship) cls.push('scan-ship');
      if (found.powerup === 'mine') cls.push('scan-mine');
      else if (found.powerup) cls.push('scan-pickup');
    }
    if (hidden.has(c)) cls.push('mined');
    if (aim?.has(c)) cls.push('aim');

    // Radar shows WHAT is hidden, so draw the actual pickup rather than a coloured box.
    let inner = '';
    if (found?.powerup) inner = iconHTML(found.powerup, null);
    if (eye.has(c)) { cls.push('storm'); inner += stormHTML(); }

    if (tabStop === null && !isLand) tabStop = c;

    cells += `<button class="${cls.join(' ')}" data-cell="${c}"`
      + ` tabindex="${c === tabStop ? '0' : '-1'}"`
      + ` aria-label="${esc(cellLabel(c, grid, { isLand, shot, ship, order }))}"`
      + (order ? ` data-pm="${order}"` : '')
      + (c === lastShot ? ' data-new' : '')
      + (style ? ` style="${style}"` : '')
      + `>${inner}</button>`;
  }

  // Targeting lines cross the full plot through the armed cell.
  let tlines = '';
  if (selected != null) {
    const row = Math.floor(selected / grid);
    const col = selected % grid;
    tlines = `<div class="tline h" style="top:calc((${row} + .5) * 100% / ${grid})"></div>
      <div class="tline v" style="left:calc((${col} + .5) * 100% / ${grid})"></div>`;
  }

  // Only the painted layers are clipped — the caustics and radar sweep are deliberately
  // oversized. The cell grid stays outside the clip so an armed target's reticle and a
  // queue badge on an edge cell are not sliced off by the board's rounded corner.
  return `<div class="board${disabled ? ' disabled' : ''}" style="--grid:${grid}">
    <div class="plot">
      <div class="water"></div>
      <div class="caustics"></div>
      <div class="gridlines"></div>
      <div class="sweep"></div>
      <div class="hulls${plop ? ' plop' : ''}">${hulls}${ghostHull}</div>
    </div>
    <div class="cells" role="group" aria-label="${esc(name)}">${cells}</div>
    ${tlines}
  </div>`;
}

/**
 * Ship silhouette for the placement dock chips. The box has to keep the sprite's own
 * aspect ratio or a carrier ends up looking like a tugboat, so its width is driven
 * off the ship's length in cells.
 */
export function shipChipHTML(type) {
  const region = SHIPS[type];
  if (!region) return '';
  return `<span class="mini" style="--len:${region.w / TILE}">${spriteIMG(region)}</span>`;
}

/** A national flag badge. `size` is its height in px; width follows the 3:2 art. */
export function flagHTML(countryId, size = 14) {
  const region = FLAGS?.[countryId];
  if (!region) return '';
  return `<span class="flag" style="height:${size}px;width:${size * (region.w / region.h)}px">${
    spriteIMG(region)}</span>`;
}

/**
 * A power-up icon — the same art in the item tray and on a radar-revealed square.
 * Pass a pixel size for the tray, or null on the board where CSS positions it against
 * the cell.
 */
export function iconHTML(kind, size = 18) {
  const region = ICONS?.[kind];
  if (!region) return '';
  const style = size == null ? '' : ` style="width:${size}px;height:${size}px"`;
  return `<span class="icon"${style}>${spriteIMG(region)}</span>`;
}

/**
 * A frame strip animated by sliding the sheet sideways under a one-frame window.
 * The step is a percentage of the IMAGE's width, so it stays a pure transform and
 * costs nothing to composite. Both strips are 8 frames — see the steps(8) in the CSS.
 */
function stripHTML(strip, cls, extraStyle = '') {
  if (!strip) return '';
  const w = (SHEET_W / strip.size) * 100;
  const h = (SHEET_H / strip.size) * 100;
  const t = (-strip.y / strip.size) * 100;
  const run = -((strip.frames * strip.size) / SHEET_W) * 100;
  return `<span class="strip ${cls}" style="${extraStyle}">
    <img class="sprite" src="${SHEET}" alt="" draggable="false"
      style="width:${w}%;height:${h}%;left:0;top:${t}%;--run:${run}%"></span>`;
}

/** The hurricane, looping. Sits over a cell inside the storm's eye. */
export const stormHTML = () => stripHTML(STORM, 'storm-anim');

/** One-shot explosion, sized larger than a cell so the blast overspills it. */
export const boomHTML = () => stripHTML(BOOM, 'boom-anim');
