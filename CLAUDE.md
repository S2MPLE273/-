# DiskClean Agent 项目说明

**修改任何代码前，先读 `PROJECT.md`** —— 它是项目状态的权威记录（当前阶段、文件结构、硬性约定、已知限制、后续方向）。

## 速览

- 绿色单 exe 磁盘清理工具（Node 24 + SEA 打包 + 本地 HTTP + PowerShell 子进程 + 离线 HMAC 密钥）
- 当前阶段：v0.2.5 时钟容差收紧 4h + lastSeen 回拨容差 1h + 时间异常文案拆分（独立审查后修复），79/79 测试；v0.2.4 密钥时钟容差 + 设备绑定 v3（keygen 设备码/客户界面设备码）；v0.2.3 回收站清理修复（提权直删）+ 失败项原始错误显示；v0.2.2 密钥格式 v2（精确 24h）+ keygen 密码门禁/历史记录；v0.2.1 修复切盘按盘过滤/TOP10 超时/进度条确定式 0→100；v0.2 新增进度条+动效、已选统计、管理员接口（X-Admin-Key 三端点 + 服务方管理面板）
- 测试：`npm test`；构建：`npm run build`（产物在 dist/，gitignored）
- 开发模式：`DKC_MASTER_KEY=<64hex> node src/main.js`
- 工作流：TDD → spec 审查 → 质量审查 → 修复循环

## 最重要的硬性约定（详细见 PROJECT.md 第 6 节）

1. PS 脚本一律纯 ASCII + `[Console]::OutputEncoding = UTF8` 首条可执行语句；中文走 Base64 JSON 参数
2. PS 数组输出 `ConvertTo-Json -InputObject @($x)`；排序用 `[pscustomobject]`；大目录递归用 .NET 栈遍历跳过 ReparsePoint
3. 密钥位布局（`[[2,2],[issueDay,16],[validDays,6],[tagHash,16],[issueHour,5],[issueMinute,6],[0,1]]` + HMAC 截 3 字节）是 license.js 与 keygen 模板的硬约束：version=2 忽略 tagHash，version=3 校验 tagHash=设备码哈希（v0.2.4 起）；验证侧 4h 签发时钟容差 + lastSeen 1h 回拨容差 + 设备码归一化两处实现必须一致，改动必须跑交叉测试
4. esbuild 注入主密钥必须用 JS API `define`（shell 传参引号会被剥掉）
5. 磁盘参数 `C:` → `C:\` 标准化（scanner/cleaner 入口）
