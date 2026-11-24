[English](./README.md) | [简体中文](./README.zh-CN.md)

# super-work

基于 DeepSeek Harness 团队技术文章《Super-agent 设计探索：迈向更自主的 Agent 系统》构建的异步自主研发工作流编排内核与本地决策指挥舱（TypeScript / Bun Monorepo）。

> **核心理念**：AI 辅助研发的核心瓶颈已经不是单次模型推理能力，而是**人类的注意力带宽**。`super-work` 将开发者从同时紧盯 3–5 个终端会话的“微操员”解放为**审批边界与结果的决策者**——轻量控制面常驻调度，执行面在隔离的工作区与不可变授权边界内自主推进。

---

## 核心能力

- **Router + 隔离 Worker 双层架构**：
  - **控制面（`EventIntakeRouter` & `MasterAssessor`）**：统一接收入站触发器（`web`、`github_issue`、`github_pr`、`github_ci`、`cli`），具备 **两层只读代码探针系统（`ReadOnlyRepoProber`：`search_symbols`/`read_file_slice`/`grep_literals`/`git_recent_commits`，严格越界防护与 `.env*` 脱敏，2 轮有界循环）**，提供派单前 **Pre-Flight Spec Studio 预勘探与澄清（`POST /api/specs/clarify` 与 `--clarify`，注入 1-hop / 2+ hop 符号影响面分析）**，注入仓库契约（`super-work.json`）、**命中追踪与衰减自净的 Playbook 经验库**及**混合加权历史判例库（Casebook）**，支持 **跨仓库联合 Epic 与 `--depends-on` 依赖编排（含 1-hop 语义依赖自动串行）**、**自适应引擎多臂老虎机路由（`--engine auto`）与低置信双引擎 Auto-Arena 触发护栏**、**红绿先测试守卫（`--tdd` + `SPEC_TEST_CHALLENGE` 单次回退重审）**、**交互式 DAG 拓扑画布与热修改断点（`--pause-before-run`）**、**回合中零惩罚实时纠偏（Live Steer：`POST /api/tickets/:id/steer`）**、**Worker `[ASK_HUMAN]` 结构化歧义提问（单任务限 1 次，`auto` 模式自动采纳推荐项防卡死）**、**零 LLM 工具调用画像（`StageToolProfile`）**、**阶段 Git 检查点时间旅行 Re-steer**、**定时探测晋升巡航（Probe-to-Promote）**，以及守护进程重启断点自愈。
  - **执行面（`WorkerDriver` & `GitWorktreeProvider`）**：在独立的 `git worktree` 分支中调度外部 Coding Agent（`ClaudeCodeDriver`、`CodexDriver`、`OpenCodeDriver`、`MockWorkerDriver`），通过 **OS 原生安全沙箱（`sandboxMode`：`balanced` | `strict` | `off`，基于 macOS Seatbelt / Linux `bwrap` + `readOnlyPaths` 测试文件内核级只读锁 + 自动清洗密钥环境变量）** 约束写边界，支持 **`setupCommands` 预热**、**结构化对抗盲审**、**临时服务运行时冒烟 + 零依赖 CDP 无头浏览器门禁（支持交互 `steps` 与纯 TS 像素级视觉回归对比 `visualDiffMode`）**、隐藏 Git ref 阶段检查点与 Worktree GC。
- **原生 MCP 服务器与双向签名 Webhook**：
  - **零外部 SDK 的原生 MCP 服务（`v1.1.0`）**：同时提供 Streamable HTTP（`GET/POST /api/mcp`）与 `super-work mcp` stdio 桥接（本地守护进程离线时自动拉起），暴露 **19 个工具**（`clarify_spec`、`dispatch_ticket`、`dispatch_epic`、`list_tickets`、`get_ticket_detail`、`list_inbox`、`resolve_inbox`、`batch_resolve_inbox`、`steer_ticket`、`ask_chief`、`manage_evals`、`search_memory_and_casebook`、`trigger_routine`、`manage_preview`、`analyze_impact`、`manage_checkpoints`、`mutate_dag_node`、`submit_review_comments`、`system_doctor`）与 **3 个资源**（`superwork://health`、`superwork://repos`、`superwork://inbox/pending`）。
  - **双向签名 Webhook 与移动端审批卡**：接收 HMAC-SHA256 验签的 GitHub Webhook（`POST /api/webhooks/github`，`X-Hub-Signature-256`）与 ChatOps 回调（`POST /api/webhooks/chatops`），并在飞书/Slack/Discord/通用 JSON 推送中附带 **防爬虫预览误触发的签名远程审批卡片（`GET/POST /api/webhooks/action`）**，同时支持 macOS 原生通知。
- **可组合任务蓝图与风险评分置信度交付门禁**：内置 5 套 **Task Blueprints**（`tdd-bugfix`、`ui-visual-polish`、`safe-refactor`、`backend-feature`、`docs-chore`）并支持在 `super-work.json` 扩展自定义 `blueprints`（严格遵循 `explicit > blueprint > repo` 优先级）。所有非汇总任务入库前通过 **`evaluateTicketRisk`** 对 Diff 体积、`sensitivePaths`、符号波及扇出、视觉差异比例、重试次数、冲突解决与校验置信度给出 `0–100` 确定性评分；当启用 `risk_gated` 策略且超过 `riskThreshold` 时，自动生成带风险因子拆解的 `outbox_signoff` Inbox 审批卡。
- **行级锚定审查工作台与 3-Way 语义冲突自动消解**：
  - **Line-Anchored Review Studio**：将 AI 结构化审校结论持久化同步至 `ticket_review_comments`，在 Diff Studio 支持按代码行点击 `+` 批注、汇入 **Review Basket**（区分「仅保存批注」与「打回修改 `request_changes`」），并在后续修改触达对应文件且通过校验后自动流转为 `resolved`。
  - **3-Way 语义变基冲突解析**：Rebase 遇冲突时先打隐藏快照 `pre_rebase_conflict`，通过 `prepareThreeWayConflictWorkspace` 提取共同祖先、上游最新提交摘要及双边 `ours`/`theirs` 差异摘要构建无锁干净工作区，在单回合限定内调用编码引擎协同消解冲突（全程受 `lockedTestPaths` 只读与全量门禁保护）；若仍失败则无损回退快照并升级附带完整语义上下文的 `merge_conflict` 审批卡。
- **阶段瀑布流监控、系统诊断（System Doctor）、原子热恢复、黄金评测台与知识包迁移**：
  - 内联记录 `StageSpan` 阶段分片耗时与 `StageToolProfile` 工具热点画像；提供 **`System Doctor`** 多维巡检自愈、基于 **`VACUUM INTO`** 的零锁 SQLite 热备份，以及校验完整性的 **原子热恢复（`POST /api/system/backups/:id/restore` & `super-work backup restore`，自动打 `pre-restore` 保险快照）**；内置隔离 `eval-worktrees/` 的 **Golden Eval Suite** 多引擎回放评测台与可移植 **知识包（Playbook + Casebook + Blueprints）** 导出/导入。
- **`⌘K` 双模式幕僚长全局面板与收件箱批量处理**：
  - 顶部 **`⌘K` (`Ctrl+K`)** 集成工单/FTS5 瞬时检索与 **`?` 问幕僚只读问答（`POST /api/chief/ask` & `super-work ask`，结合探针证据给出需人工确认的执行建议卡）**；收件箱支持多选及 **「仅选低风险」一键批量批准/驳回（`POST /api/inbox/batch-resolve` & `super-work inbox batch`）**。
- **工程契约（`super-work.json`）、视觉截图 Spill 与实时工作树预览**：仓库契约承载 `verificationCommands`、`setupCommands`、`smokeCheck`（含 `browserCheck`）、`previewCommand`、`forbiddenPaths`、`conventions`、`deliveryGatePolicy`、`sensitivePaths`、`blueprints` 与共享 `playbook`，个人 `sandboxMode` 等运行态配置保存在本地 SQLite；门禁日志与 PNG `screenshot` 视觉截图持久化为 Spill 产物（`GET /api/artifacts/:id/raw`），**`WorktreePreviewManager`** 支持按需启动带 20m TTL 与最多 3 路 LRU 淘汰的工作树实时预览服务并在清理/撤销时自动销毁。
- **双通道 `Transactional Outbox` 与安全一键回滚**：支持 **PR 推送/增量更新** 与 **本地 `--no-ff` 原子合入主干**，并在 Web 与 CLI 提供 **安全反向提交回滚（`git revert -m 1`）**。
- **分级不可变 `Mandate` 护栏、并发配额与每日预算柔性熔断**：
  - 派单前通过 `mandateScopesOverlap` 检测活跃任务的授权路径重合度；支持单仓 `maxConcurrentWorkers` 与 `dailyBudgetUsd` 每日花费上限（触顶后跑完进行中 Stage 并暂停排队推送 `budget_cap` 审批卡）。
  - 事后基于 `git diff` 校验改动路径：触及 `.env*`、`*.pem`、`*.key` 等禁区立即回滚禁止扩权；仅超出 `allowedPaths` 的普通文件**保留在 Worktree 挂起**，支持收件箱 **「一键扩权并继续」**（免重烧 Token 直接验证流转）。
- **五合一控制入口（四层 Web 指挥舱 + 一等公民 `super-work` CLI）**：
  1. **Attention Inbox（决策收件箱）**：聚合 `observe_proposal`、`plan_approval`、`watchdog_escalation`、`mandate_violation`、`merge_conflict`、`outbox_signoff`、`budget_cap`、`pr_followup`、`arena_tiebreak`、`epic_replan` 与 `clarification_request` 审批项，支持多选及低风险批量审批、Arena 截图预览与 Live Preview 快捷拉起。
  2. **Mission Board（态势泳道 & 拓扑 DAG 看板）**：五列实时并发泳道 + 内嵌 **交互式 DAG Studio**（SVG 贝塞尔曲线拓扑、暂停/恢复/重跑断点与实时节点热手术），展示引擎、TDD 锁、Auto-Arena、PR、作用域与预算进度。
  3. **Scheduled Routines（自治巡航）**：支持一键预设模板与 Cron/周期巡检配置，通过 Probe-to-Promote 在静默健康退出与实质修复晋升间自动闭环。
  4. **Metrics & Budget（效能与预算面板）**：追踪今日预算消耗、交付成功率、总花费、各引擎耗时/通过率、**引擎 × 任务分类 Bandit 评分矩阵** 与 **Golden Eval 黄金基准回放评测台**。
  5. **Deep Dive Drawer & `@super-work/cli`**：支持面板下钻流式轨迹、**Live Steer 实时纠偏**、**工具调用画像**、**一键存为黄金用例**、**文件级 Diff Studio + Arena 双候选切换 + 内联视觉证据 + 检查点时间轴 + Live Preview + 一键回滚**、`Chain of Recall` & 历史判例；终端支持 `super-work mcp`、`ask`、`steer`、`inbox batch`、`eval`、`backup restore`、`bundle export/import`、`dispatch --clarify --tdd --pause-before-run --engine auto --arena --wait`、`impact`、`checkpoint`、`dag`、`preview`、`routine`、`casebook`、`playbook prune` 等完整指令。

---

## Monorepo 分包结构

```text
super-work/
├── packages/
│   ├── core/       # @super-work/core    — 零 UI 编排内核、Mandate、Memory、Watchdog、Outbox 与端口契约
│   ├── drivers/    # @super-work/drivers — bun:sqlite + FTS5、FsArtifactStore、GitWorktreeProvider、LLM 与 CLI 驱动
│   ├── cli/        # @super-work/cli     — 一等公民命令行客户端（up/status/dispatch/epic/inbox/logs）
│   ├── server/     # @super-work/server  — Hono HTTP/SSE API 守护进程与静态看板托管
│   └── web/        # @super-work/web     — React + Vite + Tailwind v4 本地决策指挥舱
└── scripts/dev.ts  # 服务端与前端并行开发启动脚本
```

---

## 环境要求与快速开始

### 前置依赖
- [Bun](https://bun.sh) `>= 1.3`
- `git`（被接管的本地仓库需至少有一次初始提交 / 有效 `HEAD`，否则 `git worktree add` 无法创建工作树分支）
- 可选 Worker / 事件源 CLI（需在 `PATH` 中）：`claude`（Claude Code）、`codex`（Codex CLI）、`opencode`（OpenCode CLI）、`gh`（GitHub CLI）

### 常用命令

```bash
# 1. 安装工作区依赖
bun install

# 2. 运行全部单元测试、驱动解析、SQLite/FTS5、Watchdog、E2E 内核与 API 测试
bun test

# 3. 全工作区 TypeScript 严格类型检查
bun run typecheck

# 4. 运行首次启动 CLI 环境扫描与控制面大模型配置（也可启动后直接在 Web 向导中配置）
bun run setup

# 5. 构建生产环境 Web 看板静态产物至 packages/web/dist
bun run build

# 6. 一键启动守护进程 (http://localhost:4318) 与 Vite 看板 (http://localhost:5173)
bun run dev
```

也可单独启动前后端：
```bash
bun run dev:server   # 监听 4318 端口的 Hono 守护进程 (--watch)
bun run dev:web      # 监听 5173 端口的 Vite 开发服务器（自动代理 /api -> 4318）
```

> **首次运行向导与自举提示**：首次启动打开看板时，系统会自动扫描本机 CLI（`claude`、`codex`、`opencode`、`gh`、`git`、`bun`）并弹出配置向导帮助你选择控制面 LLM；对任意仓库派发 `git worktree` 任务前，请确保该仓库已有至少一次初始 `git commit`（`HEAD`）。完整操作手册见 [USAGE.zh-CN.md](./USAGE.zh-CN.md)。

---

## 环境变量（可选）

未配置任何外部 API Key 时，控制面默认启用内置的 `HeuristicControlLLM` 本地启发式评估器，开箱即可跑通完整编排流程。模板见 [.env.example](./.env.example)。

| 环境变量 | 说明 |
| :--- | :--- |
| `DEEPSEEK_API_KEY` | 启用 OpenAI 兼容控制面模型，默认接入 `https://api.deepseek.com/v1` 与 `deepseek-chat`。 |
| `OPENAI_API_KEY` | 启用 OpenAI 兼容控制面模型，默认接入 `https://api.openai.com/v1` 与 `gpt-4o-mini`。 |
| `SUPER_WORK_LLM_API_KEY` / `_BASE_URL` / `_MODEL` | 自定义 OpenAI 兼容控制面接口密钥、地址与模型名称。 |
| `SUPER_WORK_ENABLE_CLI_LLM=1` | 在无 API Key 时允许控制面降级调用无工具模式的本地 `claude -p --tools ""`。 |
| `SUPER_WORK_DATA_DIR` | 运行时 `super-work.db`、Spill 产物与 `worktrees/` 存储目录（默认 `./.super-work`）。 |
| `SUPER_WORK_TOKEN` | 可选 Bearer / URL Query 鉴权令牌；配置后保护所有 `/api/*` REST、MCP 与 SSE 接口（HMAC 验签的 `/api/webhooks/*` 除外）。 |
| `SUPER_WORK_ACTION_SECRET` | 用于签名移动端一键审批卡片（`/api/webhooks/action`）并校验 ChatOps 回调（`X-Super-Work-Signature`）的 HMAC 密钥。 |
| `GITHUB_WEBHOOK_SECRET` | 用于校验 GitHub 入站 Webhook（`POST /api/webhooks/github`，`X-Hub-Signature-256`）的 HMAC 密钥。 |
| `PORT` | 守护进程 HTTP/SSE 监听端口（默认 `4318`）。 |

---

## REST、MCP、Webhook 与 SSE 接口概览

- `GET /api/health` — 服务健康状态、当前控制面 LLM 提供者、可用 Worker 引擎（`claude`、`codex`、`opencode`、`mock`）及实时 `activePreviews` 计数
- `POST /api/chief/ask` — 基于实时态势、记忆召回与只读代码探针的幕僚长只读问答，附带需人工点击确认的 `ChiefActionSuggestion[]`
- `GET /api/repos`、`POST /api/repos`、`PATCH /api/repos/:id`、`GET /api/repos/:id/blueprints`、`POST /api/repos/:id/contract/sync`、`POST /api/repos/:id/contract/export`、`GET /api/repos/:id/knowledge-bundle`、`POST /api/repos/:id/knowledge-bundle/import` — 注册仓库、配置 `sandboxMode`、`deliveryGatePolicy`（`always_auto`/`risk_gated`/`always_signoff`）、`riskThreshold`、`sensitivePaths`，查询 **Task Blueprints**、双向同步 `super-work.json` 并导出/导入知识包
- `GET /api/repos/:id/playbook`、`POST /api/repos/:id/playbook`、`PATCH /api/playbook/:entryId`、`DELETE /api/playbook/:entryId`、`POST /api/repos/:id/playbook/prune` — 管理并一键清理陈旧/失效的经验库（Playbook）规则
- `GET /api/repos/:id/casebook?q=...`、`DELETE /api/casebook/:entryId` — 检索已交付历史判例（Casebook）与回滚警示记录
- `GET /api/routines`、`POST /api/routines`、`PATCH /api/routines/:id`、`DELETE /api/routines/:id`、`POST /api/routines/:id/run`、`GET /api/routines/runs` — 管理定时自治巡检例程（Probe-to-Promote）与运行健康时间线
- `GET /api/metrics?repoId=...` — 获取今日预算消耗、交付成功率、各引擎效能统计及 `engineMatrix` 分类矩阵评分
- `POST /api/repos/:id/impact` — 基于零依赖符号图分析改动文件的 1-hop 直接影响与 2+ hop 传递影响面
- `POST /api/specs/clarify` — 按需执行 Pre-Flight Spec Studio 预勘探（含只读 `ReadOnlyRepoProber` 探针轨迹），输出推荐派单模式、模板、授权路径、验收标准、影响面提示与选择题澄清清单
- `POST /api/triggers` — 接入外部或模拟事件触发器（`github_issue`、`github_pr`、`github_ci`、`cli`）
- `GET /api/tickets`、`POST /api/tickets`、`GET /api/tickets/:id`、`POST /api/tickets/:id/message`、`POST /api/tickets/:id/steer`、`POST /api/tickets/:id/cancel`、`POST /api/tickets/:id/cleanup-worktree`、`POST /api/tickets/:id/deliver`、`POST /api/tickets/:id/revert`、`PATCH /api/tickets/:id/dag-node` — 派单（支持 `--blueprint`、`--gate-policy`、`--tdd`、`--pause-before-run`、`--engine auto`）、回合中零惩罚 **Live Steer**、DAG 节点断点与热编辑、Stage Span 与 `StageToolProfile` 画像、风险评分与安全 `git revert`
- `GET /api/evals/cases`、`POST /api/evals/cases/from-ticket/:ticketId`、`DELETE /api/evals/cases/:id`、`GET /api/evals/runs`、`POST /api/evals/run` — 沉淀已交付工单为 **黄金评测用例** 并在独立 `eval-worktrees/` 内进行多引擎隔离回放对比
- `GET /api/tickets/:id/review-comments`、`POST /api/tickets/:id/review-comments`、`PATCH /api/review-comments/:commentId` — 查询行级 Review 批注、提交 Review Basket（`comment_only` / `request_changes`）并更新解决状态
- `GET /api/tickets/:id/checkpoints`、`GET /api/tickets/:id/checkpoints/:cpId/diff`、`POST /api/tickets/:id/checkpoints/:cpId/restore` — 查看隐藏 Git Ref 检查点快照、增量 diff 与原地 Re-steer / Fork 时间旅行
- `POST /api/epics/preview`、`POST /api/epics` — 预览并派发复杂需求 Epic 子任务 DAG 拓扑
- `GET /api/previews`、`POST /api/previews`、`POST /api/previews/:id/renew`、`DELETE /api/previews/:id` — 启动、查看、续期（+20m TTL）与停止受控 Live Worktree 实时预览实例
- `GET /api/worktrees`、`POST /api/worktrees/gc` — 查看 Worktree 运行池与一键回收终态/孤儿工作树目录
- `GET /api/system/doctor`、`POST /api/system/doctor/fix`、`GET /api/system/backups`、`POST /api/system/backups`、`POST /api/system/backups/:id/restore` — 运行 System Doctor 诊断清理、SQLite `VACUUM INTO` 零锁在线热备份及带 `pre-restore` 保险快照的原子热恢复
- `GET /api/inbox`、`POST /api/inbox/:id/resolve`、`POST /api/inbox/batch-resolve` — 审批、驳回或低风险批量处理 Attention Inbox 待决项（含高风险 `outbox_signoff`、3-Way `merge_conflict`、Worker `[ASK_HUMAN]` `clarification_request`、DAG 执行断点与 `SPEC_TEST_CHALLENGE`）
- `GET /api/tickets/:id/recall`、`GET /api/memory/search?q=...`、`GET /api/artifacts/:id`、`GET /api/artifacts/:id/raw` — 获取 `Chain of Recall` 全链路、FTS5 记忆检索、Spill 文本产物及原生 PNG `screenshot` / `visual_diff` 视觉对比读取
- `GET /api/outbox` — 查询 `Transactional Outbox` 外发队列状态
- `GET /api/mcp`、`POST /api/mcp` — 原生 MCP JSON-RPC 2.0 Streamable HTTP 端点（`v1.1.0`，配合 `super-work mcp` stdio 桥接；提供 **19 个工具** 与 3 个资源）
- `POST /api/webhooks/github`、`GET /api/webhooks/action`、`POST /api/webhooks/action`、`POST /api/webhooks/chatops` — HMAC 验签 GitHub 入站事件、防爬虫误触的签名移动端审批卡片页及 ChatOps 交互回调
- `GET /api/setup/status`、`POST /api/setup/scan`、`POST /api/setup/test-llm`、`POST /api/setup/configure`、`POST /api/notifications/test` — CLI 扫描、控制面大模型、Webhook 安全密钥及 macOS / Webhook 主动通知配置与测试
- `GET /api/events?repoId=...&ticketId=...` — 实时 Server-Sent Events（SSE）事件流（支持按仓库或含 Epic 子任务的 Ticket 精准过滤，含 `preview_updated`、`review_comment_updated` 与 `eval_run_updated`）

完整操作说明与工作流实战指南见 [USAGE.zh-CN.md](./USAGE.zh-CN.md)（英文版 [USAGE.md](./USAGE.md)）；架构设计与核心契约见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)（英文版 [ARCHITECTURE.md](./ARCHITECTURE.md)）。
