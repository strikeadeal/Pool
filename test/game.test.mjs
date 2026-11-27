// Complete games, computer vs computer, through the real physics and real rules.
// Fails if a game stalls, the state becomes inconsistent, or a rule invariant breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Rl from '../src/js/rules.js';
import * as P from '../src/js/physics.js';
import { decideSync, chooseDecision } from '../src/js/ai.js';

export function playGame(seed, levels, maxShots = 400, callEight = true) {
  let s = Rl.newGame({ mode: 'cpu', players: [{ name: 'A', cpu: levels[0] }, { name: 'B', cpu: levels[1] }], seed, callEight });
  const log = [];
  for (let n = 0; n < maxShots && s.phase !== 'over'; n++) {
    if (s.phase === 'decision') { s = Rl.decide(s, chooseDecision(s)); continue; }
    const lvl = s.players[s.turn].cpu;
    const d = decideSync(s, lvl, seed * 1000 + n);
    if (d.place) assert.ok(Rl.placeCueBall(s, d.place[0], d.place[1]), 'AI placement must be legal');
    if (Rl.needsCall(s)) assert.ok(d.called != null && d.called >= 0 && d.called < 6, 'must call the 8');
    const fixed = Rl.eightPocket(s);
    if (Rl.needsCall(s) && fixed != null) assert.equal(d.called, fixed, 'the computer plays the 8 into its fixed pocket');
    s.called = d.called;
    const fixedBefore = (s.eightPocket || [null, null]).slice();
    const before = s.balls.on.slice();
    const sim = P.simulate(s.balls, d.shot, { record: false });
    const { state, report } = Rl.judge(s, sim.outcome(), sim.finalBalls());
    // invariants
    for (let i = 1; i < 16; i++) if (!before[i]) assert.equal(state.balls.on[i], 0, 'potted balls never come back (except a re-spotted 8)');
    if (state.phase !== 'over' && state.phase !== 'decision') assert.equal(state.balls.on[0], 1, 'cue ball is on the table between shots');
    if (state.groups[0]) assert.notEqual(state.groups[0], state.groups[1]);
    if (report.fouls.length && state.phase === 'play') assert.equal(state.ballInHand, 'anywhere');
    for (const p of [0, 1]) if (fixedBefore[p] != null) assert.equal(state.eightPocket[p], fixedBefore[p], 'a fixed pocket never changes');
    log.push({ shooter: s.turn, fouls: report.fouls, potted: report.potted, ballInHand: s.phase === 'play' && s.ballInHand === 'anywhere' });
    s = state;
  }
  return { s, log };
}

test('complete computer-vs-computer games finish with a winner and consistent state', () => {
  const results = [];
  for (let seed = 1; seed <= 6; seed++) {
    const { s, log } = playGame(seed, [2, 2]);
    assert.equal(s.phase, 'over', `game ${seed} did not finish in 400 shots`);
    assert.ok(s.winner === 0 || s.winner === 1);
    assert.ok(s.winReason.length > 0);
    results.push(log.length);
  }
  assert.ok(results.every((n) => n > 3));
});

test('a complete game with 8-ball calling off finishes with a winner', () => {
  const { s } = playGame(7, [2, 2], 400, false);
  assert.equal(s.phase, 'over'); assert.ok(s.winner === 0 || s.winner === 1);
  assert.equal(s.callEight, false);
});

test('skill matters: Hard beats Easy far more often than not', () => {
  let hard = 0, games = 0;
  for (let seed = 101; seed <= 110; seed++) {
    const swap = seed % 2 === 0;                  // alternate who breaks
    const { s } = playGame(seed, swap ? [1, 3] : [3, 1]);
    if (s.phase !== 'over') continue;
    games++;
    if (s.winner === (swap ? 1 : 0)) hard++;
  }
  assert.ok(games >= 8, `only ${games} games finished`);
  assert.ok(hard / games >= 0.7, `Hard won ${hard}/${games}`);
});

test('with ball in hand the computer always hits a legal ball first', () => {
  // It places the cue ball itself, so missing everything or hitting the wrong ball first is never forced.
  const bad = [];
  for (let seed = 1; seed <= 12; seed++) {
    for (const lvl of [1, 2]) {
      const { log } = playGame(seed, [lvl, lvl]);
      for (const e of log) if (e.ballInHand && e.fouls.some((f) => f === 'noHit' || f === 'wrongFirst')) bad.push(`L${lvl} seed ${seed}: ${e.fouls}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('on the 8, a safety or direct hit calls the pocket the 8 is heading for', () => {
  // Only the 8 is left, frozen in the top-left jaw. Calling a fixed pocket made a direct hit an
  // "uncalled" loss, so the computer fouled on purpose instead, turn after turn.
  const s = Rl.newGame({ mode: 'cpu', players: [{ name: 'A', cpu: 1 }, { name: 'B', cpu: 1 }], seed: 5 });
  for (let i = 1; i < 16; i++) s.balls.on[i] = i === 8 ? 1 : 0;
  s.balls.x[8] = 0.0563; s.balls.y[8] = 0.9738;
  s.phase = 'play'; s.groups = ['S', 'T']; s.turn = 1; s.ballInHand = 'anywhere';
  for (const lvl of [1, 2, 3]) {
    const d = decideSync(s, lvl, 77);
    assert.equal(d.called, 5, `level ${lvl} called pocket ${d.called}, not top-left`);
  }
});

test('on the 8 with a fixed pocket, the computer never pots the 8 elsewhere', () => {
  // The 8 hangs in the bottom-left jaw, an easy pot there, but this player's pocket is the top-right.
  const s = Rl.newGame({ mode: 'cpu', players: [{ name: 'A', cpu: 1 }, { name: 'B', cpu: 1 }], seed: 5 });
  for (let i = 1; i < 16; i++) s.balls.on[i] = i === 8 ? 1 : 0;
  s.balls.x[8] = 0.08; s.balls.y[8] = 0.08;
  s.balls.x[0] = 0.5; s.balls.y[0] = 0.5;
  s.phase = 'play'; s.groups = ['S', 'T']; s.turn = 1; s.ballInHand = null; s.eightPocket = [null, 3];
  for (const lvl of [1, 2, 3]) {
    const d = decideSync(s, lvl, 77);
    assert.equal(d.called, 3, `level ${lvl} called ${d.called}`);
    const sim = P.simulate(s.balls, d.shot, { record: false });
    const { state } = Rl.judge({ ...s, called: d.called }, sim.outcome(), sim.finalBalls());
    assert.notEqual(state.winner, 0, `level ${lvl} potted the 8 in the wrong pocket and lost`);
  }
});

test('a first shot at the 8 that leaves it on the table fixes a pocket near it, not a default', () => {
  // The 8 among the opponent's solids, no clean pot (found by search: every level leaves the 8 up).
  const s = Rl.newGame({ mode: 'cpu', players: [{ name: 'A', cpu: 1 }, { name: 'B', cpu: 1 }], seed: 9 });
  const at = [[1.404, 0.0844], [0.9076, 0.1167], [0.9651, 0.194], [0.5449, 0.5418], [0.4164, 0.1244], [1.3919, 0.4743], [1.5422, 0.833], [0.6584, 0.6646], [0.5891, 0.6482]];
  for (let i = 0; i < 16; i++) { s.balls.on[i] = i <= 8 ? 1 : 0; if (i <= 8) [s.balls.x[i], s.balls.y[i]] = at[i]; }
  s.phase = 'play'; s.groups = ['S', 'T']; s.turn = 1; s.ballInHand = null;
  let checked = 0;
  for (const lvl of [1, 2, 3]) {
    const d = decideSync(s, lvl, 31);
    const sim = P.simulate(s.balls, d.shot, { record: false });
    if (sim.outcome().pocketed.some((q) => q.b === 8)) continue;   // it potted it: any correct call is fine
    const fb = sim.finalBalls();
    const near = [0, 1, 2, 3, 4, 5].map((p) => [p, Math.hypot(P.TABLE.pockets[p].mx - fb.x[8], P.TABLE.pockets[p].my - fb.y[8])]).sort((a, b) => a[1] - b[1])[0][0];
    assert.equal(d.called, near, `level ${lvl} fixed pocket ${d.called}, the 8 stopped nearest ${near}`);
    checked++;
  }
  assert.ok(checked > 0, 'the position must leave the 8 up for some level');
});
