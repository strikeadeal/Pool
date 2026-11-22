import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeLS { constructor() { this.m = new Map(); } getItem(k) { return this.m.has(k) ? this.m.get(k) : null; } setItem(k, v) { this.m.set(k, String(v)); } removeItem(k) { this.m.delete(k); } }
globalThis.localStorage = new FakeLS();
// Two "tabs" = two independent module instances sharing one localStorage.
const tabA = await import('../src/js/storage.js?a');
const tabB = await import('../src/js/storage.js?b');

test('save/load round trip with versioned key and rev', () => {
  assert.equal(tabA.save('game', { n: 1 }), 'ok');
  assert.deepEqual(tabA.load('game'), { n: 1 });
  const raw = JSON.parse(localStorage.getItem('baize.v1.game'));
  assert.equal(raw.schema, 1); assert.equal(raw.rev, 1); assert.ok(raw.at > 0);
});

test('a stale tab cannot overwrite newer data; it gets a conflict and adopts the newer state', () => {
  tabA.load('game'); tabB.load('game');
  assert.equal(tabA.save('game', { n: 2 }), 'ok');
  assert.equal(tabB.save('game', { n: 99 }), 'conflict');
  assert.deepEqual(tabB.load('game'), { n: 2 });
  assert.equal(tabB.save('game', { n: 3 }), 'ok');
  assert.deepEqual(tabA.load('game'), { n: 3 });
});

test('older code never writes over data saved by a newer schema', () => {
  localStorage.setItem('baize.v1.game', JSON.stringify({ schema: 2, rev: 50, data: { future: true } }));
  tabA.load('game');
  assert.equal(tabA.save('game', { n: 4 }), 'readonly');
  assert.deepEqual(JSON.parse(localStorage.getItem('baize.v1.game')).data, { future: true });
  assert.equal(tabA.update('stats', (d) => d, {}) !== undefined, true);
});

test('update() is read-modify-write on the latest value, so two tabs never lose a record', () => {
  localStorage.removeItem('baize.v1.stats');
  tabA.update('stats', (d) => ({ wins: d.wins + 1 }), { wins: 0 });
  tabB.update('stats', (d) => ({ wins: d.wins + 1 }), { wins: 0 });
  assert.deepEqual(tabA.load('stats'), { wins: 2 });
});

test('corrupt data falls back instead of throwing', () => {
  localStorage.setItem('baize.v1.settings', '{nope');
  assert.deepEqual(tabA.load('settings', { a: 1 }), { a: 1 });
});
