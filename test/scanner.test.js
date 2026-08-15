// test/scanner.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createScanner, ITEMS, SCAN_TOPLEVEL_PS, SCAN_SPECIAL_PS } = require('../src/scanner');
const psutil = require('../src/psutil');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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
  assert.deepEqual(res.items.map(i => i.id).sort(), ITEMS.map(i => i.id).sort());
  assert.equal(res.disk, 'C:\\');
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

test('SCAN_TOPLEVEL_PS integration: array output, correct size, junction skipped', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dkc_top_'));
  try {
    fs.writeFileSync(path.join(base, 'f1.bin'), Buffer.alloc(1024));
    fs.mkdirSync(path.join(base, 'sub'));
    fs.writeFileSync(path.join(base, 'sub', 'f2.bin'), Buffer.alloc(2048));
    try { fs.symlinkSync(base, path.join(base, 'loop'), 'junction'); } catch (e) { /* junction creation may fail on some systems; test tolerates */ }
    const r = await psutil.runJson('scan_toplevel_test.ps1', SCAN_TOPLEVEL_PS, { disk: base }, { timeoutMs: 60000 });
    assert.equal(r.ok, true);
    const list = r.data[0];
    assert.ok(Array.isArray(list), 'output must be an array');
    const sub = list.find(d => d.path === path.join(base, 'sub'));
    assert.ok(sub && sub.size === 2048, 'subdir size correct');
    const loop = list.find(d => d.path === path.join(base, 'loop'));
    assert.ok(!loop, 'junction must not be walked');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('scanAll reports phases: items batches then space then special', async () => {
  const scanner = createScanner({ psutil: fakePsutil({}) });
  const phases = [];
  await scanner.scanAll('C:', () => {}, (p) => phases.push(p));
  const kinds = phases.map(p => p.phase);
  assert.equal(kinds[0], 'items');
  assert.equal(phases[0].labels.length, 4, 'first batch has 4 labels');
  assert.ok(kinds.includes('space'), 'space phase reported');
  assert.ok(kinds.includes('special'), 'special phase reported');
  assert.ok(kinds.indexOf('items') < kinds.indexOf('space'), 'items before space');
  assert.ok(kinds.indexOf('space') < kinds.indexOf('special'), 'space before special');
});

test('getItems: system disk returns all items, non-system only recycle_bin', () => {
  const scanner = createScanner({ psutil: fakePsutil({}) });
  const sys = scanner.getItems('C:');
  assert.equal(sys.length, ITEMS.length);
  assert.ok(sys.some(i => i.id === 'recycle_bin'));
  const non = scanner.getItems('D:');
  assert.deepEqual(non.map(i => i.id), ['recycle_bin']);
  assert.equal(non[0].label, '回收站（本盘）');
});

test('scanAll: non-system disk scans only recycle_bin, no entries batches', async () => {
  const calls = [];
  const scanner = createScanner({ psutil: {
    runJson: async (name, body, params) => {
      calls.push({ name, params });
      if (name === 'scan_special.ps1') return { ok: true, data: [{ id: 'recycle_bin', size: 4096 }] };
      if (name === 'scan_toplevel.ps1') return { ok: true, data: [[{ path: 'D:\\Games', size: 999 }]] };
      return { ok: true, data: [] };
    },
  } });
  const res = await scanner.scanAll('D:', () => {});
  assert.deepEqual(res.items.map(i => i.id), ['recycle_bin']);
  assert.equal(res.items[0].sizeBytes, 4096);
  assert.ok(res.spaceDist[0] && res.spaceDist[0].path === 'D:\\Games');
  assert.ok(!calls.some(c => c.name === 'scan_entries.ps1'), 'no entries batches for non-system disk');
  assert.equal(calls.find(c => c.name === 'scan_special.ps1').params.disk, 'D:\\');
});

test('toplevel scan uses extended 10min timeout', async () => {
  let opts;
  const scanner = createScanner({ psutil: {
    runJson: async (n, b, p, o) => { if (n === 'scan_toplevel.ps1') opts = o; return { ok: true, data: [] }; },
  } });
  await scanner.scanAll('C:', () => {});
  assert.equal(opts.timeoutMs, 600000);
});

test('SCAN_SPECIAL_PS integration: per-disk $RECYCLE.BIN walk sums size', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dkc_rb_'));
  try {
    const rb = path.join(base, '$RECYCLE.BIN');
    fs.mkdirSync(rb);
    fs.writeFileSync(path.join(rb, 'f1.bin'), Buffer.alloc(1024));
    fs.mkdirSync(path.join(rb, 'S-1-5-18'));
    fs.writeFileSync(path.join(rb, 'S-1-5-18', 'f2.bin'), Buffer.alloc(2048));
    const r = await psutil.runJson('scan_special_test.ps1', SCAN_SPECIAL_PS, { disk: base + '\\' }, { timeoutMs: 60000 });
    assert.equal(r.ok, true);
    assert.equal(r.data.find(d => d.id === 'recycle_bin').size, 3072);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
