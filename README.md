[English](./README.md) | [简体中文](./README.zh-CN.md)

# super-work

An asynchronous autonomous development workflow orchestration kernel and local decision command center built in TypeScript / Bun Monorepo, inspired by DeepSeek Harness team's design essay *"Exploring Super-agent Design: Towards a More Autonomous Agent System"*.

> **Core Philosophy**: The bottleneck in AI-assisted engineering is **human attention bandwidth**, not single-turn model intelligence. `super-work` shifts developers from manually micromanaging 3–5 interactive coding sessions to acting as **reviewers and boundary authorizers**—keeping a lightweight control plane always on while dispatching isolated coding workers behind immutable guardrails.

---

## Key Capabilities

- **Router + Isolated Worker Architecture**:
  - **Control Plane (`EventIntakeRouter` & `MasterAssessor`)**: Triages incoming triggers (`web`, `github_issue`, `github_pr`, `github_ci`, `cli`), offers an on-demand **Pre-Flight Spec Studio (`POST /api/specs/clarify` & `--clarify`)** combining repo scan + Playbook + Casebook, injects repo conventions (`super-work.json`), **decay-governed Playbook guardrails** (with hit tracking, stale/zombie/suspect classification & pruning), and **hybrid-recalled Episodic Casebook** (with revert-warning flipping), orchestrates **Cross-Repo Epics & explicit `--depends-on` chains** with automatic **Upstream Handover Digests** and **Adaptive Epic Re-planning**, **Scheduled Probe-to-Promote Routines**, **Engine Fallback Chains & Dual-Engine Arena Duels (`--arena`)**, **Epic Staging Branches**, **same-branch PR review/CI auto-followup loops**, and **lossless crash/restart recovery (`recoverInterruptedRuns`)**.
  - **Execution Plane (`WorkerDriver` & `GitWorktreeProvider`)**: Schedules external coding agents (`ClaudeCodeDriver`, `CodexDriver`, `OpenCodeDriver`, plus `MockWorkerDriver`) inside isolated `git worktree` branches wrapped by an **OS Native Sandbox (`sandboxMode`: `"balanced"` | `"strict"` | `"off"` via macOS Seatbelt / Linux `bwrap` + automatic credential/token env scrubbing)**, with **fresh-worktree `setupCommands` warmup hooks**, native session resume, **structured adversarial cross-engine reviews**, **Ephemeral Runtime Smoke Gate (`smokeCheck`) + Zero-Dep CDP Headless Browser Gate (`smokeCheck.browserCheck`)**, and automatic/one-click worktree GC.
- **Native MCP Server & Bidirectional Webhooks**:
  - **`@modelcontextprotocol`-free Native MCP Server**: Exposes **10 tools** (`clarify_spec`, `dispatch_ticket`, `dispatch_epic`, `list_tickets`, `get_ticket_detail`, `list_inbox`, `resolve_inbox`, `search_memory_and_casebook`, `trigger_routine`, `manage_preview`) & **3 resources** (`superwork://health`, `superwork://repos`, `superwork://inbox/pending`) over Streamable HTTP (`GET/POST /api/mcp`) and the `super-work mcp` stdio bridge (auto-spawning the local daemon when offline).
  - **Signed Webhooks & Mobile Action Cards**: Accepts HMAC-verified inbound GitHub webhooks (`POST /api/webhooks/github` via `X-Hub-Signature-256`) and ChatOps callbacks (`POST /api/webhooks/chatops`), dispatches adaptive Feishu/Slack/Discord/JSON notifications with **signed crawler-safe remote approval links (`GET/POST /api/webhooks/action`)**, plus native macOS desktop notifications.
- **Deterministic Verification, Visual Spill, Live Previews & Repo Contract (`super-work.json`)**: Syncs team-shared `verificationCommands`, `setupCommands`, `smokeCheck` (including `browserCheck`), `previewCommand`, `forbiddenPaths`, `conventions`, and shared `playbook` rules from `super-work.json`; verification, smoke logs, and PNG `screenshot` captures persist as Spill artifacts (`GET /api/artifacts/:id/raw`), while **`WorktreePreviewManager`** launches bounded LRU-evicted Live Previews on free local ports with 20m TTL and automatic worktree/cleanup teardown.
- **Dual-Channel `Transactional Outbox` & 1-Click Safe Revert**: Supports remote **GitHub PR creation / incremental PR updates**, PR comment replies, and **`--no-ff` Local Merge (`local_merge`)** with **1-Click Safe Revert (`git revert -m 1`)** from both Web UI and CLI.
- **Graded `Mandate` Guardrails, Concurrency Quotas & Daily Budget Fuse**:
  - Pre-dispatch overlap detection (`mandateScopesOverlap`) serializes overlapping scopes, while per-repo `maxConcurrentWorkers` and `dailyBudgetUsd` caps pause new queued dispatches after finishing in-flight stages and create a `budget_cap` Inbox card.
  - Post-turn `git diff` validation immediately reverts forbidden paths (`.env*`, `*.pem`, `*.key`), while preserving out-of-scope edits (`scopeViolations`) in the worktree so the Inbox can **Expand Mandate & Continue** without re-burning worker tokens.
- **Command Center + First-Class `super-work` CLI**:
  1. **Attention Inbox**: High-signal approval queue for `observe_proposal`, `plan_approval`, `watchdog_escalation`, `mandate_violation`, `merge_conflict`, `outbox_signoff`, `budget_cap`, `pr_followup`, `arena_tiebreak`, and `epic_replan`—including inline Arena screenshots and Live Preview launch buttons.
  2. **Mission Board**: Five-column live swimlane board with engine badges, PR chips, scope chips, dependency locks, and budget meters.
  3. **Scheduled Routines**: Dedicated view & preset library for Probe-to-Promote autonomous patrols with active hour windows, overlap/budget guards, and health run timeline.
  4. **Metrics & Budget View**: Tracks daily spend progress, delivery success rate, cumulative cost, and per-engine latency/pass-rate telemetry.
  5. **Deep Dive Drawer & `@super-work/cli`**: Inspect SSE streams, **per-file collapsible Diff Studio + Arena candidate diff switcher + inline `screenshot` artifacts + Live Preview controls + 1-Click Safe Revert**, `Chain of Recall` & Casebook, or drive everything via CLI (`super-work mcp`, `up -d`, `status`, `dispatch --clarify --arena --wait`, `epic --wait`, `preview`, `routine`, `casebook`, `inbox`, `logs -f`, `watch`, `revert`, `playbook prune`).

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

# 3. Typecheck all five workspace packages
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
| `SUPER_WORK_TOKEN` | Optional Bearer / query token securing all REST, MCP, and SSE `/api/*` endpoints (excluding HMAC-signed `/api/webhooks/*`). |
| `SUPER_WORK_ACTION_SECRET` | HMAC secret for signing mobile one-tap `/api/webhooks/action` links and verifying `/api/webhooks/chatops` callbacks (`X-Super-Work-Signature`). |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret verifying inbound GitHub webhooks at `POST /api/webhooks/github` (`X-Hub-Signature-256`). |
| `PORT` | Daemon HTTP/SSE port (default: `4318`). |

---

## REST, MCP, Webhooks & SSE API Summary

- `GET /api/health` — Daemon health, active control-plane LLM provider, available worker engines (`claude`, `codex`, `opencode`, `mock`), worktree counts, and `activePreviews`
- `GET /api/repos`, `POST /api/repos`, `PATCH /api/repos/:id`, `POST /api/repos/:id/contract/sync`, `POST /api/repos/:id/contract/export` — Register repos, configure `sandboxMode` (`balanced`/`strict`/`off`), `previewCommand`, `browserCheck` & `setupCommands`, and sync/export `super-work.json`
- `GET /api/repos/:id/playbook`, `POST /api/repos/:id/playbook`, `PATCH /api/playbook/:entryId`, `DELETE /api/playbook/:entryId`, `POST /api/repos/:id/playbook/prune` — View, curate, and prune stale/suspect self-evolving Playbook rules
- `GET /api/repos/:id/casebook?q=...`, `DELETE /api/casebook/:entryId` — Browse and search delivered Episodic Casebook solutions and reverted pitfall warnings
- `GET /api/routines`, `POST /api/routines`, `PATCH /api/routines/:id`, `DELETE /api/routines/:id`, `POST /api/routines/:id/run`, `GET /api/routines/runs` — Manage Probe-to-Promote scheduled autonomous routines and patrol run logs
- `GET /api/metrics?repoId=...` — Query today's budget spend, delivery rate, and per-engine latency/cost telemetry
- `POST /api/specs/clarify` — On-demand Pre-Flight Spec Studio exploration returning recommended mode, template, allowed paths, criteria, and clarifying questions
- `POST /api/triggers` — Ingest external or simulated triggers (`github_issue`, `github_pr`, `github_ci`, `cli`)
- `GET /api/tickets`, `POST /api/tickets`, `GET /api/tickets/:id`, `POST /api/tickets/:id/message`, `POST /api/tickets/:id/cancel`, `POST /api/tickets/:id/cleanup-worktree`, `POST /api/tickets/:id/deliver`, `POST /api/tickets/:id/revert` — Direct task dispatch, 3-tier Diff inspection, Thread follow-ups, dual-channel delivery, and atomic `git revert -m 1`
- `POST /api/epics/preview`, `POST /api/epics` — Preview and dispatch Epic sub-task dependency DAGs
- `GET /api/previews`, `POST /api/previews`, `POST /api/previews/:id/renew`, `DELETE /api/previews/:id` — Launch, inspect, renew (+20m TTL), and tear down bounded Live Worktree Previews
- `GET /api/worktrees`, `POST /api/worktrees/gc` — Inspect active/reclaimable worktrees and run one-click garbage collection
- `GET /api/inbox`, `POST /api/inbox/:id/resolve` — Approve or reject pending Attention Inbox decisions
- `GET /api/tickets/:id/recall`, `GET /api/memory/search?q=...`, `GET /api/artifacts/:id`, `GET /api/artifacts/:id/raw` — `Chain of Recall` lineage, FTS5 search, text Spill reader, and raw binary PNG `screenshot` reader
- `GET /api/outbox` — Inspect `Transactional Outbox` delivery entries
- `GET /api/mcp`, `POST /api/mcp` — Native MCP JSON-RPC 2.0 Streamable HTTP endpoint (`super-work mcp` provides stdio transport; 10 tools & 3 resources)
- `POST /api/webhooks/github`, `GET /api/webhooks/action`, `POST /api/webhooks/action`, `POST /api/webhooks/chatops` — HMAC-signed GitHub inbound webhooks, crawler-safe mobile remote approval HTML/action card endpoints, and ChatOps callbacks
- `GET /api/setup/status`, `POST /api/setup/scan`, `POST /api/setup/test-llm`, `POST /api/setup/configure`, `POST /api/notifications/test` — CLI environment scan, Control-Plane LLM setup, webhook secrets, and macOS / Webhook notification settings
- `GET /api/events?repoId=...&ticketId=...` — Real-time Server-Sent Events (SSE) stream with optional repo/ticket filtering (including `preview_updated`)

For step-by-step workflows see [USAGE.md](./USAGE.md); for architectural deep dives and core contracts see [ARCHITECTURE.md](./ARCHITECTURE.md).
