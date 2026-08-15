# DiskClean Agent 设计文档

日期：2026-08-15
状态：待用户审阅

## 1. 背景与目标

用户（服务方）远程协助客户电脑时，需要一个 C 盘清理工具：客户下载后输入服务方生成的密钥，自助完成扫描与清理。工具以 Web 界面呈现，最终形态为单 exe，双击即用。

核心诉求：
- 客户电脑无需安装任何运行环境（单 exe 内嵌一切）
- 密钥离线验证（无服务器），带有效期（默认 1 天）与单机绑定，便于服务方管理
- 扫描免费，清理需密钥（先展示价值，客户更有动力索取密钥）
- 服务方在本机用独立工具（keygen.html）生成密钥，不依赖任何开发环境

## 2. 总体架构

```
客户电脑（Windows 10/11）
┌─────────────────────────────────────────────┐
│  DiskClean.exe（Node SEA 单文件打包）         │
│  ├─ 启动：检测非管理员 → UAC 提权重启自身      │
│  ├─ 本地 HTTP 服务（127.0.0.1:随机端口+token） │
│  ├─ Node 后端：路由/密钥验证/任务编排          │
│  └─ PowerShell 子进程：扫描与清理执行          │
│        ↓ 自动打开默认浏览器                    │
│  浏览器 Web UI（内嵌 HTML/CSS/JS）             │
└─────────────────────────────────────────────┘

服务方电脑
┌─────────────────────────────────────────────┐
│  keygen.html（纯 HTML 单文件，双击浏览器打开） │
│  输入客户备注 → 生成 DKC-XXXX-... 密钥          │
│  （内嵌同一把主密钥，HMAC-SHA256 签发）        │
└─────────────────────────────────────────────┘
```

### 数据流

1. 双击 exe → 非管理员则 `Start-Process -Verb RunAs` 提权重启自身（一次 UAC）
2. 以管理员启动 HTTP 服务（随机端口，URL 带随机 token，仅本机可访问）
3. 自动打开浏览器 → 前端 `GET /api/overview` 显示 C 盘概况
4. 客户点「开始扫描」→ `POST /api/scan` → Node 编排多个 PowerShell 子进程并行扫描 → 返回分类结果
5. 客户输入密钥 → `POST /api/verify` → HMAC 离线验证 + 时效 + 单机绑定 → 解锁清理
6. 客户勾选项目 → `POST /api/clean` → Node 编排 PowerShell 清理 → 返回实际释放空间
7. 前端展示清理结果

## 3. 技术选型

| 决策点 | 选择 | 理由 |
|---|---|---|
| 运行形态 | Node 24 单文件（SEA 官方打包） | 零第三方依赖、官方支持、客户机无需环境 |
| Web 服务 | node:http 原生模块 | SEA 不支持原生扩展，纯 JS 模块即可 |
| 扫描/清理执行 | PowerShell 子进程 | 回收站 COM、系统目录、DISM 等必须走 Windows 原生能力；2026-08-15 会话已验证此方案 |
| 前端 | 原生 HTML/CSS/JS（内嵌字符串） | SEA 单文件约束；无构建链依赖 |
| UI 风格 | 简洁现代（Windows 风：白底、圆角卡片、#0067c0 主色） | 用户已选定 |
| 密钥算法 | HMAC-SHA256（node:crypto / keygen.html 用纯 JS 实现） | 浏览器 file:// 下 Web Crypto 不可用，keygen.html 需纯 JS HMAC |

## 4. 密钥方案（离线验证 + 时效 + 单机绑定）

### 4.1 密钥格式

`DKC-XXXX-XXXX-XXXX-XXXX`（4 组，每组 4 字符，Base32 字母表，去掉易混淆字符）

payload 结构：
- `version`（1 字节）
- `issueTime`：签发时间（Unix 天数，即 date/86400）
- `validDays`：有效天数（默认 1，表示自签发时刻起 24 小时内有效，按天粒度校验：当前天数 ∈ [issueTime, issueTime+validDays]）
- `clientTag`：客户备注的短哈希（仅供服务方辨认，不参与界面展示）
- `sig`：以上字段的 HMAC-SHA256（主密钥）截断

编码布局：payload（version+issueTime+validDays+clientTag）经 Base32 编码为前 3 组，sig 截断编码为第 4 组，共 4 组拼成 `DKC-XXXX-XXXX-XXXX-XXXX`。

### 4.2 主密钥

32 字节随机 hex。存在于两处：
- exe 内（验证侧）——SEA 打包的 JS 可被逆向提取，属离线方案固有风险，已接受
- keygen.html（签发侧）——仅服务方本机持有，不外发

主密钥作为构建参数注入：`src/license.js` 中留占位符，`tools/build.js` 打包时替换为实际值；`tools/keygen.html` 由同一构建脚本从模板生成。这样主密钥只保存在服务方本机的一个秘密文件（`tools/master.key`，gitignore），不散落在源码各处。

### 4.3 验证流程（license.js）

1. 格式检查：`DKC-` 前缀 + 分组格式
2. HMAC 签名验证：签名不符 → 「密钥无效」
3. 有效期：`当前Unix天数 ∈ [issueTime, issueTime + validDays]` → 过期提示「密钥已过期，请联系服务人员获取新密钥」
4. 单机绑定：首次使用时把 `MachineGuid`（注册表 `HKLM\SOFTWARE\Microsoft\Cryptography`）写入本地状态文件；之后使用若 MachineGuid 不符 → 「此密钥已在其他电脑上使用」
5. 时间回拨防护：状态文件记录 `lastSeen`（最后成功验证的时间）；若当前时间早于 lastSeen → 拒绝（防改系统时间绕过有效期）
6. 状态文件位置：`%ProgramData%\DiskCleanAgent\license.dat`（JSON，存密钥哈希、MachineGuid、lastSeen）

### 4.4 密钥生成器（keygen.html）

- 纯 HTML 单文件 + 纯 JS HMAC-SHA256 实现（不用 Web Crypto，兼容 file://）
- 界面：客户备注输入 → 有效天数（默认 1，可调）→ 「生成密钥」→ 显示密钥 + 一键复制
- 仅服务方本机使用，内置主密钥

## 5. 扫描与清理项目

### 5.1 扫描引擎

- Node 编排，按目录并行启动 PowerShell 子进程（`-NoProfile -File`，脚本通过 stdin 传入或临时文件，输出 JSON 行）
- 每个扫描项独立子进程，失败隔离：单项失败返回 `{error}`，前端标记「扫描失败」，不影响整体
- 扫描结果统一 JSON：`{id, label, path, sizeBytes, category, recommended}`

### 5.2 清理项目清单

默认勾选（安全项，category: safe）：
| id | 项目 | 路径/实现 |
|---|---|---|
| user_temp | 用户临时文件 | `%TEMP%`（跳过占用文件） |
| win_temp | 系统临时文件 | `C:\Windows\Temp` |
| recycle_bin | 回收站 | Shell COM 清空 |
| thumb_cache | 缩略图缓存 | `%LOCALAPPDATA%\Microsoft\Windows\Explorer\thumbcache_*.db` |
| crash_dumps | 崩溃转储 | `%LOCALAPPDATA%\CrashDumps`、`C:\Windows\Minidump` |
| wu_cache | Windows 更新缓存 | `C:\Windows\SoftwareDistribution\Download` |
| inet_cache | 网络缓存 | `%LOCALAPPDATA%\Microsoft\Windows\INetCache` |
| pip_npm_cache | 包管理器缓存 | pip cache、npm-cache |
| d3d_cache | D3D 着色器缓存 | `%LOCALAPPDATA%\D3DSCache` |

默认不勾选（大项，category: optional，带风险说明文案）：
| id | 项目 | 说明文案 |
|---|---|---|
| nvidia_shader | NVIDIA 着色器缓存（DXCache/GLCache） | 游戏首次启动会重新编译，稍慢几分钟 |
| nvidia_driver | NVIDIA 驱动更新缓存（UpdateFramework/Downloader） | 不影响已装驱动，下次更新需重新下载 |
| edge_cache | Edge 浏览器缓存 | 不影响书签/密码/历史 |
| chrome_cache | Chrome 浏览器缓存（如存在） | 同上 |
| prefetch | 预读取文件 | 系统会自动重建 |
| winsxs | WinSxS 组件清理（DISM） | 耗时较长（几分钟到十几分钟），清理期间请勿断电 |
| hibernation | 休眠文件（如存在） | 关闭休眠功能，释放约内存大小的空间 |

### 5.3 清理执行

- 每个项目独立 PowerShell 子进程，逐个执行，前端显示进度（x/y 完成）
- 删除策略：`Remove-Item -Recurse -Force` + 跳过占用/无权限文件（SilentlyContinue），不中断
- 完成后汇总实际释放字节数（清理前后 `Get-PSDrive C` 差值）
- 若所有清理项均失败（如权限异常），前端明确报错，不显示虚假成功

## 6. HTTP API

| 路由 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 前端页面（内嵌 HTML） |
| `/api/overview` | GET | C 盘总量/已用/剩余 + 是否管理员 |
| `/api/scan` | POST | 启动扫描（返回任务 id） |
| `/api/scan/:id` | GET | 轮询扫描进度与结果 |
| `/api/verify` | POST | `{key}` → 验证结果 + 剩余有效时长 |
| `/api/clean` | POST | `{key, items: [id...]}` → 再次验证密钥后执行清理，返回释放空间 |
| `/api/progress/:id` | GET | 清理进度 |

安全：所有路由校验 URL token（启动时生成，浏览器地址栏携带）；仅绑定 127.0.0.1；JSON 响应统一 `{ok, data|error}`。

## 7. 前端页面（简洁现代风格）

三个视图：
1. **首页**：顶部 C 盘概况（剩余/总量进度条）、大按钮「开始扫描」、底部小字品牌信息
2. **扫描结果**：总可清理量大字展示；分类列表（默认勾选安全项，可展开大项）；密钥输入框 + 「验证密钥」；验证成功后「开始清理」按钮可用
3. **清理完成**：释放空间大字 + 各项目明细；过期/无效密钥提示文案

视觉规范：白底、`#0067c0` 主色、圆角卡片、系统字体栈（Segoe UI）、无动画依赖。

## 8. 提权与启动流程

```
main.js 启动
├─ process.platform !== 'win32' → 报错退出
├─ 检测管理员（net session 或 SID 判断）
│   └─ 非管理员 → Start-Process -Verb RunAs 重启自身 → 原进程退出
├─ 生成随机端口 + token
├─ 启动 HTTP 服务
├─ 打开默认浏览器（cmd /c start URL）
└─ 保持运行；浏览器全部关闭检测（心跳超时 10 分钟无请求 → 自动退出）
```

## 9. 错误处理

- PowerShell 脚本输出 UTF-8 JSON；子进程超时（扫描单项目 >5 分钟、清理单项目 >30 分钟）→ 终止并标记失败
- 扫描结果含不可读目录时静默跳过（沿用已验证的 SilentlyContinue 模式）
- 清理删除操作一律跳过占用文件，绝不因单个文件失败中断
- 服务异常统一 500 + `{error: "..."}`，前端 toast 展示
- 中文路径兼容：PowerShell 脚本一律 ASCII 内容、参数经 Base64 传递（规避 GBK 编码坑，2026-08-15 会话已验证此坑）

## 10. 测试策略

1. **license.js 单元测试**（node:test）：生成→验证通过；篡改签名→拒绝；过期→拒绝；换机（不同 MachineGuid）→拒绝；时间回拨→拒绝
2. **keygen.html 交叉验证**：keygen 生成的密钥能被 license.js 验证通过（共享主密钥一致性测试）
3. **扫描/清理本机实测**：在开发机实测全部扫描项与清理项（2026-08-15 已人工验证全部路径可达）
4. **打包后端到端**：SEA 打包 exe → 双击 → UAC → 浏览器全流程走通；清理实际生效（选一个安全项实测释放空间 > 0）
5. **跨机验证**（如可行）：虚拟机 Win10/11 各测一次启动流程

## 11. 项目结构

```
DiskCleanAgent/
├── src/
│   ├── main.js          # 入口：提权/服务/浏览器
│   ├── server.js        # HTTP 路由
│   ├── license.js       # 密钥验证（含 MASTER_KEY 占位符）
│   ├── scanner.js       # 扫描编排 + 扫描项定义
│   ├── cleaner.js       # 清理编排
│   ├── psutil.js        # PowerShell 子进程封装（Base64 参数传递）
│   └── webui/
│       ├── index.html
│       ├── style.css
│       └── app.js
├── tools/
│   ├── build.js         # SEA 打包 + 主密钥注入 + keygen.html 生成
│   ├── master.key       # 主密钥（gitignore，构建时生成一次）
│   └── keygen.template.html
├── test/
│   └── license.test.js
├── docs/superpowers/specs/2026-08-15-diskclean-agent-design.md
├── .gitignore
└── package.json         # 零运行时依赖；仅 node:test 与 SEA 构建
```

## 12. 明确的非目标（YAGNI）

- 不做在线密钥服务器、不做密钥吊销
- 不做多语言（仅中文界面）
- 不做自动更新
- 不做卸载/安装器（绿色单文件，删除即卸载）
- 不做除 C 盘外的多盘支持（首版）
- 不做客户数据回传（纯本地运行）
