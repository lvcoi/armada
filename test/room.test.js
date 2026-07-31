import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../server/room.js';
import { projectState } from '../server/redact.js';
import {
  PHASE, MSG, SHOT, MAX_PREMOVES, PREMOVE_DELAY_MS,
} from '../shared/constants.js';
import { toIndex, label } from '../shared/coords.js';

/** Controllable clock so timer tests run instantly. */
function fakeClock() {
  let t = 1_000_000;
  const timers = new Set();
  return {
    now: () => t,
    rng: () => 0.5,
    setTimeout(fn, ms) {
      const h = { fn, at: t + ms };
      timers.add(h);
      return h;
    },
    clearTimeout(h) { if (h) timers.delete(h); },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let due = null;
        for (const h of timers) if (h.at <= target && (!due || h.at < due.at)) due = h;
        if (!due) break;
        timers.delete(due);
        t = due.at;
        due.fn();
      }
      t = target;
    },
  };
}

/** Errors carry a machine-readable `code`; the message is for humans. */
const throwsCode = (fn, code) =>
  assert.throws(fn, (e) => e.code === code, `expected error code "${code}"`);

function harness() {
  const clock = fakeClock();
  const events = [];
  const room = new Room(
    { event: (m) => events.push(m), changed: () => {} },
    clock,
  );
  return { room, clock, events };
}

/** Three players play on a 12x12 board. All fixture coordinates below assume it. */
const G = 12;
const at = (x, y) => toIndex(x, y, G);

const rowFleet = (col, startRow, g = G) => [
  { type: 'carrier', anchor: toIndex(col, startRow + 0, g), dir: 'h' },
  { type: 'battleship', anchor: toIndex(col, startRow + 1, g), dir: 'h' },
  { type: 'cruiser', anchor: toIndex(col, startRow + 2, g), dir: 'h' },
  { type: 'submarine', anchor: toIndex(col, startRow + 3, g), dir: 'h' },
  { type: 'destroyer', anchor: toIndex(col, startRow + 4, g), dir: 'h' },
];

/** Ben's fleet: vertical, packed into the bottom-left, clear of the atoll ring. */
const benFleet = () => [
  { type: 'carrier', anchor: at(0, 7), dir: 'v' },     // (0,7)-(0,11)
  { type: 'battleship', anchor: at(1, 8), dir: 'v' },  // (1,8)-(1,11)
  { type: 'cruiser', anchor: at(2, 9), dir: 'v' },     // (2,9)-(2,11)
  { type: 'submarine', anchor: at(3, 9), dir: 'v' },   // (3,9)-(3,11)
  { type: 'destroyer', anchor: at(4, 10), dir: 'v' },  // (4,10)-(4,11)
];

/** Cal's fleet: top-right rows, destroyer shifted right of the atoll ring. */
const calFleet = () => [
  { type: 'carrier', anchor: at(7, 0), dir: 'h' },     // (7,0)-(11,0)
  { type: 'battleship', anchor: at(7, 1), dir: 'h' },
  { type: 'cruiser', anchor: at(7, 2), dir: 'h' },
  { type: 'submarine', anchor: at(7, 3), dir: 'h' },
  { type: 'destroyer', anchor: at(8, 4), dir: 'h' },   // (8,4)-(9,4)
];

/**
 * 3 players (12x12 board) on the atoll map with known, non-overlapping fleets.
 * atoll@12 land is the ring (4..7)x(4..7) minus its hollow middle.
 */
function threePlayerGame() {
  const h = harness();
  const { room } = h;
  const a = room.join({ name: 'Ann' }).player;
  const b = room.join({ name: 'Ben' }).player;
  const c = room.join({ name: 'Cal' }).player;

  room.startGame(a.id);
  assert.equal(room.grid, G, '3 players play on a 12x12 board');
  room.terrainId = 'atoll'; // pin the map so the fixtures below are always legal

  room.setPlacement(a.id, rowFleet(0, 0)); // Ann occupies the top-left rows
  room.setPlacement(b.id, benFleet());
  room.setPlacement(c.id, calFleet());

  [a, b, c].forEach((p) => room.confirmPlacement(p.id));
  assert.equal(room.phase, PHASE.PLAYING);
  return { ...h, a, b, c };
}

test('THE CORE MECHANIC: one cell resolves independently per defender', () => {
  const { room, a, b, c } = threePlayerGame();
  const CELL = at(0, 0); // "A1"

  // A1 is water on Ben's board (his fleet is vertical, rows 7+) but is Ann's carrier.
  assert.equal(room.currentPlayerId(), a.id);
  room.fire(a.id, { targetId: b.id, cell: CELL });
  assert.equal(b.incoming[CELL], SHOT.MISS, `${label(CELL, G)} should miss Ben`);

  // Same coordinate, different defender, opposite outcome — and Ben's grid is untouched.
  assert.equal(room.currentPlayerId(), b.id);
  room.fire(b.id, { targetId: a.id, cell: CELL });
  assert.equal(a.incoming[CELL], SHOT.HIT, `${label(CELL, G)} should hit Ann`);
  assert.equal(b.incoming[CELL], SHOT.MISS, "Ben's grid must not change when Ann is shot");
  assert.equal(c.incoming[CELL], SHOT.NONE, 'Cal was never fired at');

  // Cal fires the same column at a third player — still independent, still allowed.
  assert.equal(room.currentPlayerId(), c.id);
  room.fire(c.id, { targetId: b.id, cell: at(0, 10) });

  // Back to Ann: firing A1 at Ben again is a repeat and must be refused...
  assert.equal(room.currentPlayerId(), a.id);
  throwsCode(() => room.fire(a.id, { targetId: b.id, cell: CELL }), 'already_fired');

  // ...but the very same coordinate against Cal is a brand new, legal shot.
  room.fire(a.id, { targetId: c.id, cell: CELL });
  assert.equal(c.incoming[CELL], SHOT.MISS);
});

test('no global shot grid leaks between defenders', () => {
  const { room, a, b, c } = threePlayerGame();
  // Ann shoots every cell of row 3 at Ben; Cal's and Ann's grids stay pristine.
  for (let x = 0; x < 5; x++) {
    const cell = at(x, 2);
    b.incoming[cell] = SHOT.NONE;
    room.turn.pos = room.seating.indexOf(a.id);
    room.fire(a.id, { targetId: b.id, cell });
  }
  for (let x = 0; x < 5; x++) {
    assert.equal(c.incoming[at(x, 2)], SHOT.NONE);
    assert.equal(a.incoming[at(x, 2)], SHOT.NONE);
  }
});

test('sinking a ship reports it, and a wiped fleet eliminates the player', () => {
  const { room, events, a, b } = threePlayerGame();

  // Ben's destroyer sits at (4,10)-(4,11).
  room.turn.pos = room.seating.indexOf(a.id);
  room.fire(a.id, { targetId: b.id, cell: at(4, 10) });
  assert.equal(events.at(-2).result, 'hit');

  room.turn.pos = room.seating.indexOf(a.id);
  room.fire(a.id, { targetId: b.id, cell: at(4, 11) });
  const sunk = events.find((e) => e.t === MSG.FIRE_RESULT && e.result === 'sunk');
  assert.equal(sunk.shipType, 'destroyer');

  // Now flatten the rest of Ben's fleet.
  for (const ship of b.ships) {
    for (const cell of ship.cells) {
      if (b.incoming[cell] === SHOT.NONE) {
        room.turn.pos = room.seating.indexOf(a.id);
        if (!b.eliminated) room.fire(a.id, { targetId: b.id, cell });
      }
    }
  }

  assert.ok(b.eliminated, 'Ben should be out');
  assert.ok(events.some((e) => e.t === MSG.ELIMINATED && e.playerId === b.id));
  throwsCode(() => {
    room.turn.pos = room.seating.indexOf(a.id);
    room.fire(a.id, { targetId: b.id, cell: at(3, 3) });
  }, 'bad_target');
});

test('turn order skips eliminated players without losing anyone', () => {
  const { room, a, b, c } = threePlayerGame();
  b.eliminated = true;

  room.turn.pos = room.seating.indexOf(a.id);
  room.advanceTurn();
  assert.equal(room.currentPlayerId(), c.id, 'should jump over Ben to Cal');

  room.advanceTurn();
  assert.equal(room.currentPlayerId(), a.id, 'and wrap back to Ann');
});

test('last fleet standing wins', () => {
  const { room, events, a, b, c } = threePlayerGame();
  b.ships.forEach((s) => { s.sunk = true; });
  c.ships.forEach((s) => { s.sunk = true; });
  b.eliminated = true;

  room.turn.pos = room.seating.indexOf(a.id);
  const lastCell = c.ships[0].cells[0];
  c.ships.forEach((s) => { s.sunk = true; });
  room.fire(a.id, { targetId: c.id, cell: lastCell });

  assert.equal(room.phase, PHASE.OVER);
  assert.equal(room.winnerId, a.id);
  assert.ok(events.some((e) => e.t === MSG.OVER && e.winnerId === a.id));
});

test('turn timeout auto-fires exactly one legal shot and moves on', () => {
  const { room, clock, events, a, b, c } = threePlayerGame();
  assert.equal(room.currentPlayerId(), a.id);

  const before = events.filter((e) => e.t === MSG.FIRE_RESULT).length;
  clock.advance(room.settings.turnLimitMs);

  const shots = events.filter((e) => e.t === MSG.FIRE_RESULT);
  assert.equal(shots.length, before + 1, 'exactly one auto shot');

  const shot = shots.at(-1);
  assert.equal(shot.attackerId, a.id);
  assert.equal(shot.auto, true);
  assert.notEqual(shot.targetId, a.id, 'never shoot yourself');
  assert.ok([b.id, c.id].includes(shot.targetId));
  assert.equal(room.currentPlayerId(), b.id, 'turn advanced');
});

test('"No limit" means no deadline and no auto-fire', () => {
  const h = harness();
  const { room, clock, events } = h;
  const a = room.join({ name: 'Ann' }).player;
  room.join({ name: 'Ben' });
  room.setSettings(a.id, { turnLimitMs: null, placementLimitMs: null });
  room.startGame(a.id);

  assert.equal(room.placementDeadlineAt, null);
  room.players.forEach((p) => room.confirmPlacement(p.id));
  assert.equal(room.turn.deadlineAt, null);

  clock.advance(60 * 60 * 1000);
  assert.equal(events.filter((e) => e.t === MSG.FIRE_RESULT).length, 0);
  assert.equal(room.phase, PHASE.PLAYING);
});

test('placement timeout keeps what you placed and fills in the rest', () => {
  const h = harness();
  const { room, clock } = h;
  const a = room.join({ name: 'Ann' }).player;
  const b = room.join({ name: 'Ben' }).player;
  room.startGame(a.id);
  assert.equal(room.grid, 10, '2 players play on a 10x10 board');
  room.terrainId = 'atoll';
  room.randomPlacement(b.id); // re-roll on the pinned map so his fleet is legal there

  room.setPlacement(a.id, rowFleet(0, 0, 10));
  room.confirmPlacement(a.id);
  assert.equal(room.phase, PHASE.PLACEMENT, 'still waiting on Ben');

  const benCarrier = b.ships.find((s) => s.type === 'carrier');
  const keptAnchor = benCarrier.anchor;

  clock.advance(room.settings.placementLimitMs);

  assert.equal(room.phase, PHASE.PLAYING, 'timeout starts the game');
  assert.ok(b.ready, 'Ben was locked in automatically');
  assert.equal(b.ships.length, 5);
  assert.equal(b.ships.find((s) => s.type === 'carrier').anchor, keptAnchor,
    'his existing placement survived');
});

test('redaction hides afloat enemy ships but reveals sunk ones', () => {
  const { room, a, b } = threePlayerGame();

  const asBen = projectState(room, b.id);
  const annAsSeenByBen = asBen.players.find((p) => p.id === a.id);
  assert.equal(annAsSeenByBen.isSelf, false);
  for (const ship of annAsSeenByBen.ships) {
    assert.equal(ship.cells, null, 'afloat enemy ship positions must never ship over the wire');
  }
  assert.ok(!JSON.stringify(asBen).includes('shipAt'));

  const benSelf = asBen.players.find((p) => p.id === b.id);
  assert.equal(benSelf.isSelf, true);
  assert.ok(benSelf.ships.every((s) => Array.isArray(s.cells)), 'you can see your own fleet');

  // Sink Ann's destroyer, then it becomes public.
  const destroyer = a.ships.find((s) => s.type === 'destroyer');
  destroyer.cells.forEach((c) => { a.shipAt[c] = a.ships.indexOf(destroyer); });
  room.turn.pos = room.seating.indexOf(b.id);
  destroyer.cells.forEach((cell) => {
    if (!a.eliminated && a.incoming[cell] === SHOT.NONE) {
      room.turn.pos = room.seating.indexOf(b.id);
      room.fire(b.id, { targetId: a.id, cell });
    }
  });

  const after = projectState(room, b.id).players.find((p) => p.id === a.id);
  const pubDestroyer = after.ships.find((s) => s.type === 'destroyer');
  assert.equal(pubDestroyer.sunk, true);
  assert.deepEqual(pubDestroyer.cells, destroyer.cells, 'sunk ships are revealed');
});

test('land cannot be targeted', () => {
  const { room, a, b } = threePlayerGame();
  const landCell = at(4, 4); // corner of the atoll ring on the 12x12 map
  room.turn.pos = room.seating.indexOf(a.id);
  throwsCode(() => room.fire(a.id, { targetId: b.id, cell: landCell }), 'cell_is_land');
});

test('only the host can change settings, and only in the lobby', () => {
  const h = harness();
  const { room } = h;
  const a = room.join({ name: 'Ann' }).player;
  const b = room.join({ name: 'Ben' }).player;

  throwsCode(() => room.setSettings(b.id, { turnLimitMs: 30_000 }), 'not_host');
  room.setSettings(a.id, { turnLimitMs: 30_000 });
  assert.equal(room.settings.turnLimitMs, 30_000);

  throwsCode(() => room.setSettings(a.id, { turnLimitMs: 99 }), 'bad_message');

  room.startGame(a.id);
  throwsCode(() => room.setSettings(a.id, { turnLimitMs: 60_000 }), 'wrong_phase');
});

test('reconnecting with a token reclaims the same slot and fleet', () => {
  const { room, a } = threePlayerGame();
  const carrier = a.ships.find((s) => s.type === 'carrier').cells.slice();

  room.disconnect(a.id);
  assert.equal(a.connected, false);
  assert.ok(room.byId(a.id), 'a mid-game player is never dropped');

  const back = room.join({ token: a.token });
  assert.equal(back.reconnected, true);
  assert.equal(back.player.id, a.id);
  assert.equal(back.player.connected, true);
  assert.deepEqual(back.player.ships.find((s) => s.type === 'carrier').cells, carrier);
});

test('a repeated nonce does not fire twice', () => {
  const { room, events, a, b } = threePlayerGame();
  const cell = at(1, 6); // open water on Ben's board

  room.turn.pos = room.seating.indexOf(a.id);
  room.fire(a.id, { targetId: b.id, cell, nonce: 'n1' });
  const count = events.filter((e) => e.t === MSG.FIRE_RESULT).length;

  room.turn.pos = room.seating.indexOf(a.id);
  room.fire(a.id, { targetId: b.id, cell, nonce: 'n1' });
  assert.equal(events.filter((e) => e.t === MSG.FIRE_RESULT).length, count, 'retry ignored');
});

test('you cannot fire out of turn', () => {
  const { room, a, b, c } = threePlayerGame();
  assert.equal(room.currentPlayerId(), a.id);
  throwsCode(() => room.fire(c.id, { targetId: b.id, cell: at(3, 6) }), 'not_your_turn');
});

// ---------------------------------------------------------------------- premoves

test('premoves fire automatically, one per turn, until a hit clears the queue', () => {
  const { room, clock, events, a, b, c } = threePlayerGame();

  room.setPremoves(b.id, [
    { targetId: c.id, cell: at(0, 11) },  // open water on Cal's board -> miss
    { targetId: a.id, cell: at(2, 0) },   // Ann's carrier -> hit
    { targetId: c.id, cell: at(1, 11) },  // queued behind the hit; must never fire
  ]);
  assert.equal(b.premoves.length, 3);

  // Ann plays by hand; then Ben's queue takes over after the reveal delay.
  room.fire(a.id, { targetId: c.id, cell: at(2, 11) });
  assert.equal(room.currentPlayerId(), b.id);

  const before = events.filter((e) => e.t === MSG.FIRE_RESULT).length;
  clock.advance(PREMOVE_DELAY_MS);

  let shots = events.filter((e) => e.t === MSG.FIRE_RESULT);
  assert.equal(shots.length, before + 1, 'the queued shot fired on its own');
  assert.equal(shots.at(-1).attackerId, b.id);
  assert.equal(shots.at(-1).premove, true);
  assert.equal(shots.at(-1).result, 'miss');
  assert.equal(c.incoming[at(0, 11)], SHOT.MISS);
  assert.equal(b.premoves.length, 2, 'a miss keeps the rest of the queue');
  assert.equal(room.currentPlayerId(), c.id, 'the turn moved on');

  // A full round later, Ben's next queued shot connects — and wipes the queue.
  room.fire(c.id, { targetId: a.id, cell: at(0, 11) });
  room.fire(a.id, { targetId: c.id, cell: at(3, 11) });
  assert.equal(room.currentPlayerId(), b.id);
  clock.advance(PREMOVE_DELAY_MS);

  shots = events.filter((e) => e.t === MSG.FIRE_RESULT);
  assert.equal(shots.at(-1).result, 'hit');
  assert.equal(a.incoming[at(2, 0)], SHOT.HIT);
  assert.equal(b.premoves.length, 0, 'a hit clears the whole queue');
  assert.equal(c.incoming[at(1, 11)], SHOT.NONE, 'the shot behind the hit never fires');
});

test('a queued cell someone else has since shot is skipped for the next one', () => {
  const { room, clock, events, b, c, a } = threePlayerGame();
  const cellX = at(5, 11);
  const cellY = at(6, 11);
  room.setPremoves(b.id, [
    { targetId: c.id, cell: cellX },
    { targetId: c.id, cell: cellY },
  ]);

  // Ann takes cellX on Cal's board first.
  room.fire(a.id, { targetId: c.id, cell: cellX });
  assert.equal(room.currentPlayerId(), b.id);
  clock.advance(PREMOVE_DELAY_MS);

  const shot = events.filter((e) => e.t === MSG.FIRE_RESULT).at(-1);
  assert.equal(shot.attackerId, b.id);
  assert.equal(shot.cell, cellY, 'the stale entry was skipped');
  assert.equal(b.premoves.length, 0);
});

test('firing by hand cancels the pending queued shot but keeps the queue', () => {
  const { room, clock, events, a, b, c } = threePlayerGame();
  const queued = at(7, 11);
  room.setPremoves(b.id, [{ targetId: c.id, cell: queued }]);

  room.fire(a.id, { targetId: c.id, cell: at(2, 11) });
  assert.equal(room.currentPlayerId(), b.id);

  // Ben aims himself before the queue pops.
  room.fire(b.id, { targetId: c.id, cell: at(8, 11) });
  const count = events.filter((e) => e.t === MSG.FIRE_RESULT).length;

  clock.advance(PREMOVE_DELAY_MS * 2);
  assert.equal(events.filter((e) => e.t === MSG.FIRE_RESULT).length, count, 'no ghost shot');
  assert.equal(c.incoming[queued], SHOT.NONE);
  assert.equal(b.premoves.length, 1, 'the queue holds for his next turn');
});

test('setPremoves sanitizes garbage and caps the queue', () => {
  const { room, a, b, c } = threePlayerGame();
  room.setPremoves(a.id, [
    { targetId: a.id, cell: at(0, 11) },    // yourself — dropped
    { targetId: 'zz', cell: at(1, 11) },    // unknown player — dropped
    { targetId: b.id, cell: at(4, 4) },     // land — dropped
    { targetId: b.id, cell: -1 },           // off the board — dropped
    { targetId: b.id, cell: G * G },        // off the board — dropped
    { targetId: b.id, cell: at(2, 11) },
    { targetId: b.id, cell: at(2, 11) },    // duplicate — dropped
    ...Array.from({ length: 10 }, (_, x) => ({ targetId: c.id, cell: at(x, 11) })),
  ]);

  assert.equal(a.premoves.length, MAX_PREMOVES, 'queue is capped');
  assert.ok(a.premoves.every((m) => m.targetId !== a.id));
  assert.ok(!a.premoves.some((m) => m.cell === at(4, 4)));
  assert.equal(a.premoves.filter((m) => m.cell === at(2, 11) && m.targetId === b.id).length, 1);

  const empty = harness();
  const p = empty.room.join({ name: 'Solo' }).player;
  throwsCode(() => empty.room.setPremoves(p.id, [{ targetId: 'x', cell: 0 }]), 'wrong_phase');
});

test('your queue is private: never projected to other players', () => {
  const { room, a, b } = threePlayerGame();
  room.setPremoves(a.id, [{ targetId: b.id, cell: at(9, 11) }]);

  const asAnn = projectState(room, a.id);
  assert.equal(asAnn.players.find((p) => p.id === a.id).premoves.length, 1);
  assert.equal(asAnn.grid, G, 'state carries the board size');

  const asBen = projectState(room, b.id);
  assert.equal(asBen.players.find((p) => p.id === a.id).premoves, undefined,
    "Ann's battle plan must never reach Ben's phone");
});

test('board size scales with the player count', () => {
  // Two players: close-quarters 10x10.
  const two = harness();
  const a2 = two.room.join({ name: 'Ann' }).player;
  two.room.join({ name: 'Ben' });
  two.room.startGame(a2.id);
  assert.equal(two.room.grid, 10);
  assert.equal(a2.incoming.length, 100);
  assert.equal(a2.shipAt.length, 100);
  assert.equal(projectState(two.room, a2.id).grid, 10);

  // Four players: the full 15x15 ocean.
  const four = harness();
  const a4 = four.room.join({ name: 'Ann' }).player;
  four.room.join({ name: 'Ben' });
  four.room.join({ name: 'Cal' });
  const d4 = four.room.join({ name: 'Dot' }).player;
  four.room.startGame(a4.id);
  assert.equal(four.room.grid, 15);
  assert.equal(d4.incoming.length, 225);
  assert.ok(a4.ships.every((s) => s.cells.every((c) => c < 225)));
});
