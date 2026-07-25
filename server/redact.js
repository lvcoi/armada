// Per-recipient state projection.
//
// Someone in the family will open devtools. There is no code path that sends the raw
// room object to a socket — every outbound snapshot goes through projectState(), which
// only ever includes a player's ship positions in that player's own copy.

import { landCells } from '../shared/terrain.js';
import { shipsRemaining } from './game.js';

function projectPlayer(player, isSelf) {
  const common = {
    id: player.id,
    name: player.name,
    color: player.color,
    connected: player.connected,
    ready: player.ready,
    eliminated: player.eliminated,
    shipsRemaining: shipsRemaining(player),
    // The defender's own record of shots fired at them. Public by design — this is
    // exactly what every other player is allowed to see about this board.
    incoming: Array.from(player.incoming),
  };

  if (isSelf) {
    return {
      ...common,
      isSelf: true,
      ships: player.ships.map((s) => ({
        type: s.type,
        len: s.len,
        sunk: s.sunk,
        cells: s.cells,
      })),
    };
  }

  return {
    ...common,
    isSelf: false,
    // Sunk ships are revealed — standard Battleship, and already inferable from the
    // hit pattern. Everything still afloat stays hidden.
    ships: player.ships.map((s) => ({
      type: s.type,
      len: s.len,
      sunk: s.sunk,
      cells: s.sunk ? s.cells : null,
    })),
  };
}

export function projectState(room, viewerId) {
  return {
    phase: room.phase,
    seq: room.seq,
    hostId: room.hostId,
    settings: { ...room.settings },
    terrainId: room.terrainId,
    land: room.terrainId ? landCells(room.terrainId) : [],
    you: viewerId,
    players: room.players.map((p) => projectPlayer(p, p.id === viewerId)),
    turn: {
      playerId: room.currentPlayerId(),
      deadlineAt: room.turn.deadlineAt,
    },
    placementDeadlineAt: room.placementDeadlineAt,
    log: room.log.slice(-60),
    winnerId: room.winnerId,
    serverNow: Date.now(),
  };
}
