<p align="center">
  <a href="./USAGE.md">English</a> · <strong>简体中文</strong> · <a href="./README.zh-CN.md">README</a> · <a href="./ARCHITECTURE.zh-CN.md">架构设计</a>
</p>

# `super-work` 使用指南

本指南带你快速完成首次零配置上手、双基座大模型池与三角色配置、Web 决策指挥舱操作，以及日常多任务自治编排与一键版本发布实战（`v1.8.3`）。

---

## 目录

1. [三步零配置快速上手](#1-三步零配置快速上手)
2. [大模型与角色配置（双基座 Studio）](#2-大模型与角色配置双基座-studio)
3. [Web 决策指挥舱导览](#3-web-决策指挥舱导览)
4. [日常自主研发工作流](#4-日常自主研发工作流)
5. [版本里程碑与一键自举发布](#5-版本里程碑与一键自举发布)
6. [开发者引擎室：契约、记忆、评测、热备与自检](#6-开发者引擎室契约记忆评测热备与自检)
7. [CLI 与 MCP 指令速查](#7-cli-与-mcp-指令速查)
8. [多任务并发最佳实践与常见问题](#8-多任务并发最佳实践与常见问题)

---

## 1. 三步零配置快速上手

从全新克隆仓库到交付第一笔代码变更只需三步：

### 第一步 —— 启动守护进程与 Web 指挥舱

```bash
bun install && bun run build
bun run dev
# 守护进程 API + SSE: http://127.0.0.1:4318
# Web 决策指挥舱:     http://localhost:5173
```

*（如偏好纯终端引导，可执行交互式 `bun run setup` 或全自动 `bun run setup -- --auto`。）*

### 第二步 —— 一键零配置环境绑定
首次打开 `http://localhost:5173` 时，**首次运行向导**会自动扫描本机安装的 `claude`、`codex`、`opencode`、`gemini`、`gh`、`git` 与 `bun`：
- 点击 **「使用推荐默认配置开始」**（`POST /api/setup/quick-start`），即可免填任何 API Key 自动启用本机已登录的最佳 CLI（`claude` → `codex` → 本地启发式）；
- 或点击 **「自定义 LLM 与引擎」** 直接接入 API 模型并自定义三角色分工。

### 第三步 —— 注册代码仓库并下达需求
1. 在首页输入框左下角点击仓库胶囊旁的 **`+`**，选择本地 Git 仓库路径。系统会执行只读探测（`POST /api/repos/detect`），自动识别仓库名、基准分支、技术栈（Bun / Node / Rust / Python / Go）及测试门禁命令。
2. 直接在首页 **Hero Composer** 输入自然语言需求（或在终端执行 `super-work do "<需求>"`）。如需显式收敛修改目录，可在句末附带 `scope:<glob>`（例如 `scope:packages/server/**`）。

### 切换自治委托档位（Autonomy Dial）

在首页输入框底部工具栏可随时按仓库切换委托权限：

| 档位 | 交付门禁策略 | 运行行为 |
| :--- | :--- | :--- |
| **受控**（`guarded`） | `always_signoff` | 智能体自主完成编码、门禁与盲审，每次合入主干 / 建 PR 前都停下等你拍板 |
| **智能**（`smart`，默认） | `risk_gated`（阈值 `35`） | 低风险改动通过验证后自动合入交付；高风险或触及敏感路径时请你确认 |
| **全权**（`autonomous`） | `always_auto` | 端到端全自动交付；**仅**在真实受阻（冲突、越界、预算触顶）时打扰你 |

> **向后兼容**：`super-work.json` 或接口中的旧档位名（`copilot` → `guarded`、`standard` → `smart`、`autopilot` → `autonomous`）会自动归一化；你在仓库设置中显式修改的单项覆盖不会被自动重同步冲掉。

---

## 2. 大模型与角色配置（双基座 Studio）

打开 **设置 → 大模型与角色**，即可管理统一平级的双轨模型配置池。

`super-work` 采用**外层确定性治理基座**包裹两条平级可插拔的**内层编码基座**：
- **原厂 CLI 基座**（`claude` / `codex` / `opencode` / `gemini`）：直接复用本机包月订阅与原厂协同训练的工具循环。
- **内置 API 基座**（`DeepSeek` / `OpenAI 兼容` / `Anthropic 兼容` / `本地 Ollama`）：HTTP 直连配合受工单 worktree 严格约束的内置沙盒工具循环。

### 1. 先定三角色分工（或点选一键推荐搭配）
面板顶部采用**角色优先**布局：
- **一键推荐搭配**：根据你当前已就绪的模型实时生成（*API 控场 + 包月 CLI 编码*、*包月双 CLI 异构搭配*、*纯 API 自治模式*、*全池智能自动路由*），点击一次即可同时绑定三个角色。
- **三张角色卡**修改后立即保存生效：
  1. **控制模型**：负责理解需求、拆解 DAG、路由调度与看门狗诊断（可选零 Token 的*本地启发式规则*）。
  2. **工作实现模型**：负责在隔离 `git worktree` 中编码与自测（选*自动择优*时由 Bandit 胜率矩阵调度）。
  3. **交叉审查模型**：独立盲审实现改动（选*自动异构*时优先挑与编码不同的模型，避免同模型自审盲区）。
- **反模式顾问**：自动检测“实现与审查共用同一模型”、“已有就绪 AI 却仍用启发式控制”、“自动候选池为空”或“自定义配置未填完”，并提供**一键修复按钮**。

### 2. 新增模型、`/models` 实时拉取与中转网关
1. 点击 **「新增模型配置」**，按 API 协议轨道或本机 CLI 变体轨道选择模板（DeepSeek、OpenAI / 兼容 API、Anthropic / 兼容 API、本地 Ollama，或四大 CLI）。
2. 填好 **接口地址（Base URL）** 与 **API Key**（本地 Ollama / `localhost` 免填密钥）后，点击模型输入框旁的 **「获取可选模型」**（`POST /api/setup/models` / `/api/setup/model`）：系统自动探测上游 `/models`、`/v1/models`、`/model`、`/v1/model`（及本地 `/api/tags`），以可过滤标签列出真实可用模型 ID，点击即可填入。
3. 如需为某个本机 CLI 单独走第三方中转网关，展开 **「高级：自定义中转网关 / 独立密钥」** 填写中转地址与 Key（同样支持**获取中转可选模型**），按次调用注入环境变量，绝不污染本机 `~/.claude` 或 `~/.codex` 配置文件。
4. 点击 **「测试连接」**（`POST /api/setup/test-model`）确认延迟与可用性后保存。每张卡片上的 **「允许自动轮换」** 仅控制该模型是否进入「自动」候选池，不影响手动指定。

---

## 3. Web 决策指挥舱导览

界面由单行 **HeaderBar**（品牌图标 + `v1.8.3` 徽标 + 实时健康灯 · **首页 / 历史 / 设置** 胶囊页签 · `⌘K` 幕僚面板 · `中文 / EN` 切换）与三大空间组成：

### 1. 首页（Home）
- **Hero Composer**：
  - **快捷操作胶囊**（`修复 Bug`、`构建功能`、`安全重构`、`发布版本`）：选中后常驻可见并高亮显示（`aria-pressed` + `×`）。**再次点击当前激活胶囊**或点击末尾 **「取消 / 清空」** 即可取消模板并重置发布模式/版本号；未改动的模板可直接跨胶囊切换，你手写的自定义内容与自定义选项会被安全保留。
  - **选项（`▾`）**：开启*发布里程碑模式*、设置 `allowedPaths` 范围、为当前任务单独指定模型或设置美元预算上限。
  - **预览计划** 与 **运行**（`⌘⏎` / `Ctrl+Enter`）：可在正式派单前预演拆单路由（单任务 / 多步计划 / 优化循环）。
- **需要你处理（Needs You）**：将所有待决事项归并为 **批准**（交付签发、方案审批、观察拟单、里程碑待发布、Arena 择优）、**回答**（Worker 设计澄清提问、Epic 重规划）与 **解除阻塞**（越界拦截、看门狗告警、合并冲突、预算触顶、PR 返修、战役暂停），支持多选批量处理。
- **进行中的工作（Live Work）**：运行中工单实时显示跳秒计时器、最新语义动作徽章与标题、`计划 · 编码 · 评审 · 合并` 进度条，以及行内 **「实况 (n)」** 折叠面板（无需打开抽屉即可直接查看最近 6 步实时动态；服务端 SSE 回放缓冲保证刷新页面不丢轨迹）。

### 2. 下钻详情抽屉（DeepDive Drawer）
点击任意工单行打开右侧滑出工作台：
- **概览（Overview）**：
  - **置顶内嵌决策卡**：当工单处于 `needs_human`（如澄清提问、越界扩权）或 `outbox_pending` 待签发时，`NeedsYouCard` 直接置顶显示在抽屉内部，无需关抽屉回首页即可一键拍板。
  - **可视化实时执行面板**：配备阶段感知状态徽标（运行中显示绿色脉冲 `实时推送中`、待人工介入显示琥珀色 `等待你拍板`、完结显示灰色 `执行已结束`），支持按 `全部 / 工具 / 思考 / 阶段门禁` 筛选与自动滚屏；历史工单自动根据 `StageRun` 瀑布流合成可读轨迹。
  - **阶段流水线记录**：展示每阶段引擎、花费、`增量门禁` 节省时间、`StageSpan` 耗时条与 `StageToolProfile` 工具调用/报错热点。
- **变更（Changes）**：分文件折叠 **Diff Studio**、Arena 双引擎候选对比、代码行左侧 `+` 号锚定 **行内审查篮（Review Basket）**（支持「仅保存批注」与「打回修改」），以及不可变 Mandate 范围展示。
- **更多（`▾`）**：切换查看 **链式召回**（FTS5 检索 + 按需读取 Spill 原始日志/截图）、**发件箱**、**快照时间轴**（查看增量 Diff、原地回滚重导或分叉新工单），以及 **启动实时预览**、**存为黄金用例**、**回收工作树** 与 **一键安全回滚**。
- **底部常驻纠偏栏（Steer Bar）**：工单运行中发送指令即触发零惩罚 **实时纠偏（Live Steer）**（温和重启当前回合并保留工作树与会话，支持同步切换模型）；非运行态则作为 Thread 追加说明注入。

### 3. 历史（History）与设置（Settings / 引擎室）
- **历史**：一键切换 **时间线与发布**（活跃与历史归档里程碑 + 工单检索筛选）与 **看板 / DAG**（五列并发泳道 + 支持断点与节点热编辑的交互式 SVG **DAG Studio**）。
- **设置**：上半部分为 5 项高频精要设置（仓库与分支、自治等级、每日预算、大模型与角色、通知），下半部分可展开 **开发者 / 工程室（Engine Room）** 五大专业标签页。

---

## 4. 日常自主研发工作流

### 三种流水线模板

| 模板 | 阶段顺序 | 人工门禁 | 适用场景 |
| :--- | :--- | :--- | :--- |
| `fast` | `implement` → `rebase` | 仅异常或越界时介入 | 明确的小型修复、文案或配置微调 |
| `standard` | `plan` → `implement` → `review` → `rebase` | 按风险门禁或异常介入 | 日常主力研发（编码与审查异构盲审） |
| `strict` | `plan` → `implement` → `review` → `rebase` | 强制 `方案审批` + `交付签发` | 鉴权、计费、数据库迁移、核心契约变更 |

### 场景 A —— 单任务、跨模块 Epic DAG 与量化目标战役
- **一句话智能分诊**：在首页输入需求或运行 `super-work do "..."`——单一模块改动自动走 `single_ticket`；跨多模块/跨仓库需求自动拆解为并发 `epic_dag`（统一汇入 `super-work/epic/<id>` 跑全局终验后单次合入）；附带可执行指标（如 `指标命令: \`bun run bench\` 目标: 120`）则启动多波次 `goal_campaign`（指标退化自动单调回退）。
- **派单前预勘探（Pre-Flight Spec）**：复杂改动可执行 `super-work dispatch "..." --clarify`（`POST /api/specs/clarify`），先行查看 1-hop / 2+ hop 符号波及面与澄清问题。
- **红绿 TDD 测试锁（`--tdd`）**：在编码前插入 `spec_test` 阶段先写失败测试，并在编码阶段通过 OS 沙箱将测试文件设为内核级只读（`lockedTestPaths`），彻底杜绝 Worker 删改测试蒙混过关。

### 场景 B —— GitHub PR 评审与 CI 失败自动返修
- 在仓库设置绑定 `githubRepo`（`owner/repo`）或接入签名 Webhook（`POST /api/webhooks/github`）。
- 当 `super-work` 创建的未合入 PR 收到外部 Review 意见或 Actions CI 报错时，系统自动过滤 `[super-work]` 自身评论，唤醒原分支修复并通过本地门禁后增量推送更新原 PR（单 PR 最多自动返修 3 轮）。

### 场景 C —— 零浪费处理越界拦截与变基冲突
- **一键扩权续跑**：触碰 `.env*`、`*.pem`、`*.key` 或只读 `super-work.json` 会被立即回滚；若仅修改了 `allowedPaths` 之外的普通源码文件，改动会安全保留在工作树中并生成 `越界授权拦截` 卡片——点击 **「一键扩权并继续」** 即可免重烧 Token 直接验收推进。
- **3-Way 语义冲突消解**：Rebase 遇主干更新冲突时，自动打下隐藏快照并在无锁工作区执行单回合 3-Way 语义合并与门禁复验；若仍冲突则无损回退快照并附上双边差异摘要交你裁决。

---

## 5. 版本里程碑与一键自举发布

`super-work` 同时支持**主干就绪直接发版**与**多需求波次编排发版**：

### 模式 A —— 主干代码已就绪，直接发版（Squash + Tag + Push）
当各项功能/修复均已合入主干（如 `main`），只需合并未推送提交、升级版本号、打注释 Tag 并推送远端时：
1. 在首页点击 **「发布版本」** 快捷胶囊，填入目标版本号（如 `v1.8.3`）与可选标题，**文本框直接留空**（或写入 `整合修改、打 v1.8.3 tag 并推送远端` 等纯发版说明），点击 **「创建发布里程碑」**。
2. 系统不会启动多余的沙盒编码 Worker，而是立即在首页 **「需要你处理」** 生成 **`Milestone Ready`** 待发布卡片。
3. 可展开 *技术详情* 预览自动生成的中英双语发布说明，并在卡片上直接确认发版动作：
   - **同步升级 `package.json` 版本**（自动对齐根目录与 `packages/*/package.json`）
   - **压缩为单个发布提交**（自动将 `origin/main..HEAD` 未推送提交无损压缩为 1 个干净发布提交，并严格校验 `HEAD^{tree}` 文件树 SHA 100% 一致）
   - **创建 Git 标签**（生成 `vX.Y.Z` 注释标签；若本地同名标签已存在会在修改历史前安全拦截）
   - **推送到远端**（推送分支与标签至 `origin`）
   - **创建 GitHub Release**（需同时勾选标签与推送且本机 `gh` 已登录）
   - 可选自定义发布提交信息（默认 `feat: release vX.Y.Z`）
4. 点击 **「执行发布」** 一键完成（若放弃发版，点击 **「驳回」** 或里程碑面板的取消按钮即可调用 `POST /api/milestones/:id/cancel` 干净关闭）。

### 模式 B —— 多需求波次编排发版
1. 点击 **「发布版本」**，输入 `vX.Y.Z`，在文本框中**每行输入一项待开发需求**。
2. `planMilestoneWaves` 自动将互不重叠的需求放入同一波并发推进，路径重叠项自动串行到下一波。
3. 支持 `direct_main`（默认）或零中途签字的暂存分支模式（`super-work milestone create --integration milestone_branch`，所有子项先自动合入 `super-work/milestone/<id>`）。待全部子项交付后，自动弹出同一张首页 **`Milestone Ready`** 卡片供你一键签发。

---

## 6. 开发者引擎室：契约、记忆、评测、热备与自检

打开 **设置 → 开发者 / 工程室**（或按 `⌘K` / `Ctrl+K` 快速跳转）：

1. **契约与门禁**：双向同步 `super-work.json`（测试门禁、预热脚本、禁改路径、编码约定、风险门禁阈值、动态端口运行时冒烟 + CDP 浏览器视觉门禁，以及 `pre_deliver` / `post_deliver` / `on_escalate` 生命周期 Hooks）。
2. **记忆（Playbook 与 Casebook）**：管理经验规则（收件箱批注默认不入库，仅显式传 `saveToPlaybook: true` 且通过噪声卫生检查才沉淀）、检索历史判例库，或导出/导入跨仓 JSON **知识包**（`super-work bundle`）。
3. **自动化**：管理 **定时自治巡航**（Probe-to-Promote 静默巡检）与 **目标战役**（指标趋势线、波次记录、暂停/续跑/交付）。
4. **运维**：查看或一键 GC **工作树池**、推进或剔除 **并行投机合并列车** 槽位、**模拟外部触发器**，或查看 OS `launchd` / `systemd --user` 常驻服务日志。
5. **可观测性与健康**：
   - **自举飞行记录仪**：查看 24h / 7d / 全部窗口的交付率、增量+复用门禁节省时长、Canary 热重载/回滚、Watchdog 引擎切换/自适应延时与 Flake 重试统计，一键复制中英文运行摘要（`super-work digest --hours 24 --markdown`）。
   - **引擎熔断器**：瞬时故障自动冷却 15 分钟，额度耗尽/鉴权失效等持久故障熔断 24 小时，修复后支持一键 **重置 / 重新探测**。
   - **System Doctor 与 SQLite 在线热备**：一键检查数据库完整性、孤儿工作树、Playbook 噪声规则（一键**禁用噪声规则**）及 **`> 1,500` 行代码热点雷达**（一键派生安全拆分工单）；支持零锁 `VACUUM INTO` 热备份与自动带 `pre-restore` 保险快照的 **原子恢复**。
   - **黄金基准回放评测台**：在独立 `eval-worktrees/` 内跨多引擎回放真实历史工单，零副作用横向对比耗时、成本与一次过门禁率。

---

## 7. CLI 与 MCP 指令速查

```bash
# 日常核心指令
super-work do "<需求描述>" [--preview] [--wait] [--milestone vX.Y.Z]
super-work status
super-work watch [--repo <repoId>] [--ticket <ticketId>]
super-work logs <ticketId> [-f]

# 人工审批、实时纠偏与安全回滚
super-work inbox [list | approve <id> | reject <id> | batch --low-risk --approve]
super-work steer <ticketId> "<纠偏指令>" [--engine <engine>]
super-work ask "<询问队列阻塞或代码库现状>"
super-work revert <ticketId>

# 里程碑发版、目标战役与合并列车
super-work milestone [list | create --name <n> --version <v> [需求...] | show <id> | release <id> --bump --squash --tag --push [--github-release]]
super-work campaign [list | start <id> | pause <id> | deliver <id>]
super-work train [list | flush | eject <entryId>]

# 经验治理、体检热备、常驻服务与 MCP
super-work playbook [list | add "<规则>" | audit | prune [--delete] | sync [--export]]
super-work doctor [--fix] [--prune-playbooks]
super-work backup [list | create | restore <backupId>]
super-work eval [list | save <ticketId> | run <caseId> --engines claude,codex]
super-work reload [--skip-canary] [--force]
super-work up [-d] [--host 127.0.0.1] [--port 4318]
super-work service [install | uninstall | start | stop | status | logs]
super-work mcp
```

---

## 8. 多任务并发最佳实践与常见问题

1. **如何让多个 Worker 全速并发而不互相排队等待？**
   下达任务时通过 `scope:<glob>`（或选项中的范围路径）指定互不重叠的目录（例如 `scope:packages/core/**` 与 `scope:packages/web/**`）。无交集任务会在各自独立的 `git worktree` 中同时推进；存在路径交集的任务会自动通过 `waiting_deps`（`dependsOn`）串行排队，从根源避免合并冲突。
2. **提示 `Repository has no commits (unborn HEAD)` 怎么办？**
   `git worktree add` 要求目标仓库至少有一次提交。请先在目标仓库执行一次初始 `git commit`（如 `git commit --allow-empty -m "chore: init"`）。
3. **某个 CLI 模型卡片显示「未就绪」如何处理？**
   在终端完成对应工具登录（`claude auth login`、`codex login`、`gemini` 或 `gh auth login`），再回到 **设置 → 大模型与角色** 点击 **「扫描本机 CLI」**；或者直接点击 **「新增模型配置」** 接入任意 API 模型或本地 Ollama。
4. **运行时数据库、日志产物与临时工作树存在哪里？**
   全部隔离存放在 `.super-work/`（或 `SUPER_WORK_DATA_DIR`）目录下并已被 `.gitignore` 忽略。默认开启「自动回收 Worktree」时，完结或取消的工单会自动清理临时目录，同时完整保留分支记录与 Diff 供随时回看。
