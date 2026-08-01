// Shared between the Node server and the browser client.
// Plain ESM with explicit extensions so both runtimes resolve it natively.

/**
 * Board size scales with the head count: two players get the classic close-quarters
 * 10x10, a full table gets room to maneuver. Decided once, at game start.
 */
export const GRID_FOR_PLAYERS = { 2: 10, 3: 12, 4: 15 };
export const MAX_GRID = 15;

export function gridFor(playerCount) {
  const n = Math.min(Math.max(playerCount, 2), 4);
  return GRID_FOR_PLAYERS[n];
}

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

/**
 * Premoves: shots queued in advance that fire automatically, one per turn, until one
 * of them HITS — a hit hands aiming back to the player. The delay gives everyone a
 * beat to watch the turn change before the queued shell flies.
 */
export const MAX_PREMOVES = 8;
export const PREMOVE_DELAY_MS = 700;

/**
 * Hidden pickups scattered over open water at the start of a game. They are revealed
 * only by being shot at, and only ever to the people entitled to know: a mine's damage
 * is private to the player who set it off, everything else is private to whoever found
 * it. Every one of them still writes a line to the public combat log.
 */
export const POWERUP = {
  MINE: 'mine',          // 1 hit on a random ship of YOURS; nobody else sees which
  RADAR: 'radar',        // reveals a 3x3 patch of a chosen board, to you only
  EXTRA: 'extra',        // your next shot this turn is free
  REPAIR: 'repair',      // heals one hit on one of your own ships
  RECHARGE: 'recharge',  // one more strike from your country's superpower
};

/**
 * A mine detonates the instant you shoot it — that is the whole point of a mine.
 * Everything else is CARRIED: you pick it up and decide later when and where to
 * spend it.
 */
export const COLLECTABLE = [POWERUP.RADAR, POWERUP.EXTRA, POWERUP.REPAIR, POWERUP.RECHARGE];

/** Items that need you to aim at somebody before they do anything. */
export const NEEDS_TARGET = [POWERUP.RADAR];

export const ITEM_LABEL = {
  [POWERUP.RADAR]: 'Radar',
  [POWERUP.EXTRA]: 'Spare shell',
  [POWERUP.REPAIR]: 'Repair crew',
  [POWERUP.RECHARGE]: 'Supply crate',
};

export const ITEM_GLYPH = {
  [POWERUP.RADAR]: '📡',
  [POWERUP.EXTRA]: '🐚',
  [POWERUP.REPAIR]: '🔧',
  [POWERUP.RECHARGE]: '📦',
};

/** Draw weights — mines are the common one, so the board stays genuinely risky. */
export const POWERUP_WEIGHTS = [
  [POWERUP.MINE, 5],
  [POWERUP.RADAR, 3],
  [POWERUP.EXTRA, 3],
  [POWERUP.REPAIR, 3],
  [POWERUP.RECHARGE, 2],
];

/**
 * Roughly one pickup per 6 water cells, so a 12x12 board carries about 24. Dense on
 * purpose: at the old 1-in-18 a short game could finish without anyone hitting a
 * single one, which made the whole mechanic invisible.
 */
export const POWERUP_DENSITY = 1 / 6;
export const RADAR_RADIUS = 1; // 1 -> a 3x3 patch

/**
 * The storm. It is announced HURRICANE_WARNING_ROUNDS full rounds before landfall,
 * then a vertical band walks west to east, scattering every ship it touches.
 */
export const HURRICANE_WARNING_ROUNDS = 3;
export const HURRICANE_BAND = 3;          // the eye is BAND x BAND squares
export const HURRICANE_START_ROUND = 4;   // rounds played before the warning appears

/**
 * Once it makes landfall the storm crosses the whole map in a single continuous
 * sweep rather than a step per round — about ten seconds of everyone watching their
 * fleet get thrown around. Play is suspended while it passes.
 */
export const HURRICANE_SWEEP_MS = 10_000;

export function timerLabel(ms) {
  if (ms == null) return 'No limit';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

/** Colorblind-separable, tuned for the dark phosphor UI, always shown with the name. */
export const PLAYER_COLORS = ['#ff6a3d', '#35d08e', '#5b9dff', '#ffc83d'];

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
  PREMOVE_SET: 'premove/set',
  COUNTRY_SET: 'country/set',
  ITEM_USE: 'item/use',
  POWER_FIRE: 'power/fire',
  POWERUP_FOUND: 'powerup/found',
  HURRICANE: 'hurricane',
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
