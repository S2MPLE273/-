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
  const key = algo.generate({ validDays: 1, issueTime: T });
  assert.match(key, /^DKC-/);
  const r = lic.verify(key, { now: () => T + 3600000 });
  assert.equal(r.ok, true);
});

test('keygen device-bound key: matching device ok, other machine mismatch', () => {
  const lic = createLicense({ masterKey: MASTER });
  const algo = makeApi(MASTER);
  const key = algo.generate({ deviceCode: 'A1B2C3D4-E5F6-7890-ABCD-EF1234567890', validDays: 1, issueTime: T });
  const ok = lic.verify(key, { now: () => T + 3600000, machineGuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' });
  assert.equal(ok.ok, true);
  const bad = lic.verify(key, { now: () => T + 3600000, machineGuid: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'machine_mismatch');
});

test('keygen device code normalization matches license.js (braces/case/dashes ignored)', () => {
  const lic = createLicense({ masterKey: MASTER });
  const algo = makeApi(MASTER);
  const key = algo.generate({ deviceCode: '{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}', validDays: 1, issueTime: T });
  const ok = lic.verify(key, { now: () => T + 3600000, machineGuid: 'a1b2c3d4e5f67890abcdef1234567890' });
  assert.equal(ok.ok, true);
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

test('keygen cross: validDays clamp', () => {
  const lic = createLicense({ masterKey: MASTER });
  const algo = makeApi(MASTER);
  const key = algo.generate({ validDays: 100, issueTime: T });
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
  // 密码明文不入库：本地校验"明文→哈希"对应关系需显式提供 DKC_KEYGEN_PW 环境变量（可选断言）
  const pw = process.env.DKC_KEYGEN_PW || '';
  if (pw) assert.equal(algo.sha256HexText(pw), '7284519dd9c9a67a36e87a20a3e89dd0bed7ff84caf276994820b7191a4d6301');
  assert.equal(algo.PASS_HASH, '7284519dd9c9a67a36e87a20a3e89dd0bed7ff84caf276994820b7191a4d6301');
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
