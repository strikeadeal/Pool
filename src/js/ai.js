// Computer opponent. Candidate shots come from ghost-ball geometry; the best few are
// simulated with the real physics and judged with the real rules, then executed with
// level-dependent aim and pace error. think() is a generator so the UI can time-slice it.
import { R, L, W, N, HEAD_X, FOOT_X, TABLE, simulate, ghostAim, canPlace, rng } from './physics.js';
import { judge, legalTargets, onEight, groupOf } from './rules.js';
import { FEEL } from './feel.js';

export const LEVELS = {
  1: { name: 'Easy', aimSigmaDeg: 1.1, paceErr: 0.12, candidates: 3, variants: 1, position: false, safety: false },
  2: { name: 'Medium', aimSigmaDeg: 0.45, paceErr: 0.06, candidates: 6, variants: 3, position: true, safety: true },
  3: { name: 'Hard', aimSigmaDeg: 0.16, paceErr: 0.025, candidates: 10, variants: 6, position: true, safety: true },
};

const MAX_V = FEEL.maxBallSpeed;

function pocketTarget(p) {
  const pk = TABLE.pockets[p];
  return [pk.mx + pk.ax * 0.012, pk.my + pk.ay * 0.012];
}

// Is the straight corridor from (ax,ay) to (bx,by) free of balls (other than skip)?
function clear(balls, ax, ay, bx, by, skip1, skip2) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  for (let i = 0; i < N; i++) {
    if (!balls.on[i] || i === skip1 || i === skip2) continue;
    let t = ((balls.x[i] - ax) * dx + (balls.y[i] - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + dx * t - balls.x[i], ey = ay + dy * t - balls.y[i];
    if (ex * ex + ey * ey < (2 * R - 1e-4) * (2 * R - 1e-4)) return false;
  }
  return true;
}

// All geometrically plausible pots for the shooter, best first. quality in 0..1.
export function potCandidates(state, balls = state.balls, targets = legalTargets(state)) {
  const out = [];
  if (!balls.on[0]) return out;
  for (const t of targets) {
    for (let p = 0; p < 6; p++) {
      const [tx, ty] = pocketTarget(p);
      const g = ghostAim(balls, t, tx, ty);
      if (g.cosCut < 0.2) continue;                         // thinner than ~78 degrees
      const pk = TABLE.pockets[p];
      // approach angle into the pocket: object path vs pocket axis
      const ox = (tx - balls.x[t]) / g.objDist, oy = (ty - balls.y[t]) / g.objDist;
      const entry = ox * pk.ax + oy * pk.ay;
      if (entry < (p === 1 || p === 4 ? 0.55 : 0.35)) continue;
      if (!clear(balls, balls.x[0], balls.y[0], g.gx, g.gy, 0, t)) continue;
      if (!clear(balls, balls.x[t], balls.y[t], tx, ty, t, 0)) continue;
      if (g.gx < R * 0.5 || g.gx > L - R * 0.5 || g.gy < R * 0.5 || g.gy > W - R * 0.5) continue;
      const quality = g.cosCut * g.cosCut * Math.exp(-(g.dist * 0.6 + g.objDist * 0.9)) * (0.6 + 0.4 * entry);
      out.push({ target: t, pocket: p, ...g, quality });
    }
  }
  return out.sort((a, b) => b.quality - a.quality);
}

// Pace that gets the object ball to the pocket with some to spare.
function basePace(c) {
  const vObj = Math.sqrt(2 * 0.13 * (c.objDist + 0.35)) * 1.25;
  const vCue = vObj / Math.max(0.25, c.cosCut * 0.975);
  return Math.min(MAX_V, Math.sqrt(vCue * vCue + 2 * 1.2 * c.dist));
}

function gauss(r) {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function rotate(dx, dy, rad) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [dx * c - dy * s, dx * s + dy * c];
}

// Score a simulated result from the shooter's point of view.
function scoreResult(state, sim, me, lvl) {
  const st = { ...state, called: state.called };
  const { state: next, report } = judge(st, sim.outcome(), sim.finalBalls());
  if (next.phase === 'over') return next.winner === me ? 1000 : -1000;
  let score = 0;
  if (report.fouls.length) score -= 60;
  if (next.turn === me) {
    score += 50 + 6 * report.potted.length;
    if (lvl.position) {
      const best = potCandidates(next)[0];
      score += best ? 40 * Math.min(1, best.quality * 3) : -15;
    }
  } else if (lvl.safety) {
    // leave the opponent as little as possible
    const opp = potCandidates(next)[0];
    score -= opp ? 30 * Math.min(1, opp.quality * 3) : -10;
  }
  return score;
}

function* evaluate(state, shot, called, me, lvl) {
  const s = { ...state, called };
  const sim = simulate(state.balls, shot, { record: false });
  yield;
  return scoreResult(s, sim, me, lvl);
}

// Choose where to put the cue ball with ball in hand.
function placeCueBall(state, lvl, r) {
  const kitchen = state.ballInHand === 'kitchen';
  const balls = state.balls;
  const ok = (x, y) => canPlace(balls, 0, x, y, kitchen);
  if (state.phase === 'break') {
    const y = W / 2 + (r() - 0.5) * 0.3;
    return ok(HEAD_X - 0.12, y) ? [HEAD_X - 0.12, y] : null;
  }
  if (lvl.candidates <= 3 && r() < 0.5) {
    for (let k = 0; k < 40; k++) {
      const x = R + r() * ((kitchen ? HEAD_X : L) - 2 * R), y = R + r() * (W - 2 * R);
      if (ok(x, y)) return [x, y];
    }
  }
  // Put the cue ball behind an object ball on its line to a pocket: a straight, short pot.
  let best = null, bestQ = -1;
  for (const t of legalTargets(state)) {
    for (let p = 0; p < 6; p++) {
      const [tx, ty] = pocketTarget(p);
      let ox = tx - balls.x[t], oy = ty - balls.y[t];
      const od = Math.hypot(ox, oy); ox /= od; oy /= od;
      for (const back of [0.18, 0.28, 0.4]) {
        for (const ang of [0, 0.25, -0.25]) {           // slight angle so the cue ball doesn't follow in
          const [bx, by] = rotate(-ox, -oy, ang);
          const x = balls.x[t] + bx * (2 * R + back), y = balls.y[t] + by * (2 * R + back);
          if (!ok(x, y)) continue;
          const trial = { ...balls, x: balls.x.slice(), y: balls.y.slice() };
          trial.x[0] = x; trial.y[0] = y;
          const c = potCandidates(state, trial, [t]).find((q) => q.pocket === p);
          if (c && c.quality > bestQ) { bestQ = c.quality; best = [x, y]; }
        }
      }
    }
  }
  return best;
}

// Returns { place: [x,y]|null, shot, called }
export function* think(state, level, seed) {
  const lvl = LEVELS[level] || LEVELS[2];
  const r = rng(seed >>> 0);
  const me = state.turn;
  let work = state;
  let place = null;
  if (state.ballInHand) {
    place = placeCueBall(state, lvl, r);
    if (place) {
      work = { ...state, balls: { ...state.balls, x: state.balls.x.slice(), y: state.balls.y.slice(), on: state.balls.on.slice() } };
      work.balls.x[0] = place[0]; work.balls.y[0] = place[1]; work.balls.on[0] = 1;
    }
  }
  const b = work.balls;
  // Break: hit the apex hard, a hair off centre.
  if (state.phase === 'break') {
    let ax = FOOT_X, ay = W / 2;
    let bestD = 1e9;
    for (let i = 1; i < 16; i++) {
      if (!b.on[i]) continue;
      const d = Math.hypot(b.x[i] - FOOT_X, b.y[i] - W / 2);
      if (d < bestD) { bestD = d; ax = b.x[i]; ay = b.y[i]; }
    }
    let dx = ax - b.x[0], dy = ay - b.y[0]; const l = Math.hypot(dx, dy); dx /= l; dy /= l;
    [dx, dy] = rotate(dx, dy, ((gauss(r) * lvl.aimSigmaDeg) / 2) * (Math.PI / 180));
    return { place, called: null, shot: { dx, dy, speed: MAX_V * (0.92 + r() * 0.08), a: 0, b: -0.1 } };
  }
  const eight = onEight(work, me);
  const cands = potCandidates(work).slice(0, lvl.candidates);
  let best = null, bestScore = -Infinity;
  const variants = [
    { k: 1, b: 0 }, { k: 1.5, b: 0.3 }, { k: 1.25, b: -0.35 },
    { k: 2.2, b: 0 }, { k: 0.85, b: 0.2 }, { k: 1.8, b: -0.5 },
  ].slice(0, lvl.variants);
  for (const c of cands) {
    const base = basePace(c);
    for (const v of variants) {
      const shot = { dx: c.dx, dy: c.dy, speed: Math.min(MAX_V, base * v.k), a: 0, b: v.b };
      const called = eight || c.target === 8 ? c.pocket : null;
      const sc = yield* evaluate(work, shot, called, me, lvl);
      const total = sc + c.quality * 10;
      if (total > bestScore) { bestScore = total; best = { shot, called }; }
    }
  }
  // No good pot: look for a legal safety or kick by sampling directions.
  if (!best || bestScore < 20) {
    const targets = legalTargets(work);
    const tries = [];
    for (const t of targets) {
      let dx = b.x[t] - b.x[0], dy = b.y[t] - b.y[0]; const l = Math.hypot(dx, dy); dx /= l; dy /= l;
      for (const sp of [0.9, 1.6, 2.6]) tries.push({ dx, dy, speed: sp });
    }
    if (!tries.length || !lvl.safety) {
      for (let k = 0; k < 36; k++) {
        const a = (k / 36) * Math.PI * 2;
        tries.push({ dx: Math.cos(a), dy: Math.sin(a), speed: 2.2 });
      }
    }
    for (const t of tries) {
      const shot = { ...t, a: 0, b: 0 };
      const called = eight ? 0 : null;
      const sc = yield* evaluate(work, shot, called, me, lvl);
      if (sc > bestScore) { bestScore = sc; best = { shot, called }; }
    }
    if (!best) best = { shot: { dx: 1, dy: 0, speed: 2, a: 0, b: 0 }, called: eight ? 0 : null };
  }
  // Execute with human-like error.
  const err = gauss(r) * lvl.aimSigmaDeg * (Math.PI / 180);
  const [dx, dy] = rotate(best.shot.dx, best.shot.dy, err);
  const speed = Math.min(MAX_V, Math.max(0.2, best.shot.speed * (1 + gauss(r) * lvl.paceErr)));
  return { place, called: best.called, shot: { dx, dy, speed, a: best.shot.a, b: best.shot.b } };
}

export function decideSync(state, level, seed) {
  const g = think(state, level, seed);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

// Decisions after illegal break / 8 on the break: keep it simple and sensible.
export function chooseDecision(state) {
  const d = state.decision;
  if (!d) return null;
  if (d.kind === 'illegalBreak') return 'rerackSelf';
  if (d.kind === 'eightBreak') return 'spot';
  return 'spot';
}

export { groupOf };
