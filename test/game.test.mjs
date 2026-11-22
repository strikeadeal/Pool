// Complete games, computer vs computer, through the real physics and real rules.
// Fails if a game stalls, the state becomes inconsistent, or a rule invariant breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Rl from '../src/js/rules.js';
import * as P from '../src/js/physics.js';
import { decideSync, chooseDecision } from '../src/js/ai.js';

export function playGame(seed, levels, maxShots = 400) {
  let s = Rl.newGame({ mode: 'cpu', players: [{ name: 'A', cpu: levels[0] }, { name: 'B', cpu: levels[1] }], seed });
  const log = [];
  for (let n = 0; n < maxShots && s.phase !== 'over'; n++) {
    if (s.phase === 'decision') { s = Rl.decide(s, chooseDecision(s)); continue; }
    const lvl = s.players[s.turn].cpu;
    const d = decideSync(s, lvl, seed * 1000 + n);
    if (d.place) assert.ok(Rl.placeCueBall(s, d.place[0], d.place[1]), 'AI placement must be legal');
    if (Rl.needsCall(s)) assert.ok(d.called != null && d.called >= 0 && d.called < 6, 'must call the 8');
    s.called = d.called;
    const before = s.balls.on.slice();
    const sim = P.simulate(s.balls, d.shot, { record: false });
    const { state, report } = Rl.judge(s, sim.outcome(), sim.finalBalls());
    // invariants
    for (let i = 1; i < 16; i++) if (!before[i]) assert.equal(state.balls.on[i], 0, 'potted balls never come back (except a re-spotted 8)');
    if (state.phase !== 'over' && state.phase !== 'decision') assert.equal(state.balls.on[0], 1, 'cue ball is on the table between shots');
    if (state.groups[0]) assert.notEqual(state.groups[0], state.groups[1]);
    if (report.fouls.length && state.phase === 'play') assert.equal(state.ballInHand, 'anywhere');
    log.push({ shooter: s.turn, fouls: report.fouls, potted: report.potted });
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
