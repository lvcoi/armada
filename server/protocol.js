// Inbound message dispatch. Every client action is re-checked here and in the Room —
// nothing the browser sends is taken on trust.

import { MSG, ERR } from '../shared/constants.js';
import { GameError } from './room.js';

export function parse(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    throw new GameError(ERR.BAD_MESSAGE, 'Malformed message');
  }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
    throw new GameError(ERR.BAD_MESSAGE, 'Malformed message');
  }
  return msg;
}

/**
 * Route one message for an already-identified player.
 * `hello` is handled by the connection layer, since it's what establishes identity.
 */
export function dispatch(room, playerId, msg) {
  switch (msg.t) {
    case MSG.SETTINGS_SET:
      return room.setSettings(playerId, {
        turnLimitMs: msg.turnLimitMs,
        placementLimitMs: msg.placementLimitMs,
      });

    case MSG.GAME_START:
      return room.startGame(playerId);

    case MSG.GAME_RESET:
      return room.resetToLobby(playerId);

    case MSG.PLACE_SET:
      return room.setPlacement(playerId, msg.ships);

    case MSG.PLACE_RANDOM:
      return room.randomPlacement(playerId);

    case MSG.PLACE_CONFIRM:
      return room.confirmPlacement(playerId);

    case MSG.FIRE:
      return room.fire(playerId, {
        targetId: msg.targetId,
        cell: msg.cell,
        nonce: typeof msg.nonce === 'string' ? msg.nonce : null,
      });

    default:
      throw new GameError(ERR.BAD_MESSAGE, `Unknown message: ${msg.t}`);
  }
}
