// Client state machine. One render() off a single state object, delegated events,
// no framework and no build step.

import {
  MSG, PHASE, FLEET, TIMER_STOPS, timerLabel, MIN_PLAYERS,
} from '/shared/constants.js';
import { label, shipCells } from '/shared/coords.js';
import { canPlace } from '/shared/placement.js';
import { Net, savedToken, savedName, forgetSession } from '/net.js';
import { boardHTML } from '/board.js';

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
  serverGone: false,
};

let lastKey = '';
let toastTimer = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const me = () => ui.state?.players.find((p) => p.id === ui.you?.id) ?? null;
const others = () => ui.state?.players.filter((p) => p.id !== ui.you?.id) ?? [];
const isHost = () => ui.state && ui.you && ui.state.hostId === ui.you.id;
const isMyTurn = () => ui.state?.turn?.playerId === ui.you?.id;

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
    schedule();
  },
  onClose() {
    ui.connected = false;
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
        break;
      case MSG.TURN:
        if (msg.playerId === ui.you?.id) buzz([40, 60, 40]);
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
  return `<div class="timer${s <= 15 ? ' warn' : ''}">${txt}</div>`;
}

function topbar(title, sub, deadlineAt) {
  return `<header class="topbar">
    <div><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
    ${clockHTML(remaining(deadlineAt))}
  </header>`;
}

function playerRow(p) {
  return `<div class="player${p.connected ? '' : ' off'}">
    <span class="dot" style="background:${p.color}"></span>
    <span class="nm">${esc(p.name)}</span>
    <span class="badge">${[
      p.id === ui.state.hostId ? 'host' : '',
      p.connected ? '' : 'offline',
      p.eliminated ? 'out' : '',
      ui.state.phase === PHASE.PLACEMENT && p.ready ? 'ready' : '',
    ].filter(Boolean).join(' · ')}</span>
  </div>`;
}

// -------------------------------------------------- offline / join

function offlineScreen() {
  return `${topbar('Armada', ui.serverGone ? 'Disconnected' : 'Connecting…')}
    <main>
      <div class="card center">
        <p class="big">${ui.serverGone ? 'Lost the host' : 'Connecting…'}</p>
        <p class="dim">Make sure you are on the same wifi as the person hosting the game.
        This will reconnect on its own.</p>
      </div>
    </main>`;
}

function joinScreen() {
  return `${topbar('Armada', 'Battleship on the home wifi')}
    <main>
      <div class="card">
        <div class="field">
          <label for="nm">What should we call you?</label>
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

function lobbyScreen() {
  const s = ui.state;
  const enough = s.players.length >= MIN_PLAYERS;
  return `${topbar('Lobby', `${s.players.length} of 4 aboard`)}
    <main>
      <div class="card">
        <h2>Players</h2>
        <div class="players">${s.players.map(playerRow).join('')}</div>
      </div>
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
    const dirs = ['h', 'v'].filter((d) => canPlace(ui.anchor, d, def.len, s.terrainId, occupied));
    const cells = shipCells(ui.anchor, dirs[0] ?? 'h', def.len);
    ghost = { cells: cells ?? [ui.anchor], bad: dirs.length === 0 };
  }

  const chips = FLEET.map((f) => {
    const placed = my.ships.find((x) => x.type === f.type);
    return `<button class="chip" data-ship="${f.type}"
      aria-pressed="${ui.selShip === f.type}">
      ${f.name} <span class="len">${'▪'.repeat(f.len)}</span>
      ${placed ? '' : '<span class="len">?</span>'}
    </button>`;
  }).join('');

  const sheet = my.ready
    ? `<div class="sheet"><p class="center dim">Fleet locked in. Waiting for everyone else…</p></div>`
    : ui.anchor != null && def
      ? `<div class="sheet">
           <div class="label">${def.name} at <b>${label(ui.anchor)}</b></div>
           <div class="row">
             <button class="btn" data-act="place" data-dir="h"
               ${canPlace(ui.anchor, 'h', def.len, s.terrainId, occupied) ? '' : 'disabled'}>→ Across</button>
             <button class="btn" data-act="place" data-dir="v"
               ${canPlace(ui.anchor, 'v', def.len, s.terrainId, occupied) ? '' : 'disabled'}>↓ Down</button>
           </div>
           <button class="btn ghost" data-act="cancel-place">Cancel</button>
         </div>`
      : `<div class="sheet">
           <div class="row">
             <button class="btn" data-act="random">Shuffle</button>
             <button class="btn primary" data-act="ready">I'm ready</button>
           </div>
         </div>`;

  return `${topbar('Place your fleet',
      ui.selShip ? `Tap a square for your ${def.name.toLowerCase()}` : 'Tap a ship, then a square',
      s.placementDeadlineAt)}
    <main>
      <div class="chips">${chips}</div>
      <div class="board-wrap" data-board="own">
        ${boardHTML({
          land: s.land, incoming: my.incoming, ships: my.ships,
          ghost, disabled: my.ready,
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
  const tabs = [my, ...others()].map((p) => {
    const isMine = p.id === ui.you.id;
    const pips = Array.from({ length: FLEET.length }, (_, i) =>
      `<span class="pip${i < p.shipsRemaining ? ' on' : ''}"></span>`).join('');
    return `<button class="tab${p.eliminated ? ' out' : ''}" data-tab="${p.id}"
      aria-selected="${ui.tab === p.id}">
      <span class="swatch" style="background:${p.color}"></span>
      <span class="nm">${isMine ? 'You' : esc(p.name)}</span>
      <span class="pips">${pips}</span>
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
    return `<div class="line"><b>${esc(name(r.attackerId))}</b> → <b>${esc(name(r.targetId))}</b>
      ${label(r.cell)} ${verb}${r.auto ? ' <span class="auto">(auto)</span>' : ''}</div>`;
  }).join('');
  return `<div class="card"><h2>What just happened</h2><div class="feed">${lines || '<div class="line">No shots yet.</div>'}</div></div>`;
}

function battleScreen() {
  const s = ui.state;
  const my = me();
  const viewing = s.players.find((p) => p.id === ui.tab) ?? my;
  const viewingSelf = viewing.id === ui.you.id;
  const turnName = s.players.find((p) => p.id === s.turn.playerId)?.name ?? '';

  const canFire = isMyTurn() && !my.eliminated && !viewingSelf && !viewing.eliminated;

  const sheet = my.eliminated
    ? `<div class="sheet"><p class="center dim">You're out — enjoy the show.</p></div>`
    : !isMyTurn()
      ? `<div class="sheet"><p class="center dim">Waiting for <b>${esc(turnName)}</b>…</p></div>`
      : ui.target
        ? `<div class="sheet">
             <div class="label">Fire at <b>${esc(viewing.name)}</b> · <b>${label(ui.target.cell)}</b></div>
             <div class="nudge">
               <button data-nudge="-15">↑</button>
               <button data-nudge="-1">←</button>
               <button data-nudge="1">→</button>
               <button data-nudge="15">↓</button>
             </div>
             <button class="btn fire" data-act="fire">FIRE</button>
             <button class="btn ghost" data-act="cancel-fire">Cancel</button>
           </div>`
        : `<div class="sheet"><p class="center dim">
             ${viewingSelf ? 'Pick an opponent above to attack.' : `Tap a square on ${esc(viewing.name)}'s waters.`}
           </p></div>`;

  return `${topbar(isMyTurn() ? 'Your turn' : `${esc(turnName)}'s turn`,
      viewingSelf ? 'Your waters' : `${esc(viewing.name)}'s waters`,
      s.turn.deadlineAt)}
    <main>
      ${tabsHTML()}
      <div class="board-wrap" data-board="${viewing.id}">
        ${boardHTML({
          land: s.land,
          incoming: viewing.incoming,
          ships: viewing.ships.filter((sh) => sh.cells),
          selected: ui.target?.targetId === viewing.id ? ui.target.cell : null,
          disabled: !canFire && !viewingSelf,
        })}
      </div>
      ${feedHTML()}
    </main>
    ${sheet}`;
}

// -------------------------------------------------- over

function overScreen() {
  const s = ui.state;
  const winner = s.players.find((p) => p.id === s.winnerId);
  const won = winner?.id === ui.you?.id;
  return `${topbar('Game over', '')}
    <main>
      <div class="card center">
        <p class="big">${winner ? `${esc(winner.name)} wins!` : 'Nobody left standing.'}</p>
        <p class="dim">${won ? 'Your fleet was the last one afloat.' : ''}</p>
      </div>
      ${feedHTML()}
      <div class="card">
        <h2>Final standings</h2>
        <div class="players">${s.players.map(playerRow).join('')}</div>
      </div>
      ${isHost()
        ? '<button class="btn primary" data-act="again">Play again</button>'
        : '<p class="dim center">Waiting for the host to start another game…</p>'}
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

function render() {
  const sc = screen();
  const key = JSON.stringify([sc, ui.state?.seq, ui.tab, ui.target, ui.selShip, ui.anchor, ui.connected]);
  if (key === lastKey) { tickClock(); return; }
  lastKey = key;

  // Keep whatever the player was typing when a state push lands.
  const typed = app.querySelector('#nm')?.value;
  app.innerHTML = RENDERERS[sc]();
  const input = app.querySelector('#nm');
  if (input && typed != null) input.value = typed;
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
  const el = ev.target.closest('[data-act],[data-cell],[data-tab],[data-ship],[data-nudge]');
  if (!el) return;

  if (el.dataset.tab) {
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
    const next = ui.target.cell + Number(el.dataset.nudge);
    // Sideways nudges must not wrap onto the next row.
    const sameRow = Math.abs(Number(el.dataset.nudge)) === 1
      ? Math.floor(next / 15) === Math.floor(ui.target.cell / 15)
      : true;
    if (next >= 0 && next < 225 && sameRow) ui.target = { ...ui.target, cell: next };
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
    if (!isMyTurn()) return toast("It isn't your turn yet");
    if (me().eliminated) return;
    if (!viewing || viewing.id === ui.you.id) return toast('Pick an opponent to attack');
    if (viewing.eliminated) return toast(`${viewing.name} is already out`);
    if (s.land.includes(cell)) return toast('That square is land');
    if (viewing.incoming[cell] !== 0) return toast("You've already fired there");
    ui.target = { targetId: viewing.id, cell };
    return schedule();
  }
}

function onAction(act, el) {
  const s = ui.state;
  switch (act) {
    case 'join': {
      const name = app.querySelector('#nm')?.value.trim();
      if (!name) return toast('Type a name first');
      net.hello(name);
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
