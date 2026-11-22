// 8-ball rules (WPA-based; deviations listed in DECISIONS.md §2). Pure functions over
// plain-JSON game state, so the same code runs in the app, the AI and the tests.
import { rack, spotBall, canPlace, cloneBalls, HEAD_X, L, W, R } from './physics.js';

export const POCKET_NAMES = ['bottom-left', 'bottom side', 'bottom-right', 'top-right', 'top side', 'top-left'];

export const groupOf = (n) => (n === 0 ? null : n < 8 ? 'S' : n === 8 ? '8' : 'T');
export const groupName = (g) => (g === 'S' ? 'solids' : g === 'T' ? 'stripes' : 'open table');
const other = (g) => (g === 'S' ? 'T' : 'S');

export function remaining(balls, g) {
  let n = 0;
  for (let i = 1; i < 16; i++) if (balls.on[i] && groupOf(i) === g) n++;
  return n;
}

// Next rack seed: deterministic from the previous one.
export const nextSeed = (s) => (Math.imul(s ^ 0x9e3779b9, 0x85ebca6b) >>> 0) || 1;

// mode: 'pvp' | 'cpu' | 'practice'. players: [{name, cpu: 0|1|2|3}] (cpu level 0 = human)
// callEight: the 8 must go in a called pocket (WPA). false = any pocket wins.
export function newGame({ mode, players, seed, breaker = 0, callEight = true }) {
  const s = {
    mode,
    callEight,
    players: players.map((p) => ({ name: p.name, cpu: p.cpu || 0 })),
    seed,
    rackNo: 1,
    balls: rack(seed),
    turn: breaker,
    breaker,
    groups: [null, null],
    phase: mode === 'practice' ? 'play' : 'break',
    ballInHand: mode === 'practice' ? 'anywhere' : 'kitchen',
    called: null,
    decision: null,
    winner: null,
    winReason: '',
    shotNo: 0,
    visit: 0,
    bestRun: [0, 0],
    potted: [0, 0],
    fouls: [0, 0],
    log: [],
  };
  return s;
}

const clone = (s) => JSON.parse(JSON.stringify(s));
// Text helpers: the solo player is called "You", so verbs and pronouns follow the name.
export const says = (n, third, second) => (n === 'You' ? `You ${second}` : `${n} ${third}`);
export const toShoot = (n) => (n === 'You' ? 'Your shot.' : `${n} to shoot.`);

// Whose turn is it at the 8? (own group cleared, or the rare open table with an empty group)
export function onEight(s, p = s.turn) {
  const g = s.groups[p];
  if (g) return remaining(s.balls, g) === 0;
  return remaining(s.balls, 'S') === 0 || remaining(s.balls, 'T') === 0;
}

// Which balls may the shooter legally hit first?
export function legalTargets(s, p = s.turn) {
  if (s.mode === 'practice') return [...Array(15).keys()].map((i) => i + 1).filter((i) => s.balls.on[i]);
  const out = [];
  const g = s.groups[p];
  const eight = onEight(s, p);
  for (let i = 1; i < 16; i++) {
    if (!s.balls.on[i]) continue;
    if (i === 8) { if (eight) out.push(i); continue; }
    if (!g || (!eight && groupOf(i) === g)) out.push(i);
  }
  return out;
}

// Saved games from before the option have no callEight field: they keep calling.
export const needsCall = (s) => s.mode !== 'practice' && s.callEight !== false && s.phase === 'play' && onEight(s);

// Put the cue ball somewhere legal for ball in hand (used after a scratch).
export function defaultCuePlacement(s) {
  const b = s.balls;
  const candidates = [[HEAD_X - 0.12, W / 2], [HEAD_X - 0.12, W / 2 + 0.15], [HEAD_X - 0.12, W / 2 - 0.15], [HEAD_X - 0.3, W / 2], [L / 2, W / 2]];
  for (const [x, y] of candidates) if (canPlace(b, 0, x, y, s.ballInHand === 'kitchen')) return [x, y];
  for (let x = R + 0.01; x < L - R; x += 0.02) for (let y = R + 0.01; y < W - R; y += 0.02) if (canPlace(b, 0, x, y, s.ballInHand === 'kitchen')) return [x, y];
  return [HEAD_X - 0.12, W / 2];
}

function giveBallInHand(s, where) {
  s.ballInHand = where;
  if (!s.balls.on[0] || !canPlace(s.balls, 0, s.balls.x[0], s.balls.y[0], where === 'kitchen')) {
    s.balls.on[0] = 0;
    const [x, y] = defaultCuePlacement(s);
    s.balls.x[0] = x; s.balls.y[0] = y; s.balls.on[0] = 1;
  }
}

export function placeCueBall(s, x, y) {
  if (!s.ballInHand || !canPlace(s.balls, 0, x, y, s.ballInHand === 'kitchen')) return false;
  s.balls.x[0] = x; s.balls.y[0] = y; s.balls.on[0] = 1;
  return true;
}

function rerack(s, breaker) {
  s.seed = nextSeed(s.seed);
  s.rackNo++;
  s.balls = rack(s.seed);
  s.groups = [null, null];
  s.phase = 'break';
  s.ballInHand = 'kitchen';
  s.breaker = breaker; s.turn = breaker;
  s.called = null; s.decision = null; s.visit = 0;
}

const FOUL_TEXT = {
  noHit: 'the cue ball didn’t hit a ball',
  scratch: 'scratch, the cue ball was potted',
  noRail: 'no ball hit a cushion after contact',
  eightFirstOpen: 'the 8 can’t be hit first on an open table',
};
function wrongFirstText(s, first) {
  if (onEight(s)) return `hit the ${first} first, you had to hit the 8`;
  const g = groupOf(first);
  return `hit ${first === 8 ? 'the 8' : g === 'S' ? 'a solid' : 'a stripe'} first`;
}

// Apply a finished shot. outcome = Sim.outcome(); balls = Sim.finalBalls().
// Returns { state, report } where report explains what happened for the banner/VoiceOver.
export function judge(prev, outcome, balls) {
  const s = clone(prev);
  s.balls = cloneBalls(balls);
  s.shotNo++;
  const me = s.turn, opp = 1 - me;
  const names = s.players.map((p) => p.name);
  const potted = outcome.pocketed.map((p) => p.b);
  const scratch = potted.includes(0);
  const eightIdx = outcome.pocketed.findIndex((p) => p.b === 8);
  const objPotted = potted.filter((b) => b > 0 && b !== 8);
  const report = { shooter: me, potted: potted.filter((b) => b > 0), fouls: [], foulText: '', first: outcome.first, title: '', detail: '', turnChange: false, wrongBall: -1 };
  s.called = null;

  // ---------- Practice: no rules ----------
  if (s.mode === 'practice') {
    giveBallInHand(s, 'anywhere');
    if (remaining(s.balls, 'S') + remaining(s.balls, 'T') === 0 && !s.balls.on[8]) {
      rerack(s, 0); s.phase = 'play'; s.ballInHand = 'anywhere';
      report.title = 'Table cleared'; report.detail = 'New rack.';
    } else if (report.potted.length) report.title = `Potted ${report.potted.join(', ')}`;
    return { state: s, report };
  }

  // ---------- Break ----------
  if (prev.phase === 'break') {
    s.phase = 'play';
    const legal = objPotted.length > 0 || eightIdx >= 0 || outcome.cushionBalls.length >= 4;
    if (!legal) {
      s.phase = 'decision';
      s.turn = opp;
      s.decision = { kind: 'illegalBreak', who: opp, scratch, eight: eightIdx >= 0 };
      report.title = 'Illegal break';
      report.detail = `No ball potted and fewer than four balls reached a cushion. ${says(names[opp], 'chooses', 'choose')} what happens next.`;
      report.turnChange = true;
      s.fouls[me] += scratch ? 1 : 0;
      return { state: s, report };
    }
    if (eightIdx >= 0) {
      s.phase = 'decision';
      if (scratch) {
        s.turn = opp;
        s.decision = { kind: 'eightBreakScratch', who: opp };
        report.title = '8 potted on the break, with a scratch';
        report.detail = `${says(names[opp], 'chooses', 'choose')}: re-spot the 8 and take ball in hand, or re-rack and break.`;
        report.turnChange = true;
      } else {
        s.decision = { kind: 'eightBreak', who: me };
        report.title = '8 potted on the break';
        report.detail = `${says(names[me], 'chooses', 'choose')}: re-spot the 8 and keep shooting, or re-break.`;
      }
      return { state: s, report };
    }
    if (scratch) {
      report.fouls.push('scratch');
      s.fouls[me]++;
      s.turn = opp; s.visit = 0;
      giveBallInHand(s, 'anywhere');
      report.title = 'Foul: scratch on the break';
      report.detail = `${says(names[opp], 'has', 'have')} ball in hand. The table is open.`;
      report.turnChange = true;
      return { state: s, report };
    }
    s.ballInHand = null;
    s.potted[me] += objPotted.length;
    if (objPotted.length) {
      s.visit = objPotted.length;
      s.bestRun[me] = Math.max(s.bestRun[me], s.visit);
      report.title = `Good break: potted ${objPotted.length}`;
      report.detail = `${says(names[me], 'shoots', 'shoot')} again. The table is open.`;
    } else {
      s.turn = opp; s.visit = 0;
      report.title = 'Nothing potted on the break';
      report.detail = `${toShoot(names[opp])} The table is open.`;
      report.turnChange = true;
    }
    return { state: s, report };
  }

  // ---------- Normal shot ----------
  const myGroup = prev.groups[me];
  const open = !myGroup;
  const eight = onEight(prev, me);
  const first = outcome.first;
  if (first < 0) report.fouls.push('noHit');
  else if (open) { if (first === 8 && !eight) report.fouls.push('eightFirstOpen'); }
  else if (eight ? first !== 8 : groupOf(first) !== myGroup) { report.fouls.push('wrongFirst'); report.wrongBall = first; }
  if (first >= 0 && potted.length === 0 && !outcome.cushionAfterFirst) report.fouls.push('noRail');
  if (scratch) report.fouls.push('scratch');
  const fouled = report.fouls.length > 0;
  report.foulText = report.fouls.map((f) => (f === 'wrongFirst' ? wrongFirstText(prev, first) : FOUL_TEXT[f])).join('; ');

  // The 8 decides the game.
  if (eightIdx >= 0) {
    const pocket = outcome.pocketed[eightIdx].p;
    let reason = '';
    if (fouled) reason = `potted the 8 on a foul (${report.foulText})`;
    else if (!eight) reason = `potted the 8 before clearing ${names[me] === 'You' ? 'your' : 'their'} group`;
    else if (prev.callEight !== false && prev.called !== pocket) reason = prev.called == null ? 'potted the 8 without calling a pocket' : `potted the 8 in the ${POCKET_NAMES[pocket]} pocket, not the called ${POCKET_NAMES[prev.called]}`;
    s.phase = 'over';
    s.ballInHand = null;
    if (reason) {
      s.winner = opp; s.winReason = `${names[me]} ${reason}.`;
      report.title = says(names[opp], 'wins', 'win'); report.detail = s.winReason;
    } else {
      s.winner = me; s.winReason = `${names[me]} potted the 8${prev.callEight === false ? '' : ' in the called pocket'}.`;
      s.potted[me] += objPotted.length;
      report.title = says(names[me], 'wins', 'win'); report.detail = s.winReason;
    }
    return { state: s, report };
  }

  if (fouled) {
    s.fouls[me]++;
    s.turn = opp; s.visit = 0;
    giveBallInHand(s, 'anywhere');
    report.title = `Foul: ${report.foulText}`;
    report.detail = `${says(names[opp], 'has', 'have')} ball in hand.`;
    report.turnChange = true;
    return { state: s, report };
  }

  s.ballInHand = null;
  if (open && objPotted.length) {
    const g = groupOf(objPotted[0]);
    s.groups[me] = g; s.groups[opp] = other(g);
    report.groups = true;
  }
  const mine = s.groups[me];
  const myPots = objPotted.filter((b) => groupOf(b) === mine).length;
  s.potted[me] += myPots;
  if (myPots > 0) {
    s.visit += myPots;
    s.bestRun[me] = Math.max(s.bestRun[me], s.visit);
    report.title = report.groups ? `${says(names[me], 'takes', 'take')} ${groupName(mine)}` : `Potted ${objPotted.filter((b) => groupOf(b) === mine).join(', ')}`;
    report.detail = onEight(s, me) ? `${says(names[me], 'is', 'are')} on the 8.` : `${says(names[me], 'shoots', 'shoot')} again.`;
  } else {
    s.turn = opp; s.visit = 0;
    report.turnChange = true;
    report.title = objPotted.length ? `Potted the opponent’s ${objPotted.join(', ')}` : 'No pot';
    report.detail = toShoot(names[opp]);
  }
  return { state: s, report };
}

// Resolve a pending decision. choice is one of decisionOptions(s)[i].id
export function decisionOptions(s) {
  const d = s.decision;
  if (!d) return [];
  const n = s.players.map((p) => p.name);
  if (d.kind === 'illegalBreak') return [
    { id: 'accept', label: 'Play from here' },
    { id: 'rerackSelf', label: 'Re-rack, I’ll break' },
    { id: 'rerackOther', label: `Re-rack, ${n[1 - d.who]} breaks again` },
  ];
  if (d.kind === 'eightBreak') return [
    { id: 'spot', label: 'Re-spot the 8, keep shooting' },
    { id: 'rebreak', label: 'Re-break' },
  ];
  if (d.kind === 'eightBreakScratch') return [
    { id: 'spot', label: 'Re-spot the 8, ball in hand' },
    { id: 'rerackSelf', label: 'Re-rack, I’ll break' },
  ];
  return [];
}

export function decide(prev, choice) {
  const s = clone(prev);
  const d = s.decision;
  if (!d) return s;
  const who = d.who;
  s.decision = null;
  s.phase = 'play';
  if (d.kind === 'illegalBreak') {
    if (choice === 'accept') {
      if (d.eight) spotBall(s.balls, 8);
      s.turn = who;
      if (d.scratch) giveBallInHand(s, 'anywhere'); else s.ballInHand = null;
    } else rerack(s, choice === 'rerackSelf' ? who : 1 - who);
  } else if (d.kind === 'eightBreak') {
    if (choice === 'spot') { spotBall(s.balls, 8); s.turn = who; s.ballInHand = null; }
    else rerack(s, who);
  } else if (d.kind === 'eightBreakScratch') {
    if (choice === 'spot') { spotBall(s.balls, 8); s.turn = who; giveBallInHand(s, 'anywhere'); }
    else rerack(s, who);
  }
  return s;
}

// Plain-language summary for VoiceOver ("Table status").
export function describe(s) {
  const n = s.players.map((p) => p.name);
  if (s.mode === 'practice') {
    const left = [];
    for (let i = 1; i < 16; i++) if (s.balls.on[i]) left.push(i);
    return `Practice. Balls on the table: ${left.join(', ') || 'none'}.`;
  }
  const parts = [];
  if (s.phase === 'over') return `Game over. ${says(n[s.winner], 'won', 'won')}. ${s.winReason}`;
  parts.push(toShoot(n[s.turn]));
  if (s.phase === 'break') parts.push('Break shot, ball in hand behind the head string.');
  else if (s.ballInHand) parts.push('Ball in hand.');
  for (const p of [0, 1]) {
    const g = s.groups[p];
    if (!g) continue;
    const left = [];
    for (let i = 1; i < 16; i++) if (s.balls.on[i] && groupOf(i) === g) left.push(i);
    parts.push(`${says(n[p], 'has', 'have')} ${groupName(g)}: ${left.length ? left.join(', ') + ' left' : 'all potted, on the 8'}.`);
  }
  if (!s.groups[0] && s.phase !== 'break') parts.push('The table is open.');
  if (s.callEight === false) parts.push('8-ball: any pocket.');
  return parts.join(' ');
}
