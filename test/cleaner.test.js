// test/cleaner.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createCleaner, CLEAN_ENTRIES_PS } = require('../src/cleaner');
const psutil = require('../src/psutil');

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

test('clean: driver_store marked unsupported, not silent success', async () => {
  const calls = [];
  const cleaner = createCleaner(fake({ scriptResults: {} }));
  cleaner._psutil.runJson = async (...a) => { calls.push(a[0]); return { ok: true, data: [] }; };
  const res = await cleaner.clean({ disk: 'C:\\', items: ['driver_store'] }, () => {});
  assert.equal(res.results[0].ok, false);
  assert.match(res.results[0].error, /暂不支持/);
  assert.equal(calls.length, 0, 'cleanOne must not be invoked for driver_store');
});

test('clean: retries once on failure, then diagnoses', async () => {
  const cleaner = createCleaner(fake({
    scriptResults: { 'clean_entries.ps1': { ok: true, data: [] } },
    diag: { diagnose: async () => ({ errorType: 'access_denied', detected: [{ name: '火绒安全' }], suggestion: 's', retryable: true }) },
  }));
  // 覆盖 runJson 以模拟两次失败
  let calls = 0;
  cleaner._psutil.runJson = async () => { calls++; return { ok: false, error: 'Access is denied.' }; };
  const res = await cleaner.clean({ disk: 'C:\\', items: ['user_temp'] }, () => {}, { retryDelayMs: 0 });
  assert.equal(calls, 2, 'must retry once');
  assert.equal(res.results[0].ok, false);
  assert.ok(res.results[0].diagnosis);
  assert.equal(res.results[0].diagnosis.errorType, 'access_denied');
});

// CLEAN_ENTRIES_PS 的错误字段现用 ConvertTo-Json 转义；真实 DISM 错误含反斜杠路径
// 与引号（如 C:\Windows\Logs\DISM\dism.log），旧 -replace 转义会产生非法 JSON。
test('error field: backslash+quote stays valid JSON (integration)', async () => {
  const probe = `
param([string]$Json)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$err = 'Access is denied. C:\\Windows\\Logs\\DISM\\dism.log "quoted"'
Write-Output ('{"error":' + ($err | ConvertTo-Json -Compress) + '}')
`;
  const r = await psutil.runJson('errprobe.ps1', probe, {});
  assert.equal(r.ok, true);
  assert.equal(r.data[0].error, 'Access is denied. C:\\Windows\\Logs\\DISM\\dism.log "quoted"');
});

test('old -replace escape yields bad json on backslash+quote (regression pin)', async () => {
  const probe = `
param([string]$Json)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$err = 'Access is denied. C:\\Windows\\Logs\\DISM\\dism.log "quoted"'
Write-Output ('{"error":"' + ($err -replace '"','\\"') + '"}')
`;
  const r = await psutil.runJson('errprobe-old.ps1', probe, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /bad json output/);
});

test('recycle clean: SHEmptyRecycleBin branch removed (elevated E_UNEXPECTED fix)', () => {
  assert.doesNotMatch(CLEAN_ENTRIES_PS, /SHEmptyRecycleBin/);
  assert.doesNotMatch(CLEAN_ENTRIES_PS, /Clear-RecycleBin/);
});

test('recycle clean: deletes selected-drive $RECYCLE.BIN via dir kind', async () => {
  const params = [];
  const cleaner = createCleaner(fake({ scriptResults: {} }));
  cleaner._psutil.runJson = async (n, b, p) => { params.push(p); return { ok: true, data: [{ id: 'recycle_bin', ok: true, freed: 100, error: '' }] }; };
  const res = await cleaner.clean({ disk: 'D:\\', items: ['recycle_bin'] }, () => {}, { retryDelayMs: 0 });
  assert.equal(res.results[0].ok, true);
  assert.equal(params[0].disk, 'D:\\');
  assert.deepStrictEqual(params[0].entries[0], { id: 'recycle_bin', kind: 'dir', paths: ['D:\\$RECYCLE.BIN'], filters: null });
});

test('recycle clean: C: shorthand normalized to C:\\$RECYCLE.BIN', async () => {
  const params = [];
  const cleaner = createCleaner(fake({ scriptResults: {} }));
  cleaner._psutil.runJson = async (n, b, p) => { params.push(p); return { ok: true, data: [{ id: 'recycle_bin', ok: true, freed: 0, error: '' }] }; };
  await cleaner.clean({ disk: 'C:', items: ['recycle_bin'] }, () => {}, { retryDelayMs: 0 });
  assert.deepStrictEqual(params[0].entries[0].paths, ['C:\\$RECYCLE.BIN']);
});
