// Sound and haptics. Hits are CC0 recordings (src/sounds, built by tools/sounds.mjs); the synthesised
// buffers below are the fallback if a file fails to load or decode, plus the menu tick and the rolling hum.
let ctx = null, master = null, enabledSound = true, enabledHaptics = true;
const buffers = {};             // name -> [AudioBuffer, ...] variants
let voices = 0;
const lastPlay = {}, lastVariant = {};
const SAMPLES = { click: 4, cushion: 3, cue: 3, pocket: 3 };
const raw = {};                 // name -> Promise<ArrayBuffer|null>[]

// Fetch the recordings early (no gesture needed); they're decoded once audio is unlocked.
export function loadSounds() {
  for (const [name, n] of Object.entries(SAMPLES)) {
    raw[name] = Array.from({ length: n }, (_, i) => fetch(`sounds/${name}${i + 1}.wav`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null));
  }
}

// Resolves to the number of recordings decoded (the e2e check reads it).
export let soundsReady = Promise.resolve(0);
function decodeAll() {
  soundsReady = Promise.all(Object.entries(raw).map(async ([name, list]) => {
    const got = (await Promise.all(list.map(async (p) => {
      const ab = await p;
      if (!ab) return null;
      try { return await new Promise((res, rej) => ctx.decodeAudioData(ab.slice(0), res, rej)); } catch { return null; }
    }))).filter(Boolean);
    if (got.length) buffers[name] = got;
    return got.length;
  })).then((n) => n.reduce((a, b) => a + b, 0));
}

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
      decodeAll();
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  } catch { /* audio is optional */ }
}

export function suspendAudio() { setRoll(0); try { ctx?.suspend(); } catch { /* ignore */ } }

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
  const synth = {};
  // Ball on ball: bright, very short modal click.
  synth.click = buf(0.07, (d, sr, nz) => {
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
  synth.cushion = buf(0.14, (d, sr, nz) => {
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      lp += (nz() - lp) * 0.08;
      d[i] = lp * 2.2 * Math.exp(-38 * t) + Math.sin(TAU * 150 * t) * Math.exp(-30 * t) * 0.8 + Math.sin(TAU * 310 * t) * Math.exp(-45 * t) * 0.25;
    }
  });
  // Pocket: clunk, a short rattle, then a roll down the return.
  synth.pocket = buf(0.55, (d, sr, nz) => {
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
  synth.cue = buf(0.06, (d, sr, nz) => {
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      lp += (nz() - lp) * 0.35;
      d[i] = Math.sin(TAU * 1450 * t) * Math.exp(-110 * t) * 0.7 + lp * Math.exp(-180 * t) + Math.sin(TAU * 420 * t) * Math.exp(-60 * t) * 0.3;
    }
  });
  synth.tick = buf(0.03, (d, sr) => {
    for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = Math.sin(TAU * 2600 * t) * Math.exp(-220 * t); }
  });
  // Rolling on cloth: low-passed noise, looped. ponytail: synthesised, no clean CC0 roll recording found.
  synth.roll = buf(1.5, (d, sr, nz) => {
    let a = 0, b = 0;
    for (let i = 0; i < d.length; i++) { a += (nz() - a) * 0.06; b += (a - b) * 0.06; d[i] = b; }
  });
  for (const [k, v] of Object.entries(synth)) if (!buffers[k]) buffers[k] = [v];
}

// gain 0..1 (impact strength), rate ~1, pan -1..1. Picks a variant (never the same twice running),
// jitters pitch, and closes a low-pass on soft hits so they sound duller, as real ones do.
export function play(name, gain = 1, rate = 1, pan = 0) {
  const list = buffers[name];
  if (!enabledSound || !ctx || ctx.state !== 'running' || !list) return;
  const now = ctx.currentTime;
  if (voices >= 16) return;
  if (lastPlay[name] && now - lastPlay[name].t < 0.012 && gain <= lastPlay[name].g) return; // de-dupe bursts in the break
  lastPlay[name] = { t: now, g: gain };
  let v = Math.floor(Math.random() * list.length);
  if (list.length > 1 && v === lastVariant[name]) v = (v + 1) % list.length;
  lastVariant[name] = v;
  gain = Math.min(1, Math.max(0, gain));
  const src = ctx.createBufferSource();
  src.buffer = list[v];
  src.playbackRate.value = rate * (0.96 + Math.random() * 0.08);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1200 + 14000 * gain * gain;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(lp); lp.connect(g);
  if (pan && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    g.connect(p); p.connect(master);
  } else g.connect(master);
  voices++;
  src.onended = () => { voices--; };
  src.start(now);
}

// Rolling hum: level 0..1 from the balls' total speed; 0 fades it out and stops it.
let roll = null;
export function setRoll(level) {
  if (!ctx) return;
  const now = ctx.currentTime;
  if (level > 0.02 && enabledSound && ctx.state === 'running' && !roll) {
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = buffers.roll[0]; src.loop = true;
    g.gain.value = 0;
    src.connect(g); g.connect(master); src.start(now);
    roll = { src, g };
  }
  if (!roll) return;
  if (level > 0.02 && enabledSound) {
    roll.g.gain.setTargetAtTime(0.28 * Math.min(1, level), now, 0.06);
    roll.src.playbackRate.setTargetAtTime(0.7 + 0.6 * Math.min(1, level), now, 0.06);
  } else {
    roll.g.gain.setTargetAtTime(0, now, 0.05);
    roll.src.stop(now + 0.3);
    roll = null;
  }
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
