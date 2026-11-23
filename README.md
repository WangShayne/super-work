[English](./README.md) | [简体中文](./README.zh-CN.md)

# super-work

An asynchronous autonomous development workflow orchestration kernel and local decision command center built in TypeScript / Bun Monorepo, inspired by DeepSeek Harness team's design essay *"Exploring Super-agent Design: Towards a More Autonomous Agent System"*.

> **Core Philosophy**: The bottleneck in AI-assisted engineering is **human attention bandwidth**, not single-turn model intelligence. `super-work` shifts developers from manually micromanaging 3–5 interactive coding sessions to acting as **reviewers and boundary authorizers**—keeping a lightweight control plane always on while dispatching isolated coding workers behind immutable guardrails.

---

## Key Capabilities

- **Router + Isolated Worker Architecture**:
  - **Control Plane (`EventIntakeRouter` & `MasterAssessor`)**: Triages incoming triggers (`web`, `github_issue`, `github_pr`, `github_ci`, `cli`), enforces `off` / `observe` / `auto` modes, decomposes complex requirements into **Epic Sub-Ticket DAGs** with automated upstream branch integration, and routes follow-up comments on active `Thread`s directly to the subscribed `Ticket`.
  - **Execution Plane (`WorkerDriver` & `GitWorktreeProvider`)**: Schedules external coding agents (`ClaudeCodeDriver`, `CodexDriver`, `OpenCodeDriver`, plus `MockWorkerDriver`) inside isolated `git worktree` branches with native session resume, automatic or one-click worktree GC, and clean cross-engine handover.
- **Deterministic Verification Harness**: Configure mandatory shell checks per repository (e.g. `bun run typecheck`, `bun test`) executed by the kernel after `implement` and `rebase`; outputs persist as `test_log` Spill artifacts and failures automatically feed back to retry or escalate.
- **Dual-Channel `Transactional Outbox`**: Supports both remote **GitHub PR creation** and **one-click Local Merge (`local_merge`)** into the base branch with branch cleanup, backed by Spill `diff` fallback retention.
- **Stage Pipeline Templates**: Built-in `fast` (`implement` → `rebase`), `standard` (`plan` → `implement` → `review` → `rebase`), and `strict` (with mandatory `plan_approval` and `outbox_signoff` human gates) workflows.
- **Immutable `Mandate` Guardrails & Scope Serialization**:
  - Pre-dispatch overlap detection (`mandateScopesOverlap`) serializes tickets touching overlapping paths via `dependsOn`, while disjoint scopes execute in parallel.
  - Pre-turn CLI permission mapping forbids direct `git push` / `gh pr create`; post-turn `git diff` validation automatically reverts out-of-scope or secret modifications (`.env*`, `*.pem`, `*.key`) and escalates to the Attention Inbox.
- **`Inline & Spill` Memory + `Chain of Recall`**: Keeps active prompts lean with structured `InlineMemory` while offloading raw JSONL transcripts and unified patches to `FsArtifactStore` (`Spill`), indexed with `bun:sqlite` FTS5 for on-demand cross-ticket recall.
- **Two-Tier `Watchdog`**: Zero-cost L1 probes detect silence timeouts, repeated identical tool errors, `A -> B -> A` diff oscillation, and budget burn; L2 semantic diagnosis chooses `CONTINUE`, `INJECT_HINT`, `SWITCH_ENGINE`, or `ESCALATE_HUMAN`.
- **`Transactional Outbox`**: Idempotent SQLite WAL-backed delivery queue for rebasing, pushing branches, creating GitHub PRs via `gh`, or recording local branch readiness.
- **Three-Tier Local Web Command Center**:
  1. **Attention Inbox**: High-signal approval queue for `observe_proposal`, `plan_approval`, `watchdog_escalation`, `mandate_violation`, `merge_conflict`, and `outbox_signoff`.
  2. **Mission Board**: Five-column live swimlane board with engine badges, scope chips, dependency locks, and budget meters.
  3. **Deep Dive Drawer**: Real-time SSE worker event stream, colorized worktree `git diff`, `Chain of Recall` + FTS5 search, `Outbox` ledger, and live Thread follow-up injection.

---

## Monorepo Package Map

```text
super-work/
├── packages/
│   ├── core/       # @super-work/core    — Zero-UI orchestration kernel, Mandate, Memory, Watchdog, Outbox, Ports
│   ├── drivers/    # @super-work/drivers — bun:sqlite + FTS5, FsArtifactStore, GitWorktreeProvider, LLM & CLI drivers
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
| `PORT` | Daemon HTTP/SSE port (default: `4318`). |

---

## REST & SSE API Summary

- `GET /api/health` — Daemon health, active control-plane LLM provider, available worker engines (`claude`, `codex`, `opencode`, `mock`), and worktree pool counts
- `GET /api/repos`, `POST /api/repos`, `PATCH /api/repos/:id` — Register repos, configure per-repo preferences (template, engines, worktree cleanup), and switch `off` / `observe` / `auto` mode
- `POST /api/triggers` — Ingest external or simulated triggers (`github_issue`, `github_pr`, `github_ci`, `cli`)
- `GET /api/tickets`, `POST /api/tickets`, `GET /api/tickets/:id`, `POST /api/tickets/:id/message`, `POST /api/tickets/:id/cancel`, `POST /api/tickets/:id/cleanup-worktree`, `POST /api/tickets/:id/deliver` — Direct task dispatch, 3-tier Diff inspection (worktree / branch / Spill), Thread Subscription follow-ups, and dual-channel delivery
- `POST /api/epics/preview`, `POST /api/epics` — Preview and dispatch Epic sub-task dependency DAGs
- `GET /api/worktrees`, `POST /api/worktrees/gc` — Inspect active/reclaimable worktrees and run one-click garbage collection
- `GET /api/inbox`, `POST /api/inbox/:id/resolve` — Approve or reject pending Attention Inbox decisions
- `GET /api/tickets/:id/recall`, `GET /api/memory/search?q=...`, `GET /api/artifacts/:id` — `Chain of Recall` lineage, FTS5 search, and Spill artifact reader
- `GET /api/outbox` — Inspect `Transactional Outbox` delivery entries
- `GET /api/setup/status`, `POST /api/setup/scan`, `POST /api/setup/test-llm`, `POST /api/setup/configure` — CLI environment scan, connection test, and dynamic Control-Plane LLM setup
- `GET /api/events` — Real-time Server-Sent Events (SSE) stream of `KernelEvent` updates

For step-by-step workflows see [USAGE.md](./USAGE.md); for architectural deep dives and core contracts see [ARCHITECTURE.md](./ARCHITECTURE.md).
