// HTTP + WebSocket entry point. Serves the client and runs the one room.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

import { MSG, ERR } from '../shared/constants.js';
import { Room, GameError } from './room.js';
import { projectState } from './redact.js';
import { parse, dispatch } from './protocol.js';
import { lanAddresses, banner } from './net.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLIENT_DIR = path.join(ROOT, 'client');
const SHARED_DIR = path.join(ROOT, 'shared');
const PORT = Number(process.env.PORT) || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// --------------------------------------------------------------- static files

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  // `shared/` is imported by the browser as well as by this process — same files,
  // no build step, so it has to be reachable over HTTP too.
  const [baseDir, rel] = pathname.startsWith('/shared/')
    ? [SHARED_DIR, pathname.slice('/shared/'.length)]
    : [CLIENT_DIR, pathname.slice(1)];

  const target = path.resolve(baseDir, rel);
  if (target !== baseDir && !target.startsWith(baseDir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const data = await fsp.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}

// --------------------------------------------------------------- wiring

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server });

/** ws -> playerId */
const sockets = new Map();

const send = (ws, msg) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

function pushState() {
  for (const [ws, playerId] of sockets) {
    send(ws, { t: MSG.STATE, ...projectState(room, playerId) });
  }
}

function broadcast(msg) {
  for (const ws of sockets.keys()) send(ws, msg);
}

// Full snapshots rather than deltas: the whole state is a couple of KB, this is a LAN,
// and patch reconciliation is a bug factory nobody here needs.
const room = new Room({ event: broadcast, changed: pushState });

const socketsFor = (playerId) =>
  [...sockets.entries()].filter(([, id]) => id === playerId);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = parse(raw);
    } catch (err) {
      send(ws, { t: MSG.ERROR, code: err.code, message: err.message });
      return;
    }

    // Latency probe so clients can render the server's deadlines against their own clock.
    if (msg.t === MSG.PING) {
      send(ws, { t: MSG.PONG, t0: msg.t0, tServer: Date.now() });
      return;
    }

    try {
      if (msg.t === MSG.HELLO) {
        const { player, reconnected } = room.join({ token: msg.token, name: msg.name });
        sockets.set(ws, player.id);
        send(ws, {
          t: MSG.WELCOME,
          you: { id: player.id, token: player.token },
          reconnected,
        });
        pushState();
        return;
      }

      const playerId = sockets.get(ws);
      if (!playerId) {
        send(ws, { t: MSG.ERROR, code: ERR.BAD_MESSAGE, message: 'Say hello first' });
        return;
      }

      dispatch(room, playerId, msg);
    } catch (err) {
      if (err instanceof GameError) {
        send(ws, { t: MSG.ERROR, code: err.code, message: err.message });
      } else {
        console.error('[armada]', err);
        send(ws, { t: MSG.ERROR, code: ERR.BAD_MESSAGE, message: 'Something went wrong' });
      }
    }
  });

  ws.on('close', () => {
    const playerId = sockets.get(ws);
    sockets.delete(ws);
    // Two tabs open on one phone shouldn't look like a disconnect when one closes.
    if (playerId && socketsFor(playerId).length === 0) room.disconnect(playerId);
  });

  ws.on('error', () => ws.close());
});

// Drop sockets that died without a close frame (phone went to sleep, wifi vanished),
// otherwise they pile up and players look permanently online.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
heartbeat.unref();

// --------------------------------------------------------------- boot

server.listen(PORT, async () => {
  const best = lanAddresses()[0];
  let qr = '';
  if (best) {
    try {
      qr = await QRCode.toString(`http://${best.address}:${PORT}`, {
        type: 'terminal', small: true,
      });
    } catch {
      // A missing QR code is cosmetic; the URL above is what actually matters.
    }
  }
  console.log(banner(PORT, qr));
});

const shutdown = () => {
  room.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
