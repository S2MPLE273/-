// test/server.test.js
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createServer } = require('../src/server');

function listen(srv) { return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port))); }
function req(port, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port, method, path: token ? p + '?token=' + token : p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

function makeServer(opts = {}) {
  const state = { items: [{ id: 'user_temp', sizeBytes: 1 }, { id: 'win_temp', sizeBytes: 2 }], spaceDist: [] };
  const scanner = opts.scanner || { scanAll: async (disk, onItem, onPhase) => { if (onPhase) onPhase({ phase: 'items', labels: ['用户临时文件'] }); state.items.forEach(onItem); if (onPhase) onPhase({ phase: 'space' }); return state; }, getItems: () => [{ id: 'user_temp' }, { id: 'win_temp' }] };
  const cleaner = { clean: async () => ({ results: [{ id: 'user_temp', ok: true, freed: 10 }], freedTotal: 10 }) };
  const license = { verify: (k) => k === 'GOODKEY' ? { ok: true } : { ok: false, reason: 'invalid' } };
  const psutil = { getSysInfo: async () => ({ disks: [{ name: 'C:\\', total: 100, free: 40 }], isAdmin: true, machineGuid: 'guid-1', procs: '' }) };
  return createServer({ port: 0, token: 'tok', webui: { html: '<h1>hi</h1>', css: '', js: '' }, license, scanner, cleaner, psutil, machineGuid: 'guid-1', loadState: () => ({ entries: {} }), saveState: () => {} });
}

test('rejects requests without token', async () => {
  const srv = await makeServer(); const port = await listen(srv);
  const r = await req(port, 'GET', '/api/overview');
  assert.equal(r.status, 403);
  srv.close();
});

test('overview with token returns disks', async () => {
  const srv = await makeServer(); const port = await listen(srv);
  const r = await req(port, 'GET', '/api/overview', null, 'tok');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.disks.length, 1);
  srv.close();
});

test('scan flow: start + incremental poll', async () => {
  const srv = await makeServer(); const port = await listen(srv);
  const started = await req(port, 'POST', '/api/scan', { disk: 'C:\\' }, 'tok');
  assert.equal(started.status, 200);
  const id = started.body.data.taskId;
  const poll1 = await req(port, 'GET', '/api/scan/' + id, null, 'tok');
  assert.equal(poll1.status, 200);
  assert.equal(poll1.body.data.status, 'done');
  assert.equal(poll1.body.data.inc.length, 2, 'first poll returns all items');
  const poll2 = await req(port, 'GET', '/api/scan/' + id, null, 'tok');
  assert.equal(poll2.body.data.inc.length, 0, 'second poll returns nothing new');
  const missing = await req(port, 'GET', '/api/scan/nonexistent', null, 'tok');
  assert.equal(missing.status, 404);
  srv.close();
});

test('verify: good/bad key', async () => {
  const srv = await makeServer(); const port = await listen(srv);
  const bad = await req(port, 'POST', '/api/verify', { key: 'WRONG' }, 'tok');
  assert.equal(bad.body.data.ok, false);
  const good = await req(port, 'POST', '/api/verify', { key: 'GOODKEY' }, 'tok');
  assert.equal(good.body.data.ok, true);
  srv.close();
});

test('clean requires verified key', async () => {
  const srv = await makeServer(); const port = await listen(srv);
  const r = await req(port, 'POST', '/api/clean', { key: 'WRONG', disk: 'C:\\', items: ['user_temp'] }, 'tok');
  assert.equal(r.status, 403);
  const ok = await req(port, 'POST', '/api/clean', { key: 'GOODKEY', disk: 'C:\\', items: ['user_temp'] }, 'tok');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.freedTotal, 10);
  srv.close();
});

test('clean rejects unknown item ids', async () => {
  const srv = await makeServer(); const port = await listen(srv);
  const r = await req(port, 'POST', '/api/clean', { key: 'GOODKEY', disk: 'C:\\', items: ['not_a_real_id'] }, 'tok');
  assert.equal(r.status, 400);
  srv.close();
});

test('clean with non-array items returns 400, no crash', async () => {
  const srv = await makeServer(); const port = await listen(srv);
  const r = await req(port, 'POST', '/api/clean', { key: 'GOODKEY', disk: 'C:\\', items: 'user_temp' }, 'tok');
  assert.equal(r.status, 400);
  srv.close();
});

test('oversized body receives 413', async () => {
  const srv = await makeServer(); const port = await listen(srv);
  const status = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/scan?token=tok', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject);
    r.write(JSON.stringify({ disk: 'C:\\', pad: 'x'.repeat(1_100_000) }));
    r.end();
  });
  assert.equal(status, 413);
  srv.close();
});

test('verify passes machine-bound state (machineGuid + state supplied)', async () => {
  // 单机绑定接线验证：license.verify 必须收到 machineGuid 与 file-backed state
  let received;
  const srv = await makeServer();
  const origVerify = srv._license.verify.bind(srv._license);
  srv._license.verify = (key, opts) => { received = opts; return origVerify(key, opts); };
  const port = await listen(srv);
  await req(port, 'POST', '/api/verify', { key: 'GOODKEY' }, 'tok');
  assert.ok(received && received.machineGuid === 'guid-1', 'machineGuid must be passed');
  assert.ok(received && received.state && typeof received.state.save === 'function', 'file-backed state with save must be passed');
  assert.equal(typeof received.now, 'function');
  srv.close();
});

test('scan poll includes progress', async () => {
  const srv = await makeServer(); const port = await listen(srv);
  const started = await req(port, 'POST', '/api/scan', { disk: 'C:\\' }, 'tok');
  const poll1 = await req(port, 'GET', '/api/scan/' + started.body.data.taskId, null, 'tok');
  const p = poll1.body.data.progress;
  assert.ok(p, 'progress present');
  assert.equal(p.done, 2);
  assert.equal(p.total, 2);
  assert.equal(p.phase, 'space');
  assert.deepEqual(p.current, []);
  srv.close();
});

test('progress exposes current labels and partial done mid-scan', async () => {
  let releaseItems;
  const itemsGate = new Promise(r => { releaseItems = r; });
  const scanner = {
    scanAll: async (disk, onItem, onPhase) => {
      if (onPhase) onPhase({ phase: 'items', labels: ['用户临时文件', '系统临时文件'] });
      onItem({ id: 'user_temp', sizeBytes: 1 });
      await itemsGate;
      return { items: [], spaceDist: [] };
    },
    getItems: () => [{ id: 'user_temp' }, { id: 'win_temp' }],
  };
  const srv = await makeServer({ scanner }); const port = await listen(srv);
  const started = await req(port, 'POST', '/api/scan', { disk: 'C:\\' }, 'tok');
  const mid = await req(port, 'GET', '/api/scan/' + started.body.data.taskId, null, 'tok');
  assert.equal(mid.body.data.status, 'running');
  assert.equal(mid.body.data.progress.phase, 'items');
  assert.deepEqual(mid.body.data.progress.current, ['用户临时文件', '系统临时文件']);
  assert.equal(mid.body.data.progress.done, 1);
  releaseItems();
  srv.close();
});
