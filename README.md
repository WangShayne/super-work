[English](./README.md) | [简体中文](./README.zh-CN.md)

# super-work

An asynchronous autonomous development workflow orchestration kernel and local decision command center built in TypeScript / Bun Monorepo, inspired by DeepSeek Harness team's design essay *"Exploring Super-agent Design: Towards a More Autonomous Agent System"*.

> **Core Philosophy**: The bottleneck in AI-assisted engineering is **human attention bandwidth**, not single-turn model intelligence. `super-work` shifts developers from manually micromanaging 3–5 interactive coding sessions to acting as **reviewers and boundary authorizers**—keeping a lightweight control plane always on while dispatching isolated coding workers behind immutable guardrails.

---

## Key Capabilities

- **Router + Isolated Worker Architecture**:
  - **Control Plane (`EventIntakeRouter` & `MasterAssessor`)**: Triages incoming triggers (`web`, `github_issue`, `github_pr`, `github_ci`, `cli`), injects real repository structure (`RepoStructureScanner`), repo conventions (`super-work.json`), and **self-evolving Playbook guardrails** (path-scoped, capped at Top 8 / `<= 1200` chars), orchestrates **Epic Staging Branches (`super-work/epic/<id>`) + Final Verification Gate & single atomic PR/merge**, supports **same-branch GitHub PR review & failing CI auto-followup loops** (capped at 3 rounds), and performs **lossless crash/restart recovery (`recoverInterruptedRuns`)**.
  - **Execution Plane (`WorkerDriver` & `GitWorktreeProvider`)**: Schedules external coding agents (`ClaudeCodeDriver`, `CodexDriver`, `OpenCodeDriver`, plus `MockWorkerDriver`) inside isolated `git worktree` branches with **fresh-worktree `setupCommands` warmup hooks**, native session resume, **structured adversarial cross-engine reviews (`blocker`/`major`/`nit` findings)**, and automatic/one-click worktree GC.
- **Deterministic Verification Harness & Repo Contract (`super-work.json`)**: Syncs team-shared `verificationCommands`, `setupCommands`, `forbiddenPaths`, `conventions`, and shared `playbook` rules from `super-work.json` (while keeping runtime mode, quotas, and engine preferences in local SQLite); verification outputs persist as `test_log` Spill artifacts and closed-loop recoveries automatically distill reusable Playbook lessons.
- **Dual-Channel `Transactional Outbox` & 1-Click Safe Revert**: Supports remote **GitHub PR creation / incremental PR updates**, PR comment replies, and **`--no-ff` Local Merge (`local_merge`)** with **1-Click Safe Revert (`git revert -m 1`)** from both Web UI and CLI.
- **Attention Push Notifications**: High-signal alerts on new Inbox blockers, final deliveries, and terminal failures via **macOS native desktop notifications** and **adaptive Webhooks** (Feishu/Lark, Slack, Discord, or signed JSON).
- **Graded `Mandate` Guardrails, Concurrency Quotas & Daily Budget Fuse**:
  - Pre-dispatch overlap detection (`mandateScopesOverlap`) serializes overlapping scopes, while per-repo `maxConcurrentWorkers` and `dailyBudgetUsd` caps pause new queued dispatches after finishing in-flight stages and create a `budget_cap` Inbox card.
  - Post-turn `git diff` validation immediately reverts forbidden paths (`.env*`, `*.pem`, `*.key`), while preserving out-of-scope edits (`scopeViolations`) in the worktree so the Inbox can **Expand Mandate & Continue** without re-burning worker tokens.
- **Command Center + First-Class `super-work` CLI**:
  1. **Attention Inbox**: High-signal approval queue for `observe_proposal`, `plan_approval`, `watchdog_escalation`, `mandate_violation`, `merge_conflict`, `outbox_signoff`, `budget_cap`, and `pr_followup`.
  2. **Mission Board**: Five-column live swimlane board with engine badges, PR chips, scope chips, dependency locks, and budget meters.
  3. **Metrics & Budget View**: Tracks daily spend progress, delivery success rate, cumulative cost, and per-engine latency/pass-rate telemetry.
  4. **Deep Dive Drawer (Diff Studio) & `@super-work/cli`**: Inspect SSE streams, **per-file collapsible Diff Studio with inline review findings & targeted file feedback**, **1-Click Safe Revert**, `Chain of Recall`, or drive everything from the terminal (`super-work up -d`, `status`, `dispatch --wait`, `epic --wait`, `inbox`, `logs -f`, `watch`, `revert`, `playbook`).

---

## Monorepo Package Map

```text
super-work/
├── packages/
│   ├── core/       # @super-work/core    — Zero-UI orchestration kernel, Mandate, Memory, Watchdog, Outbox, Ports
│   ├── drivers/    # @super-work/drivers — bun:sqlite + FTS5, FsArtifactStore, GitWorktreeProvider, LLM & CLI drivers
│   ├── cli/        # @super-work/cli     — First-class CLI client (up/status/dispatch/epic/inbox/logs)
│   ├── server/     # @super-work/server  — Hono HTTP/SSE API daemon & static web bundle server
│   └── web/        # @super-work/web     — React + Vite + Tailwind v4 local command center
└── scripts/dev.ts  # Concurrent dev launcher for server + web
```

---

## Prerequisites & Quickstart

### Prerequisites
- [Bun](https://bun.sh) `>= 1.3`
- `git` (repositories managed by `super-work` must have at least an initial commit / valid `HEAD` before `git worktree add` can branch from them)
- Optional Worker / Source CLIs on `PATH`: `claude` (Claude Code), `codex` (Codex CLI), `opencode` (OpenCode CLI), `gh` (GitHub CLI)

### Commands

```bash
# 1. Install workspace dependencies
bun install

# 2. Run all unit, driver, database/FTS5, Watchdog, E2E kernel, and API tests
bun test

# 3. Typecheck all four workspace packages
bun run typecheck

# 4. Run interactive first-run CLI scan & Control-Plane LLM setup (or configure in the Web wizard)
bun run setup

# 5. Build production frontend bundle into packages/web/dist
bun run build

# 6. Start daemon (http://localhost:4318) + Vite dashboard (http://localhost:5173)
bun run dev
```

You can also run the backend or frontend individually:
```bash
bun run dev:server   # Hono daemon with --watch on port 4318
bun run dev:web      # Vite dev server on port 5173 (proxies /api -> 4318)
```

> **First-Run Wizard & Self-hosting note**: On first startup, `super-work` automatically scans installed CLIs (`claude`, `codex`, `opencode`, `gh`, `git`, `bun`) and pops up the setup wizard in the Web UI to configure your Control-Plane LLM. Before dispatching worktree tasks against any repository, ensure it has at least an initial `git commit` (`HEAD`). See [USAGE.md](./USAGE.md) for the complete user guide.

---

## Environment Variables (Optional)

When no API key is configured, the control plane automatically uses the built-in `HeuristicControlLLM` so local evaluation and workflows run with zero external setup. See [.env.example](./.env.example).

| Variable | Description |
| :--- | :--- |
| `DEEPSEEK_API_KEY` | Enables OpenAI-compatible control-plane LLM defaulting to `https://api.deepseek.com/v1` and `deepseek-chat`. |
| `OPENAI_API_KEY` | Enables OpenAI-compatible control-plane LLM defaulting to `https://api.openai.com/v1` and `gpt-4o-mini`. |
| `SUPER_WORK_LLM_API_KEY` / `_BASE_URL` / `_MODEL` | Custom OpenAI-compatible control-plane endpoint, key, and model override. |
| `SUPER_WORK_ENABLE_CLI_LLM=1` | Allows control-plane fallback to tool-less `claude -p --tools ""` when no API key is set. |
| `SUPER_WORK_DATA_DIR` | Directory for `super-work.db`, Spill artifacts, and `worktrees/` (default: `./.super-work`). |
| `SUPER_WORK_TOKEN` | Optional Bearer / query token securing all REST and SSE `/api/*` endpoints for remote access. |
| `PORT` | Daemon HTTP/SSE port (default: `4318`). |

---

## REST & SSE API Summary

- `GET /api/health` — Daemon health, active control-plane LLM provider, available worker engines (`claude`, `codex`, `opencode`, `mock`), and worktree pool counts
- `GET /api/repos`, `POST /api/repos`, `PATCH /api/repos/:id`, `POST /api/repos/:id/contract/sync`, `POST /api/repos/:id/contract/export` — Register repos, configure preferences & `setupCommands`, sync/export `super-work.json`, and manage per-repo modes & quotas
- `GET /api/repos/:id/playbook`, `POST /api/repos/:id/playbook`, `PATCH /api/playbook/:entryId`, `DELETE /api/playbook/:entryId` — View and curate self-evolving repository Playbook rules
- `GET /api/metrics?repoId=...` — Query today's budget spend, delivery rate, and per-engine latency/cost telemetry
- `POST /api/triggers` — Ingest external or simulated triggers (`github_issue`, `github_pr`, `github_ci`, `cli`)
- `GET /api/tickets`, `POST /api/tickets`, `GET /api/tickets/:id`, `POST /api/tickets/:id/message`, `POST /api/tickets/:id/cancel`, `POST /api/tickets/:id/cleanup-worktree`, `POST /api/tickets/:id/deliver`, `POST /api/tickets/:id/revert` — Direct task dispatch, 3-tier Diff inspection, Thread follow-ups, dual-channel delivery, and atomic `git revert -m 1`
- `POST /api/epics/preview`, `POST /api/epics` — Preview and dispatch Epic sub-task dependency DAGs
- `GET /api/worktrees`, `POST /api/worktrees/gc` — Inspect active/reclaimable worktrees and run one-click garbage collection
- `GET /api/inbox`, `POST /api/inbox/:id/resolve` — Approve or reject pending Attention Inbox decisions
- `GET /api/tickets/:id/recall`, `GET /api/memory/search?q=...`, `GET /api/artifacts/:id` — `Chain of Recall` lineage, FTS5 search, and Spill artifact reader
- `GET /api/outbox` — Inspect `Transactional Outbox` delivery entries
- `GET /api/setup/status`, `POST /api/setup/scan`, `POST /api/setup/test-llm`, `POST /api/setup/configure`, `POST /api/notifications/test` — CLI environment scan, Control-Plane LLM setup, and macOS / Webhook notification settings
- `GET /api/events?repoId=...&ticketId=...` — Real-time Server-Sent Events (SSE) stream with optional repo/ticket (including Epic child subtasks) filtering

For step-by-step workflows see [USAGE.md](./USAGE.md); for architectural deep dives and core contracts see [ARCHITECTURE.md](./ARCHITECTURE.md).
