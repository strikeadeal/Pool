// Touch controls. Every mapping is positional (finger position -> value), never per-frame,
// so behaviour is identical at 60 Hz and 120 Hz. Feel numbers come from feel.js only.
import { FEEL } from './feel.js';
import { R } from './physics.js';
import { toWorld } from './layout.js';
import { recPointer } from './recorder.js';
import { haptic, play, unlockAudio } from './feedback.js';

const DEG = Math.PI / 180;

export function attachInput(app) {
  const canvas = document.getElementById('gl');
  const powerEl = document.getElementById('power');
  const rollerEl = document.getElementById('roller');
  const ribs = rollerEl.querySelector('.ribs');
  const fill = powerEl.querySelector('.fill');
  const grip = powerEl.querySelector('.grip');
  const pct = powerEl.querySelector('.pct');

  // ---------- Table: aim / move cue ball / call pocket ----------
  const touches = new Map();
  canvas.addEventListener('pointerdown', (e) => {
    unlockAudio();
    recPointer('table', e);
    if (app.isPlayingBack()) { app.fastForward(); return; }
    if (!app.inputEnabled()) return;
    if ([...touches.values()].some((t) => t.mode === 'aim' || t.mode === 'cue')) return;   // one aiming finger at a time
    const [wx, wy] = toWorld(app.lay, e.clientX, e.clientY);
    const [cx, cy] = app.cuePos();
    const t = { mode: 'aim', t0: e.timeStamp, sx: e.clientX, sy: e.clientY, lx: wx, ly: wy, aim0: app.aim, moved: 0 };
    if (app.ballInHandMovable() && Math.hypot(wx - cx, wy - cy) < FEEL.grabRadiusBalls * R) {
      t.mode = 'cue'; t.ox = cx - wx; t.oy = cy - wy;
      app.setGrabbing(true);
    } else {
      const p = app.pocketAt(wx, wy);
      if (p >= 0) { t.mode = 'pocket'; t.pocket = p; }
    }
    touches.set(e.pointerId, t);
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    recPointer('table', e);
    const [wx, wy] = toWorld(app.lay, e.clientX, e.clientY);
    t.moved = Math.max(t.moved, Math.hypot(e.clientX - t.sx, e.clientY - t.sy));
    if (t.mode === 'cue') { app.tryPlaceCue(wx + t.ox, wy + t.oy); return; }
    if (t.mode === 'pocket') { if (t.moved > FEEL.tapMaxMovePt * 2) t.mode = 'aim'; else return; }
    // Relative angular drag: the cue turns by the finger's exact change of angle around the
    // cue ball. Exact angle differences telescope, so the result doesn't depend on how many
    // touch events arrive (60 Hz vs 120 Hz). Inside aimMinRadiusPt the turn is damped.
    const [cx, cy] = app.cuePos();
    const ax = t.lx - cx, ay = t.ly - cy, bx = wx - cx, by = wy - cy;
    let dTheta = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    const rMin = FEEL.aimMinRadiusPt / app.lay.s;
    const r = (Math.hypot(ax, ay) + Math.hypot(bx, by)) / 2;
    if (r < rMin) dTheta *= (r * r) / (rMin * rMin);
    dTheta *= FEEL.aimDragGain;
    t.lx = wx; t.ly = wy;
    if (dTheta) app.setAim(app.aim + dTheta, 'drag');
  });
  const tableUp = (e) => {
    const t = touches.get(e.pointerId);
    if (!t) return;
    recPointer('table', e);
    touches.delete(e.pointerId);
    if (t.mode === 'cue') { app.setGrabbing(false); return; }
    if (e.type === 'pointercancel') return;
    const quick = e.timeStamp - t.t0 < FEEL.tapMaxMs && t.moved < FEEL.tapMaxMovePt;
    if (t.mode === 'pocket') { if (quick || t.moved < FEEL.tapMaxMovePt * 2) app.callPocket(t.pocket); return; }
    if (quick) {
      const [wx, wy] = toWorld(app.lay, e.clientX, e.clientY);
      const [cx, cy] = app.cuePos();
      if (Math.hypot(wx - cx, wy - cy) > R) app.setAim(Math.atan2(wy - cy, wx - cx), 'tap');
      else app.setAim(t.aim0, 'tap');
    }
  };
  canvas.addEventListener('pointerup', tableUp);
  canvas.addEventListener('pointercancel', tableUp);

  // ---------- Power: pull down, release to shoot, slide back to the top to cancel ----------
  let pw = null;
  const showPower = (p) => {
    fill.style.transform = `scaleY(${p})`;
    grip.style.transform = `translateY(${p * (app.lay.power.h - 80)}px)`;
    pct.textContent = Math.round(p * 100) + '%';
    powerEl.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  };
  powerEl.addEventListener('pointerdown', (e) => {
    unlockAudio();
    recPointer('power', e, 0);
    if (!app.inputEnabled() || pw) return;
    const travel = Math.min(FEEL.powerTravelPt, app.lay.power.h * 0.9);
    pw = { id: e.pointerId, y0: e.clientY, travel, p: 0, full: false };
    powerEl.setPointerCapture(e.pointerId);
    powerEl.classList.add('dragging');
    app.setPower(0, true);
    e.preventDefault();
  });
  powerEl.addEventListener('pointermove', (e) => {
    if (!pw || e.pointerId !== pw.id) return;
    let p = (e.clientY - pw.y0) / pw.travel;
    p = p < 0 ? 0 : p > 1 ? 1 : p;
    recPointer('power', e, p);
    if (p >= 1 && !pw.full) { pw.full = true; haptic('heavy'); }
    if (p < 0.98) pw.full = false;
    pw.p = p;
    showPower(p);
    app.setPower(p, true);
  });
  const powerUp = (e) => {
    if (!pw || e.pointerId !== pw.id) return;
    recPointer('power', e, pw.p);
    const p = pw.p;
    pw = null;
    powerEl.classList.remove('dragging');
    showPower(0);
    if (e.type !== 'pointercancel' && p >= FEEL.powerCancel && app.inputEnabled()) { haptic('heavy'); app.shoot(p); }
    else app.setPower(0, false);
  };
  powerEl.addEventListener('pointerup', powerUp);
  powerEl.addEventListener('pointercancel', powerUp);

  // ---------- Fine-aim roller ----------
  let rl = null, ribOffset = 0, tickAcc = 0;
  rollerEl.addEventListener('pointerdown', (e) => {
    unlockAudio();
    recPointer('roller', e, 0);
    if (!app.inputEnabled() || rl) return;
    rl = { id: e.pointerId, last: e.clientY };
    rollerEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  rollerEl.addEventListener('pointermove', (e) => {
    if (!rl || e.pointerId !== rl.id) return;
    const d = e.clientY - rl.last;
    rl.last = e.clientY;
    if (!d) return;
    const deg = d * FEEL.fineAimDegPerPt;
    recPointer('roller', e, deg);
    app.setAim(app.aim - deg * DEG, 'fine');   // down = clockwise
    ribOffset = (ribOffset + d) % 10;
    ribs.style.transform = `translateY(${ribOffset}px)`;
    tickAcc += Math.abs(deg);
    if (tickAcc >= FEEL.fineTickDeg) { tickAcc = 0; haptic('light'); play('tick', 0.12); }
  });
  const rollerUp = (e) => { if (rl && e.pointerId === rl.id) { recPointer('roller', e, 0); rl = null; app.fineDone(); } };
  rollerEl.addEventListener('pointerup', rollerUp);
  rollerEl.addEventListener('pointercancel', rollerUp);

  // ---------- Spin picker ----------
  const pad = document.getElementById('spin-pad');
  const dot = pad.querySelector('.pad-dot');
  let sp = null;
  const setFromPad = (e) => {
    const r = pad.getBoundingClientRect();
    const rad = r.width / 2;
    let a = (e.clientX - (r.left + rad)) / rad, b = -(e.clientY - (r.top + rad)) / rad;
    const m = Math.hypot(a, b);
    if (m > FEEL.spinMax) { a *= FEEL.spinMax / m; b *= FEEL.spinMax / m; }
    app.setSpin(a, b);
  };
  pad.addEventListener('pointerdown', (e) => { recPointer('spin', e); sp = e.pointerId; pad.setPointerCapture(e.pointerId); setFromPad(e); e.preventDefault(); });
  pad.addEventListener('pointermove', (e) => { if (sp === e.pointerId) { recPointer('spin', e); setFromPad(e); } });
  const padUp = (e) => { if (sp === e.pointerId) { recPointer('spin', e); sp = null; } };
  pad.addEventListener('pointerup', padUp);
  pad.addEventListener('pointercancel', padUp);
  app.drawSpinDot = (a, b) => {
    const rad = pad.clientWidth / 2 || 116;
    dot.style.transform = `translate(${a * rad}px, ${-b * rad}px)`;
    pad.querySelector('.pad-limit').style.inset = `${(1 - FEEL.spinMax) * 50}%`;
  };

  // ---------- Keyboard (desktop testing, external keyboards, switch control) ----------
  window.addEventListener('keydown', (e) => {
    if (!app.inputEnabled() || e.target.tagName === 'INPUT') return;
    const fine = e.shiftKey ? 0.05 : 1;
    if (e.key === 'ArrowLeft') app.setAim(app.aim + fine * DEG, 'key');
    else if (e.key === 'ArrowRight') app.setAim(app.aim - fine * DEG, 'key');
    else if (e.key === 'ArrowUp') app.nudgePower(0.05);
    else if (e.key === 'ArrowDown') app.nudgePower(-0.05);
    else if (e.key === ' ' || e.key === 'Enter') app.shootAssisted();
    else return;
    e.preventDefault();
  });

  // Stop iOS page gestures (pinch zoom, rubber-band scroll) outside scrollable cards.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (!e.target.closest('.card')) e.preventDefault(); }, { passive: false });
  document.addEventListener('dblclick', (e) => e.preventDefault());

  return { showPower, cancel: () => { touches.clear(); pw = null; rl = null; sp = null; showPower(0); } };
}
