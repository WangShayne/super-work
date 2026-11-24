[English](./USAGE.md) | [简体中文](./USAGE.zh-CN.md)

# super-work Usage Guide

This guide walks through first-run CLI environment scanning, Control-Plane LLM configuration, and day-to-day asynchronous multi-agent engineering workflows in `super-work`.

---

## 1. First-Run Setup: CLI Environment Scan & Control-Plane LLM

`super-work` cleanly separates the **Control Plane** from the **Execution Plane**:
- **Execution Plane (Workers)**: Schedules locally installed coding agent CLIs (`claude`, `codex`, `opencode`, etc.) inside isolated `git worktree` sandboxes.
- **Control Plane (Router / Watchdog)**: Handles event triage, Mandate scoping, and Watchdog L2 semantic recovery.

### Option A: Web First-Run Setup Wizard (Recommended)

1. Start the daemon and Web Command Center, then open `http://localhost:5173`:
   ```bash
   bun run dev
   ```
2. On first launch (when `initialized` is false), the **First-Run CLI Scan & LLM Setup** wizard opens automatically. You can also reopen it anytime via the **Env & LLM** button in the top-right header:
   - **Local CLI Toolchain Scan**: Probes `claude`, `codex`, `opencode`, `gh`, `git`, and `bun` for binary paths, versions, authentication state (`Ready` / `Not Logged In` / `Not Found`), and local model/effort defaults from `~/.claude/settings.json`, `~/.codex/config.toml`, and `~/.config/opencode/opencode.json`.
   - **Default Engines & CLI Model/Effort Profiles**: Configure global `model` and `effort` (`low` / `medium` / `high` / `xhigh` / `max`) independently for `Claude Code`, `Codex CLI`, and `OpenCode CLI` (`provider/model#variant`) without modifying your local config files; **Dispatch Task** also supports per-task model and effort overrides.
   - **Control-Plane LLM**: Pick one of five presets, click **Test Connection** to verify reachability and latency, and click **Save & Activate** (hot-swaps immediately in memory without restarting the server):

| Preset | Best For | Requirements & Cost |
| :--- | :--- | :--- |
| **DeepSeek API** (Recommended) | Fast, low-cost JSON triage & Watchdog L2 diagnosis | Requires `DEEPSEEK_API_KEY`; defaults to `https://api.deepseek.com/v1` + `deepseek-chat` |
| **OpenAI / Compatible API** | OpenAI, Azure, OneAPI, or local Ollama gateways | Provide `Base URL`, `Model Name`, and `API Key` |
| **Reuse Local Claude CLI** | Using existing Claude Code login without a separate API key | Zero extra keys; configurable model & effort (recommend `low`) |
| **Reuse Local Codex CLI** | Using existing Codex CLI login without a separate API key | Zero extra keys; read-only structured JSON exec with model & effort (`low` recommended) |
| **Local Heuristic Engine** | Offline testing, demos, or zero control-plane token cost | Zero configuration; deterministic rule-based routing & recovery |

### Option B: Terminal Setup Command

You can also scan and configure settings from the command line:

```bash
# Interactive terminal wizard
bun run setup

# Non-interactive auto-configuration from scanned CLIs and env vars
bun run setup -- --auto
```

---

## 2. Interface Tour & Core Concepts

### 1. Header Control Bar
- **Repository Switcher, `+` & Preferences Button**: Automatically binds the current Git repository; click **Repository preferences** next to the selector to configure per-repo default pipeline template, preferred implement/review engines, base branch, GitHub binding, and **Auto-reclaim Worktree**.
- **Operating Mode Toggle**:
  - `OFF`: Ingests triggers without creating tickets.
  - `OBSERVE` (Recommended to start): Proposes tickets into the **Attention Inbox** for human approval before touching any code.
  - `AUTO`: Dispatches qualifying triggers straight to worker execution, interrupting only on policy gates or Watchdog escalations.
- **Live Status Pills**: Displays `Live Sync`, `Control Brain`, `Agent Roles`, `Repo Contract` (with `RiskGate` badge when gated), `Anti-Stall Watchdog`, `PR Delivery Queue`, `Autonomous Routines`, and **`Worktrees` (click to inspect active/reclaimable directories, run one-click GC, or open System Doctor)**, alongside **Env & LLM** (including **Doctor & Hot Backup**) and the `中文 / EN` language switch.

### 2. Command Center Views & `@super-work/cli`
1. **Attention Inbox**: High-signal queue aggregating `OBSERVE PROPOSAL`, `PLAN APPROVAL`, `MANDATE VIOLATION` (out-of-scope edits remain preserved for one-click **Expand Mandate & Continue**), `WATCHDOG ESCALATION`, `MERGE CONFLICT` (with **3-way `ours`/`theirs` semantic diff context**), `PR SIGNOFF` (with **A.1 Risk Breakdown** when risk-gated), `BUDGET CAP`, `ARENA TIEBREAK`, `EPIC REPLAN`, and `PR FOLLOW-UP`.
2. **Mission Board**: Five-column real-time swimlane view with risk score badges (`R:<score>`), TDD/Auto-Arena tags, PR links, and Epic DAG canvas.
3. **Metrics & Budget**: Live daily budget progress, delivery rate, cumulative cost, per-engine latency & pass-rate metrics, and Bandit matrix.
4. **Deep Dive Drawer & `@super-work/cli`** (`bun run cli` / `super-work`):
   - `super-work up [-d]` — Start daemon in foreground or background.
   - `super-work status`, `blueprints`, `dispatch <title> -d <desc> [--blueprint <id>] [--gate-policy <policy>] [--wait]`, `epic <title> [--preview-only|--wait]`, `doctor [--fix]`, `backup [list|create]`, `inbox list|approve <id> [--expand-mandate]`, `logs <ticketId> [-f]`, `watch [--repo <id>|--ticket <id>]`, `revert <ticketId>`, `playbook [list|add|toggle|delete|sync --export]` — Control tasks, Task Blueprints, System Doctor/hot backups, Playbook rules, live SSE streams, and safe merge reverts from the terminal.

### 3. Pipeline Templates

| Template | Stages | Human Gates | When to Use |
| :--- | :--- | :--- | :--- |
| `fast` | `implement` → `rebase` | On error/violation only | Small, well-scoped bug fixes or docs tweaks |
| `standard` | `plan` → `implement` → `review` → `rebase` | On error/violation only | Everyday feature work with cross-engine implement & review |
| `strict` | `plan` → `implement` → `review` → `rebase` | Mandatory `PLAN APPROVAL` + `PR SIGNOFF` | Auth, billing, migrations, or sensitive core changes |

---

## 3. Four Everyday Workflows

### 1. Dispatching a Task or Decomposing an Epic DAG
1. Click **Dispatch Task** in the header:
   - **Single Ticket**: Enter title, goal/verification notes, pipeline template, preferred engine (+ optional per-task model/effort overrides), and narrow **Mandate Allowed Paths** (out-of-scope edits or `.env*` / `*.pem` / `*.key` touches are automatically reverted and escalated).
   - **Decompose Epic (DAG)**: Switch to the Epic tab, keep **Unified Staging Branch (`super-work/epic/<id>`)** or switch to per-subtask delivery, describe a multi-module requirement, and click **Preview Epic DAG** to inline-edit subtask templates, descriptions, allowed paths, and dependency toggles. Completed subtasks merge into the Epic staging branch, run a final Epic verification gate (with 1 auto-fixup round if needed), and open one consolidated PR or atomic merge.

### 2. Testing `OBSERVE` vs `AUTO` with GitHub Polling & PR Follow-up Loops
1. With the repository in **`OBSERVE`** mode, click **Simulate Event** (or configure `githubRepo` so `GhCliPollingSource` polls open Issues, PR comments/reviews, and failing CI logs via `gh run view --log-failed`).
2. Self-comments containing `[super-work]` are automatically ignored. When an open PR receives external review feedback or CI failure, `auto` mode reactivates the original branch to fix, verify, incrementally `git push`, and comment back (capped at 3 rounds), while `observe` mode creates a `PR FOLLOW-UP` Inbox item.
3. Review the proposed Ticket + Mandate in **Attention Inbox** and click **Approve & Continue** to spin up its isolated `git worktree`.

### 3. Inspecting Diff Studio, Line-Anchored Review Basket & Using Chain of Recall
1. Open **Deep Dive Drawer** on any ticket:
   - **Execution Stream**: Inspect stage status, costs, **inline Stage Span Waterfall bars (`StageSpan`)**, **Risk Assessment** & **3-way conflict context**, and live SSE events.
   - **Diff & Mandate**: Browse the **File-Tree Diff Studio** with per-file `+`/`-` stats, collapsible hunks, synced AI & human inline `review_comments`, clickable **`+`** buttons per diff line feeding the **Review Basket** (`Save Comments Only` vs `Request Changes`, auto-resolving open comments once modified files pass verification), and **Rework This File** buttons.
   - **Chain of Recall**: Trace `Trigger → Thread → Inline Notes → Spill Artifacts` (including JSON `review_report` and `test_log` artifacts), click **Read Spill** on demand, or search past tickets via SQLite FTS5.
2. **Thread Subscription Follow-Up**: Send follow-up instructions via the bottom **Inject** bar; messages route straight into the subscribed Ticket's `inlineMemory.threadUpdates`.

### 4. Task Blueprints, Risk Gate, System Doctor, Hot Backups & Safe Revert
- **Task Blueprints & Delivery Risk Gate (`A.1`)**: Pick built-in or custom `super-work.json` Blueprints (`tdd-bugfix`, `ui-visual-polish`, `safe-refactor`, `backend-feature`, `docs-chore`) inside **Dispatch Task** to prefill pipeline template, TDD, allowed paths, and `deliveryGatePolicy`; configure repo-wide `deliveryGatePolicy` (`always_auto` / `risk_gated` / `always_signoff`), `riskThreshold`, and `sensitivePaths` under **Repository Preferences**.
- In **Env & LLM Setup → Doctor & Hot Backup** (or via CLI `super-work doctor [--fix]` / `super-work backup [list|create]`), run integrity diagnostics across SQLite, reclaimable worktrees, stale previews, and lingering hidden checkpoint refs, and capture zero-lock `VACUUM INTO` hot SQLite snapshots.
- For tasks delivered via `local_merge` (`--no-ff`), click **1-Click Safe Revert** in the drawer header (or run `super-work revert <ticketId>`) to execute a non-destructive `git revert -m 1` without rewriting history.

---

## 4. Concurrency Best Practices & FAQ

1. **How do multiple Workers run truly in parallel without blocking each other?**
   - Assign disjoint **Mandate Allowed Paths** when dispatching tasks (e.g., `packages/core/**` and `packages/web/**`). Non-overlapping tickets run concurrently in separate `git worktree` directories; overlapping scopes are automatically serialized via `dependsOn`.
2. **What does `Repository has no commits (unborn HEAD)` mean?**
   - `git worktree add` requires at least one commit in the repository. Create an initial `git commit` before dispatching tasks.
3. **What if the CLI scan reports `Not Logged In`?**
   - Claude Code: run `claude auth login`
   - Codex CLI: run `codex login`
   - GitHub CLI: run `gh auth login`
   - Then click **Setup → Rescan** in the Web dashboard.
4. **Where are runtime databases, worktrees, and Spill artifacts stored?**
   - Everything lives inside `.super-work/` (or `SUPER_WORK_DATA_DIR`), which is ignored by `.gitignore`. By default, delivered and cancelled worktree directories are automatically reclaimed while keeping committed branches viewable, or click **Worktrees** in the header strip to run manual GC.
