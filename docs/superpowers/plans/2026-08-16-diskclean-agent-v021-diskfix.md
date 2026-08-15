# DiskClean Agent v0.2.1 修复计划 — 切盘扫描/清理按盘过滤 + TOP10 超时 + 进度条确定式

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复三个验收 bug：①切换磁盘后仍扫描/清理 C 盘项（按盘过滤）；②C 盘空间分布 TOP10 有时不显示（toplevel 遍历超时）；③进度条 space 阶段循环流光观感像"卡住"（改为确定式 0→100）。

**Architecture:** scanner 增加 `getItems(disk)` 按盘过滤（非系统盘仅 `recycle_bin`）+ 回收站按盘扫描（`$RECYCLE.BIN` 栈遍历替代 COM 全局统计）；cleaner 回收站改为 `SHEmptyRecycleBin` 按盘清空；server 的 runClean 校验与 scan progress total 改为按盘；UI 进度条全程确定式（条目 + space 阶段加权计分，去 indeterminate 流光）。

**Tech Stack:** 沿用 Node 24 + node:test + 原生前端。用户已确认采用**最小方案**（不加 Steam 缓存项）。

**约束：** 遵守 PROJECT.md 12 条硬性约定（本计划新增 PS 改动必须纯 ASCII + OutputEncoding 首行 + 栈遍历跳过 ReparsePoint）；TDD（先红后绿）；每任务独立 commit；前端无自动化测试（构建 + 内联检查 + 人工验收）。

---

### Task 1: scanner 按盘过滤 + 按盘回收站扫描 + toplevel 超时（TDD）

**Files:**
- Modify: `src/scanner.js`
- Test: `test/scanner.test.js`

- [ ] **Step 1: 写失败测试**

`test/scanner.test.js` 顶部 import 加 `SCAN_SPECIAL_PS`：

```js
const { createScanner, ITEMS, SCAN_TOPLEVEL_PS, SCAN_SPECIAL_PS } = require('../src/scanner');
```

文件末尾追加 4 个测试：

```js
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: 4 个新测试 FAIL（getItems 无参数版返回全部 / 非系统盘仍扫 entries / opts undefined / SCAN_SPECIAL_PS 仍是 COM 全局统计 size 0）。

- [ ] **Step 3: 实现 scanner.js**

1. 模块级加 normalizeDisk 辅助（放在 `const H = homedir();` 之前）：

```js
function normalizeDisk(disk) { return /^[A-Za-z]:$/.test(disk) ? disk + '\\' : disk; }
```

2. ITEMS 中 recycle_bin 的 label 改为 `'回收站（本盘）'`。

3. `createScanner` 内，scanAll 之前加 `getItems`：

```js
  function getItems(disk) {
    disk = normalizeDisk(disk || SYSD);
    const isSystem = disk.toLowerCase() === SYSD.toLowerCase();
    if (isSystem) return ITEMS;
    // 非系统盘白名单底线：仅回收站（本盘）；空间分布另行分析
    return ITEMS.filter(i => i.id === 'recycle_bin');
  }
```

4. `scanAll` 改为（磁盘标准化复用 normalizeDisk；defs 按盘过滤；toplevel 放宽超时）：

```js
  async function scanAll(disk, onItem, onPhase) {
    // 'C:' without a trailing backslash is the drive-relative current directory
    // (usually C:\Windows\system32), not the drive root. Normalize to 'C:\'.
    disk = normalizeDisk(disk);
    const defs = getItems(disk);
    const items = [];
    const scanable = defs.filter(i => i.paths.length > 0);
    // 分批并发 4 个（避免一次性拉起 15 个 PowerShell 进程）
    const batchSize = 4;
    for (let i = 0; i < scanable.length; i += batchSize) {
      const batch = scanable.slice(i, i + batchSize);
      if (onPhase) onPhase({ phase: 'items', labels: batch.map(b => b.label) });
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
    // 空间分布（所选盘，独立）。C: 全盘遍历在大盘/慢盘上可能超过 5 分钟默认超时，
    // 超时会导致 spaceDist 为空、TOP10 不显示——单独放宽到 10 分钟。
    if (onPhase) onPhase({ phase: 'space' });
    const rTop = await psutil.runJson('scan_toplevel.ps1', SCAN_TOPLEVEL_PS, { disk }, { timeoutMs: 600000 });
    const spaceDist = (rTop.ok && Array.isArray(rTop.data[0])) ? rTop.data[0] : [];
    // 特殊项：回收站（本盘）/ WinSxS / driver_store 用轻量统计（预估）
    if (onPhase) onPhase({ phase: 'special' });
    const special = await scanSpecial(psutil, disk);
    for (const s of special) { items.push(s); onItem(s); }
    return { items, spaceDist, disk };
  }
```

5. `scanSpecial` 改为按盘 defs 映射：

```js
  async function scanSpecial(psutil, disk) {
    const out = [];
    const r = await psutil.runJson('scan_special.ps1', SCAN_SPECIAL_PS, { disk });
    const defs = getItems(disk);
    if (r.ok && r.data.length) {
      for (const d of r.data) {
        const def = defs.find(i => i.id === d.id);
        if (def) out.push({ id: def.id, label: def.label, scope: def.scope, risk: def.risk, sizeBytes: d.size, error: d.error });
      }
    }
    for (const def of defs.filter(i => i.paths.length === 0 && !out.some(o => o.id === i.id))) {
      out.push({ id: def.id, label: def.label, scope: def.scope, risk: def.risk, sizeBytes: 0, error: 'unavailable' });
    }
    return out;
  }
```

6. `return { scanAll, getItems, ps: {...} }` —— getItems 由 `() => ITEMS` 改为函数引用。

7. `SCAN_SPECIAL_PS` 整体替换（COM 全局统计 → 所选盘 `$RECYCLE.BIN` .NET 栈遍历）：

```js
const SCAN_SPECIAL_PS = `
param([string]$Json)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
$data = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($Json)) | ConvertFrom-Json
$rb = 0L
$rbPath = $data.disk + '$RECYCLE.BIN'
if(Test-Path -LiteralPath $rbPath){
  $stack = New-Object System.Collections.Stack
  $stack.Push($rbPath)
  while($stack.Count -gt 0){
    $cur = $stack.Pop()
    try {
      foreach($f in [IO.Directory]::GetFiles($cur)){
        $rb += ([IO.FileInfo]::new($f)).Length
      }
      foreach($d in [IO.Directory]::GetDirectories($cur)){
        $di = [IO.DirectoryInfo]::new($d)
        if($di.Attributes -band [IO.FileAttributes]::ReparsePoint){ continue }
        $stack.Push($d)
      }
    } catch {}
  }
}
Write-Output ('{"id":"recycle_bin","size":' + $rb + '}')
Write-Output '{"id":"winsxs","size":0}'
Write-Output '{"id":"driver_store","size":0}'
`;
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: 全部通过（54 个：既有 50 + 新 4）。

- [ ] **Step 5: 提交**

```bash
git add src/scanner.js test/scanner.test.js
git commit -m "fix: 扫描按盘过滤（非系统盘仅回收站）+ 按盘回收站统计 + toplevel 超时 10 分钟"
```

---

### Task 2: cleaner 按盘清空回收站 + server 按盘校验（TDD）

**Files:**
- Modify: `src/cleaner.js`（recycle kind → SHEmptyRecycleBin）
- Modify: `src/server.js`（runClean 校验与 scan total 按盘）
- Test: `test/cleaner.test.js`、`test/server.test.js`

- [ ] **Step 1: 写失败测试**

`test/cleaner.test.js` 顶部 import 加 CLEAN_ENTRIES_PS：

```js
const { createCleaner, CLEAN_ENTRIES_PS } = require('../src/cleaner');
```

文件末尾追加：

```js
test('recycle clean: script uses SHEmptyRecycleBin per-disk, not global Clear-RecycleBin', () => {
  assert.match(CLEAN_ENTRIES_PS, /SHEmptyRecycleBin/);
  assert.doesNotMatch(CLEAN_ENTRIES_PS, /Clear-RecycleBin/);
});

test('recycle clean: disk root passed to PS', async () => {
  const params = [];
  const cleaner = createCleaner(fake({ scriptResults: {} }));
  cleaner._psutil.runJson = async (n, b, p) => { params.push(p); return { ok: true, data: [{ id: 'recycle_bin', ok: true, freed: 100, error: '' }] }; };
  const res = await cleaner.clean({ disk: 'D:\\', items: ['recycle_bin'] }, () => {}, { retryDelayMs: 0 });
  assert.equal(res.results[0].ok, true);
  assert.equal(params[0].disk, 'D:\\');
});

test('SHEmptyRecycleBin P/Invoke compiles on real PS (integration, no side effect)', async () => {
  const probe = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DKC_RB { [DllImport("Shell32.dll", CharSet=CharSet.Unicode)] public static extern int SHEmptyRecycleBin(IntPtr hwnd, string root, uint flags); }'
Write-Output '{"compiled":true}'
`;
  const r = await psutil.runJson('rbprobe.ps1', probe, {}, { timeoutMs: 60000 });
  assert.equal(r.ok, true);
  assert.equal(r.data[0].compiled, true);
});
```

`test/server.test.js` 的 `makeServer()` 中 scanner mock 的 `getItems` 改为按盘（其余不动）：

```js
  const scanner = opts.scanner || { scanAll: async (disk, onItem, onPhase) => { if (onPhase) onPhase({ phase: 'items', labels: ['用户临时文件'] }); state.items.forEach(onItem); if (onPhase) onPhase({ phase: 'space' }); return state; }, getItems: (disk) => (disk && String(disk).toLowerCase().startsWith('d')) ? [{ id: 'recycle_bin' }] : [{ id: 'user_temp' }, { id: 'win_temp' }] };
```

文件末尾追加：

```js
test('clean rejects items not applicable to selected disk', async () => {
  const srv = await makeServer(); const port = await listen(srv);
  const bad = await req(port, 'POST', '/api/clean', { key: 'GOODKEY', disk: 'D:\\', items: ['user_temp'] }, 'tok');
  assert.equal(bad.status, 400);
  const ok = await req(port, 'POST', '/api/clean', { key: 'GOODKEY', disk: 'D:\\', items: ['recycle_bin'] }, 'tok');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.freedTotal, 10);
  srv.close();
});

test('scan progress total reflects selected disk', async () => {
  const scanner = { scanAll: async (disk, onItem, onPhase) => ({ items: [], spaceDist: [] }), getItems: (disk) => (String(disk).toLowerCase().startsWith('d') ? [{ id: 'recycle_bin' }] : [{ id: 'user_temp' }, { id: 'win_temp' }]) };
  const srv = await makeServer({ scanner }); const port = await listen(srv);
  const started = await req(port, 'POST', '/api/scan', { disk: 'D:\\' }, 'tok');
  const poll1 = await req(port, 'GET', '/api/scan/' + started.body.data.taskId, null, 'tok');
  assert.equal(poll1.body.data.progress.total, 1);
  srv.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: 新测试 FAIL（CLEAN_ENTRIES_PS 仍含 Clear-RecycleBin / 跨盘项 200 而非 400 / total 为 2 而非 1 等）。

- [ ] **Step 3: 实现 cleaner.js**

`CLEAN_ENTRIES_PS` 中 `'recycle' { Clear-RecycleBin -Force -ErrorAction Stop }` 替换为：

```powershell
      'recycle' {
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DKC_RB { [DllImport("Shell32.dll", CharSet=CharSet.Unicode)] public static extern int SHEmptyRecycleBin(IntPtr hwnd, string root, uint flags); }'
        $rc = [DKC_RB]::SHEmptyRecycleBin([IntPtr]::Zero, $data.disk, 7)
        if($rc -ne 0){ $ok=$false; $err = 'SHEmptyRecycleBin failed: ' + $rc }
      }
```

（其余一字不动；SHEmptyRecycleBin 不是控制台 exe，无需 OutputEncoding 切换；flags=7 = NOCONFIRMATION|NOPROGRESSUI|NOSOUND）

- [ ] **Step 4: 实现 server.js**

1. POST /api/scan 的 task 初始值：`total: scanner.getItems().length` → `total: scanner.getItems(disk).length`。
2. `runClean` 改为（先算 disk 再按盘校验 items）：

```js
  async function runClean(body) {
    const disk = (body && body.disk) || (process.env.SystemDrive || 'C:') + '\\';
    const items = (body && body.items) || [];
    const known = new Set(scanner.getItems(disk).map(i => i.id));
    if (!Array.isArray(items) || !items.length || !items.every(id => known.has(id))) return { status: 400, body: { ok: false, error: 'invalid item id' } };
    try { const r = await cleaner.clean({ disk, items }, () => {}); return { status: 200, body: { ok: true, data: r } }; }
    catch (e) { return { status: 500, body: { ok: false, error: e.message } }; }
  }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: 全部通过（59 个：54 + 新 5）。

- [ ] **Step 6: 提交**

```bash
git add src/cleaner.js src/server.js test/cleaner.test.js test/server.test.js
git commit -m "fix: 回收站按盘清空（SHEmptyRecycleBin）+ 清理按盘校验 + 进度 total 按盘"
```

---

### Task 3: UI 进度条确定式 0→100（webui，构建验证）

**Files:**
- Modify: `src/webui/app.js`、`src/webui/index.html`、`src/webui/style.css`

- [ ] **Step 1: app.js renderProgress 改为加权确定式，去掉 indeterminate**

`renderProgress` 整体替换为：

```js
  function renderProgress(p) {
    if (!p) return;
    const total = p.total || 0;
    const done = p.done || 0;
    // 进度单位 = 扫描项 + 空间分布阶段 1 个单位；条只前进不循环
    const phaseDone = (p.phase === 'space' || p.phase === 'special') ? 1 : 0;
    const pct = total > 0 ? Math.min(100, Math.round((done + phaseDone) / (total + 1) * 100)) : 0;
    const bar = $('prog-bar');
    $('prog-fill').style.width = pct + '%';
    bar.setAttribute('aria-valuenow', String(pct));
    $('prog-meta').textContent = done + ' / ' + total + ' 项 · ' + pct + '%';
    if (p.phase === 'space') {
      $('prog-text').textContent = '正在分析磁盘空间分布（较大磁盘约需 1–3 分钟）';
    } else if (p.phase === 'special') {
      $('prog-text').textContent = '正在统计回收站与特殊项…';
    } else {
      $('prog-text').textContent = '正在扫描：' + ((p.current && p.current.length) ? p.current.join('、') : '…');
    }
  }
```

`$('btn-scan').onclick` 重置区：

```js
    $('prog-fill').style.width = '0%';
    $('prog-bar').classList.remove('indeterminate');
    $('prog-bar').setAttribute('aria-valuenow', '0');
    $('prog-text').textContent = '正在准备扫描…';
    $('prog-meta').textContent = '0 / 17 项';
```

替换为：

```js
    $('prog-fill').style.width = '0%';
    $('prog-bar').setAttribute('aria-valuenow', '0');
    $('prog-text').textContent = '正在准备扫描…';
    $('prog-meta').textContent = '准备扫描…';
```

- [ ] **Step 2: index.html 初始文案**

`<div id="prog-meta" class="sub">0 / 17 项</div>` → `<div id="prog-meta" class="sub">准备扫描…</div>`。

- [ ] **Step 3: style.css 删除 indeterminate 流光**

删除以下整块（含 dkc-shimmer keyframes）：

```css
.prog-bar.indeterminate .prog-fill {
  /* !important 覆盖 JS 每次 poll 写入的内联 width，space 阶段强制满宽流光 */
  width: 100% !important;
  background: linear-gradient(90deg, #cfe3f7 0%, #0067c0 50%, #cfe3f7 100%);
  background-size: 200% 100%;
  animation: dkc-shimmer 1.6s linear infinite;
}
@keyframes dkc-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
```

（雷达旋转、圆点脉冲、错峰淡入、对勾描边、reduced-motion 全部保留）

- [ ] **Step 4: 回归 + 构建验证**

Run: `npm test` → Expected: 全部通过（59 个）。
Run: `npm run build` → Expected: 构建成功。
Run: `node -e "const w=require('./src/webui-inline'); console.log(!w.js.includes('indeterminate') && !w.css.includes('dkc-shimmer') && w.js.includes('phaseDone') ? 'OK' : 'MISSING')"` → Expected: `OK`

- [ ] **Step 5: 提交**

```bash
git add src/webui/app.js src/webui/index.html src/webui/style.css
git commit -m "fix: 进度条全程确定式 0→100（条目+阶段加权），移除循环流光"
```

---

### Task 4: 版本 0.2.1 + 文档更新 + 全量回归

**Files:**
- Modify: `package.json`（0.2.0 → 0.2.1）
- Modify: `src/webui/index.html`（footer v0.2 → v0.2.1）
- Modify: `PROJECT.md`、`CLAUDE.md`
- Modify: memory `project_diskclean_agent.md` + `MEMORY.md`

- [ ] **Step 1: 版本号**

package.json `"version": "0.2.0"` → `"version": "0.2.1"`；index.html footer `DiskClean Agent v0.2 ·` → `DiskClean Agent v0.2.1 ·`。

- [ ] **Step 2: PROJECT.md 更新**

1. §2 当前阶段加一行：`- v0.2.1 修复（2026-08-16）：切盘后扫描/清理按所选盘过滤（非系统盘仅回收站·本盘）、空间分布 TOP10 超时修复、进度条改为确定式 0→100`；测试数更新为实际值（以 `npm test` 输出为准，预期 59）。
2. §4 "扫描进度"一行：`UI 进度卡（确定条 + space 阶段 shimmer 流光）` → `UI 进度卡（确定式进度条 0→100，条目+空间分布阶段加权）`。
3. §8 已知限制：
   - 删除 `- 非系统盘仅回收站 + 空间分布分析（白名单底线，防误删客户数据）`，替换为 `- 非系统盘可清理项仅回收站（本盘），另显示该盘空间分布 TOP10（白名单底线，防误删客户数据；扫描/清理项按所选盘过滤，服务端校验）`
   - 删除 `- 回收站为全局清空（Shell COM 限制，文案已注明"所有磁盘"）`，替换为 `- 回收站按所选盘清空（SHEmptyRecycleBin API），统计为所选盘 $RECYCLE.BIN 实际大小`
   - 删除 `- 释放差值按所选盘统计（跨盘项如用户 Temp 在 C 盘而选 D 盘时差值计 0）`（按盘过滤后该项不再成立）
4. §9 第 1 条验收更新为包含 v0.2.1 回归（切盘扫描/清理、TOP10、进度条）；第 7 条"非系统盘常见游戏缓存白名单扩展"保留。
5. §10 里程碑顶部加 v0.2.1 三个修复提交（以实际 hash 为准）。
6. 标题下"最后更新"保持 2026-08-16。

- [ ] **Step 3: CLAUDE.md / memory 更新**

CLAUDE.md 速览：`当前阶段：v0.2 开发完成（50/50 测试）` → `当前阶段：v0.2.1（切盘按盘过滤/TOP10 超时/进度条确定式修复完成，59 个测试），待人工验收`（测试数以实际为准）。
memory `project_diskclean_agent.md`：当前阶段更新为 v0.2.1 修复完成待验收，补充"非系统盘仅回收站（本盘），服务端按盘校验"要点；MEMORY.md 索引行同步。

- [ ] **Step 4: 全量回归 + 构建**

Run: `npm test` → Expected: 全绿。
Run: `npm run build` → Expected: 构建成功。

- [ ] **Step 5: 提交**

```bash
git add package.json src/webui/index.html PROJECT.md CLAUDE.md docs/superpowers/plans/2026-08-16-diskclean-agent-v021-diskfix.md
git commit -m "docs: v0.2.1 版本号与项目记录更新（切盘修复）"
```

---

## 验收清单（用户人工验收）

1. 首页选 D 盘（或其他非系统盘）→ 扫描：结果只显示"回收站（本盘）"一项 + D 盘空间分布 TOP10；进度条 0→100 只前进不循环。
2. 选 D 盘清理：只清空 D 盘回收站，C 盘文件不受影响（可在 C 盘放一个测试回收站文件验证不被清）。
3. 选 C 盘：仍显示全部 17 项 + TOP10 稳定显示（遍历超时已放宽）；回收站只清 C 盘本盘。
4. 进度条任何阶段都不再出现循环流光动画。
