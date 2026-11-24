[English](./README.md) | [简体中文](./README.zh-CN.md)

# super-work

An asynchronous autonomous development workflow orchestration kernel and local decision command center built in TypeScript / Bun Monorepo, inspired by DeepSeek Harness team's design essay *"Exploring Super-agent Design: Towards a More Autonomous Agent System"*.

> **Core Philosophy**: The bottleneck in AI-assisted engineering is **human attention bandwidth**, not single-turn model intelligence. `super-work` shifts developers from manually micromanaging 3–5 interactive coding sessions to acting as **reviewers and boundary authorizers**—keeping a lightweight control plane always on while dispatching isolated coding workers behind immutable guardrails.

---

## Key Capabilities

- **Router + Isolated Worker Architecture**:
  - **Control Plane (`EventIntakeRouter` & `MasterAssessor`)**: Triages incoming triggers (`web`, `github_issue`, `github_pr`, `github_ci`, `cli`), offers an on-demand **Pre-Flight Spec Studio (`POST /api/specs/clarify` & `--clarify`)** enriched with **1-hop / 2+ hop Symbol Impact Radius**, injects repo conventions (`super-work.json`), **decay-governed Playbook guardrails** (with hit tracking, stale/zombie/suspect classification & pruning), and **hybrid-recalled Episodic Casebook** (with revert-warning flipping), orchestrates **Cross-Repo Epics & explicit `--depends-on` chains** (with **1-hop automatic semantic dependency serialization**), executes **Adaptive Engine Bandit Routing (`--engine auto`)** with **Dual Auto-Arena escalation guardrails**, **Scheduled Probe-to-Promote Routines**, **Red-Green Spec-Test Guard (`--tdd` & single-rewind `SPEC_TEST_CHALLENGE`)**, **Interactive DAG Studio & Live Node Surgery (`--pause-before-run`)**, **Worktree Stage Checkpoints & Time-Travel Re-steer**, **same-branch PR review/CI auto-followup loops**, and **lossless crash/restart recovery (`recoverInterruptedRuns`)**.
  - **Execution Plane (`WorkerDriver` & `GitWorktreeProvider`)**: Schedules external coding agents (`ClaudeCodeDriver`, `CodexDriver`, `OpenCodeDriver`, plus `MockWorkerDriver`) inside isolated `git worktree` branches wrapped by an **OS Native Sandbox (`sandboxMode`: `"balanced"` | `"strict"` | `"off"` via macOS Seatbelt / Linux `bwrap` + read-only `readOnlyPaths` spec-test lock + automatic credential/token env scrubbing)**, with **fresh-worktree `setupCommands` warmup hooks**, native session resume, **structured adversarial cross-engine reviews**, **Ephemeral Runtime Smoke Gate (`smokeCheck`) + Zero-Dep CDP Headless Browser Gate (`smokeCheck.browserCheck` with interactive `steps` and zero-dep PNG Pixel Visual Diff `visualDiffMode`)**, hidden-ref worktree stage checkpoints, and automatic/one-click worktree GC.
- **Native MCP Server & Bidirectional Webhooks**:
  - **`@modelcontextprotocol`-free Native MCP Server (`v1.0.0`)**: Exposes **15 tools** (`clarify_spec`, `dispatch_ticket`, `dispatch_epic`, `list_tickets`, `get_ticket_detail`, `list_inbox`, `resolve_inbox`, `search_memory_and_casebook`, `trigger_routine`, `manage_preview`, `analyze_impact`, `manage_checkpoints`, `mutate_dag_node`, `submit_review_comments`, `system_doctor`) & **3 resources** (`superwork://health`, `superwork://repos`, `superwork://inbox/pending`) over Streamable HTTP (`GET/POST /api/mcp`) and the `super-work mcp` stdio bridge (auto-spawning the local daemon when offline).
  - **Signed Webhooks & Mobile Action Cards**: Accepts HMAC-verified inbound GitHub webhooks (`POST /api/webhooks/github` via `X-Hub-Signature-256`) and ChatOps callbacks (`POST /api/webhooks/chatops`), dispatches adaptive Feishu/Slack/Discord/JSON notifications with **signed crawler-safe remote approval links (`GET/POST /api/webhooks/action`)**, plus native macOS desktop notifications.
- **Composable Task Blueprints & Risk-Scored Delivery Confidence Gate**: Ships 5 built-in **Task Blueprints** (`tdd-bugfix`, `ui-visual-polish`, `safe-refactor`, `backend-feature`, `docs-chore`) plus custom `super-work.json` `blueprints` (`explicit > blueprint > repo` precedence). Every pre-delivery task computes a deterministic `0–100` **`evaluateTicketRisk`** score across diff volume, `sensitivePaths`, symbol fanout, visual pixel delta, retries, conflict resolution, and verification confidence; under `deliveryGatePolicy: "risk_gated"`, scores above `riskThreshold` automatically route to an `outbox_signoff` Inbox card with full factor breakdown.
- **Line-Anchored Review Studio & 3-Way Semantic Rebase Conflict Resolver**:
  - **Line-Anchored Review Studio**: Syncs structured AI findings into persistent `ticket_review_comments`, enables `+` line-level commenting & **Draft Review Basket** (`Save Comments Only` vs `Request Changes`) in Diff Studio, rewinds safely to `implement`, and auto-resolves open comments when touched files pass verification.
  - **3-Way Semantic Conflict Resolver**: On rebase conflicts, captures a hidden `pre_rebase_conflict` checkpoint, extracts `merge-base` + `upstreamCommitSummaries` + `ours`/`theirs` hunks into a lockfile-free worktree (`prepareThreeWayConflictWorkspace`), runs a single bounded resolution turn preserving `lockedTestPaths`, and verifies all static + smoke gates (falling back cleanly to the checkpoint & `merge_conflict` Inbox card if still failing).
- **Stage Span Waterfall, System Doctor, Hot SQLite Backup & Modular Code-Split Web UI**:
  - Records inline per-stage execution **`StageSpan`** segments (`workspace_prep`, `worker_turn`, `static_verify`, `smoke_cdp`, `visual_diff`, `git_ops`), provides **`GET/POST /api/system/doctor(/fix)`** and **`VACUUM INTO`** zero-lock SQLite hot backups (`super-work doctor --fix`, `super-work backup create`), modularizes `SuperWorkKernel` into cohesive coordinators (`packages/core/src/kernel/*`), and code-splits React modals/views so every Vite chunk stays well under `500 kB`.
- **Deterministic Verification, Visual Spill, Live Previews & Repo Contract (`super-work.json`)**: Syncs team-shared `verificationCommands`, `setupCommands`, `smokeCheck` (including `browserCheck`), `previewCommand`, `forbiddenPaths`, `conventions`, `deliveryGatePolicy`, `sensitivePaths`, `blueprints`, and shared `playbook` rules from `super-work.json`; verification, smoke logs, and PNG `screenshot` captures persist as Spill artifacts (`GET /api/artifacts/:id/raw`), while **`WorktreePreviewManager`** launches bounded LRU-evicted Live Previews on free local ports with 20m TTL and automatic worktree/cleanup teardown.
- **Dual-Channel `Transactional Outbox` & 1-Click Safe Revert**: Supports remote **GitHub PR creation / incremental PR updates**, PR comment replies, and **`--no-ff` Local Merge (`local_merge`)** with **1-Click Safe Revert (`git revert -m 1`)** from both Web UI and CLI.
- **Graded `Mandate` Guardrails, Concurrency Quotas & Daily Budget Fuse**:
  - Pre-dispatch overlap detection (`mandateScopesOverlap`) serializes overlapping scopes, while per-repo `maxConcurrentWorkers` and `dailyBudgetUsd` caps pause new queued dispatches after finishing in-flight stages and create a `budget_cap` Inbox card.
  - Post-turn `git diff` validation immediately reverts forbidden paths (`.env*`, `*.pem`, `*.key`), while preserving out-of-scope edits (`scopeViolations`) in the worktree so the Inbox can **Expand Mandate & Continue** without re-burning worker tokens.
- **Command Center + First-Class `super-work` CLI**:
  1. **Attention Inbox**: High-signal approval queue for `observe_proposal`, `plan_approval`, `watchdog_escalation`, `mandate_violation`, `merge_conflict`, `outbox_signoff`, `budget_cap`, `pr_followup`, `arena_tiebreak`, and `epic_replan`—including inline Arena screenshots and Live Preview launch buttons.
  2. **Mission Board**: Five-column live swimlane board & embedded **Interactive DAG Studio** (SVG topology, breakpoint/pause/resume/rerun & live node surgery) with engine badges, TDD/Auto-Arena chips, PR chips, scope chips, and budget meters.
  3. **Scheduled Routines**: Dedicated view & preset library for Probe-to-Promote autonomous patrols with active hour windows, overlap/budget guards, and health run timeline.
  4. **Metrics & Budget View**: Tracks daily spend progress, delivery success rate, cumulative cost, per-engine telemetry, and **Engine x Category Bandit Performance Matrix**.
  5. **Deep Dive Drawer & `@super-work/cli`**: Inspect SSE streams, **per-file collapsible Diff Studio + Arena candidate diff switcher + inline `screenshot` & `visual_diff` PNG artifacts + Stage Checkpoint timeline (in-place Time-Travel Re-steer & fork) + Live Preview controls + 1-Click Safe Revert**, `Chain of Recall` & Casebook, or drive everything via CLI (`super-work mcp`, `up -d`, `status`, `dispatch --clarify --tdd --pause-before-run --engine auto --arena --wait`, `epic --tdd --wait`, `impact`, `checkpoint`, `dag`, `preview`, `routine`, `casebook`, `inbox`, `logs -f`, `watch`, `revert`, `playbook prune`).

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
- `GET /api/repos`, `POST /api/repos`, `PATCH /api/repos/:id`, `GET /api/repos/:id/blueprints`, `POST /api/repos/:id/contract/sync`, `POST /api/repos/:id/contract/export` — Register repos, configure `sandboxMode`, `deliveryGatePolicy` (`always_auto`/`risk_gated`/`always_signoff`), `riskThreshold`, `sensitivePaths`, list built-in/custom **Task Blueprints**, and sync/export `super-work.json`
- `GET /api/repos/:id/playbook`, `POST /api/repos/:id/playbook`, `PATCH /api/playbook/:entryId`, `DELETE /api/playbook/:entryId`, `POST /api/repos/:id/playbook/prune` — View, curate, and prune stale/suspect self-evolving Playbook rules
- `GET /api/repos/:id/casebook?q=...`, `DELETE /api/casebook/:entryId` — Browse and search delivered Episodic Casebook solutions and reverted pitfall warnings
- `GET /api/routines`, `POST /api/routines`, `PATCH /api/routines/:id`, `DELETE /api/routines/:id`, `POST /api/routines/:id/run`, `GET /api/routines/runs` — Manage Probe-to-Promote scheduled autonomous routines and patrol run logs
- `GET /api/metrics?repoId=...` — Query today's budget spend, delivery rate, per-engine telemetry, and `engineMatrix` Bandit category scores
- `POST /api/repos/:id/impact` — Compute zero-dep TS/JS/Py/Go/Rust symbol impact radius (`directDependents` & `indirectDependents`)
- `POST /api/specs/clarify` — On-demand Pre-Flight Spec Studio exploration returning recommended mode, template, allowed paths, criteria, impact warnings, and clarifying questions
- `POST /api/triggers` — Ingest external or simulated triggers (`github_issue`, `github_pr`, `github_ci`, `cli`)
- `GET /api/tickets`, `POST /api/tickets`, `GET /api/tickets/:id`, `POST /api/tickets/:id/message`, `POST /api/tickets/:id/cancel`, `POST /api/tickets/:id/cleanup-worktree`, `POST /api/tickets/:id/deliver`, `POST /api/tickets/:id/revert`, `PATCH /api/tickets/:id/dag-node` — Direct task dispatch (`--blueprint`, `--gate-policy`, `--tdd`, `--pause-before-run`, `--engine auto`), live DAG node surgery, Stage Span waterfalls, Risk assessments, Diff inspection, Thread follow-ups, dual-channel delivery, and atomic `git revert -m 1`
- `GET /api/tickets/:id/review-comments`, `POST /api/tickets/:id/review-comments`, `PATCH /api/review-comments/:commentId` — Read, submit line-anchored review baskets (`comment_only` / `request_changes`), and resolve/reopen comments
- `GET /api/tickets/:id/checkpoints`, `GET /api/tickets/:id/checkpoints/:cpId/diff`, `POST /api/tickets/:id/checkpoints/:cpId/restore` — Inspect hidden-ref stage checkpoints, view incremental diffs, and time-travel re-steer (`in_place` / `fork`)
- `POST /api/epics/preview`, `POST /api/epics` — Preview and dispatch Epic sub-task dependency DAGs
- `GET /api/previews`, `POST /api/previews`, `POST /api/previews/:id/renew`, `DELETE /api/previews/:id` — Launch, inspect, renew (+20m TTL), and tear down bounded Live Worktree Previews
- `GET /api/worktrees`, `POST /api/worktrees/gc` — Inspect active/reclaimable worktrees and run one-click garbage collection
- `GET /api/system/doctor`, `POST /api/system/doctor/fix`, `GET /api/system/backups`, `POST /api/system/backups` — Run System Doctor health diagnostics/cleanup and create zero-lock SQLite `VACUUM INTO` hot backups
- `GET /api/inbox`, `POST /api/inbox/:id/resolve` — Approve or reject pending Attention Inbox decisions (including Risk-gated `outbox_signoff`, 3-way `merge_conflict`, DAG breakpoints & `SPEC_TEST_CHALLENGE`)
- `GET /api/tickets/:id/recall`, `GET /api/memory/search?q=...`, `GET /api/artifacts/:id`, `GET /api/artifacts/:id/raw` — `Chain of Recall` lineage, FTS5 search, text Spill reader, and raw binary PNG `screenshot` / `visual_diff` reader
- `GET /api/outbox` — Inspect `Transactional Outbox` delivery entries
- `GET /api/mcp`, `POST /api/mcp` — Native MCP JSON-RPC 2.0 Streamable HTTP endpoint (`v1.0.0`, `super-work mcp` provides stdio transport; **15 tools** & 3 resources)
- `POST /api/webhooks/github`, `GET /api/webhooks/action`, `POST /api/webhooks/action`, `POST /api/webhooks/chatops` — HMAC-signed GitHub inbound webhooks, crawler-safe mobile remote approval HTML/action card endpoints, and ChatOps callbacks
- `GET /api/setup/status`, `POST /api/setup/scan`, `POST /api/setup/test-llm`, `POST /api/setup/configure`, `POST /api/notifications/test` — CLI environment scan, Control-Plane LLM setup, webhook secrets, and macOS / Webhook notification settings
- `GET /api/events?repoId=...&ticketId=...` — Real-time Server-Sent Events (SSE) stream with optional repo/ticket filtering (including `preview_updated` & `review_comment_updated`)

For step-by-step workflows see [USAGE.md](./USAGE.md); for architectural deep dives and core contracts see [ARCHITECTURE.md](./ARCHITECTURE.md).
