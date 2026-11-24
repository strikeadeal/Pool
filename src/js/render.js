// WebGL 1 renderer. One static unit quad; every primitive is that quad placed in world space
// (centre + two half-axes), so per-frame work is a few dozen small draws and uniform uploads.
// The table and room are a single pre-painted texture: no per-frame rasterisation on the CPU.
import { L, W, R, N } from './physics.js';
import { paintScene, noisePixels, paintDigits, paintCue, BALL_COLORS, hexToRgb, LAMPS, FELT_RGB } from './textures.js';

// Painting the table and room is a full-screen Canvas 2D raster plus a texture upload: 0.25 s at SE size and 0.6-0.9 s
// at 3x on a 4x-throttled WebKit, all in one task, and taps wait behind it. So a worker paints it and the main thread
// uploads it in strips, a few per task. Where there's no OffscreenCanvas (iOS before 16.4) it's painted here, as before.
const STRIP_PX = 1 << 17;    // pixels per strip handed back by the worker (512 KB)
const UPLOAD_MS = 6;         // upload strips for at most this long per task
let worker = null, jobId = 0;
function painter() {
  if (worker === null) {
    try { worker = typeof OffscreenCanvas === 'function' ? new Worker(new URL('./paint.js', import.meta.url), { type: 'module' }) : false; }
    catch { worker = false; }
  }
  return worker;
}

const VS = `
attribute vec2 a_q;
uniform mat3 u_m; uniform vec2 u_c, u_u, u_v;
varying vec2 v_q;
void main() { vec2 p = u_c + u_u * a_q.x + u_v * a_q.y; vec3 c = u_m * vec3(p, 1.0); gl_Position = vec4(c.xy, 0.0, 1.0); v_q = a_q; }`;

const FS_BG = `precision mediump float; varying vec2 v_q; uniform sampler2D u_tex;
void main() { gl_FragColor = texture2D(u_tex, vec2(v_q.x * 0.5 + 0.5, 0.5 - v_q.y * 0.5)); }`;

const FS_BALL = `#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 v_q;
uniform float u_k; uniform mat3 u_rot; uniform vec3 u_col; uniform float u_stripe, u_num, u_fade;
uniform sampler2D u_digits; uniform vec3 u_l0, u_l1, u_felt;
void main() {
  vec2 o = v_q * u_k;
  float r2 = dot(o, o), r = sqrt(r2);
  float aa = fwidth(r) * 1.25;
  float alpha = 1.0 - smoothstep(1.0 - aa, 1.0, r);
  if (alpha <= 0.0) discard;
  vec3 n = vec3(o, sqrt(max(0.0, 1.0 - min(r2, 1.0))));
  vec3 ln = u_rot * n;
  vec3 white = vec3(0.95, 0.93, 0.87);
  vec3 base = u_col;
  if (u_stripe > 0.5) { float b = abs(ln.z); float w = fwidth(b) + 0.004; base = mix(u_col, white, smoothstep(0.52 - w, 0.52 + w, b)); }
  if (u_num > 0.5) {
    float side = ln.x >= 0.0 ? 1.0 : -1.0;
    float c = abs(ln.x); float dw = fwidth(c) + 0.002;
    float disc = smoothstep(0.93 - dw, 0.93 + dw, c);
    vec2 t = vec2(ln.y * side, ln.z) / 0.37;
    vec2 cell = vec2(mod(u_num, 4.0), floor(u_num / 4.0 + 0.001));
    vec2 uv = (cell + 0.5 + vec2(t.x, -t.y) * 0.46) / 4.0;
    float ink = texture2D(u_digits, uv).r;
    base = mix(base, mix(vec3(0.07), white, ink), disc);
  } else {
    float c = abs(ln.x); float dw = fwidth(c) + 0.001;
    base = mix(base, vec3(0.62, 0.07, 0.05), smoothstep(0.991 - dw, 0.991 + dw, c));
  }
  vec3 lin = pow(base, vec3(2.2));
  float d0 = max(dot(n, u_l0), 0.0), d1 = max(dot(n, u_l1), 0.0);
  vec3 col = lin * (0.16 + 0.62 * d0 + 0.62 * d1);
  // One elongated highlight from the long lamp over the table (stretched along the table's length),
  // plus a broad sheen. Two point highlights read as a colon on small balls.
  vec3 hc = normalize(normalize(u_l0 + u_l1) + vec3(0.0, 0.0, 1.0));
  vec3 ns = normalize(vec3(n.x * 0.5, n.y, n.z));
  float e0 = max(dot(ns, hc), 0.0);
  float sp = pow(e0, 300.0) * 1.3;
  float sheen = pow(max(dot(n, hc), 0.0), 14.0);
  float fres = pow(1.0 - n.z, 3.0);
  col = mix(col, u_felt * 0.55, fres * 0.5);
  col += vec3(1.0, 0.97, 0.9) * (sp * 1.7 + sheen * 0.07);
  col *= 1.0 - u_fade;
  gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), alpha * (1.0 - u_fade * 0.6));
}`;

// mode 0: bar (AA across width, optional dashes), 1: ring, 2: disc, 3: soft disc (shadow)
const FS_SHAPE = `#extension GL_OES_standard_derivatives : enable
precision mediump float;
varying vec2 v_q;
uniform vec4 u_color; uniform float u_mode, u_r0, u_dash;
void main() {
  float a = 1.0;
  if (u_mode < 0.5) {
    float y = abs(v_q.y); float w = fwidth(y) * 1.5;
    a = 1.0 - smoothstep(1.0 - w, 1.0, y);
    if (u_dash > 0.0) { float f = fract(v_q.x * u_dash); a *= smoothstep(0.0, 0.08, f) * (1.0 - smoothstep(0.55, 0.63, f)); }
  } else {
    float r = length(v_q); float w = fwidth(r) * 1.5;
    if (u_mode < 1.5) a = smoothstep(u_r0 - w, u_r0, r) * (1.0 - smoothstep(1.0 - w, 1.0, r));
    else if (u_mode < 2.5) a = 1.0 - smoothstep(1.0 - w, 1.0, r);
    else a = 1.0 - smoothstep(u_r0, 1.0, r);
  }
  if (a <= 0.0) discard;
  gl_FragColor = vec4(u_color.rgb, u_color.a * a);
}`;

const FS_CUE = `#extension GL_OES_standard_derivatives : enable
precision mediump float;
varying vec2 v_q; uniform sampler2D u_tex; uniform float u_tip; uniform float u_alpha;
void main() {
  float u = v_q.x * 0.5 + 0.5;
  float half_ = mix(u_tip, 1.0, smoothstep(0.0, 0.62, u));
  float y = v_q.y / half_;
  float w = fwidth(y) * 1.5;
  float a = 1.0 - smoothstep(1.0 - w, 1.0, abs(y));
  if (a <= 0.0) discard;
  vec4 c = texture2D(u_tex, vec2(u, y * 0.5 + 0.5));
  gl_FragColor = vec4(c.rgb, a * u_alpha);
}`;

function compile(gl, vs, fs) {
  const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'a_q');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

function texture(gl, src, mip) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (mip) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
  else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  return t;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.lost = false;
    this.colors = BALL_COLORS.map(hexToRgb);
    this.rot = new Float32Array(9);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.bgKey = null; this.init(); if (this.lay) this.resize(this.lay, this.dpr); this.onRestore?.(); });
    this.init();
  }

  init() {
    const gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'default' });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    gl.getExtension('OES_standard_derivatives');
    this.bgProg = compile(gl, VS, FS_BG);
    this.ball = compile(gl, VS, FS_BALL);
    this.shape = compile(gl, VS, FS_SHAPE);
    this.cue = compile(gl, VS, FS_CUE);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.digitTex = this.cueTex = null;   // made by paintBg while the worker paints (they're a 40-60 ms task)
    this.bg = null;         // the painting on screen: { key, lay, tex }
    this.bgs = [];          // the last two paintings, so going between two layouts (assisted aiming) doesn't repaint
    this.job = null;
  }

  resize(lay, dpr) {
    this.lay = lay; this.dpr = dpr;
    const c = this.canvas;
    // Every screen change relayouts; setting a canvas's size, even to the same value, reallocates its drawing buffer.
    const cw = Math.round(lay.w * dpr), ch = Math.round(lay.h * dpr);
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    c.style.width = lay.w + 'px'; c.style.height = lay.h + 'px';
    const gl = this.gl;
    if (this.lost) return;
    gl.viewport(0, 0, c.width, c.height);
    // Repaint the table only when its geometry actually changed (resize events are frequent).
    const key = [lay.w, lay.h, dpr, lay.s, lay.cx, lay.cy].join();
    if (key !== this.bgKey) { this.bgKey = key; this.paintBg(lay, dpr, key); }
    const s = lay.s, vw = lay.w, vh = lay.h, [ex0, ex1] = lay.ex, [ey0, ey1] = lay.ey;
    const A = (2 * s * ex0) / vw, B = (2 * s * ey0) / vw, C = (2 * (lay.cx - (L / 2) * s * ex0 - (W / 2) * s * ey0)) / vw - 1;
    const D = (-2 * s * ex1) / vh, E = (-2 * s * ey1) / vh, F = 1 - (2 * (lay.cy - (L / 2) * s * ex1 - (W / 2) * s * ey1)) / vh;
    this.m = new Float32Array([A, D, 0, B, E, 0, C, F, 1]);
  }

  get ready() { return !!(this.bg && this.digitTex); }
  makeTextures() {
    if (this.digitTex || this.lost) return;
    this.digitTex = texture(this.gl, paintDigits(), true);
    this.cueTex = texture(this.gl, paintCue(), true);
    if (this.ready) this.onReady?.();
  }

  // Until the new painting is in, the last one stays up, moved and scaled so its table sits on the new table.
  paintBg(lay, dpr, key) {
    const hit = this.bgs.find((b) => b.key === key);
    if (hit) { this.job = null; this.bg = hit; return; }
    const gl = this.gl, job = (this.job = { id: ++jobId });
    const finish = (tex) => {
      this.job = null;
      this.bg = { key, lay, tex };
      this.bgs = [this.bg, ...this.bgs.filter((b) => b.key !== key)];
      for (const b of this.bgs.splice(2)) gl.deleteTexture(b.tex);
      if (this.ready) this.onReady?.();
    };
    const w = painter();
    if (!w) { this.makeTextures(); finish(texture(gl, paintScene(lay, dpr), false)); return; }
    const cw = Math.round(lay.w * dpr), ch = Math.round(lay.h * dpr);
    const fail = () => { if (this.job === job) { worker = false; this.paintBg(lay, dpr, key); } };
    w.onerror = fail;
    w.onmessage = ({ data }) => {
      if (data.id !== job.id || this.job !== job || this.lost) { for (const b of data.strips) b.close(); return; }
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      for (const [k, v] of [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_MIN_FILTER, gl.LINEAR]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      let i = 0, y = 0;
      const step = () => {
        if (this.job !== job || this.lost) { gl.deleteTexture(tex); for (const b of data.strips.slice(i)) b.close(); return; }
        const t = performance.now();
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
        do { const b = data.strips[i++]; gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, gl.RGBA, gl.UNSIGNED_BYTE, b); y += b.height; b.close(); }
        while (i < data.strips.length && performance.now() - t < UPLOAD_MS);
        if (i < data.strips.length) setTimeout(step, 0); else finish(tex);
      };
      step();
    };
    w.postMessage({ id: job.id, lay: { w: lay.w, h: lay.h, s: lay.s, cx: lay.cx, cy: lay.cy, ex: lay.ex, ey: lay.ey }, dpr, noise: noisePixels(), rows: Math.max(1, Math.floor(STRIP_PX / cw)) });
    if (!this.digitTex) setTimeout(() => this.makeTextures(), 0);
  }

  use(prog) {
    const gl = this.gl;
    if (this.cur !== prog) { gl.useProgram(prog.p); this.cur = prog; gl.uniformMatrix3fv(prog.u.u_m, false, this.m); }
    return prog.u;
  }

  quad(u, cx, cy, ux, uy, vx, vy) {
    const gl = this.gl;
    gl.uniform2f(u.u_c, cx, cy); gl.uniform2f(u.u_u, ux, uy); gl.uniform2f(u.u_v, vx, vy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---- primitives (world units) ----
  bar(x0, y0, x1, y1, width, rgba, dash = 0) {
    const u = this.use(this.shape);
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1e-6;
    const hx = dx / 2, hy = dy / 2, px = (-dy / len) * width / 2, py = (dx / len) * width / 2;
    this.gl.uniform4fv(u.u_color, rgba); this.gl.uniform1f(u.u_mode, 0); this.gl.uniform1f(u.u_dash, dash ? len / dash : 0);
    this.quad(u, x0 + hx, y0 + hy, hx, hy, px, py);
  }
  ring(x, y, r, thick, rgba) {
    const u = this.use(this.shape);
    this.gl.uniform4fv(u.u_color, rgba); this.gl.uniform1f(u.u_mode, 1); this.gl.uniform1f(u.u_r0, 1 - thick / r);
    this.quad(u, x, y, r, 0, 0, r);
  }
  disc(x, y, r, rgba, soft = -1) {
    const u = this.use(this.shape);
    this.gl.uniform4fv(u.u_color, rgba); this.gl.uniform1f(u.u_mode, soft >= 0 ? 3 : 2); this.gl.uniform1f(u.u_r0, soft);
    this.quad(u, x, y, r, 0, 0, r);
  }

  drawBall(i, x, y, q, o, scale = 1, fade = 0) {
    const gl = this.gl, u = this.use(this.ball);
    const w = q[o], qx = q[o + 1], qy = q[o + 2], qz = q[o + 3];
    const m = this.rot;   // world -> local = R^T, column-major
    m[0] = 1 - 2 * (qy * qy + qz * qz); m[1] = 2 * (qx * qy - w * qz); m[2] = 2 * (qx * qz + w * qy);
    m[3] = 2 * (qx * qy + w * qz); m[4] = 1 - 2 * (qx * qx + qz * qz); m[5] = 2 * (qy * qz - w * qx);
    m[6] = 2 * (qx * qz - w * qy); m[7] = 2 * (qy * qz + w * qx); m[8] = 1 - 2 * (qx * qx + qy * qy);
    gl.uniformMatrix3fv(u.u_rot, false, m);
    const c = this.colors[i];
    gl.uniform3f(u.u_col, c[0], c[1], c[2]);
    gl.uniform1f(u.u_stripe, i > 8 ? 1 : 0);
    gl.uniform1f(u.u_num, i);
    gl.uniform1f(u.u_fade, fade);
    for (let k = 0; k < 2; k++) {
      const [lx, ly, lz] = LAMPS[k];
      const dx = lx - x, dy = ly - y, dz = lz - R, n = Math.hypot(dx, dy, dz);
      gl.uniform3f(k ? u.u_l1 : u.u_l0, dx / n, dy / n, dz / n);
    }
    const k = 1.08;
    gl.uniform1f(u.u_k, k);
    const r = R * scale * k;
    this.quad(u, x, y, r, 0, 0, r);
  }

  shadowFor(x, y, scale = 1) {
    // contact shadow plus one soft shadow per lamp, cast away from it
    this.disc(x, y, R * 1.02 * scale, [0, 0, 0, 0.5], 0.55);
    for (const [lx, ly, lz] of LAMPS) {
      const k = R / (lz - R);
      this.disc(x + (x - lx) * k * 1.6, y + (y - ly) * k * 1.6, R * 1.35 * scale, [0, 0, 0, 0.2], 0.3);
    }
  }

  drawCue(tipX, tipY, dx, dy, alpha = 1) {
    const len = 1.45, maxW = 0.0145;
    const cx = tipX - dx * len / 2, cy = tipY - dy * len / 2;
    // Clip the cue to the play area between the side columns and below the HUD, so it never
    // runs over the controls or the player plates. GL scissor y counts up from the bottom.
    const gl = this.gl, r = this.lay.region, d = this.dpr;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.round(r.x * d), 0, Math.round(r.w * d), Math.round((this.lay.h - r.y) * d));
    // shadow on the cloth, offset as if from above-left lamp
    const u0 = this.use(this.shape);
    this.gl.uniform4fv(u0.u_color, [0, 0, 0, 0.28 * alpha]); this.gl.uniform1f(u0.u_mode, 0); this.gl.uniform1f(u0.u_dash, 0);
    this.quad(u0, cx + 0.012, cy - 0.016, -dx * len / 2, -dy * len / 2, -dy * maxW * 1.3, dx * maxW * 1.3);
    const u = this.use(this.cue);
    this.gl.activeTexture(this.gl.TEXTURE0); this.gl.bindTexture(this.gl.TEXTURE_2D, this.cueTex);
    this.gl.uniform1i(u.u_tex, 0); this.gl.uniform1f(u.u_tip, 0.45); this.gl.uniform1f(u.u_alpha, alpha);
    this.quad(u, cx, cy, -dx * len / 2, -dy * len / 2, -dy * maxW, dx * maxW);
    gl.disable(gl.SCISSOR_TEST);
  }

  // scene: { balls:{x,y,on,q}, drops:[{i,x,y,s,f}], under:[fn], over:[fn], cue:{x,y,dx,dy,a}|null }
  draw(scene) {
    if (this.lost || !this.ready) return;
    const gl = this.gl;
    this.cur = null;
    const ub = this.use(this.bgProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.bg.tex);
    gl.uniform1i(ub.u_tex, 0);
    gl.uniformMatrix3fv(ub.u_m, false, IDENT);
    const o = this.bg.lay, n = this.lay;
    if (this.bg.key === this.bgKey) { gl.uniform2f(ub.u_c, 0, 0); gl.uniform2f(ub.u_u, 1, 0); gl.uniform2f(ub.u_v, 0, 1); }
    else {
      // stand-in while the repaint for a new size is under way: the old picture, its table over the new table
      gl.clearColor(0.012, 0.027, 0.059, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      const k = n.s / o.s, X = (x) => (2 * (n.cx + (x - o.cx) * k)) / n.w - 1, Y = (y) => 1 - (2 * (n.cy + (y - o.cy) * k)) / n.h;
      const x0 = X(0), x1 = X(o.w), y0 = Y(0), y1 = Y(o.h);
      gl.uniform2f(ub.u_c, (x0 + x1) / 2, (y0 + y1) / 2); gl.uniform2f(ub.u_u, (x1 - x0) / 2, 0); gl.uniform2f(ub.u_v, 0, (y0 - y1) / 2);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.cur = null;
    for (const f of scene.under || []) f(this);
    const b = scene.balls;
    for (const d of scene.drops || []) this.disc(d.x, d.y, R * d.s, [0, 0, 0, 0.35 * (1 - d.f)], 0.4);
    for (let i = 0; i < N; i++) if (b.on[i]) this.shadowFor(b.x[i], b.y[i]);
    // ball shader needs the digit texture on unit 1 and felt colour
    const u = this.use(this.ball);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.digitTex);
    gl.uniform1i(u.u_digits, 1);
    gl.uniform3f(u.u_felt, FELT_RGB[0], FELT_RGB[1], FELT_RGB[2]);
    gl.activeTexture(gl.TEXTURE0);
    for (const d of scene.drops || []) this.drawBall(d.i, d.x, d.y, b.q, d.i * 4, d.s, d.f);
    for (let i = 0; i < N; i++) if (b.on[i]) this.drawBall(i, b.x[i], b.y[i], b.q, i * 4);
    for (const f of scene.over || []) f(this);
    if (scene.cue) this.drawCue(scene.cue.x, scene.cue.y, scene.cue.dx, scene.cue.dy, scene.cue.a ?? 1);
  }
}
const IDENT = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
