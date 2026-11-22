[English](./USAGE.md) | [简体中文](./USAGE.zh-CN.md)

# super-work Usage Guide

This guide walks through first-run CLI environment scanning, Control-Plane LLM configuration, and day-to-day asynchronous multi-agent engineering workflows in `super-work`.

---

## 1. First-Run Setup: CLI Environment Scan & Control-Plane LLM

`super-work` cleanly separates the **Control Plane** from the **Execution Plane**:
- **Execution Plane (Workers)**: Schedules locally installed coding agent CLIs (`claude`, `codex`, etc.) inside isolated `git worktree` sandboxes.
- **Control Plane (Router / Watchdog)**: Handles event triage, Mandate scoping, and Watchdog L2 semantic recovery.

### Option A: Web First-Run Setup Wizard (Recommended)

1. Start the daemon and Web Command Center, then open `http://localhost:5173`:
   ```bash
   bun run dev
   ```
2. On first launch (when `initialized` is false), the **First-Run CLI Scan & LLM Setup** wizard opens automatically. You can also reopen it anytime via the **Env & LLM** button in the top-right header:
   - **Local CLI Toolchain Scan**: Probes `claude`, `codex`, `opencode`, `gh`, `git`, and `bun` for binary paths, versions, authentication state (`Ready` / `Not Logged In` / `Not Found`), and local model/effort defaults from `~/.claude/settings.json` and `~/.codex/config.toml`.
   - **Default Engines & CLI Model/Effort Profiles**: Configure global `model` and `effort` (`low` / `medium` / `high` / `xhigh` / `max`) independently for `Claude Code` and `Codex CLI` without modifying your local config files; **Dispatch Task** also supports per-task model and effort overrides.
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
- **Repository Switcher & `+` Button**: Automatically binds the current Git repository (and parses `owner/repo` from `origin` for GitHub integration). Register multiple repositories anytime.
- **Operating Mode Toggle**:
  - `OFF`: Ingests triggers without creating tickets.
  - `OBSERVE` (Recommended to start): Proposes tickets into the **Attention Inbox** for human approval before touching any code.
  - `AUTO`: Dispatches qualifying triggers straight to worker execution, interrupting only on policy gates or Watchdog escalations.
- **Live Status Pills**: Displays `Live SSE`, detected worker engines, `Watchdog`, `Outbox` queue count, **Setup**, and `中文 / EN` language switch.

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

### 1. Dispatching a Task with Mandate Guardrails
1. Click **Dispatch Task** in the header.
2. Enter title, goal/verification notes, pipeline template, and preferred engine (`claude`, `codex`, or `mock`).
3. Narrow **Mandate Allowed Paths** (e.g. `packages/core/**, packages/drivers/**`):
   - Any modification outside allowed paths—or inside forbidden secret files (`.env*`, `*.pem`, `*.key`)—is automatically reverted post-turn and flagged in the Attention Inbox.

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

### 4. Handling Watchdog Escalations & Strict PR Sign-off
- If a worker hits repeated identical errors, `A -> B -> A` diff oscillation, or a silence timeout, `TwoTierWatchdog` attempts automatic self-healing (`INJECT_HINT` or `SWITCH_ENGINE`, e.g., `claude` → `codex`) before escalating to **Attention Inbox**.
- In `strict` mode, after a clean rebase, delivery pauses at `outbox_pending` until you approve `PR SIGNOFF` in the Inbox, triggering idempotent `Transactional Outbox` push & PR creation.

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
   - Everything lives inside `.super-work/` (or `SUPER_WORK_DATA_DIR`), which is ignored by `.gitignore`.
