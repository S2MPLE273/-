# DiskClean Agent — 项目记录

> 最后更新：2026-08-16。本文件是项目状态的权威记录，修改代码前先读这里。

## 1. 项目是什么

绿色单 exe 磁盘清理工具：服务方远程协助客户时，客户下载工具、输入服务方签发的密钥（默认 1 天有效期），自助完成任意磁盘的扫描与清理。纯本地运行、无广告、无上传、删除即卸载。

**双角色模型：**
- **客户**：拿到 `DiskCleanAgent.exe`，扫描免费（先看到"可清理 20 GB"），清理需密钥
- **服务方（用户本人）**：用 `keygen.html` 生成密钥发给客户，实现服务管理

## 2. 当前阶段

**v0.2.5：时钟容差收紧为 4h + lastSeen 回拨容差 1h + 时间异常文案拆分（2026-08-17，独立审查后修复）。**

- v0.2.4 的 24h 容差经独立代码审查指出代价：恶意客户首次使用时拨慢时钟（容差内），1 天密钥实际可用约 2 天。服务方拍板收紧为 **4h**（"一般误差不会那么大"）；超出容差返回新 reason `not_yet_valid`（"密钥尚未生效"），与"时间回拨"（`clock_rollback`，保留给 lastSeen 检查）拆分为两种提示。
- lastSeen 回拨防护加 **1h 容差**：吸收"时钟先快后被 NTP 校正回调"造成的假拒绝（审查发现，与本次修复同源的反向问题）；超出 1h 仍判回拨。
- 其余 Minor：generate 对非法 deviceCode（归一化后非 32 hex）抛错；keygen 本机时间在每次生成时刷新；新增 v3 tagHash=0 fail-closed 回归钉、容差边界相等用例。
- 79/79 测试全绿（`npm test`）；TDD + 独立子代理代码审查（superpowers 流程）

v0.2.4（2026-08-16）：密钥验证 24h 时钟容差（后经 v0.2.5 收紧为 4h）+ 密钥设备绑定 v3（keygen 设备码 + 客户界面设备码）。修复"先无效、过会儿又有效"：v2 密钥内嵌签发时刻（分钟精度），原验证 `cur < issueMs` 即拒绝——签发机时钟略快于客户机（秒级偏差即可触发）就误报无效。keygen 新增本机时间显示。设备码（MachineGuid 归一化 32 hex）哈希烙入 tagHash、version=3，验证端 v3 强制比对，不符提示"此密钥已绑定其他设备"；v2 忽略 tagHash。注意：跨设备"已使用"检测离线不可实现（license.dat 是本机状态），必须签发时烙入设备码。

v0.2.3：回收站清理修复（提权直删）+ 失败项原始错误显示，已人工验收通过（2026-08-16）。

v0.2 新增：扫描进度条+动效、已选/共统计、管理员接口。v0.2.1 修复（验收反馈）：①切换磁盘后扫描/清理按所选盘过滤（非系统盘仅"回收站（本盘）"，服务端按盘校验，跨盘项 400）；②空间分布 TOP10 偶发不显示（C 盘全盘遍历超时 5→10 分钟）；③进度条改为确定式 0→100（条目+空间分布阶段加权，移除循环流光动画）。
v0.2.2 新增：密钥有效期改为签发时刻起精确 N×24h（位布局 v2、版本号 2，v1 密钥全部作废）；keygen 增加管理密码门禁（SHA-256 哈希比对）、历史密钥记录（本机浏览器 localStorage，有效/过期分区）、模板未注入守卫与主密钥指纹显示；exe 验证成功显示精确到期时刻。
v0.2.3 修复：回收站清理必失败（SHEmptyRecycleBin 在提权进程返回 E_UNEXPECTED，实测 Win11 26200，非提权对照组正常）——改为 dir 直删所选盘 `$RECYCLE.BIN` 内容，保持按盘语义；清理失败项同时显示原始错误与诊断建议（取证改进，保留）。

- 70/70 测试全绿（`npm test`）；逐任务 TDD + spec 审查 + 质量审查（含安全实测：非盘根路径磁盘参数曾可清空系统盘回收站、非字符串参数曾可杀进程——均已修复并加守卫）
- 产物已构建：`dist/DiskCleanAgent.exe` + `dist/keygen.html`
- 主密钥指纹 `da73f44b`，存于 `tools/master.key`（gitignored，**务必备份**——丢失后旧密钥全部作废、exe/keygen 配对断裂）
- 尚未完成：正式外发（未做代码签名，客户机 SmartScreen 会提示未知发布者）
- 全部提交在 main 分支；远端仓库：`https://github.com/S2MPLE273/-`（2026-08-16 已推送；仓库不含任何密钥——`tools/master.key`、`dist/` 均 gitignored）
- 推送网络说明：本机经 Watt Toolkit（Steam++）hosts 加速访问 GitHub（推送时需保持其运行）；2026-08-16 已清除失效的 git 代理配置（原 127.0.0.1:26561，全局与项目两处），直接 `git push` 即可

## 3. 交付物与使用方法

| 文件 | 给谁 | 用法 |
|---|---|---|
| `dist/DiskCleanAgent.exe` | 客户 | 双击 → UAC 提权 → 浏览器自动打开 → 选盘扫描 → 输密钥 → 勾选清理 |
| `dist/keygen.html` | 服务方 | 双击浏览器打开 → 输客户备注 + 有效期 +（可选）客户设备码 → 生成 `DKC-XXXX-XXXX-XXXX-XXXX`（打开需输入管理密码；填设备码则仅该设备可用） |

构建命令：`npm run build`（幂等，产物到 `dist/`，全部 gitignored）。

## 4. 技术栈与架构

- **Node 24 + SEA 单文件打包**（esbuild bundle + postject 注入 blob），零运行时依赖
- **本地 HTTP 服务**（127.0.0.1 随机端口 + 96-bit 随机 token 于 URL 查询参数）→ 浏览器 Web UI（原生 HTML/CSS/JS，构建时内嵌进 bundle）
- **PowerShell 子进程**执行全部系统操作（扫描/清理/诊断），参数 Base64 JSON 传递
- **密钥**：HMAC-SHA256 离线验证 + 可选设备绑定（v3 密钥烙入 MachineGuid 哈希）+ 本机状态绑定 + 时间回拨防护（1h 校时回调容差）+ 4h 签发时钟容差，状态存 `%ProgramData%\DiskCleanAgent\license.dat`
- **扫描进度**：scanAll 的 onPhase 回调（items 批次/空间分布/特殊项三阶段）→ task.progress → GET /api/scan/:id 增量返回；UI 进度卡（确定式 0→100，条目+空间分布阶段加权）；扫描/清理项按所选盘过滤（非系统盘仅回收站·本盘）
- **管理员接口**：`X-Admin-Key` 头（64 hex 主密钥，timingSafeEqual）→ `/api/admin/status|clean|license/reset`（状态查看/免密钥清理/授权重置）；UI 页脚"服务方入口"管理面板（主密钥仅存 sessionStorage）
- **失败诊断**：错误分类 + 安全软件进程检测（火绒/360/管家/毒霸/Defender）→ 针对性建议卡片 + 单项目重试

## 5. 文件结构

```
DiskCleanAgent/
├── src/
│   ├── main.js          # 入口：UAC 提权重启、端口+token、浏览器、心跳退出（in-flight 保护）
│   ├── server.js        # HTTP 路由：token 门禁、scan 增量轮询、verify/clean（密钥+id 校验）
│   ├── license.js       # 密钥生成/验证（BigInt packBits、HMAC 截断签名、分钟精度 N×24h 有效期）
│   ├── psutil.js        # PowerShell 网关：runPs/runJson、getSysInfo、normalizeDisks
│   ├── scanner.js       # 17 项扫描清单 + 并行分批 + 空间分布 Top10（.NET 栈遍历 PS）
│   ├── cleaner.js       # 串行清理 + 失败重试 1 次 + 诊断联动 + 差值统计
│   ├── diagnose.js      # 错误分类（含中文关键词）+ 安全软件表 + 建议文案
│   ├── webui/           # index.html / style.css / app.js（checkbox 分级勾选版）
│   └── webui-inline.js  # 构建产物（gitignored）：webui 内嵌为 JS 字符串模块
├── tools/
│   ├── build.js         # SEA 打包流水线（主密钥注入、正向断言、fuse 校验、keygen 成品）
│   ├── keygen.template.html  # 密钥生成器模板（纯 JS HMAC-SHA256，__MASTER_KEY__ 占位）
│   └── master.key       # 主密钥 64 hex（gitignored）
├── test/                # 70 个测试（node:test）：license/diagnose/scanner/cleaner/server/psutil/keygen-cross
├── docs/superpowers/
│   ├── specs/2026-08-15-diskclean-agent-design.md   # 设计文档（权威需求）
│   └── plans/2026-08-15-diskclean-agent.md          # 实施计划（11 任务）
└── dist/                # 构建产物（gitignored）
```

## 6. 硬性约定（修改代码必须遵守，违反会静默出错）

1. **PS 脚本体纯 ASCII**（零非 ASCII 字节；中文经 Base64 JSON 参数传递）——PS 5.1 按 GBK 读无 BOM 文件
2. **每个 PS 脚本体第一条可执行语句**（param 之后）：`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`
3. **PS 原生命令（Dism.exe/powercfg）调用前后**切换 OutputEncoding 为 Default 再恢复 UTF-8，否则 GBK stderr 乱码
4. **PS 数组输出必须 `ConvertTo-Json -InputObject @($x)`**——单元素管道会展开成裸对象（已踩坑：sysinfo/toplevel）
5. **PS 排序用 `[pscustomobject]`**，裸 hashtable 的 Sort-Object 在 PS 5.1 失效
6. **PS 大目录递归用 .NET 栈遍历**（跳过 ReparsePoint），`Get-ChildItem -Recurse` 遇 junction 静默返回空
7. **PS 错误文本嵌入 JSON 用 `ConvertTo-Json -Compress`**，手写 `-replace` 转义会漏反斜杠/换行
8. **JS 位打包用 BigInt**（license.js 与 keygen 模板的 packBits）——32 位位运算会截断 56-bit payload
9. **密钥位布局（硬约束，两处实现必须一致）**：`[[2,2],[issueDay,16],[validDays,6],[tagHash,16],[issueHour,5],[issueMinute,6],[0,1]]` + HMAC-SHA256 截 3 字节；version=2 忽略 tagHash（不绑定设备），version=3 强制 tagHash = SHA-256(归一化设备码) 前 2 字节（v0.2.4 起，v1 已作废）；改算法必须跑 `test/keygen-cross.test.js`。验证侧另有 4h 签发时钟容差（`cur < issueMs - 4h` → `not_yet_valid`）、lastSeen 回拨容差 1h（`cur < rec.lastSeen - 1h` → `clock_rollback`）与设备码归一化（仅保留 hex、小写）——两处实现必须一致
10. **esbuild 注入主密钥用 JS API `define: {__MASTER_KEY__: JSON.stringify(key)}`**——shell 传参引号会被剥掉导致静默回退
11. **磁盘参数必须 `C:` → `C:\` 标准化**（scanner 与 cleaner 入口都做）
12. 修改 main.js 的 `__MASTER_KEY__` 分支时注意：bundle 里不得残留 sentinel 字符串（build.js 会断言）

## 7. 测试与开发工作流

- 测试：`npm test`（= `node --test`，自动发现 test/）
- 构建：`npm run build`（含正向断言：sentinel 无、主密钥在、dev 回退密钥无、fuse 翻转）
- 开发模式跑服务：`DKC_MASTER_KEY=<64hex> node src/main.js`（webui 从磁盘读，便于改前端）
- 工作流：TDD（先失败测试→实现→通过）→ spec 审查 → 质量审查 → 修复循环 → 提交

## 8. 已知限制（设计内接受）

- 非系统盘可清理项仅回收站（本盘），另显示该盘空间分布 TOP10（白名单底线，防误删客户数据；扫描/清理项按所选盘过滤，服务端按盘校验）
- `winsxs`/`driver_store` 扫描预估为 0，实际释放按清理后差值计；driver_store 清理未实现（明确报"暂不支持"）
- 回收站按所选盘清空（直接删除该盘 `$RECYCLE.BIN` 内容——SHEmptyRecycleBin 在提权进程返回 E_UNEXPECTED 已弃用，实测 2026-08-16），统计为所选盘 `$RECYCLE.BIN` 实际大小；桌面回收站视图可能延迟刷新（打开回收站即恢复）
- exe 未做代码签名（SmartScreen 未知发布者）；主密钥在 exe 内可被逆向（离线方案固有风险）
- 设备绑定 tagHash 仅 16 位（碰撞率 1/65536，位布局硬约束）；绑定密钥（version 3）在旧版 exe（<0.2.4）上直接报"密钥无效"（fail-closed，不会静默放行）——发绑定密钥前需确认客户已用新版 exe
- 跨设备"密钥已被使用"离线不可检测（license.dat 是本机状态）——需严格单设备时必须签发时填写设备码；密钥签发机时钟不准（慢于真实时间）会导致密钥提前过期（容差只放宽生效侧、不放宽到期侧）；4h 生效容差意味着恶意客户首次使用时拨慢时钟最多可多获得约 4h 使用时间（审查已知、服务方接受）
- 管理员接口权限等价于持有主密钥：能逆向提取 exe 内主密钥者获得同等管理权限（与 keygen.html 同级，离线方案固有风险）；客户正常流程不受影响（无 admin 头一律 401）
- Edge/Chrome 缓存只扫 `User Data\Default` 单一 profile
- 浏览器 UI 未做自动化测试（API 层已集成验证；真实点击流程待人工验收）
- keygen 历史记录存于生成密钥的那台电脑的浏览器 localStorage：换电脑/换浏览器/清浏览器数据会丢；管理密码仅防非技术性"顺手打开"（主密钥仍在文件中，技术人员可提取）
- keygen 需输入管理密码解锁（密码仅以 SHA-256 哈希存于文件）；改密码需重算哈希替换模板常量后重新构建

## 9. 后续优化方向（按优先级）

1. ✅ **人工验收 v0.2.2（2026-08-16 通过）**：keygen 密码解锁/生成/历史记录、exe 验证显示"有效期至 精确时刻"、v1 旧密钥报无效、切盘修复与 v0.2 功能回归均通过（下一优先：正式外发前代码签名）
2. 可选：`signtool` 代码签名解决 SmartScreen 提示
3. 完成页"预估 vs 实际释放"对比展示（spec §7，当前只显示实际值）
4. "切换磁盘无需重新输密钥"（当前重扫会清 key，spec §7 未完全实现）
5. 清理结果显示中文标签（当前显示原始 id 如 user_temp）
6. driver_store 过期驱动清理（pnputil，风险高需谨慎设计）
7. 非系统盘常见游戏缓存白名单扩展
8. 诊断建议多安全软件全量展示（数据已支持，UI 只展示第一条）
9. 完成页 retry 按钮对 `retryable:false` 的尊重（当前所有失败项都显示重试）
10. 清理过程逐项进度展示（当前 /api/clean 同步无进度反馈，扫描已解决）

## 10. 里程碑提交

- v0.2.5（2026-08-17）：时钟容差 24h→4h + lastSeen 回拨容差 1h + not_yet_valid/clock_rollback 文案拆分（独立审查后修复）
- v0.2.4（2026-08-16）：密钥验证时钟容差（修复时钟偏差误判）+ 可选设备绑定 v3（keygen 设备码 + 客户界面设备码）
- `4720a93`/`6b133ed` v0.2.3：回收站清理修复（提权 E_UNEXPECTED 取证 → dir 直删所选盘）+ 失败项原始错误显示
- `d199564`/`05a4914`/`5821736`/`be86886`/`ef040fd`/`9f359d2` v0.2.2：密钥格式 v2 + keygen 密码/历史/守卫（子代理驱动开发 + 两阶段审查）
- `d5c422c` v0.2.2 设计文档 + `bd327cb` 实施计划
- `491c9e8` 合并远端 README 历史并推送 GitHub（首次上线）
- `3012867` 记录 GitHub 远端仓库；清理 untracked masterkey.txt
- `a089f90` 进度条确定式 0→100（v0.2.1）
- `501a29b` 磁盘参数盘根格式校验守卫（安全修复：非盘根路径曾可清空系统盘回收站）
- `628775b` 回收站按盘清空（SHEmptyRecycleBin）+ 清理按盘校验（v0.2.1）
- `d33ff36` 扫描按盘过滤 + 按盘回收站统计 + toplevel 超时 10 分钟（v0.2.1）
- `e3c92c8` 终审加固（管理员密钥失效自动复位普通模式 + admin 面板字段转义）← v0.2 HEAD
- `a61fa8c` v0.2 版本号 0.2.0 + 项目记录更新
- `b4aa41c`/`49cd050` v0.2 管理员面板 UI + 质量审查修复
- `ca41721`/`0af66e7` 动效包 + reduced-motion 修复
- `9f920ea`/`9a85f6c`/`667e086` 进度卡 UI + 已选统计 + 质量修复
- `d85822d` 管理员接口（X-Admin-Key 三端点）
- `3821097`/`44cda6c` 扫描进度（onPhase + progress 字段）
- `1d5a921` 最终审查修复（密钥日粒度、单盘阵列化、心跳 in-flight、JSON 转义）← v0.1 HEAD
- `ef2af49`/`83e22e7` SEA 打包流水线 + 加固
- `2332e92`/`ee4482d` keygen 生成器 + 交叉验证
- `5e01335` 扫描编排（含 PS junction/排序两大平台 bug 修复）
- `6ea9c57` 清理编排（freed 差值符号修正）
- `7e98568` 密钥模块（packBits BigInt 修复）
