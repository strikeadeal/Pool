// Procedural art, painted once with Canvas 2D (at start-up or on resize, never per frame). paintScene runs in a worker
// (js/paint.js) where OffscreenCanvas exists, so it uses no DOM.
import { L, W, FOOT_X, TABLE } from './physics.js';
import { RAIL, CUSHION } from './layout.js';

export const LAMPS = [[L * 0.27, W / 2, 1.05], [L * 0.73, W / 2, 1.05]];   // world x, y, height
export const FELT_RGB = [0.11, 0.35, 0.62];

const HOLE_R = 0.058;
export function holeCentre(p) {
  const pk = TABLE.pockets[p];
  const d = pk.drop + HOLE_R;
  return [pk.mx + pk.ax * d, pk.my + pk.ay * d, HOLE_R];
}

const canvas = (w, h) => {
  if (typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
};

// Cloth weave noise: the pixels of a 128 px tile. Made on the main thread and passed to the worker, so Math.random
// is called in the same place as before (tests seed it to compare paintings).
export function noisePixels(size = 128, alpha = 16) {
  const d = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = Math.random() * alpha;
  }
  return d;
}
function makeNoise(px, size = 128) {
  const c = canvas(size, size);
  c.getContext('2d').putImageData(new ImageData(px, size, size), 0, 0);
  return c;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
  g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r);
  g.lineTo(x + r, y + h); g.arcTo(x, y + h, x, y + h - r, r);
  g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r); g.closePath();
}

// Felt outline including the pocket throats, walked counter-clockwise: for each pocket the
// entry nose, down its facing, across the throat, up the other facing to the exit nose.
function feltPath(g) {
  const S = TABLE.segs;
  g.beginPath();
  let first = true;
  for (let p = 0; p < 6; p++) {
    const pk = TABLE.pockets[p];
    const f = [];
    for (let k = 6; k < S.length / 9; k++) {
      const o = k * 9;
      if (Math.hypot((S[o] + S[o + 2]) / 2 - pk.mx, (S[o + 1] + S[o + 3]) / 2 - pk.my) < 0.12) f.push([S[o], S[o + 1], S[o + 2], S[o + 3]]);
    }
    const ang = (q) => Math.atan2(q[1] - W / 2, q[0] - L / 2);
    f.sort((u, v) => ang(u) - ang(v));
    const pts = [[f[0][0], f[0][1]], [f[0][2], f[0][3]], [f[1][2], f[1][3]], [f[1][0], f[1][1]]];
    for (const [x, y] of pts) { if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y); }
  }
  g.closePath();
}

export function paintScene(lay, dpr, noise = noisePixels()) {
  const cw = Math.round(lay.w * dpr), ch = Math.round(lay.h * dpr);
  const c = canvas(cw, ch);
  const g = c.getContext('2d');
  // Room
  const [tcx, tcy] = [lay.cx * dpr, lay.cy * dpr];
  const room = g.createRadialGradient(tcx, tcy, 0, tcx, tcy, Math.max(cw, ch) * 0.75);
  room.addColorStop(0, '#1a2c4c'); room.addColorStop(0.45, '#0b1628'); room.addColorStop(1, '#03070f');
  g.fillStyle = room; g.fillRect(0, 0, cw, ch);

  const s = lay.s * dpr;
  const a = s * lay.ex[0], b = s * lay.ex[1], cc = s * lay.ey[0], d = s * lay.ey[1];
  const e = lay.cx * dpr - (L / 2) * a - (W / 2) * cc;
  const f = lay.cy * dpr - (L / 2) * b - (W / 2) * d;
  const world = () => g.setTransform(a, b, cc, d, e, f);
  world();

  // Shadow of the table on the floor
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.75)'; g.shadowBlur = 40 * dpr; g.shadowOffsetX = 0; g.shadowOffsetY = 10 * dpr;
  roundRect(g, -RAIL, -RAIL, L + 2 * RAIL, W + 2 * RAIL, 0.05);
  g.fillStyle = '#000'; g.fill();
  g.restore();

  // Rails: matte black, like a TV tournament table
  g.save();
  roundRect(g, -RAIL, -RAIL, L + 2 * RAIL, W + 2 * RAIL, 0.05);
  g.clip();
  const wood = g.createLinearGradient(0, -RAIL, 0, W + RAIL);
  wood.addColorStop(0, '#1e2126'); wood.addColorStop(0.5, '#141619'); wood.addColorStop(1, '#1e2126');
  g.fillStyle = wood; g.fillRect(-RAIL, -RAIL, L + 2 * RAIL, W + 2 * RAIL);
  // faint grain along each rail
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const grain = (horizontal, c0, c1) => {
    for (let k = 0; k < 70; k++) {
      const t = c0 + rnd() * (c1 - c0);
      const amp = 0.0015 + rnd() * 0.004, wl = 0.2 + rnd() * 0.6, ph = rnd() * 6.28;
      g.strokeStyle = rnd() < 0.5 ? `rgba(0,0,0,${(0.15 + rnd() * 0.25) * 0.25})` : `rgba(120,140,170,${(0.05 + rnd() * 0.12) * 0.25})`;
      g.lineWidth = 0.0006 + rnd() * 0.0022;
      g.beginPath();
      for (let u = -RAIL; u <= (horizontal ? L : W) + RAIL; u += 0.02) {
        const v = t + Math.sin(u / wl + ph) * amp;
        if (horizontal) (u === -RAIL ? g.moveTo(u, v) : g.lineTo(u, v)); else (u === -RAIL ? g.moveTo(v, u) : g.lineTo(v, u));
      }
      g.stroke();
    }
  };
  grain(true, -RAIL, -CUSHION); grain(true, W + CUSHION, W + RAIL);
  grain(false, -RAIL, -CUSHION); grain(false, L + CUSHION, L + RAIL);
  // lamp light on the rails
  g.globalCompositeOperation = 'lighter';
  for (const [lx, ly] of LAMPS) {
    const lg = g.createRadialGradient(lx, ly, 0, lx, ly, 0.9);
    lg.addColorStop(0, 'rgba(110,135,175,0.20)'); lg.addColorStop(1, 'rgba(110,135,175,0)');
    g.fillStyle = lg; g.fillRect(-RAIL, -RAIL, L + 2 * RAIL, W + 2 * RAIL);
  }
  g.globalCompositeOperation = 'source-over';
  // bevels
  g.lineWidth = 0.004;
  g.strokeStyle = 'rgba(200,220,255,0.16)';
  roundRect(g, -RAIL + 0.004, -RAIL + 0.004, L + 2 * RAIL - 0.008, W + 2 * RAIL - 0.008, 0.046); g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 0.006;
  roundRect(g, -RAIL, -RAIL, L + 2 * RAIL, W + 2 * RAIL, 0.05); g.stroke();
  g.restore();

  // Cushion rubber strip (cloth-covered)
  // each strip shaded across its width: lit at the nose, falling into shadow at the rail
  g.fillStyle = '#0f3463'; g.fillRect(-CUSHION, -CUSHION, L + 2 * CUSHION, W + 2 * CUSHION);
  for (const [x0, y0, x1, y1, w, h] of [
    [0, 0, 0, -CUSHION, L, -CUSHION], [0, W, 0, W + CUSHION, L, CUSHION],
    [0, 0, -CUSHION, 0, -CUSHION, W], [L, 0, L + CUSHION, 0, CUSHION, W]]) {
    const cg = g.createLinearGradient(x0, y0, x1, y1);
    cg.addColorStop(0, '#2563ab'); cg.addColorStop(0.35, '#1c5192'); cg.addColorStop(1, '#0f3363');
    g.fillStyle = cg;
    g.fillRect(x0, y0, w, h);
  }
  g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 0.003;
  g.strokeRect(-CUSHION, -CUSHION, L + 2 * CUSHION, W + 2 * CUSHION);

  // Felt with pocket throats
  g.save();
  feltPath(g);
  g.clip('nonzero');
  const felt = g.createRadialGradient(L / 2, W / 2, 0.1, L / 2, W / 2, L * 0.62);
  felt.addColorStop(0, '#2366b2'); felt.addColorStop(0.6, '#1d599f'); felt.addColorStop(1, '#154580');
  g.fillStyle = felt; g.fillRect(-0.2, -0.2, L + 0.4, W + 0.4);
  g.globalCompositeOperation = 'lighter';
  for (const [lx, ly] of LAMPS) {
    const lg = g.createRadialGradient(lx, ly, 0, lx, ly, 0.75);
    lg.addColorStop(0, 'rgba(70,130,210,0.20)'); lg.addColorStop(0.5, 'rgba(50,110,190,0.08)'); lg.addColorStop(1, 'rgba(50,110,190,0)');
    g.fillStyle = lg; g.fillRect(-0.2, -0.2, L + 0.4, W + 0.4);
  }
  g.globalCompositeOperation = 'source-over';
  // cushion shadow on the cloth
  const sh = 0.016;
  for (const [x0, y0, x1, y1, dx, dy] of [[0, 0, L, 0, 0, 1], [0, W, L, W, 0, -1], [0, 0, 0, W, 1, 0], [L, 0, L, W, -1, 0]]) {
    const lg = g.createLinearGradient(x0, y0, x0 + dx * sh, y0 + dy * sh);
    lg.addColorStop(0, 'rgba(0,0,0,0.38)'); lg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = lg;
    g.fillRect(Math.min(x0, x0 + dx * sh), Math.min(y0, y0 + dy * sh), Math.max(x1 - x0, Math.abs(dx * sh)), Math.max(y1 - y0, Math.abs(dy * sh)));
  }
  // cloth weave noise, applied in device space
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = g.createPattern(makeNoise(noise), 'repeat');
  g.fillRect(0, 0, cw, ch);
  world();
  // cloth mark near the head rail and the foot spot
  g.fillStyle = 'rgba(255,255,255,0.10)';
  g.beginPath(); g.arc(FOOT_X, W / 2, 0.006, 0, Math.PI * 2); g.fill();
  g.restore();

  // Cushion nose highlight (rail segments and facings)
  const S = TABLE.segs;
  g.lineCap = 'round';
  for (let k = 0; k < S.length / 9; k++) {
    const o = k * 9;
    g.strokeStyle = k < 6 ? 'rgba(150,200,255,0.42)' : 'rgba(130,180,240,0.32)';
    g.lineWidth = 0.0035;
    g.beginPath(); g.moveTo(S[o], S[o + 1]); g.lineTo(S[o + 2], S[o + 3]); g.stroke();
  }

  // Pockets
  for (let p = 0; p < 6; p++) {
    const [hx, hy, hr] = holeCentre(p);
    // liner
    g.fillStyle = '#0b0c0e';
    g.beginPath(); g.arc(hx, hy, hr + 0.014, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(200,220,255,0.10)'; g.lineWidth = 0.003;
    g.beginPath(); g.arc(hx, hy, hr + 0.012, 0, Math.PI * 2); g.stroke();
    const hole = g.createRadialGradient(hx, hy, hr * 0.2, hx, hy, hr);
    hole.addColorStop(0, '#000'); hole.addColorStop(0.75, '#020202'); hole.addColorStop(1, '#151515');
    g.fillStyle = hole;
    g.beginPath(); g.arc(hx, hy, hr, 0, Math.PI * 2); g.fill();
  }
  // re-draw the felt shelf lip so the hole edge reads as a drop
  for (let p = 0; p < 6; p++) {
    const [hx, hy, hr] = holeCentre(p);
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 0.004;
    g.beginPath(); g.arc(hx, hy, hr - 0.002, 0, Math.PI * 2); g.stroke();
  }

  // Diamond sights
  const dm = CUSHION + (RAIL - CUSHION) / 2;
  const diamonds = [];
  for (const k of [1, 2, 3, 5, 6, 7]) { diamonds.push([(L * k) / 8, -dm, 0], [(L * k) / 8, W + dm, 0]); }
  for (const k of [1, 2, 3]) { diamonds.push([-dm, (W * k) / 4, 1], [L + dm, (W * k) / 4, 1]); }
  for (const [x, y, rot] of diamonds) {
    const hw = rot ? 0.008 : 0.0045, hh = rot ? 0.0045 : 0.008;
    const dg = g.createLinearGradient(x - hw, y - hh, x + hw, y + hh);
    dg.addColorStop(0, '#ffffff'); dg.addColorStop(0.5, '#e8ebf1'); dg.addColorStop(1, '#b9c0cc');
    g.fillStyle = dg;
    g.beginPath(); g.moveTo(x - hw, y); g.lineTo(x, y - hh); g.lineTo(x + hw, y); g.lineTo(x, y + hh); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 0.0012; g.stroke();
  }
  // Vignette over everything
  g.setTransform(1, 0, 0, 1, 0, 0);
  const vg = g.createRadialGradient(tcx, tcy, Math.min(cw, ch) * 0.35, tcx, tcy, Math.max(cw, ch) * 0.8);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = vg; g.fillRect(0, 0, cw, ch);
  return c;
}

// Ball numbers: 4x4 atlas of 64px cells, index = ball number.
export function paintDigits() {
  const c = canvas(256, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let n = 1; n < 16; n++) {
    const cx = (n % 4) * 64 + 32, cy = Math.floor(n / 4) * 64 + 32;
    g.font = `800 ${n > 9 ? 36 : 42}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
    g.fillText(String(n), cx, cy + 2);
    if (n === 6 || n === 9) g.fillRect(cx - 9, cy + 20, 18, 3.5);
  }
  return c;
}

// Cue stick, tip at the left. 512x32, shaded as a cylinder across its height.
export function paintCue() {
  const c = canvas(512, 32);
  const g = c.getContext('2d');
  const bands = [
    [0, 0.012, '#3d6fb3'],     // chalked tip
    [0.012, 0.03, '#f2ecdc'],  // ferrule
    [0.03, 0.6, null],         // maple shaft (gradient)
    [0.6, 0.612, '#c9ccd1'],   // joint
    [0.612, 0.79, '#3b1f12'],  // forearm
    [0.79, 0.93, '#151515'],   // wrap
    [0.93, 0.985, '#4a2616'],  // butt sleeve
    [0.985, 1, '#0b0b0b'],     // bumper
  ];
  for (const [u0, u1, col] of bands) {
    if (col) g.fillStyle = col;
    else { const lg = g.createLinearGradient(u0 * 512, 0, u1 * 512, 0); lg.addColorStop(0, '#efdcb4'); lg.addColorStop(1, '#d9b882'); g.fillStyle = lg; }
    g.fillRect(u0 * 512, 0, (u1 - u0) * 512 + 1, 32);
  }
  // forearm inlay points
  g.fillStyle = '#e9dcc0';
  for (const yy of [8, 24]) { g.beginPath(); g.moveTo(0.612 * 512, yy); g.lineTo(0.74 * 512, 16); g.lineTo(0.612 * 512, 16 + (yy - 16) * 0.3); g.fill(); }
  // wrap texture
  g.fillStyle = 'rgba(255,255,255,0.06)';
  for (let x = 0.79 * 512; x < 0.93 * 512; x += 4) g.fillRect(x, 0, 1.5, 32);
  // brass rings
  g.fillStyle = '#c9a24a'; g.fillRect(0.79 * 512 - 2, 0, 2, 32); g.fillRect(0.93 * 512, 0, 2, 32);
  // cylinder shading
  const sh = g.createLinearGradient(0, 0, 0, 32);
  sh.addColorStop(0, 'rgba(255,255,255,0.35)'); sh.addColorStop(0.3, 'rgba(255,255,255,0.05)');
  sh.addColorStop(0.65, 'rgba(0,0,0,0.15)'); sh.addColorStop(1, 'rgba(0,0,0,0.6)');
  g.fillStyle = sh; g.fillRect(0, 0, 512, 32);
  return c;
}

export const BALL_COLORS = [
  '#f6f1e3', '#f4bf16', '#1d50c2', '#d4261f', '#5a2b8a', '#ef7419', '#178548', '#8b1d25',
  '#141414', '#f4bf16', '#1d50c2', '#d4261f', '#5a2b8a', '#ef7419', '#178548', '#8b1d25',
];
export const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
