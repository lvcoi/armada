// The single in-memory room. One game per server process.

import { randomUUID } from 'node:crypto';

import {
  PHASE, MSG, ERR, MAX_PLAYERS, MIN_PLAYERS, gridFor,
  TIMER_STOPS, DEFAULT_TURN_LIMIT_MS, DEFAULT_PLACEMENT_LIMIT_MS, DISCONNECT_GRACE_MS,
  MAX_PREMOVES, PREMOVE_DELAY_MS, SHOT,
} from '../shared/constants.js';
import { randomTerrainId, isLand } from '../shared/terrain.js';
import { COUNTRIES, byCountry, powerCells, POWER_BUDGET } from '../shared/countries.js';
import { scatterPowerups, resolvePowerup, applyEffect } from './powerups.js';
import { hurricanePath, hurricaneState, sweepCells } from './hurricane.js';
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
      country: this.freeCountry().id,
      // The country's accent doubles as the player colour, so every existing
      // colour-coded surface picks up the national identity for free.
      color: this.freeCountry().accent,
      powerBudget: 0,       // squares of superpower left; see POWER_BUDGET
      connected: true,
      ready: false,
      eliminated: false,
      ships: [],
      // Boards are sized at startGame, once the head count (and so the grid) is known.
      shipAt: new Int8Array(0),
      incoming: new Uint8Array(0),
      premoves: [],             // [{ targetId, cell }] — fires one per turn until a hit
      powerups: new Map(),      // cell -> POWERUP type hidden on THIS player's water
      reveals: [],              // radar results; projected to this player only
      privateLog: [],           // what only this player is told (their own mine damage)
      selfDamage: [],           // mine hits on their fleet — hidden from the public board
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
    this.roundsPlayed = 0;
    this.stormPhase = null;
    // The storm's track is rolled once, at the start, so every board is churned by the
    // same wandering path rather than each getting its own weather.
    this.stormTrack = hurricanePath(this.grid, this.rng);

    for (const p of this.players) {
      p.incoming = new Uint8Array(this.grid * this.grid);
      p.premoves = [];
      p.reveals = [];
      p.privateLog = [];
      p.selfDamage = [];
      p.powerBudget = POWER_BUDGET;
      this.applyFleet(p, randomFleet(this.terrainId, this.grid, this.rng));
      p.ready = false;
      // Each board hides its own pickups, so the same square can be a mine for one
      // player and open water for another — exactly like the shot grids.
      p.powerups = scatterPowerups(
        this.terrainId, this.grid, new Set(p.ships.flatMap((s) => s.cells)), this.rng,
      );
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

  /**
   * Resolve ONE shot completely — damage, hidden pickup, elimination — without
   * touching whose turn it is. Superpowers fire several of these in a row, and an
   * "extra shot" pickup has to keep the turn, so turn control lives in applyFire.
   */
  resolveShot(attacker, target, cell, { auto = false, premove = false, power = null } = {}) {
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
      ...(power ? { power } : {}),
    };
    this.log.push(record);
    this.bus.event({ t: MSG.FIRE_RESULT, ...record });

    // Taking damage is what invalidates a plan, not dealing it. The DEFENDER's queue
    // is scrapped so they can react to being hit; the attacker's keeps running.
    if (outcome.result !== 'miss') target.premoves = [];

    const extraShot = this.triggerPowerup(attacker, target, cell);

    if (fleetSunk(target)) {
      target.eliminated = true;
      target.premoves = [];
      this.bus.event({ t: MSG.ELIMINATED, playerId: target.id });
    }
    return { outcome, extraShot };
  }

  /**
   * Did that square hide something? Everyone is told WHAT was triggered and by whom —
   * that is the drama — but the consequences that should stay secret (which of your own
   * ships a mine wrecked, what radar showed you) go only to the player they belong to,
   * carried in per-player state rather than a broadcast.
   */
  triggerPowerup(attacker, target, cell) {
    const type = target.powerups?.get(cell);
    if (!type) return false;
    target.powerups.delete(cell);

    const { effects, logNote } = resolvePowerup(
      type, { attacker, defender: target, cell, grid: this.grid, terrainId: this.terrainId }, this.rng,
    );

    let extraShot = false;
    for (const effect of effects) {
      applyEffect(effect, this);
      switch (effect.kind) {
        case 'extraShot':
          extraShot = true;
          break;
        case 'recharge':
          // One more strike, whatever a strike costs your navy.
          attacker.powerBudget += byCountry(attacker.country)?.power.volley ?? 1;
          break;
        case 'reveal': {
          // The scan itself only knows WHICH squares it swept. The contents are read
          // here, where the defender's real state is: hull, and anything hidden in the
          // water — mines included. This is the only place a ship that is still afloat
          // is ever disclosed, and it goes to one player's private channel, never a
          // broadcast and never into the public projection.
          const scanned = target.id === effect.targetId ? target : this.byId(effect.targetId);
          const findings = (effect.cells ?? []).map((c) => ({
            cell: c,
            ship: !!scanned && scanned.shipAt[c] >= 0,
            powerup: scanned?.powerups?.get(c) ?? null,
          }));
          attacker.reveals.push({ targetId: effect.targetId, findings, at: this.now() });
          break;
        }
        case 'selfHit': {
          // A mine is meant to be invisible to everyone else, so the damage counts
          // toward sinking but is scrubbed from the public shot grid. The owner still
          // sees it, via their own private channel.
          attacker.incoming[effect.cell] = SHOT.NONE;
          attacker.selfDamage.push(effect.cell);
          attacker.privateLog.push({
            kind: 'mine', cell: effect.cell, shipType: effect.shipType,
            sunk: !!effect.sinks, at: this.now(),
          });
          if (effect.sinks && fleetSunk(attacker)) {
            attacker.eliminated = true;
            attacker.premoves = [];
            this.bus.event({ t: MSG.ELIMINATED, playerId: attacker.id });
          }
          break;
        }
        case 'heal':
          attacker.privateLog.push({ kind: 'repair', cell: effect.cell, shipType: effect.shipType, at: this.now() });
          break;
        default:
          break;
      }
    }

    const found = {
      t: MSG.POWERUP_FOUND,
      powerup: type,
      attackerId: attacker.id,
      targetId: target.id,
      cell,
      note: logNote,
      at: this.now(),
    };
    this.log.push({ ...found, attackerId: attacker.id, targetId: target.id });
    this.bus.event(found);
    return extraShot;
  }

  applyFire(attacker, target, cell, auto, premove = false) {
    const { outcome, extraShot } = this.resolveShot(attacker, target, cell, { auto, premove });

    if (this.checkGameOver()) return outcome;
    // An "extra shot" pickup keeps the turn — but you have to be at the table to take
    // it. A shot the timer fired on your behalf does not earn you a bonus turn you
    // would only time out of again.
    if (extraShot && !auto && !attacker.eliminated) {
      this.armTurnTimer();
      this.touch();
      return outcome;
    }
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
        // Wrapping past the end of the seating order is one full round played, which
        // is the clock the storm runs on.
        if (pos <= this.turn.pos) this.endOfRound();
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

  // ---------------------------------------------------------------- superpowers

  /**
   * Fire your country's weapon at one defender. The shape is re-derived here from the
   * country definition — the client sends only an anchor (and, for the free-aim and
   * line shapes, its picks) so it can never invent a bigger blast than it is owed.
   *
   * Cells that are land or already spent are skipped rather than rejected: a nuke that
   * clips the coast still detonates.
   */
  firePower(playerId, { targetId, anchor, picked = null }) {
    if (this.phase !== PHASE.PLAYING) fail(ERR.WRONG_PHASE, 'The game is not running');

    const attacker = this.byId(playerId);
    if (!attacker) fail(ERR.BAD_MESSAGE, 'Unknown player');
    if (this.currentPlayerId() !== playerId) fail(ERR.NOT_YOUR_TURN, "It isn't your turn");

    const country = byCountry(attacker.country);
    if (!country) fail(ERR.BAD_MESSAGE, 'You have no navy');
    const { power } = country;
    const need = power.flexible ? 1 : power.volley;
    if (attacker.powerBudget < need) fail(ERR.BAD_MESSAGE, `No ${power.name} left`);

    const target = this.byId(targetId);
    if (!target || target.id === attacker.id || target.eliminated) {
      fail(ERR.BAD_TARGET, 'Pick an opponent still in the game');
    }

    let cells = powerCells(power, anchor ?? 0, this.grid, picked);
    if (!cells || !cells.length) fail(ERR.BAD_MESSAGE, `${power.name} does not fit there`);

    // A flexible power spends one square per pick, so it can never commit more than
    // the budget on the table.
    if (power.flexible) cells = cells.slice(0, attacker.powerBudget);

    // A scatter only lands on some of the box it covers.
    if (power.shape === 'scatter' && cells.length > power.n) {
      const pool = [...cells];
      const picks = [];
      while (picks.length < country.power.n && pool.length) {
        picks.push(pool.splice(Math.floor(this.rng() * pool.length), 1)[0]);
      }
      cells = picks;
    }

    const legal = [...new Set(cells)].filter((c) =>
      Number.isInteger(c) && c >= 0 && c < this.grid * this.grid
      && !isLand(this.terrainId, c, this.grid)
      && target.incoming[c] === SHOT.NONE);
    if (!legal.length) fail(ERR.BAD_MESSAGE, 'Nothing left to hit there');

    // A shaped strike costs its full volley even if the coast ate part of the blast —
    // you fired the weapon. A flexible one costs exactly the pilots you committed.
    attacker.powerBudget -= power.flexible
      ? Math.min(cells.length, attacker.powerBudget)
      : power.volley;
    if (attacker.powerBudget < 0) attacker.powerBudget = 0;

    this.bus.event({
      t: MSG.POWER_FIRE,
      attackerId: attacker.id,
      targetId: target.id,
      power: power.name,
      country: country.id,
      cells: legal,
    });

    // Every cell resolves as an ordinary shot, so mines and pickups still fire.
    for (const cell of legal) {
      if (target.eliminated) break;
      this.resolveShot(attacker, target, cell, { power: power.name });
    }

    if (this.checkGameOver()) return;
    this.advanceTurn();
  }

  // ---------------------------------------------------------------- premoves

  /**
   * Replace this player's queue wholesale. The client always sends the full list,
   * which makes the message idempotent — a retry after flaky wifi can't double-queue.
   * Entries are sanitized here; whether a cell is still fireable is checked again at
   * fire time, because the board keeps changing while shots sit in the queue.
   */
  // ---------------------------------------------------------------- the storm

  /**
   * One full trip round the table. The hurricane is announced a few rounds out, then
   * a band walks across every board at once, scattering ships and — the whole point —
   * wiping everyone's hard-won intel about that strip of ocean.
   */
  endOfRound() {
    if (this.phase !== PHASE.PLAYING) return;
    this.roundsPlayed += 1;

    const state = hurricaneState(this.roundsPlayed, this.stormTrack);
    this.stormPhase = state;
    if (!state) return;

    if (state.phase === 'warning') {
      this.bus.event({ t: MSG.HURRICANE, phase: 'warning', roundsLeft: state.roundsLeft });
      return;
    }
    if (state.phase !== 'active') return;

    const hit = new Set(state.cells);
    let moved = 0;
    let cleared = 0;
    for (const p of this.players) {
      if (p.eliminated) continue;
      const res = sweepCells(p, state.cells, this.grid, this.terrainId, this.rng);
      moved += res.moved;
      cleared += res.cleared;
      // Ships that moved are no longer where anyone thought they were, so radar intel
      // about this board is stale, and hidden mine damage inside the eye is wiped too.
      p.reveals = [];
      p.selfDamage = p.selfDamage.filter((c) => !hit.has(c));
    }

    this.bus.event({
      t: MSG.HURRICANE, phase: 'active', cells: state.cells, center: state.center, moved, cleared,
    });
    this.log.push({
      hurricane: true, cells: state.cells, moved, cleared, at: this.now(),
    });
  }

  // ---------------------------------------------------------------- countries

  /** First navy nobody has claimed — new joiners always land on a free one. */
  freeCountry() {
    const taken = new Set(this.players.map((p) => p.country));
    return COUNTRIES.find((c) => !taken.has(c.id)) ?? COUNTRIES[0];
  }

  setCountry(playerId, countryId) {
    const p = this.byId(playerId);
    if (!p) fail(ERR.BAD_MESSAGE, 'Unknown player');
    if (this.phase !== PHASE.LOBBY) fail(ERR.WRONG_PHASE, 'Navies are locked once the game starts');
    const country = byCountry(countryId);
    if (!country) fail(ERR.BAD_MESSAGE, 'No such navy');
    if (this.players.some((x) => x.id !== playerId && x.country === country.id)) {
      fail(ERR.BAD_MESSAGE, `${country.name} is already taken`);
    }
    p.country = country.id;
    p.color = country.accent;
    this.touch();
  }

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

      // A queued shot that connects does NOT stop the queue — you keep raking. Only
      // being hit yourself scraps your plan (handled in applyFire).
      this.applyFire(attacker, target, cell, false, true);
      this.touch();
      return;
    }
    // Queue drained without a legal shot; the turn continues by hand.
    this.touch();
  }

  /** "Play again" — back to the lobby with the same people, fresh boards. */
  /**
   * Back to the lobby. Allowed from any phase, not just a finished game — somebody
   * always needs to bail out of a half-set-up game. The client guards it behind a
   * confirmation, and it stays host-only.
   */
  resetToLobby(playerId) {
    if (playerId !== this.hostId) fail(ERR.NOT_HOST, 'Only the host can reset the game');
    if (this.phase === PHASE.LOBBY) return; // already there; nothing to tear down

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
      p.powerups = new Map();
      p.reveals = [];
      p.privateLog = [];
      p.selfDamage = [];
      p.powerBudget = 0;
      p.lastNonce = null;
    }
    this.roundsPlayed = 0;
    this.stormPhase = null;

    this.touch();
  }

  dispose() {
    this.clearTimeout(this._turnTimer);
    this.clearTimeout(this._placementTimer);
    this.clearTimeout(this._premoveTimer);
  }
}

export { GameError };
