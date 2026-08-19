// test/resultfx.test.js
const test = require('node:test');
const assert = require('node:assert');
const { selectedEstimate, compareNote } = require('../src/webui/resultfx');

test('selectedEstimate sums selected scanned items only', () => {
  const items = [
    { id: 'user_temp', sizeBytes: 1024 },
    { id: 'win_temp', sizeBytes: 2048 },
    { id: 'broken', sizeBytes: 4096, error: 'scan failed' },
  ];
  assert.equal(selectedEstimate(items, ['user_temp', 'broken', 'missing']), 1024);
});

test('selectedEstimate guards invalid sizes and input shape', () => {
  assert.equal(selectedEstimate(null, ['x']), 0);
  assert.equal(selectedEstimate([{ id: 'x', sizeBytes: -1 }, { id: 'y', sizeBytes: '512' }], ['x', 'y']), 512);
});

test('compareNote describes exact, lower and higher actual release', () => {
  const fmt = n => n + ' B';
  assert.equal(compareNote(100, 100, fmt), '实际释放按所选盘前后差值统计 · 与扫描预估一致');
  assert.equal(compareNote(100, 40, fmt), '实际释放按所选盘前后差值统计 · 实际少释放 60 B');
  assert.equal(compareNote(100, 130, fmt), '实际释放按所选盘前后差值统计 · 实际多释放 30 B');
});
