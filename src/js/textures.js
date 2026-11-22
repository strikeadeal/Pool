// Procedural art, painted once with Canvas 2D (at start-up or on resize, never per frame).
import { L, W, R, FOOT_X, TABLE } from './physics.js';
import { RAIL, CUSHION } from './layout.js';

export const LAMPS = [[L * 0.27, W / 2, 1.05], [L * 0.73, W / 2, 1.05]];   // world x, y, height
export const FELT_RGB = [0.05, 0.36, 0.38];

const HOLE_R = 0.058;
export function holeCentre(p) {
  const pk = TABLE.pockets[p];
  const d = pk.drop + HOLE_R;
  return [pk.mx + pk.ax * d, pk.my + pk.ay * d, HOLE_R];
}

function makeNoise(size, alpha) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = Math.random() * alpha;
  }
  g.putImageData(img, 0, 0);
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

export function paintScene(lay, dpr) {
  const cw = Math.round(lay.w * dpr), ch = Math.round(lay.h * dpr);
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const g = c.getContext('2d');
  // Room
  const [tcx, tcy] = [lay.cx * dpr, lay.cy * dpr];
  const room = g.createRadialGradient(tcx, tcy, 0, tcx, tcy, Math.max(cw, ch) * 0.75);
  room.addColorStop(0, '#1d2628'); room.addColorStop(0.45, '#0e1416'); room.addColorStop(1, '#040607');
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
  g.fillStyle = '#20130b'; g.fill();
  g.restore();

  // Wood rails
  g.save();
  roundRect(g, -RAIL, -RAIL, L + 2 * RAIL, W + 2 * RAIL, 0.05);
  g.clip();
  const wood = g.createLinearGradient(0, -RAIL, 0, W + RAIL);
  wood.addColorStop(0, '#3a2215'); wood.addColorStop(0.5, '#2c180e'); wood.addColorStop(1, '#3a2215');
  g.fillStyle = wood; g.fillRect(-RAIL, -RAIL, L + 2 * RAIL, W + 2 * RAIL);
  // grain along each rail
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const grain = (horizontal, c0, c1) => {
    for (let k = 0; k < 70; k++) {
      const t = c0 + rnd() * (c1 - c0);
      const amp = 0.0015 + rnd() * 0.004, wl = 0.2 + rnd() * 0.6, ph = rnd() * 6.28;
      g.strokeStyle = rnd() < 0.5 ? `rgba(15,7,3,${0.15 + rnd() * 0.25})` : `rgba(120,70,40,${0.05 + rnd() * 0.12})`;
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
  // lamp light on the wood
  g.globalCompositeOperation = 'lighter';
  for (const [lx, ly] of LAMPS) {
    const lg = g.createRadialGradient(lx, ly, 0, lx, ly, 0.9);
    lg.addColorStop(0, 'rgba(120,80,45,0.30)'); lg.addColorStop(1, 'rgba(120,80,45,0)');
    g.fillStyle = lg; g.fillRect(-RAIL, -RAIL, L + 2 * RAIL, W + 2 * RAIL);
  }
  g.globalCompositeOperation = 'source-over';
  // bevels
  g.lineWidth = 0.004;
  g.strokeStyle = 'rgba(255,210,160,0.16)';
  roundRect(g, -RAIL + 0.004, -RAIL + 0.004, L + 2 * RAIL - 0.008, W + 2 * RAIL - 0.008, 0.046); g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.55)'; g.lineWidth = 0.006;
  roundRect(g, -RAIL, -RAIL, L + 2 * RAIL, W + 2 * RAIL, 0.05); g.stroke();
  g.restore();

  // Cushion rubber strip (cloth-covered)
  const cush = g.createLinearGradient(0, -CUSHION, 0, W + CUSHION);
  cush.addColorStop(0, '#08393c'); cush.addColorStop(0.5, '#0a4a4e'); cush.addColorStop(1, '#08393c');
  g.fillStyle = cush; g.fillRect(-CUSHION, -CUSHION, L + 2 * CUSHION, W + 2 * CUSHION);
  g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 0.003;
  g.strokeRect(-CUSHION, -CUSHION, L + 2 * CUSHION, W + 2 * CUSHION);

  // Felt with pocket throats
  g.save();
  feltPath(g);
  g.clip('nonzero');
  const felt = g.createRadialGradient(L / 2, W / 2, 0.1, L / 2, W / 2, L * 0.62);
  felt.addColorStop(0, '#11686d'); felt.addColorStop(0.6, '#0d5a5f'); felt.addColorStop(1, '#083f43');
  g.fillStyle = felt; g.fillRect(-0.2, -0.2, L + 0.4, W + 0.4);
  g.globalCompositeOperation = 'lighter';
  for (const [lx, ly] of LAMPS) {
    const lg = g.createRadialGradient(lx, ly, 0, lx, ly, 0.75);
    lg.addColorStop(0, 'rgba(40,110,105,0.30)'); lg.addColorStop(0.5, 'rgba(30,90,90,0.12)'); lg.addColorStop(1, 'rgba(30,90,90,0)');
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
  g.fillStyle = g.createPattern(makeNoise(128, 22), 'repeat');
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
    g.strokeStyle = k < 6 ? 'rgba(90,190,185,0.35)' : 'rgba(70,160,155,0.28)';
    g.lineWidth = 0.0035;
    g.beginPath(); g.moveTo(S[o], S[o + 1]); g.lineTo(S[o + 2], S[o + 3]); g.stroke();
  }

  // Pockets
  for (let p = 0; p < 6; p++) {
    const [hx, hy, hr] = holeCentre(p);
    // leather liner
    g.fillStyle = '#120d0a';
    g.beginPath(); g.arc(hx, hy, hr + 0.014, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,220,180,0.10)'; g.lineWidth = 0.003;
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
    dg.addColorStop(0, '#fbf6ea'); dg.addColorStop(0.5, '#d9d2c0'); dg.addColorStop(1, '#a9a191');
    g.fillStyle = dg;
    g.beginPath(); g.moveTo(x - hw, y); g.lineTo(x, y - hh); g.lineTo(x + hw, y); g.lineTo(x, y + hh); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = 0.0012; g.stroke();
  }
  // Vignette over everything
  g.setTransform(1, 0, 0, 1, 0, 0);
  const vg = g.createRadialGradient(tcx, tcy, Math.min(cw, ch) * 0.35, tcx, tcy, Math.max(cw, ch) * 0.8);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)');
  g.fillStyle = vg; g.fillRect(0, 0, cw, ch);
  return c;
}

// Ball numbers: 4x4 atlas of 64px cells, index = ball number.
export function paintDigits() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
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
  const c = document.createElement('canvas');
  c.width = 512; c.height = 32;
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
