// Baize: app controller. Screens, turn flow, shot playback, computer turns, persistence, updates.
import { L, W, R, N, HEAD_X, Sim, simulate, predict, FRAME_DT } from './physics.js';
import * as Rules from './rules.js';
import { think, chooseDecision, potCandidates, LEVELS } from './ai.js';
import { FEEL } from './feel.js';
import { measure, computeLayout, toScreen } from './layout.js';
import { Renderer } from './render.js';
import { holeCentre } from './textures.js';
import { attachInput } from './input.js';
import { play, haptic, unlockAudio, suspendAudio, setSound, setHaptics } from './feedback.js';
import * as Store from './storage.js';
import { initRecorder, recShot, setRecording, recording, recCount, shareRecording, copyRecording, clearRecording, flush as flushRec } from './recorder.js';

const VERSION = '__VERSION__';
Store.setAppVersion(VERSION);
const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
const STROKE = 0.085;      // cue stroke animation, seconds
const DROP = 0.24;         // pocket drop animation, seconds

const DEFAULT_SETTINGS = { sound: true, haptics: true, guide: 'short', left: false, motion: 'system', instant: false, assist: false,
  tutorial: 0, names: ['Player 1', 'Player 2'], solo: 'You', level: 2, vsource: 'auto', fps: false, screen: 'title' };
const DEFAULT_STATS = { played: 0, cpu: { 1: [0, 0], 2: [0, 0], 3: [0, 0] }, pvp: 0, practiceShots: 0, shots: 0, potted: 0, fouls: 0, bestRun: 0, breakPots: 0 };

let settings = { ...DEFAULT_SETTINGS, ...Store.load('settings', {}) };
let game = null;            // rules state (what's on screen)
let aim = 0;                // radians, world frame
let spin = { a: 0, b: 0 };
let power = 0, powerLive = false;
let assistPower = 0.4;
let calledManual = false;
let pb = null;              // shot playback
let cpu = null;             // computer turn in progress
let grabbing = false;
let lockUntil = 0;
let wrongFlash = null;      // { ball, until }
let lay = null, meas = null, renderer = null, input = null, dpr = 1;
let overlay = null;         // id of the open sheet, or null
let screenName = 'title';
let readonly = false;
let bootAt = performance.now(), interacted = false;
let pendingWorker = null, reloadingForUpdate = false;

// ---------------------------------------------------------------- persistence
function saveSettings() { Store.update('settings', () => settings, DEFAULT_SETTINGS); }
function saveGame() {
  if (readonly) return;
  let data = null;
  if (pb && pb.judged) data = pb.judged.state;
  else if (game) data = { ...game, ui: { aim, spin } };
  if (pb && !pb.judged) data = { ...game, pending: pb.shot, ui: { aim, spin } };
  if (!data) { Store.remove('game'); return; }
  const r = Store.save('game', data);
  if (r === 'conflict') adoptStoredGame('Updated from another window');
  else if (r === 'readonly') { readonly = true; banner('A newer version is open elsewhere', 'Close this tab or reload to keep playing here.', 'foul', 5000); }
}
function adoptStoredGame(msg) {
  if (pb || cpu) return;
  const g = Store.load('game', null);
  if (!g) return;
  game = recover(g);
  if (screenName === 'game') { setupTurn(true); banner(msg, '', '', 2000); }
}
// A shot taken but not finished when the app died: re-simulate it (deterministic) and apply.
function recover(g) {
  if (!g) return null;
  if (g.pending) {
    const { pending, ...pre } = g;
    try {
      const sim = simulate(pre.balls, pending, { record: false });
      const { state } = Rules.judge(pre, sim.outcome(), sim.finalBalls());
      Store.save('game', state);
      return state;
    } catch { return pre; }
  }
  return g;
}

// ---------------------------------------------------------------- layout
let portrait = false;
function relayout() {
  meas = measure(settings.vsource);
  const app = $('app');
  app.style.width = meas.w + 'px'; app.style.height = meas.h + 'px';
  // Landscape only: iOS can't lock a web app's orientation, so portrait shows a rotate prompt
  // and frame() stops (playback and the computer pause until the phone turns back).
  portrait = meas.h > meas.w;
  document.body.classList.toggle('portrait', portrait);
  if (portrait && lay) return;
  const st = document.documentElement.style;
  st.setProperty('--sat', meas.insets.t + 'px'); st.setProperty('--sar', meas.insets.r + 'px');
  st.setProperty('--sab', meas.insets.b + 'px'); st.setProperty('--sal', meas.insets.l + 'px');
  lay = computeLayout(meas, { leftHanded: settings.left, assist: settings.assist && screenName === 'game' && game?.mode !== undefined });
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  renderer.resize(lay, dpr);
  const place = (el, r) => { if (!r) { el.style.display = 'none'; return; } el.style.display = ''; el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px'; };
  place($('hud'), lay.hud);
  place($('power'), lay.power);
  place($('roller'), lay.roller);
  place($('spin-btn'), lay.spin);
  place($('assist'), lay.assist);
  const b = $('banner'); b.style.left = lay.cx + 'px'; b.style.top = (lay.table.y + lay.table.h - 10) + 'px';
  const th = $('thinking'); th.style.left = (lay.cx - 30) + 'px'; th.style.top = (lay.table.y + 14) + 'px';
  app.classList.remove('booting');
  input?.showPower(0);
  positionCoach();
  if (overlay === 'diag') fillDiag();
  requestRender();
}
let relayoutTimer = 0;
function scheduleRelayout() {
  cancelAnimationFrame(relayoutTimer);
  relayoutTimer = requestAnimationFrame(relayout);
  // iOS reports stale sizes right after rotation; measure again shortly after.
  setTimeout(relayout, 150); setTimeout(relayout, 600);
}

// ---------------------------------------------------------------- render loop
let rafId = 0, lastTs = 0, frames = 0, fpsT = 0;
function requestRender() { if (!rafId) rafId = requestAnimationFrame(frame); }
const frameMs = [];
function frame(ts) {
  rafId = 0;
  if (portrait) { lastTs = 0; return; }
  const t0 = performance.now();
  const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
  lastTs = ts;
  let busy = false;
  if (pb) busy = stepPlayback(dt) || busy;
  if (cpu) busy = stepCpu(dt) || busy;
  renderer.draw(buildScene());
  if (settings.fps) {
    frames++;
    if (ts - fpsT > 500) { $('fps').textContent = Math.round((frames * 1000) / (ts - fpsT)) + ' fps'; frames = 0; fpsT = ts; }
    busy = busy || !!pb || !!cpu;
  }
  frameMs.push(performance.now() - t0); if (frameMs.length > 600) frameMs.shift();
  if (busy || pb || cpu) requestRender();
  else lastTs = 0;   // loop sleeps; next start uses a fresh clock
}

// ---------------------------------------------------------------- scene
const view = { x: new Float64Array(N), y: new Float64Array(N), on: new Uint8Array(N), q: new Float64Array(N * 4) };
function viewFromBalls(b) {
  for (let i = 0; i < N; i++) { view.x[i] = b.x[i]; view.y[i] = b.y[i]; view.on[i] = b.on[i]; }
  for (let i = 0; i < N * 4; i++) view.q[i] = b.q[i];
}

function buildScene() {
  const drops = [];
  const scene = { balls: view, drops, under: [], over: [], cue: null };
  if (!game) { viewFromBalls(titleBalls); return scene; }
  if (pb) playbackView(drops);
  else viewFromBalls(game.balls);
  const human = isHumanTurn();
  // Kitchen line while placing the cue ball for the break
  if (screenName !== 'game') return scene;
  if (!pb && game.ballInHand === 'kitchen') scene.under.push((r) => r.bar(HEAD_X, 0.01, HEAD_X, W - 0.01, 0.0025, [1, 1, 1, 0.3], 0.03));
  // Called pocket for the 8
  const calling = !pb && Rules.needsCall(game) && (human || cpu);
  if (calling) {
    scene.under.push((r) => {
      for (let p = 0; p < 6; p++) {
        const [hx, hy, hr] = holeCentre(p);
        if (p === game.called) { r.ring(hx, hy, hr + 0.014, 0.006, [0.85, 0.71, 0.35, 0.95]); r.disc(hx, hy, hr * 0.35, [0.85, 0.71, 0.35, 0.9]); }
        else r.ring(hx, hy, hr + 0.01, 0.002, [1, 1, 1, 0.22]);
      }
    });
  }
  const aiming = !pb && game.phase !== 'over' && game.phase !== 'decision' && view.on[0] && (human || (cpu && cpu.stage !== 'think'));
  if (aiming) {
    const dx = Math.cos(aim), dy = Math.sin(aim);
    const cx = view.x[0], cy = view.y[0];
    const pr = predict(view, dx, dy);
    const legal = pr.kind !== 'ball' || Rules.legalTargets(game).includes(pr.ball);
    scene.over.push((r) => drawGuide(r, cx, cy, dx, dy, pr, legal));
    const pull = 0.008 + (powerLive ? power : cpu?.pull || 0) * 0.24;
    scene.cue = { x: cx - dx * (R + pull), y: cy - dy * (R + pull), dx, dy, a: 1 };
    if (game.ballInHand && (human || cpu)) {
      scene.over.push((r) => r.ring(cx, cy, R * (grabbing ? 1.9 : 1.6), 0.003, [0.85, 0.71, 0.35, grabbing ? 0.95 : 0.7]));
    }
  }
  if (pb) {
    // cue stroke and follow-through
    const dx = pb.shot.dx, dy = pb.shot.dy;
    const sx = pb.cx, sy = pb.cy;
    let pull, a = 1;
    if (pb.strike < STROKE) pull = 0.008 + pb.p * 0.24 * (1 - pb.strike / STROKE);
    else { const k = Math.min(1, (pb.strike - STROKE) / 0.3); pull = -0.025 * Math.min(1, k * 3); a = 1 - k; }
    if (a > 0) scene.cue = { x: sx - dx * (R + pull), y: sy - dy * (R + pull), dx, dy, a };
  }
  if (wrongFlash && performance.now() < wrongFlash.until && view.on[wrongFlash.ball]) {
    const b = wrongFlash.ball;
    scene.over.push((r) => r.ring(view.x[b], view.y[b], R * 1.45, 0.004, [0.94, 0.42, 0.35, 0.95]));
  }
  return scene;
}

function drawGuide(r, cx, cy, dx, dy, pr, legal) {
  const white = legal ? [1, 1, 1, 0.85] : [0.95, 0.42, 0.35, 0.9];
  const soft = [1, 1, 1, 0.5];
  const g = settings.guide;
  const w = Math.max(0.0028, 1.6 / lay.s);
  if (pr.kind === 'none') return;
  const ex = pr.x - dx * R, ey = pr.y - dy * R;
  if (Math.hypot(ex - cx, ey - cy) > R) r.bar(cx + dx * R, cy + dy * R, ex, ey, w, white);
  r.ring(pr.x, pr.y, R, Math.max(0.0025, 1.4 / lay.s), white);
  if (pr.kind === 'ball') {
    if (!legal) { const k = R * 0.5; r.bar(pr.x - k, pr.y - k, pr.x + k, pr.y + k, w, white); r.bar(pr.x - k, pr.y + k, pr.x + k, pr.y - k, w, white); return; }
    if (g === 'off') return;
    const ob = pr.ball, ox = view.x[ob], oy = view.y[ob];
    let len = 0.22;
    if (g === 'long') {
      const ray = predict(view, pr.ox, pr.oy, ob);
      len = ray.kind === 'none' ? 1 : Math.min(1.2, ray.t + R);
    }
    r.bar(ox + pr.ox * R, oy + pr.oy * R, ox + pr.ox * (R + len), oy + pr.oy * (R + len), w, white);
    if (pr.cut > 0.02) {
      const cl = (g === 'long' ? 0.3 : 0.13) * pr.cut;
      r.bar(pr.x + pr.cx * R, pr.y + pr.cy * R, pr.x + pr.cx * (R + cl), pr.y + pr.cy * (R + cl), w * 0.8, soft, 0.012);
    }
  } else if (g !== 'off') {
    const len = g === 'long' ? 0.4 : 0.15;
    r.bar(pr.x, pr.y, pr.x + pr.rx * len, pr.y + pr.ry * len, w * 0.8, soft, 0.012);
  }
}

// Interpolate the recorded keyframes at playback time pb.t
function playbackView(drops) {
  const s = pb.sim;
  const maxT = (s.nFrames - 1) * FRAME_DT;
  const t = Math.min(pb.t, maxT);
  const fi = Math.floor(t / FRAME_DT), f1 = Math.min(fi + 1, s.nFrames - 1), u = t / FRAME_DT - fi;
  const F = s.frames, o0 = fi * N * 6, o1 = f1 * N * 6;
  for (let i = 0; i < N; i++) {
    const k0 = o0 + i * 6, k1 = o1 + i * 6;
    view.x[i] = F[k0] + (F[k1] - F[k0]) * u;
    view.y[i] = F[k0 + 1] + (F[k1 + 1] - F[k0 + 1]) * u;
    let qw = F[k0 + 2] + (F[k1 + 2] - F[k0 + 2]) * u, qx = F[k0 + 3] + (F[k1 + 3] - F[k0 + 3]) * u;
    let qy = F[k0 + 4] + (F[k1 + 4] - F[k0 + 4]) * u, qz = F[k0 + 5] + (F[k1 + 5] - F[k0 + 5]) * u;
    const qn = Math.hypot(qw, qx, qy, qz) || 1;
    view.q[i * 4] = qw / qn; view.q[i * 4 + 1] = qx / qn; view.q[i * 4 + 2] = qy / qn; view.q[i * 4 + 3] = qz / qn;
    const pt = s.pocketT[i];
    view.on[i] = pb.startOn[i] && (pt < 0 || pb.t < pt) ? 1 : 0;
    if (pt >= 0 && pb.t >= pt && pb.t < pt + DROP && pb.startOn[i]) {
      const k = (pb.t - pt) / DROP, e = 1 - (1 - k) * (1 - k);
      const [hx, hy] = holeCentre(s.pocketI[i]);
      const px = view.x[i] + Math.min(0.05, s.pocketVX[i] * 0.04), py = view.y[i] + Math.min(0.05, s.pocketVY[i] * 0.04);
      drops.push({ i, x: px + (hx - px) * e, y: py + (hy - py) * e, s: 1 - 0.38 * e, f: Math.min(1, k * 1.2) });
    }
  }
}

// ---------------------------------------------------------------- shots
const isHumanTurn = () => game && game.mode !== undefined && !game.players[game.turn]?.cpu;
function inputEnabled() {
  return screenName === 'game' && !overlay && !pb && !cpu && game && game.phase !== 'over' && game.phase !== 'decision' && isHumanTurn() && performance.now() > lockUntil;
}

function shoot(p, fromCpu) {
  if (!game || pb) return;
  interacted = true;
  const speed = FEEL.maxBallSpeed * Math.pow(p, FEEL.powerCurve);
  const shot = fromCpu?.shot || { dx: Math.cos(aim), dy: Math.sin(aim), speed, a: spin.a, b: spin.b };
  if (Rules.needsCall(game) && game.called == null) game.called = autoCallPocket();
  if (!Rules.needsCall(game)) game.called = fromCpu ? fromCpu.called : null;
  recShot(shot, { power: p, aimDeg: +(aim / DEG).toFixed(4), mode: game.mode, cpu: !!fromCpu });
  powerLive = false; power = 0;
  pb = { shot, p: fromCpu ? Math.pow(shot.speed / FEEL.maxBallSpeed, 1 / FEEL.powerCurve) : p, sim: new Sim(game.balls, shot), t: 0, strike: 0, speed: 1,
    judged: null, ev: 0, startOn: game.balls.on.slice(), cx: game.balls.x[0], cy: game.balls.y[0], hudPots: new Set() };
  if (settings.tutorial === 1 && !fromCpu) { settings.tutorial = 2; saveSettings(); }
  if (!fromCpu) $('power').classList.add('used');
  hideCoach();
  saveGame();                                   // pre-shot state + the shot itself, before anything moves
  if (settings.instant) {
    pb.sim.advance();
    play('cue', Math.min(1, shot.speed / 6));
    pb.judged = Rules.judge(game, pb.sim.outcome(), pb.sim.finalBalls());
    saveGame();
    if (pb.sim.pocketed.length) play('pocket', 0.7);
    finishShot();
    return;
  }
  updateControls();
  requestRender();
}

function stepPlayback(dt) {
  const s = pb.sim;
  if (!s.done) {
    const end = performance.now() + 6;           // time-slice the simulation
    while (!s.done && performance.now() < end) s.advance(1);
  }
  if (s.done && !pb.judged) {
    pb.judged = Rules.judge(game, s.outcome(), s.finalBalls());
    saveGame();                                  // commit the result as soon as it's known
  }
  if (pb.strike < STROKE) {
    pb.strike += dt;
    if (pb.strike >= STROKE) { play('cue', Math.min(1, 0.25 + pb.shot.speed / 7)); }
    return true;
  }
  pb.strike += dt;
  const maxT = (s.nFrames - 1) * FRAME_DT;
  pb.t = Math.min(pb.t + dt * pb.speed, s.done ? s.t + DROP + 0.05 : maxT);
  // sounds and live pot updates
  while (pb.ev < s.events.length && s.events[pb.ev].t <= pb.t) {
    const e = s.events[pb.ev++];
    if (e.k === 'b') play('click', Math.min(1, e.s / 3.5), 0.94 + (e.a % 5) * 0.03);
    else if (e.k === 'c') play('cushion', Math.min(1, e.s / 3));
    else if (e.k === 'p') { play('pocket', Math.min(1, 0.45 + e.s / 3)); pb.hudPots.add(e.a); updateHud(pb.hudPots); }
  }
  if (s.done && pb.t >= s.t + DROP) { finishShot(); return false; }
  return true;
}

function fastForward() { if (pb) pb.speed = pb.speed === 1 ? FEEL.fastForward : 1; }

function finishShot() {
  const { state, report } = pb.judged;
  const prev = game;
  pb = null;
  game = state;
  input?.cancel();
  // stats
  Store.update('stats', (st) => {
    st = { ...DEFAULT_STATS, ...st };
    if (game.mode === 'practice') st.practiceShots++;
    else if (!prev.players[prev.turn].cpu) {
      st.shots++; st.potted += report.potted.filter((b) => b !== 0).length; st.fouls += report.fouls.length ? 1 : 0;
      st.bestRun = Math.max(st.bestRun, state.bestRun[prev.turn]);
    }
    return st;
  }, DEFAULT_STATS);
  if (report.wrongBall > 0) wrongFlash = { ball: report.wrongBall, until: performance.now() + 2200 };
  const kind = report.fouls.length ? 'foul' : game.phase === 'over' ? 'win' : '';
  if (report.title && game.phase !== 'over') banner(report.title, report.detail, kind, report.fouls.length ? 3200 : 2200);
  announce([report.title, report.detail].filter(Boolean).join('. '));
  if (report.turnChange && game.mode === 'pvp') lockUntil = performance.now() + 700;
  spin = { a: 0, b: 0 }; updateSpinUi();
  calledManual = false;
  if (game.mode !== 'practice' && game.phase !== 'over') game.called = null;
  saveGame();
  setupTurn(false, prev);
}

// ---------------------------------------------------------------- turns
function defaultAim() {
  const b = game.balls;
  if (!b.on[0]) return aim;
  if (game.phase === 'break') {
    let best = -1, bd = 1e9;
    for (let i = 1; i < 16; i++) if (b.on[i]) { const d = Math.hypot(b.x[i] - (3 * L) / 4, b.y[i] - W / 2); if (d < bd) { bd = d; best = i; } }
    return best > 0 ? Math.atan2(b.y[best] - b.y[0], b.x[best] - b.x[0]) : 0;
  }
  const t = Rules.legalTargets(game);
  let best = -1, bd = 1e9;
  for (const i of t) { const d = Math.hypot(b.x[i] - b.x[0], b.y[i] - b.y[0]); if (d < bd) { bd = d; best = i; } }
  return best > 0 ? Math.atan2(b.y[best] - b.y[0], b.x[best] - b.x[0]) : aim;
}

function setupTurn(resumed, prev) {
  updateHud();
  updateControls();
  hideOverlay('decision');
  if (!game) return;
  if (game.phase === 'over') { gameOver(prev); return; }
  if (game.phase === 'decision') { showDecision(); return; }
  if (resumed && game.ui) { aim = game.ui.aim ?? defaultAim(); spin = game.ui.spin || { a: 0, b: 0 }; }
  else if (!prev || prev.turn !== game.turn || game.ballInHand || prev.phase === 'break') aim = defaultAim();
  updateSpinUi();
  if (Rules.needsCall(game) && game.called == null) game.called = autoCallPocket();
  if (!isHumanTurn()) startCpu();
  else { showTutorial(); if (settings.assist) updateAssist(); }
  requestRender();
}

function autoCallPocket() {
  const pr = predict(game.balls, Math.cos(aim), Math.sin(aim));
  const b = game.balls;
  let ox, oy;
  if (pr.kind === 'ball' && pr.ball === 8) { ox = pr.ox; oy = pr.oy; }
  else { ox = b.x[8] - b.x[0]; oy = b.y[8] - b.y[0]; const l = Math.hypot(ox, oy) || 1; ox /= l; oy /= l; }
  let best = 0, bd = -2;
  for (let p = 0; p < 6; p++) {
    const [hx, hy] = holeCentre(p);
    const dx = hx - b.x[8], dy = hy - b.y[8], l = Math.hypot(dx, dy);
    const d = (dx * ox + dy * oy) / l;
    if (d > bd) { bd = d; best = p; }
  }
  return best;
}

function setAim(a, src) {
  aim = Math.atan2(Math.sin(a), Math.cos(a));
  if (src) interacted = true;
  if (Rules.needsCall(game) && !calledManual) game.called = autoCallPocket();
  if (coachTarget === 'table') positionCoach();
  if (settings.tutorial === 0 && (src === 'drag' || src === 'tap')) { tutAim += 1; if (tutAim > 8 || src === 'tap') { settings.tutorial = 1; saveSettings(); showTutorial(); } }
  requestRender();
}
let tutAim = 0;

// ---------------------------------------------------------------- computer turns
function startCpu() {
  const lvl = game.players[game.turn].cpu;
  const seed = (game.seed ^ Math.imul(game.shotNo + 1, 2654435761)) >>> 0;
  cpu = { stage: 'think', gen: think(game, lvl, seed), t: 0, result: null };
  $('thinking').hidden = false;
  updateControls();
  requestRender();
}

function stepCpu(dt) {
  if (overlay) return true;
  cpu.t += dt;
  if (cpu.stage === 'think') {
    if (!cpu.result) {
      const end = performance.now() + 8;
      let r = { done: false };
      while (performance.now() < end && !(r = cpu.gen.next()).done);
      if (r.done) cpu.result = r.value;
    }
    if (cpu.result && cpu.t > 0.6) {
      $('thinking').hidden = true;
      const res = cpu.result;
      cpu.stage = res.place ? 'place' : 'aim';
      cpu.t = 0;
      cpu.from = [game.balls.x[0], game.balls.y[0]];
      cpu.aim0 = aim;
      cpu.aim1 = Math.atan2(res.shot.dy, res.shot.dx);
      if (Rules.needsCall(game) && res.called != null) game.called = res.called;
    }
    return true;
  }
  const res = cpu.result;
  const ease = (k) => (k >= 1 ? 1 : 1 - Math.pow(1 - k, 3));
  const quick = reduceMotion() ? 0.4 : 1;
  if (cpu.stage === 'place') {
    const k = ease(cpu.t / (0.45 * quick));
    game.balls.x[0] = cpu.from[0] + (res.place[0] - cpu.from[0]) * k;
    game.balls.y[0] = cpu.from[1] + (res.place[1] - cpu.from[1]) * k;
    game.balls.on[0] = 1;
    if (k >= 1) { Rules.placeCueBall(game, res.place[0], res.place[1]); cpu.stage = 'aim'; cpu.t = 0; cpu.aim0 = aim; }
    return true;
  }
  if (cpu.stage === 'aim') {
    let d = cpu.aim1 - cpu.aim0; d = Math.atan2(Math.sin(d), Math.cos(d));
    const k = ease(cpu.t / ((0.35 + Math.min(0.5, Math.abs(d) * 0.3)) * quick));
    aim = cpu.aim0 + d * k;
    if (k >= 1) { aim = cpu.aim1; cpu.stage = 'pull'; cpu.t = 0; }
    return true;
  }
  if (cpu.stage === 'pull') {
    const target = Math.pow(res.shot.speed / FEEL.maxBallSpeed, 1 / FEEL.powerCurve);
    const k = ease(cpu.t / (0.45 * quick));
    cpu.pull = target * k;
    if (cpu.t > 0.45 * quick + 0.18) {
      const r = cpu.result;
      cpu = null;
      shoot(0, r);
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- HUD & UI
function chipHtml(n, gone) {
  if (gone) return '<span class="chip empty"></span>';
  const c = ['', '#f4bf16', '#1d50c2', '#d4261f', '#5a2b8a', '#ef7419', '#178548', '#8b1d25', '#141414'][n > 8 ? n - 8 : n];
  const bg = n > 8 ? `linear-gradient(180deg,#f3efe4 0 22%,${c} 22% 78%,#f3efe4 78%)` : c;
  return `<span class="chip" style="background:${bg}"><i>${n}</i></span>`;
}

function updateHud(extraPotted) {
  const hud = $('hud');
  if (!game || screenName !== 'game') { hud.hidden = true; return; }
  hud.hidden = false;
  const b = game.balls;
  const isOn = (n) => b.on[n] && !(extraPotted && extraPotted.has(n));
  for (const p of [0, 1]) {
    const plate = $('plate-' + p);
    const nm = plate.querySelector('.pname'), chips = plate.querySelector('.chips');
    if (game.mode === 'practice') {
      if (p === 0) { nm.textContent = 'Practice'; let left = 0; for (let i = 1; i < 16; i++) if (isOn(i)) left++; chips.textContent = `${left} balls on the table`; chips.setAttribute('aria-label', chips.textContent); }
      plate.hidden = p === 1;
      plate.classList.add('active');
      continue;
    }
    plate.hidden = false;
    const pl = game.players[p];
    nm.innerHTML = '';
    nm.append(pl.name);
    if (pl.cpu && lay.hud.w > 480) { const sm = document.createElement('small'); sm.textContent = ' · ' + LEVELS[pl.cpu].name; nm.append(sm); }
    plate.classList.toggle('active', game.turn === p && game.phase !== 'over');
    if (game.turn === p && game.phase !== 'over') { const sr = document.createElement('span'); sr.className = 'sr-only'; sr.textContent = ', to shoot'; nm.append(sr); }
    const g = game.groups[p];
    if (!g) { chips.innerHTML = chipHtml(0, true).repeat(7); chips.setAttribute('aria-label', game.phase === 'break' ? (game.turn === p ? 'To break' : 'No group yet') : 'Open table'); }
    else {
      const nums = g === 'S' ? [1, 2, 3, 4, 5, 6, 7] : [9, 10, 11, 12, 13, 14, 15];
      const left = nums.filter(isOn);
      chips.innerHTML = nums.map((n) => chipHtml(n, !isOn(n))).join('') + (left.length ? '' : chipHtml(8, !isOn(8)));
      chips.setAttribute('aria-label', `${Rules.groupName(g)}: ${left.length ? left.join(', ') + ' left' : 'on the 8'}`);
    }
  }
  // Centre caption: the stage of the rack until groups are set.
  $('status-cap').textContent = game.mode === 'practice' ? '' : game.phase === 'break' ? 'Break' : !game.groups[0] ? 'Open' : '';
  $('p-rerack').hidden = game.mode !== 'practice';
  $('p-forfeit').hidden = game.mode === 'practice';
}

function updateControls() {
  const show = screenName === 'game' && game && game.phase !== 'over';
  $('controls').hidden = !show;
  $('controls').classList.toggle('cpu', !!(show && !isHumanTurn()));
  $('assist').hidden = !(show && settings.assist && isHumanTurn());
  if (!show) $('thinking').hidden = true;
}

function updateSpinUi() {
  const btn = $('spin-btn');
  btn.querySelector('.dot').style.transform = `translate(${spin.a * 20}px, ${-spin.b * 20}px)`;
  const desc = spinWords(spin.a, spin.b);
  btn.setAttribute('aria-label', `Spin: ${desc}. Tap to change.`);
  $('spin-desc').textContent = desc;
  input && app.drawSpinDot?.(spin.a, spin.b);
}
function spinWords(a, b) {
  if (Math.hypot(a, b) < 0.05) return 'centre ball';
  const v = b > 0.08 ? 'follow' : b < -0.08 ? 'draw' : '';
  const h = a > 0.08 ? 'right' : a < -0.08 ? 'left' : '';
  return [v, h && h + ' english'].filter(Boolean).join(' with ') || 'centre ball';
}

let bannerTimer = 0;
function banner(title, detail, kind = '', ms = 2400) {
  const b = $('banner');
  b.querySelector('.b-title').textContent = title;
  b.querySelector('.b-detail').textContent = detail || '';
  b.className = 'show' + (kind ? ' ' + kind : '');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.className = kind; }, ms);
}
function announce(text) { const l = $('live'); l.textContent = ''; setTimeout(() => { l.textContent = text; }, 50); }

// ---------------------------------------------------------------- tutorial
function showTutorial() {
  if (!game || game.mode === undefined || !isHumanTurn() || screenName !== 'game' || overlay) return hideCoach();
  const step = settings.tutorial;
  if (step === 0) coach('Drag on the table to aim', 'table');
  else if (step === 1) coach('Pull down to shoot', 'power');
  else if (step === 2 && lay.roller) coach('Slide to fine-tune', 'roller');
  else hideCoach();
}
let coachTarget = null;
function coach(text, target) {
  const c = $('coach');
  c.querySelector('.c-text').textContent = text;
  coachTarget = target;
  positionCoach();
  c.classList.add('show');
}
function positionCoach() {
  const c = $('coach');
  if (!coachTarget || !lay) return;
  c.classList.remove('below');
  if (coachTarget === 'table') {
    // Sit behind the cue ball, over the cue stick, so the hint never hides the aim line.
    if (!game) return;
    const [bx, by] = toScreen(lay, game.balls.x[0], game.balls.y[0]);
    const [ax, ay] = toScreen(lay, game.balls.x[0] + Math.cos(aim), game.balls.y[0] + Math.sin(aim));
    const ux = ax - bx, uy = ay - by, ul = Math.hypot(ux, uy) || 1;
    const t = lay.table, cw = c.offsetWidth || 220;
    const x = Math.min(t.x + t.w - cw / 2 - 4, Math.max(t.x + cw / 2 + 4, bx - (ux / ul) * 110));
    const y = Math.min(t.y + t.h - 30, Math.max(t.y + 60, by - (uy / ul) * 110));
    c.style.left = x + 'px'; c.style.top = y + 'px';
  }
  else {
    // Beside the control, on the side facing the middle of the screen.
    const r = coachTarget === 'power' ? lay.power : lay.roller;
    if (!r) return;
    const cw = c.offsetWidth || 200;
    c.style.left = (r.x < lay.w / 2 ? r.x + r.w + 12 + cw / 2 : r.x - 12 - cw / 2) + 'px';
    c.style.top = (r.y + 40) + 'px';
  }
}
function hideCoach() { $('coach').classList.remove('show'); coachTarget = null; }

// ---------------------------------------------------------------- screens
function showScreen(name) {
  screenName = name;
  $('title').hidden = name !== 'title';
  if (name === 'title') { hideCoach(); $('t-continue').hidden = !(game && game.phase !== 'over'); applyUpdateIfSafe(); }
  settings.screen = name; saveSettings();
  relayout();
  updateHud(); updateControls();
}
function showOverlay(id) {
  if (overlay && overlay !== id) $(overlay).hidden = true;
  overlay = id;
  $(id).hidden = false;
  hideCoach();
  if (id === 'settings') fillSettings();
  if (id === 'stats') fillStats();
  if (id === 'diag') fillDiag();
  const f = $(id).querySelector('.btn.primary, button');
  setTimeout(() => f?.focus({ preventScroll: true }), 30);
  updateControls();
}
let overlayStack = [];
function openSheet(id) { if (overlay) overlayStack.push(overlay); showOverlay(id); }
function hideOverlay(id) {
  if (id && overlay !== id) return;
  if (overlay) $(overlay).hidden = true;
  overlay = overlayStack.pop() || null;
  if (overlay) $(overlay).hidden = false;
  updateControls();
  if (!overlay) { showTutorial(); requestRender(); }
}

function newGameFor(mode) {
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  if (mode === 'practice') return Rules.newGame({ mode, players: [{ name: settings.solo || 'You' }, { name: '' }], seed });
  if (mode === 'cpu') return Rules.newGame({ mode, players: [{ name: settings.solo || 'You' }, { name: 'Computer', cpu: settings.level }], seed });
  return Rules.newGame({ mode, players: settings.names.map((n, i) => ({ name: n || `Player ${i + 1}` })), seed });
}
function startGame(mode, breaker = 0) {
  game = newGameFor(mode);
  if (breaker) { game.turn = breaker; game.breaker = breaker; }
  pb = null; cpu = null; spin = { a: 0, b: 0 }; calledManual = false;
  overlayStack = []; if (overlay) { $(overlay).hidden = true; overlay = null; }
  showScreen('game');
  saveGame();
  const first = game.players[game.turn].name;
  if (mode !== 'practice') banner(first === 'You' ? 'Your break' : `${first} to break`, 'Drag the cue ball to place it behind the line.', '', 2600);
  setupTurn();
}

function showDecision() {
  const d = game.decision;
  const who = game.players[d.who];
  if (who.cpu) {
    banner(`${who.name} is deciding…`, '', '', 1200);
    setTimeout(() => { if (game?.decision) { game = Rules.decide(game, chooseDecision(game)); saveGame(); setupTurn(); } }, 1100);
    return;
  }
  const titles = { illegalBreak: 'Illegal break', eightBreak: '8 potted on the break', eightBreakScratch: '8 potted on the break, with a scratch' };
  $('dec-h').textContent = titles[d.kind];
  $('dec-p').textContent = who.name === 'You' ? 'Your choice.' : `${who.name}, your choice.`;
  const box = $('dec-opts');
  box.innerHTML = '';
  for (const o of Rules.decisionOptions(game)) {
    const btn = document.createElement('button');
    btn.className = 'btn'; btn.textContent = o.label;
    btn.onclick = () => { game = Rules.decide(game, o.id); hideOverlay('decision'); saveGame(); setupTurn(); };
    box.append(btn);
  }
  box.firstChild.classList.add('primary');
  showOverlay('decision');
}

function gameOver(prev) {
  updateControls();
  const w = game.players[game.winner];
  const humanWon = !w.cpu;
  $('over-h').textContent = game.mode === 'cpu' ? (humanWon ? 'You win' : 'Computer wins') : `${w.name} wins`;
  $('over-p').textContent = game.winReason;
  const rows = [];
  for (const p of [0, 1]) rows.push([`${game.players[p].name}: balls potted`, game.potted[p]], [`${game.players[p].name}: best run`, game.bestRun[p]]);
  $('over-stats').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('');
  if (prev && prev.phase !== 'over' && !game.counted) {
    game.counted = true;
    Store.update('stats', (st) => {
      st = { ...DEFAULT_STATS, ...st, cpu: { ...DEFAULT_STATS.cpu, ...(st?.cpu || {}) } };
      st.played++;
      if (game.mode === 'cpu') { const lv = game.players[1].cpu; const c = [...(st.cpu[lv] || [0, 0])]; c[0]++; if (game.winner === 0) c[1]++; st.cpu[lv] = c; }
      else st.pvp++;
      return st;
    }, DEFAULT_STATS);
    saveGame();
    if (humanWon || game.mode === 'pvp') play('pocket', 0.6);
  }
  announce(`${$('over-h').textContent}. ${game.winReason}`);
  setTimeout(() => { if (game?.phase === 'over' && screenName === 'game') { showOverlay('over'); applyUpdateIfSafe(); } }, prev ? 900 : 0);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- settings, stats, diagnostics
function reduceMotion() {
  return settings.motion === 'on' || (settings.motion === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}
function applySettings() {
  setSound(settings.sound); setHaptics(settings.haptics);
  document.documentElement.classList.toggle('reduce-motion', reduceMotion());
  $('fps').hidden = !settings.fps;
}
function segSet(id, v) { for (const b of $(id).querySelectorAll('button')) { const on = b.dataset.v === String(v) || b.dataset.level === String(v); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.classList.toggle('on', on); } }
function fillSettings() {
  $('s-sound').checked = settings.sound; $('s-haptics').checked = settings.haptics; $('s-left').checked = settings.left;
  $('s-instant').checked = settings.instant; $('s-assist').checked = settings.assist;
  segSet('s-guide', settings.guide); segSet('s-motion', settings.motion);
  $('version').textContent = `Baize ${VERSION}`;
}
function fillStats() {
  const st = { ...DEFAULT_STATS, ...Store.load('stats', {}) };
  const c = { ...DEFAULT_STATS.cpu, ...st.cpu };
  const rows = [['Games played', st.played], ...[1, 2, 3].map((l) => [`vs ${LEVELS[l].name}: won / played`, `${c[l][1]} / ${c[l][0]}`]),
    ['Pass-and-play games', st.pvp], ['Your shots', st.shots], ['Balls potted', st.potted],
    ['Pot rate', st.shots ? Math.round((100 * st.potted) / st.shots) + '%' : '–'], ['Best run (one visit)', st.bestRun], ['Fouls', st.fouls], ['Practice shots', st.practiceShots]];
  $('stat-grid').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}
function fillDiag() {
  const m = meas || measure(settings.vsource);
  $('diag-vp').textContent = [
    `version ${VERSION}`, `standalone ${m.standalone}  source ${m.source}`,
    `app ${m.w}×${m.h}  dpr ${m.raw.dpr}`, `inner ${m.raw.innerW}×${m.raw.innerH}  fixed ${m.raw.fixedW}×${m.raw.fixedH}`,
    `100vh ${m.raw.vh100}  visual ${m.raw.visualH}  client ${m.raw.clientH}`, `screen ${m.raw.screenW}×${m.raw.screenH}`,
    `safe(env) ${m.raw.safe}`, `insets used t${m.insets.t} r${m.insets.r} b${m.insets.b} l${m.insets.l}`,
    `table ${Math.round(lay?.table.w)}×${Math.round(lay?.table.h)}  ball ${lay?.ballPx.toFixed(1)}px`,
    `ua ${navigator.userAgent}`,
  ].join('\n');
  segSet('d-vsource', settings.vsource);
  $('d-fps').checked = settings.fps; $('d-rec').checked = recording();
  $('d-rec-info').textContent = `${recCount()} touch events recorded.`;
}

// ---------------------------------------------------------------- assisted aiming
function updateAssist() { $('as-power').textContent = Math.round(assistPower * 100) + '%'; }
function openShotList() {
  const list = $('shots-list');
  list.innerHTML = '';
  const add = (html, fn) => { const li = document.createElement('li'); const btn = document.createElement('button'); btn.innerHTML = html; btn.onclick = fn; li.append(btn); list.append(li); };
  const b = game.balls;
  const aimAt = (i, pw, say) => { setAim(Math.atan2(b.y[i] - b.y[0], b.x[i] - b.x[0]), 'assist'); assistPower = pw; updateAssist(); hideOverlay('shots'); announce(say); };
  if (game.phase === 'break') {
    add('Break <small>(full power into the rack)</small>', () => { setAim(defaultAim(), 'assist'); assistPower = 1; updateAssist(); hideOverlay('shots'); announce('Aimed at the rack. Power 100 percent.'); });
  }
  const cands = game.phase === 'break' ? [] : potCandidates(game).slice(0, 14);
  if (game.phase !== 'break') {
    // Always offer a plain hit on each legal ball (a safety), so there's never a dead end.
    for (const i of Rules.legalTargets(game)) {
      if (cands.some((c) => c.target === i)) continue;
      add(`Hit the ${i === 8 ? '8' : esc(i)} ball <small>(no clear pot, safety)</small>`, () => aimAt(i, 0.3, `Aimed straight at the ${i}. Power 30 percent.`));
    }
  }
  for (const c of cands) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    const diff = c.quality > 0.25 ? 'easy' : c.quality > 0.1 ? 'medium' : 'hard';
    btn.innerHTML = `${c.target === 8 ? 'The 8' : esc(c.target + ' ball')} → ${esc(Rules.POCKET_NAMES[c.pocket])} pocket <small>(${diff})</small>`;
    btn.onclick = () => {
      setAim(Math.atan2(c.dy, c.dx), 'assist');
      if (Rules.needsCall(game)) { game.called = c.pocket; calledManual = true; }
      assistPower = Math.min(1, Math.max(0.15, Math.pow(Math.min(FEEL.maxBallSpeed, 1.6 + c.dist + c.objDist) / FEEL.maxBallSpeed, 1 / FEEL.powerCurve)));
      updateAssist();
      hideOverlay('shots');
      announce(`Aimed at the ${c.target} into the ${Rules.POCKET_NAMES[c.pocket]} pocket. Power ${Math.round(assistPower * 100)} percent.`);
    };
    li.append(btn); list.append(li);
  }
  openSheet('shots');
}

// ---------------------------------------------------------------- service worker & updates
function registerSW() {
  if (!('serviceWorker' in navigator) || VERSION.startsWith('__')) return;   // unbuilt dev copy: no service worker
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then((reg) => {
    window.__swReg = reg;
    if (reg.waiting && navigator.serviceWorker.controller) onUpdateReady(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) onUpdateReady(w); });
    });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloadingForUpdate) location.reload(); });
}
function onUpdateReady(worker) {
  pendingWorker = worker;
  if (!applyUpdateIfSafe()) $('update-pill').hidden = false;
}
// Apply only where it can't interrupt play: menus, game over, or right after launch before any input.
function applyUpdateIfSafe() {
  if (!pendingWorker) return false;
  const early = performance.now() - bootAt < 4000 && !interacted;
  const safe = !pb && !cpu && (screenName === 'title' || game?.phase === 'over' || early);
  if (!safe) return false;
  saveGame(); flushRec();
  try { sessionStorage.setItem('baize.updated', '1'); } catch { /* ignore */ }
  reloadingForUpdate = true;
  pendingWorker.postMessage({ type: 'SKIP_WAITING' });
  return true;
}

// ---------------------------------------------------------------- title scene
let titleBalls = null;

// ---------------------------------------------------------------- wire up
const app = {
  get lay() { return lay; },
  get aim() { return aim; },
  setAim,
  cuePos: () => [game.balls.x[0], game.balls.y[0]],
  isPlayingBack: () => !!pb,
  fastForward,
  inputEnabled,
  ballInHandMovable: () => !!(game && game.ballInHand && isHumanTurn()),
  setGrabbing: (v) => { grabbing = v; requestRender(); },
  tryPlaceCue: (x, y) => {
    if (Rules.placeCueBall(game, x, y)) { interacted = true; requestRender(); return true; }
    // slide along the obstacle: try moving only one axis
    if (Rules.placeCueBall(game, x, game.balls.y[0]) || Rules.placeCueBall(game, game.balls.x[0], y)) requestRender();
    return false;
  },
  pocketAt: (wx, wy) => {
    if (!Rules.needsCall(game)) return -1;
    for (let p = 0; p < 6; p++) { const [hx, hy, hr] = holeCentre(p); if (Math.hypot(wx - hx, wy - hy) < hr + 0.05) return p; }
    return -1;
  },
  callPocket: (p) => { game.called = p; calledManual = true; haptic(); announce(`Calling the 8 in the ${Rules.POCKET_NAMES[p]} pocket`); requestRender(); },
  setPower: (p, live) => { power = p; powerLive = live; requestRender(); },
  shoot: (p) => shoot(p),
  fineDone: () => { if (settings.tutorial === 2) { settings.tutorial = 3; saveSettings(); hideCoach(); } },
  setSpin: (a, b) => { spin = { a, b }; updateSpinUi(); },
  nudgePower: (d) => { assistPower = Math.min(1, Math.max(0.05, assistPower + d)); updateAssist(); },
  shootAssisted: () => { if (inputEnabled()) shoot(assistPower); },
};

function wire() {
  const go = (where) => {
    if (where === 'setup-cpu' || where === 'setup-pvp') {
      const cpuMode = where === 'setup-cpu';
      $('setup-cpu').hidden = !cpuMode; $('setup-pvp').hidden = cpuMode;
      $('setup').dataset.mode = cpuMode ? 'cpu' : 'pvp';
      segSet('setup-cpu', settings.level);
      for (const b of $('setup-cpu').querySelectorAll('[data-level]')) b.setAttribute('aria-checked', String(+b.dataset.level === settings.level));
      $('name-solo').value = settings.solo; $('name-0').value = settings.names[0]; $('name-1').value = settings.names[1];
      openSheet('setup');
    } else if (where === 'practice') startGame('practice');
    else openSheet(where);
  };
  document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { unlockAudio(); play('tick', 0.3); go(b.dataset.go); }));
  document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => { play('tick', 0.3); hideOverlay(); }));
  $('t-continue').onclick = () => { unlockAudio(); showScreen('game'); setupTurn(true); };
  $('setup-cpu').querySelectorAll('[data-level]').forEach((b) => b.addEventListener('click', () => { settings.level = +b.dataset.level; segSet('setup-cpu', settings.level); for (const x of $('setup-cpu').querySelectorAll('[data-level]')) x.setAttribute('aria-checked', String(x === b)); }));
  $('setup-start').onclick = () => {
    const mode = $('setup').dataset.mode;
    settings.solo = $('name-solo').value.trim() || 'You';
    settings.names = [$('name-0').value.trim() || 'Player 1', $('name-1').value.trim() || 'Player 2'];
    saveSettings();
    startGame(mode);
  };
  $('menu-btn').onclick = () => { play('tick', 0.3); openSheet('pause'); };
  $('status-btn').onclick = () => { if (game) { const t = Rules.describe(game); announce(t); banner('Table status', t, '', 4500); } };
  $('p-resume').onclick = () => hideOverlay();
  $('p-quit').onclick = () => { overlayStack = []; hideOverlay(); saveGame(); showScreen('title'); };
  $('p-rerack').onclick = () => { overlayStack = []; hideOverlay(); startGame('practice'); };
  $('p-forfeit').onclick = () => {
    if (!game || pb) return;
    overlayStack = []; hideOverlay();
    const loser = game.mode === 'cpu' ? 0 : game.turn;
    const prev = game;
    game = { ...game, phase: 'over', winner: 1 - loser, winReason: `${game.players[loser].name} conceded.`, ballInHand: null };
    cpu = null; $('thinking').hidden = true;
    saveGame(); setupTurn(false, prev);
  };
  $('o-menu').onclick = () => { overlayStack = []; hideOverlay(); game = null; Store.remove('game'); showScreen('title'); };
  $('o-again').onclick = () => { const m = game.mode; const nb = 1 - (game.breaker || 0); overlayStack = []; hideOverlay(); startGame(m, m === 'cpu' ? nb : nb); };
  // spin
  $('spin-btn').onclick = () => { if (!inputEnabled()) return; openSheet('spin'); app.drawSpinDot(spin.a, spin.b); };
  $('spin-reset').onclick = () => app.setSpin(0, 0);
  $('spin-done').onclick = () => hideOverlay('spin');
  $('spin-presets').querySelectorAll('[data-spin]').forEach((b) => b.addEventListener('click', () => { const [a, bb] = b.dataset.spin.split(',').map(Number); app.setSpin(a, bb); }));
  $('spin').addEventListener('pointerdown', (e) => { if (e.target === $('spin')) hideOverlay('spin'); });
  // settings
  const bind = (id, key, after) => { $(id).onchange = (e) => { settings[key] = e.target.checked; saveSettings(); applySettings(); after?.(); }; };
  bind('s-sound', 'sound'); bind('s-haptics', 'haptics'); bind('s-instant', 'instant');
  bind('s-left', 'left', relayout); bind('s-assist', 'assist', () => { relayout(); updateControls(); updateAssist(); });
  const segBind = (id, key, after) => $(id).querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { settings[key] = b.dataset.v; segSet(id, b.dataset.v); saveSettings(); applySettings(); after?.(); requestRender(); }));
  segBind('s-guide', 'guide'); segBind('s-motion', 'motion');
  segBind('d-vsource', 'vsource', () => { relayout(); fillDiag(); });
  // hidden diagnostics: long-press the version label
  let lp = 0;
  const v = $('version');
  v.addEventListener('pointerdown', () => { lp = setTimeout(() => { haptic('heavy'); openSheet('diag'); }, 2000); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) v.addEventListener(ev, () => clearTimeout(lp));
  v.addEventListener('keydown', (e) => { if (e.key === 'd' && e.altKey) openSheet('diag'); });
  $('d-fps').onchange = (e) => { settings.fps = e.target.checked; saveSettings(); applySettings(); requestRender(); };
  $('d-rec').onchange = (e) => { setRecording(e.target.checked); fillDiag(); };
  $('d-share').onclick = async () => { const r = await shareRecording(); $('d-rec-info').textContent = `${recCount()} events. ${r}.`; };
  $('d-copy').onclick = async () => { const ok = await copyRecording(); $('d-rec-info').textContent = ok ? 'Copied to the clipboard.' : 'Copy failed. Use Share instead.'; };
  $('d-clear').onclick = () => { clearRecording(); fillDiag(); };
  // assisted aiming
  $('as-pick').onclick = () => { if (inputEnabled()) openShotList(); };
  $('assist').querySelectorAll('[data-nudge]').forEach((b) => b.addEventListener('click', () => { if (inputEnabled()) { setAim(aim - Number(b.dataset.nudge) * DEG, 'assist'); announce(`Aim ${(((aim / DEG) % 360) + 360) % 360 | 0} degrees`); } }));
  $('assist').querySelectorAll('[data-power]').forEach((b) => b.addEventListener('click', () => app.nudgePower(Number(b.dataset.power))));
  $('as-shoot').onclick = () => app.shootAssisted();

  // lifecycle
  window.addEventListener('resize', scheduleRelayout);
  window.addEventListener('orientationchange', scheduleRelayout);
  window.visualViewport?.addEventListener('resize', scheduleRelayout);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      saveGame(); flushRec(); suspendAudio();
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      lastTs = 0;
    } else {
      lastTs = 0;
      scheduleRelayout();
      window.__swReg?.update().catch(() => {});
      requestRender();
    }
  });
  window.addEventListener('pagehide', () => { saveGame(); flushRec(); });
  window.addEventListener('storage', (e) => {
    if (e.key === Store.keyName('game') && screenName === 'game' && !pb && !cpu) adoptStoredGame('Updated from another window');
  });
  document.addEventListener('pointerdown', () => { interacted = true; unlockAudio(); }, { capture: true, passive: true });
}

function boot() {
  try { renderer = new Renderer($('gl')); }
  catch (err) {
    document.body.innerHTML = '<p style="color:#eee;padding:2em;font:16px -apple-system,sans-serif">Baize needs WebGL, which isn’t available here.</p>';
    return;
  }
  renderer.onRestore = requestRender;
  applySettings();
  initRecorder(() => ({ viewport: meas, layout: lay && { table: lay.table, ballPx: lay.ballPx }, version: VERSION }));
  Store.requestPersistence();
  titleBalls = Rules.newGame({ mode: 'practice', players: [{ name: '' }], seed: 20240607 }).balls;
  game = recover(Store.load('game', null));
  if (game && game.phase === 'over') { game = null; Store.remove('game'); }
  wire();
  input = attachInput(app);
  relayout();
  if (game && settings.screen === 'game') { showScreen('game'); setupTurn(true); }
  else showScreen('title');
  try { if (sessionStorage.getItem('baize.updated')) { sessionStorage.removeItem('baize.updated'); banner('Updated', `Baize ${VERSION}`, '', 2200); } } catch { /* ignore */ }
  registerSW();
  requestRender();
  window.__baize = { frameMs, version: VERSION, get screen() { return screenName; }, get overlay() { return overlay; }, get game() { return game; }, get lay() { return lay; }, get pb() { return pb; }, get cpu() { return cpu; }, shoot, setAim, app, settings, get meas() { return meas; } };
}

boot();
