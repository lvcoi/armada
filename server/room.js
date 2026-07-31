// The single in-memory room. One game per server process.

import { randomUUID } from 'node:crypto';

import {
  PHASE, MSG, ERR, MAX_PLAYERS, MIN_PLAYERS, PLAYER_COLORS, gridFor,
  TIMER_STOPS, DEFAULT_TURN_LIMIT_MS, DEFAULT_PLACEMENT_LIMIT_MS, DISCONNECT_GRACE_MS,
  MAX_PREMOVES, PREMOVE_DELAY_MS,
} from '../shared/constants.js';
import { randomTerrainId, isLand } from '../shared/terrain.js';
import { validateFleet, randomFleet, completeFleet } from '../shared/placement.js';
import { fireAt, fleetSunk, openCells, rejectFire } from './game.js';

class GameError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

const fail = (code, message) => { throw new GameError(code, message); };

/** TIMER_STOPS is the whole permitted set, so an arbitrary number can't be smuggled in. */
const validLimit = (ms) => ms === null || TIMER_STOPS.includes(ms);

export class Room {
  /**
   * @param bus       { event(msg), changed() } — how the room talks to sockets
   * @param scheduler injectable clock so tests don't wait in real time
   */
  constructor(bus, scheduler = {}) {
    this.bus = bus;
    this.setTimeout = scheduler.setTimeout ?? setTimeout;
    this.clearTimeout = scheduler.clearTimeout ?? clearTimeout;
    this.now = scheduler.now ?? (() => Date.now());
    this.rng = scheduler.rng ?? Math.random;

    this.phase = PHASE.LOBBY;
    this.seq = 0;
    this.hostId = null;
    this.terrainId = null;
    this.grid = null;           // board size; decided at startGame from the head count
    this.winnerId = null;
    this.players = [];
    this.log = [];
    this.nextPlayerNum = 1;

    this.settings = {
      turnLimitMs: DEFAULT_TURN_LIMIT_MS,
      placementLimitMs: DEFAULT_PLACEMENT_LIMIT_MS,
    };

    this.seating = [];          // fixed join order; never reshuffled
    this.turn = { pos: 0, deadlineAt: null };
    this.placementDeadlineAt = null;
    this._turnTimer = null;
    this._placementTimer = null;
    this._premoveTimer = null;
  }

  // ---------------------------------------------------------------- helpers

  byId(id) { return this.players.find((p) => p.id === id) ?? null; }
  byToken(token) { return this.players.find((p) => p.token === token) ?? null; }
  alive() { return this.players.filter((p) => !p.eliminated); }
  currentPlayerId() {
    if (this.phase !== PHASE.PLAYING) return null;
    return this.seating[this.turn.pos] ?? null;
  }
  currentPlayer() { return this.byId(this.currentPlayerId()); }

  touch() { this.seq++; this.bus.changed(); }

  // ---------------------------------------------------------------- joining

  join({ token, name }) {
    const existing = token ? this.byToken(token) : null;

    if (existing) {
      existing.connected = true;
      existing.lastSeenAt = this.now();
      if (name && this.phase === PHASE.LOBBY) existing.name = String(name).slice(0, 16);
      this.touch();
      return { player: existing, reconnected: true };
    }

    const clean = String(name ?? '').trim().slice(0, 16);
    if (!clean) fail(ERR.NAME_REQUIRED, 'Pick a name first');
    if (this.phase !== PHASE.LOBBY) fail(ERR.GAME_IN_PROGRESS, 'That game has already started');
    if (this.players.length >= MAX_PLAYERS) fail(ERR.ROOM_FULL, 'This game is full');

    const player = {
      id: `p${this.nextPlayerNum++}`,
      token: randomUUID(),
      name: clean,
      color: PLAYER_COLORS[this.players.length % PLAYER_COLORS.length],
      connected: true,
      ready: false,
      eliminated: false,
      ships: [],
      // Boards are sized at startGame, once the head count (and so the grid) is known.
      shipAt: new Int8Array(0),
      incoming: new Uint8Array(0),
      premoves: [],             // [{ targetId, cell }] — fires one per turn until a hit
      lastSeenAt: this.now(),
      lastNonce: null,
    };

    this.players.push(player);
    this.seating.push(player.id);
    if (!this.hostId) this.hostId = player.id;

    this.touch();
    return { player, reconnected: false };
  }

  disconnect(playerId) {
    const p = this.byId(playerId);
    if (!p) return;
    p.connected = false;
    p.lastSeenAt = this.now();

    // In the lobby nobody has invested anything yet, so drop them and let the slot recycle.
    if (this.phase === PHASE.LOBBY) {
      this.players = this.players.filter((x) => x.id !== playerId);
      this.seating = this.seating.filter((x) => x !== playerId);
      if (this.hostId === playerId) this.hostId = this.players[0]?.id ?? null;
    }

    this.touch();
  }

  // ---------------------------------------------------------------- settings

  setSettings(playerId, { turnLimitMs, placementLimitMs }) {
    if (playerId !== this.hostId) fail(ERR.NOT_HOST, 'Only the host can change settings');
    if (this.phase !== PHASE.LOBBY) fail(ERR.WRONG_PHASE, 'Settings lock when the game starts');

    if (turnLimitMs !== undefined) {
      if (!validLimit(turnLimitMs)) fail(ERR.BAD_MESSAGE, 'Unsupported turn limit');
      this.settings.turnLimitMs = turnLimitMs;
    }
    if (placementLimitMs !== undefined) {
      if (!validLimit(placementLimitMs)) fail(ERR.BAD_MESSAGE, 'Unsupported placement limit');
      this.settings.placementLimitMs = placementLimitMs;
    }
    this.touch();
  }

  // ---------------------------------------------------------------- placement

  startGame(playerId) {
    if (playerId !== this.hostId) fail(ERR.NOT_HOST, 'Only the host can start the game');
    if (this.phase !== PHASE.LOBBY) fail(ERR.WRONG_PHASE, 'The game has already started');
    if (this.players.length < MIN_PLAYERS) {
      fail(ERR.NOT_ENOUGH_PLAYERS, `Need at least ${MIN_PLAYERS} players`);
    }

    this.phase = PHASE.PLACEMENT;
    this.terrainId = randomTerrainId(this.rng);
    // Two players fight close-quarters on 10x10; a full table gets the 15x15 ocean.
    this.grid = gridFor(this.players.length);

    // Everyone starts from a legal random layout, so a player who does nothing at all
    // still has a real fleet and the Random button has something to shuffle away from.
    for (const p of this.players) {
      p.incoming = new Uint8Array(this.grid * this.grid);
      p.premoves = [];
      this.applyFleet(p, randomFleet(this.terrainId, this.grid, this.rng));
      p.ready = false;
    }

    const limit = this.settings.placementLimitMs;
    this.placementDeadlineAt = limit == null ? null : this.now() + limit;
    this.clearTimeout(this._placementTimer);
    if (limit != null) {
      this._placementTimer = this.setTimeout(() => this.onPlacementTimeout(), limit);
    }

    this.touch();
  }

  applyFleet(player, ships) {
    player.ships = ships.map((s) => ({
      type: s.type, len: s.len, anchor: s.anchor, dir: s.dir,
      cells: s.cells, hits: [], sunk: false,
    }));
    player.shipAt = new Int8Array(this.grid * this.grid).fill(-1);
    player.ships.forEach((ship, idx) => {
      ship.cells.forEach((c) => { player.shipAt[c] = idx; });
    });
  }

  requirePlacing(playerId) {
    if (this.phase !== PHASE.PLACEMENT) fail(ERR.WRONG_PHASE, 'Not in the placement phase');
    const p = this.byId(playerId);
    if (!p) fail(ERR.BAD_MESSAGE, 'Unknown player');
    if (p.ready) fail(ERR.WRONG_PHASE, 'Your fleet is already locked in');
    return p;
  }

  setPlacement(playerId, ships) {
    const p = this.requirePlacing(playerId);
    const check = validateFleet(ships, this.terrainId, this.grid);
    if (!check.ok) fail(ERR.BAD_PLACEMENT, check.error);
    this.applyFleet(p, check.ships);
    this.touch();
  }

  randomPlacement(playerId) {
    const p = this.requirePlacing(playerId);
    this.applyFleet(p, randomFleet(this.terrainId, this.grid, this.rng));
    this.touch();
  }

  confirmPlacement(playerId) {
    const p = this.requirePlacing(playerId);
    p.ready = true;
    this.touch();
    if (this.players.every((x) => x.ready)) this.beginPlaying();
  }

  onPlacementTimeout() {
    if (this.phase !== PHASE.PLACEMENT) return;
    for (const p of this.players) {
      if (p.ready) continue;
      // Keep whatever they had placed, fill in the rest, lock them in.
      const partial = p.ships.map(({ type, anchor, dir }) => ({ type, anchor, dir }));
      this.applyFleet(p, completeFleet(partial, this.terrainId, this.grid, this.rng));
      p.ready = true;
    }
    this.beginPlaying();
  }

  // ---------------------------------------------------------------- play

  beginPlaying() {
    this.clearTimeout(this._placementTimer);
    this._placementTimer = null;
    this.placementDeadlineAt = null;

    this.phase = PHASE.PLAYING;
    this.turn.pos = 0;
    this.armTurnTimer();
    this.armPremove();
    this.bus.event({ t: MSG.TURN, playerId: this.currentPlayerId(), deadlineAt: this.turn.deadlineAt });
    this.touch();
  }

  armTurnTimer() {
    this.clearTimeout(this._turnTimer);
    this._turnTimer = null;

    const limit = this.settings.turnLimitMs;
    const current = this.currentPlayer();

    // Someone who dropped off the wifi shouldn't hold the table for a full turn.
    if (current && !current.connected && this.now() - current.lastSeenAt > DISCONNECT_GRACE_MS) {
      this.turn.deadlineAt = this.now();
      this._turnTimer = this.setTimeout(() => this.onTurnTimeout(), 0);
      return;
    }

    if (limit == null) {
      this.turn.deadlineAt = null;
      return;
    }
    this.turn.deadlineAt = this.now() + limit;
    this._turnTimer = this.setTimeout(() => this.onTurnTimeout(), limit);
  }

  fire(playerId, { targetId, cell, nonce }) {
    if (this.phase !== PHASE.PLAYING) fail(ERR.WRONG_PHASE, 'The game is not running');

    const attacker = this.byId(playerId);
    if (!attacker) fail(ERR.BAD_MESSAGE, 'Unknown player');
    if (this.currentPlayerId() !== playerId) fail(ERR.NOT_YOUR_TURN, "It isn't your turn");

    // A retried send (flaky wifi) must not fire twice.
    if (nonce && attacker.lastNonce === nonce) return;

    const target = this.byId(targetId);
    if (!target || target.id === playerId || target.eliminated) {
      fail(ERR.BAD_TARGET, 'Pick a player who is still in the game');
    }

    const why = rejectFire(target, cell, this.terrainId, this.grid);
    if (why) fail(why, {
      bad_cell: 'That square is off the board',
      cell_is_land: 'That square is land',
      already_fired: "You've already fired there",
    }[why]);

    attacker.lastNonce = nonce ?? null;
    // A hand-aimed shot supersedes anything queued earlier for this turn.
    this.clearTimeout(this._premoveTimer);
    this._premoveTimer = null;
    this.applyFire(attacker, target, cell, false);
  }

  applyFire(attacker, target, cell, auto, premove = false) {
    const outcome = fireAt(target, cell);

    const record = {
      attackerId: attacker.id,
      targetId: target.id,
      cell,
      result: outcome.result,
      ...(outcome.shipType ? { shipType: outcome.shipType } : {}),
      at: this.now(),
      auto,
      ...(premove ? { premove: true } : {}),
    };
    this.log.push(record);
    this.bus.event({ t: MSG.FIRE_RESULT, ...record });

    if (fleetSunk(target)) {
      target.eliminated = true;
      target.premoves = [];
      this.bus.event({ t: MSG.ELIMINATED, playerId: target.id });
    }

    if (this.checkGameOver()) return outcome;
    this.advanceTurn();
    return outcome;
  }

  checkGameOver() {
    const alive = this.alive();
    if (alive.length > 1) return false;

    this.phase = PHASE.OVER;
    this.winnerId = alive[0]?.id ?? null;
    this.clearTimeout(this._turnTimer);
    this._turnTimer = null;
    this.clearTimeout(this._premoveTimer);
    this._premoveTimer = null;
    this.turn.deadlineAt = null;
    this.bus.event({ t: MSG.OVER, winnerId: this.winnerId });
    this.touch();
    return true;
  }

  advanceTurn() {
    // Walk the fixed seating order, skipping anyone knocked out. Because seating never
    // changes, eliminating a player can't shift indices and skip somebody's turn.
    for (let step = 1; step <= this.seating.length; step++) {
      const pos = (this.turn.pos + step) % this.seating.length;
      const p = this.byId(this.seating[pos]);
      if (p && !p.eliminated) {
        this.turn.pos = pos;
        this.armTurnTimer();
        this.armPremove();
        this.bus.event({ t: MSG.TURN, playerId: p.id, deadlineAt: this.turn.deadlineAt });
        this.touch();
        return;
      }
    }
    this.checkGameOver();
  }

  onTurnTimeout() {
    if (this.phase !== PHASE.PLAYING) return;
    const attacker = this.currentPlayer();
    if (!attacker) return;

    // Fire one random legal shot at a random opponent who still has squares left.
    const targets = this.alive()
      .filter((p) => p.id !== attacker.id)
      .map((p) => ({ player: p, cells: openCells(p, this.terrainId, this.grid) }))
      .filter((t) => t.cells.length > 0);

    if (!targets.length) {
      this.advanceTurn();
      return;
    }

    const pick = targets[Math.floor(this.rng() * targets.length)];
    const cell = pick.cells[Math.floor(this.rng() * pick.cells.length)];
    this.applyFire(attacker, pick.player, cell, true);
  }

  // ---------------------------------------------------------------- premoves

  /**
   * Replace this player's queue wholesale. The client always sends the full list,
   * which makes the message idempotent — a retry after flaky wifi can't double-queue.
   * Entries are sanitized here; whether a cell is still fireable is checked again at
   * fire time, because the board keeps changing while shots sit in the queue.
   */
  setPremoves(playerId, list) {
    const p = this.byId(playerId);
    if (!p) fail(ERR.BAD_MESSAGE, 'Unknown player');
    if (this.phase !== PHASE.PLACEMENT && this.phase !== PHASE.PLAYING) {
      fail(ERR.WRONG_PHASE, 'You can only queue shots during a game');
    }
    if (!Array.isArray(list)) fail(ERR.BAD_MESSAGE, 'Bad premove list');

    const seen = new Set();
    const clean = [];
    for (const entry of list) {
      if (clean.length >= MAX_PREMOVES) break;
      const target = this.byId(entry?.targetId);
      const cell = entry?.cell;
      if (!target || target.id === playerId || target.eliminated) continue;
      if (!Number.isInteger(cell) || cell < 0 || cell >= this.grid * this.grid) continue;
      if (isLand(this.terrainId, cell, this.grid)) continue;
      const key = `${target.id}:${cell}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push({ targetId: target.id, cell });
    }
    p.premoves = clean;
    this.touch();
  }

  /** Called at every turn start: give the room a beat, then fire the head of the queue. */
  armPremove() {
    this.clearTimeout(this._premoveTimer);
    this._premoveTimer = null;
    if (this.phase !== PHASE.PLAYING) return;
    const current = this.currentPlayer();
    if (!current || !current.premoves.length) return;
    this._premoveTimer = this.setTimeout(() => this.firePremove(current.id), PREMOVE_DELAY_MS);
  }

  firePremove(playerId) {
    if (this.phase !== PHASE.PLAYING) return;
    if (this.currentPlayerId() !== playerId) return;
    const attacker = this.byId(playerId);
    if (!attacker || attacker.eliminated) return;

    while (attacker.premoves.length) {
      const { targetId, cell } = attacker.premoves.shift();
      const target = this.byId(targetId);
      // Stale entries — target eliminated, or someone else already shot that cell — are
      // skipped silently and the next queued shot steps up.
      if (!target || target.eliminated) continue;
      if (rejectFire(target, cell, this.terrainId, this.grid)) continue;

      const outcome = this.applyFire(attacker, target, cell, false, true);
      // The queue exists to rake open water. The moment a shell connects, the rest of
      // the plan is stale intel — clear it and give the aiming back to the player.
      if (outcome.result !== 'miss') attacker.premoves = [];
      this.touch();
      return;
    }
    // Queue drained without a legal shot; the turn continues by hand.
    this.touch();
  }

  /** "Play again" — back to the lobby with the same people, fresh boards. */
  resetToLobby(playerId) {
    if (playerId !== this.hostId) fail(ERR.NOT_HOST, 'Only the host can start a new game');
    if (this.phase !== PHASE.OVER) fail(ERR.WRONG_PHASE, 'Finish this game first');

    this.clearTimeout(this._turnTimer);
    this.clearTimeout(this._placementTimer);
    this.clearTimeout(this._premoveTimer);
    this._turnTimer = null;
    this._placementTimer = null;
    this._premoveTimer = null;

    this.phase = PHASE.LOBBY;
    this.terrainId = null;
    this.grid = null;
    this.winnerId = null;
    this.log = [];
    this.turn = { pos: 0, deadlineAt: null };
    this.placementDeadlineAt = null;

    // Anyone who wandered off between games gives up their slot.
    this.players = this.players.filter((p) => p.connected);
    this.seating = this.players.map((p) => p.id);
    if (!this.players.some((p) => p.id === this.hostId)) {
      this.hostId = this.players[0]?.id ?? null;
    }

    for (const p of this.players) {
      p.ready = false;
      p.eliminated = false;
      p.ships = [];
      p.shipAt = new Int8Array(0);
      p.incoming = new Uint8Array(0);
      p.premoves = [];
      p.lastNonce = null;
    }

    this.touch();
  }

  dispose() {
    this.clearTimeout(this._turnTimer);
    this.clearTimeout(this._placementTimer);
    this.clearTimeout(this._premoveTimer);
  }
}

export { GameError };
