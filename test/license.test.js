// test/license.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createLicense } = require('../src/license');

const MASTER = 'a'.repeat(64);
const lic = createLicense({ masterKey: MASTER });

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
