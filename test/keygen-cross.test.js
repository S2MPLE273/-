// test/keygen-cross.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createLicense } = require('../src/license');

function extractAlgo(html) {
  const m = html.match(/<script id="dkc-algo">([\s\S]*?)<\/script>/);
  assert.ok(m, 'dkc-algo script block missing');
  return m[1];
}

function makeApi(masterKey) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'tools', 'keygen.template.html'), 'utf8')
    .replace('__MASTER_KEY__', masterKey);
  const algo = extractAlgo(html);
  const ctx = { console, TextEncoder, Date, Math, parseInt, DataView, Uint8Array, Uint32Array };
  vm.createContext(ctx);
  vm.runInContext(algo, ctx);
  return ctx.dkcAlgo;
}

const MASTER = 'b'.repeat(64);
const T = Date.UTC(2026, 7, 15, 12, 0); // 分钟对齐

test('keygen and license.js share the v2 algorithm', () => {
  const lic = createLicense({ masterKey: MASTER });
  const algo = makeApi(MASTER);
  const key = algo.generate({ clientTag: 'customer-A', validDays: 1, issueTime: T });
  assert.match(key, /^DKC-/);
  const r = lic.verify(key, { now: () => T + 3600000 });
  assert.equal(r.ok, true);
});

test('v2 cross: exact 24h boundary via keygen-generated key', () => {
  const lic = createLicense({ masterKey: MASTER });
  const algo = makeApi(MASTER);
  const key = algo.generate({ validDays: 1, issueTime: T });
  assert.equal(lic.verify(key, { now: () => T + 24 * 3600000 - 60000 }).ok, true);
  assert.equal(lic.verify(key, { now: () => T + 24 * 3600000 }).reason, 'expired', 'expired at exactly the expiry minute');
  assert.equal(lic.verify(key, { now: () => T + 24 * 3600000 + 60000 }).reason, 'expired');
});

test('v2 cross: issue time floored to minute in both implementations', () => {
  const lic = createLicense({ masterKey: MASTER });
  const algo = makeApi(MASTER);
  const key = algo.generate({ validDays: 1, issueTime: T + 45000 });
  assert.equal(lic.verify(key, { now: () => T }).ok, true);
  assert.equal(lic.verify(key, { now: () => T + 24 * 3600000 }).reason, 'expired');
});

test('keygen cross: validDays clamp + multibyte tag boundary', () => {
  const lic = createLicense({ masterKey: MASTER });
  const algo = makeApi(MASTER);
  const key = algo.generate({ clientTag: '客户-张三-联想笔记本-2026年8月-编号0001', validDays: 100, issueTime: T });
  assert.equal(lic.verify(key, { now: () => T + 3600000 }).ok, true);
  // validDays 100 被钳位到 63：+60 天仍有效
  assert.equal(lic.verify(key, { now: () => T + 60 * 24 * 3600000 }).ok, true);
});

test('keygen with different master key is rejected', () => {
  const lic = createLicense({ masterKey: MASTER });
  const algo = makeApi('c'.repeat(64));
  const key = algo.generate({ validDays: 1, issueTime: T });
  const r = lic.verify(key, { now: () => T + 3600000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('history remainingMs formula identical to license.verify remainingMs', () => {
  const lic = createLicense({ masterKey: MASTER });
  const algo = makeApi(MASTER);
  const key = algo.generate({ validDays: 3, issueTime: T });
  const now = T + 2 * 24 * 3600000 + 30 * 60000;
  assert.equal(algo.remainingMs(T, 3, now), lic.verify(key, { now: () => now }).remainingMs);
});

test('keygen password hash constant matches SHA-256 of the password', () => {
  const algo = makeApi(MASTER);
  assert.equal(algo.sha256HexText('Hjh20050613'), '5fc9989839d6c0871e749306c1d1dad4cb2c23e89cc56321835eb622fef96e0d');
  assert.notEqual(algo.sha256HexText('Hjh20050614'), '5fc9989839d6c0871e749306c1d1dad4cb2c23e89cc56321835eb622fef96e0d');
  assert.equal(algo.PASS_HASH, '5fc9989839d6c0871e749306c1d1dad4cb2c23e89cc56321835eb622fef96e0d');
  assert.ok(typeof algo.PASS_HASH === 'string');
});

test('master key guard: injected template ok, raw template flagged', () => {
  const good = makeApi(MASTER);
  assert.equal(good.masterOk, true);
  assert.equal(good.fingerprint, MASTER.slice(0, 8));
  const raw = makeApi('__MASTER_KEY__'); // 模拟未注入（占位符原样保留）
  assert.equal(raw.masterOk, false);
  assert.equal(raw.fingerprint, '');
});

test('UI script block parses (syntax check only)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'tools', 'keygen.template.html'), 'utf8')
    .replace('__MASTER_KEY__', MASTER);
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'UI script block missing');
  new vm.Script(m[1]); // 仅解析，不执行
});
