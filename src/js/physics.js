// Baize physics. Deterministic: the simulation path uses only + - * / and Math.sqrt,
// which IEEE 754 makes bit-identical on every JS engine. No Math.sin/cos/pow/random here.
// Units: metres, seconds, radians/second. Table origin at the head-left corner,
// x along the length (head rail x=0, foot rail x=L), y across (0..W), z up.

export const L = 1.98;            // 7 ft bar-box playfield
export const W = 0.99;
export const R = 0.028575;        // 2 1/4" ball
export const N = 16;              // 0 = cue ball, 1..15 = object balls
export const DT = 1 / 480;        // fixed sim step
export const KEY_EVERY = 2;       // keyframe every 2 steps (240 Hz playback data)
export const FRAME_DT = DT * KEY_EVERY;
export const HEAD_X = L / 4;      // head string
export const FOOT_X = (3 * L) / 4; // foot spot x

const G = 9.81;
const MU_S = 0.2;                 // cloth sliding friction
const MU_R = 0.013;               // rolling resistance
const MU_SP = 0.044;              // vertical-axis spin friction
const E_BALL = 0.95;              // ball-ball restitution
const MU_CUSH = 0.2;              // cushion friction (english)
const ROLL_KEEP = -0.25;          // fraction of into-cushion roll spin kept (nose above centre reverses it)
const MAX_TIME = 60;              // safety cap per shot
const V_EPS = 1e-4, WZ_EPS = 0.3;
const BALL_MASS = 0.17;
const CLUSTER_GAP = 0.0005;       // balls closer than this count as touching (rack, frozen balls)
const DEM_K = 1e8;                // soft-contact stiffness, N/m^1.5 (contact ~0.5 ms, max overlap ~1.4 mm)
const DEM_RATE = 491520;          // soft-contact substeps per second (DT/1024)

const SQRT2 = 1.4142135623730951;
const SQRT3 = 1.7320508075688772;
const COS142 = -0.7880107536067219, SIN142 = 0.6156614753256584;
const COS104 = -0.24192189559966779, SIN104 = 0.9702957262759965;

export const CORNER_MOUTH = 0.117;
export const SIDE_MOUTH = 0.130;
const PC = CORNER_MOUTH / SQRT2;  // corner nose point offset along each rail
const FACE_C = 0.06, FACE_S = 0.05;
const DROP_C = 0.6 * R, DROP_S = 0.4 * R;

function cushionE(vn) {           // harder hits lose more
  const e = 0.84 - 0.018 * vn;
  return e < 0.7 ? 0.7 : e;
}

// ---------- Table geometry ----------
// segs: [ax, ay, bx, by, nx, ny, ux, uy, len] per segment; n points into free space.
// pts: jaw points (segment ends). pockets: mouth centre, axis into pocket, drop depth.
function buildTable() {
  const segs = [], pts = [], pockets = [];
  const addSeg = (ax, ay, bx, by, refx, refy) => {
    const dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy);
    const ux = dx / len, uy = dy / len;
    let nx = -uy, ny = ux;
    if ((refx - ax) * nx + (refy - ay) * ny < 0) { nx = -nx; ny = -ny; }
    segs.push(ax, ay, bx, by, nx, ny, ux, uy, len);
    for (const [x, y] of [[ax, ay], [bx, by]]) {
      let dup = false;
      for (let i = 0; i < pts.length; i += 2) if (pts[i] === x && pts[i + 1] === y) dup = true;
      if (!dup) pts.push(x, y);
    }
  };
  const cx = L / 2, cy = W / 2;
  // rail noses
  addSeg(PC, 0, cx - SIDE_MOUTH / 2, 0, cx, cy);
  addSeg(cx + SIDE_MOUTH / 2, 0, L - PC, 0, cx, cy);
  addSeg(PC, W, cx - SIDE_MOUTH / 2, W, cx, cy);
  addSeg(cx + SIDE_MOUTH / 2, W, L - PC, W, cx, cy);
  addSeg(0, PC, 0, W - PC, cx, cy);
  addSeg(L, PC, L, W - PC, cx, cy);
  // corner pockets: canonical at origin, mirrored with sx/sy
  const corners = [[0, 0, 1, 1], [L, 0, -1, 1], [L, W, -1, -1], [0, W, 1, -1]];
  const cornerPocket = (ox, oy, sx, sy) => {
    const mx = ox + sx * PC / 2, my = oy + sy * PC / 2;
    const axx = -sx / SQRT2, axy = -sy / SQRT2;
    const refx = mx + axx * 0.02, refy = my + axy * 0.02;
    // nose on the long rail -> facing back at 142 deg; nose on the short rail mirrored across diagonal
    const n1x = ox + sx * PC, n1y = oy;
    addSeg(n1x, n1y, n1x + sx * COS142 * FACE_C, n1y - sy * SIN142 * FACE_C, refx, refy);
    const n2x = ox, n2y = oy + sy * PC;
    addSeg(n2x, n2y, n2x - sx * SIN142 * FACE_C, n2y + sy * COS142 * FACE_C, refx, refy);
    return { mx, my, ax: axx, ay: axy, drop: DROP_C, hx: mx + axx * 0.045, hy: my + axy * 0.045 };
  };
  const sidePocket = (sy) => {
    const y0 = sy > 0 ? 0 : W;
    const ax = 0, ay = -sy;
    const refx = cx, refy = y0 + ay * 0.02;
    const lx = cx - SIDE_MOUTH / 2, rx = cx + SIDE_MOUTH / 2;
    addSeg(lx, y0, lx - COS104 * FACE_S, y0 - sy * SIN104 * FACE_S, refx, refy);
    addSeg(rx, y0, rx + COS104 * FACE_S, y0 - sy * SIN104 * FACE_S, refx, refy);
    return { mx: cx, my: y0, ax, ay, drop: DROP_S, hx: cx, hy: y0 + ay * 0.032 };
  };
  // pocket order: 0 head-left, 1 head-right... use spatial order around table
  pockets.push(cornerPocket(...corners[0])); // 0: (0,0)
  pockets.push(sidePocket(1));               // 1: (L/2,0)
  pockets.push(cornerPocket(...corners[1])); // 2: (L,0)
  pockets.push(cornerPocket(...corners[2])); // 3: (L,W)
  pockets.push(sidePocket(-1));              // 4: (L/2,W)
  pockets.push(cornerPocket(...corners[3])); // 5: (0,W)
  return { segs: new Float64Array(segs), pts: new Float64Array(pts), pockets };
}

export const TABLE = buildTable();
const SEGS = TABLE.segs, NSEG = SEGS.length / 9;
const PTS = TABLE.pts, NPTS = PTS.length / 2;
const POCKETS = TABLE.pockets;

// ---------- Ball state helpers ----------
// A table state is plain JSON: { x:[16], y:[16], on:[16 of 0|1], q:[64] }.
export function emptyBalls() {
  const q = [];
  for (let i = 0; i < N; i++) q.push(1, 0, 0, 0);
  return { x: new Array(N).fill(0), y: new Array(N).fill(0), on: new Array(N).fill(0), q };
}

export function cloneBalls(b) {
  return { x: b.x.slice(), y: b.y.slice(), on: b.on.slice(), q: b.q.slice() };
}

// Mulberry32: integer-only PRNG, deterministic everywhere.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard 8-ball rack at the foot spot. 8 in the middle of row 3; back corners one
// solid + one stripe; others shuffled; sub-millimetre jitter so no two breaks are identical.
export function rack(seed) {
  const r = rng(seed);
  const b = emptyBalls();
  const solids = [1, 2, 3, 4, 5, 6, 7], stripes = [9, 10, 11, 12, 13, 14, 15];
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  shuffle(solids); shuffle(stripes);
  const solidCorner = r() < 0.5;
  const slots = new Array(15).fill(0);
  // slot index: rows 0..4, row k has k+1 slots; slot 4 = middle of row 2; slots 10 & 14 = back corners
  slots[4] = 8;
  slots[10] = solidCorner ? solids.pop() : stripes.pop();
  slots[14] = solidCorner ? stripes.pop() : solids.pop();
  const rest = shuffle(solids.concat(stripes));
  for (let i = 0; i < 15; i++) if (!slots[i]) slots[i] = rest.pop();
  const gap = 0.00012, jit = 0.00005;
  const d = 2 * R + gap;
  let s = 0;
  for (let k = 0; k < 5; k++) {
    for (let j = 0; j <= k; j++, s++) {
      const n = slots[s];
      b.x[n] = FOOT_X + k * d * (SQRT3 / 2) + (r() * 2 - 1) * jit;
      b.y[n] = W / 2 + (j - k / 2) * d + (r() * 2 - 1) * jit;
      b.on[n] = 1;
      // random visual orientation so numbers face different ways
      const qa = r() * 2 - 1, qb = r() * 2 - 1, qc = r() * 2 - 1, qd = r() * 2 - 1;
      const qn = Math.sqrt(qa * qa + qb * qb + qc * qc + qd * qd) || 1;
      b.q[n * 4] = qa / qn; b.q[n * 4 + 1] = qb / qn; b.q[n * 4 + 2] = qc / qn; b.q[n * 4 + 3] = qd / qn;
    }
  }
  b.x[0] = HEAD_X - 0.12; b.y[0] = W / 2; b.on[0] = 1;
  return b;
}

// Is (x,y) a legal resting spot for ball i (on the cloth, not touching another ball)?
export function canPlace(balls, i, x, y, kitchenOnly = false) {
  if (x < R || x > L - R || y < R || y > W - R) return false;
  if (kitchenOnly && x > HEAD_X) return false;
  for (let j = 0; j < N; j++) {
    if (j === i || !balls.on[j]) continue;
    const dx = balls.x[j] - x, dy = balls.y[j] - y;
    if (dx * dx + dy * dy < (2 * R + 1e-5) * (2 * R + 1e-5)) return false;
  }
  return true;
}

// Re-spot a ball on the foot spot, sliding toward the foot rail if occupied (WPA rule).
export function spotBall(balls, i) {
  let x = FOOT_X;
  while (x < L - R && !canPlace(balls, i, x, W / 2)) x += 0.001;
  if (x >= L - R) { x = FOOT_X; while (x > R && !canPlace(balls, i, x, W / 2)) x -= 0.001; }
  balls.x[i] = x; balls.y[i] = W / 2; balls.on[i] = 1;
}

// Cue impulse: offset (a = side, +right; b = vertical, +top) in units of R, level cue.
export function cueSpin(dx, dy, speed, a, b) {
  const k = (2.5 * speed) / R;
  return { wx: k * b * -dy, wy: k * b * dx, wz: k * a };
}

// ---------- Simulation ----------
export class Sim {
  constructor(balls, shot, { record = true } = {}) {
    this.px = Float64Array.from(balls.x); this.py = Float64Array.from(balls.y);
    this.vx = new Float64Array(N); this.vy = new Float64Array(N);
    this.wx = new Float64Array(N); this.wy = new Float64Array(N); this.wz = new Float64Array(N);
    this.on = Uint8Array.from(balls.on);
    this.q = Float64Array.from(balls.q);
    this.record = record;
    this.t = 0; this.steps = 0; this.done = false;
    this.first = -1;                  // first ball contacted by the cue ball
    this.cushionAfterFirst = false;   // any ball touched a cushion after first contact
    this.cushionBalls = new Set();    // object balls that touched a cushion (break rule)
    this.pocketed = [];               // [{b, p, t}]
    this.events = [];                 // [{t, k:'b'|'c'|'p', a, b, s}] for sound
    this.pocketT = new Float64Array(N).fill(-1);
    this.pocketI = new Int8Array(N).fill(-1);
    this.pocketVX = new Float64Array(N); this.pocketVY = new Float64Array(N);
    this.cap = record ? 1024 : 0;
    this.frames = record ? new Float32Array(this.cap * N * 6) : null;
    this.nFrames = 0;
    this.fallbacks = 0;
    this.disp = new Float64Array(N);
    this.dem = false;
    this.touching = new Uint8Array(N * N);
    if (shot) {
      const { dx, dy, speed, a = 0, b = 0 } = shot;
      this.vx[0] = dx * speed; this.vy[0] = dy * speed;
      const w = cueSpin(dx, dy, speed, a, b);
      this.wx[0] = w.wx; this.wy[0] = w.wy; this.wz[0] = w.wz;
    }
    if (record) this.keyframe();
  }

  keyframe() {
    if (this.nFrames >= this.cap) {
      this.cap *= 2;
      const f = new Float32Array(this.cap * N * 6);
      f.set(this.frames); this.frames = f;
    }
    const f = this.frames, o = this.nFrames * N * 6;
    for (let i = 0; i < N; i++) {
      const k = o + i * 6;
      f[k] = this.px[i]; f[k + 1] = this.py[i];
      f[k + 2] = this.q[i * 4]; f[k + 3] = this.q[i * 4 + 1]; f[k + 4] = this.q[i * 4 + 2]; f[k + 5] = this.q[i * 4 + 3];
    }
    this.nFrames++;
  }

  moving(i) {
    return this.on[i] && (this.vx[i] !== 0 || this.vy[i] !== 0 || this.wx[i] !== 0 || this.wy[i] !== 0 || this.wz[i] !== 0);
  }

  // Advance up to maxSteps; returns true when every ball has stopped.
  advance(maxSteps = 1e9) {
    for (let s = 0; s < maxSteps && !this.done; s++) this.step();
    return this.done;
  }

  step() {
    const { px, py, vx, vy, on } = this;
    if (this.dem) this.demStep(DT);
    else {
      let remaining = DT, events = 0;
      const disp = this.disp;
      for (let i = 0; i < N; i++) disp[i] = on[i] ? Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) * DT : 0;
      while (remaining > 0) {
        let tMin = remaining, kind = 0, ia = -1, ib = -1;
        // ball-ball
        for (let i = 0; i < N; i++) {
          if (!on[i]) continue;
          for (let j = i + 1; j < N; j++) {
            if (!on[j]) continue;
            if (disp[i] === 0 && disp[j] === 0) continue;
            const dx = px[j] - px[i], dy = py[j] - py[i];
            const reach = 2 * R + disp[i] + disp[j];
            const c0 = dx * dx + dy * dy;
            if (c0 > reach * reach) continue;
            const wx = vx[j] - vx[i], wy = vy[j] - vy[i];
            const b = dx * wx + dy * wy;
            if (b >= 0) continue;                 // separating
            const a = wx * wx + wy * wy;
            const c = c0 - 4 * R * R;
            let t;
            if (c <= 0) t = 0;
            else {
              const disc = b * b - a * c;
              if (disc < 0) continue;
              t = (-b - Math.sqrt(disc)) / a;
            }
            if (t < tMin) { tMin = t; kind = 1; ia = i; ib = j; }
          }
        }
        // ball-cushion
        for (let i = 0; i < N; i++) {
          if (!on[i] || disp[i] === 0) continue;
          const m = R + disp[i] + 1e-9;
          const x = px[i], y = py[i];
          if (x > m && x < L - m && y > m && y < W - m) continue; // well inside: no cushion reachable
          const ux = vx[i], uy = vy[i];
          for (let s = 0; s < NSEG; s++) {
            const o = s * 9;
            const nx = SEGS[o + 4], ny = SEGS[o + 5];
            const vn = ux * nx + uy * ny;
            if (vn >= 0) continue;
            const d0 = (x - SEGS[o]) * nx + (y - SEGS[o + 1]) * ny - R;
            if (d0 < -R) continue;                // behind the segment
            const t = d0 <= 0 ? 0 : -d0 / vn;
            if (t >= tMin) continue;
            const cx = x + ux * t - SEGS[o], cy = y + uy * t - SEGS[o + 1];
            const along = cx * SEGS[o + 6] + cy * SEGS[o + 7];
            if (along < 0 || along > SEGS[o + 8]) continue;
            tMin = t; kind = 2; ia = i; ib = s;
          }
          for (let p = 0; p < NPTS; p++) {
            const dx = x - PTS[p * 2], dy = y - PTS[p * 2 + 1];
            const b = dx * ux + dy * uy;
            if (b >= 0) continue;
            const c = dx * dx + dy * dy - R * R;
            let t;
            if (c <= 0) t = 0;
            else {
              const a = ux * ux + uy * uy;
              const disc = b * b - a * c;
              if (disc < 0) continue;
              t = (-b - Math.sqrt(disc)) / a;
            }
            if (t < tMin) { tMin = t; kind = 3; ia = i; ib = p; }
          }
        }
        // advance everything to tMin
        if (tMin > 0) {
          for (let i = 0; i < N; i++) if (on[i]) { px[i] += vx[i] * tMin; py[i] += vy[i] * tMin; }
          remaining -= tMin;
        }
        if (kind === 0) break;
        if (++events > 200) { this.fallbacks++; break; } // pathological pile-up: finish step without more events
        const tEv = this.t + (DT - remaining);
        if (kind === 1) {
          // Ball hitting a touching cluster (the rack, frozen balls): instantaneous pairwise
          // impulses pass energy along like a Newton's cradle, which real racks don't do.
          // Switch to a soft-contact model so the compression wave spreads through all contacts.
          if (this.inCluster(ia, ib)) {
            this.contactEvent(ia, ib, tEv);
            this.dem = true;
            if (remaining > 0) this.demStep(remaining);
            remaining = 0;
            break;
          }
          this.collideBalls(ia, ib, tEv);
        } else if (kind === 2) this.collideCushion(ia, SEGS[ib * 9 + 4], SEGS[ib * 9 + 5], tEv);
        else {
          const nx = px[ia] - PTS[ib * 2], ny = py[ia] - PTS[ib * 2 + 1];
          const d = Math.sqrt(nx * nx + ny * ny) || 1;
          this.collideCushion(ia, nx / d, ny / d, tEv);
        }
        for (let i = 0; i < N; i++) disp[i] = on[i] ? Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) * remaining : 0;
      }
    }
    this.t += DT; this.steps++;
    this.friction();
    this.pockets();
    this.integrateOrientation();
    if (this.record && this.steps % KEY_EVERY === 0) this.keyframe();
    let anyMoving = false;
    for (let i = 0; i < N; i++) if (this.moving(i)) { anyMoving = true; break; }
    if (!anyMoving || this.t > MAX_TIME) {
      if (this.t > MAX_TIME) for (let i = 0; i < N; i++) { vx[i] = vy[i] = this.wx[i] = this.wy[i] = this.wz[i] = 0; }
      this.done = true;
      if (this.record && this.steps % KEY_EVERY !== 0) this.keyframe();
    }
  }

  // Does ball i or j touch (within CLUSTER_GAP) a third ball?
  inCluster(i, j) {
    const { px, py, on } = this;
    const lim = (2 * R + CLUSTER_GAP) * (2 * R + CLUSTER_GAP);
    for (let k = 0; k < N; k++) {
      if (!on[k] || k === i || k === j) continue;
      let dx = px[k] - px[i], dy = py[k] - py[i];
      if (dx * dx + dy * dy < lim) return true;
      dx = px[k] - px[j]; dy = py[k] - py[j];
      if (dx * dx + dy * dy < lim) return true;
    }
    return false;
  }

  contactEvent(i, j, t) {
    let nx = this.px[j] - this.px[i], ny = this.py[j] - this.py[i];
    const d = Math.sqrt(nx * nx + ny * ny); nx /= d; ny /= d;
    const rel = (this.vx[i] - this.vx[j]) * nx + (this.vy[i] - this.vy[j]) * ny;
    if (this.first < 0 && (i === 0 || j === 0)) this.first = i === 0 ? j : i;
    this.events.push({ t, k: 'b', a: i, b: j, s: rel > 0 ? rel : 0 });
  }

  // Soft-contact (Hertz, F = k*d^1.5) integration over time T with tiny substeps.
  // Restitution via load/unload hysteresis: unloading force scaled by e^2.
  demStep(T) {
    const { px, py, vx, vy, on } = this;
    const M = Math.max(1, Math.round(T * DEM_RATE));
    const h = T / M;
    const t0 = this.t + (DT - T);
    const touching = this.touching;
    let anyContact = false;
    for (let s = 0; s < M; s++) {
      for (let i = 0; i < N; i++) {
        if (!on[i]) continue;
        for (let j = i + 1; j < N; j++) {
          if (!on[j]) continue;
          const dx = px[j] - px[i], dy = py[j] - py[i];
          const d2 = dx * dx + dy * dy;
          const key = i * N + j;
          if (d2 >= 4 * R * R) { touching[key] = 0; continue; }
          const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
          const pen = 2 * R - d;
          const vn = (vx[i] - vx[j]) * nx + (vy[i] - vy[j]) * ny; // >0 approaching
          if (!touching[key]) { touching[key] = 1; this.contactEvent(i, j, t0 + s * h); }
          let f = DEM_K * pen * Math.sqrt(pen);
          if (vn < 0) f *= E_BALL * E_BALL;
          const dv = (f / BALL_MASS) * h;
          vx[i] -= dv * nx; vy[i] -= dv * ny; vx[j] += dv * nx; vy[j] += dv * ny;
        }
      }
      for (let i = 0; i < N; i++) if (on[i]) this.cushionContact(i, t0 + s * h);
      for (let i = 0; i < N; i++) if (on[i]) { px[i] += vx[i] * h; py[i] += vy[i] * h; }
    }
    for (let k = 0; k < touching.length; k++) if (touching[k]) { anyContact = true; break; }
    if (!anyContact) this.dem = false;
  }

  // Penetration-based cushion contact used during soft-contact substeps.
  cushionContact(i, t) {
    const x = this.px[i], y = this.py[i];
    if (x > R && x < L - R && y > R && y < W - R) return;
    const ux = this.vx[i], uy = this.vy[i];
    for (let s = 0; s < NSEG; s++) {
      const o = s * 9, nx = SEGS[o + 4], ny = SEGS[o + 5];
      if (ux * nx + uy * ny >= 0) continue;
      const d0 = (x - SEGS[o]) * nx + (y - SEGS[o + 1]) * ny - R;
      if (d0 > 0 || d0 < -R) continue;
      const along = (x - SEGS[o]) * SEGS[o + 6] + (y - SEGS[o + 1]) * SEGS[o + 7];
      if (along < 0 || along > SEGS[o + 8]) continue;
      this.collideCushion(i, nx, ny, t);
      return;
    }
    for (let p = 0; p < NPTS; p++) {
      const dx = x - PTS[p * 2], dy = y - PTS[p * 2 + 1];
      const d2 = dx * dx + dy * dy;
      if (d2 >= R * R || dx * ux + dy * uy >= 0) continue;
      const d = Math.sqrt(d2) || 1;
      this.collideCushion(i, dx / d, dy / d, t);
      return;
    }
  }

  collideBalls(i, j, t) {
    const { px, py, vx, vy } = this;
    let nx = px[j] - px[i], ny = py[j] - py[i];
    const d = Math.sqrt(nx * nx + ny * ny);
    nx /= d; ny /= d;
    const vi = vx[i] * nx + vy[i] * ny, vj = vx[j] * nx + vy[j] * ny;
    const rel = vi - vj;
    if (rel <= 0) return;
    const k = ((1 + E_BALL) / 2) * rel;
    vx[i] -= k * nx; vy[i] -= k * ny;
    vx[j] += k * nx; vy[j] += k * ny;
    if (this.first < 0 && (i === 0 || j === 0)) this.first = i === 0 ? j : i;
    this.events.push({ t, k: 'b', a: i, b: j, s: rel });
  }

  // n: unit normal pointing from the cushion into free space.
  collideCushion(i, nx, ny, t) {
    const { vx, vy, wx, wy, wz } = this;
    const vn = vx[i] * nx + vy[i] * ny;
    if (vn >= 0) return;
    const tx = -ny, ty = nx;                       // tangent (z x n)
    const vt = vx[i] * tx + vy[i] * ty;
    const e = cushionE(-vn);
    // normal: restitution
    const jn = (1 + e) * -vn;                      // impulse / mass
    let nvx = vx[i] + jn * nx, nvy = vy[i] + jn * ny;
    // tangential friction from english: slip s = vt - R*wz, effective mass factor 3.5
    const slip = vt - R * wz[i];
    let jt = -slip / 3.5;
    const lim = MU_CUSH * jn;
    if (jt > lim) jt = lim; else if (jt < -lim) jt = -lim;
    nvx += jt * tx; nvy += jt * ty;
    wz[i] += (-R * jt) / (0.4 * R * R);
    // roll spin about the tangent axis (driving the ball into the cushion) mostly reversed by the nose
    const wt = wx[i] * tx + wy[i] * ty, wn = wx[i] * nx + wy[i] * ny;
    const nwt = wt * ROLL_KEEP;
    wx[i] = nwt * tx + wn * nx; wy[i] = nwt * ty + wn * ny;
    vx[i] = nvx; vy[i] = nvy;
    if (this.first >= 0) this.cushionAfterFirst = true;
    if (i > 0) this.cushionBalls.add(i);
    this.events.push({ t, k: 'c', a: i, b: -1, s: -vn });
  }

  friction() {
    const { vx, vy, wx, wy, wz, on } = this;
    const slideDv = MU_S * G * DT;
    const slideDw = ((5 * MU_S * G) / (2 * R)) * DT;
    const rollDv = MU_R * G * DT;
    const spinDw = ((5 * MU_SP * G) / (2 * R)) * DT;
    for (let i = 0; i < N; i++) {
      if (!on[i]) continue;
      const ux = vx[i] - R * wy[i], uy = vy[i] + R * wx[i];
      const u = Math.sqrt(ux * ux + uy * uy);
      if (u > 1e-9) {
        const hx = ux / u, hy = uy / u;
        if (u <= 3.5 * slideDv) {                  // reaches pure rolling inside this step
          vx[i] -= (hx * u) / 3.5; vy[i] -= (hy * u) / 3.5;
          wx[i] = -vy[i] / R; wy[i] = vx[i] / R;
        } else {
          vx[i] -= hx * slideDv; vy[i] -= hy * slideDv;
          wx[i] -= hy * slideDw; wy[i] += hx * slideDw;
        }
      } else {
        const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        if (sp <= rollDv || sp < V_EPS) { vx[i] = 0; vy[i] = 0; }
        else { const k = (sp - rollDv) / sp; vx[i] *= k; vy[i] *= k; }
        wx[i] = -vy[i] / R; wy[i] = vx[i] / R;
      }
      const az = wz[i] < 0 ? -wz[i] : wz[i];
      if (az <= spinDw || (az < WZ_EPS && vx[i] === 0 && vy[i] === 0)) wz[i] = 0;
      else wz[i] += wz[i] > 0 ? -spinDw : spinDw;
    }
  }

  pockets() {
    const { px, py, on } = this;
    for (let i = 0; i < N; i++) {
      if (!on[i]) continue;
      const x = px[i], y = py[i];
      if (x > R && x < L - R && y > R && y < W - R) continue;
      for (let p = 0; p < 6; p++) {
        const pk = POCKETS[p];
        const depth = (x - pk.mx) * pk.ax + (y - pk.my) * pk.ay;
        if (depth > pk.drop) { this.pocket(i, p); break; }
      }
      // Safety net: a ball that somehow left the cloth outside a pocket goes back on the rail.
      if (on[i]) {
        if (x < R - 1e-6 || x > L - R + 1e-6 || y < R - 1e-6 || y > W - R + 1e-6) {
          let inMouth = false;
          for (let p = 0; p < 6; p++) {
            const pk = POCKETS[p];
            const lat = Math.abs((x - pk.mx) * -pk.ay + (y - pk.my) * pk.ax);
            if (lat < (p === 1 || p === 4 ? SIDE_MOUTH : CORNER_MOUTH) / 2 + R) inMouth = true;
          }
          if (!inMouth) {
            this.px[i] = x < R ? R : x > L - R ? L - R : x;
            this.py[i] = y < R ? R : y > W - R ? W - R : y;
            this.fallbacks++;
          }
        }
      }
    }
  }

  pocket(i, p) {
    this.on[i] = 0;
    this.pocketT[i] = this.t; this.pocketI[i] = p;
    this.pocketVX[i] = this.vx[i]; this.pocketVY[i] = this.vy[i];
    const s = Math.sqrt(this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i]);
    this.vx[i] = this.vy[i] = this.wx[i] = this.wy[i] = this.wz[i] = 0;
    this.pocketed.push({ b: i, p, t: this.t });
    this.events.push({ t: this.t, k: 'p', a: i, b: p, s });
  }

  integrateOrientation() {
    const { q, wx, wy, wz, on } = this;
    const h = 0.5 * DT;
    for (let i = 0; i < N; i++) {
      if (!on[i]) continue;
      const ax = wx[i], ay = wy[i], az = wz[i];
      if (ax === 0 && ay === 0 && az === 0) continue;
      const o = i * 4;
      const w = q[o], x = q[o + 1], y = q[o + 2], z = q[o + 3];
      // q += 0.5 * (0,w) * q * dt  (world-frame angular velocity)
      const nw = w + h * (-ax * x - ay * y - az * z);
      const nx = x + h * (ax * w + ay * z - az * y);
      const ny = y + h * (ay * w + az * x - ax * z);
      const nz = z + h * (az * w + ax * y - ay * x);
      const n = Math.sqrt(nw * nw + nx * nx + ny * ny + nz * nz);
      q[o] = nw / n; q[o + 1] = nx / n; q[o + 2] = ny / n; q[o + 3] = nz / n;
    }
  }

  finalBalls() {
    return { x: Array.from(this.px), y: Array.from(this.py), on: Array.from(this.on), q: Array.from(this.q) };
  }

  // Summary consumed by the rules engine.
  outcome() {
    return {
      first: this.first,
      cushionAfterFirst: this.cushionAfterFirst,
      cushionBalls: [...this.cushionBalls].sort((a, b) => a - b),
      pocketed: this.pocketed.map((p) => ({ b: p.b, p: p.p })),
      duration: this.t,
    };
  }
}

// Run a shot to completion (used by tests, the AI and crash recovery).
export function simulate(balls, shot, opts) {
  const sim = new Sim(balls, shot, opts);
  sim.advance();
  return sim;
}

// ---------- Aim prediction for the guide line ----------
// Casts the cue ball along (dx,dy). Returns the first thing it touches.
export function predict(balls, dx, dy, from = 0) {
  const x0 = balls.x[from], y0 = balls.y[from];
  let tMin = Infinity, hit = -1, nX = 0, nY = 0, kind = 'none';
  for (let j = 0; j < N; j++) {
    if (j === from || !balls.on[j]) continue;
    const ex = x0 - balls.x[j], ey = y0 - balls.y[j];
    const b = ex * dx + ey * dy;
    if (b >= 0) continue;
    const c = ex * ex + ey * ey - 4 * R * R;
    const disc = b * b - c;
    if (disc < 0) continue;
    const t = c <= 0 ? 0 : -b - Math.sqrt(disc);
    if (t < tMin) { tMin = t; hit = j; kind = 'ball'; }
  }
  for (let s = 0; s < NSEG; s++) {
    const o = s * 9, nx = SEGS[o + 4], ny = SEGS[o + 5];
    const vn = dx * nx + dy * ny;
    if (vn >= 0) continue;
    const d0 = (x0 - SEGS[o]) * nx + (y0 - SEGS[o + 1]) * ny - R;
    if (d0 < -R) continue;
    const t = d0 <= 0 ? 0 : -d0 / vn;
    if (t >= tMin) continue;
    const along = (x0 + dx * t - SEGS[o]) * SEGS[o + 6] + (y0 + dy * t - SEGS[o + 1]) * SEGS[o + 7];
    if (along < 0 || along > SEGS[o + 8]) continue;
    tMin = t; hit = -1; kind = 'cushion'; nX = nx; nY = ny;
  }
  for (let p = 0; p < NPTS; p++) {
    const ex = x0 - PTS[p * 2], ey = y0 - PTS[p * 2 + 1];
    const b = ex * dx + ey * dy;
    if (b >= 0) continue;
    const c = ex * ex + ey * ey - R * R;
    const disc = b * b - c;
    if (disc < 0) continue;
    const t = c <= 0 ? 0 : -b - Math.sqrt(disc);
    if (t < tMin) {
      tMin = t; hit = -1; kind = 'cushion';
      const gx = x0 + dx * t - PTS[p * 2], gy = y0 + dy * t - PTS[p * 2 + 1];
      const d = Math.sqrt(gx * gx + gy * gy) || 1; nX = gx / d; nY = gy / d;
    }
  }
  if (kind === 'none') return { kind, x: x0, y: y0, t: 0 };
  const gx = x0 + dx * tMin, gy = y0 + dy * tMin;          // ghost ball centre
  if (kind === 'ball') {
    let ox = balls.x[hit] - gx, oy = balls.y[hit] - gy;
    const d = Math.sqrt(ox * ox + oy * oy); ox /= d; oy /= d;   // object ball direction
    // stun-shot cue ball direction: tangent line (90 degree rule)
    let cx = dx - (dx * ox + dy * oy) * ox, cy = dy - (dx * ox + dy * oy) * oy;
    const cl = Math.sqrt(cx * cx + cy * cy);
    if (cl > 1e-9) { cx /= cl; cy /= cl; } else { cx = 0; cy = 0; }
    return { kind, ball: hit, x: gx, y: gy, t: tMin, ox, oy, cx, cy, cut: cl };
  }
  // cushion: reflected direction (ideal mirror) for the guide
  const vn = dx * nX + dy * nY;
  return { kind, x: gx, y: gy, t: tMin, rx: dx - 2 * vn * nX, ry: dy - 2 * vn * nY };
}

// Unit vector from cue ball toward where the object ball must be struck to send it at (tx,ty).
// Returns the ghost-ball aim used by the AI and assisted aiming.
export function ghostAim(balls, obj, tx, ty, from = 0) {
  let ox = tx - balls.x[obj], oy = ty - balls.y[obj];
  const od = Math.sqrt(ox * ox + oy * oy); ox /= od; oy /= od;
  const gx = balls.x[obj] - ox * 2 * R, gy = balls.y[obj] - oy * 2 * R;
  let dx = gx - balls.x[from], dy = gy - balls.y[from];
  const d = Math.sqrt(dx * dx + dy * dy);
  dx /= d; dy /= d;
  const cut = dx * ox + dy * oy;   // cos of cut angle
  return { dx, dy, gx, gy, dist: d, objDist: od, cosCut: cut };
}
