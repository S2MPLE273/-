# DiskClean Agent v0.2 — 扫描进度 / 动效 / 已选统计 / 管理员接口 设计文档

> 日期：2026-08-16。本文档是 v0.1 设计文档（2026-08-15-diskclean-agent-design.md）的增量扩展，冲突处以本文档为准。

## 1. 背景

v0.1 实测验收反馈四个问题：

1. 扫描耗时较长且无任何进度反馈，易被误判为卡死；
2. 只显示总可清理大小，用户看不到"勾选后实际要清理多少"；
3. 视觉单调，缺乏反馈动效；
4. 服务方（持有主密钥者）缺少远程管理能力：希望免密钥清理、重置授权状态、查看程序状态。

## 2. 需求（R）

- **R1 扫描进度**：扫描期间显示进度卡——确定进度条（x/17 项 + 百分比）+ 当前扫描项文案；空间分布分析阶段（时长未知）显示流光动画条 + 说明文案；扫描完成后进度卡隐藏。
- **R2 已选统计**：扫描结果区显示"已选 X / 共可清理 Y"一行，随勾选实时重算。
- **R3 动效**：进度条 shimmer 流光、扫描雷达旋转图标、当前步骤跳动圆点、结果行错峰淡入、完成页对勾描边动画、失败项轻微抖动；支持 `prefers-reduced-motion` 降级；进度条带 progressbar ARIA。全部内联 CSS/SVG 自绘，不引入第三方素材（版权 / exe 体积 / 离线约束三方面均不划算）。
- **R4 管理员接口**：主密钥门禁的 HTTP 接口 + Web UI 管理面板：
  - 鉴权：请求头 `X-Admin-Key` = 64 位 hex 主密钥，`crypto.timingSafeEqual` 恒定时间比较；缺失/错误 → 401；
  - `GET /api/admin/status`：版本、主密钥指纹、机器标识、授权记录、扫描中任务数；
  - `POST /api/admin/clean`：免密钥强制清理（复用现有参数校验与清理管线，跳过授权验证）；
  - `POST /api/admin/license/reset`：删除授权状态文件（解决客户换机/密钥绑死的运维问题）；
  - UI：页脚低调入口"服务方入口"→ 主密钥登录（仅存 sessionStorage，关页即清）→ 管理面板（状态卡片 + 重置授权）；管理员模式下清理页显示"管理员模式：无需密钥"。
- **R5**：版本 0.1.0 → 0.2.0；43 个既有测试保持全绿，新增测试覆盖新功能。

## 3. 设计

### 3.1 后端

**扫描进度（最小改动）**——v0.1 的扫描已是后台任务 + 增量轮询（POST /api/scan 立即返回 taskId，GET /api/scan/:id 返回增量），只需补进度数据：

- `scanner.scanAll(disk, onItem, onPhase)` 增加第三个回调（向后兼容）：
  - 每个批次（4 项并发）开始前：`onPhase({ phase: 'items', labels: [4 个项标签] })`；
  - 空间分布分析前：`onPhase({ phase: 'space' })`；
  - 特殊项统计前：`onPhase({ phase: 'special' })`。
- `server.js`：task 对象增加 `progress = { phase, done, total, current }`；`done` 按已产出条目数累计，`total = scanner.getItems().length`（17）；GET /api/scan/:id 响应增加 `progress` 字段。
- 心跳退出保护**无需改动**：UI 每 1.2 秒轮询本身就是请求活跃信号。

**管理员接口**：

- `server.js` 增加 `isAdminReq(req)` 头校验；`/api/clean` 与 `/api/admin/clean` 共用 `runClean(body)` 辅助函数（DRY，不复制参数校验与管线调用）。
- `main.js` 依赖注入增加 `masterKey`（已解析）、`version`（package.json）、`removeState`（删除 STATE_FILE）。

### 3.2 前端（webui 三件套）

- `index.html`：
  - view-scan 顶部插入进度卡 `#scan-progress`（雷达 SVG + 文案 + 圆点 span + 进度条，`role="progressbar"` + aria-valuemin/max/now）；
  - scan-head 下插入统计行 `#sel-line`："已选 <b>X</b> / 共可清理 <b>Y</b>"；
  - license-box 的说明 `<p>` 加 id `license-desc`、输入行加 id `key-row`（管理员模式隐藏输入行）；
  - footer 加"服务方入口"链接 + 版本号 v0.2；
  - body 末尾加管理面板 modal（登录框 + 面板区）。
- `app.js`：
  - `api()` 增加可选 headers 参数（admin 头）；
  - `renderProgress(p)`：items 阶段确定进度条 + 文案"正在扫描：a、b、c、d"；space 阶段 indeterminate 类 + "正在分析磁盘空间分布（约需 1–3 分钟）"；special 阶段"正在统计回收站与特殊项…"；
  - `updateSummary()` 汇总勾选大小，并入 `updateCleanButton()`；poll 每批新条目后刷新；
  - admin：`adminKey`（sessionStorage）、登录/面板渲染/`applyAdminMode()`（管理员模式下 state.verified=true、隐藏密钥输入行）、btn-clean 与重试按钮走 `/api/admin/clean` 分支、重置授权后 `location.reload()`；
  - 扫描开始重置进度卡状态。
- `style.css`：进度条/流光/雷达/圆点/错峰淡入/对勾描边/轻抖/reduced-motion/modal/btn-danger 样式（参数见 §6）。

### 3.3 接口明细

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | /api/scan/:id | token | 响应增加 `progress` 字段 |
| GET | /api/admin/status | token + X-Admin-Key | 版本/指纹/机器标识/授权条目/扫描中任务数 |
| POST | /api/admin/clean | token + X-Admin-Key | 免密钥清理（与 /api/clean 共用 runClean） |
| POST | /api/admin/license/reset | token + X-Admin-Key | 删除 %ProgramData%\DiskCleanAgent\license.dat |

## 4. 安全边界

- 管理员权限 = 持有主密钥。主密钥内嵌于 exe 内可被逆向提取（v0.1 已接受的离线方案固有风险），管理员接口**不引入任何新密钥材料**，权限与 keygen.html 等价。
- 客户正常流程零影响：无 admin 头一律 401。
- UI 中主密钥仅存 sessionStorage（关页即清），不落 localStorage。
- 该边界写入 PROJECT.md 已知限制。

## 5. 测试策略

- 后端 TDD（node:test）：scanner phases 时序（items→space→special）；server progress 字段（done/total/phase/current）；admin 四组用例（401 缺失/错误、status 内容、clean 免密钥 + 400 校验、reset 调用 removeState、大写 hex 接受）。
- 前端沿用 v0.1 约定：无自动化测试，构建后人工验收（进度条动效、已选统计、管理员面板三个清单）。

## 6. 动效参数（联网调研结论固化）

- 进度条宽度过渡 `.3s cubic-bezier(.4, 0, .2, 1)`，只增不减（真实进度，不伪造）。
- shimmer 流光周期 1.6s（调研区间 1.5–2s），`background-size: 200%` 平移。
- 结果行错峰淡入 40ms/项（调研区间 30–50ms），单次 ≤250ms。
- 对勾描边：dashoffset 24→0，.25s ease-out，延迟 .15s + 每项递增 .08s。
- 圆点脉冲 1.2s（三圆点错峰 .2s）；雷达旋转 1.2s linear。
- 失败抖动 3px、.3s、一次性。
- 所有动画属性仅 transform/opacity/background-position；`prefers-reduced-motion: reduce` 下全部禁用。

## 7. 不做（YAGNI）

- 清理过程逐项进度条（本次只做扫描进度；/api/clean 保持同步）。
- 第三方动效素材（见 R3）。
- 管理员密钥生成（keygen.html 已有）。
- 管理员操作审计日志、多管理员体系。
