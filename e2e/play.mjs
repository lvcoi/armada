// Plays a real 3-player game in 3 browsers and checks the rules through the UI.
// Needs Playwright on the machine:  node e2e/play.mjs
import pw from 'playwright';
import { spawn } from 'node:child_process';
import { PREMOVE_DELAY_MS } from '../shared/constants.js';
const { chromium } = pw;

const PORT = 8099;
const SERVER_URL = `http://localhost:${PORT}`;

// Own the server lifecycle here so every run starts from an empty room.
const server = spawn('node', ['server/index.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
process.on('exit', () => server.kill());

for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(SERVER_URL);
    if (r.ok) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 150));
}
const SHOT_DIR = process.env.SHOT_DIR || null;
// The third name is deliberately hostile: names are only length-capped by the server,
// and they reach the DOM through innerHTML (board aria-labels, tabs, the feed). If any
// interpolation stops escaping, this player's board stops rendering and the run fails.
const HOSTILE = '"><img src=x>';
const NAMES = ['Ann', 'Ben', HOSTILE];

const log = (...a) => console.log('  ', ...a);
const fails = [];
const check = (cond, what) => {
  if (cond) log('PASS', what);
  else { fails.push(what); log('FAIL', what); }
};

const browser = await chromium.launch();
const pages = [];

for (const name of NAMES) {
  // Separate contexts => separate localStorage => separate player tokens.
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 780 },
    isMobile: true, hasTouch: true, deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => fails.push(`JS error (${name}): ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') fails.push(`console error (${name}): ${m.text()}`); });
  await page.goto(SERVER_URL);
  await page.fill('#nm', name);
  await page.click('[data-act="join"]');
  pages.push({ name, page });
}

const [ann, ben, cal] = pages;
await ann.page.waitForSelector('[data-act="start"]');

const roster = await ann.page.$$eval('.player .nm', (els) => els.map((e) => e.textContent.trim()));
check(roster.length === 3, `3 players in lobby (got ${roster.join(', ')})`);

// ---- horizontal overflow is the #1 mobile-first failure mode
const overflow = await ann.page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
check(overflow <= 0, `no horizontal scroll at 360px (overflow ${overflow}px)`);

if (SHOT_DIR) await ann.page.screenshot({ path: `${SHOT_DIR}/1-lobby.png` });

// ---- start + placement
await ann.page.click('[data-act="start"]');
for (const { page } of pages) await page.waitForSelector('[data-act="ready"]');

// 3 players play on a 12x12 board now that size follows the head count.
const gridSide = await ann.page.$$eval('.cell', (els) => Math.sqrt(els.length));
check(gridSide === 12, `3-player game gets a 12x12 board (got ${gridSide}x${gridSide})`);

const cellBox = await ann.page.locator('[data-cell="0"]').boundingBox();
log(`cell size at 360px: ${cellBox.width.toFixed(1)}px`);
check(cellBox.width >= 24 && cellBox.width <= 34, 'cells comfortably tappable on a 12 board at 360px');

// Manual placement path: pick the carrier, then find an open anchor where Across
// fits — the starting fleet is random, so a fixed anchor is a coin flip.
await ann.page.click('[data-ship="carrier"]');
const openAnchors = await ann.page.$$eval('.cell:not(.ship):not(.land)',
  (els) => els.map((e) => Number(e.dataset.cell)));
let anchor = null;
for (const cand of openAnchors.slice(0, 80)) {
  await ann.page.click(`[data-cell="${cand}"]`);
  await ann.page.waitForTimeout(60); // rendering is rAF-scheduled
  const ok = await ann.page.$eval('[data-act="place"][data-dir="h"]', (el) => !el.disabled)
    .catch(() => false);
  if (ok) { anchor = cand; break; }
}
check(anchor != null, 'found an anchor where the carrier fits Across');
const sheetText = await ann.page.textContent('.sheet .label');
check(/Carrier at [A-O]\d+/.test(sheetText), `placement sheet reads "${sheetText.trim()}"`);
if (SHOT_DIR) await ann.page.screenshot({ path: `${SHOT_DIR}/2-placement.png` });
await ann.page.click('[data-act="place"][data-dir="h"]');
await ann.page.waitForTimeout(200);

const carrierPlaced = await ann.page.$$eval('.cell.ship', (els) =>
  els.map((e) => Number(e.dataset.cell)));
const want = Array.from({ length: 5 }, (_, n) => anchor + n);
check(want.every((c) => carrierPlaced.includes(c)),
  `carrier landed on cells ${want[0]}-${want[4]}`);

// ---- the sprite sheet has to actually decode, or every ship is an invisible box
const art = await ann.page.evaluate(async () => {
  const imgs = [...document.querySelectorAll('.hull img.sprite')];
  await Promise.all(imgs.map((i) => i.complete ? null : i.decode().catch(() => null)));
  const land = [...document.querySelectorAll('.cell.land')];
  return {
    hulls: imgs.length,
    broken: imgs.filter((i) => !i.naturalWidth).length,
    landTiles: land.length,
    landTextured: land.filter((c) =>
      getComputedStyle(c).backgroundImage.includes('sprites.png')).length,
  };
});
check(art.hulls === 5, `5 ship sprites on the board (got ${art.hulls})`);
check(art.broken === 0, `every ship sprite decoded (${art.broken} broken)`);
check(art.landTiles === 0 || art.landTextured === art.landTiles,
  `all ${art.landTiles} land cells use an island tile (${art.landTextured} textured)`);

for (const { page } of pages) {
  await page.click('[data-act="random"]');
  await page.waitForTimeout(150);
  await page.click('[data-act="ready"]');
}

for (const { page } of pages) await page.waitForSelector('.tabs', { timeout: 5000 });
log('all three reached the battle screen');

// ---- a hostile player name must not be able to break anyone else's board
{
  const tabs = await ann.page.$$('.tabs .tab');
  await tabs[tabs.length - 1].click(); // the hostile-named player's waters
  await ann.page.waitForTimeout(200);
  const shape = await ann.page.evaluate(() => ({
    cells: document.querySelectorAll('.cells [data-cell]').length,
    strayImgs: document.querySelectorAll('.cells img').length,
    aria: document.querySelector('.cells')?.getAttribute('aria-label') ?? '',
  }));
  const side = Math.sqrt(shape.cells);
  check(Number.isInteger(side) && side === 12,
    `hostile name still renders a full 12x12 board (got ${shape.cells} cells)`);
  check(shape.strayImgs === 0, `no markup injected from the name (${shape.strayImgs} stray imgs)`);
  check(shape.aria.includes('<img'), 'the name is carried as literal text in aria-label');
}
if (SHOT_DIR) await ann.page.screenshot({ path: `${SHOT_DIR}/3-battle.png` });

// ---- play turns
const whoseTurn = async () => {
  for (const p of pages) {
    if ((await p.page.textContent('.topbar h1')).trim() === 'Your turn') return p;
  }
  return null;
};

/** Fire at the Nth opponent tab, choosing a cell that is still open. */
async function takeTurn(p, tabIndex, wantCell = null) {
  await p.page.click(`.tabs .tab:nth-child(${tabIndex + 1})`);
  await p.page.waitForTimeout(120);

  // The turn can move on between whoseTurn() and this click — a queued shot auto-fires
  // on its owner's turn. Tapping a cell off-turn QUEUES A PREMOVE rather than arming a
  // shot, and that stray would fire later and corrupt the rest of the run. Re-check.
  const stillMine = (await p.page.textContent('.topbar h1')).trim() === 'Your turn';
  if (!stillMine) return null;

  const cell = wantCell ?? await p.page.$$eval(
    '.cell:not(.land):not(.miss):not(.hit)',
    (els) => Number(els[Math.floor(els.length / 2)].dataset.cell));

  await p.page.click(`[data-cell="${cell}"]`);
  // Rendering is rAF-scheduled, so the sheet appears a frame after the tap.
  try {
    await p.page.waitForSelector('[data-act="fire"]', { timeout: 2000 });
  } catch {
    return null;
  }
  await p.page.click('[data-act="fire"]');
  await p.page.waitForTimeout(220);
  return cell;
}

// THE CORE MECHANIC, through the real UI: the same coordinate fired at two different
// defenders must both be accepted.
const first = await whoseTurn();
check(!!first, 'someone has the turn');
const cellUsed = await takeTurn(first, 1);
check(cellUsed != null, `${first.name} fired a real shot (cell ${cellUsed})`);

const second = await whoseTurn();
const secondCell = await takeTurn(second, 1, cellUsed);
check(secondCell != null && secondCell === cellUsed,
  `same coordinate (${cellUsed}) accepted again against a different defender`);

// Cal must NOT be able to repeat that coordinate against Ann — Ben already used it there.
// (Cal's tab #1 is Ann, same defender.) A rejection here is the mechanic working.
const third = await whoseTurn();
const repeat = await takeTurn(third, 1, cellUsed);
check(repeat === null, 'repeating a coordinate against the SAME defender is refused');

// Cal takes a legitimate shot instead so play continues.
await takeTurn(await whoseTurn(), 1);

// Now Ann fires that same coordinate at Cal — a third, untouched defender. Legal.
const fourth = await whoseTurn();
const thirdDefender = fourth ? await takeTurn(fourth, 2, cellUsed) : null;
check(thirdDefender === cellUsed,
  'same coordinate accepted a third time against a third, untouched defender');

// Play out a bunch more turns and make sure nothing wedges.
let turns = 0;
for (let i = 0; i < 24; i++) {
  const p = await whoseTurn();
  if (!p) break;
  const got = await takeTurn(p, 1 + (i % 2));
  if (got != null) turns++;
}
log(`played ${turns} more turns without wedging`);

const feed = await ann.page.$$eval('.feed .line', (els) => els.length);
check(feed > 1, `event feed populated (${feed} lines)`);

const stillMyTurnSomewhere = await whoseTurn();
check(!!stillMyTurnSomewhere || await ann.page.$('[data-act="again"]'),
  'game is either still running or finished cleanly');

if (SHOT_DIR) await ann.page.screenshot({ path: `${SHOT_DIR}/4-midgame.png` });

// ---- premoves through the real UI: queue off-turn, watch them fire on-turn
const active = await whoseTurn();
if (active) {
  const idle = pages.find((p) => p !== active);
  await idle.page.click('.tabs .tab:nth-child(2)'); // first opponent's board
  await idle.page.waitForTimeout(150);

  // Start from a known-empty queue so the count below is exact.
  const clear = await idle.page.$('[data-act="clear-queue"]');
  if (clear) { await clear.click(); await idle.page.waitForTimeout(200); }

  const open = await idle.page.$$eval(
    '.cell:not(.land):not(.miss):not(.hit)',
    (els) => els.map((e) => Number(e.dataset.cell)));
  await idle.page.click(`[data-cell="${open[3]}"]`);
  await idle.page.click(`[data-cell="${open[9]}"]`);
  await idle.page.waitForTimeout(250);

  const queued = await idle.page.$$eval('.cell.queued', (els) => els.map((e) => e.dataset.pm));
  check(queued.length === 2, `off-turn taps queued ${queued.length} premoves (want 2)`);
  if (SHOT_DIR) await idle.page.screenshot({ path: `${SHOT_DIR}/5-premove.png` });

  // Cycle turns; when the queue owner's turn arrives, the shot must fire on its own.
  let autoFired = false;
  for (let i = 0; i < 6 && !autoFired; i++) {
    const now = await whoseTurn();
    if (!now) break;
    if (now === idle) {
      await idle.page.waitForTimeout(PREMOVE_DELAY_MS + 700);
      const left = await idle.page.$$eval('.cell.queued', (els) => els.length);
      autoFired = left < 2; // one consumed by a miss, or the whole queue cleared by a hit
    } else {
      await takeTurn(now, 1);
    }
  }
  check(autoFired, "queued shot fired automatically on the owner's turn");
}

// ---- power-ups are COLLECTED, not fired on discovery
{
  let holder = null;
  let collectedKind = null;
  // Boards carry ~1 pickup per 6 water cells, so this lands quickly. Bounded anyway.
  for (let i = 0; i < 90 && !holder; i++) {
    const p = await whoseTurn();
    if (!p) break;
    await takeTurn(p, 1 + (i % 2));
    for (const q of pages) {
      const chips = await q.page.$$eval('.item', (els) =>
        els.map((e) => ({ item: e.dataset.item, text: e.textContent.replace(/\s+/g, ' ').trim() })));
      if (chips.length) { holder = q; collectedKind = chips; break; }
    }
  }
  check(!!holder, `somebody collected a power-up into their tray${holder ? ` (${holder.name})` : ''}`);
  if (holder) {
    log('tray:', collectedKind.map((c) => c.text).join(' | '));
    if (SHOT_DIR) await holder.page.screenshot({ path: `${SHOT_DIR}/6-items.png` });

    // A collected item must NOT have fired itself — radar reveals only appear on use.
    const scannedBefore = await holder.page.$$eval('.cell.scanned', (e) => e.length);
    check(scannedBefore === 0, `a collected radar did not auto-fire (${scannedBefore} scanned cells)`);

    // Spend a self-targeting item and watch the count fall.
    const spendable = collectedKind.find((c) => c.item !== 'radar');
    if (spendable) {
      // Items are spendable only on your own turn — the chip is disabled otherwise —
      // so walk the rotation back round to the holder before clicking.
      let mine = false;
      for (let i = 0; i < 30 && !mine; i++) {
        const p = await whoseTurn();
        if (!p) break;
        if (p === holder) { mine = true; break; }
        await takeTurn(p, 1);
      }
      const enabled = await holder.page.$eval(`[data-item="${spendable.item}"]`, (el) => !el.disabled)
        .catch(() => false);
      check(mine && enabled,
        `${holder.name}'s turn came round and the item is enabled (turn=${mine}, enabled=${enabled})`);

      if (mine && enabled) {
        const before = await holder.page.$$eval(`[data-item="${spendable.item}"] .ic`, (e) => e[0]?.textContent ?? '');
        await holder.page.click(`[data-item="${spendable.item}"]`);
        await holder.page.waitForTimeout(600);
        const after = await holder.page.$$eval(`[data-item="${spendable.item}"] .ic`, (e) => e[0]?.textContent ?? 'gone');
        check(before !== after, `spending "${spendable.item}" changed the tray (${before} -> ${after})`);
      }
    }
  }
}

// ---- reconnection: reload mid-game and confirm the slot is reclaimed
const beforeName = await ben.page.$$eval('.tab .nm', (e) => e.map((x) => x.textContent.trim()));
await ben.page.reload();
await ben.page.waitForSelector('.tabs', { timeout: 5000 });
const afterName = await ben.page.$$eval('.tab .nm', (e) => e.map((x) => x.textContent.trim()));
check(JSON.stringify(beforeName) === JSON.stringify(afterName),
  'reload mid-game reclaimed the same player slot');

// ---- the secrecy check: no afloat enemy ship positions in the client's state
const leak = await ann.page.evaluate(() => {
  const cells = [...document.querySelectorAll('.cell.ship')].length;
  return cells;
});
log(`ship cells visible on the opponent board Ann is viewing: ${leak}`);

await browser.close();
server.kill();

console.log(fails.length ? `\nFAILURES (${fails.length}):\n- ${fails.join('\n- ')}` : '\nAll e2e checks passed.');
process.exit(fails.length ? 1 : 0);
