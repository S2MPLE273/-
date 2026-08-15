# DiskClean Agent v0.2 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 v0.1 增加扫描进度展示（进度条+动效）、已选/共可清理大小统计、管理员接口（主密钥后门）与配套 UI 管理面板。

**Architecture:** 扫描已是后台任务+增量轮询（v0.1 既有），只需 scanner 补 onPhase 回调、server 补 progress 字段、前端渲染进度卡。管理员接口在现有 server 上新增 3 条路由（X-Admin-Key 头 + timingSafeEqual），/api/clean 与 /api/admin/clean 共用 runClean 辅助。动效全部内联 CSS/SVG（无第三方素材）。

**Tech Stack:** Node 24 + node:test + 原生 HTML/CSS/JS（沿用 v0.1 技术栈与硬性约定，本计划不触碰任何 PS 脚本）。

**Spec:** `docs/superpowers/specs/2026-08-16-diskclean-agent-v02-design.md`

**约束（实现时必须遵守）：** 修改代码前已读 PROJECT.md；遵守其 12 条硬性约定；前端无自动化测试（沿用 v0.1 约定，构建后人工验收）；每个任务完成后提交 commit。

---

### Task 1: 扫描进度（scanner onPhase + server progress 字段）

**Files:**
- Modify: `src/scanner.js`（scanAll 增加 onPhase 参数）
- Modify: `src/server.js`（task.progress + 响应字段）
- Test: `test/scanner.test.js`、`test/server.test.js`

- [ ] **Step 1: 写失败测试（scanner phases）**

在 `test/scanner.test.js` 末尾追加：

```js
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
```

- [ ] **Step 2: 写失败测试（server progress 字段）**

在 `test/server.test.js` 中，把 `makeServer()` 里 scanner mock 的 `scanAll` 替换为（其余不动）：

```js
  const scanner = { scanAll: async (disk, onItem, onPhase) => { if (onPhase) onPhase({ phase: 'items', labels: ['用户临时文件'] }); state.items.forEach(onItem); if (onPhase) onPhase({ phase: 'space' }); return state; }, getItems: () => [{ id: 'user_temp' }, { id: 'win_temp' }] };
```

文件末尾追加：

```js
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
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`
Expected: 2 个新测试 FAIL（`scanAll` 不接受 onPhase / `progress` 为 undefined）。

- [ ] **Step 4: 实现 scanner onPhase**

`src/scanner.js` 的 `scanAll` 签名与批次循环改为：

```js
  async function scanAll(disk, onItem, onPhase) {
    // 'C:' without a trailing backslash is the drive-relative current directory
    // (usually C:\Windows\system32), not the drive root. Normalize to 'C:\'.
    disk = /^[A-Za-z]:$/.test(disk) ? disk + '\\' : disk;
    const items = [];
    const scanable = ITEMS.filter(i => i.paths.length > 0);
    // 分批并发 4 个（避免一次性拉起 15 个 PowerShell 进程）
    const batchSize = 4;
    for (let i = 0; i < scanable.length; i += batchSize) {
      const batch = scanable.slice(i, i + batchSize);
      if (onPhase) onPhase({ phase: 'items', labels: batch.map(b => b.label) });
      await Promise.all(batch.map(async (def) => {
```

（批次循环体其余部分不变）空间分布与特殊项两处改为：

```js
    // 空间分布（所选盘，独立）
    if (onPhase) onPhase({ phase: 'space' });
    const rTop = await psutil.runJson('scan_toplevel.ps1', SCAN_TOPLEVEL_PS, { disk });
    const spaceDist = (rTop.ok && Array.isArray(rTop.data[0])) ? rTop.data[0] : [];
    // 特殊项：回收站 / WinSxS / driver_store 用轻量统计（预估）
    if (onPhase) onPhase({ phase: 'special' });
    const special = await scanSpecial(psutil, disk);
```

- [ ] **Step 5: 实现 server progress**

`src/server.js` 的 POST /api/scan 路由替换为：

```js
    if (req.method === 'POST' && p === '/api/scan') {
      const disk = (body && body.disk) || (process.env.SystemDrive || 'C:') + '\\';
      const taskId = Math.random().toString(36).slice(2, 10);
      const task = { id: taskId, status: 'running', disk, items: [], spaceDist: [], cursor: 0, progress: { phase: 'items', done: 0, total: scanner.getItems().length, current: [] } };
      tasks.set(taskId, task);
      scanner.scanAll(disk, (item) => { task.items.push(item); task.progress.done = task.items.length; },
        (ph) => { task.progress.phase = ph.phase; task.progress.current = ph.labels || []; })
        .then(r => { task.spaceDist = r.spaceDist; task.status = 'done'; })
        .catch(e => { task.status = 'done'; task.error = e.message; });
      return json(res, 200, { ok: true, data: { taskId } });
    }
```

GET /api/scan/:id 的响应行改为：

```js
      return json(res, 200, { ok: true, data: { status: task.status, inc, spaceDist: task.status === 'done' ? task.spaceDist : [], error: task.error, progress: task.progress } });
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm test`
Expected: 全部通过（45 个）。

- [ ] **Step 7: 提交**

```bash
git add src/scanner.js src/server.js test/scanner.test.js test/server.test.js
git commit -m "feat: 扫描进度——scanAll onPhase 回调 + /api/scan/:id progress 字段"
```

---

### Task 2: 管理员接口（X-Admin-Key 鉴权 + 3 端点）

**Files:**
- Modify: `src/server.js`（isAdminReq、runClean 重构、3 条 admin 路由、deps 扩展）
- Modify: `src/main.js`（deps 注入 masterKey/version/removeState）
- Test: `test/server.test.js`

- [ ] **Step 1: 写失败测试**

`test/server.test.js` 顶部 `req` 辅助函数改为（增加 headers 参数）：

```js
function req(port, method, p, body, token, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers || {});
    const r = http.request({ host: '127.0.0.1', port, method, path: token ? p + '?token=' + token : p, headers: h }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
```

`makeServer()` 改为（增加 opts 与 admin 依赖注入）：

```js
function makeServer(opts) {
  opts = opts || {};
  const state = { items: [{ id: 'user_temp', sizeBytes: 1 }, { id: 'win_temp', sizeBytes: 2 }], spaceDist: [] };
  const scanner = { scanAll: async (disk, onItem, onPhase) => { if (onPhase) onPhase({ phase: 'items', labels: ['用户临时文件'] }); state.items.forEach(onItem); if (onPhase) onPhase({ phase: 'space' }); return state; }, getItems: () => [{ id: 'user_temp' }, { id: 'win_temp' }] };
  const cleaner = { clean: async () => ({ results: [{ id: 'user_temp', ok: true, freed: 10 }], freedTotal: 10 }) };
  const license = { verify: (k) => k === 'GOODKEY' ? { ok: true } : { ok: false, reason: 'invalid' } };
  const psutil = { getSysInfo: async () => ({ disks: [{ name: 'C:\\', total: 100, free: 40 }], isAdmin: true, machineGuid: 'guid-1', procs: '' }) };
  return createServer({ port: 0, token: 'tok', webui: { html: '<h1>hi</h1>', css: '', js: '' }, license, scanner, cleaner, psutil, machineGuid: 'guid-1', loadState: () => ({ entries: {} }), saveState: () => {}, masterKey: opts.masterKey || '', removeState: opts.removeState || (() => {}), version: '9.9.9' });
}
```

文件末尾追加 4 个测试：

```js
const MASTER = 'ab'.repeat(32);

test('admin endpoints reject missing/wrong key', async () => {
  const srv = await makeServer({ masterKey: MASTER }); const port = await listen(srv);
  const noKey = await req(port, 'GET', '/api/admin/status', null, 'tok');
  assert.equal(noKey.status, 401);
  const wrong = await req(port, 'GET', '/api/admin/status', null, 'tok', { 'X-Admin-Key': 'c'.repeat(64) });
  assert.equal(wrong.status, 401);
  srv.close();
});

test('admin status returns version/fingerprint/license (uppercase hex accepted)', async () => {
  const srv = await makeServer({ masterKey: MASTER }); const port = await listen(srv);
  const r = await req(port, 'GET', '/api/admin/status', null, 'tok', { 'X-Admin-Key': MASTER.toUpperCase() });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.version, '9.9.9');
  assert.equal(r.body.data.fingerprint, MASTER.slice(0, 8));
  assert.equal(r.body.data.machineGuid, 'guid-1');
  assert.deepEqual(r.body.data.license.entries, {});
  srv.close();
});

test('admin clean bypasses license but keeps item validation', async () => {
  const srv = await makeServer({ masterKey: MASTER }); const port = await listen(srv);
  const noKey = await req(port, 'POST', '/api/admin/clean', { disk: 'C:\\', items: ['user_temp'] }, 'tok');
  assert.equal(noKey.status, 401);
  const invalid = await req(port, 'POST', '/api/admin/clean', { disk: 'C:\\', items: ['nope'] }, 'tok', { 'X-Admin-Key': MASTER });
  assert.equal(invalid.status, 400);
  const ok = await req(port, 'POST', '/api/admin/clean', { disk: 'C:\\', items: ['user_temp'] }, 'tok', { 'X-Admin-Key': MASTER });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.freedTotal, 10);
  srv.close();
});

test('admin license reset calls removeState', async () => {
  let removed = false;
  const srv = await makeServer({ masterKey: MASTER, removeState: () => { removed = true; } });
  const port = await listen(srv);
  const noKey = await req(port, 'POST', '/api/admin/license/reset', {}, 'tok');
  assert.equal(noKey.status, 401);
  assert.equal(removed, false);
  const r = await req(port, 'POST', '/api/admin/license/reset', {}, 'tok', { 'X-Admin-Key': MASTER });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.reset, true);
  assert.equal(removed, true);
  srv.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: 4 个新测试 FAIL（404/401 不符）。

- [ ] **Step 3: 实现 server.js**

`src/server.js` 顶部 `const http = require('node:http');` 之后加：

```js
const crypto = require('node:crypto');
```

`createServer` 签名改为：

```js
function createServer({ port, token, webui, license, scanner, cleaner, psutil, machineGuid = 'unknown', loadState, saveState, masterKey = '', removeState, version = '0.0.0' }) {
```

`const tasks = new Map();` 之后加：

```js
  masterKey = (masterKey || '').toLowerCase();

  function isAdminReq(req) {
    const h = String(req.headers['x-admin-key'] || '');
    if (!masterKey || h.length !== 64 || !/^[0-9a-f]{64}$/i.test(h)) return false;
    try { return crypto.timingSafeEqual(Buffer.from(h.toLowerCase(), 'hex'), Buffer.from(masterKey, 'hex')); }
    catch (e) { return false; }
  }

  async function runClean(body) {
    const items = (body && body.items) || [];
    const known = new Set(scanner.getItems().map(i => i.id));
    if (!Array.isArray(items) || !items.length || !items.every(id => known.has(id))) return { status: 400, body: { ok: false, error: 'invalid item id' } };
    const disk = (body && body.disk) || (process.env.SystemDrive || 'C:') + '\\';
    try { const r = await cleaner.clean({ disk, items }, () => {}); return { status: 200, body: { ok: true, data: r } }; }
    catch (e) { return { status: 500, body: { ok: false, error: e.message } }; }
  }
```

`/api/clean` 路由替换为（复用 runClean）：

```js
    if (req.method === 'POST' && p === '/api/clean') {
      const v = verifyKey((body && body.key) || '');
      if (!v.ok) return json(res, 403, { ok: false, error: 'license_' + v.reason, data: v });
      const r = await runClean(body);
      return json(res, r.status, r.body);
    }
```

`/api/clean` 之后、404 兜底之前插入 3 条 admin 路由：

```js
    if (req.method === 'GET' && p === '/api/admin/status') {
      if (!isAdminReq(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
      const state = loadState ? (loadState() || { entries: {} }) : { entries: {} };
      return json(res, 200, { ok: true, data: {
        version,
        fingerprint: masterKey.slice(0, 8),
        machineGuid,
        scanRunning: [...tasks.values()].filter(t => t.status === 'running').length,
        license: { entries: state.entries || {} },
      } });
    }
    if (req.method === 'POST' && p === '/api/admin/clean') {
      if (!isAdminReq(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
      const r = await runClean(body);
      return json(res, r.status, r.body);
    }
    if (req.method === 'POST' && p === '/api/admin/license/reset') {
      if (!isAdminReq(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
      try { if (removeState) removeState(); } catch (e) {}
      return json(res, 200, { ok: true, data: { reset: true } });
    }
```

- [ ] **Step 4: 实现 main.js deps 注入**

`src/main.js` 中 `const deps = { license, scanner, cleaner, psutil, machineGuid: info.machineGuid, loadState, saveState };` 替换为：

```js
  const deps = {
    license, scanner, cleaner, psutil,
    machineGuid: info.machineGuid, loadState, saveState,
    masterKey,
    version: require('../package.json').version,
    removeState: () => { try { fs.unlinkSync(STATE_FILE); } catch (e) {} },
  };
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: 全部通过（49 个）。

- [ ] **Step 6: 提交**

```bash
git add src/server.js src/main.js test/server.test.js
git commit -m "feat: 管理员接口——X-Admin-Key 鉴权 + status/clean/license-reset 三端点"
```

---

### Task 3: 进度卡 UI + 已选/共统计（webui）

**Files:**
- Modify: `src/webui/index.html`
- Modify: `src/webui/app.js`
- Modify: `src/webui/style.css`

前端沿用 v0.1 约定：无自动化测试，实现后以 `npm test`（回归）+ `npm run build`（webui-inline 重新生成）+ 内联检查验证，最终由用户人工验收。

- [ ] **Step 1: index.html 进度卡与统计行**

在 view-scan 的 `<div class="scan-head">…</div>` 之后、`<div id="space-dist" …>` 之前插入：

```html
    <div id="scan-progress" class="card" hidden>
      <div class="prog-head">
        <svg class="prog-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="none" stroke="#0067c0" stroke-width="2" opacity=".25"/><path d="M12 2 A10 10 0 0 1 22 12" fill="none" stroke="#0067c0" stroke-width="2" stroke-linecap="round"/></svg>
        <div class="prog-text">
          <div class="prog-current"><span id="prog-text">正在准备扫描…</span><span class="dots"><span></span><span></span><span></span></span></div>
          <div id="prog-meta" class="sub">0 / 17 项</div>
        </div>
      </div>
      <div class="prog-bar" id="prog-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="prog-fill" id="prog-fill" style="width:0%"></div>
      </div>
    </div>
```

在 scan-head 内部、`<div class="sub" id="scan-sub">…</div>` 之后插入统计行：

```html
      <div class="sel-line" id="sel-line" hidden>已选 <b id="sel-num">0 B</b> / 共可清理 <b id="total-num">0 B</b></div>
```

给 view-scan section 加 aria-busy 初始值：`<section id="view-scan" hidden>` → `<section id="view-scan" hidden aria-busy="false">`。

- [ ] **Step 2: style.css 基础样式（动效在 Task 4）**

`src/webui/style.css` 末尾追加：

```css
.prog-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.prog-icon { width: 26px; height: 26px; flex-shrink: 0; }
.prog-current { font-size: 14px; margin-bottom: 2px; }
.prog-bar { height: 10px; background: #eef2f6; border-radius: 5px; overflow: hidden; position: relative; }
.prog-fill { height: 10px; background: #0067c0; border-radius: 5px; transition: width .3s cubic-bezier(.4, 0, .2, 1); }
.sel-line { margin-top: 10px; font-size: 14px; color: #445; }
.sel-line b { color: #0067c0; }
```

- [ ] **Step 3: app.js 进度渲染 + 已选统计**

`src/webui/app.js` 的 `$('btn-scan').onclick` 中，`show('scan');` 之前追加进度卡重置：

```js
    $('scan-progress').hidden = false;
    $('prog-fill').style.width = '0%';
    $('prog-bar').classList.remove('indeterminate');
    $('prog-text').textContent = '正在准备扫描…';
    $('prog-meta').textContent = '0 / 17 项';
    $('sel-line').hidden = true;
    $('view-scan').setAttribute('aria-busy', 'true');
```

在 `renderItem` 函数之后新增 `renderProgress` 与 `updateSummary`：

```js
  function renderProgress(p) {
    if (!p) return;
    const total = p.total || 17;
    const done = p.done || 0;
    const pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
    $('prog-fill').style.width = pct + '%';
    $('prog-bar').setAttribute('aria-valuenow', String(pct));
    $('prog-meta').textContent = done + ' / ' + total + ' 项 · ' + pct + '%';
    const bar = $('prog-bar');
    if (p.phase === 'space') {
      bar.classList.add('indeterminate');
      $('prog-text').textContent = '正在分析磁盘空间分布（约需 1–3 分钟）';
    } else if (p.phase === 'special') {
      bar.classList.remove('indeterminate');
      $('prog-text').textContent = '正在统计回收站与特殊项…';
    } else {
      bar.classList.remove('indeterminate');
      $('prog-text').textContent = '正在扫描：' + ((p.current && p.current.length) ? p.current.join('、') : '…');
    }
  }

  function updateSummary() {
    const picks = Array.from(document.querySelectorAll('.pick:checked'));
    const sel = picks.reduce((s, cb) => {
      const it = state.items.find(i => i.id === cb.dataset.id);
      return s + ((it && !it.error) ? (it.sizeBytes || 0) : 0);
    }, 0);
    const total = state.items.reduce((s, i) => s + (i.error ? 0 : (i.sizeBytes || 0)), 0);
    const line = $('sel-line');
    if (state.scanDone && state.items.length) {
      line.hidden = false;
      $('sel-num').textContent = fmt(sel);
      $('total-num').textContent = fmt(total);
    } else {
      line.hidden = true;
    }
  }
```

`updateCleanButton` 函数体开头加一行：

```js
  function updateCleanButton() {
    updateSummary();
    const picks = document.querySelectorAll('.pick:checked');
```

`poll(id)` 中 `(r.data.inc || []).forEach(...)` 循环之后加：

```js
    if (r.data.progress) renderProgress(r.data.progress);
```

`poll(id)` 中 `r.data.status === 'done'` 分支里，`$('license-box').hidden = false;` 之后加（该分支末尾已有 `updateCleanButton()`，不要重复添加）：

```js
      $('scan-progress').hidden = true;
      $('view-scan').setAttribute('aria-busy', 'false');
```

`poll(id)` 中 `!r.ok` 失败分支里加 `$('scan-progress').hidden = true;`。

- [ ] **Step 4: 回归 + 构建验证**

Run: `npm test` → Expected: 全部通过（49 个）。
Run: `npm run build` → Expected: 构建成功，输出 built: dist/DiskCleanAgent.exe。
Run: `node -e "const w=require('./src/webui-inline'); console.log(w.html.includes('scan-progress') && w.js.includes('renderProgress') && w.js.includes('updateSummary') ? 'OK' : 'MISSING')"` → Expected: `OK`

- [ ] **Step 5: 提交**

```bash
git add src/webui/index.html src/webui/app.js src/webui/style.css
git commit -m "feat: 扫描进度卡 + 已选/共可清理统计（webui）"
```

---

### Task 4: 动效包（内联 CSS/SVG + 对勾描边 + 错峰淡入）

**Files:**
- Modify: `src/webui/style.css`
- Modify: `src/webui/app.js`

- [ ] **Step 1: style.css 动效**

`src/webui/style.css` 末尾追加：

```css
/* —— v0.2 动效（参数见 spec §6，全部内联自绘）—— */
.prog-icon path { transform-origin: 12px 12px; animation: dkc-spin 1.2s linear infinite; }
@keyframes dkc-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.dots { display: inline-block; margin-left: 4px; vertical-align: 2px; }
.dots span { display: inline-block; width: 4px; height: 4px; margin-left: 3px; border-radius: 50%; background: #0067c0; animation: dkc-pulse 1.2s ease-in-out infinite; }
.dots span:nth-child(2) { animation-delay: .2s; }
.dots span:nth-child(3) { animation-delay: .4s; }
@keyframes dkc-pulse { 0%, 100% { opacity: .2; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }

.prog-bar.indeterminate .prog-fill {
  width: 100% !important;
  background: linear-gradient(90deg, #cfe3f7 0%, #0067c0 50%, #cfe3f7 100%);
  background-size: 200% 100%;
  animation: dkc-shimmer 1.6s linear infinite;
}
@keyframes dkc-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

.item { animation: dkc-in .25s ease-out both; }
@keyframes dkc-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.item.failed .iname { animation: dkc-shake .3s ease-in-out .3s; }
@keyframes dkc-shake { 0%, 100% { transform: none; } 25% { transform: translateX(-3px); } 75% { transform: translateX(3px); } }

.ck { width: 18px; height: 18px; margin-right: 2px; vertical-align: -4px; }
.ck path { stroke-dasharray: 24; stroke-dashoffset: 24; animation: dkc-draw .25s ease-out forwards; }
@keyframes dkc-draw { to { stroke-dashoffset: 0; } }

@media (prefers-reduced-motion: reduce) {
  .prog-icon path, .prog-fill, .dots span, .item, .item.failed .iname, .ck path { animation: none !important; transition: none !important; }
}
```

- [ ] **Step 2: app.js 错峰延迟 + 完成页对勾描边**

`src/webui/app.js` IIFE 内、`let pollTimer = null;` 之后加计数器：

```js
  let renderSeq = 0;
```

`$('btn-scan').onclick` 中重置（放在 `state.items = [];` 之后）：

```js
    renderSeq = 0;
```

`renderItem` 中 `row.className = 'item' + (it.error ? ' failed' : '');` 之后加：

```js
    row.style.animationDelay = ((renderSeq++ % 4) * 40) + 'ms';
```

`$('btn-clean').onclick` 完成页渲染：`(r.data.results || []).forEach(res => {` 改为 `(r.data.results || []).forEach((res, idx) => {`，其中 `'✓ '` 文本替换为对勾 SVG：

```js
      div.innerHTML = '<div style="flex:1"><div class="iname">' + (res.ok ? '<svg class="ck" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" fill="none" stroke="#2e9e5b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' : '✗ ') + res.id + '</div>' + (res.diagnosis ? '<div class="diag">' + res.diagnosis.suggestion + '</div>' : (res.error ? '<div class="imeta">' + res.error + '</div>' : '')) + '</div><div>' + (res.ok ? fmt(res.freed) : '<button class="retry-btn" data-id="' + res.id + '">重试此项目</button>') + '</div>';
      if (res.ok) { const ck = div.querySelector('.ck path'); if (ck) ck.style.animationDelay = (0.15 + idx * 0.08) + 's'; }
```

- [ ] **Step 3: 回归 + 构建验证**

Run: `npm test` → Expected: 全部通过（49 个）。
Run: `npm run build` → Expected: 构建成功。
Run: `node -e "const w=require('./src/webui-inline'); console.log(w.css.includes('dkc-shimmer') && w.css.includes('dkc-draw') && w.css.includes('prefers-reduced-motion') ? 'OK' : 'MISSING')"` → Expected: `OK`

- [ ] **Step 4: 提交**

```bash
git add src/webui/app.js src/webui/style.css
git commit -m "feat: 动效包——shimmer/雷达/圆点/错峰淡入/对勾描边/reduced-motion"
```

---

### Task 5: 管理员面板 UI（页脚入口 + modal + 免密钥清理接线）

**Files:**
- Modify: `src/webui/index.html`
- Modify: `src/webui/app.js`
- Modify: `src/webui/style.css`

- [ ] **Step 1: index.html——页脚入口 + license-box id + modal**

license-box 两处加 id：`<p class="sub">输入服务密钥解锁清理（有效期内可反复使用）</p>` → `<p class="sub" id="license-desc">…`；`<div class="row">`（license-box 内）→ `<div class="row" id="key-row">`。

footer 替换为：

```html
<footer>DiskClean Agent v0.2 · 本地运行 · 数据不出本机<a id="admin-link" href="#">服务方入口</a></footer>
```

`</main>` 之后、`<footer>` 之前插入 modal：

```html
<div id="admin-modal" class="modal-mask" hidden>
  <div class="modal">
    <h3>服务方管理面板</h3>
    <div id="admin-login">
      <p class="sub">输入主密钥（tools/master.key，64 位 hex）</p>
      <div class="row">
        <input id="admin-key-input" type="password" placeholder="主密钥" autocomplete="off">
        <button id="admin-login-btn" class="btn-primary">进入</button>
      </div>
      <div id="admin-msg" class="sub"></div>
    </div>
    <div id="admin-panel" hidden>
      <div class="card admin-card" id="admin-status"></div>
      <div class="row">
        <button id="admin-reset" class="btn-danger">重置授权状态</button>
        <button id="admin-close" class="btn-secondary">关闭</button>
      </div>
      <p class="sub">管理员模式下，清理页验证框将显示"管理员模式：无需密钥"，可直接清理。</p>
    </div>
  </div>
</div>
```

- [ ] **Step 2: style.css modal 样式**

`src/webui/style.css` 末尾追加：

```css
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 10; }
.modal { background: #fff; border-radius: 14px; padding: 22px; width: 480px; max-width: 92vw; max-height: 86vh; overflow: auto; box-shadow: 0 10px 40px rgba(0,0,0,.2); animation: dkc-in .2s ease-out both; }
.modal .row { display: flex; gap: 10px; margin-top: 12px; }
.modal input { flex: 1; padding: 10px 12px; border: 1px solid #ccd; border-radius: 8px; font-size: 13px; }
.btn-danger { background: #d9534f; color: #fff; border: 0; border-radius: 10px; padding: 10px 20px; font-size: 14px; cursor: pointer; }
.admin-card { margin: 10px 0; font-size: 13px; padding: 12px; }
.admin-card table { width: 100%; border-collapse: collapse; }
.admin-card td { padding: 4px 8px; border-bottom: 1px solid #f0f2f5; word-break: break-all; }
.admin-card td:first-child { color: #778; width: 110px; }
#admin-link { color: #99a; text-decoration: none; margin-left: 10px; font-size: 12px; }
#admin-link:hover { color: #0067c0; }
#admin-msg.bad { color: #d9534f; }
```

- [ ] **Step 3: app.js admin 逻辑**

`api()` 函数替换为（headers 支持）：

```js
  async function api(method, path, body, headers) {
    try {
      const r = await fetch(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN, {
        method, headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined,
      });
      return r.json();
    } catch (e) {
      return { ok: false, error: 'network' };
    }
  }
```

`let pollTimer = null;` 之后加：

```js
  let adminKey = '';
  try { adminKey = sessionStorage.getItem('dkcAdminKey') || ''; } catch (e) {}
  function adminHeaders() { return adminKey ? { 'X-Admin-Key': adminKey } : {}; }
```

`show(view)` 函数之后加 `applyAdminMode`：

```js
  function applyAdminMode() {
    if (!adminKey) return;
    state.verified = true;
    $('license-desc').textContent = '管理员模式：无需密钥，可直接清理';
    $('key-row').hidden = true;
    const el = $('key-status');
    el.textContent = '管理员模式已启用 ✓';
    el.className = 'sub ok';
  }
```

`poll(id)` 的 done 分支中 `$('license-box').hidden = false;` 之后加 `applyAdminMode();`。IIFE 末尾 `loadOverview();` 之前加 `applyAdminMode();`。

`$('btn-clean').onclick` 中 clean 调用改为 admin 分支：

```js
      r = await api('POST', adminKey ? '/api/admin/clean' : '/api/clean', { key: state.key, disk: state.disk, items: ids }, adminHeaders());
```

完成页重试按钮调用同样改：

```js
        const r2 = await api('POST', adminKey ? '/api/admin/clean' : '/api/clean', { key: state.key, disk: state.disk, items: [b.dataset.id] }, adminHeaders());
```

文件末尾 `loadOverview();` 之前加管理面板逻辑：

```js
  $('admin-link').onclick = () => {
    $('admin-modal').hidden = false;
    if (adminKey) { $('admin-login').hidden = true; renderAdminPanel(); }
    else { $('admin-login').hidden = false; $('admin-panel').hidden = true; $('admin-msg').textContent = ''; }
  };
  $('admin-close').onclick = () => { $('admin-modal').hidden = true; };
  $('admin-login-btn').onclick = async () => {
    const key = $('admin-key-input').value.trim();
    if (!key) return;
    const r = await api('GET', '/api/admin/status', null, { 'X-Admin-Key': key });
    if (!r.ok) {
      $('admin-msg').textContent = '主密钥错误（401）';
      $('admin-msg').className = 'sub bad';
      return;
    }
    adminKey = key;
    try { sessionStorage.setItem('dkcAdminKey', key); } catch (e) {}
    $('admin-login').hidden = true;
    applyAdminMode();
    renderAdminPanel();
  };
  async function renderAdminPanel() {
    const r = await api('GET', '/api/admin/status', null, adminHeaders());
    $('admin-panel').hidden = false;
    if (!r.ok) {
      adminKey = '';
      try { sessionStorage.removeItem('dkcAdminKey'); } catch (e) {}
      $('admin-panel').hidden = true;
      $('admin-login').hidden = false;
      $('admin-msg').textContent = '主密钥已失效，请重新输入';
      $('admin-msg').className = 'sub bad';
      return;
    }
    const d = r.data;
    const entries = Object.entries(d.license.entries || {});
    let rows = entries.map(([h, e]) => '<tr><td>' + h + '</td><td>' + (e.machineGuid || '') + '</td><td>' + new Date(e.lastSeen || 0).toLocaleString() + '</td></tr>').join('');
    if (!rows) rows = '<tr><td colspan="3" style="color:#889">无授权记录</td></tr>';
    $('admin-status').innerHTML =
      '<table><tr><td>版本</td><td>v' + d.version + '</td></tr>' +
      '<tr><td>主密钥指纹</td><td>' + d.fingerprint + '</td></tr>' +
      '<tr><td>机器标识</td><td>' + d.machineGuid + '</td></tr>' +
      '<tr><td>授权记录数</td><td>' + entries.length + '</td></tr></table>' +
      '<h3 style="margin-top:10px">授权记录</h3><table><tr><td>密钥哈希</td><td>绑定机器</td><td>最近使用</td></tr>' + rows + '</table>';
  }
  $('admin-reset').onclick = async () => {
    if (!confirm('确认清除本机全部授权状态？清除后客户密钥需重新验证。')) return;
    const r = await api('POST', '/api/admin/license/reset', {}, adminHeaders());
    if (r.ok) location.reload();
  };
```

- [ ] **Step 4: 回归 + 构建验证**

Run: `npm test` → Expected: 全部通过（49 个）。
Run: `npm run build` → Expected: 构建成功。
Run: `node -e "const w=require('./src/webui-inline'); console.log(w.html.includes('admin-modal') && w.js.includes('renderAdminPanel') && w.js.includes('applyAdminMode') ? 'OK' : 'MISSING')"` → Expected: `OK`

- [ ] **Step 5: 提交**

```bash
git add src/webui/index.html src/webui/app.js src/webui/style.css
git commit -m "feat: 服务方管理面板——主密钥登录/状态/重置授权/免密钥清理"
```

---

### Task 6: 版本号、文档与构建交付

**Files:**
- Modify: `package.json`（0.1.0 → 0.2.0）
- Modify: `PROJECT.md`、`CLAUDE.md`
- Modify: `C:\Users\胡家豪\.claude\projects\C--\memory\project_diskclean_agent.md`、`MEMORY.md`

- [ ] **Step 1: package.json 版本**

`"version": "0.1.0"` → `"version": "0.2.0"`。

- [ ] **Step 2: PROJECT.md 更新**

1. §2 当前阶段改为：**v0.2 开发完成，待用户实测验收（2026-08-16）**——新增扫描进度条+动效、已选/共统计、管理员接口（X-Admin-Key）；测试 N 个全绿（以 `npm test` 实际数为准）；产物 dist/ 已重建。
2. §4 技术栈增加一行：**管理员接口**：`X-Admin-Key` 头（64 hex 主密钥，timingSafeEqual）→ `/api/admin/status|clean|license/reset`（免密钥清理/授权重置/状态查看，UI 页脚"服务方入口"）。
3. §8 已知限制增加：管理员权限等价于持有主密钥（主密钥在 exe 内可被逆向提取者同权）——离线方案固有风险，与 keygen.html 同级。
4. §9 后续方向：删除已完成项"清理进度条（/api/progress）"；第 1 条人工验收保留（标注含 v0.2 新功能验收）。
5. §10 里程碑：顶部追加 v0.2 三个提交（扫描进度 / 管理员接口 / 动效与面板）。
6. 标题下"最后更新"保持 2026-08-16。

- [ ] **Step 3: CLAUDE.md 更新**

速览区更新为：当前阶段：v0.2 开发完成（进度条/动效/已选统计/管理员接口），待人工验收；测试 `npm test`；构建 `npm run build`。其余不动。

- [ ] **Step 4: memory 更新**

`project_diskclean_agent.md`：当前阶段更新为 v0.2（新增进度条+动效、已选统计、管理员接口 X-Admin-Key 三端点）；MEMORY.md 描述同步。

- [ ] **Step 5: 全量回归 + 构建**

Run: `npm test` → Expected: 全绿。
Run: `npm run build` → Expected: 构建成功（built: dist/DiskCleanAgent.exe + keygen: dist/keygen.html + 指纹打印）。

- [ ] **Step 6: 提交**

```bash
git add package.json PROJECT.md CLAUDE.md docs/superpowers/specs/2026-08-16-diskclean-agent-v02-design.md docs/superpowers/plans/2026-08-16-diskclean-agent-v02.md
git commit -m "docs: v0.2 版本号/项目记录更新 + 设计文档与实施计划"
```

---

## 验收清单（用户人工验收）

1. 双击 dist/DiskCleanAgent.exe → 扫描时进度卡显示 x/17 + 当前扫描项 + 流光/雷达动效；空间分布阶段显示流光条与说明文案；完成后进度卡消失。
2. 勾选/取消项目时"已选 X / 共 Y"实时变化；全不选时清理按钮禁用。
3. 页脚"服务方入口"→ 输入错误主密钥提示 401；输入正确主密钥（tools/master.key 内容）→ 面板显示版本/指纹/授权记录；清理页验证框变为"管理员模式：无需密钥"，直接清理成功；"重置授权状态"生效。
4. 正常客户流程（keygen 生成密钥 → 扫描 → 验证 → 清理）回归无异常。
5. 系统开启"减弱动态效果"时动画降级为静态。
