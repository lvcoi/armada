// Transient battle effects. Everything renders into #fx (fixed, pointer-events:none,
// OUTSIDE the re-rendered #app) so an innerHTML rebuild can never kill an animation
// mid-flight. Every effect is transform/opacity-only, self-removing, and skipped (or
// reduced to a short static state) under prefers-reduced-motion.

const fxEl = document.getElementById('fx');
const appEl = document.getElementById('app');

const RM = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Spawn a positioned div inside #fx that removes itself when done. */
function node(cls, style = '') {
  const el = document.createElement('div');
  el.className = cls;
  el.style.cssText = style;
  fxEl.appendChild(el);
  return el;
}

const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

// ------------------------------------------------------------------ banners

/** "YOU HAVE THE CONN" — full-width phosphor bar; enemy turns get a dim tinted one. */
export function banner(text, color = null, strong = false) {
  // Rapid turns must replace the banner, not stack a double exposure.
  fxEl.querySelectorAll('.fx-banner').forEach((b) => b.remove());
  const el = node(`fx-banner${strong ? ' strong' : ''}`);
  el.textContent = text;
  if (color) el.style.setProperty('--pc', color);
  if (RM()) {
    el.style.opacity = '1';
    setTimeout(() => el.remove(), 900);
    return;
  }
  el.animate(
    [
      { opacity: 0, transform: 'translate3d(-24px, -50%, 0)' },
      { opacity: 1, transform: 'translate3d(0, -50%, 0)', offset: 0.16 },
      { opacity: 1, transform: 'translate3d(0, -50%, 0)', offset: 0.78 },
      { opacity: 0, transform: 'translate3d(12px, -50%, 0)' },
    ],
    { duration: 1300, easing: 'ease-out' },
  ).onfinish = () => el.remove();
}

// ------------------------------------------------------------------ shots

/** Particle burst at a cell — embers for a hit. */
export function burst(rect) {
  if (RM()) return;
  const { x, y } = center(rect);
  const COLORS = ['#ffd9a0', '#ff5031', '#ffffff', '#ffb547'];
  for (let i = 0; i < 12; i++) {
    const p = node('fx-p', `left:${x}px;top:${y}px;background:${COLORS[i % COLORS.length]}`);
    const a = Math.random() * Math.PI * 2;
    const v = 24 + Math.random() * 42;
    p.animate(
      [
        { transform: 'translate3d(-50%,-50%,0) scale(1)', opacity: 1 },
        {
          transform: `translate3d(calc(-50% + ${Math.cos(a) * v}px), calc(-50% + ${Math.sin(a) * v + 18}px), 0) scale(.2)`,
          opacity: 0,
        },
      ],
      { duration: 480 + Math.random() * 160, easing: 'cubic-bezier(.2,.7,.3,1)' },
    ).onfinish = () => p.remove();
  }
}

/** Two expanding sonar rings + a little spray — a miss. */
export function splash(rect) {
  if (RM()) return;
  const { x, y } = center(rect);
  for (let i = 0; i < 2; i++) {
    const r = node('fx-ring', `left:${x}px;top:${y}px`);
    r.animate(
      [
        { transform: 'translate3d(-50%,-50%,0) scale(.3)', opacity: 0.85 },
        { transform: 'translate3d(-50%,-50%,0) scale(1.9)', opacity: 0 },
      ],
      { duration: 640, delay: i * 120, easing: 'ease-out', fill: 'backwards' },
    ).onfinish = () => r.remove();
  }
  for (let i = 0; i < 4; i++) {
    const p = node('fx-p', `left:${x}px;top:${y}px;background:#5cc9ec`);
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.2;
    const v = 14 + Math.random() * 18;
    p.animate(
      [
        { transform: 'translate3d(-50%,-50%,0)', opacity: 0.9 },
        { transform: `translate3d(${Math.cos(a) * v}px, ${Math.sin(a) * v}px, 0)`, opacity: 0 },
      ],
      { duration: 420, easing: 'ease-out' },
    ).onfinish = () => p.remove();
  }
}

/** Incoming shell streaking onto YOUR board, then the payload lands. */
export function shell(rect, onLand) {
  if (RM()) { onLand?.(); return; }
  const { x, y } = center(rect);
  const s = node('fx-shell', `left:${x}px;top:${y}px`);
  s.animate(
    [
      { transform: 'translate3d(120px, -170px, 0) scale(1.1)', opacity: 0 },
      { transform: 'translate3d(66px, -94px, 0) scale(1)', opacity: 1, offset: 0.25 },
      { transform: 'translate3d(-50%, -50%, 0) scale(.8)', opacity: 1 },
    ],
    { duration: 420, easing: 'cubic-bezier(.2,.7,.3,1)' },
  ).onfinish = () => { s.remove(); onLand?.(); };
}

/** Phosphor tracer from the bottom sheet up to the auto-fired cell. */
export function tracer(rect, onLand) {
  if (RM()) { onLand?.(); return; }
  const { x, y } = center(rect);
  const fromY = innerHeight - 60;
  const len = Math.max(0, fromY - y);
  const line = node('fx-tracer', `left:${x}px;top:${y}px;height:${len}px`);
  line.animate(
    [
      { transform: 'scaleY(0)', opacity: 0.9 },
      { transform: 'scaleY(1)', opacity: 0.9, offset: 0.7 },
      { transform: 'scaleY(1)', opacity: 0 },
    ],
    { duration: 360, easing: 'ease-in' },
  ).onfinish = () => { line.remove(); onLand?.(); };
}

/** Red-alert overlay flash + deck shake when YOUR board takes fire. */
export function struck() {
  const flash = node('fx-flash');
  flash.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260 }).onfinish = () => flash.remove();
  if (RM()) return;
  appEl.classList.remove('shake');
  void appEl.offsetWidth; // restart the keyframe if two hits land back to back
  appEl.classList.add('shake');
  setTimeout(() => appEl.classList.remove('shake'), 420);
}

/** Kill sequence garnish: rising smoke over the wreck. */
export function smoke(rect) {
  if (RM()) return;
  const { x, y } = center(rect);
  for (let i = 0; i < 5; i++) {
    const p = node('fx-smoke', `left:${x + (Math.random() - 0.5) * 22}px;top:${y}px`);
    p.animate(
      [
        { transform: 'translate3d(-50%,-50%,0) scale(.6)', opacity: 0.5 },
        { transform: `translate3d(${(Math.random() - 0.5) * 20 - 8}px, -44px, 0) scale(1.4)`, opacity: 0 },
      ],
      { duration: 1100, delay: i * 140, easing: 'ease-out', fill: 'backwards' },
    ).onfinish = () => p.remove();
  }
}

// ------------------------------------------------------------------ mines & pickups

/**
 * A sea mine going off. Everyone on the board sees this one, so it has to hit harder
 * than an ordinary hit burst: a white core that overexposes and collapses, a red
 * shockwave running out, dark debris arcing under gravity, and smoke left hanging.
 * ~860ms, threat red + white only — deliberately outside the amber/phosphor language.
 */
export function mineBlast(rect) {
  const { x, y } = center(rect);
  const at = `left:${x}px;top:${y}px`;

  if (RM()) {
    // No motion: hold the aftermath — a scorch ring — long enough to be read, then clear.
    const s = node('fx-scorch', at);
    setTimeout(() => s.remove(), 700);
    return;
  }

  // 1. Core: blows past white, holds a beat, then collapses.
  // Easing lives on the keyframes, not the effect: an effect-level easing warps the
  // progress the offsets are read against, which would swallow the hold.
  const core = node('fx-mine-core', at);
  core.animate(
    [
      { transform: 'translate3d(-50%,-50%,0) scale(.25)', opacity: 1, easing: 'cubic-bezier(.05,.9,.2,1)' },
      { transform: 'translate3d(-50%,-50%,0) scale(1.15)', opacity: 1, offset: 0.3, easing: 'linear' },
      { transform: 'translate3d(-50%,-50%,0) scale(1)', opacity: 1, offset: 0.5, easing: 'cubic-bezier(.6,0,.9,.5)' },
      { transform: 'translate3d(-50%,-50%,0) scale(.15)', opacity: 0 },
    ],
    { duration: 260, easing: 'linear' },
  ).onfinish = () => core.remove();

  // 2. Shockwave: a thin white edge out front, heavy red rings behind it.
  const RINGS = [
    ['fx-mine-ring edge', 3.6, 360, 0],
    ['fx-mine-ring', 4.4, 620, 70],
    ['fx-mine-ring', 2.7, 660, 210],
  ];
  for (const [cls, to, duration, delay] of RINGS) {
    const r = node(cls, at);
    // Opacity starts at 0 so a delayed ring is invisible while it waits its turn
    // (a backwards fill would otherwise park a hard little donut on the cell).
    r.animate(
      [
        { transform: 'translate3d(-50%,-50%,0) scale(.22)', opacity: 0, easing: 'linear' },
        { transform: 'translate3d(-50%,-50%,0) scale(.5)', opacity: 1, offset: 0.07, easing: 'cubic-bezier(.05,.8,.3,1)' },
        { transform: `translate3d(-50%,-50%,0) scale(${to})`, opacity: 0 },
      ],
      { duration, delay, easing: 'linear', fill: 'backwards' },
    ).onfinish = () => r.remove();
  }

  // 3. Debris: casing fragments thrown up and out, then dragged back down.
  const DEBRIS = ['#0a0d10', '#181f24', '#4a1409', '#ff5031'];
  for (let i = 0; i < 18; i++) {
    const p = node('fx-debris', `${at};background:${DEBRIS[i % DEBRIS.length]}`);
    const a = Math.random() * Math.PI * 2;
    const v = 46 + Math.random() * 98;
    const vx = Math.cos(a) * v;
    const vy = Math.sin(a) * v * 0.7 - 30; // biased upward, out of the water
    const spin = (Math.random() - 0.5) * 720;
    p.animate(
      [
        {
          transform: 'translate3d(-50%,-50%,0) rotate(0deg) scale(1)',
          opacity: 1,
          easing: 'cubic-bezier(.1,.6,.4,1)', // thrown out hard, then drag takes over
        },
        {
          transform: `translate3d(calc(-50% + ${vx * 0.62}px), calc(-50% + ${vy * 0.62}px), 0) rotate(${spin * 0.5}deg) scale(1)`,
          opacity: 1,
          offset: 0.45,
          easing: 'cubic-bezier(.4,0,.9,.7)', // gravity wins
        },
        {
          transform: `translate3d(calc(-50% + ${vx}px), calc(-50% + ${vy + 78}px), 0) rotate(${spin}deg) scale(.55)`,
          opacity: 0,
        },
      ],
      { duration: 620 + Math.random() * 200, easing: 'linear' },
    ).onfinish = () => p.remove();
  }

  // 4. Smoke: the part that lingers after the violence is over.
  for (let i = 0; i < 5; i++) {
    const s = node('fx-mine-smoke', `left:${x + (Math.random() - 0.5) * 26}px;top:${y}px`);
    s.animate(
      [
        { transform: 'translate3d(-50%,-50%,0) scale(.4)', opacity: 0, easing: 'ease-out' },
        { transform: 'translate3d(-50%,-50%,0) scale(1.1)', opacity: 0.6, offset: 0.28, easing: 'linear' },
        {
          transform: `translate3d(calc(-50% + ${(Math.random() - 0.5) * 26}px), calc(-50% - 42px), 0) scale(2.1)`,
          opacity: 0,
        },
      ],
      { duration: 620, delay: 60 + i * 45, easing: 'linear', fill: 'backwards' },
    ).onfinish = () => s.remove();
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Build a power-up glyph from a shape list — no markup strings, no assets. */
function glyphSVG(parts) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2.05', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  })) svg.setAttribute(k, v);
  for (const [tag, attrs] of parts) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

/* The four power-ups: one viewBox and one stroke weight so they read as a family,
   with a kind hue mixed into the finder's accent for a nudge of difference. */
const PICKUPS = {
  // Sweep arc.
  radar: {
    hue: '#5cc9ec',
    parts: [
      ['circle', { cx: 12, cy: 12, r: 9.4 }],
      ['path', { d: 'M12 12 L12 2.6 A9.4 9.4 0 0 1 20.14 7.3 Z', fill: 'currentColor', stroke: 'none', opacity: 0.5 }],
      ['path', { d: 'M12 12 L20.14 7.3' }],
      ['circle', { cx: 12, cy: 12, r: 1.6, fill: 'currentColor', stroke: 'none' }],
    ],
  },
  // Shell in its casing.
  extra: {
    hue: '#ffd9a0',
    parts: [
      ['path', { d: 'M12 2.2c2.9 2.8 4.2 5.5 4.2 8.1v10.5H7.8V10.3c0-2.6 1.3-5.3 4.2-8.1z' }],
      ['path', { d: 'M7.8 11.6h8.4M7.8 16.2h8.4' }],
    ],
  },
  // Repair cross.
  repair: {
    hue: '#3ddc97',
    parts: [
      ['circle', { cx: 12, cy: 12, r: 9.2, opacity: 0.5 }],
      ['path', { d: 'M12 6.2v11.6M6.2 12h11.6', 'stroke-width': 3.3 }],
    ],
  },
  // Supply crate.
  recharge: {
    hue: '#c9ffef',
    parts: [
      ['rect', { x: 3.2, y: 5.4, width: 17.6, height: 13.4, rx: 1.6 }],
      ['path', { d: 'M3.2 9.6h17.6' }],
      ['path', { d: 'M3.2 9.6 L20.8 18.8M20.8 9.6 L3.2 18.8', opacity: 0.45 }],
    ],
  },
};

/**
 * Someone just picked a power-up up off the water — everyone sees it, so it has to
 * read as GOOD: a soft ring opening out, the kind's glyph rising above the cell, and
 * a few sparkles going up with it. ~860ms in the finder's accent colour.
 */
export function pickupCollected(rect, kind, color) {
  const { x, y } = center(rect);
  const at = `left:${x}px;top:${y}px`;
  const k = PICKUPS[kind] ?? PICKUPS.extra;
  const tint = `color-mix(in oklab, ${k.hue} 45%, ${color || '#39f0c3'})`;

  const glyph = node('fx-glyph', at);
  glyph.style.setProperty('--pc', tint);
  glyph.appendChild(glyphSVG(k.parts));

  if (RM()) {
    // No motion: show the end of the story — glyph up, ring already open — and hold it.
    const r = node('fx-pickup-ring', at);
    r.style.setProperty('--pc', tint);
    r.style.transform = 'translate3d(-50%,-50%,0) scale(1.7)';
    r.style.opacity = '.5';
    glyph.style.transform = 'translate3d(-50%, calc(-50% - 32px), 0)';
    setTimeout(() => { r.remove(); glyph.remove(); }, 700);
    return;
  }

  for (let i = 0; i < 2; i++) {
    const r = node(`fx-pickup-ring${i ? ' soft' : ''}`, at);
    r.style.setProperty('--pc', tint);
    r.animate(
      [
        { transform: 'translate3d(-50%,-50%,0) scale(.35)', opacity: 0, easing: 'linear' },
        { transform: 'translate3d(-50%,-50%,0) scale(.6)', opacity: 0.95, offset: 0.08, easing: 'cubic-bezier(.22,1,.36,1)' },
        { transform: `translate3d(-50%,-50%,0) scale(${i ? 2.6 : 2})`, opacity: 0 },
      ],
      { duration: 700, delay: i * 130, easing: 'linear', fill: 'backwards' },
    ).onfinish = () => r.remove();
  }

  glyph.animate(
    [
      { transform: 'translate3d(-50%, calc(-50% + 4px), 0) scale(.5)', opacity: 0, easing: 'cubic-bezier(.2,1.4,.5,1)' },
      { transform: 'translate3d(-50%, calc(-50% - 6px), 0) scale(1.15)', opacity: 1, offset: 0.22, easing: 'ease-out' },
      { transform: 'translate3d(-50%, calc(-50% - 28px), 0) scale(1)', opacity: 1, offset: 0.62, easing: 'ease-in' },
      { transform: 'translate3d(-50%, calc(-50% - 52px), 0) scale(1)', opacity: 0 },
    ],
    { duration: 860, easing: 'linear' },
  ).onfinish = () => glyph.remove();

  for (let i = 0; i < 6; i++) {
    const s = node('fx-spark', `left:${x + (Math.random() - 0.5) * 30}px;top:${y + 6}px`);
    s.style.setProperty('--pc', tint);
    const dx = (Math.random() - 0.5) * 26;
    s.animate(
      [
        { transform: 'translate3d(-50%,-50%,0) scale(.4)', opacity: 0, easing: 'ease-out' },
        { transform: `translate3d(calc(-50% + ${dx * 0.4}px), calc(-50% - 14px), 0) scale(1)`, opacity: 1, offset: 0.3, easing: 'linear' },
        { transform: `translate3d(calc(-50% + ${dx}px), calc(-50% - ${34 + Math.random() * 24}px), 0) scale(.3)`, opacity: 0 },
      ],
      { duration: 620 + Math.random() * 200, delay: i * 45, easing: 'linear', fill: 'backwards' },
    ).onfinish = () => s.remove();
  }
}

// ------------------------------------------------------------------ moments

/** "FLEET DESTROYED" stamp when someone is knocked out. */
export function stamp(text) {
  const el = node('fx-stamp');
  el.textContent = text;
  if (RM()) {
    el.style.opacity = '1';
    setTimeout(() => el.remove(), 1200);
    return;
  }
  el.animate(
    [
      { opacity: 0, transform: 'translate3d(-50%,-50%,0) rotate(-8deg) scale(1.6)' },
      { opacity: 1, transform: 'translate3d(-50%,-50%,0) rotate(-8deg) scale(1)', offset: 0.14 },
      { opacity: 1, transform: 'translate3d(-50%,-50%,0) rotate(-8deg) scale(1)', offset: 0.85 },
      { opacity: 0, transform: 'translate3d(-50%,-50%,0) rotate(-8deg) scale(1)' },
    ],
    { duration: 1600, easing: 'cubic-bezier(.34,1.56,.64,1)' },
  ).onfinish = () => el.remove();
}

/** Victory barrage: ember flares from the corners plus a confetti rain. */
export function victory(color = '#39f0c3') {
  if (RM()) return;
  const COLORS = [color, '#39f0c3', '#ffffff', '#ffb547', '#5cc9ec'];
  for (let wave = 0; wave < 3; wave++) {
    setTimeout(() => {
      for (let i = 0; i < 16; i++) {
        const fromLeft = i % 2 === 0;
        const p = node('fx-p', `left:${fromLeft ? 20 : innerWidth - 20}px;top:${innerHeight - 30}px;background:${COLORS[i % COLORS.length]}`);
        const vx = (fromLeft ? 1 : -1) * (30 + Math.random() * 140);
        const vy = -(160 + Math.random() * 240);
        p.animate(
          [
            { transform: 'translate3d(0,0,0)', opacity: 1 },
            { transform: `translate3d(${vx}px, ${vy}px, 0)`, opacity: 1, offset: 0.6 },
            { transform: `translate3d(${vx * 1.4}px, ${vy + 130}px, 0)`, opacity: 0 },
          ],
          { duration: 1400, easing: 'cubic-bezier(.2,.7,.4,1)' },
        ).onfinish = () => p.remove();
      }
    }, wave * 380);
  }
  for (let i = 0; i < 40; i++) {
    const c = node('fx-confetti', `left:${Math.random() * 100}vw;top:-12px;background:${COLORS[i % COLORS.length]}`);
    c.animate(
      [
        { transform: 'translate3d(0,0,0) rotate(0deg)', opacity: 1 },
        {
          transform: `translate3d(${(Math.random() - 0.5) * 90}px, ${innerHeight + 40}px, 0) rotate(${540 + Math.random() * 360}deg)`,
          opacity: 0.9,
        },
      ],
      { duration: 2000 + Math.random() * 900, delay: Math.random() * 500, easing: 'cubic-bezier(.3,.4,.6,1)', fill: 'backwards' },
    ).onfinish = () => c.remove();
  }
}

/** Connection-lost treatment: desaturate the console, roll scanlines. */
let scan = null;
export function signalLost(on) {
  appEl.classList.toggle('offline', on);
  if (on && !scan && !RM()) {
    scan = node('fx-scan');
  } else if (!on && scan) {
    scan.remove();
    scan = null;
  }
}
