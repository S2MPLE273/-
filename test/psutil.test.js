// test/psutil.test.js
const test = require('node:test');
const assert = require('node:assert');
const psutil = require('../src/psutil');

test('b64json roundtrip', () => {
  const obj = { entries: [{ id: 'a', paths: ['C:\\Windows\\Temp'] }] };
  const b = psutil.b64json(obj);
  const back = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
  assert.deepStrictEqual(back, obj);
});

test('normalizeDisks wraps single object into array', () => {
  assert.deepStrictEqual(psutil.normalizeDisks({ name: 'C:\\' }), [{ name: 'C:\\' }]);
  assert.deepStrictEqual(psutil.normalizeDisks([{ name: 'C:\\' }]), [{ name: 'C:\\' }]);
});

test('sysinfo returns disks + admin flag + machineGuid (integration, Windows)', async () => {
  const info = await psutil.getSysInfo();
  assert.ok(Array.isArray(info.disks) && info.disks.length >= 1);
  const c = info.disks.find(d => d.name.startsWith('C'));
  assert.ok(c && typeof c.free === 'number' && c.total > c.free);
  assert.equal(typeof info.isAdmin, 'boolean');
  assert.match(info.machineGuid, /^[0-9a-f-]{20,40}$/i);
});

test('runJson: non-zero exit maps to ok:false', async () => {
  const r = await psutil.runJson('fail.ps1', 'param([string]$Json)\nexit 3\n', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /exit 3/);
});

test('runJson: bad json output maps to ok:false', async () => {
  const r = await psutil.runJson('badjson.ps1', 'param([string]$Json)\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\nWrite-Output "not json"\n', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /bad json output/);
});

test('runJson: utf8 output roundtrip (Chinese preserved)', async () => {
  // Script body stays pure ASCII; the Chinese only appears in the JS param,
  // which runJson base64-encodes before passing to PowerShell.
  const body = 'param([string]$Json)\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$d=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json)) | ConvertFrom-Json\nWrite-Output (\'{"echo":"\' + $d.name + \'"}\')\n';
  const r = await psutil.runJson('echo.ps1', body, { name: '磁盘清理测试' });
  assert.equal(r.ok, true);
  assert.equal(r.data[0].echo, '磁盘清理测试');
});
