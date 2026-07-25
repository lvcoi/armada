// The 15x15 grid renderer, shared by every screen.

import { CELLS, SHOT } from '/shared/constants.js';

/**
 * Build one board.
 *
 * @param opts.land      array of land cell indices
 * @param opts.incoming  the DEFENDER's own shot record — never a global grid
 * @param opts.ships     [{cells, sunk}] to draw (own board, or sunk enemy ships)
 * @param opts.selected  cell to outline
 * @param opts.ghost     { cells, bad } preview overlay
 * @param opts.disabled  dim and ignore taps
 */
export function boardHTML(opts = {}) {
  const {
    land = [], incoming = [], ships = [], selected = null,
    ghost = null, disabled = false,
  } = opts;

  const landSet = new Set(land);
  const shipAt = new Map();
  for (const s of ships) {
    if (!s?.cells) continue;
    for (const c of s.cells) shipAt.set(c, s);
  }
  const ghostSet = new Set(ghost?.cells ?? []);

  let html = `<div class="board${disabled ? ' disabled' : ''}" role="grid">`;
  for (let c = 0; c < CELLS; c++) {
    const cls = ['cell'];
    if (landSet.has(c)) cls.push('land');

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

    if (ghostSet.has(c)) {
      cls.push('ghost');
      if (ghost.bad) cls.push('bad');
    }
    if (c === selected) cls.push('sel');

    html += `<button class="${cls.join(' ')}" data-cell="${c}" tabindex="-1"></button>`;
  }
  return html + '</div>';
}
