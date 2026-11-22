// Sound (synthesised at start-up, nothing sampled) and haptics.
let ctx = null, master = null, enabledSound = true, enabledHaptics = true;
const buffers = {};
let voices = 0;
const lastPlay = {};

export function setSound(on) { enabledSound = on; }
export function setHaptics(on) { enabledHaptics = on; }

// Must be called from a user gesture (iOS only starts audio inside one).
export function unlockAudio() {
  try {
    if (!ctx) {
      // 'ambient': respects the ringer switch and mixes with the player's music.
      if (navigator.audioSession) navigator.audioSession.type = 'ambient';
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
      build();
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  } catch { /* audio is optional */ }
}

export function suspendAudio() { try { ctx?.suspend(); } catch { /* ignore */ } }

function buf(dur, fill) {
  const sr = ctx.sampleRate, n = Math.floor(sr * dur);
  const b = ctx.createBuffer(1, n, sr);
  const d = b.getChannelData(0);
  let seed = 12345;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;
  fill(d, sr, noise);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (let i = 0; i < n; i++) d[i] /= peak;
  return b;
}

function build() {
  const TAU = Math.PI * 2;
  // Ball on ball: bright, very short modal click.
  buffers.click = buf(0.07, (d, sr, nz) => {
    const modes = [[2350, 1, 90], [3720, 0.6, 120], [5480, 0.35, 160], [7900, 0.15, 220]];
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      let v = 0;
      for (const [f, a, k] of modes) v += a * Math.sin(TAU * f * t) * Math.exp(-k * t);
      v += nz() * 0.25 * Math.exp(-900 * t);
      d[i] = v;
    }
  });
  // Cushion: soft rubber thump.
  buffers.cushion = buf(0.14, (d, sr, nz) => {
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      lp += (nz() - lp) * 0.08;
      d[i] = lp * 2.2 * Math.exp(-38 * t) + Math.sin(TAU * 150 * t) * Math.exp(-30 * t) * 0.8 + Math.sin(TAU * 310 * t) * Math.exp(-45 * t) * 0.25;
    }
  });
  // Pocket: clunk, a short rattle, then a roll down the return.
  buffers.pocket = buf(0.55, (d, sr, nz) => {
    let lp = 0;
    const clicks = [0, 0.035, 0.07];
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      let v = Math.sin(TAU * 105 * t) * Math.exp(-14 * t) * 0.9 + Math.sin(TAU * 240 * t) * Math.exp(-22 * t) * 0.4;
      for (const c of clicks) if (t > c) v += Math.sin(TAU * 1900 * (t - c)) * Math.exp(-160 * (t - c)) * 0.35;
      lp += (nz() - lp) * 0.03;
      v += lp * 1.4 * Math.exp(-6 * Math.max(0, t - 0.08)) * (t > 0.08 ? 1 : 0);
      d[i] = v;
    }
  });
  // Cue tip on ball: leathery tick.
  buffers.cue = buf(0.06, (d, sr, nz) => {
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      lp += (nz() - lp) * 0.35;
      d[i] = Math.sin(TAU * 1450 * t) * Math.exp(-110 * t) * 0.7 + lp * Math.exp(-180 * t) + Math.sin(TAU * 420 * t) * Math.exp(-60 * t) * 0.3;
    }
  });
  buffers.tick = buf(0.03, (d, sr) => {
    for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = Math.sin(TAU * 2600 * t) * Math.exp(-220 * t); }
  });
}

// gain 0..1, rate ~1
export function play(name, gain = 1, rate = 1) {
  if (!enabledSound || !ctx || ctx.state !== 'running' || !buffers[name]) return;
  const now = ctx.currentTime;
  if (voices > 12) return;
  if (lastPlay[name] && now - lastPlay[name].t < 0.012 && gain <= lastPlay[name].g) return; // de-dupe bursts in the break
  lastPlay[name] = { t: now, g: gain };
  const src = ctx.createBufferSource();
  src.buffer = buffers[name];
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = Math.min(1, Math.max(0, gain));
  src.connect(g); g.connect(master);
  voices++;
  src.onended = () => { voices--; };
  src.start(now);
}

// Haptics: Vibration API where it exists; on iOS 18+ a native switch input gives a system tick
// when toggled. Only works inside a user gesture, so it's used for touch feedback, not collisions.
let lastHaptic = 0;
export function haptic(strength = 'light') {
  if (!enabledHaptics) return;
  const now = performance.now();
  if (now - lastHaptic < 45) return;
  lastHaptic = now;
  try {
    if (navigator.vibrate) { navigator.vibrate(strength === 'heavy' ? 18 : 8); return; }
    document.getElementById('haptic')?.click();
  } catch { /* optional */ }
}
