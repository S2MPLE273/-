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

test('keygen and license.js share the same algorithm', () => {
  const lic = createLicense({ masterKey: MASTER });
  const algo = makeApi(MASTER);
  const key = algo.generate({ clientTag: 'customer-A', validDays: 1, issueTime: Date.UTC(2026, 7, 15, 12) });
  assert.match(key, /^DKC-/);
  const r = lic.verify(key, { now: () => Date.UTC(2026, 7, 15, 13) });
  assert.equal(r.ok, true);
});

test('keygen with different master key is rejected', () => {
  const lic = createLicense({ masterKey: MASTER });
  const algo = makeApi('c'.repeat(64));
  const key = algo.generate({ validDays: 1, issueTime: Date.UTC(2026, 7, 15) });
  const r = lic.verify(key, { now: () => Date.UTC(2026, 7, 15, 12) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid');
});
