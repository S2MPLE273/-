# DiskClean Agent 设计文档

日期：2026-08-15
状态：待用户审阅

## 1. 背景与目标

用户（服务方）远程协助客户电脑时，需要一个磁盘清理工具：客户下载后输入服务方生成的密钥，自助完成扫描与清理。工具以 Web 界面呈现，最终形态为单 exe，双击即用。支持选择任意磁盘（C/D/E…）进行扫描清理，密钥在有效期内可反复使用（含多次清理不同磁盘）。

核心诉求：
- 客户电脑无需安装任何运行环境（单 exe 内嵌一切）
- 密钥离线验证（无服务器），带有效期（默认 1 天）与单机绑定，便于服务方管理
- 扫描免费，清理需密钥（先展示价值，客户更有动力索取密钥）
- 服务方在本机用独立工具（keygen.html）生成密钥，不依赖任何开发环境

产品定位（借鉴市场调研，2026-08-15）：
- **绿色纯净**：单文件、无广告、无弹窗、无后台常驻、无隐私上传、删除即卸载（对标 Dism++ 口碑，避开 CCleaner 捆绑门与国产管家广告痛点）
- **数据透明**：清理前预估大小、清理后实际释放对比展示（避开「清完只少 200MB 还偷偷装插件」的信任痛点）
- **安全分级**：清理项按风险分级标注，红色高风险项需二次确认（借鉴 Dism++ 的橙/红警告标注与 TreeSize 的关键路径删除保护）
- **定位清晰**：不是「全能优化大师」，只做「磁盘空间回收」一件事（避开 CCleaner 功能堆砌与误删注册表风险）

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
3. 自动打开浏览器 → 前端 `GET /api/overview` 显示全部磁盘概况（C/D/E… 卡片，可选择目标盘）
4. 客户选择目标盘 → 点「开始扫描」→ `POST /api/scan {disk}` → Node 编排多个 PowerShell 子进程并行扫描（通用项 + 所选盘空间分布）→ 渐进式返回结果
5. 客户输入密钥 → `POST /api/verify` → HMAC 离线验证 + 时效 + 单机绑定 → 解锁清理（有效期内反复使用，前端缓存验证状态）
6. 客户勾选项目 → `POST /api/clean {key, items}` → Node 编排 PowerShell 清理 → 返回实际释放空间
7. 前端展示清理结果；客户可切换磁盘重复扫描/清理（密钥有效期内无需重新输入）

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

**使用语义**：密钥在有效期内（默认自签发起 24 小时）可**反复使用**——可多次扫描、多次清理、切换不同磁盘重复操作，均无需重新输入密钥（前端缓存已验证状态）。有效期过后再次清理时才要求新密钥。

### 4.4 密钥生成器（keygen.html）

- 纯 HTML 单文件 + 纯 JS HMAC-SHA256 实现（不用 Web Crypto，兼容 file://）
- 界面：客户备注输入 → 有效天数（默认 1，可调）→ 「生成密钥」→ 显示密钥 + 一键复制
- 仅服务方本机使用，内置主密钥

## 5. 扫描与清理项目

### 5.1 扫描引擎

- Node 编排，按目录并行启动 PowerShell 子进程（`-NoProfile -File`，脚本通过 stdin 传入或临时文件，输出 JSON 行）
- 每个扫描项独立子进程，失败隔离：单项失败返回 `{error}`，前端标记「扫描失败」，不影响整体
- **渐进式结果**：各扫描项完成后立即推送给前端（SSE 或轮询增量），前端边扫边出结果，先完成的项目先显示（改善长扫描等待体验；WizTree 的秒级扫描依赖 MFT 直读，PowerShell 无法实现，渐进式展示是可行折中）
- **空间分布扫描**：与清理项并行，统计**所选盘**顶层大目录排行（Top 10），用于结果页「空间分布」区块，帮助客户直观看到空间去向（借鉴 WizTree 大文件定位能力，2026-08-15 会话已验证此扫描可行）
- **扫描项 scope**：清理项分三类——`system`（系统盘专属，仅 C 盘/系统盘存在：win_temp、winsxs、driver_store、hibernation、prefetch、wu_cache）、`user`（用户目录，与所选盘无关，一次扫完全局生效）、`disk`（所选盘相关：空间分布分析、所选盘回收站清空）
- 扫描结果统一 JSON：`{id, label, path, sizeBytes, scope, risk, recommended}`

### 5.2 清理项目清单

风险分级（risk 字段，前端以颜色标注，借鉴 Dism++ 的橙/红警告体系）：
- `low`（绿）：默认勾选，安全项
- `medium`（橙）：默认不勾选，有副作用说明文案
- `high`（红）：默认不勾选，勾选后清理前弹二次确认框

默认勾选（low）：
| id | 项目 | scope | 路径/实现 |
|---|---|---|---|
| user_temp | 用户临时文件 | user | `%TEMP%`（跳过占用文件） |
| win_temp | 系统临时文件 | system | `%SystemDrive%\Windows\Temp` |
| recycle_bin | 回收站（所选盘） | disk | Shell COM 清空（全局清空时清所有盘） |
| thumb_cache | 缩略图缓存 | user | `%LOCALAPPDATA%\Microsoft\Windows\Explorer\thumbcache_*.db` |
| crash_dumps | 崩溃转储 | user | `%LOCALAPPDATA%\CrashDumps`、`C:\Windows\Minidump` |
| wu_cache | Windows 更新缓存 | system | `%SystemDrive%\Windows\SoftwareDistribution\Download` |
| inet_cache | 网络缓存 | user | `%LOCALAPPDATA%\Microsoft\Windows\INetCache` |
| pip_npm_cache | 包管理器缓存 | user | pip cache、npm-cache |
| d3d_cache | D3D 着色器缓存 | user | `%LOCALAPPDATA%\D3DSCache` |

默认不勾选（medium）：
| id | 项目 | scope | 说明文案 |
|---|---|---|---|
| nvidia_shader | NVIDIA 着色器缓存（DXCache/GLCache） | user | 游戏首次启动会重新编译，稍慢几分钟 |
| nvidia_driver | NVIDIA 驱动更新缓存（UpdateFramework/Downloader） | system | 不影响已装驱动，下次更新需重新下载 |
| edge_cache | Edge 浏览器缓存 | user | 不影响书签/密码/历史 |
| chrome_cache | Chrome 浏览器缓存（如存在） | user | 同上 |
| prefetch | 预读取文件 | system | 系统会自动重建 |

默认不勾选（high，红色警告 + 二次确认）：
| id | 项目 | scope | 说明文案 |
|---|---|---|---|
| winsxs | WinSxS 组件清理（DISM） | system | 耗时较长（几分钟到十几分钟），清理期间请勿断电 |
| hibernation | 休眠文件（如存在） | system | 关闭休眠功能，释放约内存大小的空间 |
| driver_store | 过期驱动包（DriverStore） | system | 清理已淘汰的旧版驱动，保留当前在用版本 |

### 5.3 清理执行

- 每个项目独立 PowerShell 子进程，逐个执行，前端显示进度（x/y 完成）
- 删除策略：`Remove-Item -Recurse -Force` + 跳过占用/无权限文件（SilentlyContinue），不中断
- **失败自动重试**：单项目失败后自动重试 1 次（间隔 2 秒），仍失败则标记 failed 并触发失败诊断（见第 9 章）
- 完成后汇总实际释放字节数（清理前后 `Get-PSDrive C` 差值）
- 若所有清理项均失败（如权限异常），前端明确报错，不显示虚假成功

## 6. HTTP API

| 路由 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 前端页面（内嵌 HTML） |
| `/api/overview` | GET | 全部磁盘（C/D/E…）总量/已用/剩余 + 是否管理员 + 系统盘标识 |
| `/api/scan` | POST | `{disk}` 启动扫描（返回任务 id） |
| `/api/scan/:id` | GET | 轮询扫描进度与结果（增量：仅返回新增完成项） |
| `/api/verify` | POST | `{key}` → 验证结果 + 剩余有效时长 |
| `/api/clean` | POST | `{key, disk, items: [id...]}` → 再次验证密钥后执行清理，返回释放空间 |
| `/api/progress/:id` | GET | 清理进度 |

安全：所有路由校验 URL token（启动时生成，浏览器地址栏携带）；仅绑定 127.0.0.1；JSON 响应统一 `{ok, data|error}`。

## 7. 前端页面（简洁现代风格）

四个视图：
1. **首页**：全部磁盘卡片（C/D/E… 总量/已用/剩余进度条，红黄色提示空间紧张），点击选择目标盘（默认 C）；底部大按钮「开始扫描」；底部小字品牌信息
2. **扫描中**：各项目渐进式出现（先完成的先显示，带动画反馈）；顶部累计可清理量实时跳动；可提前看到部分结果
3. **扫描结果**：总可清理量大字展示；**「空间分布」区块**（所选盘 Top 大目录横向条形图，帮客户看懂空间去向）；分类列表按风险分级着色（绿默认勾选 / 橙带说明 / 红警告），红色项勾选时弹二次确认；密钥输入框 + 「验证密钥」；验证成功后「开始清理」按钮可用
4. **清理完成**：释放空间大字（清理前预估 vs 实际释放对比）+ 各项目明细（成功项绿标、失败项红标 + 诊断建议卡片 + 「重试此项目」按钮）；过期/无效密钥提示文案；「切换磁盘」按钮返回首页换盘操作（有效期内无需重新输入密钥）

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

## 9. 错误处理与失败诊断

### 9.1 基础错误处理

- PowerShell 脚本输出 UTF-8 JSON；子进程超时（扫描单项目 >5 分钟、清理单项目 >30 分钟）→ 终止并标记失败
- 扫描结果含不可读目录时静默跳过（沿用已验证的 SilentlyContinue 模式）
- 清理删除操作一律跳过占用文件，绝不因单个文件失败中断
- 服务异常统一 500 + `{error: "..."}`，前端 toast 展示
- 中文路径兼容：PowerShell 脚本一律 ASCII 内容、参数经 Base64 传递（规避 GBK 编码坑，2026-08-15 会话已验证此坑）

### 9.2 失败诊断与干扰检测（diagnose.js）

背景：清理系统级项目（WinSxS、系统 Temp 等）可能被第三方安全软件的文件防护拦截，表现为「拒绝访问/文件被占用」——2026-08-15 实测火绒拦截 DISM 组件清理（85% 时 0x80070005 拒绝访问）即为典型案例。

诊断流程（清理项目失败后自动触发）：

1. **错误分类**：解析 PowerShell 退出码与 stderr 关键词，归类为
   - `access_denied`（0x80070005 / ERROR_ACCESS_DENIED / 拒绝访问）
   - `file_locked`（0x80070020 / 文件被占用 / 正在使用）
   - `not_found`、`timeout`、`unknown`
2. **安全软件检测**：`Get-Process` 匹配进程特征表（仅检测，不终止任何进程）：
   | 安全软件 | 特征进程 |
   |---|---|
   | 火绒 | HipsDaemon, HipsTray, usysdiag, wsctrlsvc |
   | 360 安全卫士 | 360Tray, 360Safe, ZhuDongFangYu |
   | 腾讯电脑管家 | QQPCRTP, QQPCTray |
   | 金山毒霸 | kxescore, kxetray |
   | 微软 Defender | MsMpEng（正常系统组件，仅提示不强调关闭） |
3. **相关性判断**：错误类型 ∈ {access_denied, file_locked} 且检测到安全软件运行 → 生成针对性建议卡片
4. **建议文案**（以火绒为例）：「检测到火绒安全软件正在运行。项目「WinSxS 组件清理」失败（拒绝访问），很可能被其文件实时防护拦截。建议：打开火绒 → 防护中心 → 临时关闭「文件实时防护」→ 回到本页点击重试。清理完成后再开启防护。」
   - 未检测到已知安全软件时给通用文案：「文件可能被其他程序占用，建议关闭相关程序后重试」
5. **输出结构**：`{errorType, detected: [{name, hint}], suggestion, retryable: true}`
6. **前端失败卡片**：失败项目显示红标 + 原因分类 + 建议文案 + 「重试此项目」按钮（单独重试，不清除其他项目结果）
7. **安全边界**：诊断只读检测（进程列表、错误码），绝不主动关闭/修改安全软件及其配置；建议操作由客户手动完成

### 5.4 关键路径保护（防误删防线）

清理逻辑只作用于清单内白名单路径，且强制排除以下关键路径（即使被误配置也拒绝执行）：

- `%SystemDrive%\Windows\System32`、`%SystemDrive%\Windows\SysWOW64`、`%SystemDrive%\Windows\WinSxS`（DISM 项目除外，且该路径仅经 DISM 官方接口操作）
- `%SystemDrive%\Windows\Installer`（卸载信息，手工删除会破坏已装软件的卸载/修复）
- `%SystemDrive%\Windows\servicing`、`%SystemDrive%\Windows\Boot`、`%SystemDrive%\Windows\INF`
- `%SystemDrive%\Program Files` 与 `%SystemDrive%\Program Files (x86)` 本体（仅允许清理清单内明确列出的子缓存路径）
- `%USERPROFILE%` 非缓存类目录（Documents/Desktop/Pictures 等一律不触碰）
- 非系统盘（D/E…）仅允许两类操作：清空该盘回收站、只读空间分布分析。**任何非系统盘的目录删除都不在白名单内，首版一律不做**（游戏盘、资料盘风险高，避免误删客户数据）

### 9.3 与核心流程的关系

- 诊断在单项目重试 1 次仍失败后触发（第 5.3 节），作为失败状态的一部分返回前端
- 诊断结果不影响其他项目的继续清理（失败隔离）
- DISM/WinSxS 项目失败时优先怀疑安全软件（该类操作需 TrustedInstaller 级写入）

## 10. 测试策略

1. **license.js 单元测试**（node:test）：生成→验证通过；篡改签名→拒绝；过期→拒绝；换机（不同 MachineGuid）→拒绝；时间回拨→拒绝
2. **keygen.html 交叉验证**：keygen 生成的密钥能被 license.js 验证通过（共享主密钥一致性测试）
3. **diagnose.js 单元测试**：错误分类（各错误码/关键词映射）；安全软件检测（mock 进程列表：火绒/360/管家/无安全软件）；相关性判断（拒绝访问+火绒 → 提示火绒；拒绝访问+无安全软件 → 通用提示）
4. **扫描/清理本机实测**：在开发机实测全部扫描项与清理项（2026-08-15 已人工验证全部路径可达）
5. **诊断真实场景验证**：本机已装火绒，DISM 清理失败 → 应产出火绒针对性提示（2026-08-15 已确认该失败模式真实存在）
6. **打包后端到端**：SEA 打包 exe → 双击 → UAC → 浏览器全流程走通；清理实际生效（选一个安全项实测释放空间 > 0）
7. **跨机验证**（如可行）：虚拟机 Win10/11 各测一次启动流程

## 11. 项目结构

```
DiskCleanAgent/
├── src/
│   ├── main.js          # 入口：提权/服务/浏览器
│   ├── server.js        # HTTP 路由
│   ├── license.js       # 密钥验证（含 MASTER_KEY 占位符）
│   ├── scanner.js       # 扫描编排 + 扫描项定义
│   ├── cleaner.js       # 清理编排（含失败重试）
│   ├── diagnose.js      # 失败诊断：错误分类 + 安全软件检测 + 建议生成
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
- 不做客户数据回传（纯本地运行）
- 不做注册表清理、不做启动项管理（风险高且非空间回收核心）
