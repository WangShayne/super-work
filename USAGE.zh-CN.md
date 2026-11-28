[English](./USAGE.md) | [简体中文](./USAGE.zh-CN.md)

# super-work 使用指南

本指南介绍如何完成 `super-work` 的首次运行环境扫描、控制面大模型配置，以及如何在日常研发中使用决策指挥舱进行异步多任务编排。

---

## 零、 v1.8.3：可取消的快捷 Chips 与可视化实时执行流

- 首页**快捷 Chips**可开关（再次点击已激活的 Chip，或点击**取消 / 清空**）。切换 Chip 会替换模板；你自己输入的文本会保留。退出“发版”会重置发版模式、版本号与标题。
- **观察执行**：运行中的任务行显示已用时间与最新一步；展开**实况 (n)** 查看最近 6 步的内联控制台，或打开任务抽屉查看完整执行流（过滤：全部 / 工具 / 思考 / 阶段门禁，自动滚屏开关，SSE 状态）。刷新页面时，服务端会重放最近的事件。

## 零、 v1.8.2：角色优先的「大模型与角色」Studio

打开 **设置 → 大模型与角色**：

1. **先选三个角色**——*控制*（理解需求、拆单、路由）、*实现*（在隔离 worktree 里写代码）、*交叉审查*（独立复核）。每张卡片都会提示推荐轨道。
2. **或直接点一键智能搭配**（仅在已就绪模型满足条件时出现）：*包月双 CLI 异构搭配*、*API 控场 + 包月 CLI 编码*、*纯 API 自治*、*全池智能自动路由*；当前生效的会显示绿色对勾。
3. **看卡片下方的顾问提示**：会提醒实现与审查同模型、仅用启发式控制、自动池为空、自定义模型未补全；点一键按钮即可应用建议。
4. **在下方管理配置池**：*原厂 CLI 基座*卡片复用本机订阅，*内置 API 基座*卡片直连 HTTP。徽标显示该模型承担的角色；**允许自动轮换**只影响「自动」模式，不会阻止手动选择；未补全的自定义模型会显示琥珀色**去补全**按钮。
5. **新增模型配置**按轨道分组模板、提供模型名称建议、标出 API 必填项，并把可选的 CLI 中转地址 / 密钥折叠在「高级」里。

## 零 a、 v1.8.1：配置池与角色指派

打开**设置 → 大模型与角色**（或安装向导的*自定义*）进入 **ModelRegistryStudio**。

**阶段 ① — 大模型配置池（CLI 与 API 平级）**

1. 点击**扫描本机 CLI**检测本机 `claude` / `codex` / `opencode` / `gemini`，顶部显示 `{已就绪}/{总数}`。
2. 点击**新增模型配置**，从 8 个平级模板中选择：**DeepSeek**、**OpenAI / 兼容 API**（OpenAI、OpenRouter、OneAPI、SiliconFlow、Qwen）、**Anthropic / 兼容 API**、**本地 Ollama**（`http://localhost:11434/v1`），或 **Claude / Codex / OpenCode / Gemini CLI**。填写 Base URL、模型、推理强度与 API Key（已保存的密钥以掩码显示，勾选*清除已保存的 Key*即可删除）。CLI 配置的可选中转 Base URL / API Key 会注入为 `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `GOOGLE_GEMINI_BASE_URL`。
3. 点击**测试连接**（`POST /api/setup/test-model`）查看延迟与状态，再点击**保存模型配置**。
   - **获取可选模型（v1.8.2）**：填好*接口地址*与 *API Key* 后，点击模型名称旁的**获取可选模型**。系统通过 `POST /api/setup/models`（别名 `POST /api/setup/model`）依次探测上游 `/models`、`/v1/models`、`/model`、`/v1/model`（本地端点另加 Ollama 原生 `/api/tags`），并以可点击的标签列出结果，点击即可填入模型名称。编辑已保存配置时会复用已存密钥（不会回传浏览器）。CLI 配置在*高级：自定义中转网关*中填写中转 Base URL 后，也可点击**获取中转可选模型**。
4. 每张卡片可切换**参与自动工作池**（是否纳入 Worker 智能路由）、**测试**、**编辑**，或**删除**（仅自定义配置，行内二次确认）。内置 CLI 配置的类型与引擎被锁定，且不可删除。

**阶段 ② — 角色模型指派**

选择**控制模型**（路由 / 拆单 / 看门狗；*本地启发式规则*不消耗 Token）、**工作实现模型**与**交叉审查模型**（*自动*走 Worker 池智能路由，审查优先选择不同模型盲审）。仅列出*已就绪*的配置；修改后立即保存并提示*已保存*；选中仓库时还会同步更新该仓库的 `implementModelId` / `reviewModelId`，且不会覆盖 `auto`。

通过 `POST /api/setup/configure` 的 `deleteModelProfileIds` 删除配置后，曾使用它的角色回退为 `heuristic` / `auto`。首页编辑器的*选项 → 模型*与 DeepDive 的 Steer 栏从同一批已就绪配置中选择（`preferredModelId`）。

## 零、 v1.8.0 快速开始：Super-Agent First

v1.8.0 的主题是*消费级界面，专业级引擎*：三步即可从零到交付一次变更。

1. **1 键完成配置。** 打开 Web 界面，零配置 SetupWizard 调用 `POST /api/setup/quick-start`，自动选择已登录的最佳 CLI（`claude` → `codex` → 启发式）作为控制面 LLM。
2. **添加仓库。** 选择目录；`POST /api/repos/detect`（只读）推断名称、基线分支、技术栈（Bun / Node / Rust / Python / Go）与验证命令；`POST /api/repos` 以 `standard` `AutonomyPreset` 创建仓库。
3. **说出需求。** 在 Home 的 **Hero Composer** 中输入（或运行 `super-work do "<需求>"`）。智能分诊隐式完成路由；追加 `scope:<glob>`（如 `scope:packages/core/**`）可固定允许路径。

```bash
super-work do "新增 /healthz 接口 scope:packages/server/**"
super-work do "新增 /healthz 接口" --preview             # 仅预览计划，不创建任务
super-work do "新增 /healthz 接口" --wait                # 阻塞直至完成
super-work do "新增 /healthz 接口" --milestone v1.9.0    # 归入里程碑
super-work up [-d|--detach]                              # 显式启动守护进程
```

### 授权拨盘（Hero Composer）

| 预设 | 交付门禁 | 行为 |
|---|---|---|
| **受控**（`guarded`） | `always_signoff` | 智能体自主完成编码与验证，但每次合入前都停下来等你拍板 |
| **智能**（`smart`，默认） | `risk_gated`（阈值 35） | 低风险改动自动合入交付，高风险或敏感变更才请你确认 |
| **全权**（`autonomous`） | `always_auto` | 端到端全权委托交付，仅在真正受阻（冲突、预算、越界）时通知你 |

所有预设均使用 `mode: auto`、`sandboxMode: balanced`、`verificationStrategy: smart_tiered`。预设仅在首次或强制同步时展开；自动重同步绝不覆盖你通过 `PATCH /api/repos/:id` 设置的显式覆盖。

> **旧名称**：`copilot` → `guarded`、`standard` → `smart`、`autopilot` → `autonomous`。`.super-work.json`、REST 请求体与已存储仓库中的旧值仍被接受并自动归一化，无需迁移。

### 三大空间

- **Home（首页）**：Hero Composer（含可折叠 *Advanced ▾*）、**Needs You**、**Live Work** 卡片。Needs You 将所有收件箱类型归并为三个动词：**Approve 批准**（签核、计划批准、观察提案、里程碑就绪、擂台裁决）、**Answer 回答**（澄清请求、Epic 重规划）、**Unblock 解阻**（授权违规、Watchdog 升级、合并冲突、预算上限、PR 跟进、战役暂停）。
- **History（历史）**：时间线与发布（Timeline & Releases）、看板 / DAG。
- **Settings（设置）**：5 项 Essentials + 可折叠 **Developer / Engine Room**（Contract / Gates、Playbook / Casebook、Routines / Campaigns、Worktrees / Merge Train / Simulate、Flight Recorder / Doctor / Evals）。
- **DeepDiveDrawer**：*Overview & Changes* + *More ▾*，底部常驻 **Steer** 输入栏。
- **HeaderBar**（单栏）：`v1.8.2` 徽标 + 实时健康点 · 胶囊标签页（Home / History / Settings） · `⌘K` / `ZH-EN`（非首页标签另有紧凑仓库胶囊）。
- **Hero Composer 上下文工具栏**：仓库切换器（含注册） · **受控 / 智能 / 全权** 拨盘 · *Advanced ▾*，直接集成在需求输入框下方。

以下章节深入介绍完整的 Engine Room 能力。

---

## 一、 首次运行：CLI 自动扫描与控制面 LLM 配置

`super-work` 采用**控制面 + 执行面**分离架构：
- **执行面（Worker）**：直接复用本机安装的 Coding Agent CLI（`claude`、`codex`、`opencode`、`gemini` 等）。
- **控制面（Router / Watchdog）**：负责新事件分诊、任务作用域划分以及异常卡死诊断。

### 方式 A：Web 指挥舱可视化向导（推荐）

1. 启动服务并打开看板 `http://localhost:5173`：
   ```bash
   bun run dev
   ```
2. 首次启动且尚未完成初始化时，系统会自动弹出 **「首次运行环境扫描与模型配置」** 向导（此后也可随时点击右上角 **环境与模型** 按钮再次打开）：
   - **本机 CLI 工具链扫描**：自动探测 `claude`、`codex`、`opencode`、`gemini`、`gh`、`git`、`bun` 的安装路径、版本、登录认证状态（`已就绪` / `未登录` / `未安装`）以及 `~/.claude/settings.json`、`~/.codex/config.toml`、`~/.config/opencode/opencode.json`、`~/.gemini/settings.json` 中的本机默认模型与思考强度。
   - **默认引擎与 CLI 模型/强度档位**：分别为 `Claude Code`、`Codex CLI`、`OpenCode CLI`（`provider/model#variant`）与 `Gemini CLI` 配置全局默认模型和思考强度（`low` / `medium` / `high` / `xhigh` / `max`）；留空则沿用本机全局配置文件，**派发任务弹窗也支持对单个任务做临时覆盖**。
   - **控制面大模型配置**：从五种方案中任选其一，点击 **「测试连接」** 验证延迟与连通性，再点击 **「完成配置并启用」**（保存后立即热生效，无需重启进程）：

| 方案 | 适用场景 | 费用与依赖 |
| :--- | :--- | :--- |
| **DeepSeek API**（默认推荐） | 日常高频路由与 Watchdog L2 语义诊断 | 需 `DEEPSEEK_API_KEY`，接口 `https://api.deepseek.com/v1`，模型 `deepseek-chat` |
| **OpenAI / 兼容接口** | 接入 OpenAI、Azure、OneAPI 或本地 Ollama | 填写对应 `Base URL`、`Model` 与 `API Key` |
| **复用本地 Claude CLI** | 已登录 Claude Code 且不想单独申请 API Key | 零额外密钥，支持指定模型与思考强度（推荐 `low`） |
| **复用本地 Codex CLI** | 已登录 Codex CLI 且不想单独申请 API Key | 零额外密钥，只读结构化输出，支持指定模型与思考强度（推荐 `low`） |
| **本地启发式引擎** | 离线演练、Mock 测试或零控制面 Token 消耗 | 免配置、零网络请求 |

### 方式 B：终端交互 / 全自动配置命令

也可以在启动前通过终端命令完成扫描与写入：

```bash
# 交互式扫描并引导配置
bun run setup

# 非交互模式：按扫描结果与当前环境变量自动写入最佳配置
bun run setup -- --auto
```

---

## 二、 界面三层导航与核心概念速查

### 1. 顶部控制栏
- **仓库切换、`+` 注册与偏好设置按钮**：自动识别当前工作区 Git 仓库并绑定远程 `owner/repo`；点击仓库旁的 **「偏好设置」** 图标可按仓库单独调整默认流水线模板（`fast`/`standard`/`strict`）、首选编码/审查引擎、基准分支以及 **交付/取消后自动回收 Worktree** 开关。
- **自治模式开关**：
  - `关闭 (off)`：仅记录事件触发器，不生成任务。
  - `观察 (observe)`（推荐初上手）：收到外部事件后仅**拟单**放入「决策收件箱」等你点头确认，绝不私自改代码。
  - `自动 (auto)`：收到高信噪比事件后直接入队执行，仅在触发审批门禁或异常升级时通知你。
- **状态指示灯与 `⌘K` 全局指令/幕僚面板**：顶栏首行提供 **`⌘K 指令/幕僚`** 快捷键（支持即时搜索工单/记忆，或输入 `?` 向幕僚只读提问态势）；第二行紧凑展示 `实时同步`（SSE）、`总控大脑`、`Agent 分工`、`工程契约`（开启风险门禁时自动显示 `风险门禁`）、`防卡死巡检`、`PR 交付队列`、`定时巡航` 与 **`工作树池`（支持查看/一键 GC 或快捷跳转至系统自检）**，以及 `环境与模型`（内含 **系统自检与热备份/原子恢复** 标签页）/ `中文 / EN` 切换。

### 2. 三层信息结构与 `@super-work/cli`
1. **决策收件箱（Attention Inbox）**：聚合 `观察模式拟单`、`方案审批门禁`、`越界授权拦截`（普通越界保留现场一键扩权，不可变 `super-work.json` 与敏感路径强制回滚）、`看门狗升级告警`、`合并冲突待解`、`目标战役熔断暂停`、`PR 交付签发`、`每日预算触顶`、`Arena 双引擎决胜`、`Epic 规划调整`、`Worker 设计歧义提问`与 `PR 评审/CI 返修`，并支持多选及「仅选低风险」批量审批。
2. **态势看板 & 并行合并列车**：五列泳道实时展示风险分数标签、TDD/Auto-Arena 徽章与 Epic DAG 画布；点击顶部状态条 **「PR 交付队列」** 可随时查看、推进或驱逐 **并行投机合并列车与跨仓屏障** 槽位。
3. **定时巡检 & 目标战役（Autonomous Routines）**：视图顶部分段切换 **定时巡检** 与 **目标战役（Goal Campaigns）**，支持设置指标测量命令、内联 SVG 指标趋势线（Sparkline）与回归单调回退保护。
4. **效能与预算（Metrics & Budget）**：展示当日预算水位进度条、端到端交付成功率、累计花费、按引擎 × 任务类别的 Bandit 评分矩阵，以及 **Golden Eval 黄金基准回放评测台**。
5. **下钻详情抽屉 & 命令行客户端（`bun run cli` / `super-work`）**：
   - `super-work up [-d] [--host 127.0.0.1] [--port 4318]` / `super-work service [install|uninstall|start|stop|status|logs]`：前台/系统常驻守护进程（`launchd` / `systemd --user`）安装与启停管理。
   - `super-work milestone [list | create --name <n> [--version <v>] [--repo <id>] <需求...> | show <id> | release <id> [--bump] [--tag] [--push]]`：创建多波次里程碑并显式发布（未传 `--tag` / `--push` 时不会打标签或推送）。
   - `super-work campaign ...` / `super-work train [list|flush|eject]`：终端创建/控制指标驱动目标战役与并行合并列车队列。
   - `super-work status`、`intake [--preview] [--wait] "<需求>"`、`wait <ticketId|epicId>`、`reload [--skip-canary] [--force]`、`ask <问题>`、`steer <ticketId> <纠偏指令>`、`blueprints`、`dispatch <title> -d <desc> [--blueprint <id>] [--gate-policy <policy>] [--wait]`、`epic <title> [--preview-only|--wait]`、`inbox [list|approve|reject|batch]`、`eval [list|save|run|delete]`、`doctor [--fix]`、`backup [list|create|restore <id>]`、`bundle [export|import <file>]`、`logs <ticketId> [-f]`、`watch`、`revert <ticketId>`、`playbook [list|add|toggle|delete|sync --export]`。

### 3. 三种流水线模板对比

| 模板 | 阶段流水线 | 人工门禁 | 适用场景 |
| :--- | :--- | :--- | :--- |
| `fast` | `implement` → `rebase` | 无 | 明确的小型 Bug 修复、文档或样式微调 |
| `standard` | `plan` → `implement` → `review` → `rebase` | 仅异常或越界时介入 | 日常功能开发（编码与审查可配异构引擎交叉验证） |
| `strict` | `plan` → `implement` → `review` → `rebase` | 强制 `方案审批` + `PR 交付签发` | 核心模块改造、鉴权/支付等高风险改动 |

---

## 三、 四大实战工作流

### 1. 智能需求直投、主动单任务与 Epic 拆单 DAG
1. 点击右上角 **「派发任务」**：
   - **智能需求直投（默认页签）**：直接丢入自然语言需求（可选填量化优化指标命令），点击 **「预演路由与范围」** 查看自动匹配的路由方案（`single_ticket` / `epic_dag` / `goal_campaign`）与路径作用域，确认后 **「一键智能派发」**；也可在终端执行 `super-work intake --wait "..."`。
   - **单任务派发**：填写任务标题与目标说明，选择流水线模板、执行引擎（`claude` / `codex` / `opencode` / `gemini` 及可选单任务模型/思考强度覆盖），并在 **Mandate 允许修改路径** 中收敛授权目录（触及越界或 `.env*` / `*.pem` / `*.key` 将自动回滚并告警）。
   - **复杂需求拆单 (Epic DAG)**：切换到 Epic 标签页，默认使用 **统一集成分支 `super-work/epic/<id>`**（也可切回逐子单独立交付），描述跨模块需求后点击 **「AI 预览拆单 DAG」**，可直接编辑每条子任务的模板、描述、授权路径与前置依赖关系；全部子任务汇入集成分支后由内核执行全局终验与单轮集成自愈，最终聚合提交 1 个 PR 或 1 次本地合入。

### 2. 观察模式下模拟 / 监听 GitHub 事件并审批（含 PR 返修闭环）
1. 保持顶部自治模式为 **`观察`**，点击 **「模拟事件」**（或由内置的 `GhCliPollingSource` 自动轮询已绑定的 GitHub 仓库 Issue / PR Review / Actions CI 失败日志）。
2. 当已提 PR 收到外部 Review 意见或 CI 失败时：内核会自动过滤 `[super-work]` 自身评论，在 `auto` 模式下直接唤醒原分支轻量修复、跑通本地校验后增量 `git push` 更新同一个 PR 并自动评论回复（单 PR 最多自动返修 3 轮；`observe` 模式先推送至收件箱待批）。
3. 提交后，事件会先经过 `MasterAssessor` 评估，随后在 **决策收件箱** 出现一条「观察模式拟单」。
4. 你可在输入框补充额外提示，点击 **「批准并继续」**，任务立即转入独立 `git worktree` 开始执行。

### 3. 文件树 Diff 审查台、行级批注篮与链式召回
1. 在态势看板点击任一任务，打开 **下钻详情抽屉**：
   - **执行轨迹**：查看各阶段状态、对进行中任务下发 **实时纠偏 (`Live Steer`)**、查看 **阶段分片耗时瀑布流 (`StageSpan`)**、**工具调用热点画像 (`StageToolProfile`)**、**风险评分卡片**、3-Way 冲突解析摘要与实时 SSE 事件流，或在已交付任务右上角点击 **「存为黄金用例」**。
   - **Diff 与授权边界**：通过 **文件树 Diff 审查台** 查看分文件 `+`/`-` 统计与折叠代码块，浏览内联 AI `review_comments` 与结构化审查清单，点击任意代码行左侧 **`+`** 锚定行级批注加入 **Review Basket**（支持「仅保存批注」或一键 **「打回修改 (Request Changes)」**，返修触及对应文件并过门禁后自动标为已解决），也可点击文件右上角 **「针对此文件返修」**。
   - **链式召回**：沿 `Trigger → Thread → Inline 摘要 → Spill 溢出产物`（含结构化 JSON `review_report` 与 `test_log`）溯源，或用 FTS5 搜索历史经验。
2. **Thread 订阅追问**：在抽屉底部输入框发送补充要求，消息直接注入活跃 `Thread`。

#### 8. 韧性与 Watchdog 2.0 可观测性（`v1.7.0`）
1. 引擎熔断已分级：瞬时故障冷却 15 分钟；持久故障（`model_unsupported`、`tier_ineligible`、`auth_invalid`、`quota_exhausted`）冷却 24 小时。Web **Doctor** 页中持久熔断显示「持久熔断（需重置/探测）」，修复账号/模型后点击**重置**或**重新探测**；瞬时熔断显示临时冷却徽标及冷却时间。
2. `super-work digest --hours 24` 在计数非零时会提及 **Watchdog 2.0 延长** 与 **Flake 重试**；飞行记录器面板在「Watchdog 引擎切换」下展示。
3. MCP `1.7.0`（27 个工具）、CLI `v1.7.0`、Web 徽标 `v1.7`。

## 4. 任务蓝图、黄金评测、原子恢复、知识包与安全回滚
- **派发任务（Task Blueprints）与交付风险门禁（A.1 Risk Gate）**：派发弹窗支持一键选用 `tdd-bugfix`、`ui-visual-polish`、`safe-refactor`、`backend-feature`、`docs-chore` 或 `super-work.json` 自定义蓝图快速填充模板/TDD/路径与门禁策略；可在 **仓库偏好设置 → 运行时与策略** 配置 `deliveryGatePolicy`（`always_auto` / `risk_gated` / `always_signoff`）、风险阈值 `riskThreshold` 与高敏感路径 `sensitivePaths`。
- **黄金基准回放、知识包迁移与 SQLite 原子恢复（D.1）**：可在抽屉保存已交付工单为黄金基准并在 **效能与预算 → 黄金基准回放评测台** 跨引擎隔离回放对比（`super-work eval`）；在 **仓库偏好设置 → 经验库** 一键导出/导入包含 Playbook + Casebook + Blueprints 的 **知识包**（`super-work bundle`）；在 **环境与模型设置 → 系统自检与热备份** 执行零锁 `VACUUM INTO` 热备份与带 `pre-restore` 保险快照的 **原子恢复**（`super-work backup restore`）。
- 通过 `local_merge`（统一 `--no-ff` 生成单点 Merge Commit）本地合入主干后，抽屉顶部提供 **「一键安全回滚」** 按钮（或运行 `super-work revert <ticketId>`），执行非破坏性 `git revert -m 1` 生成反向提交。

---

### 5. 里程碑：多需求波次编排与受控发布（`v1.4.0`）
1. 打开 **派单 → 里程碑批量编排**（或执行 `super-work milestone create --name "v1.4.0 发布" --version 1.4.0 "需求一" "需求二"`），填写名称、目标版本及 Markdown 列表（项目符号/编号）形式的需求清单。
2. 路径重叠的需求自动串行到后续波次，互不相干的并行执行；可在看板上查看波次卡片。
3. 全部交付后里程碑进入**待发布**：可在看板或收件箱「里程碑待发布」卡片中查看中英文发布说明。
4. 显式发布：勾选「同步升级 package.json 版本」（默认勾选），按需勾选「创建 Git 标签」「推送到远端」（默认均关闭），再点击确认。同样可通过 `POST /api/milestones/:id/release`、`super-work milestone release <id> --bump` 或在收件箱批准（仅升级版本）完成。

### 6. 里程碑暂存分支与 Squash 发布（`v1.5.0`）
1. 在 **派单 → 里程碑批量编排** 中选择 **集成模式 = 里程碑暂存分支**（CLI：`super-work milestone create --name "v1.5.0 发布" --version 1.5.0 --integration milestone_branch --route auto "需求一" "需求二"`）。使用 `--route single_ticket` 可跳过 Epic/战役拆分。
2. 各项自动合入 `super-work/milestone/<id>`（以「暂存分支」徽标显示），无需逐项签收；发布前基线分支保持不变。
3. 全部交付后，批准唯一的**里程碑待发布**卡片，或显式发布：勾选「压缩为单个发布提交」即可得到文件树与合并结果一致的一个干净提交。CLI：`super-work milestone release <id> --bump --squash [-m "feat: release v1.5.0"]`；REST 请求体：`{"bumpVersion":true,"squashReleaseCommit":true,"createTag":false,"pushRemote":false}`。
4. 已发布里程碑进入可折叠的**已发布里程碑**区域（版本、发布提交 SHA、中英文发布说明）。
5. 引擎健康可通过 `GET /api/system/engines` 与 MCP `manage_engine_health`（`list|reset|probe`）查看。

### 7. Playbook 卫生与可选 GitHub Release（`v1.6.0`）
1. Inbox 备注**默认不再写入 Playbook**。需显式传入 `saveToPlaybook: true`（REST）才会保存；“human approved continuation”、工单 ID 等一次性备注仍会被跳过。
2. 审计：`super-work playbook audit`（REST `GET /api/playbooks/hygiene`，MCP `manage_playbook_hygiene {action:"audit"}`）。清理：`super-work playbook prune`（禁用噪声规则，加 `--delete` 则删除）或 `super-work doctor --prune-playbooks`。Web **Doctor** 页的 **Playbook 卫生** 卡片提供「禁用噪声规则」按钮。REST 清理接受 `{ repoId?, dryRun?, mode? }`。
3. 飞行记录器面板现在展示合并后的校验门节省（精简校验 + Rebase 复用）以及引擎熔断 / 溢出隔离计数。
4. 可选 GitHub Release：`super-work milestone release <id> --bump --tag --push --github-release`（REST `createGithubRelease: true`；Web 勾选框仅在同时勾选*标签*与*推送*时可用）。需要里程碑目标版本与已登录的 `gh`；非法组合会在触碰 git 之前被拒绝，默认关闭。

## 四、 多任务并发最佳实践与常见问题（FAQ）

1. **如何让多个 Worker 真正并发而不互相排队？**
   - 派发任务时为不同任务填写互不重叠的 **Mandate 允许修改路径**（例如任务 A 填 `packages/core/**`，任务 B 填 `packages/web/**`）。当检测到两个任务路径无交集时，内核会在各自独立的 `git worktree` 中全速并发；只有路径存在重叠时才会自动通过 `dependsOn` 串行排队，避免 Merge 冲突。
2. **提示 `Repository has no commits (unborn HEAD)` 怎么办？**
   - `git worktree add` 要求目标仓库至少已有一次提交。先在仓库根目录完成一次 `git commit` 即可。
3. **扫描显示 CLI「未登录」怎么处理？**
   - Claude Code：在终端运行 `claude auth login`
   - Codex CLI：在终端运行 `codex login`
   - Gemini CLI：运行 `gemini` 完成 OAuth 登录，或设置 `GEMINI_API_KEY`
   - GitHub CLI：在终端运行 `gh auth login`
   - 完成后在网页端点击 **设置 → 重新扫描** 即可更新为「已就绪」。
   - 提示：对 `super-work` 自身开发后可在 **环境与模型 → 系统自检与热备份 → 自举热演进** 手动触发金丝雀重启，或运行 `super-work reload`。
4. **在哪里查看或清理工作树与数据库？**
   - 所有运行时状态库（`super-work.db`）、Spill 产物与临时 `worktrees/` 均隔离存放在 `.super-work/`（或 `SUPER_WORK_DATA_DIR` 指定目录）下，且已被 `.gitignore` 忽略；开启仓库的「自动回收 Worktree」后，任务交付或取消时会自动回收工作树目录（仍保留分支 Diff 可回看），也可以点击状态栏 **「工作树池」** 一键 GC 清理历史或孤儿目录。

## 五、 自托管快速检查：里程碑与运行摘要

列出所有里程碑，并以 Markdown 输出最近 24 小时的运行摘要，用于快速确认自托管实例运行正常：

```bash
super-work milestone list
super-work digest --hours 24 --markdown
```
