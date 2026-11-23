[English](./README.md) | [简体中文](./README.zh-CN.md)

# super-work

基于 DeepSeek Harness 团队技术文章《Super-agent 设计探索：迈向更自主的 Agent 系统》构建的异步自主研发工作流编排内核与本地决策指挥舱（TypeScript / Bun Monorepo）。

> **核心理念**：AI 辅助研发的核心瓶颈已经不是单次模型推理能力，而是**人类的注意力带宽**。`super-work` 将开发者从同时紧盯 3–5 个终端会话的“微操员”解放为**审批边界与结果的决策者**——轻量控制面常驻调度，执行面在隔离的工作区与不可变授权边界内自主推进。

---

## 核心能力

- **Router + 隔离 Worker 双层架构**：
  - **控制面（`EventIntakeRouter` & `MasterAssessor`）**：统一接收入站触发器（`web`、`github_issue`、`github_pr`、`github_ci`、`cli`），支持 `off` / `observe` / `auto` 三档运行模式；支持 **Epic 复杂需求拆单 DAG**（自动拆解子任务依赖、在独立分支合入上游成果后并发推进），并通过 **Thread 订阅直通**将追问直接路由至活跃 `Ticket`。
  - **执行面（`WorkerDriver` & `GitWorktreeProvider`）**：在独立的 `git worktree` 分支中调度成熟 Coding Agent（`ClaudeCodeDriver`、`CodexDriver`、`OpenCodeDriver` 以及用于全自动验证的 `MockWorkerDriver`）。同引擎续跑优先复用原生 `--resume` / `exec resume` / `--session` 会话缓存，跨引擎接力通过结构化 `Inline` 摘要无缝衔接，并支持交付/取消后自动回收 Worktree 与一键 GC。
- **确定性质量门禁（Verification Harness）**：可在仓库偏好设置中绑定校验命令（如 `bun run typecheck`、`bun test`）；`implement` 与 `rebase` 结束后由内核强制运行并将完整日志落盘为 `test_log` Spill 产物，失败自动带日志打回自愈。
- **双通道 `Transactional Outbox`**：支持 **「推送远端建 PR」** 与 **「本地一键合入主干（自动 Merge 并清理任务分支）」**，通过 `Diff` Spill 兜底确保合入删分支后依然可在看板回看历史 Diff。
- **阶段流水线模板（Stage Pipeline）**：内置 `fast`（`implement` → `rebase`）、`standard`（`plan` → `implement` → `review` → `rebase`）与 `strict`（强制包含人工 `plan_approval` 与 `outbox_signoff` 门禁）三种模板。
- **不可变 `Mandate` 护栏与并发冲突预判**：
  - 派单前通过 `mandateScopesOverlap` 检测活跃任务的授权路径重合度：有重叠自动注入 `dependsOn` 串行排队，无重叠全速并行。
  - 事前向 CLI 映射只读/可编辑权限并禁用直接 `git push` / `gh pr create`；事后基于 `git diff` 校验改动路径，一旦越界或触及 `.env*`、`*.pem`、`*.key` 等禁区立即自动回滚并升级至 Attention Inbox。
- **`Inline & Spill` 分层记忆 + `Chain of Recall` 链式召回**：主提示词仅保留精简的 `InlineMemory`，完整 JSONL 执行流与 Diff 补丁落盘至 `FsArtifactStore`（`Spill`），并通过 `bun:sqlite` FTS5 全文索引支撑按需跨任务回忆。
- **两级混合 `Watchdog`**：L1 零成本规则探针实时监测静默超时、连续相同报错、`A -> B -> A` Diff 振荡与预算斜率；异常时才唤醒 L2 语义诊断，决策 `CONTINUE`、`INJECT_HINT`、`SWITCH_ENGINE`（自动切换备用引擎自愈）或 `ESCALATE_HUMAN`。
- **`Transactional Outbox` 事务发件箱**：基于 SQLite WAL 事务与幂等键的可靠外发队列，统一收口交付前自动 Rebase、推分支建 PR（通过 `gh` CLI）或本地分支交付汇总。
- **三层本地 Web 决策指挥舱**：
  1. **Attention Inbox（决策收件箱）**：聚合 `observe_proposal`、`plan_approval`、`watchdog_escalation`、`mandate_violation`、`merge_conflict`、`outbox_signoff` 等高信噪比审批项。
  2. **Mission Board（态势泳道看板）**：五列实时并发泳道，展示引擎徽章、授权作用域、依赖阻塞锁与预算进度条。
  3. **Deep Dive Drawer（下钻详情抽屉）**：实时 SSE 流式事件轨迹、高亮 Worktree `git diff`、`Chain of Recall` 溯源与 FTS5 检索、Outbox 发件记录，以及底部 Thread 订阅追问输入框。

---

## Monorepo 分包结构

```text
super-work/
├── packages/
│   ├── core/       # @super-work/core    — 零 UI 编排内核、Mandate、Memory、Watchdog、Outbox 与端口契约
│   ├── drivers/    # @super-work/drivers — bun:sqlite + FTS5、FsArtifactStore、GitWorktreeProvider、LLM 与 CLI 驱动
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
| `PORT` | 守护进程 HTTP/SSE 监听端口（默认 `4318`）。 |

---

## REST 与 SSE 接口概览

- `GET /api/health` — 服务健康状态、当前控制面 LLM 提供者及可用 Worker 引擎列表（`claude`、`codex`、`opencode`、`mock`）
- `GET /api/repos`、`POST /api/repos`、`PATCH /api/repos/:id` — 注册仓库、修改偏好设置（默认模板、引擎、自动回收策略）及切换 `off` / `observe` / `auto` 模式
- `POST /api/triggers` — 接入外部或模拟事件触发器（`github_issue`、`github_pr`、`github_ci`、`cli`）
- `GET /api/tickets`、`POST /api/tickets`、`GET /api/tickets/:id`、`POST /api/tickets/:id/message`、`POST /api/tickets/:id/cancel`、`POST /api/tickets/:id/cleanup-worktree`、`POST /api/tickets/:id/deliver` — 直接派单、查看 Worktree / 分支 / Spill Diff、Thread 追问、本地合入或 PR 交付
- `POST /api/epics/preview`、`POST /api/epics` — 预览并派发复杂需求 Epic 子任务 DAG 拓扑
- `GET /api/worktrees`、`POST /api/worktrees/gc` — 查看 Worktree 运行池与一键回收终态/孤儿工作树目录
- `GET /api/inbox`、`POST /api/inbox/:id/resolve` — 审批或驳回 Attention Inbox 待决项
- `GET /api/tickets/:id/recall`、`GET /api/memory/search?q=...`、`GET /api/artifacts/:id` — 获取 `Chain of Recall` 全链路、FTS5 记忆检索与按需读取 Spill 产物
- `GET /api/outbox` — 查询 `Transactional Outbox` 外发队列状态
- `GET /api/setup/status`、`POST /api/setup/scan`、`POST /api/setup/test-llm`、`POST /api/setup/configure` — 本机 CLI 环境扫描、大模型连通性测试与控制面动态配置
- `GET /api/events` — 推送实时 `KernelEvent` 的 Server-Sent Events（SSE）事件流

完整操作说明与工作流实战指南见 [USAGE.zh-CN.md](./USAGE.zh-CN.md)（英文版 [USAGE.md](./USAGE.md)）；架构设计与核心契约见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)（英文版 [ARCHITECTURE.md](./ARCHITECTURE.md)）。
