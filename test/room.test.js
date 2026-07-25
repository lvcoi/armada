import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../server/room.js';
import { projectState } from '../server/redact.js';
import { PHASE, MSG, SHOT } from '../shared/constants.js';
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

const rowFleet = (col, startRow) => [
  { type: 'carrier', anchor: toIndex(col, startRow + 0), dir: 'h' },
  { type: 'battleship', anchor: toIndex(col, startRow + 1), dir: 'h' },
  { type: 'cruiser', anchor: toIndex(col, startRow + 2), dir: 'h' },
  { type: 'submarine', anchor: toIndex(col, startRow + 3), dir: 'h' },
  { type: 'destroyer', anchor: toIndex(col, startRow + 4), dir: 'h' },
];

/** 3 players on the atoll map with known, non-overlapping fleet positions. */
function threePlayerGame() {
  const h = harness();
  const { room } = h;
  const a = room.join({ name: 'Ann' }).player;
  const b = room.join({ name: 'Ben' }).player;
  const c = room.join({ name: 'Cal' }).player;

  room.startGame(a.id);
  room.terrainId = 'atoll'; // pin the map so the fixtures below are always legal

  room.setPlacement(a.id, rowFleet(0, 0));   // Ann occupies A1..E1 etc, top-left
  room.setPlacement(b.id, rowFleet(0, 10));  // Ben is down at the bottom
  room.setPlacement(c.id, rowFleet(10, 0));  // Cal is top-right

  [a, b, c].forEach((p) => room.confirmPlacement(p.id));
  assert.equal(room.phase, PHASE.PLAYING);
  return { ...h, a, b, c };
}

test('THE CORE MECHANIC: one cell resolves independently per defender', () => {
  const { room, a, b, c } = threePlayerGame();
  const CELL = toIndex(0, 0); // "A1"

  // A1 is water on Ben's board (his fleet is at the bottom) but is Ann's carrier.
  assert.equal(room.currentPlayerId(), a.id);
  room.fire(a.id, { targetId: b.id, cell: CELL });
  assert.equal(b.incoming[CELL], SHOT.MISS, `${label(CELL)} should miss Ben`);

  // Same coordinate, different defender, opposite outcome — and Ben's grid is untouched.
  assert.equal(room.currentPlayerId(), b.id);
  room.fire(b.id, { targetId: a.id, cell: CELL });
  assert.equal(a.incoming[CELL], SHOT.HIT, `${label(CELL)} should hit Ann`);
  assert.equal(b.incoming[CELL], SHOT.MISS, "Ben's grid must not change when Ann is shot");
  assert.equal(c.incoming[CELL], SHOT.NONE, "Cal was never fired at");

  // Cal fires the same coordinate at a third player — still independent, still allowed.
  assert.equal(room.currentPlayerId(), c.id);
  room.fire(c.id, { targetId: b.id, cell: toIndex(0, 10) });

  // Back to Ann: firing A1 at Ben again is a repeat and must be refused...
  assert.equal(room.currentPlayerId(), a.id);
  throwsCode(() => room.fire(a.id, { targetId: b.id, cell: CELL }), 'already_fired');

  // ...but the very same coordinate against Cal is a brand new, legal shot.
  room.fire(a.id, { targetId: c.id, cell: CELL });
  assert.equal(c.incoming[CELL], SHOT.MISS);
});

test('no global shot grid leaks between defenders', () => {
  const { room, a, b, c } = threePlayerGame();
  // Ann shoots every cell of row 5 at Ben; Cal's and Ann's grids stay pristine.
  for (let x = 0; x < 5; x++) {
    const cell = toIndex(x, 5);
    b.incoming[cell] = SHOT.NONE;
    room.turn.pos = room.seating.indexOf(a.id);
    room.fire(a.id, { targetId: b.id, cell });
  }
  for (let x = 0; x < 5; x++) {
    assert.equal(c.incoming[toIndex(x, 5)], SHOT.NONE);
    assert.equal(a.incoming[toIndex(x, 5)], SHOT.NONE);
  }
});

test('sinking a ship reports it, and a wiped fleet eliminates the player', () => {
  const { room, events, a, b } = threePlayerGame();

  // Ben's destroyer sits at (0,14)-(1,14).
  room.turn.pos = room.seating.indexOf(a.id);
  room.fire(a.id, { targetId: b.id, cell: toIndex(0, 14) });
  assert.equal(events.at(-2).result, 'hit');

  room.turn.pos = room.seating.indexOf(a.id);
  room.fire(a.id, { targetId: b.id, cell: toIndex(1, 14) });
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
    room.fire(a.id, { targetId: b.id, cell: toIndex(3, 3) });
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
  room.terrainId = 'atoll';
  room.randomPlacement(b.id); // re-roll on the pinned map so his fleet is legal there

  room.setPlacement(a.id, rowFleet(0, 0));
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
  const landCell = toIndex(7, 7 - 1); // (7,6) is land on the atoll ring
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
  const cell = toIndex(4, 6);

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
  throwsCode(() => room.fire(c.id, { targetId: b.id, cell: toIndex(3, 6) }), 'not_your_turn');
});
