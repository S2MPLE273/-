// test/license.test.js
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createLicense, packBits, unpackBits, b32encode } = require('../src/license');

const MASTER = 'a'.repeat(64);
const lic = createLicense({ masterKey: MASTER });

function mkKeyRaw(bits) { // 用给定位布局手工构造密钥（含签名）
  const payload = packBits(bits);
  const sig = crypto.createHmac('sha256', Buffer.from(MASTER, 'hex')).update(payload).digest().slice(0, 3);
  const body = b32encode(Buffer.concat([payload, sig]));
  return 'DKC-' + body.slice(0, 4) + '-' + body.slice(4, 8) + '-' + body.slice(8, 12) + '-' + body.slice(12, 16);
}

test('generate -> verify ok', () => {
  const key = lic.generate({ clientTag: 'customer-A', validDays: 1, issueTime: Date.UTC(2026, 7, 15, 12) });
  assert.match(key, /^DKC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  const r = lic.verify(key, { now: () => Date.UTC(2026, 7, 15, 18) });
  assert.equal(r.ok, true);
});

test('tampered key rejected', () => {
  const key = lic.generate({ validDays: 1, issueTime: Date.UTC(2026, 7, 15) });
  const bad = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
  const r = lic.verify(bad, { now: () => Date.UTC(2026, 7, 15, 12) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('expired key rejected', () => {
  const key = lic.generate({ validDays: 1, issueTime: Date.UTC(2026, 7, 15) });
  const r = lic.verify(key, { now: () => Date.UTC(2026, 7, 17) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('1-day key valid exactly 24h from issue minute', () => {
  const T = Date.UTC(2026, 7, 15, 12, 0); // 分钟对齐
  const key = lic.generate({ validDays: 1, issueTime: T });
  assert.equal(lic.verify(key, { now: () => T + 24 * 3600000 - 60000 }).ok, true, '23h59m still valid');
  const r = lic.verify(key, { now: () => T + 24 * 3600000 + 60000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('issue time floored to minute', () => {
  const T = Date.UTC(2026, 7, 15, 12, 0);
  const key = lic.generate({ validDays: 1, issueTime: T + 45000 }); // +45s
  assert.equal(lic.verify(key, { now: () => T }).ok, true);
  const r = lic.verify(key, { now: () => T + 24 * 3600000 });
  assert.equal(r.reason, 'expired', 'expiry anchored at floored minute, not at +45s');
});

test('7-day key = 168h', () => {
  const T = Date.UTC(2026, 7, 15, 23, 59);
  const key = lic.generate({ validDays: 7, issueTime: T });
  assert.equal(lic.verify(key, { now: () => T + 7 * 24 * 3600000 - 60000 }).ok, true);
  assert.equal(lic.verify(key, { now: () => T + 7 * 24 * 3600000 + 60000 }).reason, 'expired');
});

test('v1-format key rejected (version 1 no longer accepted)', () => {
  const v1key = mkKeyRaw([[1, 2], [226, 16], [1, 6], [0, 16], [0, 12]]);
  const r = lic.verify(v1key, { now: () => Date.UTC(2026, 7, 15, 12) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('machine binding: different machine rejected', () => {
  const key = lic.generate({ validDays: 2, issueTime: Date.UTC(2026, 7, 15) });
  const state = { save: (s) => { Object.assign(state, s); } };
  const r1 = lic.verify(key, { now: () => Date.UTC(2026, 7, 15, 12), machineGuid: 'M1', state });
  assert.equal(r1.ok, true);
  const r2 = lic.verify(key, { now: () => Date.UTC(2026, 7, 15, 13), machineGuid: 'M2', state });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'machine_mismatch');
});

test('clock rollback rejected', () => {
  const key = lic.generate({ validDays: 2, issueTime: Date.UTC(2026, 7, 15) });
  const state = { save: (s) => { Object.assign(state, s); } };
  lic.verify(key, { now: () => Date.UTC(2026, 7, 16, 10), machineGuid: 'M1', state });
  const r = lic.verify(key, { now: () => Date.UTC(2026, 7, 16, 9), machineGuid: 'M1', state });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'clock_rollback');
});

test('bad format rejected', () => {
  const r = lic.verify('HELLO', { now: () => Date.now(), machineGuid: 'M', state: { save() {} } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});

test('packBits known vector: v2 bit layout pinned for keygen compatibility', () => {
  // version=2(2b) issueDay=226(16b) validDays=2(6b) tagHash=0(16b) hour=13(5b) minute=45(6b) reserved=0(1b)
  const h = packBits([[2, 2], [226, 16], [2, 6], [0, 16], [13, 5], [45, 6], [0, 1]]).toString('hex');
  // 独立位串构造（不依赖 packBits 实现）：
  const bits = '10' + '0000000011100010' + '000010' + '0000000000000000' + '01101' + '101101' + '0' + '0000';
  const expected = Array.from({ length: 7 }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2).toString(16).padStart(2, '0')).join('');
  assert.equal(h, expected); // 已人工验算：80388200006da0
  assert.deepStrictEqual(unpackBits(Buffer.from(h, 'hex'), [2, 16, 6, 16, 5, 6, 1]), [2, 226, 2, 0, 13, 45, 0]);
});

test('validDays clamped to 6 bits (1-63)', () => {
  const key = lic.generate({ validDays: 100, issueTime: Date.UTC(2026, 7, 15) });
  const r = lic.verify(key, { now: () => Date.UTC(2026, 7, 15, 12) });
  assert.equal(r.ok, true);
  // 100 wraps to 36 without clamping; 63 with clamping. Check expiry boundary behavior:
  const r46 = lic.verify(key, { now: () => Date.UTC(2026, 9, 20) }); // ~66 days later
  assert.equal(r46.reason, 'expired');
  const r60 = lic.verify(key, { now: () => Date.UTC(2026, 9, 14) }); // ~60 days later
  assert.equal(r60.ok, true);
});
