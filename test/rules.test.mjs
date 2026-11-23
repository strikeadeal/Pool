import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Rl from '../src/js/rules.js';
import * as P from '../src/js/physics.js';

const players = [{ name: 'Ana' }, { name: 'Ben' }];
const game = () => Rl.newGame({ mode: 'pvp', players, seed: 99 });

// Build a synthetic shot result: pocketed = [[ball, pocket], ...]
function shot(s, { first = -1, rail = true, cushionBalls = [], pocketed = [] }) {
  const balls = P.cloneBalls(s.balls);
  for (const [b] of pocketed) balls.on[b] = 0;
  return Rl.judge(s, { first, cushionAfterFirst: rail, cushionBalls, pocketed: pocketed.map(([b, p]) => ({ b, p })) }, balls);
}
// A mid-game state: groups assigned, it's Ana's turn.
function midGame({ anaGroup = 'S', clear = [] } = {}) {
  const s = game();
  s.phase = 'play'; s.ballInHand = null; s.turn = 0;
  s.groups = [anaGroup, anaGroup === 'S' ? 'T' : 'S'];
  for (const b of clear) s.balls.on[b] = 0;
  return s;
}
const SOLIDS = [1, 2, 3, 4, 5, 6, 7], STRIPES = [9, 10, 11, 12, 13, 14, 15];

test('break: pot = legal, breaker continues, table stays open', () => {
  const { state, report } = shot(game(), { first: 1, pocketed: [[3, 0], [9, 2]], cushionBalls: [] });
  assert.equal(state.phase, 'play'); assert.equal(state.turn, 0);
  assert.deepEqual(state.groups, [null, null]);
  assert.equal(state.ballInHand, null);
  assert.equal(report.title, 'Good break: potted 3, 9');   // names the balls, not just a count
});

test('break: four balls to a cushion without a pot is legal; turn passes', () => {
  const { state } = shot(game(), { first: 1, cushionBalls: [2, 5, 9, 12] });
  assert.equal(state.phase, 'play'); assert.equal(state.turn, 1);
});

test('break: fewer than four to a cushion and no pot is illegal; opponent chooses', () => {
  const { state } = shot(game(), { first: 1, cushionBalls: [2, 5, 9] });
  assert.equal(state.phase, 'decision');
  assert.equal(state.decision.who, 1);
  assert.match(state.decision.reason, /fewer than four balls reached a cushion/);   // shown with the choice
  assert.deepEqual(Rl.decisionOptions(state).map((o) => o.id), ['accept', 'rerackSelf', 'rerackOther']);
  const a = Rl.decide(state, 'accept');
  assert.equal(a.turn, 1); assert.equal(a.phase, 'play');
  const b = Rl.decide(state, 'rerackSelf');
  assert.equal(b.phase, 'break'); assert.equal(b.turn, 1); assert.equal(b.rackNo, 2);
  const c = Rl.decide(state, 'rerackOther');
  assert.equal(c.turn, 0); assert.equal(c.ballInHand, 'kitchen');
});

test('break: scratch is a foul, ball in hand anywhere for the opponent, potted balls stay down', () => {
  const { state, report } = shot(game(), { first: 1, pocketed: [[4, 2], [0, 3]] });
  assert.equal(state.turn, 1); assert.equal(state.ballInHand, 'anywhere');
  assert.equal(state.balls.on[4], 0); assert.equal(state.balls.on[0], 1);
  assert.deepEqual(state.groups, [null, null]);
  assert.deepEqual(report.fouls, ['scratch']);
});

test('break: 8 potted lets the breaker re-spot or re-break; with a scratch the opponent chooses', () => {
  const r1 = shot(game(), { first: 1, pocketed: [[8, 3]] });
  assert.equal(r1.state.decision.kind, 'eightBreak'); assert.equal(r1.state.decision.who, 0);
  const spot = Rl.decide(r1.state, 'spot');
  assert.equal(spot.balls.on[8], 1); assert.equal(spot.turn, 0); assert.equal(spot.phase, 'play');
  assert.equal(Rl.decide(r1.state, 'rebreak').phase, 'break');
  const r2 = shot(game(), { first: 1, pocketed: [[8, 3], [0, 1]] });
  assert.equal(r2.state.decision.kind, 'eightBreakScratch'); assert.equal(r2.state.decision.who, 1);
  const s2 = Rl.decide(r2.state, 'spot');
  assert.equal(s2.turn, 1); assert.equal(s2.ballInHand, 'anywhere'); assert.equal(s2.balls.on[8], 1);
});

test('open table: first legally potted ball sets the groups', () => {
  const s = game(); s.phase = 'play'; s.ballInHand = null;
  const { state, report } = shot(s, { first: 11, pocketed: [[11, 0]] });
  assert.deepEqual(state.groups, ['T', 'S']); assert.equal(state.turn, 0);
  assert.ok(report.groups);
});

test('open table: with balls of both groups potted, the first to drop decides', () => {
  const s = game(); s.phase = 'play'; s.ballInHand = null;
  const { state } = shot(s, { first: 2, pocketed: [[2, 1], [12, 0]] });
  assert.deepEqual(state.groups, ['S', 'T']);
});

test('open table: hitting the 8 first is a foul', () => {
  const s = game(); s.phase = 'play'; s.ballInHand = null;
  const { state, report } = shot(s, { first: 8, pocketed: [[3, 0]] });
  assert.deepEqual(report.fouls, ['eightFirstOpen']);
  assert.equal(state.turn, 1); assert.equal(state.ballInHand, 'anywhere');
  assert.deepEqual(state.groups, [null, null], 'no groups from a foul');
  assert.equal(state.balls.on[3], 0, 'balls potted on a foul stay down');
});

test('fouls: wrong ball first, no cushion, no hit, scratch', () => {
  let r = shot(midGame(), { first: 12, pocketed: [] });
  assert.deepEqual(r.report.fouls, ['wrongFirst']); assert.equal(r.report.wrongBall, 12);
  assert.match(r.report.title, /stripe first/);
  r = shot(midGame(), { first: 3, rail: false });
  assert.deepEqual(r.report.fouls, ['noRail']);
  r = shot(midGame(), { first: -1, rail: false });
  assert.deepEqual(r.report.fouls, ['noHit']);
  r = shot(midGame(), { first: 3, pocketed: [[3, 2], [0, 5]] });
  assert.deepEqual(r.report.fouls, ['scratch']);
  assert.equal(r.state.turn, 1); assert.equal(r.state.ballInHand, 'anywhere');
  assert.equal(r.state.balls.on[3], 0);
});

test('a pot counts as satisfying the cushion rule', () => {
  const r = shot(midGame(), { first: 3, rail: false, pocketed: [[3, 2]] });
  assert.deepEqual(r.report.fouls, []); assert.equal(r.state.turn, 0);
});

test('turn: continues on own pot, passes on opponent-only pot without a foul', () => {
  let r = shot(midGame(), { first: 3, pocketed: [[3, 2], [12, 1]] });
  assert.equal(r.state.turn, 0);
  r = shot(midGame(), { first: 3, pocketed: [[12, 1]] });
  assert.equal(r.state.turn, 1); assert.equal(r.state.ballInHand, null); assert.deepEqual(r.report.fouls, []);
});

test('8 ball: legal pot in the called pocket wins', () => {
  const s = midGame({ clear: SOLIDS }); s.called = 3;
  assert.ok(Rl.onEight(s)); assert.ok(Rl.needsCall(s));
  assert.deepEqual(Rl.legalTargets(s), [8]);
  const { state } = shot(s, { first: 8, pocketed: [[8, 3]] });
  assert.equal(state.phase, 'over'); assert.equal(state.winner, 0);
});

test('8 ball: wrong pocket, uncalled, on a foul, or early all lose', () => {
  let s = midGame({ clear: SOLIDS }); s.called = 3;
  assert.equal(shot(s, { first: 8, pocketed: [[8, 0]] }).state.winner, 1, 'wrong pocket');
  s = midGame({ clear: SOLIDS }); s.called = null;
  assert.equal(shot(s, { first: 8, pocketed: [[8, 0]] }).state.winner, 1, 'uncalled');
  s = midGame({ clear: SOLIDS }); s.called = 0;
  assert.equal(shot(s, { first: 8, pocketed: [[8, 0], [0, 2]] }).state.winner, 1, 'scratch with the 8');
  s = midGame({ clear: [1, 2, 3, 4, 5, 6] }); s.called = 0;
  const r = shot(s, { first: 7, pocketed: [[7, 2], [8, 0]] });
  assert.equal(r.state.winner, 1, '8 on the same shot as the last group ball');
  s = midGame(); s.called = 0;
  assert.equal(shot(s, { first: 3, pocketed: [[8, 0]] }).state.winner, 1, '8 early');
});

test('8 ball: with calling off, the 8 in any pocket wins; fouls and early 8s still lose', () => {
  const off = (o) => { const s = midGame(o); s.callEight = false; return s; };
  let s = off({ clear: SOLIDS });
  assert.ok(Rl.onEight(s)); assert.equal(Rl.needsCall(s), false);
  let r = shot(s, { first: 8, pocketed: [[8, 5]] });
  assert.equal(r.state.winner, 0); assert.equal(r.state.winReason, 'Ana potted the 8.');
  s = off({ clear: SOLIDS });
  assert.equal(shot(s, { first: 8, pocketed: [[8, 0], [0, 2]] }).state.winner, 1, 'scratch with the 8');
  s = off();
  assert.equal(shot(s, { first: 3, pocketed: [[8, 0]] }).state.winner, 1, '8 early');
  assert.match(Rl.describe(off()), /8-ball: any pocket\./);
});

test('8 ball: calling defaults on, and a saved game without the field still calls', () => {
  assert.equal(game().callEight, true);
  const s = midGame({ clear: SOLIDS }); delete s.callEight; s.called = 3;
  assert.ok(Rl.needsCall(s));
  assert.equal(shot(s, { first: 8, pocketed: [[8, 0]] }).state.winner, 1);
});

test('8 ball: scratching while on the 8 without potting it is only a foul', () => {
  const s = midGame({ clear: SOLIDS }); s.called = 3;
  const { state } = shot(s, { first: 8, pocketed: [[0, 2]] });
  assert.equal(state.phase, 'play'); assert.equal(state.turn, 1); assert.equal(state.ballInHand, 'anywhere');
});

test('8 ball: on the 8 you must hit the 8 first', () => {
  const s = midGame({ clear: SOLIDS }); s.called = 3;
  const { report } = shot(s, { first: 12, pocketed: [] });
  assert.deepEqual(report.fouls, ['wrongFirst']);
  assert.match(report.title, /had to hit the 8/);
});

test('ball in hand placement respects other balls and the kitchen', () => {
  const s = game();
  assert.equal(s.ballInHand, 'kitchen');
  assert.ok(!Rl.placeCueBall(s, P.HEAD_X + 0.1, 0.5), 'not past the head string on the break');
  assert.ok(Rl.placeCueBall(s, P.HEAD_X - 0.1, 0.3));
  const m = midGame(); m.ballInHand = 'anywhere';
  assert.ok(!Rl.placeCueBall(m, m.balls.x[5], m.balls.y[5]), 'not on top of a ball');
  assert.ok(Rl.placeCueBall(m, 1.0, 0.2));
});

test('practice: no fouls, always ball in hand, rack refills when cleared', () => {
  const s = Rl.newGame({ mode: 'practice', players: [{ name: 'Me' }], seed: 5 });
  for (let i = 1; i < 16; i++) if (i !== 4) s.balls.on[i] = 0;
  const { state, report } = shot(s, { first: 4, pocketed: [[4, 0], [0, 1]] });
  assert.equal(report.fouls.length, 0);
  assert.equal(state.ballInHand, 'anywhere');
  assert.equal(state.rackNo, 2);
  assert.equal(state.balls.on.filter(Boolean).length, 16);
});

test('describe() reads groups and turn in plain words', () => {
  const s = midGame({ clear: [1, 2] });
  const txt = Rl.describe(s);
  assert.match(txt, /Ana to shoot/); assert.match(txt, /Ana has solids: 3, 4, 5, 6, 7 left/); assert.match(txt, /Ben has stripes/);
});
