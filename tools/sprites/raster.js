// A tiny software canvas for authoring pixel art in plain JS.
// Everything is integer-snapped and source-over blended — no antialiasing, because
// crisp pixel edges are exactly what reads at 23px on a phone.

const hexCache = new Map();

function parse(hex) {
  let rgb = hexCache.get(hex);
  if (!rgb) {
    const h = hex.replace('#', '');
    rgb = [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
    hexCache.set(hex, rgb);
  }
  return rgb;
}

export class Raster {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h * 4);
  }

  /** Source-over blend one pixel. Out-of-bounds writes are dropped. */
  set(x, y, hex, a = 1) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const [r, g, b] = parse(hex);
    const i = (y * this.w + x) * 4;
    const d = this.data;
    const sa = Math.min(1, a);
    const da = d[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    d[i] = Math.round((r * sa + d[i] * da * (1 - sa)) / oa);
    d[i + 1] = Math.round((g * sa + d[i + 1] * da * (1 - sa)) / oa);
    d[i + 2] = Math.round((b * sa + d[i + 2] * da * (1 - sa)) / oa);
    d[i + 3] = Math.round(oa * 255);
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return [0, 0, 0, 0];
    const i = (Math.round(y) * this.w + Math.round(x)) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  rect(x, y, w, h, hex, a = 1) {
    for (let yy = Math.round(y); yy < Math.round(y) + Math.round(h); yy++) {
      for (let xx = Math.round(x); xx < Math.round(x) + Math.round(w); xx++) {
        this.set(xx, yy, hex, a);
      }
    }
  }

  /** Filled axis-aligned ellipse. */
  ellipse(cx, cy, rx, ry, hex, a = 1) {
    if (rx <= 0 || ry <= 0) return;
    for (let yy = Math.floor(cy - ry); yy <= Math.ceil(cy + ry); yy++) {
      for (let xx = Math.floor(cx - rx); xx <= Math.ceil(cx + rx); xx++) {
        const dx = (xx - cx) / rx;
        const dy = (yy - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(xx, yy, hex, a);
      }
    }
  }

  line(x0, y0, x1, y1, hex, a = 1) {
    x0 = Math.round(x0); y0 = Math.round(y0);
    x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, hex, a);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  /** Filled polygon (even-odd scanline). `pts` is [[x,y], ...]. */
  poly(pts, hex, a = 1) {
    const ys = pts.map((p) => p[1]);
    const top = Math.floor(Math.min(...ys));
    const bot = Math.ceil(Math.max(...ys));
    for (let y = top; y <= bot; y++) {
      const xs = [];
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i];
        const [xj, yj] = pts[j];
        // Half-open test on y keeps shared vertices from double-counting.
        if ((yi > y) !== (yj > y)) xs.push(xi + ((y - yi) / (yj - yi)) * (xj - xi));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.round(xs[k]); x <= Math.round(xs[k + 1]); x++) this.set(x, y, hex, a);
      }
    }
  }

  /** Trace a 1px outline around every opaque pixel — the pixel-art "ink" pass. */
  outline(hex, a = 1) {
    const edges = [];
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        if (this.get(x, y)[3] > 0) continue;
        const near = this.get(x - 1, y)[3] > 0 || this.get(x + 1, y)[3] > 0
          || this.get(x, y - 1)[3] > 0 || this.get(x, y + 1)[3] > 0;
        if (near) edges.push([x, y]);
      }
    }
    for (const [x, y] of edges) this.set(x, y, hex, a);
  }

  blit(src, dx, dy) {
    for (let y = 0; y < src.h; y++) {
      for (let x = 0; x < src.w; x++) {
        const [r, g, b, al] = src.get(x, y);
        if (al === 0) continue;
        const i = ((dy + y) * this.w + (dx + x)) * 4;
        if (dx + x < 0 || dy + y < 0 || dx + x >= this.w || dy + y >= this.h) continue;
        this.data[i] = r;
        this.data[i + 1] = g;
        this.data[i + 2] = b;
        this.data[i + 3] = al;
      }
    }
  }
}
