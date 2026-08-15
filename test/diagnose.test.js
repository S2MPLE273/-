// test/diagnose.test.js
const test = require('node:test');
const assert = require('node:assert');
const { classifyError, createDiagnose } = require('../src/diagnose');

test('classifyError: access denied', () => {
  assert.equal(classifyError({ code: 5, stderr: 'Access is denied.' }), 'access_denied');
  assert.equal(classifyError({ code: 1, stderr: '0x80070005' }), 'access_denied');
  assert.equal(classifyError({ code: 1, stderr: 'denied' }), 'access_denied');
});
test('classifyError: locked', () => {
  assert.equal(classifyError({ code: 32, stderr: '' }), 'file_locked');
  assert.equal(classifyError({ code: 1, stderr: 'being used by another process' }), 'file_locked');
});
test('classifyError: localized Chinese stderr (zh-CN Windows)', () => {
  assert.equal(classifyError({ code: 1, stderr: '拒绝访问。' }), 'access_denied');
  assert.equal(classifyError({ code: 1, stderr: '另一个程序正在使用此文件，进程无法访问。' }), 'file_locked');
  assert.equal(classifyError({ code: 1, stderr: '文件被占用' }), 'file_locked');
});
test('classifyError: timeout/unknown', () => {
  assert.equal(classifyError({ code: 1, stderr: '', timedOut: true }), 'timeout');
  assert.equal(classifyError({ code: 2, stderr: 'x' }), 'unknown');
});

test('diagnose: huorong + access_denied -> targeted hint', async () => {
  const diag = createDiagnose({ listProcs: async () => ['HipsDaemon', 'explorer'] });
  const d = await diag.diagnose('winsxs', 'access_denied');
  assert.equal(d.errorType, 'access_denied');
  assert.equal(d.detected[0].name, '火绒安全');
  assert.match(d.suggestion, /火绒/);
  assert.equal(d.retryable, true);
});

test('diagnose: no security software -> generic hint', async () => {
  const diag = createDiagnose({ listProcs: async () => ['explorer'] });
  const d = await diag.diagnose('winsxs', 'file_locked');
  assert.equal(d.detected.length, 0);
  assert.match(d.suggestion, /其他程序/);
});

test('diagnose: unknown error -> generic, retryable false', async () => {
  const diag = createDiagnose({ listProcs: async () => [] });
  const d = await diag.diagnose('user_temp', 'unknown');
  assert.equal(d.retryable, false);
});
