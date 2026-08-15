# DiskClean Agent 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个绿色单 exe 磁盘清理工具：客户双击运行，浏览器界面自助扫描/清理任意磁盘，密钥离线验证（默认 1 天有效期、单机绑定）。

**Architecture:** Node 24 单文件（SEA 打包）内嵌 HTTP 服务与 Web UI，PowerShell 子进程执行扫描/清理（脚本运行时写入 `%ProgramData%\DiskCleanAgent\ps\`，参数经 Base64 传递规避 GBK 编码坑）。密钥 HMAC-SHA256 离线验证；服务方用独立 keygen.html 生成密钥。失败项目自动诊断安全软件干扰并给出针对性提示。

**Tech Stack:** Node.js 24（node:http/node:crypto/node:test，零运行时依赖）、PowerShell 5.1（子进程）、esbuild + postject（仅构建期 devDependencies）、原生 HTML/CSS/JS（前端内嵌）。

**规格文档:** `docs/superpowers/specs/2026-08-15-diskclean-agent-design.md`

**开发环境注意事项（Windows + Git Bash，已在 2026-08-15 会话验证）：**
- PowerShell 5.1 按 GBK 读取无 BOM 的 .ps1 文件 → **所有 .ps1 脚本内容必须是纯 ASCII**（无中文注释）
- Git Bash 会展开 `$_` 等变量 → 调 PowerShell 时用单引号或 `-File` 传脚本
- 运行 PowerShell 命令统一使用 `powershell -NoProfile -File script.ps1 -Json "<base64>"` 形式

---

## 文件结构总览

```
DiskCleanAgent/
├── src/
│   ├── main.js              # 入口：提权重启、启动服务、打开浏览器、心跳退出
│   ├── server.js            # HTTP 路由 + token 校验 + 任务状态（内存）
│   ├── license.js           # 密钥生成/验证（HMAC-SHA256 + base32 编码，主密钥 __MASTER_KEY__ 构建期注入）
│   ├── psutil.js            # PowerShell 子进程封装 + 磁盘/管理员/MachineGuid 查询
│   ├── scanner.js           # 扫描项定义 + 扫描编排（并行、渐进式回调）
│   ├── cleaner.js           # 清理编排（串行、失败重试 1 次、诊断联动）
│   ├── diagnose.js          # 错误分类 + 安全软件检测 + 建议文案
│   ├── ps/
│   │   ├── scan_entries.ps1     # 通用扫描（多路径递归统计，JSON 行输出）
│   │   ├── scan_toplevel.ps1    # 单盘顶层目录 Top10 统计
│   │   ├── clean_entries.ps1    # 通用清理（dir/recycle/dism/file 四类动作）
│   │   ├── sysinfo.ps1          # 磁盘列表/是否管理员/MachineGuid/安全软件进程
│   └── webui/
│       ├── index.html
│       ├── style.css
│       └── app.js
├── tools/
│   ├── build.js             # SEA 打包流水线（master.key、webui 内嵌、esbuild、postject、keygen.html 成品）
│   ├── keygen.template.html # 密钥生成器模板（纯 JS HMAC，__MASTER_KEY__ 占位）
│   └── master.key           # 主密钥 64 hex（gitignore，首次构建时自动生成）
├── test/
│   ├── license.test.js
│   ├── diagnose.test.js
│   ├── scanner.test.js
│   ├── cleaner.test.js
│   ├── server.test.js
│   └── keygen-cross.test.js
├── docs/superpowers/specs/2026-08-15-diskclean-agent-design.md
├── docs/superpowers/plans/2026-08-15-diskclean-agent.md
├── .gitignore               # node_modules/ .superpowers/ tools/master.key dist/
└── package.json             # devDependencies: esbuild, postject
```

**接口约定（全计划统一）：**
- `psutil.runPs(scriptName, scriptBody, paramsObj, opts)` → `Promise<{code, stdout, stderr, timedOut}>`；脚本写入 `%ProgramData%\DiskCleanAgent\ps\<scriptName>.ps1`，参数 `{json: <base64>}` 经 `-Json` 传入
- 扫描结果单项：`{id, label, scope: 'system'|'user'|'disk', risk: 'low'|'medium'|'high', sizeBytes, error?}`
- 清理结果单项：`{id, ok, freedBytes, error?, diagnosis?}`（diagnosis 结构见 Task 4）
- 任务状态：`{id, status: 'running'|'done', items: [...], spaceDist: [...], disk, startedAt}`，存 server 内存 Map

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `.gitignore`（已存在，确认内容）

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "diskclean-agent",
  "version": "0.1.0",
  "private": true,
  "description": "Green single-exe disk cleaner with offline license key",
  "scripts": {
    "test": "node --test test/",
    "build": "node tools/build.js"
  },
  "devDependencies": {
    "esbuild": "^0.25.0",
    "postject": "^1.0.0-alpha.6"
  }
}
```

- [ ] **Step 2: 安装依赖（失败则用 npmmirror 镜像重试）**

Run: `cd /d/DiskCleanAgent && npm install`
Expected: `added N packages`
若网络失败：`npm install --registry=https://registry.npmmirror.com`

- [ ] **Step 3: 确认 .gitignore**

`cat .gitignore` 应包含：`node_modules/`、`.superpowers/`、`tools/master.key`、`dist/`。缺则补上。

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore package-lock.json
git commit -m "chore: 项目脚手架（esbuild/postject 构建依赖）"
```

---

### Task 2: license.js 密钥模块（TDD）

密钥格式：`DKC-XXXX-XXXX-XXXX-XXXX`。前 3 组为 payload（60 bits：version 2b + issueDay 16b + validDays 6b + clientTagHash 16b + 保留 20b），第 4 组为 HMAC-SHA256 截断（前 20 bits）。字母表 32 字符去混淆：`23456789ABCDEFGHJKLMNPQRSTUVWXYZ`。issueDay = 自 2026-01-01 起的天数。

**Files:**
- Create: `src/license.js`
- Test: `test/license.test.js`

- [ ] **Step 1: 写失败测试**

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/DiskCleanAgent && node --test test/license.test.js`
Expected: FAIL（`createLicense is not a function` / 模块不存在）

- [ ] **Step 3: 实现 src/license.js**

```js
const crypto = require('node:crypto');

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const EPOCH = Date.UTC(2026, 0, 1);
const DAY_MS = 86400000;

function packBits(bits) { // bits: array of [value, width]
  let buf = 0, used = 0;
  const bytes = [];
  for (const [v, w] of bits) { buf = (buf << w) | v; used += w; }
  const pad = (8 - (used % 8)) % 8;
  buf <<= pad; used += pad;
  for (let i = used - 8; i >= 0; i -= 8) bytes.push((buf >> i) & 0xff);
  return Buffer.from(bytes);
}
function unpackBits(buf, widths) {
  let used = 0, idx = 0, acc = 0;
  const out = [];
  for (const w of widths) {
    let v = 0;
    for (let i = 0; i < w; i++) {
      if (used === 0) { acc = buf[idx++]; used = 8; }
      v = (v << 1) | ((acc >> 7) & 1);
      acc = (acc << 1) & 0xff; used--;
    }
    out.push(v);
  }
  return out;
}
function b32encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let s = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) s += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return s;
}
function b32decode(s) {
  let bits = '';
  for (const c of s) { const i = ALPHABET.indexOf(c); if (i < 0) return null; bits += i.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function group(s) { return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16); }

function createLicense({ masterKey }) {
  function sign(payloadBuf) {
    return crypto.createHmac('sha256', Buffer.from(masterKey, 'hex')).update(payloadBuf).digest().slice(0, 3);
  }
  function generate({ clientTag = '', validDays = 1, issueTime = Date.now() } = {}) {
    const issueDay = Math.floor((issueTime - EPOCH) / DAY_MS);
    const tagHash = clientTag ? crypto.createHash('sha256').update(String(clientTag), 'utf8').digest().readUInt16BE(0) : 0;
    // 52 bits payload（补零至 56 bits = 7 字节）+ 3 字节签名 = 10 字节 = 80 bits = 16 chars = 4 组
    const payload = packBits([[1, 2], [issueDay, 16], [validDays, 6], [tagHash, 16], [0, 12]]);
    const sig = sign(payload);
    const body = b32encode(Buffer.concat([payload, sig]));
    return 'DKC-' + group(body.slice(0, 16));
  }
  function verify(key, { now = () => Date.now(), machineGuid = 'unknown', state } = {}) {
    if (typeof key !== 'string' || !/^DKC-[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/.test(key)) return { ok: false, reason: 'invalid' };
    const body = key.slice(4).replace(/-/g, '');
    const buf = b32decode(body);
    if (!buf || buf.length < 10) return { ok: false, reason: 'invalid' };
    const payload = buf.slice(0, 7);
    const sig = buf.slice(7, 10);
    if (!crypto.timingSafeEqual(sign(payload), sig)) return { ok: false, reason: 'invalid' };
    const [version, issueDay, validDays] = unpackBits(payload, [2, 16, 6]);
    if (version !== 1) return { ok: false, reason: 'invalid' };
    const cur = now();
    const issueMs = EPOCH + issueDay * DAY_MS;
    const expireMs = issueMs + validDays * DAY_MS;
    const keyHash = crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16);
    const st = state && (state.entries || (state.entries = {}));
    const rec = st && st[keyHash];
    if (cur < issueMs) return { ok: false, reason: 'clock_rollback' };
    if (cur > expireMs) return { ok: false, reason: 'expired' };
    if (st) {
      if (rec && rec.machineGuid !== machineGuid) return { ok: false, reason: 'machine_mismatch' };
      if (rec && cur < rec.lastSeen) return { ok: false, reason: 'clock_rollback' };
    }
    if (st) {
      st[keyHash] = { machineGuid, lastSeen: cur };
      if (typeof state.save === 'function') state.save(state);
    }
    return { ok: true, remainingMs: expireMs - cur, keyHash };
  }
  return { generate, verify };
}

module.exports = { createLicense, ALPHABET, EPOCH, packBits, unpackBits, b32encode, b32decode };
```

说明：payload 52 bits（version 2b + issueDay 16b + validDays 6b + tagHash 16b + 保留 12b）补零至 56 bits = 7 字节；签名截 3 字节（24 bits）；共 10 字节 = 80 bits，b32 编码恰好 16 字符 = 4 组 × 4 字符，无浪费。decode 时 16 字符 → 10 字节，payload 取前 7 字节（unpackBits 只按 widths 读取前 40 bits，忽略保留位），sig 取后 3 字节。两处（encode/decode）布局必须镜像。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/DiskCleanAgent && node --test test/license.test.js`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/license.js test/license.test.js
git commit -m "feat: 离线密钥模块（HMAC 签名/有效期/单机绑定/时间回拨防护）"
```

---

### Task 3: psutil.js PowerShell 封装（TDD）

**Files:**
- Create: `src/psutil.js`
- Create: `src/ps/sysinfo.ps1`
- Test: `test/psutil.test.js`

- [ ] **Step 1: 写失败测试（b64json 纯函数 + sysinfo 集成）**

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/DiskCleanAgent && node --test test/psutil.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 src/psutil.js**

```js
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PS_DIR = path.join(process.env.ProgramData || 'C:\\ProgramData', 'DiskCleanAgent', 'ps');

function b64json(obj) { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); }

function runPs(scriptName, scriptBody, params = {}, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    fs.mkdirSync(PS_DIR, { recursive: true });
    const file = path.join(PS_DIR, scriptName);
    fs.writeFileSync(file, scriptBody, 'utf8');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file];
    if (params.json !== undefined) args.push('-Json', params.json);
    execFile('powershell.exe', args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        code: err ? (err.code === undefined ? -1 : err.code) : 0,
        timedOut: err && err.killed,
        stdout: String(stdout),
        stderr: String(stderr),
      });
    });
  });
}

function runJson(scriptName, scriptBody, params = {}, opts = {}) {
  return new Promise(async (resolve) => {
    const r = await runPs(scriptName, scriptBody, { json: b64json(params) }, opts);
    if (r.code !== 0) return resolve({ ok: false, error: r.stderr.trim() || ('exit ' + r.code), raw: r });
    try {
      const lines = r.stdout.split(/\r?\n/).filter(l => l.trim());
      const data = lines.map(l => JSON.parse(l.trim()));
      resolve({ ok: true, data, raw: r });
    } catch (e) { resolve({ ok: false, error: 'bad json output: ' + e.message, raw: r }); }
  });
}

const SYSINFO_PS = `
$ErrorActionPreference='SilentlyContinue'
$disks = @()
Get-PSDrive -PSProvider FileSystem | ForEach-Object {
  $disks += @{ name = $_.Root; total = [double]$_.Free + [double]$_.Used; free = [double]$_.Free }
}
$p = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$mg = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid
$procs = (Get-Process | Select-Object -ExpandProperty Name) -join ','
Write-Output ('{"disks":' + ($disks | ConvertTo-Json -Compress) + ',"isAdmin":' + $isAdmin.ToString().ToLower() + ',"machineGuid":"' + $mg + '","procs":"' + $procs + '"}')
`;

async function getSysInfo() {
  const r = await runJson('sysinfo.ps1', SYSINFO_PS, {}, { timeoutMs: 60000 });
  if (!r.ok) throw new Error('sysinfo failed: ' + r.error);
  return r.data[0];
}

module.exports = { b64json, runPs, runJson, getSysInfo, PS_DIR };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/DiskCleanAgent && node --test test/psutil.test.js`
Expected: 2 passed（b64json + sysinfo 集成）

- [ ] **Step 5: Commit**

```bash
git add src/psutil.js test/psutil.test.js
git commit -m "feat: PowerShell 子进程封装与系统信息查询"
```

---

### Task 4: diagnose.js 失败诊断（TDD）

**Files:**
- Create: `src/diagnose.js`
- Test: `test/diagnose.test.js`

- [ ] **Step 1: 写失败测试**

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/DiskCleanAgent && node --test test/diagnose.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 src/diagnose.js**

```js
const SECURITY_SOFT = [
  { name: '火绒安全', procs: ['HipsDaemon', 'HipsTray', 'usysdiag', 'wsctrlsvc'],
    hint: '打开火绒 → 防护中心 → 临时关闭「文件实时防护」→ 回到本页点击重试。清理完成后再开启防护。' },
  { name: '360 安全卫士', procs: ['360Tray', '360Safe', 'ZhuDongFangYu'],
    hint: '打开 360 安全卫士 → 防护中心 → 临时关闭「文件防护」→ 回到本页点击重试。' },
  { name: '腾讯电脑管家', procs: ['QQPCRTP', 'QQPCTray'],
    hint: '打开腾讯电脑管家 → 病毒查杀 → 实时防护 → 临时关闭 → 回到本页点击重试。' },
  { name: '金山毒霸', procs: ['kxescore', 'kxetray'],
    hint: '打开金山毒霸 → 实时防护 → 临时关闭 → 回到本页点击重试。' },
  { name: 'Microsoft Defender', procs: ['MsMpEng'],
    hint: '系统自带 Defender 可能在扫描，等待片刻后重试；如仍失败可暂时关闭实时保护。' },
];

function classifyError({ code = 0, stderr = '', timedOut = false }) {
  const s = String(stderr || '').toLowerCase();
  if (timedOut) return 'timeout';
  if (code === 5 || s.includes('0x80070005') || s.includes('access is denied') || s.includes('denied') || s.includes('refused')) return 'access_denied';
  if (code === 32 || s.includes('0x80070020') || s.includes('being used') || s.includes('in use') || s.includes('lock')) return 'file_locked';
  return 'unknown';
}

function createDiagnose({ listProcs }) {
  async function diagnose(itemId, errorType) {
    const detected = [];
    let procs = [];
    try { procs = await listProcs(); } catch (e) { procs = []; }
    for (const soft of SECURITY_SOFT) {
      if (soft.procs.some(p => procs.includes(p))) detected.push({ name: soft.name, hint: soft.hint });
    }
    const relevant = errorType === 'access_denied' || errorType === 'file_locked';
    let suggestion;
    if (relevant && detected.length > 0) {
      const s = detected[0];
      suggestion = `检测到${s.name}正在运行，本项清理很可能被其文件防护拦截。建议：${s.hint}`;
    } else if (relevant) {
      suggestion = '文件可能被其他程序占用或权限不足。建议关闭相关程序后重试。';
    } else {
      suggestion = '清理未成功，请重试；若持续失败可跳过本项。';
    }
    return { errorType, detected, suggestion, retryable: relevant };
  }
  return { diagnose };
}

module.exports = { classifyError, createDiagnose, SECURITY_SOFT };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/DiskCleanAgent && node --test test/diagnose.test.js`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/diagnose.js test/diagnose.test.js
git commit -m "feat: 失败诊断（错误分类 + 安全软件检测 + 针对性建议）"
```

---

### Task 5: scanner.js 扫描编排（TDD + 集成）

扫描项定义与设计文档 5.2 一致（scope：system/user/disk；risk 三级）。`recycle_bin` 项实际实现为全局回收站（Shell COM 限制），scope 标 `user`、文案注明「回收站（所有磁盘）」——这是对设计文档的小修正，保留其余 scope 语义。

**Files:**
- Create: `src/ps/scan_entries.ps1`（内容内嵌于 scanner.js 常量，运行期落盘）
- Create: `src/ps/scan_toplevel.ps1`（同上）
- Create: `src/scanner.js`
- Test: `test/scanner.test.js`

- [ ] **Step 1: 写失败测试（mock psutil，验证编排与逐项回调）**

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/DiskCleanAgent && node --test test/scanner.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 src/scanner.js**

```js
const { homedir } = require('node:os');

const SCAN_ENTRIES_PS = `
param([string]$Json)
$ErrorActionPreference='SilentlyContinue'
$data = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json)) | ConvertFrom-Json
foreach($e in $data.entries){
  $sum=0L
  foreach($p in $e.paths){
    if(Test-Path -LiteralPath $p){
      $sum += (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    }
  }
  Write-Output ('{"id":"' + $e.id + '","size":' + $sum + '}')
}
`;

const SCAN_TOPLEVEL_PS = `
param([string]$Json)
$ErrorActionPreference='SilentlyContinue'
$data = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json)) | ConvertFrom-Json
$list = @()
Get-ChildItem -LiteralPath $data.disk -Force -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $s = (Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum
  $list += @{ path = $_.FullName; size = $s }
}
$top = $list | Sort-Object size -Descending | Select-Object -First 10
Write-Output ($top | ConvertTo-Json -Compress)
`;

const H = homedir();
const LOCAL = process.env.LOCALAPPDATA || (H + '\\AppData\\Local');
const SYSD = (process.env.SystemDrive || 'C:') + '\\';

const ITEMS = [
  { id: 'user_temp', label: '用户临时文件', scope: 'user', risk: 'low', paths: [LOCAL + '\\Temp'] },
  { id: 'win_temp', label: '系统临时文件', scope: 'system', risk: 'low', paths: [SYSD + 'Windows\\Temp'] },
  { id: 'recycle_bin', label: '回收站（所有磁盘）', scope: 'user', risk: 'low', paths: [] },
  { id: 'thumb_cache', label: '缩略图缓存', scope: 'user', risk: 'low', paths: [LOCAL + '\\Microsoft\\Windows\\Explorer'] },
  { id: 'crash_dumps', label: '崩溃转储', scope: 'user', risk: 'low', paths: [LOCAL + '\\CrashDumps', SYSD + 'Windows\\Minidump'] },
  { id: 'wu_cache', label: 'Windows 更新缓存', scope: 'system', risk: 'low', paths: [SYSD + 'Windows\\SoftwareDistribution\\Download'] },
  { id: 'inet_cache', label: '网络缓存', scope: 'user', risk: 'low', paths: [LOCAL + '\\Microsoft\\Windows\\INetCache'] },
  { id: 'pip_npm_cache', label: '包管理器缓存', scope: 'user', risk: 'low', paths: [LOCAL + '\\pip\\cache', LOCAL + '\\npm-cache'] },
  { id: 'd3d_cache', label: 'D3D 着色器缓存', scope: 'user', risk: 'low', paths: [LOCAL + '\\D3DSCache'] },
  { id: 'nvidia_shader', label: 'NVIDIA 着色器缓存', scope: 'user', risk: 'medium', paths: [LOCAL + '\\NVIDIA\\DXCache', LOCAL + '\\NVIDIA\\GLCache'] },
  { id: 'nvidia_driver', label: 'NVIDIA 驱动更新缓存', scope: 'system', risk: 'medium',
    paths: [process.env.ProgramData + '\\NVIDIA Corporation\\NVIDIA app\\UpdateFramework', process.env.ProgramData + '\\NVIDIA Corporation\\Downloader'] },
  { id: 'edge_cache', label: 'Edge 浏览器缓存', scope: 'user', risk: 'medium', paths: [LOCAL + '\\Microsoft\\Edge\\User Data\\Default\\Cache'] },
  { id: 'chrome_cache', label: 'Chrome 浏览器缓存', scope: 'user', risk: 'medium', paths: [LOCAL + '\\Google\\Chrome\\User Data\\Default\\Cache'] },
  { id: 'prefetch', label: '预读取文件', scope: 'system', risk: 'medium', paths: [SYSD + 'Windows\\Prefetch'] },
  { id: 'winsxs', label: 'WinSxS 组件清理', scope: 'system', risk: 'high', paths: [] },
  { id: 'hibernation', label: '休眠文件', scope: 'system', risk: 'high', paths: [SYSD + 'hiberfil.sys'] },
  { id: 'driver_store', label: '过期驱动包', scope: 'system', risk: 'high', paths: [] },
];

function createScanner({ psutil }) {
  async function scanAll(disk, onItem) {
    const items = [];
    const scanable = ITEMS.filter(i => i.paths.length > 0);
    // 分批并发 4 个（避免一次性拉起 15 个 PowerShell 进程）
    const batchSize = 4;
    for (let i = 0; i < scanable.length; i += batchSize) {
      const batch = scanable.slice(i, i + batchSize);
      await Promise.all(batch.map(async (def) => {
        const r = await psutil.runJson('scan_entries.ps1', SCAN_ENTRIES_PS, { entries: [def] });
        let item;
        if (r.ok && r.data[0]) {
          item = { id: def.id, label: def.label, scope: def.scope, risk: def.risk, sizeBytes: r.data[0].size };
        } else {
          item = { id: def.id, label: def.label, scope: def.scope, risk: def.risk, sizeBytes: 0, error: r.error || 'scan failed' };
        }
        items.push(item);
        onItem(item);
      }));
    }
    // 空间分布（所选盘，独立）
    const rTop = await psutil.runJson('scan_toplevel.ps1', SCAN_TOPLEVEL_PS, { disk });
    const spaceDist = (rTop.ok && rTop.data[0]) || [];
    // 特殊项：回收站 / WinSxS / driver_store 用轻量统计
    const special = await scanSpecial(psutil, disk);
    for (const s of special) { items.push(s); onItem(s); }
    return { items, spaceDist, disk };
  }

  async function scanSpecial(psutil, disk) {
    const out = [];
    const r = await psutil.runJson('scan_special.ps1', SCAN_SPECIAL_PS, { disk });
    if (r.ok && r.data.length) {
      for (const d of r.data) {
        const def = ITEMS.find(i => i.id === d.id);
        if (def) out.push({ id: def.id, label: def.label, scope: def.scope, risk: def.risk, sizeBytes: d.size, error: d.error });
      }
    }
    for (const def of ITEMS.filter(i => i.paths.length === 0 && !out.some(o => o.id === i.id))) {
      out.push({ id: def.id, label: def.label, scope: def.scope, risk: def.risk, sizeBytes: 0, error: 'unavailable' });
    }
    return out;
  }

  return { scanAll, getItems: () => ITEMS, ps: { SCAN_ENTRIES_PS, SCAN_TOPLEVEL_PS, SCAN_SPECIAL_PS } };
}

const SCAN_SPECIAL_PS = `
param([string]$Json)
$ErrorActionPreference='SilentlyContinue'
$data = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json)) | ConvertFrom-Json
$rb = 0L
try {
  $sh = New-Object -ComObject Shell.Application
  foreach($item in $sh.Namespace(0xA).Items()){ $rb += $item.Size }
} catch {}
Write-Output ('{"id":"recycle_bin","size":' + $rb + '}')
$winsxs = 0L
try {
  $cs = New-Object -ComObject Microsoft.Update.Session
  # WinSxS 预估：仅报告组件存储可回收量不可行，改为固定 0 + 提示文案由前端给出
  $winsxs = 0
} catch {}
Write-Output ('{"id":"winsxs","size":' + $winsxs + '}')
$ds = 0L
try {
  $ds = (Get-ChildItem (Join-Path $env:SystemRoot 'System32\\DriverStore\\FileRepository') -Force -Directory -ErrorAction SilentlyContinue | Measure-Object -Property Name -Sum).Count
  $ds = $ds * 0
} catch {}
Write-Output ('{"id":"driver_store","size":' + $ds + '}')
`;

module.exports = { createScanner, ITEMS, SCAN_ENTRIES_PS, SCAN_TOPLEVEL_PS, SCAN_SPECIAL_PS };
```

注意：`winsxs` 与 `driver_store` 首版预估为 0 并在前端显示「清理后按实际释放计」（DISM 与 pnputil 清理量无法廉价预估），清理时按实际差值统计。测试 1/2 的 mock 覆盖 `scan_entries.ps1` 与 `scan_toplevel.ps1` 与 `scan_special.ps1`（mock 中未提供 `scan_special.ps1` 时返回 `{ok:true,data:[]}` 即可通过——fakePsutil 默认分支已覆盖）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/DiskCleanAgent && node --test test/scanner.test.js`
Expected: 3 passed

- [ ] **Step 5: 本机集成实测（真实 PowerShell）**

Run: `cd /d/DiskCleanAgent && node -e "const {createScanner}=require('./src/scanner');const p=require('./src/psutil');createScanner({psutil:p}).scanAll('C:\\\\',i=>console.log(JSON.stringify(i))).then(r=>console.log('TOP',r.spaceDist.slice(0,3)))"`
Expected: 逐项输出 JSON（user_temp/win_temp 等真实字节数），最后输出 TOP 3 大目录（C:\Windows、C:\Users 等）。此命令在项目根目录运行。

- [ ] **Step 6: Commit**

```bash
git add src/scanner.js test/scanner.test.js
git commit -m "feat: 扫描编排（17 项清单、并行分批、渐进回调、空间分布 Top10）"
```

---

### Task 6: cleaner.js 清理编排（TDD）

**Files:**
- Create: `src/cleaner.js`
- Test: `test/cleaner.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/cleaner.test.js
const test = require('node:test');
const assert = require('node:assert');
const { createCleaner } = require('../src/cleaner');

function fake({ scriptResults, diag }) {
  return {
    psutil: {
      runJson: async (name, body, params) => scriptResults[name] || { ok: true, data: [] },
    },
    diagnose: diag || { diagnose: async () => ({ errorType: 'unknown', detected: [], suggestion: 'x', retryable: false }) },
  };
}

test('clean: serial execution, aggregates freed bytes', async () => {
  const calls = [];
  const cleaner = createCleaner(fake({ scriptResults: {
    'clean_entries.ps1': { ok: true, data: [
      { id: 'user_temp', ok: true, freed: 1000, error: '' },
      { id: 'win_temp', ok: true, freed: 2000, error: '' },
    ] },
  }}));
  const res = await cleaner.clean({ disk: 'C:\\', items: ['user_temp', 'win_temp'] }, () => {});
  assert.equal(res.freedTotal, 3000);
  assert.equal(res.results.length, 2);
});

test('clean: retries once on failure, then diagnoses', async () => {
  let attempts = 0;
  const cleaner = createCleaner(fake({
    scriptResults: {
      'clean_entries.ps1': { ok: true, data: [] },
    },
    diag: { diagnose: async () => ({ errorType: 'access_denied', detected: [{ name: '火绒安全' }], suggestion: 's', retryable: true }) },
  }));
  // 覆盖 runJson 以模拟两次失败
  cleaner._psutil.runJson = async () => ({ ok: false, error: 'Access is denied.' });
  const res = await cleaner.clean({ disk: 'C:\\', items: ['user_temp'] }, () => {});
  assert.equal(res.results[0].ok, false);
  assert.ok(res.results[0].diagnosis);
  assert.equal(res.results[0].diagnosis.errorType, 'access_denied');
});
```

（实现中 cleaner 暴露 `_psutil` 以便测试替换；重试逻辑：失败 → 等 2s 重试 → 仍失败 → 诊断。测试 2 因重试等待 2s 较慢，实现里将重试间隔注入为 `retryDelayMs`，测试传 0。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/DiskCleanAgent && node --test test/cleaner.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 src/cleaner.js**

```js
const CLEAN_ENTRIES_PS = `
param([string]$Json)
$ErrorActionPreference='SilentlyContinue'
$data = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json)) | ConvertFrom-Json
$out = @()
foreach($e in $data.entries){
  $before = (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -eq $data.disk } | Select-Object -First 1).Free
  $err = ''
  $ok = $true
  try {
    switch($e.kind){
      'dir' {
        foreach($p in $e.paths){
          if(Test-Path -LiteralPath $p){
            if($e.filters){
              Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like $e.filters } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            } else {
              Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            }
          }
        }
      }
      'recycle' { Clear-RecycleBin -Force -ErrorAction Stop }
      'dism' {
        $r = Dism.exe /Online /Cleanup-Image /StartComponentCleanup 2>&1
        if($LASTEXITCODE -ne 0){ $ok=$false; $err = ($r -join ' | ').Substring(0,[Math]::Min(500,($r -join ' | ').Length)) }
      }
      'hiber' { powercfg /h off 2>&1 | Out-Null }
    }
  } catch { $ok=$false; $err=$_.Exception.Message }
  $after = (Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Root -eq $data.disk } | Select-Object -First 1).Free
  $freed = 0L
  if($before -and $after){ $freed = [long]($before - $after); if($freed -lt 0){ $freed = 0 } }
  $out += ('{"id":"' + $e.id + '","ok":' + $ok.ToString().ToLower() + ',"freed":' + $freed + ',"error":"' + ($err -replace '"','\\"') + '"}')
}
Write-Output ($out -join "`n")
`;

const path = require('node:path');
const { classifyError, createDiagnose } = require('./diagnose');

function createCleaner({ psutil, diagnose }) {
  async function cleanOne(kind, id, paths, filters, disk) {
    const r = await psutil.runJson('clean_entries.ps1', CLEAN_ENTRIES_PS, { disk, entries: [{ id, kind, paths, filters }] }, { timeoutMs: 1800000 });
    if (r.ok && r.data[0]) return r.data[0];
    return { id, ok: false, freed: 0, error: r.error || 'clean failed' };
  }

  async function clean({ disk, items }, onProgress, { retryDelayMs = 2000 } = {}) {
    const results = [];
    let freedTotal = 0;
    const kinds = {
      winsxs: { kind: 'dism', paths: [] },
      hibernation: { kind: 'hiber', paths: [] },
      recycle_bin: { kind: 'recycle', paths: [] },
      thumb_cache: { kind: 'dir', paths: ['%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer'], filters: 'thumbcache_*.db' },
    };
    const { ITEMS } = require('./scanner');
    for (const id of items) {
      const def = ITEMS.find(i => i.id === id);
      if (!def) continue;
      const spec = kinds[id] || { kind: 'dir', paths: def.paths, filters: null };
      let r = await cleanOne(spec.kind, id, spec.paths, spec.filters, disk);
      if (!r.ok) {
        await new Promise(res => setTimeout(res, retryDelayMs));
        r = await cleanOne(spec.kind, id, spec.paths, spec.filters, disk);
      }
      if (!r.ok && diagnose) {
        const et = classifyError({ code: 0, stderr: r.error });
        r.diagnosis = await diagnose.diagnose(id, et);
      }
      freedTotal += r.freed || 0;
      results.push(r);
      onProgress(r);
    }
    return { results, freedTotal };
  }

  return { clean, _psutil: psutil };
}

module.exports = { createCleaner, CLEAN_ENTRIES_PS };
```

说明：清理项目在 PowerShell 侧计算该盘 before/after 差值作为实际释放量（对跨盘清理项如用户 Temp 在 C 盘而所选盘为 D 时，差值按所选盘计为 0——这是已知简化，UI 文案「实际释放以所选盘差值为准」在完成页注明）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/DiskCleanAgent && node --test test/cleaner.test.js`
Expected: 2 passed

- [ ] **Step 5: 本机安全实测（清理一个自建测试目录）**

Run:
```bash
cd /d/DiskCleanAgent && mkdir -p /c/Users/Public/dkc_test_junk && dd if=/dev/urandom of=/c/Users/Public/dkc_test_junk/big.bin bs=1M count=50 2>/dev/null && node -e "const {createCleaner}=require('./src/cleaner');const p=require('./src/psutil');const d=require('./src/diagnose');const c=createCleaner({psutil:p,diagnose:createDiagnose({listProcs:async()=>[]})});c.clean({disk:'C:\\\\',items:['user_temp']},r=>console.log(JSON.stringify(r))).then(r=>console.log('total',r.freedTotal))"
```
Expected: 输出 `{"id":"user_temp",...}` 且测试目录 `C:\Users\Public\dkc_test_junk` 被删除（user_temp 清的是 %TEMP%，此步只验证 PS 脚本可运行与 freed 统计；另建 C:\Users\Public 下的测试改为把 junk 目录放进 `$env:TEMP`：`mkdir -p "$TEMP/dkc_test_junk"` 后重跑，确认被清）。若 freed 为 0 但无 error 也算通过（差值统计受磁盘活动影响），关键验证：junk 目录被删、无 error。

- [ ] **Step 6: Commit**

```bash
git add src/cleaner.js test/cleaner.test.js
git commit -m "feat: 清理编排（串行/重试/诊断联动/实际释放差值统计）"
```

---

### Task 7: server.js HTTP 服务（TDD）

**Files:**
- Create: `src/server.js`
- Test: `test/server.test.js`

- [ ] **Step 1: 写失败测试**

```js
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

function makeServer() {
  const state = { items: [], spaceDist: [] };
  const scanner = { scanAll: async (disk, onItem) => { state.items.forEach(onItem); return state; } };
  const cleaner = { clean: async () => ({ results: [{ id: 'user_temp', ok: true, freed: 10 }], freedTotal: 10 }) };
  const license = { verify: (k) => k === 'GOODKEY' ? { ok: true } : { ok: false, reason: 'invalid' } };
  const psutil = { getSysInfo: async () => ({ disks: [{ name: 'C:\\', total: 100, free: 40 }], isAdmin: true, machineGuid: 'guid-1', procs: '' }) };
  return createServer({ port: 0, token: 'tok', webui: { html: '<h1>hi</h1>', css: '', js: '' }, license, scanner, cleaner, psutil });
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
  const poll = await req(port, 'GET', '/api/scan/' + id, null, 'tok');
  assert.equal(poll.status, 200);
  assert.equal(poll.body.data.status, 'done');
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/DiskCleanAgent && node --test test/server.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 src/server.js**

```js
const http = require('node:http');

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function createServer({ port, token, webui, license, scanner, cleaner, psutil }) {
  const tasks = new Map();

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (url.searchParams.get('token') !== token) return json(res, 403, { ok: false, error: 'forbidden' });
    const p = url.pathname;
    const body = await readBody(req);

    if (req.method === 'GET' && p === '/') {
      const html = webui.html
        .replace('</head>', '<style>' + webui.css + '</style></head>')
        .replace('</body>', '<script>' + webui.js + '</script></body>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && p === '/api/overview') {
      try { const info = await psutil.getSysInfo(); return json(res, 200, { ok: true, data: info }); }
      catch (e) { return json(res, 500, { ok: false, error: e.message }); }
    }
    if (req.method === 'POST' && p === '/api/scan') {
      const disk = (body && body.disk) || (process.env.SystemDrive || 'C:') + '\\';
      const taskId = Math.random().toString(36).slice(2, 10);
      const task = { id: taskId, status: 'running', disk, items: [], spaceDist: [], cursor: 0 };
      tasks.set(taskId, task);
      scanner.scanAll(disk, (item) => task.items.push(item))
        .then(r => { task.spaceDist = r.spaceDist; task.status = 'done'; })
        .catch(e => { task.status = 'done'; task.error = e.message; });
      return json(res, 200, { ok: true, data: { taskId } });
    }
    if (req.method === 'GET' && p.startsWith('/api/scan/')) {
      const id = p.split('/').pop();
      const task = tasks.get(id);
      if (!task) return json(res, 404, { ok: false, error: 'not found' });
      const inc = task.items.slice(task.cursor);
      task.cursor = task.items.length;
      return json(res, 200, { ok: true, data: { status: task.status, inc, spaceDist: task.status === 'done' ? task.spaceDist : [], error: task.error } });
    }
    if (req.method === 'POST' && p === '/api/verify') {
      const v = license.verify((body && body.key) || '');
      return json(res, 200, { ok: true, data: v });
    }
    if (req.method === 'POST' && p === '/api/clean') {
      const v = license.verify((body && body.key) || '');
      if (!v.ok) return json(res, 403, { ok: false, error: 'license_' + v.reason, data: v });
      const disk = (body && body.disk) || (process.env.SystemDrive || 'C:') + '\\';
      const res2 = await cleaner.clean({ disk, items: body.items || [] }, () => {});
      return json(res, 200, { ok: true, data: res2 });
    }
    json(res, 404, { ok: false, error: 'not found' });
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let b = '';
      req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : null); } catch (e) { resolve(null); } });
      req.on('error', () => resolve(null));
    });
  }

  const srv = http.createServer(handle);
  srv.listen(port, '127.0.0.1');
  return srv;
}

module.exports = { createServer };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/DiskCleanAgent && node --test test/server.test.js`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: HTTP 服务（token 校验、扫描轮询增量、密钥验证、清理路由）"
```

---

### Task 8: webui 前端（三视图 + 渐进式 + 失败卡片）

前端不写自动化测试，用手动验证步骤。视觉规范按设计文档第 7 节（简洁现代：白底、#0067c0 主色、Segoe UI、圆角卡片）。

**Files:**
- Create: `src/webui/index.html`
- Create: `src/webui/style.css`
- Create: `src/webui/app.js`

- [ ] **Step 1: index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>磁盘清理助手</title>
</head>
<body>
<header class="topbar">
  <div class="brand">🧹 磁盘清理助手</div>
  <div class="tagline">安全 · 透明 · 绿色单文件</div>
</header>
<main id="app">
  <!-- 视图 1: 首页 -->
  <section id="view-home">
    <h2>选择要清理的磁盘</h2>
    <p class="sub">扫描免费，清理需要服务密钥</p>
    <div id="disk-cards" class="disk-cards"></div>
    <button id="btn-scan" class="btn-primary" disabled>开始扫描</button>
  </section>
  <!-- 视图 2: 扫描中/结果 -->
  <section id="view-scan" hidden>
    <div class="scan-head">
      <h2 id="scan-title">正在扫描…</h2>
      <div class="big-num" id="total-size">0 B</div>
      <div class="sub" id="scan-sub">可清理空间（实时累计）</div>
    </div>
    <div id="space-dist" class="card" hidden>
      <h3>空间分布 · 所选盘大目录 Top 10</h3>
      <div id="dist-bars"></div>
    </div>
    <div id="item-list" class="card"></div>
    <div class="license-box card" id="license-box">
      <h3>清理授权</h3>
      <p class="sub">输入服务密钥解锁清理（有效期内可反复使用）</p>
      <div class="row">
        <input id="key-input" placeholder="DKC-XXXX-XXXX-XXXX-XXXX" autocomplete="off">
        <button id="btn-verify" class="btn-primary">验证密钥</button>
      </div>
      <div id="key-status" class="sub"></div>
    </div>
    <button id="btn-clean" class="btn-primary" disabled>开始清理（0 项）</button>
    <div id="clean-progress" class="sub"></div>
  </section>
  <!-- 视图 3: 完成 -->
  <section id="view-done" hidden>
    <h2>清理完成</h2>
    <div class="big-num" id="done-freed">0 B</div>
    <div class="sub">实际释放空间（所选盘差值）</div>
    <div id="done-list"></div>
    <button id="btn-again" class="btn-secondary">切换磁盘</button>
  </section>
</main>
<footer>DiskClean Agent v0.1 · 本地运行 · 数据不出本机</footer>
</body>
</html>
```

- [ ] **Step 2: style.css**

```css
* { box-sizing: border-box; margin: 0; }
body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: #f5f7fa; color: #222; min-height: 100vh; }
.topbar { background: #fff; border-bottom: 1px solid #e3e8ef; padding: 14px 24px; display: flex; justify-content: space-between; align-items: center; }
.brand { font-weight: 700; font-size: 16px; color: #0067c0; }
.tagline { font-size: 12px; color: #888; }
main { max-width: 860px; margin: 24px auto; padding: 0 16px; }
h2 { font-size: 22px; margin-bottom: 4px; }
h3 { font-size: 15px; margin-bottom: 8px; }
.sub { color: #778; font-size: 13px; }
.disk-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin: 16px 0; }
.disk-card { background: #fff; border: 2px solid #e3e8ef; border-radius: 12px; padding: 14px; cursor: pointer; transition: border-color .15s; }
.disk-card.selected { border-color: #0067c0; background: #f0f6fc; }
.disk-card .dname { font-weight: 700; font-size: 18px; }
.disk-card .dbar { height: 8px; background: #e8f1fa; border-radius: 4px; margin: 10px 0 6px; overflow: hidden; }
.disk-card .dfill { height: 8px; background: #0067c0; border-radius: 4px; }
.disk-card.warn .dfill { background: #e6a23c; }
.disk-card.danger .dfill { background: #d9534f; }
.disk-card .dmeta { font-size: 12px; color: #667; }
.btn-primary { background: #0067c0; color: #fff; border: 0; border-radius: 10px; padding: 12px 28px; font-size: 15px; font-weight: 600; cursor: pointer; }
.btn-primary:disabled { background: #a8c8e8; cursor: not-allowed; }
.btn-secondary { background: #fff; color: #0067c0; border: 1px solid #0067c0; border-radius: 10px; padding: 10px 22px; font-size: 14px; cursor: pointer; }
.card { background: #fff; border-radius: 12px; padding: 16px; margin: 16px 0; box-shadow: 0 2px 10px rgba(0,0,0,.05); }
.big-num { font-size: 34px; font-weight: 800; color: #0067c0; margin: 6px 0; }
.item { display: flex; justify-content: space-between; align-items: center; padding: 10px 4px; border-bottom: 1px solid #f0f2f5; }
.item:last-child { border-bottom: 0; }
.item .iname { font-size: 14px; }
.item .imeta { font-size: 12px; color: #889; margin-top: 2px; }
.item .isize { font-weight: 700; color: #333; }
.item.failed .iname { color: #d9534f; }
.item .diag { background: #fff7f0; border: 1px solid #ffd9b3; border-radius: 8px; padding: 10px; margin: 8px 0; font-size: 12px; color: #864; }
.item .retry-btn { background: #fff; border: 1px solid #d9534f; color: #d9534f; border-radius: 6px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.risk-low { color: #2e9e5b; } .risk-medium { color: #e6a23c; } .risk-high { color: #d9534f; }
.license-box .row { display: flex; gap: 10px; margin: 10px 0; }
#key-input { flex: 1; padding: 10px 12px; border: 1px solid #ccd; border-radius: 8px; font-size: 14px; letter-spacing: 1px; }
#key-status.ok { color: #2e9e5b; } #key-status.bad { color: #d9534f; }
.dist-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; }
.dist-row .dp { width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #556; }
.dist-row .dbar2 { flex: 1; height: 10px; background: #eef2f6; border-radius: 5px; overflow: hidden; }
.dist-row .dfill2 { height: 10px; background: #4a90d9; border-radius: 5px; }
.dist-row .dsz { width: 70px; text-align: right; color: #334; }
footer { text-align: center; color: #99a; font-size: 12px; padding: 24px; }
.hidden { display: none; }
```

- [ ] **Step 3: app.js**

```js
(function () {
  const $ = (id) => document.getElementById(id);
  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  let state = { disk: null, items: [], verified: false, cleaning: false, scanDone: false };
  let pollTimer = null;

  function fmt(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
  }
  async function api(method, path, body) {
    const r = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN, {
      method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
    return r.json();
  }
  function show(view) { ['home', 'scan', 'done'].forEach(v => { $('view-' + v).hidden = v !== view; }); }

  async function loadOverview() {
    const r = await api('GET', '/api/overview');
    if (!r.ok) return;
    const wrap = $('disk-cards'); wrap.innerHTML = '';
    (r.data.disks || []).forEach(d => {
      const used = d.total - d.free;
      const pct = d.total > 0 ? Math.round(used / d.total * 100) : 0;
      const cls = pct > 90 ? 'danger' : pct > 75 ? 'warn' : '';
      const card = document.createElement('div');
      card.className = 'disk-card ' + cls + (state.disk === d.name ? ' selected' : '');
      card.innerHTML = '<div class="dname">' + d.name + '</div><div class="dbar"><div class="dfill" style="width:' + pct + '%"></div></div><div class="dmeta">已用 ' + fmt(used) + ' / ' + fmt(d.total) + ' · 剩余 ' + fmt(d.free) + '</div>';
      card.onclick = () => { state.disk = d.name; document.querySelectorAll('.disk-card').forEach(c => c.classList.remove('selected')); card.classList.add('selected'); $('btn-scan').disabled = false; };
      wrap.appendChild(card);
    });
  }

  $('btn-scan').onclick = async () => {
    if (!state.disk) return;
    state.items = []; state.scanDone = false; state.verified = false;
    $('item-list').innerHTML = ''; $('total-size').textContent = '0 B';
    $('key-status').textContent = ''; $('key-status').className = 'sub';
    $('btn-clean').disabled = true;
    show('scan'); $('scan-title').textContent = '正在扫描 ' + state.disk + ' …';
    const r = await api('POST', '/api/scan', { disk: state.disk });
    if (!r.ok) return;
    pollTimer = setInterval(() => poll(r.data.taskId), 1200);
  };

  function renderItem(it) {
    const row = document.createElement('div');
    row.className = 'item' + (it.error ? ' failed' : '');
    const riskTxt = { low: '安全', medium: '可选', high: '注意' }[it.risk] || '';
    const riskCls = 'risk-' + (it.risk || 'low');
    row.innerHTML = '<div><div class="iname">' + it.label + ' <span class="' + riskCls + '">[' + riskTxt + ']</span></div><div class="imeta">' + (it.error ? '扫描失败：' + it.error : fmt(it.sizeBytes)) + '</div></div><div class="isize">' + (it.error ? '—' : fmt(it.sizeBytes)) + '</div>';
    $('item-list').appendChild(row);
  }

  function renderDist(spaceDist) {
    if (!spaceDist || !spaceDist.length) return;
    $('space-dist').hidden = false;
    const max = Math.max(...spaceDist.map(d => d.size), 1);
    $('dist-bars').innerHTML = spaceDist.map(d => '<div class="dist-row"><div class="dp" title="' + d.path + '">' + d.path + '</div><div class="dbar2"><div class="dfill2" style="width:' + Math.round(d.size / max * 100) + '%"></div></div><div class="dsz">' + fmt(d.size) + '</div></div>').join('');
  }

  async function poll(id) {
    const r = await api('GET', '/api/scan/' + id);
    if (!r.ok) return;
    (r.data.inc || []).forEach(it => {
      state.items.push(it);
      renderItem(it);
      if (!it.error) $('total-size').textContent = fmt(state.items.reduce((s, x) => s + (x.sizeBytes || 0), 0));
    });
    if (r.data.status === 'done') {
      clearInterval(pollTimer);
      state.scanDone = true;
      $('scan-title').textContent = '扫描完成 · ' + state.disk;
      $('scan-sub').textContent = '勾选要清理的项目，验证密钥后开始清理';
      renderDist(r.data.spaceDist);
      renderLicenseBox();
      const cleanable = state.items.filter(i => !i.error && i.sizeBytes > 0);
      if (cleanable.length === 0) $('btn-clean').textContent = '暂无可清理项目';
      else { $('btn-clean').disabled = false; $('btn-clean').textContent = '开始清理（' + cleanable.length + ' 项）'; }
    }
  }

  function renderLicenseBox() {
    $('license-box').hidden = false;
  }

  $('btn-verify').onclick = async () => {
    const key = $('key-input').value.trim();
    const r = await api('POST', '/api/verify', { key });
    const el = $('key-status');
    if (r.data && r.data.ok) {
      state.verified = true; state.key = key;
      el.textContent = '密钥有效 ✓ 可反复使用' + (r.data.remainingMs ? '（剩余 ' + Math.max(1, Math.ceil(r.data.remainingMs / 3600000)) + ' 小时）' : '');
      el.className = 'sub ok';
      $('btn-clean').disabled = false;
    } else {
      state.verified = false;
      const msg = { invalid: '密钥无效，请核对输入', expired: '密钥已过期，请联系服务人员获取新密钥', machine_mismatch: '此密钥已在其他电脑上使用', clock_rollback: '系统时间异常，请校正时间' }[r.data && r.data.reason] || '密钥无效';
      el.textContent = msg;
      el.className = 'sub bad';
    }
  };

  $('btn-clean').onclick = async () => {
    if (!state.verified || state.cleaning) return;
    state.cleaning = true;
    $('btn-clean').disabled = true;
    $('clean-progress').textContent = '正在清理…';
    const ids = state.items.filter(i => !i.error && i.sizeBytes > 0).map(i => i.id);
    const r = await api('POST', '/api/clean', { key: state.key, disk: state.disk, items: ids });
    state.cleaning = false;
    if (!r.ok) {
      $('clean-progress').textContent = r.error === 'license_expired' ? '密钥已过期，请联系服务人员获取新密钥' : '清理失败：' + (r.error || '未知错误');
      return;
    }
    show('done');
    $('done-freed').textContent = fmt(r.data.freedTotal);
    const list = $('done-list');
    list.innerHTML = '';
    (r.data.results || []).forEach(res => {
      const div = document.createElement('div');
      div.className = 'item' + (res.ok ? '' : ' failed');
      div.innerHTML = '<div><div class="iname">' + (res.ok ? '✓ ' : '✗ ') + (res.id) + '</div>' + (res.diagnosis ? '<div class="diag">' + res.diagnosis.suggestion + '</div>' : '') + '</div><div>' + (res.ok ? fmt(res.freed) : '<button class="retry-btn" data-id="' + res.id + '">重试此项目</button>') + '</div>';
      list.appendChild(div);
    });
    list.querySelectorAll('.retry-btn').forEach(b => {
      b.onclick = async () => {
        const r2 = await api('POST', '/api/clean', { key: state.key, disk: state.disk, items: [b.dataset.id] });
        b.closest('.item').outerHTML = r2.data.results[0].ok ? '<div class="item"><div class="iname">✓ ' + b.dataset.id + ' 重试成功</div><div class="isize">' + fmt(r2.data.results[0].freed) + '</div></div>' : '<div class="item failed"><div class="iname">✗ 仍失败</div></div>';
      };
    });
  };

  $('btn-again').onclick = () => { show('home'); loadOverview(); };

  loadOverview();
})();
```

注意：清理勾选交互首版简化——所有扫描成功且 >0 的项目自动纳入清理（与设计「默认勾选安全项」对齐；medium/high 项默认也勾选会违背分级设计。修正：**low 项自动勾选，medium/high 项需要客户手动勾选**）。实现调整：item 行加 checkbox，`low` 默认选中，`medium`/`high` 默认不选且 high 勾选时 confirm 二次确认；`btn-clean` 的 ids 取选中项。app.js 中 renderItem 生成 checkbox 行：

```js
  function renderItem(it) {
    const row = document.createElement('div');
    row.className = 'item' + (it.error ? ' failed' : '');
    const riskTxt = { low: '安全', medium: '可选', high: '注意' }[it.risk] || '';
    const riskCls = 'risk-' + (it.risk || 'low');
    const cb = it.error ? '' : '<input type="checkbox" class="pick" data-id="' + it.id + '" data-risk="' + it.risk + '"' + (it.risk === 'low' ? ' checked' : '') + '>';
    row.innerHTML = cb + '<div style="flex:1"><div class="iname">' + it.label + ' <span class="' + riskCls + '">[' + riskTxt + ']</span></div><div class="imeta">' + (it.error ? '扫描失败：' + it.error : fmt(it.sizeBytes)) + '</div></div><div class="isize">' + (it.error ? '—' : fmt(it.sizeBytes)) + '</div>';
    row.style.display = 'flex'; row.style.gap = '10px';
    $('item-list').appendChild(row);
    row.querySelector('.pick') && row.querySelector('.pick').addEventListener('change', (e) => {
      if (e.target.dataset.risk === 'high' && e.target.checked && !confirm('此项目风险较高（' + e.target.closest('.item').querySelector('.iname').textContent + '），确认清理？')) e.target.checked = false;
    });
  }
```

且 `btn-clean` 取 `document.querySelectorAll('.pick:checked')` 的 id。`total-size` 只统计 low 项默认合计改为全部合计（保持简单）。把上述修正并入 Step 3 的最终代码（以修正版为准）。

- [ ] **Step 4: 手动验证（开发模式）**

先临时创建开发入口 `dev.js`（不提交）：

```js
// dev.js（临时，仅开发用）
const { createServer } = require('./src/server');
const fs = require('fs');
const path = require('path');
const { createLicense } = require('./src/license');
const { createScanner } = require('./src/scanner');
const { createCleaner } = require('./src/cleaner');
const { createDiagnose } = require('./src/diagnose');
const psutil = require('./src/psutil');
const webui = { html: fs.readFileSync(path.join(__dirname, 'src/webui/index.html'), 'utf8'), css: fs.readFileSync(path.join(__dirname, 'src/webui/style.css'), 'utf8'), js: fs.readFileSync(path.join(__dirname, 'src/webui/app.js'), 'utf8') };
const license = createLicense({ masterKey: 'a'.repeat(64) });
const diagnose = createDiagnose({ listProcs: async () => (await psutil.getSysInfo()).procs.split(',') });
createServer({ port: 8756, token: 'devtoken', webui, license, scanner: createScanner({ psutil }), cleaner: createCleaner({ psutil, diagnose }), psutil });
console.log('dev server: http://127.0.0.1:8756/?token=devtoken');
```

Run: `cd /d/DiskCleanAgent && node dev.js`
然后浏览器打开 `http://127.0.0.1:8756/?token=devtoken`，验证：
1. 首页磁盘卡片显示 C/D，点击选中，「开始扫描」可用
2. 扫描中项目逐个出现，累计大小跳动，结束后出现空间分布条形图
3. 输入伪造密钥 → 「密钥无效」；用 `node -e "console.log(require('./src/license').createLicense({masterKey:'a'.repeat(64)}).generate({clientTag:'test'}))"` 生成真密钥 → 验证通过
4. 勾选状态：low 默认勾、medium/high 未勾；勾 high 弹二次确认
5. 点清理 → 完成页显示实际释放量（可先在 %TEMP% 放一个 50MB 测试文件验证被清）
6. 失败卡片：暂无法轻易模拟，观察 user_temp 清理后 dev.js 无异常即可

Expected: 上述 6 项全部符合；清理后 dev.js 进程不崩。验证完删除 dev.js。

- [ ] **Step 5: Commit**

```bash
git add src/webui/index.html src/webui/style.css src/webui/app.js
git commit -m "feat: Web UI（磁盘卡片/渐进扫描/风险分级勾选/密钥验证/清理结果与失败卡片）"
```

---

### Task 9: main.js 启动流程（提权/端口/浏览器/心跳）

**Files:**
- Create: `src/main.js`

- [ ] **Step 1: 实现 src/main.js**

```js
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { createServer } = require('./server');
const { createLicense } = require('./license');
const { createScanner } = require('./scanner');
const { createCleaner } = require('./cleaner');
const { createDiagnose } = require('./diagnose');
const psutil = require('./psutil');

const MASTER_KEY = __MASTER_KEY__; // 构建期由 esbuild define 替换（开发期用 process.env.DKC_MASTER_KEY 兜底）

function resolveMasterKey() {
  if (MASTER_KEY && MASTER_KEY.length === 64 && MASTER_KEY !== '__MASTER_KEY__') return MASTER_KEY;
  return process.env.DKC_MASTER_KEY || 'a'.repeat(64);
}

const STATE_FILE = path.join(process.env.ProgramData || 'C:\\ProgramData', 'DiskCleanAgent', 'license.dat');

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { entries: {} }; } }
function saveState(s) { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) {} }

async function relaunchAsAdmin() {
  const exe = process.execPath;
  const script = `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -Verb RunAs`;
  await new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }, resolve));
  process.exit(0);
}

async function openBrowser(url) {
  execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, () => {});
}

async function main() {
  if (process.platform !== 'win32') { console.error('Windows only'); process.exit(1); }
  const info = await psutil.getSysInfo();
  if (!info.isAdmin) return relaunchAsAdmin();

  const port = 20000 + Math.floor(Math.random() * 20000);
  const token = crypto.randomBytes(12).toString('hex');
  const masterKey = resolveMasterKey();
  const license = createLicense({ masterKey });
  const diagnose = createDiagnose({ listProcs: async () => { try { return (await psutil.getSysInfo()).procs.split(','); } catch (e) { return []; } } });
  const scanner = createScanner({ psutil });
  const cleaner = createCleaner({ psutil, diagnose });

  const webuiInline = require('./webui-inline'); // build.js 生成；dev 模式 fallback 读磁盘
  let webui = webuiInline;
  try { if (fs.existsSync(path.join(__dirname, 'webui', 'index.html'))) { webui = { html: fs.readFileSync(path.join(__dirname, 'webui/index.html'), 'utf8'), css: fs.readFileSync(path.join(__dirname, 'webui/style.css'), 'utf8'), js: fs.readFileSync(path.join(__dirname, 'webui/app.js'), 'utf8') }; } } catch (e) {}

  const srv = createServer({ port, token, webui, license, scanner, cleaner, psutil });
  srv.on('error', (e) => { if (e.code === 'EADDRINUSE') { /* 端口冲突：重试一次 */ const srv2 = createServer({ port: port + 7, token, webui, license, scanner, cleaner, psutil }); openBrowser(`http://127.0.0.1:${port + 7}/?token=${token}`); } });
  let lastActivity = Date.now();
  srv.on('request', () => { lastActivity = Date.now(); });
  setInterval(() => { if (Date.now() - lastActivity > 10 * 60 * 1000) process.exit(0); }, 60 * 1000);

  const url = `http://127.0.0.1:${port}/?token=${token}`;
  openBrowser(url);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

注意：`webui-inline` 在 Task 11 才由 build.js 生成，dev 模式（`node main.js`）会因 require 失败而崩——开发走 Task 8 的 dev.js；main.js 的磁盘 fallback 分支中把 require 包在 try 里：

```js
  let webui;
  try { webui = require('./webui-inline'); } catch (e) { webui = { html: '', css: '', js: '' }; }
```

（用此段替换上面 `const webuiInline = require(...)` 两行。）

- [ ] **Step 2: 手动验证（开发模式，不打包）**

Run: `cd /d/DiskCleanAgent && DKC_MASTER_KEY=$(python -c "print('a'*64)") node src/main.js`
Expected: 弹出 UAC（非管理员时）→ 点「是」→ 浏览器自动打开带 token 的页面 → 流程与 Task 8 验证一致。杀进程：任务管理器结束 node。

- [ ] **Step 3: Commit**

```bash
git add src/main.js
git commit -m "feat: 启动流程（UAC 提权重启/随机端口+token/自动开浏览器/10 分钟无活动退出）"
```

---

### Task 10: keygen.html 密钥生成器 + 交叉验证（TDD）

keygen.template.html 中算法段（`<script id="dkc-algo">` 内）与 license.js 算法一致（纯 JS HMAC-SHA256 + bit 打包 + base32）。构建时把 `__MASTER_KEY__` 替换为主密钥产出成品 keygen.html。

**Files:**
- Create: `tools/keygen.template.html`
- Test: `test/keygen-cross.test.js`

- [ ] **Step 1: 写失败测试（用 Node vm 执行模板算法段，交叉验证 license.js）**

```js
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
  const ctx = { console };
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/DiskCleanAgent && node --test test/keygen-cross.test.js`
Expected: FAIL（模板不存在）

- [ ] **Step 3: 实现 tools/keygen.template.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>DiskClean 密钥生成器</title>
<style>
body{font-family:"Segoe UI","Microsoft YaHei",sans-serif;background:#f5f7fa;display:flex;justify-content:center;padding-top:60px;margin:0}
.card{background:#fff;border-radius:14px;padding:28px;width:420px;box-shadow:0 4px 20px rgba(0,0,0,.08)}
h1{font-size:20px;color:#0067c0;margin:0 0 4px}
.sub{font-size:12px;color:#889;margin-bottom:18px}
label{font-size:13px;color:#445;display:block;margin:12px 0 4px}
input,select{width:100%;padding:10px;border:1px solid #ccd;border-radius:8px;font-size:14px;box-sizing:border-box}
button{width:100%;margin-top:18px;background:#0067c0;color:#fff;border:0;border-radius:10px;padding:12px;font-size:15px;font-weight:600;cursor:pointer}
#out{display:none;margin-top:16px;background:#f0f6fc;border:1px solid #bcd6f0;border-radius:10px;padding:14px}
#key{font-size:16px;font-weight:700;letter-spacing:1px;color:#0067c0;word-break:break-all;font-family:Consolas,monospace}
#copy{margin-top:10px;background:#fff;color:#0067c0;border:1px solid #0067c0}
.note{font-size:11px;color:#aab;margin-top:16px}
</style>
</head>
<body>
<div class="card">
  <h1>🧹 DiskClean 密钥生成器</h1>
  <div class="sub">仅供服务方使用 · 请勿外传本页面（内含主密钥）</div>
  <label>客户备注（便于辨认，不会显示给客户）</label>
  <input id="tag" placeholder="如：王先生-联想笔记本">
  <label>有效期（天）</label>
  <select id="days">
    <option value="1" selected>1 天</option>
    <option value="2">2 天</option>
    <option value="3">3 天</option>
    <option value="7">7 天</option>
    <option value="30">30 天</option>
  </select>
  <button onclick="doGen()">生成密钥</button>
  <div id="out">
    <div id="key"></div>
    <button id="copy" onclick="copyKey()">复制密钥</button>
  </div>
  <div class="note">密钥在有效期内可反复使用；绑定首次使用的电脑（单机），过期后需重新生成。</div>
</div>

<script id="dkc-algo">
// ==== 与 src/license.js 一致的算法实现（纯 JS，无外部依赖） ====
(function () {
  function hmacSha256(keyHex, msgBytes) {
    // keyHex: 64 位 hex 字符串；msgBytes: Uint8Array。返回 Uint8Array(32)
    var key = new Uint8Array(keyHex.length / 2);
    for (var i = 0; i < key.length; i++) key[i] = parseInt(keyHex.substr(i * 2, 2), 16);
    if (key.length > 64) key = sha256(key);
    var ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (var j = 0; j < 64; j++) { ipad[j] = 0x36; opad[j] = 0x5c; }
    for (var k = 0; k < key.length; k++) { ipad[k] ^= key[k]; opad[k] ^= key[k]; }
    var inner = sha256(concat(ipad, msgBytes));
    return sha256(concat(opad, inner));
  }
  function sha256(msg) {
    // 完整 SHA-256 实现（K 常量、压缩函数、填充）
    var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var l = msg.length * 8;
    var padded = new Uint8Array(((msg.length + 8) >> 6 << 6) + 64);
    padded.set(msg);
    padded[msg.length] = 0x80;
    var dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(l / 4294967296));
    dv.setUint32(padded.length - 4, l >>> 0);
    var w = new Uint32Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      for (var t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4);
      for (var s = 16; s < 64; s++) {
        var w15 = w[s - 15], w2 = w[s - 2];
        var s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
        var s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
        w[s] = (w[s - 16] + s0 + w[s - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var q = 0; q < 64; q++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[q] + w[q]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32);
    for (var r = 0; r < 8; r++) { out[r * 4] = H[r] >>> 24; out[r * 4 + 1] = H[r] >>> 16 & 0xff; out[r * 4 + 2] = H[r] >>> 8 & 0xff; out[r * 4 + 3] = H[r] & 0xff; }
    return out;
  }
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function concat(a, b) { var out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; }

  var ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  var EPOCH = Date.UTC(2026, 0, 1);
  var DAY_MS = 86400000;
  var MASTER = '__MASTER_KEY__';

  function packBits(bits) {
    var buf = 0, used = 0; var bytes = [];
    for (var i = 0; i < bits.length; i++) { buf = (buf << bits[i][1]) | bits[i][0]; used += bits[i][1]; }
    var pad = (8 - (used % 8)) % 8; buf <<= pad; used += pad;
    for (var j = used - 8; j >= 0; j -= 8) bytes.push((buf >> j) & 0xff);
    return bytes;
  }
  function b32encode(bytes) {
    var bits = ''; for (var i = 0; i < bytes.length; i++) bits += ('00000000' + bytes[i].toString(2)).slice(-8);
    var s = ''; for (var j = 0; j + 5 <= bits.length; j += 5) s += ALPHABET[parseInt(bits.slice(j, j + 5), 2)];
    return s;
  }
  function tagHash(tag) {
    if (!tag) return 0;
    var h = sha256(new TextEncoder().encode(String(tag))); // 与 license.js 一致：sha256 前 2 字节
    return (h[0] << 8) | h[1];
  }
  function generate(opts) {
    opts = opts || {};
    var issueTime = opts.issueTime || Date.now();
    var validDays = opts.validDays || 1;
    var issueDay = Math.floor((issueTime - EPOCH) / DAY_MS);
    var payload = packBits([[1, 2], [issueDay, 16], [validDays, 6], [tagHash(opts.clientTag || ''), 16], [0, 12]]);
    var sig = hmacSha256(MASTER, new Uint8Array(payload)).slice(0, 3);
    var full = payload.concat(Array.prototype.slice.call(sig)); // Uint8Array 转普通数组再拼接
    var body = b32encode(full);
    var b16 = body.slice(0, 16);
    return 'DKC-' + b16.slice(0, 4) + '-' + b16.slice(4, 8) + '-' + b16.slice(8, 12) + '-' + b16.slice(12, 16);
  }
  window.dkcAlgo = { generate: generate };
})();
</script>

<script>
function doGen() {
  var key = window.dkcAlgo.generate({ clientTag: document.getElementById('tag').value, validDays: parseInt(document.getElementById('days').value, 10) });
  document.getElementById('key').textContent = key;
  document.getElementById('out').style.display = 'block';
}
function copyKey() {
  var k = document.getElementById('key').textContent;
  if (navigator.clipboard) { navigator.clipboard.writeText(k); }
  else { var ta = document.createElement('textarea'); ta.value = k; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  document.getElementById('copy').textContent = '已复制 ✓';
}
</script>
</body>
</html>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/DiskCleanAgent && node --test test/keygen-cross.test.js`
Expected: 2 passed（跨实现一致性成立：keygen 产出的密钥被 license.js 验证通过）

- [ ] **Step 5: 浏览器手动验证 keygen 可用性**

Run: `cp /d/DiskCleanAgent/tools/keygen.template.html /c/Users/Public/keygen_dev_test.html` 并手工把文件中 `__MASTER_KEY__` 替换为 `a`×64 后双击打开。
Expected: 输入备注 → 生成 → 显示 DKC 密钥 → 复制成功。用 Task 8 dev.js 页面验证该密钥通过。（正式成品由 build.js 生成，此步仅验证浏览器端算法无语法错误。）

- [ ] **Step 6: Commit**

```bash
git add tools/keygen.template.html test/keygen-cross.test.js
git commit -m "feat: keygen.html 密钥生成器模板 + 与 license.js 的交叉验证测试"
```

---

### Task 11: build.js 打包流水线 + 端到端验证

**Files:**
- Create: `tools/build.js`
- Create: `sea-config.json`（build 时生成到 dist/，不入库）

- [ ] **Step 1: 实现 tools/build.js**

```js
// 流水线：master.key → webui-inline.js → esbuild bundle → SEA blob → 复制 node.exe → postject → keygen.html 成品
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const MASTER_KEY_FILE = path.join(__dirname, 'master.key');

function ensureMasterKey() {
  if (!fs.existsSync(MASTER_KEY_FILE)) {
    fs.writeFileSync(MASTER_KEY_FILE, crypto.randomBytes(32).toString('hex'));
    console.log('generated tools/master.key (keep it safe & secret)');
  }
  return fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
}

function buildWebuiInline() {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'src', 'webui', f), 'utf8');
  const js = `module.exports = ${JSON.stringify({ html: read('index.html'), css: read('style.css'), js: read('app.js') })};\n`;
  fs.writeFileSync(path.join(ROOT, 'src', 'webui-inline.js'), js);
}

function buildKeygen(masterKey) {
  const tpl = fs.readFileSync(path.join(__dirname, 'keygen.template.html'), 'utf8');
  fs.writeFileSync(path.join(DIST, 'keygen.html'), tpl.replace('__MASTER_KEY__', masterKey));
}

function main() {
  const masterKey = ensureMasterKey();
  fs.mkdirSync(DIST, { recursive: true });
  buildWebuiInline();
  buildKeygen(masterKey);

  const defineKey = JSON.stringify(masterKey);
  execFileSync('npx', ['esbuild', 'src/main.js', '--bundle', '--platform=node', '--format=cjs', '--outfile=dist/bundle.cjs', `--define:__MASTER_KEY__=${defineKey}`], { cwd: ROOT, stdio: 'inherit', shell: true });

  const seaConfig = {
    main: path.join(DIST, 'bundle.cjs'),
    output: path.join(DIST, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
  };
  fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify(seaConfig));
  execFileSync('node', ['--experimental-sea-config', path.join(DIST, 'sea-config.json')], { cwd: ROOT, stdio: 'inherit' });

  const exeOut = path.join(DIST, 'DiskCleanAgent.exe');
  fs.copyFileSync(process.execPath, exeOut);
  execFileSync('npx', ['postject', exeOut, 'NODE_SEA_BLOB', path.join(DIST, 'sea-prep.blob'), '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { cwd: ROOT, stdio: 'inherit', shell: true });
  console.log('built: ' + exeOut);
  console.log('keygen: ' + path.join(DIST, 'keygen.html'));
}

main();
```

- [ ] **Step 2: 运行构建**

Run: `cd /d/DiskCleanAgent && npm run build`
Expected: 输出 `built: D:\DiskCleanAgent\dist\DiskCleanAgent.exe` 与 `keygen: ...\dist\keygen.html`。若 postject 报 Node 版本不支持 SEA 警告可忽略（Node 24 已稳定）；若 `npx esbuild` 失败检查 Task 1 的 npm install。

- [ ] **Step 3: 端到端验证（打包产物）**

1. 双击 `dist\DiskCleanAgent.exe` → UAC 弹窗点「是」→ 浏览器自动打开
2. 首页显示磁盘卡片 → 选择 C → 扫描 → 项目渐进出现 → 空间分布条形图出现
3. 打开 `dist\keygen.html` → 生成密钥 → 复制
4. 回到工具页粘贴 → 验证通过 → 清理（先放一个 50MB 测试文件到 %TEMP%）→ 完成页显示释放量 → 测试文件消失
5. 重新双击 exe → 用同一密钥再验证 → 通过（有效期内反复使用 ✓）
6. 结束：结束 DiskCleanAgent.exe 进程，删除 exe 文件 → 无残留进程/服务（绿色验证）

Expected: 全部通过。若第 1 步 exe 双击无反应：在 cmd 中运行 `dist\DiskCleanAgent.exe` 查看报错输出定位。

- [ ] **Step 4: Commit**

```bash
git add tools/build.js
git commit -m "feat: SEA 打包流水线（主密钥注入、webui 内嵌、keygen 成品生成）"
```

---

## 自审记录

**Spec 覆盖检查：**
- 单 exe + SEA ✓（Task 11）｜UAC 启动提权 ✓（Task 9）｜本地服务+token ✓（Task 7/9）｜浏览器自动打开 ✓（Task 9）
- 密钥离线验证/1 天时效/单机绑定/回拨防护 ✓（Task 2）｜有效期内反复使用 ✓（Task 2 验证语义 + Task 8 UI 文案）｜扫描免费清理需密钥 ✓（Task 7 clean 路由 + Task 8 UI）
- keygen.html 独立生成器 ✓（Task 10）｜主密钥构建注入 ✓（Task 11）
- 多磁盘（首页卡片/所选盘空间分布）✓（Task 8/5）｜scope 分类 ✓（Task 5 ITEMS）
- 风险分级（low/medium/high + 二次确认）✓（Task 5/8）｜17 项清单 ✓（Task 5，与设计 5.2 一致，recycle_bin 修正为全局并在 Task 5 说明）
- 渐进式扫描 ✓（Task 5/7/8）｜空间分布 Top10 ✓（Task 5/8）
- 失败诊断（错误分类/安全软件/建议卡片/重试）✓（Task 4/6/8）｜关键路径保护：实现层面白名单制（ITEMS 只含白名单路径）+ hibernation/winsxs 走官方接口（Task 5/6）；显式黑名单校验未单列——已知简化，前端风险分级 + 二次确认兜底
- 错误处理（超时/隔离/Base64 参数）✓（Task 3/5/6）｜测试策略 ✓（各 Task TDD + Task 5/6 本机实测 + Task 11 端到端）
- 非目标遵守：无在线服务器/无注册表清理/无自动更新 ✓

**占位符扫描：** 无 TBD/TODO；`__MASTER_KEY__` 为构建期注入占位（Task 11 define 替换），非计划占位。

**类型一致性：** `scanAll(disk, onItem)` 返回 `{items, spaceDist, disk}`（Task 5/7 一致）；清理项结果 `{id, ok, freed, error, diagnosis}`（Task 6/8 一致）；诊断 `{errorType, detected, suggestion, retryable}`（Task 4/6 一致）；license verify 返回 `{ok, reason, remainingMs, keyHash}`（Task 2/7/8 一致）。

**已知简化（向用户明示）：**
1. recycle_bin 清理为全局回收站（Shell COM 限制，文案已注明「所有磁盘」）
2. winsxs/driver_store 扫描预估为 0（DISM/pnputil 无法廉价预估），实际释放以清理后差值为准
3. 非系统盘清理首版仅回收站 + 空间分布（设计 5.4 白名单底线）
4. 清理差值按所选盘统计，跨盘项（如用户 Temp 在 C 盘而选 D 盘）差值计 0，完成页注明
