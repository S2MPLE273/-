# v0.2.2 设计：精确 24 小时有效期 + keygen 密码门禁 + 历史密钥记录

> 2026-08-16。项目未发布（v0.2.1 验收中），允许密钥格式破坏性变更。
> 上游主设计：`2026-08-15-diskclean-agent-design.md`。本文件描述 v0.2.2 增量。

## 背景与动机

1. **验收反馈**：1 天密钥显示"剩余 40 小时"。v1 实现为日粒度（有效至 issueDay+validDays+1 的 UTC 0 点 = 北京早 8 点），与用户"1 天 = 24 小时"的预期不符。用户要求改为**生成时刻起精确 24 小时**。
2. **服务方使用需求**：keygen.html 内含主密钥，需要进入密码防"被顺手打开"；客户丢失密钥时服务方希望从历史记录直接重发，无需重新生成。
3. 排查"密钥无效"问题（用户已确认当前密钥有效）时发现：直接打开 `tools/keygen.template.html`（主密钥未注入）会**静默生成格式正常但必然验证失败的密钥**——需加守卫。

## 1. 密钥格式 v2（精确 24 小时有效期）

### 1.1 位布局变更

```
v1: [[1,2],[issueDay,16],[validDays,6],[tagHash,16],[0,12]]
v2: [[1,2],[issueDay,16],[validDays,6],[tagHash,16],[issueHour,5],[issueMinute,6],[0,1]]
```

- 总长不变（52 bits → 7 字节 payload），密钥外观长度不变（`DKC-XXXX-XXXX-XXXX-XXXX`）
- version 字段 1 → **2**：v1 旧密钥验证返回 `invalid`（干净切割，避免旧格式被新布局误读）
- **语义**：`expireMs = EPOCH + issueDay*DAY_MS + issueHour*3600e3 + issueMinute*60e3 + validDays*DAY_MS`
  - 签发时刻按**分钟向下取整**写入密钥；实际有效期 = N×24h + 0~59 秒（误差 <1 分钟）
  - 1 天 = 整 24 小时，7 天 = 整 168 小时，N 天 = N×24 小时
  - EPOCH 仍为 `Date.UTC(2026,0,1)`，时间戳为绝对时间（时区无关）
- validDays 仍 6 bits（1–63），下拉选项 1/2/3/7/30 不变

### 1.2 影响面

| 文件 | 变更 |
|---|---|
| `src/license.js` | packBits 布局、unpackBits 宽度、generate 计算 issueDay/Hour/Min、verify 版本检查 `===2` + expire 公式 |
| `tools/keygen.template.html` | 同布局同公式（含历史剩余时间计算） |
| `PROJECT.md` | §6.9 位布局硬约束更新为 v2；§2 阶段更新 |
| 主设计 doc | §4 密钥方案补充 v2 记录 |
| 旧密钥 | 全部失效（version 1 拒绝）；用户需用新 keygen 重新生成 |

- 主密钥不变（`da73f44b`），exe/keygen 配对不受影响
- 现有 `license.dat` 状态文件中的旧 keyHash 记录与新密钥无关（keyHash 按密钥内容计算），无需清理

## 2. keygen 密码门禁

- 页面加载即显示全页密码遮罩；输入 → SHA-256 → 与模板内嵌哈希常量比对
- 解锁成功 → `sessionStorage` 写入标志（`dkcKeygenUnlocked`），同一浏览器会话内免重复输入
- 解锁失败显示"密码错误"，可无限重试
- 密码 `Hjh20050613` **仅以 SHA-256 hex 哈希**存在于模板常量中，不出现明文
- 改密码流程：计算新密码哈希 → 替换模板常量 → `npm run build`（写入 PROJECT.md）
- 诚实局限（UI 不作夸大宣传）：主密钥仍在文件中，技术人员可从文件提取（离线方案固有风险，PROJECT.md §8 已记录）；门禁只防"文件落到非技术人员手里被顺手打开"

## 3. 历史密钥记录

- 存储：`localStorage` key `dkcKeygenHistory`，值为 `[{key, tag, validDays, issueTime}]`
  - `issueTime` 存**分钟取整后**的签发时刻（与密钥内嵌时刻一致，保证剩余时间计算与 exe 完全一致）
  - 生成成功时自动追加；不做去重（同一分钟内同参数重复生成会产生相同密钥，可手工删除重复条目）
- **有效期内分区**（按到期时间升序）：
  - 每行：客户备注 | 密钥（等宽字体）| 剩余时间（≥1 小时显示"X天X小时"，<1 小时显示"不足 1 小时"；另附"至 X月X日 HH:MM"）| 复制按钮 | ✕单条删除（防填错备注）
  - 剩余时间公式与 license.js verify 完全一致（交叉测试保证）
- **已过期分区**：折叠（details），置灰显示，附"清空过期记录"按钮
- 已知限制：历史存在**生成密钥的那台电脑的浏览器**里；换电脑/换浏览器/清浏览器数据会丢；file:// 下 localStorage 为全部本地文件共享（仅本机可达）
- 使用场景：客户丢密钥 → 服务方打开 keygen → 历史中找到 → 一键复制重发

## 4. 模板守卫 + 指纹显示

- **守卫**：页面加载时校验主密钥为 64 位 hex；不满足 → 红色错误"此页面未注入主密钥，请使用构建产物 dist/keygen.html"，禁用生成按钮
  - 修的是真实踩坑：直接打开 `tools/keygen.template.html` 曾静默生成无效密钥
- **指纹显示**：keygen 页面显示主密钥指纹（前 8 hex），与 exe 管理面板已显示的指纹对照，快速确认两边同步

## 5. exe 侧 UI 文案变更

- `src/webui/app.js` 验证成功文案：`'密钥有效 ✓（有效期至 8月17日 16:30）'`——由 `now + remainingMs` 计算精确时刻
- 移除"剩余 X 小时"表述；`LICENSE_MSGS` 不变
- 无其他 exe 侧行为变更（密钥逻辑零改动以外的部分：仅显示）

## 6. 测试

### 6.1 test/keygen-cross.test.js 重写

1. v2 密钥与 license.js 互认（同主密钥、同 issueTime/validDays）
2. **24h 精确性**：`generate(issueTime=T)`（T 为分钟对齐的时间戳）→ `verify(now=T+24h-60s)` ok；`verify(now=T+24h+60s)` → expired
3. 分钟取整边界：issueTime 带秒（如 T+45s）→ 有效窗口为 `[floor(T), floor(T)+24h)`
4. v1 旧格式密钥 → invalid（版本 1 拒绝）
5. 不同主密钥拒绝（保留原有用例）
6. 历史剩余时间公式 ≡ `license.verify` 的 `remainingMs`（同一 now 下相等）
7. 密码哈希常量：64 位 hex 格式
8. 未注入模板守卫：`__MASTER_KEY__` 未替换时生成被拒（守卫函数可被 vm 调用）

### 6.2 现有测试更新

- `test/license.test.js`：version 2、expire 公式、分钟精度相关断言
- `test/server.test.js`：涉及 verify 结果的断言（如 remainingMs）同步
- UI 文案无自动化测试（既有已知限制：API 层已集成验证，真实点击待人工验收）

## 7. 构建与发布

- 版本号 0.2.2；`npm run build` 重建 exe + keygen.html（主密钥不变）
- 构建后人工验收点：keygen 密码解锁 → 生成 → 历史可见 → exe 验证显示"有效期至 精确时刻" → 清理流程正常

## 8. 明确不做

- 密钥作废/吊销（离线验证无远程通道；用户已确认靠短有效期 + 单机绑定控制风险）
- 历史导入/导出
- 密码可配置化（改模板常量重建即可）
- 历史记录跨设备同步
