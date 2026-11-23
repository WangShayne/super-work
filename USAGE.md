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
- **Live Status Pills**: Displays `Live Sync`, `Control Brain`, `Agent Roles`, `Anti-Stall Watchdog`, `PR Delivery Queue`, and **`Worktrees` (click to inspect active/reclaimable directories and run one-click GC)**, alongside **Env & LLM** and the `中文 / EN` language switch.

### 2. Three-Tier Navigation
1. **Attention Inbox**: High-signal queue aggregating `OBSERVE PROPOSAL`, `PLAN APPROVAL`, `MANDATE VIOLATION`, `WATCHDOG ESCALATION`, `MERGE CONFLICT`, and `PR SIGNOFF`.
2. **Mission Board**: Five-column real-time swimlane view (`Triage & Proposed` → `Queued & Planning` → `Implementing` → `Review & Outbox` → `Needs Human / Done`).
3. **Deep Dive Drawer**: Click any ticket card or **Inspect Deep Dive →** to access `Execution Stream`, `Diff & Mandate`, `Chain of Recall`, `Outbox`, and the live Thread follow-up bar.

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
   - **Decompose Epic (DAG)**: Switch to the Epic tab, describe a multi-module requirement, click **Preview Epic DAG** to inspect/edit subtask scopes and dependencies, and dispatch parallelizable subtasks (downstream subtasks automatically merge upstream dependency branches).

### 2. Testing `OBSERVE` vs `AUTO` with GitHub Polling or Simulated Events
1. With the repository in **`OBSERVE`** mode, click **Simulate Event** (or configure `githubRepo` so `GhCliPollingSource` polls open Issues, PR comments, and failing CI checks).
2. Include `scope:src/auth/**` in the body if you want to hint the target path scope.
3. Review the proposed Ticket + Mandate in **Attention Inbox** and click **Approve & Continue** to spin up its isolated `git worktree`.

### 3. Inspecting Live Streams, Injecting Thread Follow-Ups & Using Chain of Recall
1. Open **Deep Dive Drawer** on any ticket:
   - **Execution Stream**: Inspect stage costs, summaries, and live SSE events.
   - **Diff & Mandate**: Review colorized unified `git diff` against the base branch.
   - **Chain of Recall**: Trace `Trigger → Thread → Inline Notes → Spill Artifacts`, click **Read Spill** to load full JSONL transcripts or diff patches on demand, or search past tickets via SQLite FTS5.
2. **Thread Subscription Follow-Up**: Send follow-up instructions via the bottom **Inject** bar; messages route straight into the subscribed Ticket's `inlineMemory.threadUpdates`.

### 4. Deterministic Verification, Watchdog Escalations & Local Merge / PR Sign-off
- Configure **Deterministic Verification Gate Commands** (e.g. `bun run typecheck, bun test`) in **Repository Preferences** so every `implement` and `rebase` stage runs real shell checks with full `Verification Log` Spill artifacts and automatic retry feedback on failure.
- If a worker hits repeated identical errors, `A -> B -> A` diff oscillation, or a silence timeout, `TwoTierWatchdog` attempts automatic self-healing (`INJECT_HINT` or `SWITCH_ENGINE`) before escalating to **Attention Inbox**.
- In `strict` mode, `outbox_pending` offers both **Approve & Continue** (PR) and **Approve & Merge Locally** in the Inbox; for already-delivered branches, click **Merge Locally to Base** inside **Deep Dive Drawer** to merge into the base branch and clean up the temporary branch.

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
