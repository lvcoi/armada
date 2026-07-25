// Shared between the Node server and the browser client.
// Plain ESM with explicit extensions so both runtimes resolve it natively.

export const GRID = 15;
export const CELLS = GRID * GRID; // 225

/** Ship types, longest first — placement is easiest when big ships go down early. */
export const FLEET = [
  { type: 'carrier', name: 'Carrier', len: 5 },
  { type: 'battleship', name: 'Battleship', len: 4 },
  { type: 'cruiser', name: 'Cruiser', len: 3 },
  { type: 'submarine', name: 'Submarine', len: 3 },
  { type: 'destroyer', name: 'Destroyer', len: 2 },
];

export const FLEET_CELLS = FLEET.reduce((n, s) => n + s.len, 0); // 17

export const MAX_PLAYERS = 4;
export const MIN_PLAYERS = 2;

/** Shot states stored in a defender's `incoming` array. */
export const SHOT = { NONE: 0, MISS: 1, HIT: 2 };

export const PHASE = {
  LOBBY: 'lobby',
  PLACEMENT: 'placement',
  PLAYING: 'playing',
  OVER: 'over',
};

/**
 * Timer stops in milliseconds, shared by the turn timer and the placement timer.
 * `null` is the final stop and means "no limit" — past 10 minutes the limit is removed
 * entirely rather than growing further.
 */
export const TIMER_STOPS = [
  10_000, 15_000, 30_000, 45_000,
  60_000, 90_000, 120_000, 180_000,
  300_000, 420_000, 600_000,
  null,
];

export const DEFAULT_TURN_LIMIT_MS = 120_000;
export const DEFAULT_PLACEMENT_LIMIT_MS = 120_000;

/** A player offline this long forfeits their turn immediately rather than stalling the table. */
export const DISCONNECT_GRACE_MS = 90_000;

export function timerLabel(ms) {
  if (ms == null) return 'No limit';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

/** Colorblind-separable, and always shown alongside the player's name. */
export const PLAYER_COLORS = ['#e4572e', '#3d9970', '#4a7fd4', '#c9a227'];

export const MSG = {
  // client -> server
  HELLO: 'hello',
  SETTINGS_SET: 'settings/set',
  GAME_START: 'game/start',
  GAME_RESET: 'game/reset',
  PLACE_SET: 'place/set',
  PLACE_RANDOM: 'place/random',
  PLACE_CONFIRM: 'place/confirm',
  FIRE: 'fire',
  PING: 'ping',
  // server -> client
  WELCOME: 'welcome',
  STATE: 'state',
  FIRE_RESULT: 'fire/result',
  TURN: 'turn',
  ELIMINATED: 'eliminated',
  OVER: 'over',
  ERROR: 'error',
  PONG: 'pong',
};

export const ERR = {
  BAD_MESSAGE: 'bad_message',
  ROOM_FULL: 'room_full',
  GAME_IN_PROGRESS: 'game_in_progress',
  NOT_HOST: 'not_host',
  WRONG_PHASE: 'wrong_phase',
  NOT_YOUR_TURN: 'not_your_turn',
  BAD_TARGET: 'bad_target',
  BAD_CELL: 'bad_cell',
  CELL_IS_LAND: 'cell_is_land',
  ALREADY_FIRED: 'already_fired',
  BAD_PLACEMENT: 'bad_placement',
  NOT_ENOUGH_PLAYERS: 'not_enough_players',
  NAME_REQUIRED: 'name_required',
};
