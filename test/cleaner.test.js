// test/cleaner.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createCleaner } = require('../src/cleaner');

function fake({ scriptResults, diag }) {
  return {
    psutil: {
      runJson: async (name, body, params) => scriptResults[name] || { ok: true, data: [] },
    },
    diagnose: diag || { diagnose: async () => ({ errorType: 'unknown', detected: [], suggestion: 'x', retryable: false }) },
  };
}

test('clean: serial execution, aggregates freed bytes', async () => {
  const cleaner = createCleaner(fake({ scriptResults: {
    'clean_entries.ps1': { ok: true, data: [
      { id: 'user_temp', ok: true, freed: 1000, error: '' },
      { id: 'win_temp', ok: true, freed: 2000, error: '' },
    ] },
  }}));
  const res = await cleaner.clean({ disk: 'C:\\', items: ['user_temp', 'win_temp'] }, () => {});
  assert.equal(res.freedTotal, 3000);
  assert.equal(res.results.length, 2);
});

test('clean: retries once on failure, then diagnoses', async () => {
  const cleaner = createCleaner(fake({
    scriptResults: { 'clean_entries.ps1': { ok: true, data: [] } },
    diag: { diagnose: async () => ({ errorType: 'access_denied', detected: [{ name: '火绒安全' }], suggestion: 's', retryable: true }) },
  }));
  // 覆盖 runJson 以模拟两次失败
  cleaner._psutil.runJson = async () => ({ ok: false, error: 'Access is denied.' });
  const res = await cleaner.clean({ disk: 'C:\\', items: ['user_temp'] }, () => {}, { retryDelayMs: 0 });
  assert.equal(res.results[0].ok, false);
  assert.ok(res.results[0].diagnosis);
  assert.equal(res.results[0].diagnosis.errorType, 'access_denied');
});
