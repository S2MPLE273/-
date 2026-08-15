// test/scanner.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createScanner } = require('../src/scanner');

function fakePsutil(scriptResults) {
  return {
    runJson: async (name, body, params) => {
      const key = name + ':' + (params.entries ? params.entries.map(e => e.id).join(',') : 'top');
      return scriptResults[key] || { ok: true, data: [] };
    },
  };
}

test('scanAll emits item results progressively', async () => {
  const scanner = createScanner({ psutil: fakePsutil({
    'scan_entries.ps1:user_temp': { ok: true, data: [{ id: 'user_temp', size: 1024 }] },
    'scan_entries.ps1:win_temp': { ok: true, data: [{ id: 'win_temp', size: 2048 }] },
    'scan_toplevel.ps1:top': { ok: true, data: [[{ path: 'D:\\SteamLibrary', size: 100000 }]] },
  }) });
  const seen = [];
  const res = await scanner.scanAll('C:', (item) => seen.push(item));
  assert.ok(res.items.length >= 2);
  assert.ok(seen.some(i => i.id === 'user_temp' && i.sizeBytes === 1024));
  assert.ok(res.spaceDist.some(d => d.path === 'D:\\SteamLibrary'));
});

test('scanAll: single item failure isolated', async () => {
  const scanner = createScanner({ psutil: fakePsutil({
    'scan_entries.ps1:user_temp': { ok: false, error: 'boom' },
    'scan_entries.ps1:win_temp': { ok: true, data: [{ id: 'win_temp', size: 1 }] },
    'scan_toplevel.ps1:top': { ok: true, data: [[]] },
  }) });
  const res = await scanner.scanAll('C:', () => {});
  const bad = res.items.find(i => i.id === 'user_temp');
  assert.ok(bad.error);
  assert.ok(res.items.find(i => i.id === 'win_temp' && !i.error));
});

test('scan items are well-formed', () => {
  const scanner = createScanner({ psutil: fakePsutil({}) });
  const defs = scanner.getItems();
  for (const it of defs) {
    assert.ok(it.id && it.label && it.scope && it.risk && Array.isArray(it.paths));
    assert.ok(['low', 'medium', 'high'].includes(it.risk));
    assert.ok(['system', 'user', 'disk'].includes(it.scope));
  }
});
