// Builds src/sounds/*.wav from CC0 recordings on Freesound.
// Run: node tools/sounds.mjs   (needs curl, ffmpeg, and network access to cdn.freesound.org)
// Each clip is cut at the recorded hit, high-passed, faded, peak-normalised, and saved as
// mono 16-bit WAV at 32 kHz. WAV, not MP3/AAC: encoder padding would delay every hit by ~25 ms.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SR = 32000;
// All sources are Creative Commons 0 (checked on each sound's Freesound page).
export const SOURCES = {
  245397: { by: 'Cymeon', title: 'Billiard Ball percussive hits', mp3: 'https://cdn.freesound.org/previews/245/245397_3545231-hq.mp3' },
  763602: { by: 'ChloePieterse', title: 'Pool Ball Clatter', mp3: 'https://cdn.freesound.org/previews/763/763602_15688677-hq.mp3' },
  675330: { by: 'craigsmith', title: 'S02-22 Billiards cue stick hits ball', mp3: 'https://cdn.freesound.org/previews/675/675330_2524442-hq.mp3' },
  763601: { by: 'ChloePieterse', title: 'Pool Ball Sinking', mp3: 'https://cdn.freesound.org/previews/763/763601_15688677-hq.mp3' },
  441857: { by: 'Yarmonics', title: 'B_1 pool ball falling', mp3: 'https://cdn.freesound.org/previews/441/441857_9109395-hq.mp3' },
  708103: { by: 'Rinaldobowles56', title: 'Hard Bowls ball rolling on wooden table', mp3: 'https://cdn.freesound.org/previews/708/708103_14713648-hq.mp3' },
};
// Rolling loop: [source id, start (s), length (s), crossfade (s)]. 1.1-2.9 s is the steady part (level within ±2 dB).
const ROLL = [708103, 1.1, 1.8, 0.3];
// [output name, source id, approximate hit time (s), clip length (s)]
const CUTS = [
  ['click1', 245397, 10.147, 0.12], ['click2', 245397, 19.250, 0.12],
  ['click3', 763602, 11.137, 0.12], ['click4', 763602, 18.466, 0.12],
  ['cushion1', 675330, 98.065, 0.2], ['cushion2', 675330, 76.051, 0.2], ['cushion3', 675330, 67.185, 0.2],
  ['cue1', 675330, 3.815, 0.15], ['cue2', 675330, 7.220, 0.15], ['cue3', 675330, 18.869, 0.15],
  ['pocket1', 763601, 4.817, 0.6], ['pocket2', 763601, 16.580, 0.6], ['pocket3', 441857, 0, 0.72],
];

function decode(file) {
  const raw = execFileSync('ffmpeg', ['-v', 'quiet', '-i', file, '-af', 'highpass=f=60', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

// Cut one clip: start 1 ms before the first sample above a quarter of the hit's peak.
export function cut(x, at, len) {
  const a = Math.max(0, Math.round((at - 0.03) * SR)), b = Math.min(x.length, Math.round((at + 0.05) * SR));
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(x[i]));
  let on = a;
  while (on < b && Math.abs(x[on]) < peak * 0.25) on++;
  const s = Math.max(0, on - Math.round(SR * 0.001)), n = Math.min(Math.round(len * SR), x.length - s);
  const y = x.slice(s, s + n), fadeIn = 16, fadeOut = Math.round(n * 0.3);
  for (let i = 0; i < fadeIn; i++) y[i] *= i / fadeIn;
  for (let i = 0; i < fadeOut; i++) y[n - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fadeOut);
  let p = 0;
  for (const v of y) p = Math.max(p, Math.abs(v));
  const k = p ? 0.891 / p : 1; // peak -1 dBFS
  for (let i = 0; i < n; i++) y[i] *= k;
  return y;
}

// Seamless loop: the last `xf` seconds are crossfaded (equal power) into the start.
export function loop(x, at, len, xf) {
  const s = Math.round(at * SR), n = Math.round(len * SR), f = Math.round(xf * SR), m = n - f;
  const y = new Float32Array(m);
  for (let i = 0; i < m; i++) y[i] = x[s + i];
  for (let i = 0; i < f; i++) {
    const k = i / f;
    y[i] = x[s + i] * Math.sin(k * Math.PI / 2) + x[s + m + i] * Math.cos(k * Math.PI / 2);
  }
  let p = 0;
  for (const v of y) p = Math.max(p, Math.abs(v));
  for (let i = 0; i < m; i++) y[i] *= 0.891 / p;
  return y;
}

export function wav(y) {
  const out = Buffer.alloc(44 + y.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + y.length * 2, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(SR, 24); out.writeUInt32LE(SR * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36); out.writeUInt32LE(y.length * 2, 40);
  for (let i = 0; i < y.length; i++) out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, y[i])) * 32767), 44 + i * 2);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cache = join(tmpdir(), 'pool-sounds'), outDir = new URL('../src/sounds/', import.meta.url).pathname;
  mkdirSync(cache, { recursive: true }); mkdirSync(outDir, { recursive: true });
  const decoded = {};
  for (const [id, s] of Object.entries(SOURCES)) {
    const f = join(cache, `${id}.mp3`);
    if (!existsSync(f)) execFileSync('curl', ['-sSfL', '--retry', '3', '-o', f, s.mp3]);
    decoded[id] = decode(f);
  }
  let total = 0;
  for (const [name, id, at, len] of CUTS) {
    const file = wav(cut(decoded[id], at, len));
    writeFileSync(join(outDir, `${name}.wav`), file);
    total += file.length;
    console.log(`${name}.wav  ${id} @ ${at}s  ${(file.length / 1024).toFixed(1)} KB`);
  }
  const [rid, rat, rlen, rxf] = ROLL, rf = wav(loop(decoded[rid], rat, rlen, rxf));
  writeFileSync(join(outDir, 'roll1.wav'), rf);
  total += rf.length;
  console.log(`roll1.wav  ${rid} @ ${rat}s loop  ${(rf.length / 1024).toFixed(1)} KB`);
  console.log(`total ${(total / 1024).toFixed(0)} KB`);
}
