# DiskClean Agent — 项目记录

> 最后更新：2026-08-16。本文件是项目状态的权威记录，修改代码前先读这里。

## 1. 项目是什么

绿色单 exe 磁盘清理工具：服务方远程协助客户时，客户下载工具、输入服务方签发的密钥（默认 1 天有效期），自助完成任意磁盘的扫描与清理。纯本地运行、无广告、无上传、删除即卸载。

**双角色模型：**
- **客户**：拿到 `DiskCleanAgent.exe`，扫描免费（先看到"可清理 20 GB"），清理需密钥
- **服务方（用户本人）**：用 `keygen.html` 生成密钥发给客户，实现服务管理

## 2. 当前阶段

**v0.1 开发完成，待用户实测验收（2026-08-16）。**

- 43/43 测试全绿（`npm test`）
- 产物已构建：`dist/DiskCleanAgent.exe`（91 MB）+ `dist/keygen.html`
- 主密钥指纹 `da73f44b`，存于 `tools/master.key`（gitignored，**务必备份**——丢失后旧密钥全部作废、exe/keygen 配对断裂）
- 尚未完成：真实浏览器端到端点击验收、正式外发（未做代码签名，客户机 SmartScreen 会提示未知发布者）
- 25+ 提交全部在 main 分支，无远端仓库

## 3. 交付物与使用方法

| 文件 | 给谁 | 用法 |
|---|---|---|
| `dist/DiskCleanAgent.exe` | 客户 | 双击 → UAC 提权 → 浏览器自动打开 → 选盘扫描 → 输密钥 → 勾选清理 |
| `dist/keygen.html` | 服务方 | 双击浏览器打开 → 输客户备注 + 有效期 → 生成 `DKC-XXXX-XXXX-XXXX-XXXX` |

构建命令：`npm run build`（幂等，产物到 `dist/`，全部 gitignored）。

## 4. 技术栈与架构

- **Node 24 + SEA 单文件打包**（esbuild bundle + postject 注入 blob），零运行时依赖
- **本地 HTTP 服务**（127.0.0.1 随机端口 + 96-bit 随机 token 于 URL 查询参数）→ 浏览器 Web UI（原生 HTML/CSS/JS，构建时内嵌进 bundle）
- **PowerShell 子进程**执行全部系统操作（扫描/清理/诊断），参数 Base64 JSON 传递
- **密钥**：HMAC-SHA256 离线验证 + 单机绑定（MachineGuid）+ 时间回拨防护，状态存 `%ProgramData%\DiskCleanAgent\license.dat`
- **失败诊断**：错误分类 + 安全软件进程检测（火绒/360/管家/毒霸/Defender）→ 针对性建议卡片 + 单项目重试

## 5. 文件结构

```
DiskCleanAgent/
├── src/
│   ├── main.js          # 入口：UAC 提权重启、端口+token、浏览器、心跳退出（in-flight 保护）
│   ├── server.js        # HTTP 路由：token 门禁、scan 增量轮询、verify/clean（密钥+id 校验）
│   ├── license.js       # 密钥生成/验证（BigInt packBits、HMAC 截断签名、日粒度有效期）
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
├── test/                # 43 个测试（node:test）：license/diagnose/scanner/cleaner/server/psutil/keygen-cross
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
9. **密钥位布局（硬约束，两处实现必须一致）**：`[[1,2],[issueDay,16],[validDays,6],[tagHash,16],[0,12]]` + HMAC-SHA256 截 3 字节；改算法必须跑 `test/keygen-cross.test.js`
10. **esbuild 注入主密钥用 JS API `define: {__MASTER_KEY__: JSON.stringify(key)}`**——shell 传参引号会被剥掉导致静默回退
11. **磁盘参数必须 `C:` → `C:\` 标准化**（scanner 与 cleaner 入口都做）
12. 修改 main.js 的 `__MASTER_KEY__` 分支时注意：bundle 里不得残留 sentinel 字符串（build.js 会断言）

## 7. 测试与开发工作流

- 测试：`npm test`（= `node --test`，自动发现 test/）
- 构建：`npm run build`（含正向断言：sentinel 无、主密钥在、dev 回退密钥无、fuse 翻转）
- 开发模式跑服务：`DKC_MASTER_KEY=<64hex> node src/main.js`（webui 从磁盘读，便于改前端）
- 工作流：TDD（先失败测试→实现→通过）→ spec 审查 → 质量审查 → 修复循环 → 提交

## 8. 已知限制（设计内接受）

- 非系统盘仅回收站 + 空间分布分析（白名单底线，防误删客户数据）
- `winsxs`/`driver_store` 扫描预估为 0，实际释放按清理后差值计；driver_store 清理未实现（明确报"暂不支持"）
- 回收站为全局清空（Shell COM 限制，文案已注明"所有磁盘"）
- 释放差值按所选盘统计（跨盘项如用户 Temp 在 C 盘而选 D 盘时差值计 0）
- exe 未做代码签名（SmartScreen 未知发布者）；主密钥在 exe 内可被逆向（离线方案固有风险）
- Edge/Chrome 缓存只扫 `User Data\Default` 单一 profile
- 浏览器 UI 未做自动化测试（API 层已集成验证；真实点击流程待人工验收）

## 9. 后续优化方向（按优先级）

1. **人工验收**：双击 exe + keygen 走完整流程（最高优先）
2. 可选：`signtool` 代码签名解决 SmartScreen 提示
3. 清理进度条（x/y 逐项展示，spec §6 的 /api/progress 未实现，当前为同步 POST + 文案）
4. 完成页"预估 vs 实际释放"对比展示（spec §7，当前只显示实际值）
5. "切换磁盘无需重新输密钥"（当前重扫会清 key，spec §7 未完全实现）
6. 清理结果显示中文标签（当前显示原始 id 如 user_temp）
7. driver_store 过期驱动清理（pnputil，风险高需谨慎设计）
8. 非系统盘常见游戏缓存白名单扩展
9. 诊断建议多安全软件全量展示（数据已支持，UI 只展示第一条）
10. 完成页 retry 按钮对 `retryable:false` 的尊重（当前所有失败项都显示重试）

## 10. 里程碑提交

- `1d5a921` 最终审查修复（密钥日粒度、单盘阵列化、心跳 in-flight、JSON 转义）← 当前 HEAD
- `ef2af49`/`83e22e7` SEA 打包流水线 + 加固
- `2332e92`/`ee4482d` keygen 生成器 + 交叉验证
- `5e01335` 扫描编排（含 PS junction/排序两大平台 bug 修复）
- `6ea9c57` 清理编排（freed 差值符号修正）
- `7e98568` 密钥模块（packBits BigInt 修复）
