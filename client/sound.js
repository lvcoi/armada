// Synthesised sound. Every effect is generated from oscillators and a noise buffer at
// play time — there are no audio files, because the game has to work with no internet
// and the art already follows the same rule.
//
// Three things govern the design:
//   1. Browsers refuse to make noise until the player has interacted, so nothing works
//      until unlock() is called from a real tap. Joining the game is that tap.
//   2. Every phone in the room plays its own audio. Three phones narrating the same
//      game at full volume is noise, so events are mixed by whose they are — see LEVEL.
//   3. Nodes are one-shot and disconnect themselves; nothing accumulates.

const MUTE_KEY = 'armada.muted';

/** How loud an event is, by who it happened to. */
export const LEVEL = {
  SELF: 1,     // it happened to you
  MINE: 0.8,   // you did it
  OTHER: 0.28, // someone else's business
};

let ctx = null;
let master = null;
let noiseBuf = null;
let muted = localStorage.getItem(MUTE_KEY) === '1';

function ready() {
  if (!ctx) return false;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return !muted;
}

/** Must be called from inside a user gesture or the context stays suspended. */
export function unlock() {
  if (ctx) { ctx.resume?.().catch(() => {}); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);

    // One second of white noise, reused by every splash, crack and rumble.
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  } catch {
    ctx = null; // no audio on this device; the game is unaffected
  }
}

export const isMuted = () => muted;

export function setMuted(next) {
  muted = !!next;
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  if (master && ctx) {
    master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.02);
  }
  return muted;
}

// ------------------------------------------------------------------ builders

/** An envelope that always ends silent, so nothing can drone forever. */
function env(gain, peak, attack, decay, t0) {
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
}

function tone({ type = 'sine', from, to, peak, attack = 0.005, decay, at = 0, level = 1 }) {
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  if (to != null && to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + attack + decay);
  env(gain, peak * level, attack, decay, t0);
  osc.connect(gain).connect(master);
  osc.start(t0);
  osc.stop(t0 + attack + decay + 0.02);
  osc.onended = () => { try { gain.disconnect(); } catch { /* already gone */ } };
}

function noise({ peak, decay, at = 0, level = 1, filter = 'bandpass', freq = 1200, q = 1 }) {
  const t0 = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  const biq = ctx.createBiquadFilter();
  src.buffer = noiseBuf;
  src.loop = true;
  biq.type = filter;
  biq.frequency.setValueAtTime(freq, t0);
  biq.Q.value = q;
  env(gain, peak * level, 0.004, decay, t0);
  src.connect(biq).connect(gain).connect(master);
  src.start(t0);
  src.stop(t0 + decay + 0.05);
  src.onended = () => { try { gain.disconnect(); biq.disconnect(); } catch { /* already gone */ } };
}

// ------------------------------------------------------------------ the kit

const KIT = {
  /** Outgoing shell — a short airy whoosh. */
  fire: (l) => {
    noise({ peak: 0.13, decay: 0.22, level: l, filter: 'highpass', freq: 900 });
    tone({ type: 'triangle', from: 420, to: 180, peak: 0.06, decay: 0.18, level: l });
  },

  /** Miss: water. Low filtered burst with a little bloop under it. */
  miss: (l) => {
    noise({ peak: 0.22, decay: 0.3, level: l, filter: 'lowpass', freq: 900, q: 0.7 });
    tone({ type: 'sine', from: 300, to: 120, peak: 0.1, decay: 0.22, level: l });
  },

  /** Hit: a thump you feel plus the crack of metal. */
  hit: (l) => {
    tone({ type: 'sine', from: 160, to: 48, peak: 0.42, decay: 0.34, level: l });
    noise({ peak: 0.3, decay: 0.16, level: l, filter: 'bandpass', freq: 2400, q: 0.8 });
  },

  /** Sunk: the hit, then a long descending groan of a ship going under. */
  sunk: (l) => {
    KIT.hit(l);
    tone({ type: 'sawtooth', from: 220, to: 40, peak: 0.26, attack: 0.02, decay: 1.1, at: 0.08, level: l });
    noise({ peak: 0.18, decay: 0.9, at: 0.1, level: l, filter: 'lowpass', freq: 500 });
  },

  /** Your turn: a sonar ping with a long tail. */
  ping: (l) => {
    tone({ type: 'sine', from: 1180, to: 940, peak: 0.24, attack: 0.008, decay: 0.75, level: l });
    tone({ type: 'sine', from: 2360, peak: 0.06, attack: 0.008, decay: 0.35, level: l });
  },

  /** A mine: nasty, close, and clearly bad news. */
  mine: (l) => {
    noise({ peak: 0.5, decay: 0.5, level: l, filter: 'lowpass', freq: 1800, q: 0.6 });
    tone({ type: 'square', from: 90, to: 32, peak: 0.34, decay: 0.55, level: l });
  },

  /** Anything good found in the water. */
  pickup: (l) => {
    tone({ type: 'sine', from: 780, peak: 0.16, decay: 0.12, level: l });
    tone({ type: 'sine', from: 1170, peak: 0.16, decay: 0.16, at: 0.09, level: l });
  },

  /** A superpower going off — charge, then a big low detonation. */
  power: (l) => {
    tone({ type: 'sawtooth', from: 110, to: 640, peak: 0.16, attack: 0.18, decay: 0.12, level: l });
    noise({ peak: 0.45, decay: 0.8, at: 0.26, level: l, filter: 'lowpass', freq: 1400 });
    tone({ type: 'sine', from: 140, to: 34, peak: 0.5, attack: 0.01, decay: 0.9, at: 0.26, level: l });
  },

  /** Knocked out. */
  eliminated: (l) => {
    tone({ type: 'sawtooth', from: 300, to: 60, peak: 0.3, attack: 0.02, decay: 1.3, level: l });
    noise({ peak: 0.2, decay: 1.1, level: l, filter: 'lowpass', freq: 700 });
  },

  /** Storm warning klaxon — two falling notes. */
  alarm: (l) => {
    tone({ type: 'square', from: 600, to: 420, peak: 0.16, attack: 0.02, decay: 0.3, level: l });
    tone({ type: 'square', from: 600, to: 420, peak: 0.16, attack: 0.02, decay: 0.3, at: 0.38, level: l });
  },

  /** The hurricane passing over — a wash of low noise. */
  storm: (l) => {
    noise({ peak: 0.3, decay: 1.8, level: l, filter: 'lowpass', freq: 420, q: 0.5 });
    tone({ type: 'sine', from: 70, to: 45, peak: 0.16, attack: 0.3, decay: 1.5, level: l });
  },

  /** Last fleet afloat. */
  victory: (l) => {
    [523, 659, 784, 1047].forEach((f, i) => {
      tone({ type: 'triangle', from: f, peak: 0.22, attack: 0.01, decay: 0.5, at: i * 0.11, level: l });
    });
  },
};

/** Play one effect. Unknown names and dead audio are silently ignored. */
export function play(name, level = LEVEL.MINE) {
  if (!ready()) return;
  const make = KIT[name];
  if (!make) return;
  try { make(level); } catch { /* a failed sound must never break the game */ }
}
