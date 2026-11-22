// Hidden touch recorder (Settings → long-press the version label → Diagnostics).
// Records raw pointer events and every shot, plus device/viewport info and the feel values,
// so real-finger data can be sent back for tuning. Survives restarts; capped in size.
import { load, update, remove } from './storage.js';
import { FEEL } from './feel.js';

const MAX = 20000;
let on = false, events = [], shots = [], dirty = false, t0 = 0, meta = {};

export function initRecorder(getMeta) {
  const saved = load('rec', null);
  if (saved) { on = !!saved.on; events = saved.events || []; shots = saved.shots || []; }
  meta.get = getMeta;
  t0 = Date.now() - performance.now();
  setInterval(flush, 3000);
}
export const recording = () => on;
export function setRecording(v) { on = v; dirty = true; flush(); }
export const recCount = () => events.length;

// kind: control name; e: PointerEvent
export function recPointer(kind, e, extra) {
  if (!on) return;
  events.push([Math.round((t0 + e.timeStamp) % 1e9), e.type.replace('pointer', ''), kind, +e.clientX.toFixed(1), +e.clientY.toFixed(1), e.pointerId,
    +(e.pressure || 0).toFixed(3), Math.round(e.width || 0), Math.round(e.height || 0), extra == null ? null : +(+extra).toFixed(5)]);
  if (events.length > MAX) events.splice(0, events.length - MAX);
  dirty = true;
}
export function recShot(shot, info) {
  if (!on) return;
  shots.push({ at: Date.now(), ...shot, ...info });
  if (shots.length > 2000) shots.shift();
  dirty = true;
}
export function flush() {
  if (!dirty) return;
  dirty = false;
  update('rec', () => ({ on, events, shots }), null);
}
export function clearRecording() { events = []; shots = []; remove('rec'); dirty = true; flush(); }

export function exportJSON() {
  return JSON.stringify({
    format: 'baize-touch-v1',
    exportedAt: new Date().toISOString(),
    columns: ['timeMs', 'type', 'control', 'clientX', 'clientY', 'pointerId', 'pressure', 'width', 'height', 'value'],
    device: { ua: navigator.userAgent, ...(meta.get ? meta.get() : {}) },
    feel: FEEL,
    events, shots,
  });
}

export async function shareRecording() {
  const json = exportJSON();
  const name = `baize-touches-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
  try {
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Baize touch recording' }); return 'shared'; }
  } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    return 'downloaded';
  } catch { return 'failed'; }
}

export async function copyRecording() {
  try { await navigator.clipboard.writeText(exportJSON()); return true; } catch { return false; }
}
