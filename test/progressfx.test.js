// test/progressfx.test.js
const test = require('node:test');
const assert = require('node:assert');
const { stepVisual, nextQuip, fmtElapsed } = require('../src/webui/progressfx');

test('stepVisual eases toward target (converges within a few steps)', () => {
  let v = 0;
  for (let i = 0; i < 5; i++) v = stepVisual(v, 50, 0.5);
  assert.ok(v > 49, 'close to target after 5 steps');
  assert.ok(v <= 50, 'ease phase does not overshoot target');
});

test('stepVisual crawls past a stalled target up to the cap', () => {
  const v1 = stepVisual(50, 50, 1); // target stalled at visual
  assert.ok(v1 > 50, 'crawls beyond stalled target');
  assert.ok(v1 < 51, 'crawl speed ~0.4/s');
  const v2 = stepVisual(98.9, 98.9, 10);
  assert.equal(v2, 99, 'caps at 99');
});

test('stepVisual is monotonic non-decreasing for a monotonic target', () => {
  let v = 0;
  const targets = [10, 10, 10, 60, 60, 90];
  for (const t of targets) v = stepVisual(v, t, 0.5);
  assert.ok(v > 0 && v <= 90);
  let prev = 0; v = 0;
  for (const t of targets) { v = stepVisual(v, t, 0.5); assert.ok(v >= prev); prev = v; }
});

test('stepVisual clamps target above cap (real 100 handled by caller)', () => {
  const v = stepVisual(98, 100, 1);
  assert.ok(v <= 99, 'never renders beyond 99');
});

test('nextQuip cycles through list in order', () => {
  const list = ['a', 'b', 'c'];
  const r1 = nextQuip(list, 0);
  assert.deepStrictEqual(r1, { text: 'a', idx: 1 });
  const r2 = nextQuip(list, r1.idx);
  assert.deepStrictEqual(r2, { text: 'b', idx: 2 });
  const r3 = nextQuip(list, r2.idx);
  assert.deepStrictEqual(r3, { text: 'c', idx: 0 }, 'wraps to start');
});

test('nextQuip guards empty list and out-of-range idx', () => {
  assert.deepStrictEqual(nextQuip([], 0), { text: '', idx: 0 });
  assert.deepStrictEqual(nextQuip(['x'], 9), { text: 'x', idx: 0 });
});

test('fmtElapsed formats mm:ss and h:mm:ss', () => {
  assert.equal(fmtElapsed(0), '00:00');
  assert.equal(fmtElapsed(65000), '01:05');
  assert.equal(fmtElapsed(599999), '09:59', '59s999ms rounds down');
  assert.equal(fmtElapsed(3661000), '1:01:01');
  assert.equal(fmtElapsed(-5), '00:00', 'negative guarded');
});
