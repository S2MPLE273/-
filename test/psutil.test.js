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

test('sysinfo returns disks + admin flag + machineGuid (integration, Windows)', async () => {
  const info = await psutil.getSysInfo();
  assert.ok(Array.isArray(info.disks) && info.disks.length >= 1);
  const c = info.disks.find(d => d.name.startsWith('C'));
  assert.ok(c && typeof c.free === 'number' && c.total > c.free);
  assert.equal(typeof info.isAdmin, 'boolean');
  assert.match(info.machineGuid, /^[0-9a-f-]{20,40}$/i);
});
