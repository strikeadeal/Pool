import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/js/physics.js';

const { R, L, W } = P;
const deg = (r) => (r * 180) / Math.PI;

function table(pairs) {
  const b = P.emptyBalls();
  for (const [i, x, y] of pairs) { b.x[i] = x; b.y[i] = y; b.on[i] = 1; }
  return b;
}
// A slow ball can stop on the lip of a pocket: centre past the cushion line but not past the drop edge.
function hangingInJaws(x, y) {
  return P.TABLE.pockets.some((pk, i) => {
    const depth = (x - pk.mx) * pk.ax + (y - pk.my) * pk.ay;
    const lat = Math.abs((x - pk.mx) * -pk.ay + (y - pk.my) * pk.ax);
    const mouth = i === 1 || i === 4 ? P.SIDE_MOUTH : P.CORNER_MOUTH;
    return depth <= pk.drop && lat < mouth / 2;
  });
}
function unit(dx, dy) { const l = Math.hypot(dx, dy); return [dx / l, dy / l]; }
// Step until the predicate holds (or the sim ends); returns the sim.
function until(sim, pred) { while (!sim.done && !pred(sim)) sim.step(); return sim; }
function hash(arr) { // FNV-1a over the float64 bytes: any bit change shows
  const bytes = new Uint8Array(Float64Array.from(arr).buffer);
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}
const breakShot = (seed) => {
  const b = P.rack(seed);
  const [dx, dy] = unit(P.FOOT_X - b.x[0], W / 2 - b.y[0] + 0.002);
  return { b, shot: { dx, dy, speed: 8.5, a: 0, b: 0 } };
};

test('determinism: identical shots give bit-identical results, chunking does not matter', () => {
  const { b, shot } = breakShot(42);
  const s1 = P.simulate(P.cloneBalls(b), shot);
  const s2 = new P.Sim(P.cloneBalls(b), shot);
  while (!s2.advance(7));                       // odd-sized chunks, like time-sliced playback
  const f1 = s1.finalBalls(), f2 = s2.finalBalls();
  assert.deepEqual(f1, f2);
  assert.equal(s1.nFrames, s2.nFrames);
  assert.deepEqual(Array.from(s1.frames.subarray(0, s1.nFrames * 96)), Array.from(s2.frames.subarray(0, s2.nFrames * 96)));
});

test('determinism: golden checksum of a full break (update deliberately if physics changes)', () => {
  const { b, shot } = breakShot(7);
  const f = P.simulate(b, shot, { record: false }).finalBalls();
  const h = hash([...f.x, ...f.y, ...f.on, ...f.q]);
  // If this fails after an intentional physics change, replace the value below.
  // If it fails on a different engine/platform, determinism is broken: investigate.
  assert.equal(h, GOLDEN_BREAK);
});
const GOLDEN_BREAK = '501e870e';

test('head-on collision: stun transfers (1+e)/2 of the speed, cue keeps (1-e)/2', () => {
  const sim = new P.Sim(table([[0, 1.0, 0.5], [1, 1.0 + 2 * R + 0.0005, 0.5]]), { dx: 1, dy: 0, speed: 2 }, { record: false });
  until(sim, (s) => s.first === 1);
  assert.ok(Math.abs(sim.vx[0] - 0.025 * 2) < 0.01, `cue ${sim.vx[0]}`);
  assert.ok(Math.abs(sim.vx[1] - 0.975 * 2) < 0.01, `obj ${sim.vx[1]}`);
  assert.ok(Math.abs(sim.vy[1]) < 1e-12);
});

test('cut shot: object ball leaves along the line of centres, cue ball along the tangent (90 degree rule)', () => {
  const b = table([[0, 0.8, 0.5], [1, 1.2, 0.55]]);
  const [dx, dy] = unit(1, 0);
  const pred = P.predict(b, dx, dy);
  assert.equal(pred.kind, 'ball'); assert.equal(pred.ball, 1);
  const sim = until(new P.Sim(b, { dx, dy, speed: 1.5, b: -0.15 }, { record: false }), (s) => s.first === 1);
  const oa = Math.atan2(sim.vy[1], sim.vx[1]), pa = Math.atan2(pred.oy, pred.ox);
  assert.ok(Math.abs(deg(oa - pa)) < 0.01, `object ball off guide by ${deg(oa - pa)} deg`);
  const ca = Math.atan2(sim.vy[0], sim.vx[0]);
  const sep = Math.abs(deg(ca - oa));
  assert.ok(sep > 84 && sep < 92, `separation ${sep}`);
});

test('guide line tells the truth: predicted object-ball direction matches the simulation for many cuts', () => {
  for (let k = 0; k < 40; k++) {
    const oy = 0.3 + k * 0.01;
    const b = table([[0, 0.5, 0.5], [3, 1.3, oy]]);
    const g = P.ghostAim(b, 3, L, oy + (k - 20) * 0.02);
    const pred = P.predict(b, g.dx, g.dy);
    if (pred.kind !== 'ball') continue;
    const sim = until(new P.Sim(b, { dx: g.dx, dy: g.dy, speed: 2 }, { record: false }), (s) => s.first === 3);
    const err = Math.abs(deg(Math.atan2(sim.vy[3], sim.vx[3]) - Math.atan2(pred.oy, pred.ox)));
    assert.ok(err < 0.005, `cut ${k}: ${err} deg`);
  }
});

test('cushion: angle in roughly equals angle out without english; speed reduced by restitution', () => {
  const [dx, dy] = unit(1, -1);
  const sim = until(new P.Sim(table([[0, 1.0, 0.1]]), { dx, dy, speed: 1, b: 0.4 }, { record: false }), (s) => s.vy[0] > 0);
  const out = deg(Math.atan2(sim.vx[0], sim.vy[0]));
  assert.ok(out > 38 && out < 47, `rebound ${out}`);
  const vin = 1 * Math.SQRT1_2, vout = sim.vy[0];
  assert.ok(vout / vin > 0.72 && vout / vin < 0.86, `normal ratio ${vout / vin}`);
});

test('cushion: running english lengthens the angle, reverse english shortens it', () => {
  const [dx, dy] = unit(1, -1);
  const angle = (a) => {
    const sim = until(new P.Sim(table([[0, 1.0, 0.1]]), { dx, dy, speed: 1.5, a }, { record: false }), (s) => s.vy[0] > 0);
    return deg(Math.atan2(sim.vx[0], sim.vy[0]));
  };
  const none = angle(0), running = angle(-0.4), reverse = angle(0.4);
  assert.ok(running > none + 5, `running ${running} vs ${none}`);
  assert.ok(reverse < none - 1, `reverse ${reverse} vs ${none}`);
});

test('cushion: a rolling ball comes back at 55-75% of its speed once rolling again', () => {
  const sim = new P.Sim(table([[0, 1.2, 0.5]]), { dx: -1, dy: 0, speed: 1.2, b: 0.4 }, { record: false });
  let vin = 0;
  until(sim, (s) => { if (s.vx[0] < 0) vin = -s.vx[0]; return s.vx[0] > 0; });
  until(sim, (s) => Math.abs(s.vx[0] - R * s.wy[0]) < 1e-9);
  const ratio = sim.vx[0] / vin;
  assert.ok(ratio > 0.55 && ratio < 0.75, `ratio ${ratio}`);
});

test('spin: draw comes back, follow goes through, stun stops dead', () => {
  // Measure the cue ball's velocity once it has finished sliding after contact.
  const after = (b, dist, speed) => {
    const sim = new P.Sim(table([[0, 1.0 - dist, 0.5], [1, 1.0, 0.5]]), { dx: 1, dy: 0, speed, b }, { record: false });
    until(sim, (s) => s.first === 1);
    until(sim, (s) => Math.abs(s.vx[0] - R * s.wy[0]) < 1e-9 || (s.vx[0] === 0 && s.wy[0] === 0));
    return sim.vx[0];
  };
  assert.ok(after(-0.45, 0.3, 2.5) < -0.3, 'draw should pull back');
  assert.ok(after(0.45, 0.3, 2.5) > 0.3, 'follow should run through');
  assert.ok(Math.abs(after(0, 0.06, 2)) < 0.1, 'stun should stop near contact');
  // natural roll (b = 0.4) at contact gives the classic 2/7 follow speed
  const v = after(0.4, 0.06, 2);
  assert.ok(Math.abs(v / (2 * 0.975) - 2 / 7) < 0.05, `follow ratio ${v / 2}`);
});

test('pocketing: straight shots drop in all six pockets at soft, medium and hard pace', () => {
  for (let p = 0; p < 6; p++) {
    const pk = P.TABLE.pockets[p];
    for (const speed of [0.8, 2, 5]) {
      const ox = pk.mx - pk.ax * 0.25, oy = pk.my - pk.ay * 0.25;   // object 25 cm out on the pocket axis
      const cx = pk.mx - pk.ax * 0.6, cy = pk.my - pk.ay * 0.6;
      const b = table([[0, cx, cy], [1, ox, oy]]);
      const s = P.simulate(b, { dx: pk.ax, dy: pk.ay, speed }, { record: false });
      const hit = s.pocketed.find((e) => e.b === 1);
      assert.ok(hit && hit.p === p, `pocket ${p} at ${speed} m/s: ${JSON.stringify(s.pocketed)}`);
    }
  }
});

test('pocketing: a ball aimed at the jaw point is rejected', () => {
  const pk = P.TABLE.pockets[1];        // side pocket, aim at the left point
  const tx = L / 2 - P.SIDE_MOUTH / 2 - 0.004, ty = 0;
  const b = table([[0, tx, 0.5]]);
  const s = P.simulate(b, { dx: 0, dy: -1, speed: 1.5 }, { record: false });
  assert.equal(s.pocketed.length, 0, JSON.stringify(s.pocketed));
  assert.ok(pk);
});

test('pocketing: a ball rolling along the rail passes the side pocket', () => {
  const b = table([[0, 0.3, R + 0.0001]]);
  const s = until(new P.Sim(b, { dx: 1, dy: 0, speed: 1.4, b: 0.4 }, { record: false }), (sim) => sim.px[0] > L / 2 + 0.2 || sim.done);
  assert.ok(!s.pocketed.some((e) => e.p === 1), 'fell in side pocket');
  assert.ok(s.on[0] === 1);
});

test('containment: 300 random shots, every ball ends pocketed or on the cloth with no overlaps', () => {
  const r = P.rng(1234);
  let fallbacks = 0;
  for (let k = 0; k < 300; k++) {
    const b = P.emptyBalls();
    for (let i = 0; i < 16; i++) {
      if (r() < 0.4 && i) continue;
      for (let tries = 0; tries < 50; tries++) {
        const x = R + r() * (L - 2 * R), y = R + r() * (W - 2 * R);
        if (P.canPlace(b, i, x, y)) { b.x[i] = x; b.y[i] = y; b.on[i] = 1; break; }
      }
    }
    if (!b.on[0]) continue;
    const a = r() * 6.283185307179586;
    const shot = { dx: Math.cos(a), dy: Math.sin(a), speed: 0.3 + r() * 8.2, a: (r() - 0.5) * 0.8, b: (r() - 0.5) * 0.8 };
    const s = P.simulate(b, shot, { record: false });
    fallbacks += s.fallbacks;
    assert.ok(s.t < 60, 'shot did not finish');
    const f = s.finalBalls();
    for (let i = 0; i < 16; i++) {
      if (!f.on[i]) continue;
      const onCloth = f.x[i] >= R - 1e-6 && f.x[i] <= L - R + 1e-6 && f.y[i] >= R - 1e-6 && f.y[i] <= W - R + 1e-6;
      assert.ok(onCloth || hangingInJaws(f.x[i], f.y[i]), `ball ${i} off cloth in shot ${k}: ${f.x[i]}, ${f.y[i]}`);
      for (let j = i + 1; j < 16; j++) {
        if (!f.on[j]) continue;
        const d = Math.hypot(f.x[i] - f.x[j], f.y[i] - f.y[j]);
        assert.ok(d > 2 * R - 0.002, `balls ${i},${j} overlap ${2 * R - d} in shot ${k}`);
      }
    }
  }
  assert.ok(fallbacks <= 3, `safety fallbacks used ${fallbacks} times`);
});

test('break: a full-power break is legal (4+ balls to a cushion or a pot) for every rack', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const { b, shot } = breakShot(seed * 101);
    const o = P.simulate(b, shot, { record: false }).outcome();
    const pots = o.pocketed.filter((p) => p.b > 0).length;
    assert.ok(pots > 0 || o.cushionBalls.length >= 4, `seed ${seed}`);
    assert.ok(o.first > 0, 'cue ball hit the rack');
  }
});

test('side spin alone decays to zero and does not bend a straight path', () => {
  const s = P.simulate(table([[0, 0.5, 0.5]]), { dx: 1, dy: 0, speed: 0.8, a: 0.5 }, { record: false });
  const f = s.finalBalls();
  assert.ok(Math.abs(f.y[0] - 0.5) < 1e-9);
  assert.equal(s.wz[0], 0);
});
