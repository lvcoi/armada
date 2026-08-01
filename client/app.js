// Client state machine. One render() off a single state object, delegated events,
// no framework and no build step.

import {
  MSG, PHASE, FLEET, TIMER_STOPS, timerLabel, MIN_PLAYERS,
  MAX_PREMOVES, gridFor, COLLECTABLE, NEEDS_TARGET, ITEM_LABEL, ITEM_GLYPH, POWERUP, SHOT,
} from '/shared/constants.js';
import { label, shipCells } from '/shared/coords.js';
import { canPlace } from '/shared/placement.js';
import { Net, savedToken, savedName, forgetSession } from '/net.js';
import { boardHTML, shipChipHTML, flagHTML } from '/board.js';
import { COUNTRIES, byCountry, powerCells } from '/shared/countries.js';
import * as fx from '/fx.js';
import * as sound from '/sound.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

const ui = {
  connected: false,
  you: null,        // { id }
  state: null,
  tab: null,        // player id whose board is showing
  target: null,     // armed shot { targetId, cell }
  selShip: null,    // ship type being placed
  anchor: null,     // chosen anchor awaiting a direction
  premoves: [],     // local working copy of the queue; server echo is authoritative
  dragging: false,  // a swipe-to-queue gesture is in flight
  arming: false,    // aiming the country superpower rather than a normal shot
  usingItem: null,  // a carried item that needs a square picked before it does anything
  picks: [],        // cells chosen so far for a free-aim / line power
  confirm: null,    // { act, title, body, danger } -> a modal awaiting a yes/no
  plop: false,      // one-shot: hulls play their arrival pop on the next render
  swapDir: null,    // one-shot: board slides in from this side after a tab change
  serverGone: false,
};

let lastKey = '';
let toastTimer = null;
let stormRoaring = false; // the storm roar plays once per crossing, not once per step

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const me = () => ui.state?.players.find((p) => p.id === ui.you?.id) ?? null;
const others = () => ui.state?.players.filter((p) => p.id !== ui.you?.id) ?? [];
const isHost = () => ui.state && ui.you && ui.state.hostId === ui.you.id;
const isMyTurn = () => ui.state?.turn?.playerId === ui.you?.id;
const grid = () => ui.state?.grid ?? 15;

function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
}

function buzz(ms) {
  try { navigator.vibrate?.(ms); } catch { /* unsupported, no matter */ }
}

// ------------------------------------------------------------------ network

const net = new Net({
  onOpen() {
    ui.connected = true;
    ui.serverGone = false;
    fx.signalLost(false);
    schedule();
  },
  onClose() {
    ui.connected = false;
    fx.signalLost(true);
    schedule();
  },
  onMessage(msg) {
    switch (msg.t) {
      case MSG.WELCOME:
        ui.you = msg.you;
        break;
      case MSG.STATE:
        applyState(msg);
        break;
      case MSG.FIRE_RESULT:
        if (msg.result === 'hit' || msg.result === 'sunk') buzz(msg.targetId === ui.you?.id ? 120 : 40);
        fxShot(msg);
        break;
      case MSG.TURN: {
        if (msg.playerId === ui.you?.id) {
          buzz([40, 60, 40]);
          fx.banner('YOU HAVE THE CONN', null, true);
          sound.play('ping', sound.LEVEL.SELF);
        } else {
          const p = ui.state?.players.find((x) => x.id === msg.playerId);
          if (p) fx.banner(`${p.name.toUpperCase()} HAS THE CONN`, p.color, false);
        }
        break;
      }
      case MSG.ELIMINATED: {
        const p = ui.state?.players.find((x) => x.id === msg.playerId);
        const isMe = p?.id === ui.you?.id;
        fx.stamp(isMe ? 'YOUR FLEET IS DESTROYED' : `${(p?.name ?? '').toUpperCase()} — FLEET DESTROYED`);
        if (isMe) buzz(200);
        sound.play('eliminated', isMe ? sound.LEVEL.SELF : sound.LEVEL.OTHER);
        break;
      }
      case MSG.POWER_FIRE:
        sound.play('power', msg.targetId === ui.you?.id ? sound.LEVEL.SELF
          : msg.attackerId === ui.you?.id ? sound.LEVEL.MINE : sound.LEVEL.OTHER);
        break;
      case MSG.POWERUP_FOUND: {
        const byMe = msg.attackerId === ui.you?.id;
        const who = ui.state?.players.find((p) => p.id === msg.attackerId);
        const isMine = msg.powerup === 'mine';
        sound.play(isMine ? 'mine' : 'pickup', byMe ? sound.LEVEL.SELF : sound.LEVEL.OTHER);

        // These are public events — everybody watches the blast or the pickup, not
        // just whoever triggered it.
        const rect = cellRect(msg.targetId, msg.cell);
        if (rect) {
          if (isMine) fx.mineBlast(rect);
          else fx.pickupCollected(rect, msg.powerup, who?.color);
        }
        fx.banner(
          `${(who?.name ?? '?').toUpperCase()} ${String(msg.note ?? '').toUpperCase()}`,
          who?.color, isMine,
        );
        if (byMe && isMine) buzz([90, 60, 90]);
        break;
      }
      case MSG.ITEM_USE: {
        const mine = msg.playerId === ui.you?.id;
        sound.play('pickup', mine ? sound.LEVEL.SELF : sound.LEVEL.OTHER);
        if (mine) fx.banner(`${ITEM_LABEL[msg.item] ?? 'ITEM'} USED`.toUpperCase(), null, false);
        break;
      }
      case MSG.HURRICANE:
        // Only the first step of the crossing gets the roar; it fires every ~700ms.
        if (msg.phase === 'warning') sound.play('alarm', sound.LEVEL.SELF);
        else if (msg.phase === 'active' && !stormRoaring) {
          stormRoaring = true;
          sound.play('storm', sound.LEVEL.SELF);
        } else if (msg.phase === 'passed') stormRoaring = false;
        break;
      case MSG.ERROR:
        handleError(msg);
        break;
      default:
        break;
    }
    schedule();
  },
});

/** Rect of a cell on the board currently on screen for that defender, if visible. */
function cellRect(targetId, cell) {
  return app
    .querySelector(`.board-wrap[data-board="${targetId}"] [data-cell="${cell}"]`)
    ?.getBoundingClientRect() ?? null;
}

/** Route one shot's result to the FX layer. */
function fxShot(msg) {
  const mine = msg.targetId === ui.you?.id;
  const byMe = msg.attackerId === ui.you?.id;
  if (mine && (msg.result === 'hit' || msg.result === 'sunk')) fx.struck();

  // Loudest when it lands on you, normal when you fired it, background otherwise.
  const level = mine ? sound.LEVEL.SELF : byMe ? sound.LEVEL.MINE : sound.LEVEL.OTHER;
  if (byMe || mine) sound.play('fire', level * 0.7);

  const rect = cellRect(msg.targetId, msg.cell);
  if (!rect) {
    // The board is not on screen, but the shot still deserves to be heard.
    sound.play(msg.result === 'miss' ? 'miss' : msg.result === 'sunk' ? 'sunk' : 'hit', level);
    return;
  }

  const land = () => {
    if (msg.result === 'miss') fx.splash(rect);
    else fx.burst(rect);
    if (msg.result === 'sunk') fx.smoke(rect);
    sound.play(msg.result === 'miss' ? 'miss' : msg.result === 'sunk' ? 'sunk' : 'hit', level);
  };

  if (mine) fx.shell(rect, land);
  else if (msg.premove && msg.attackerId === ui.you?.id) fx.tracer(rect, land);
  else land();
}

function applyState(msg) {
  const prev = ui.state;
  ui.state = msg;

  // A stale token (server restarted, or a finished game) means we are not in this room.
  if (ui.you && !msg.players.some((p) => p.id === ui.you.id)) {
    ui.you = null;
    forgetSession();
  }

  if (prev?.phase !== msg.phase) {
    ui.target = null;
    ui.anchor = null;
    ui.selShip = null;
    ui.tab = null;
  }
  if (!ui.tab || !msg.players.some((p) => p.id === ui.tab)) {
    ui.tab = others().find((p) => !p.eliminated)?.id ?? ui.you?.id ?? null;
  }

  // The server's copy of the queue wins — except mid-swipe, when clobbering the local
  // list would drop the cells still under the player's finger.
  if (!ui.dragging) {
    ui.premoves = (me()?.premoves ?? []).map((m) => ({ ...m }));
  }

  if (prev && prev.phase !== PHASE.OVER && msg.phase === PHASE.OVER) {
    const winner = msg.players.find((p) => p.id === msg.winnerId);
    fx.victory(winner?.color);
    sound.play('victory', sound.LEVEL.SELF);
  }
}

function sendPremoves() {
  net.send({ t: MSG.PREMOVE_SET, premoves: ui.premoves });
}

function handleError(msg) {
  if (msg.code === 'game_in_progress' || msg.code === 'room_full') {
    ui.serverGone = false;
    forgetSession();
    ui.you = null;
  }
  toast(msg.message || msg.code);
  ui.target = null;
}

// ------------------------------------------------------------------ screens

function screen() {
  if (!ui.connected) return 'offline';
  if (!ui.you || !ui.state) return 'join';
  switch (ui.state.phase) {
    case PHASE.PLACEMENT: return 'placement';
    case PHASE.PLAYING: return 'battle';
    case PHASE.OVER: return 'over';
    default: return 'lobby';
  }
}

function remaining(deadlineAt) {
  if (deadlineAt == null) return null;
  return Math.max(0, deadlineAt - net.now());
}

function clockHTML(ms) {
  if (ms == null) return '<div class="timer none">No limit</div>';
  const s = Math.ceil(ms / 1000);
  const txt = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `<div class="timer${s <= 5 ? ' warn crit' : s <= 15 ? ' warn' : ''}">${txt}</div>`;
}

function topbar(title, sub, deadlineAt) {
  const m = sound.isMuted();
  return `<header class="topbar">
    <div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    <button class="mute${m ? ' off' : ''}" data-act="mute"
      aria-pressed="${m}" aria-label="${m ? 'Turn sound on' : 'Turn sound off'}"
      title="${m ? 'Sound off' : 'Sound on'}">${m ? '🔇' : '🔊'}</button>
    ${clockHTML(remaining(deadlineAt))}
  </header>`;
}

/** The storm banner — everyone gets the same warning, which is the whole point. */
function stormHTML() {
  const st = ui.state?.storm;
  if (!st) return '';
  if (st.phase === 'warning') {
    return `<div class="storm warn">⛈ <b>Hurricane inbound</b> — ${st.roundsLeft} round${
      st.roundsLeft === 1 ? '' : 's'}. Ships caught in it get scattered.</div>`;
  }
  if (st.phase === 'active') {
    return '<div class="storm live">🌀 <b>Hurricane over the fleet</b> — ships in the eye '
      + 'are being scattered and that water is being wiped clean.</div>';
  }
  return '';
}

/** What you are carrying. Items are free actions — spending one doesn't cost your shot. */
function itemsHTML(my, canAct) {
  const held = COLLECTABLE.filter((k) => (my.items?.[k] ?? 0) > 0);
  if (!held.length) return '';

  // A repair crew with nothing to repair is refused by the server, so don't offer it —
  // an item that silently does nothing when tapped feels broken.
  const hurt = (my.selfDamage?.length ?? 0) > 0
    || (my.ships ?? []).some((s) => (s.cells ?? []).some((c) => my.incoming[c] === SHOT.HIT));

  const chips = held.map((k) => {
    const dead = !canAct || (k === POWERUP.REPAIR && !hurt);
    const why = k === POWERUP.REPAIR && !hurt && canAct
      ? 'Nothing to repair — your fleet is unscathed'
      : ITEM_LABEL[k];
    return `<button class="item" data-item="${k}" ${dead ? 'disabled' : ''} title="${esc(why)}">
      <span class="ig">${ITEM_GLYPH[k]}</span>
      <span class="il">${esc(ITEM_LABEL[k])}</span>
      <span class="ic">×${my.items[k]}</span>
    </button>`;
  }).join('');
  return `<div class="items">${chips}</div>`;
}

/** A yes/no sheet. Used for the host reset, which is not something to fat-finger. */
function confirmHTML() {
  const c = ui.confirm;
  if (!c) return '';
  return `<div class="modal-wrap" role="dialog" aria-modal="true" aria-label="${esc(c.title)}">
    <div class="modal">
      <h3>${esc(c.title)}</h3>
      <p class="dim">${esc(c.body)}</p>
      <div class="row">
        <button class="btn ghost" data-act="confirm-no">Cancel</button>
        <button class="btn ${c.danger ? 'fire' : 'primary'}" data-act="confirm-yes">${esc(c.yes)}</button>
      </div>
    </div>
  </div>`;
}

function playerRow(p) {
  const tags = [
    p.id === ui.state.hostId ? 'HOST' : '',
    p.connected ? '' : 'NO SIGNAL',
    p.eliminated ? 'SUNK' : '',
    ui.state.phase === PHASE.PLACEMENT && p.ready ? 'READY' : '',
  ].filter(Boolean).map((t) => `[${t}]`).join(' ');
  const c = byCountry(p.country);
  return `<div class="player${p.connected ? '' : ' off'}" style="--pc:${p.color}">
    ${flagHTML(p.country, 22) || `<span class="avatar">${esc(p.name.slice(0, 1).toUpperCase())}</span>`}
    <span class="nm">${esc(p.name)}${c ? `<span class="navy">${esc(c.short)}</span>` : ''}</span>
    <span class="badge">${tags}</span>
  </div>`;
}

// -------------------------------------------------- offline / join

function offlineScreen() {
  return `${topbar('Armada', ui.serverGone ? 'Signal lost' : 'Hailing…')}
    <main>
      <div class="card center">
        <p class="big">${ui.serverGone ? 'SIGNAL LOST' : 'HAILING'}<span class="cursor">▍</span></p>
        <p class="dim">Make sure you are on the same wifi as the person hosting the game.
        This will reconnect on its own.</p>
      </div>
    </main>`;
}

function joinScreen() {
  return `${topbar('Armada', 'Battleship on the home wifi')}
    <main>
      <div class="join-hero">
        <div class="rose"><span class="ping"></span></div>
        <h1 class="hero-title">Armada</h1>
        <p class="hero-sub">NAVAL COMBAT · HOME WIFI</p>
      </div>
      <div class="card">
        <div class="field">
          <label for="nm">Enter callsign</label>
          <input id="nm" type="text" maxlength="16" autocomplete="off"
                 autocapitalize="words" placeholder="Your name" value="${esc(savedName())}">
        </div>
      </div>
      <button class="btn primary" data-act="join">Join the game</button>
      <p class="dim center">Up to 4 players. Everyone plays on their own phone.</p>
    </main>`;
}

// -------------------------------------------------- lobby

function limitSlider(id, value, name) {
  const idx = Math.max(0, TIMER_STOPS.indexOf(value));
  return `<div class="field">
    <label for="${id}">${name}: <b>${timerLabel(value)}</b></label>
    <input id="${id}" type="range" min="0" max="${TIMER_STOPS.length - 1}"
           value="${idx}" data-limit="${id}">
  </div>`;
}

/** Pick your navy. Taken ones are shown but disabled, so you can see the field. */
function navyPicker() {
  const s = ui.state;
  const mine = me();
  const takenBy = new Map(s.players.map((p) => [p.country, p]));
  const cards = COUNTRIES.map((c) => {
    const owner = takenBy.get(c.id);
    const isMine = owner?.id === ui.you?.id;
    const taken = owner && !isMine;
    return `<button class="navy-card${isMine ? ' mine' : ''}${taken ? ' taken' : ''}"
      data-navy="${c.id}" style="--pc:${c.accent}" ${taken ? 'disabled' : ''}
      aria-pressed="${isMine}">
      ${flagHTML(c.id, 26)}
      <span class="navy-body">
        <span class="navy-name">${esc(c.name)}</span>
        <span class="navy-era">${esc(c.era)}</span>
        <span class="navy-power"><b>${esc(c.power.name)}</b> — ${esc(c.power.blurb)}</span>
      </span>
      ${taken ? `<span class="navy-taken">${esc(owner.name)}</span>` : ''}
    </button>`;
  }).join('');

  return `<div class="card">
    <h2>Your navy${mine?.country ? ` — ${esc(byCountry(mine.country)?.name ?? '')}` : ''}</h2>
    <div class="navies">${cards}</div>
  </div>`;
}

function lobbyScreen() {
  const s = ui.state;
  const enough = s.players.length >= MIN_PLAYERS;
  const g = gridFor(s.players.length);
  const empty = Array.from({ length: 4 - s.players.length }, () =>
    '<div class="player ghost-seat"><span class="avatar">·</span><span class="seat dim">Awaiting challenger…</span></div>').join('');
  return `${topbar('Lobby', `Crew manifest — ${s.players.length}/4 aboard`)}
    <main>
      <div class="card">
        <h2>Players</h2>
        <div class="players">${s.players.map(playerRow).join('')}${empty}</div>
        ${enough ? `<p class="dim boardsize">Battle plot for ${s.players.length} captains: <b>${g}×${g}</b></p>` : ''}
      </div>
      ${navyPicker()}
      <div class="card">
        <h2>Settings${isHost() ? '' : ' (host only)'}</h2>
        ${isHost()
          ? limitSlider('turnLimitMs', s.settings.turnLimitMs, 'Turn timer')
            + limitSlider('placementLimitMs', s.settings.placementLimitMs, 'Setup timer')
          : `<p class="dim">Turn timer: <b>${timerLabel(s.settings.turnLimitMs)}</b><br>
             Setup timer: <b>${timerLabel(s.settings.placementLimitMs)}</b></p>`}
      </div>
      ${isHost()
        ? `<button class="btn primary" data-act="start" ${enough ? '' : 'disabled'}>
             ${enough ? 'Start the game' : `Need ${MIN_PLAYERS - s.players.length} more player(s)`}
           </button>`
        : '<p class="dim center">Waiting for the host to start…</p>'}
    </main>`;
}

// -------------------------------------------------- placement

/** Cells taken by my ships, optionally ignoring one I'm moving. */
function occupiedExcept(type) {
  const set = new Set();
  for (const s of me().ships) {
    if (s.type === type) continue;
    s.cells?.forEach((c) => set.add(c));
  }
  return set;
}

function draftFleet() {
  return me().ships.map((s) => ({ type: s.type, anchor: s.cells[0], dir: dirOf(s) }));
}

const dirOf = (ship) =>
  ship.cells.length > 1 && ship.cells[1] === ship.cells[0] + 1 ? 'h' : 'v';

function placementScreen() {
  const s = ui.state;
  const my = me();
  const def = FLEET.find((f) => f.type === ui.selShip);
  const occupied = ui.selShip ? occupiedExcept(ui.selShip) : new Set();

  let ghost = null;
  if (def && ui.anchor != null) {
    const dirs = ['h', 'v'].filter((d) => canPlace(ui.anchor, d, def.len, s.terrainId, occupied, s.grid));
    const cells = shipCells(ui.anchor, dirs[0] ?? 'h', def.len, s.grid);
    ghost = { cells: cells ?? [ui.anchor], bad: dirs.length === 0, type: def.type };
  }

  const chips = FLEET.map((f) => {
    const placed = my.ships.find((x) => x.type === f.type);
    return `<button class="chip" data-ship="${f.type}"
      aria-pressed="${ui.selShip === f.type}">
      ${shipChipHTML(f.type)}
      <span class="chip-nm">${f.name}</span>
      <span class="len">${placed ? '▸' : '?'}</span>
    </button>`;
  }).join('');

  const sheet = my.ready
    ? `<div class="sheet"><p class="center dim">Fleet locked — awaiting the other captains<span class="cursor">▍</span></p></div>`
    : ui.anchor != null && def
      ? `<div class="sheet">
           <div class="label">${def.name} at <b class="coord">${label(ui.anchor, s.grid)}</b></div>
           <div class="row">
             <button class="btn" data-act="place" data-dir="h"
               ${canPlace(ui.anchor, 'h', def.len, s.terrainId, occupied, s.grid) ? '' : 'disabled'}>→ Across</button>
             <button class="btn" data-act="place" data-dir="v"
               ${canPlace(ui.anchor, 'v', def.len, s.terrainId, occupied, s.grid) ? '' : 'disabled'}>↓ Down</button>
           </div>
           <button class="btn ghost" data-act="cancel-place">Cancel</button>
         </div>`
      : `<div class="sheet">
           <div class="row">
             <button class="btn" data-act="random">Scramble</button>
             <button class="btn primary" data-act="ready">Lock fleet</button>
           </div>
         </div>`;

  const plop = ui.plop;
  return `${topbar('Deploy the fleet',
      ui.selShip ? `Tap a square for your ${def.name.toLowerCase()}` : 'Tap a ship, then a square',
      s.placementDeadlineAt)}
    <main>
      <div class="chips">${chips}</div>
      <div class="board-wrap" data-board="own" style="--pc:${my.color}">
        ${boardHTML({
          grid: s.grid, land: s.land, incoming: my.incoming, ships: my.ships,
          ghost, plop, name: 'Your waters', disabled: my.ready,
        })}
      </div>
      <div class="card">
        <h2>Fleet status</h2>
        <div class="players">${s.players.map(playerRow).join('')}</div>
      </div>
    </main>
    ${sheet}`;
}

// -------------------------------------------------- battle

function tabsHTML() {
  const my = me();
  const turnId = ui.state.turn?.playerId;
  const tabs = [my, ...others()].map((p) => {
    const isMine = p.id === ui.you.id;
    const pips = Array.from({ length: FLEET.length }, (_, i) =>
      `<span class="pip${i < p.shipsRemaining ? ' on' : ''}"></span>`).join('');
    return `<button class="tab${p.eliminated ? ' out' : ''}${p.id === turnId ? ' turn' : ''}"
      data-tab="${p.id}" style="--pc:${p.color}" aria-selected="${ui.tab === p.id}">
      <span class="nm">${flagHTML(p.country, 11)}${isMine ? 'You' : esc(p.name)}</span>
      <span class="pips">${pips}</span>
      <span class="swatch"></span>
    </button>`;
  }).join('');
  return `<div class="tabs">${tabs}</div>`;
}

function feedHTML() {
  const s = ui.state;
  const name = (id) => s.players.find((p) => p.id === id)?.name ?? '?';
  const lines = s.log.slice(-8).reverse().map((r) => {
    const verb = r.result === 'sunk'
      ? `<span class="sunk">SANK the ${r.shipType}!</span>`
      : r.result === 'hit' ? '<span class="hit">HIT</span>' : 'missed';
    const tag = r.premove ? ' <span class="auto">[AUTO]</span>'
      : r.auto ? ' <span class="auto">[TIMEOUT]</span>' : '';
    const who = (id) => {
      const p = s.players.find((x) => x.id === id);
      return `<b style="--pc:${p?.color ?? 'inherit'}">${esc(p?.name ?? '?')}</b>`;
    };
    return `<div class="line">${who(r.attackerId)} → ${who(r.targetId)}
      <span class="coord">${label(r.cell, s.grid)}</span> ${verb}${tag}</div>`;
  }).join('');
  return `<div class="card"><h2>Combat log</h2><div class="feed">${lines || '<div class="line">No shots yet.</div>'}</div></div>`;
}

/**
 * Which cells the armed superpower would hit right now, for the on-board preview.
 * Free-aim powers show exactly what you have picked; the shaped ones preview from
 * the anchor you last tapped.
 */
function aimCells(power, viewing) {
  if (!power) return null;
  const g = grid();
  if (power.shape === 'free') return new Set(ui.picks);
  if (ui.anchor == null) return new Set();
  const cells = powerCells(power, ui.anchor, g, power.shape === 'line' ? ui.lineDir : null);
  if (!cells) return new Set([ui.anchor]);
  return new Set(cells.filter((c) => !ui.state.land.includes(c) && viewing.incoming[c] === 0));
}

function battleScreen() {
  const s = ui.state;
  const my = me();
  const viewing = s.players.find((p) => p.id === ui.tab) ?? my;
  const viewingSelf = viewing.id === ui.you.id;
  const turnName = s.players.find((p) => p.id === s.turn.playerId)?.name ?? '';

  const canFire = isMyTurn() && !my.eliminated && !viewingSelf && !viewing.eliminated;
  // Off-turn, a live opponent's board becomes the premove queue surface.
  const canQueue = !isMyTurn() && !my.eliminated && !viewingSelf && !viewing.eliminated;

  // 1-based firing order for queue badges on the board being viewed.
  const pmMap = new Map();
  ui.premoves.forEach((m, i) => {
    if (m.targetId === viewing.id) pmMap.set(m.cell, i + 1);
  });

  const chips = ui.premoves.map((m, i) =>
    `<button class="qchip" data-act="unqueue" data-idx="${i}">
       <span class="coord">${label(m.cell, s.grid)}</span><span class="qn">${i + 1}</span>
     </button>`).join('');
  const queueNote = ui.premoves.length
    ? `<div class="queue-note">
         <span class="qcount">QUEUE ${ui.premoves.length}/${MAX_PREMOVES}</span>
         <span class="qchips">${chips}</span>
         <button class="btn ghost slim" data-act="clear-queue">Clear</button>
       </div>
       <p class="center dim qhint">They fire on your turns until one hits. Tap a chip to drop it.</p>`
    : canQueue
      ? '<p class="center dim qhint">QUEUE EMPTY — tap or swipe their waters to plot shots.</p>'
      : '';

  // Radar intel and your own hidden mine damage, both private to you.
  const scan = new Map();
  for (const r of my.reveals ?? []) {
    if (r.targetId !== viewing.id) continue;
    for (const f of r.findings ?? []) scan.set(f.cell, f);
  }
  const power = byCountry(my.country)?.power ?? null;

  // A flexible power (Japan's pilots) is ready as soon as you have picked at least one;
  // everything else needs its whole shape on the board.
  const budget = my.powerBudget ?? 0;
  const strikes = power ? Math.floor(budget / power.volley) : 0;
  const ready = ui.arming && power && aimCells(power, viewing)?.size > 0
    && (power.shape !== 'free'
      || (power.flexible ? ui.picks.length >= 1 : ui.picks.length === power.n));
  const armedSheet = `<div class="sheet">
      <div class="label">${esc(power?.name ?? '')} → <b>${esc(viewing.name)}</b></div>
      <p class="center dim qhint">${power?.flexible
        ? `Send as many as you like — <b>${ui.picks.length}</b> of ${budget} left this game.`
        : power?.shape === 'free'
          ? `Tap ${power.n} squares (${ui.picks.length}/${power.n} chosen).`
          : power?.shape === 'line'
            ? 'Tap a square, then choose the direction.'
            : 'Tap a square — it anchors the top-left of the blast.'}</p>
      ${power?.shape === 'line' ? `<div class="row">
        <button class="btn${ui.lineDir === 'h' ? ' primary' : ''}" data-linedir="h">→ Across</button>
        <button class="btn${ui.lineDir === 'v' ? ' primary' : ''}" data-linedir="v">↓ Down</button>
      </div>` : ''}
      <button class="btn fire" data-act="power-fire" ${ready ? '' : 'disabled'}>Unleash</button>
      <button class="btn ghost" data-act="power-cancel">Cancel</button>
    </div>`;

  const powerBtn = (power && budget >= power.volley && isMyTurn() && !my.eliminated && !viewingSelf)
    ? `<button class="btn power" data-act="power-arm">
         ${flagHTML(my.country, 14)} ${esc(power.name)}
         <span class="uses">${power.flexible ? `${budget} left` : `×${strikes}`}</span>
       </button>`
    : '';

  const sheet = my.eliminated
    ? `<div class="sheet"><p class="center dim">You're out — enjoy the show.</p></div>`
    : ui.arming
      ? armedSheet
      : !isMyTurn()
      ? `<div class="sheet">
           ${queueNote}
           ${itemsHTML(my, false)}
           <p class="center dim">Waiting for <b>${esc(turnName)}</b><span class="cursor">▍</span></p>
         </div>`
      : ui.target
        ? `<div class="sheet">
             <div class="label">Fire at <b>${esc(viewing.name)}</b> · <b class="coord">${label(ui.target.cell, s.grid)}</b></div>
             <div class="nudge">
               <button data-nudge="up">↑</button>
               <button data-nudge="left">←</button>
               <button data-nudge="right">→</button>
               <button data-nudge="down">↓</button>
             </div>
             <button class="btn fire" data-act="fire">FIRE · ${label(ui.target.cell, s.grid)}</button>
             <button class="btn ghost" data-act="cancel-fire">Cancel</button>
           </div>`
        : ui.usingItem
          ? `<div class="sheet">
               <div class="label">${ITEM_GLYPH[ui.usingItem]} ${esc(ITEM_LABEL[ui.usingItem])} → <b>${esc(viewing.name)}</b></div>
               <p class="center dim qhint">Tap a square to scan the 3×3 around it.</p>
               <button class="btn ghost" data-act="item-cancel">Cancel</button>
             </div>`
          : `<div class="sheet">
             ${queueNote}
             ${itemsHTML(my, isMyTurn() && !my.eliminated)}
             ${powerBtn}
             <p class="center dim">
             ${viewingSelf ? 'Pick an opponent above to attack.' : `Tap a square on ${esc(viewing.name)}'s waters.`}
           </p></div>`;

  // Only the newest shot on the viewed board gets an entry animation — innerHTML
  // re-renders would otherwise replay every explosion in the history.
  const last = s.log.at(-1);
  const lastShot = last && last.targetId === viewing.id ? last.cell : null;
  const swap = ui.swapDir ? ` swap-${ui.swapDir}` : '';

  return `${topbar(isMyTurn() ? 'Your turn' : `${esc(turnName)}'s turn`,
      viewingSelf ? 'Your waters' : `${esc(viewing.name)}'s waters`,
      s.turn.deadlineAt)}
    <main>
      ${stormHTML()}
      ${tabsHTML()}
      <div class="board-wrap${canQueue ? ' queueing' : ''}${swap}" data-board="${viewing.id}"
           style="--pc:${viewing.color}">
        ${boardHTML({
          grid: s.grid,
          land: s.land,
          incoming: viewing.incoming,
          ships: viewing.ships.filter((sh) => sh.cells),
          selected: ui.target?.targetId === viewing.id ? ui.target.cell : null,
          premoves: pmMap.size ? pmMap : null,
          lastShot,
          scan: scan.size ? scan : null,
          storm: s.storm?.phase === 'active' ? s.storm.cells : null,
          selfDamage: viewingSelf ? (my.selfDamage ?? []) : null,
          aim: ui.arming && !viewingSelf ? aimCells(power, viewing) : null,
          name: viewingSelf ? 'Your waters' : `${viewing.name}'s waters`,
          disabled: !canFire && !viewingSelf && !canQueue && !ui.arming,
        })}
      </div>
      ${feedHTML()}
      ${isHost() ? '<button class="btn ghost slim danger" data-act="ask-reset">Reset game</button>' : ''}
    </main>
    ${sheet}
    ${confirmHTML()}`;
}

// -------------------------------------------------- over

function overScreen() {
  const s = ui.state;
  const winner = s.players.find((p) => p.id === s.winnerId);
  const won = winner?.id === ui.you?.id;
  return `${topbar('Game over', '')}
    <main>
      <div class="card center verdict" ${winner ? `style="--pc:${winner.color}"` : ''}>
        <p class="hero-title">${winner ? `${esc(winner.name)} wins` : 'All fleets lost'}</p>
        <p class="dim">${won ? 'LAST FLEET AFLOAT' : winner ? `${esc(winner.name).toUpperCase()} HOLDS THE OCEAN` : ''}</p>
      </div>
      ${feedHTML()}
      <div class="card">
        <h2>Final standings</h2>
        <div class="players">${s.players.map(playerRow).join('')}</div>
      </div>
      ${isHost()
        ? '<button class="btn primary" data-act="again">Run it back</button>'
        : '<p class="dim center">Awaiting the host<span class="cursor">▍</span></p>'}
    </main>`;
}

// ------------------------------------------------------------------ render

const RENDERERS = {
  offline: offlineScreen,
  join: joinScreen,
  lobby: lobbyScreen,
  placement: placementScreen,
  battle: battleScreen,
  over: overScreen,
};

let lastScreen = '';
function render() {
  const sc = screen();
  const key = JSON.stringify([sc, ui.state?.seq, ui.tab, ui.target, ui.selShip, ui.anchor,
    ui.connected, ui.premoves, ui.arming, ui.picks, ui.lineDir, ui.confirm,
    ui.usingItem, sound.isMuted()]);
  if (key === lastKey) { tickClock(); return; }
  lastKey = key;

  // Staggered entrance plays only when the SCREEN changes, never on state pushes.
  if (sc !== lastScreen) app.dataset.fresh = '1';
  else delete app.dataset.fresh;
  lastScreen = sc;

  // Keep whatever the player was typing when a state push lands.
  const typed = app.querySelector('#nm')?.value;
  app.innerHTML = RENDERERS[sc]();
  const input = app.querySelector('#nm');
  if (input && typed != null) input.value = typed;

  // innerHTML throws focus away; keyboard players get their square back.
  if (keyboardUser && focusedCell != null) {
    app.querySelector(`[data-cell="${focusedCell}"]`)?.focus({ preventScroll: true });
  }

  // One-shot animation flags are consumed by the render that painted them.
  ui.plop = false;
  ui.swapDir = null;
}

/** Update just the clock between renders so the countdown is smooth. */
function tickClock() {
  const el = app.querySelector('.timer');
  if (!el || !ui.state) return;
  const deadline = ui.state.phase === PHASE.PLACEMENT
    ? ui.state.placementDeadlineAt
    : ui.state.phase === PHASE.PLAYING ? ui.state.turn.deadlineAt : null;
  const ms = remaining(deadline);
  el.outerHTML = clockHTML(ms);
}

let frame = null;
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = null; render(); });
}

setInterval(tickClock, 250);

// ------------------------------------------------------------------ events

app.addEventListener('click', (ev) => {
  if (swallowClick) return;
  const el = ev.target.closest('[data-act],[data-cell],[data-tab],[data-ship],[data-nudge],[data-navy],[data-linedir],[data-item]');
  if (!el) return;

  if (el.dataset.item) {
    const item = el.dataset.item;
    // Radar has to be aimed; everything else takes effect where it stands.
    if (NEEDS_TARGET.includes(item)) {
      ui.usingItem = item;
      ui.arming = false;
      ui.target = null;
      return schedule();
    }
    net.send({ t: MSG.ITEM_USE, item });
    return;
  }

  if (el.dataset.navy) {
    net.send({ t: MSG.COUNTRY_SET, country: el.dataset.navy });
    return;
  }
  if (el.dataset.linedir) {
    ui.lineDir = el.dataset.linedir;
    return schedule();
  }

  if (el.dataset.tab) {
    const order = ui.state?.players.map((p) => p.id) ?? [];
    ui.swapDir = order.indexOf(el.dataset.tab) < order.indexOf(ui.tab) ? 'l' : 'r';
    ui.tab = el.dataset.tab;
    ui.target = null;
    return schedule();
  }
  if (el.dataset.ship) {
    ui.selShip = ui.selShip === el.dataset.ship ? null : el.dataset.ship;
    ui.anchor = null;
    return schedule();
  }
  if (el.dataset.nudge) {
    if (!ui.target) return;
    const g = grid();
    const delta = { up: -g, down: g, left: -1, right: 1 }[el.dataset.nudge];
    const next = ui.target.cell + delta;
    // Sideways nudges must not wrap onto the next row.
    const sameRow = Math.abs(delta) === 1
      ? Math.floor(next / g) === Math.floor(ui.target.cell / g)
      : true;
    if (next >= 0 && next < g * g && sameRow) ui.target = { ...ui.target, cell: next };
    return schedule();
  }
  if (el.dataset.cell != null) return onCell(Number(el.dataset.cell));

  return onAction(el.dataset.act, el);
});

function onCell(cell) {
  const s = ui.state;
  if (!s) return;

  if (s.phase === PHASE.PLACEMENT) {
    const my = me();
    if (my.ready) return;
    // Tapping one of your own ships picks it up to move.
    const hit = my.ships.find((sh) => sh.cells?.includes(cell));
    if (hit && ui.selShip !== hit.type) {
      ui.selShip = hit.type;
      ui.anchor = null;
    } else if (ui.selShip) {
      ui.anchor = cell;
    } else {
      toast('Pick a ship first');
    }
    return schedule();
  }

  if (s.phase === PHASE.PLAYING) {
    const viewing = s.players.find((p) => p.id === ui.tab);
    if (me().eliminated) return;
    if (!viewing || viewing.id === ui.you.id) return toast('Pick an opponent to attack');
    if (viewing.eliminated) return toast(`${viewing.name} is already out`);

    // Aiming a carried item takes over the board.
    if (ui.usingItem) {
      net.send({ t: MSG.ITEM_USE, item: ui.usingItem, targetId: viewing.id, cell });
      ui.usingItem = null;
      return schedule();
    }

    // Aiming a superpower takes over the board.
    if (ui.arming) {
      const power = byCountry(me().country)?.power;
      if (!power) return;
      if (s.land.includes(cell)) return toast('That square is land');
      if (viewing.incoming[cell] !== 0) return toast('Already fired there');
      if (power.shape === 'free') {
        const cap = power.flexible ? (me().powerBudget ?? 0) : power.n;
        const at = ui.picks.indexOf(cell);
        if (at >= 0) ui.picks.splice(at, 1);
        else if (ui.picks.length < cap) ui.picks.push(cell);
        else toast(power.flexible ? `Only ${cap} left` : `${power.name} takes ${power.n} squares`);
      } else {
        ui.anchor = cell;
      }
      return schedule();
    }

    // Off-turn taps queue premoves instead of being refused.
    if (!isMyTurn()) return togglePremove(viewing, cell);

    if (s.land.includes(cell)) return toast('That square is land');
    if (viewing.incoming[cell] !== 0) return toast("You've already fired there");
    ui.target = { targetId: viewing.id, cell };
    return schedule();
  }
}

// ------------------------------------------------------------------ premoves

function togglePremove(viewing, cell) {
  const s = ui.state;
  const at = ui.premoves.findIndex((m) => m.targetId === viewing.id && m.cell === cell);
  if (at >= 0) {
    ui.premoves.splice(at, 1);
  } else {
    if (s.land.includes(cell)) return toast('That square is land');
    if (viewing.incoming[cell] !== 0) return toast('Already fired there');
    if (ui.premoves.length >= MAX_PREMOVES) return toast(`Queue is full (${MAX_PREMOVES} max)`);
    ui.premoves.push({ targetId: viewing.id, cell });
    buzz(15);
  }
  sendPremoves();
  schedule();
}

/** Swipe across an opponent's board to queue a run of cells in one gesture. */
function queueFromPoint(x, y) {
  const el = document.elementFromPoint(x, y)?.closest?.('[data-cell]');
  if (!el || !el.closest('.board-wrap.queueing')) return;
  const s = ui.state;
  const viewing = s?.players.find((p) => p.id === ui.tab);
  if (!viewing) return;
  const cell = Number(el.dataset.cell);
  if (s.land.includes(cell) || viewing.incoming[cell] !== 0) return;
  if (ui.premoves.some((m) => m.targetId === viewing.id && m.cell === cell)) return;
  if (ui.premoves.length >= MAX_PREMOVES) return;
  ui.premoves.push({ targetId: viewing.id, cell });
  buzz(15);
  schedule();
}

let dragStart = null;

app.addEventListener('pointerdown', (ev) => {
  if (!ev.target.closest?.('.board-wrap.queueing [data-cell]')) return;
  dragStart = { x: ev.clientX, y: ev.clientY };
});

app.addEventListener('pointermove', (ev) => {
  if (!dragStart) return;
  // A finger has to travel before a tap becomes a swipe — protects the toggle tap.
  if (!ui.dragging) {
    const dx = ev.clientX - dragStart.x;
    const dy = ev.clientY - dragStart.y;
    if (dx * dx + dy * dy < 12 * 12) return;
    ui.dragging = true;
    queueFromPoint(dragStart.x, dragStart.y);
  }
  queueFromPoint(ev.clientX, ev.clientY);
});

let swallowClick = false;

function endDrag() {
  dragStart = null;
  if (!ui.dragging) return;
  ui.dragging = false;
  // The click that follows a swipe would toggle the last cell straight back off.
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 0);
  sendPremoves();
  schedule();
}
app.addEventListener('pointerup', endDrag);
app.addEventListener('pointercancel', endDrag);

// ------------------------------------------------------------------ keyboard

// The board is one tab stop; arrows walk it. Focus is only restored across renders
// once someone has actually used the keyboard, so touch players never see focus rings.
let keyboardUser = false;
let focusedCell = null;

app.addEventListener('focusin', (ev) => {
  const cell = ev.target.closest?.('[data-cell]');
  focusedCell = cell ? cell.dataset.cell : null;
});

app.addEventListener('keydown', (ev) => {
  if (ev.key === 'Tab') { keyboardUser = true; return; }
  const cell = ev.target.closest?.('[data-cell]');
  if (!cell) return;

  const g = grid();
  const delta = { ArrowUp: -g, ArrowDown: g, ArrowLeft: -1, ArrowRight: 1 }[ev.key];
  if (!delta) return;

  ev.preventDefault();
  keyboardUser = true;
  const from = Number(cell.dataset.cell);
  const to = from + delta;
  if (to < 0 || to >= g * g) return;
  // Sideways steps must not wrap onto the next row.
  if (Math.abs(delta) === 1 && Math.floor(to / g) !== Math.floor(from / g)) return;
  app.querySelector(`[data-cell="${to}"]`)?.focus({ preventScroll: true });
});

function onAction(act, el) {
  const s = ui.state;
  switch (act) {
    case 'join': {
      const name = app.querySelector('#nm')?.value.trim();
      if (!name) return toast('Type a name first');
      // Browsers only allow audio to start from a real gesture, and this is the first
      // one every player makes.
      sound.unlock();
      net.hello(name);
      break;
    }
    case 'mute': {
      sound.unlock(); // toggling is itself a gesture, so this can also be the unlock
      const nowMuted = sound.setMuted(!sound.isMuted());
      if (!nowMuted) sound.play('ping', 0.5); // confirm it actually works
      break;
    }
    case 'start':
      net.send({ t: MSG.GAME_START });
      break;
    case 'again':
      net.send({ t: MSG.GAME_RESET });
      break;
    case 'random':
      net.send({ t: MSG.PLACE_RANDOM });
      ui.selShip = null;
      ui.anchor = null;
      ui.plop = true; // the next render (the shuffle echo) pops the hulls in
      break;
    case 'ready':
      net.send({ t: MSG.PLACE_CONFIRM });
      break;
    case 'cancel-place':
      ui.anchor = null;
      break;
    case 'place': {
      const def = FLEET.find((f) => f.type === ui.selShip);
      if (!def || ui.anchor == null) break;
      const fleet = draftFleet().map((sh) =>
        sh.type === def.type ? { type: def.type, anchor: ui.anchor, dir: el.dataset.dir } : sh);
      net.send({ t: MSG.PLACE_SET, ships: fleet });
      ui.anchor = null;
      ui.selShip = null;
      break;
    }
    case 'fire':
      if (!ui.target) break;
      net.send({
        t: MSG.FIRE,
        targetId: ui.target.targetId,
        cell: ui.target.cell,
        // Survives a retry after a flaky send without firing twice.
        nonce: `${ui.you.id}:${s.seq}:${ui.target.cell}`,
      });
      ui.target = null;
      break;
    case 'cancel-fire':
      ui.target = null;
      break;
    case 'clear-queue':
      ui.premoves = [];
      sendPremoves();
      break;
    case 'power-arm':
      ui.arming = true;
      ui.picks = [];
      ui.anchor = null;
      ui.lineDir = 'h';
      ui.target = null;
      break;
    case 'power-cancel':
      ui.arming = false;
      ui.picks = [];
      ui.anchor = null;
      break;
    case 'item-cancel':
      ui.usingItem = null;
      break;
    case 'power-fire': {
      const power = byCountry(me()?.country)?.power;
      if (!power || !ui.tab) break;
      net.send({
        t: MSG.POWER_FIRE,
        targetId: ui.tab,
        anchor: power.shape === 'free' ? (ui.picks[0] ?? 0) : ui.anchor,
        picked: power.shape === 'free' ? ui.picks : (power.shape === 'line' ? ui.lineDir : null),
      });
      ui.arming = false;
      ui.picks = [];
      ui.anchor = null;
      break;
    }
    case 'ask-reset':
      ui.confirm = {
        act: 'reset',
        title: 'Reset the game?',
        body: 'Everyone goes back to the lobby. Fleets, damage and the whole board are lost. This cannot be undone.',
        yes: 'Reset it',
        danger: true,
      };
      break;
    case 'confirm-no':
      ui.confirm = null;
      break;
    case 'confirm-yes': {
      const pending = ui.confirm;
      ui.confirm = null;
      if (pending?.act === 'reset') net.send({ t: MSG.GAME_RESET });
      break;
    }
    case 'unqueue': {
      const idx = Number(el.dataset.idx);
      if (Number.isInteger(idx) && idx >= 0 && idx < ui.premoves.length) {
        ui.premoves.splice(idx, 1);
        sendPremoves();
      }
      break;
    }
    default:
      return;
  }
  schedule();
}

app.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!el.dataset.limit) return;
  const value = TIMER_STOPS[Number(el.value)];
  net.send({ t: MSG.SETTINGS_SET, [el.dataset.limit]: value });
});

// A phone waking from sleep gets a stale socket; nudge it immediately.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (net.ws?.readyState !== WebSocket.OPEN) net.connect();
    else net.ping();
  }
});

if (savedToken()) ui.serverGone = false;
net.connect();
render();
