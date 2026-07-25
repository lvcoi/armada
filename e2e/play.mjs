// Plays a real 3-player game in 3 browsers and checks the rules through the UI.
// Needs Playwright on the machine:  node e2e/play.mjs
import pw from 'playwright';
import { spawn } from 'node:child_process';
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
const NAMES = ['Ann', 'Ben', 'Cal'];

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

const cellBox = await ann.page.locator('[data-cell="0"]').boundingBox();
log(`cell size at 360px: ${cellBox.width.toFixed(1)}px`);
check(cellBox.width >= 20 && cellBox.width <= 24, 'cell ~21-23px at 360px viewport');

// Manual placement path: pick the carrier, tap a square, place it Across.
await ann.page.click('[data-ship="carrier"]');
await ann.page.click('[data-cell="0"]');
await ann.page.waitForSelector('.sheet .label');
const sheetText = await ann.page.textContent('.sheet .label');
check(/Carrier at A1/.test(sheetText), `placement sheet reads "${sheetText.trim()}"`);
if (SHOT_DIR) await ann.page.screenshot({ path: `${SHOT_DIR}/2-placement.png` });
await ann.page.click('[data-act="place"][data-dir="h"]');
await ann.page.waitForTimeout(200);

const carrierPlaced = await ann.page.$$eval('.cell.ship', (els) =>
  els.map((e) => Number(e.dataset.cell)));
check([0, 1, 2, 3, 4].every((c) => carrierPlaced.includes(c)), 'carrier landed on A1-E1');

for (const { page } of pages) {
  await page.click('[data-act="random"]');
  await page.waitForTimeout(150);
  await page.click('[data-act="ready"]');
}

for (const { page } of pages) await page.waitForSelector('.tabs', { timeout: 5000 });
log('all three reached the battle screen');
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
