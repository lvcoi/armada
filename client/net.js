// Socket handling: connect, resync, and survive a phone that went to sleep.

import { MSG } from '/shared/constants.js';

const TOKEN_KEY = 'armada.token';
const NAME_KEY = 'armada.name';

export const savedToken = () => localStorage.getItem(TOKEN_KEY) || null;
export const savedName = () => localStorage.getItem(NAME_KEY) || '';
export const rememberName = (n) => localStorage.setItem(NAME_KEY, n);
export const forgetSession = () => localStorage.removeItem(TOKEN_KEY);

export class Net {
  constructor(handlers) {
    this.h = handlers;
    this.ws = null;
    this.clockOffset = 0;      // serverNow - clientNow
    this.retry = 0;
    this.pendingName = null;
    this.closedForGood = false;
  }

  connect() {
    if (this.closedForGood) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}`);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      this.h.onOpen?.();
      const token = savedToken();
      // A token alone is enough to reclaim a slot; a name is only needed for a new player.
      if (token || this.pendingName) {
        this.send({ t: MSG.HELLO, token, name: this.pendingName ?? savedName() });
      }
      this.ping();
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.t === MSG.PONG) {
        const rtt = Date.now() - msg.t0;
        this.clockOffset = msg.tServer + rtt / 2 - Date.now();
        return;
      }
      if (msg.t === MSG.WELCOME) {
        localStorage.setItem(TOKEN_KEY, msg.you.token);
        this.pendingName = null;
      }
      this.h.onMessage?.(msg);
    };

    ws.onclose = () => {
      this.h.onClose?.();
      if (this.closedForGood) return;
      // Back off, but stay snappy for the common case: a phone waking from sleep.
      const wait = Math.min(500 * 2 ** this.retry++, 5000);
      setTimeout(() => this.connect(), wait);
    };

    ws.onerror = () => ws.close();
  }

  ping() {
    this.send({ t: MSG.PING, t0: Date.now() });
  }

  /** Join as a brand new player. */
  hello(name) {
    this.pendingName = name;
    rememberName(name);
    this.send({ t: MSG.HELLO, token: savedToken(), name });
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Server time as this device best understands it. */
  now() { return Date.now() + this.clockOffset; }
}
