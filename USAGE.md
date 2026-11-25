[English](./USAGE.md) | [简体中文](./USAGE.zh-CN.md)

# super-work Usage Guide

This guide walks through first-run CLI environment scanning, Control-Plane LLM configuration, and day-to-day asynchronous multi-agent engineering workflows in `super-work`.

---

## 1. First-Run Setup: CLI Environment Scan & Control-Plane LLM

`super-work` cleanly separates the **Control Plane** from the **Execution Plane**:
- **Execution Plane (Workers)**: Schedules locally installed coding agent CLIs (`claude`, `codex`, `opencode`, `gemini`, etc.) inside isolated `git worktree` sandboxes.
- **Control Plane (Router / Watchdog)**: Handles event triage, Mandate scoping, and Watchdog L2 semantic recovery.

### Option A: Web First-Run Setup Wizard (Recommended)

1. Start the daemon and Web Command Center, then open `http://localhost:5173`:
   ```bash
   bun run dev
   ```
2. On first launch (when `initialized` is false), the **First-Run CLI Scan & LLM Setup** wizard opens automatically. You can also reopen it anytime via the **Env & LLM** button in the top-right header:
   - **Local CLI Toolchain Scan**: Probes `claude`, `codex`, `opencode`, `gemini`, `gh`, `git`, and `bun` for binary paths, versions, authentication state (`Ready` / `Not Logged In` / `Not Found`), and local model/effort defaults from `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.config/opencode/opencode.json`, and `~/.gemini/settings.json`.
   - **Default Engines & CLI Model/Effort Profiles**: Configure global `model` and `effort` (`low` / `medium` / `high` / `xhigh` / `max`) independently for `Claude Code`, `Codex CLI`, `OpenCode CLI` (`provider/model#variant`), and `Gemini CLI` without modifying your local config files; **Dispatch Task** also supports per-task model and effort overrides.
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
- **Live Status Pills & `⌘K` Omnibox**: Header Row 1 provides `⌘K Chief` (`⌘K` / `Ctrl+K`) opening the dual-mode Search + Chief-of-Staff Omnibox (`?` prefix queries live telemetry, memory, and read-only code probes); Row 2 displays `Live Sync`, `Control Brain`, `Agent Roles`, `Repo Contract` (with `RiskGate` badge when gated), `Anti-Stall Watchdog`, `PR Delivery Queue`, `Autonomous Routines`, and **`Worktrees` (click to inspect active/reclaimable directories, run one-click GC, or open System Doctor)**, alongside **Env & LLM** (including **Doctor & Hot Backup**) and the `中文 / EN` language switch.

### 2. Command Center Views & `@super-work/cli`
1. **Attention Inbox**: High-signal queue aggregating `OBSERVE PROPOSAL`, `PLAN APPROVAL`, `MANDATE VIOLATION` (out-of-scope edits remain preserved for one-click **Expand Mandate & Continue**, while `super-work.json` & secret paths are strictly reverted), `WATCHDOG ESCALATION`, `MERGE CONFLICT`, `CAMPAIGN PAUSED`, `PR SIGNOFF`, `BUDGET CAP`, `ARENA TIEBREAK`, `EPIC REPLAN`, `CLARIFICATION`, and `PR FOLLOW-UP`, with multi-select & **Select Low-Risk** batch resolution.
2. **Mission Board & Merge Train**: Five-column real-time swimlane view with risk score badges (`R:<score>`), TDD/Auto-Arena tags, PR links, and Epic DAG canvas; click **`PR Delivery Queue`** in the header strip anytime to inspect, flush, or eject slots in the **Speculative Merge Train** & **Cross-Repo Release Barrier**.
3. **Scheduled Patrols & Goal Campaigns**: Use the top switcher in **Autonomous Routines** between **Scheduled Patrols** and **Goal Campaigns** to launch metric-driven optimization waves with inline SVG metric sparklines and monotonic regression rollback.
4. **Metrics & Budget**: Live daily budget progress, delivery rate, cumulative cost, per-engine latency & pass-rate metrics, Bandit matrix, and the **Golden Eval Suite** comparison board.
5. **Deep Dive Drawer & `@super-work/cli`** (`bun run cli` / `super-work`):
   - `super-work up [-d] [--host 127.0.0.1] [--port 4318]` / `super-work service [install|uninstall|start|stop|status|logs]` — Manage foreground or OS background daemon (`launchd` / `systemd --user`).
   - `super-work milestone [list | create --name <n> [--version <v>] [--repo <id>] <req...> | show <id> | release <id> [--bump] [--tag] [--push]]` — Create multi-wave Milestones and release them explicitly (tag/push are off unless you pass `--tag` / `--push`).
   - `super-work campaign ...` / `super-work train [list|flush|eject]` — Drive metric Goal Campaigns and inspect/flush/eject Merge Train queues.
   - `super-work status`, `intake [--preview] [--wait] "<requirement>"`, `wait <ticketId|epicId>`, `reload [--skip-canary] [--force]`, `ask <question>`, `steer <ticketId> <instruction>`, `blueprints`, `dispatch <title> -d <desc> [--blueprint <id>] [--gate-policy <policy>] [--wait]`, `epic <title> [--preview-only|--wait]`, `inbox [list|approve|reject|batch]`, `eval [list|save|run|delete]`, `doctor [--fix]`, `backup [list|create|restore <id>]`, `bundle [export|import <file>]`, `logs <ticketId> [-f]`, `watch [--repo <id>|--ticket <id>]`, `revert <ticketId>`, `playbook [list|add|toggle|delete|sync --export]` — Drop raw natural-language requirements via `intake`, wait on live SSE progress, trigger Boot Canary self-reloads, live-steer workers, query Chief-of-Staff, run Golden Evals, manage backups/restores, and revert merges safely.

### 3. Pipeline Templates

| Template | Stages | Human Gates | When to Use |
| :--- | :--- | :--- | :--- |
| `fast` | `implement` → `rebase` | On error/violation only | Small, well-scoped bug fixes or docs tweaks |
| `standard` | `plan` → `implement` → `review` → `rebase` | On error/violation only | Everyday feature work with cross-engine implement & review |
| `strict` | `plan` → `implement` → `review` → `rebase` | Mandatory `PLAN APPROVAL` + `PR SIGNOFF` | Auth, billing, migrations, or sensitive core changes |

---

## 3. Four Everyday Workflows

### 1. Smart Intake, Single Tickets, or Epics (DAG)
1. Click **Dispatch Task** in the header:
   - **Smart Intake (Default)**: Paste any natural-language requirement (with optional quantitative metric command), click **Preview Route & Scope** to inspect the predicted route (`single_ticket`, `epic_dag`, or `goal_campaign`) and scoped paths, and click **Smart Dispatch**—or run `super-work intake --wait "..."` from your terminal.
   - **Single Ticket**: Enter title, goal/verification notes, pipeline template, preferred engine (`claude` / `codex` / `opencode` / `gemini` + optional per-task model/effort overrides), and narrow **Mandate Allowed Paths** (out-of-scope edits or `.env*` / `*.pem` / `*.key` touches are automatically reverted and escalated).
   - **Decompose Epic (DAG)**: Switch to the Epic tab, keep **Unified Staging Branch (`super-work/epic/<id>`)** or switch to per-subtask delivery, describe a multi-module requirement, and click **Preview Epic DAG** to inline-edit subtask templates, descriptions, allowed paths, and dependency toggles. Completed subtasks merge into the Epic staging branch, run a final Epic verification gate (with 1 auto-fixup round if needed), and open one consolidated PR or atomic merge.

### 2. Testing `OBSERVE` vs `AUTO` with GitHub Polling & PR Follow-up Loops
1. With the repository in **`OBSERVE`** mode, click **Simulate Event** (or configure `githubRepo` so `GhCliPollingSource` polls open Issues, PR comments/reviews, and failing CI logs via `gh run view --log-failed`).
2. Self-comments containing `[super-work]` are automatically ignored. When an open PR receives external review feedback or CI failure, `auto` mode reactivates the original branch to fix, verify, incrementally `git push`, and comment back (capped at 3 rounds), while `observe` mode creates a `PR FOLLOW-UP` Inbox item.
3. Review the proposed Ticket + Mandate in **Attention Inbox** and click **Approve & Continue** to spin up its isolated `git worktree`.

### 3. Inspecting Diff Studio, Line-Anchored Review Basket & Using Chain of Recall
1. Open **Deep Dive Drawer** on any ticket:
   - **Execution Stream**: Inspect stage status, **Live Steer** active turns mid-flight without penalty, view **Stage Span Waterfall bars (`StageSpan`)**, **`StageToolProfile`** hot tool badges, **Risk Assessment**, **3-way conflict context**, and live SSE events, or click **Save Golden Eval** on delivered tickets.
   - **Diff & Mandate**: Browse the **File-Tree Diff Studio** with per-file `+`/`-` stats, collapsible hunks, synced AI & human inline `review_comments`, clickable **`+`** buttons per diff line feeding the **Review Basket** (`Save Comments Only` vs `Request Changes`, auto-resolving open comments once modified files pass verification), and **Rework This File** buttons.
   - **Chain of Recall**: Trace `Trigger → Thread → Inline Notes → Spill Artifacts` (including JSON `review_report` and `test_log` artifacts), click **Read Spill** on demand, or search past tickets via SQLite FTS5.
2. **Thread Subscription Follow-Up**: Send follow-up instructions via the bottom **Inject** bar; messages route straight into the subscribed Ticket's `inlineMemory.threadUpdates`.

### 4. Task Blueprints, Risk Gate, Golden Evals, Atomic Restore & Knowledge Bundles
- **Task Blueprints & Delivery Risk Gate (`A.1`)**: Pick built-in or custom `super-work.json` Blueprints (`tdd-bugfix`, `ui-visual-polish`, `safe-refactor`, `backend-feature`, `docs-chore`) inside **Dispatch Task** to prefill pipeline template, TDD, allowed paths, and `deliveryGatePolicy`; configure repo-wide `deliveryGatePolicy` (`always_auto` / `risk_gated` / `always_signoff`), `riskThreshold`, and `sensitivePaths` under **Repository Preferences**.
- **Golden Eval Suite, Knowledge Bundles & Atomic Hot Restore (`D.1`)**: Save any delivered ticket as a regression benchmark from the drawer header and replay it across engines under **Metrics & Budget → Golden Eval Suite** (`super-work eval`); export/import **Playbook + Casebook + Blueprints** bundles under **Repository Preferences → Playbook** (`super-work bundle`); capture `VACUUM INTO` snapshots and run verified **Atomic Restore** (`pre-restore` safety backup included) inside **Env & LLM → Doctor & Hot Backup** (`super-work backup restore`).
- For tasks delivered via `local_merge` (`--no-ff`), click **1-Click Safe Revert** in the drawer header (or run `super-work revert <ticketId>`) to execute a non-destructive `git revert -m 1` without rewriting history.

---

### 5. Milestones: Multi-Requirement Waves & Controlled Release (`v1.4.0`)
1. Open **Dispatch → Milestone** (or run `super-work milestone create --name "v1.4.0 release" --version 1.4.0 "req one" "req two"`), enter a name, the target version and a Markdown bullet/numbered list of requirements.
2. Requirements touching overlapping paths are serialized into later waves automatically; independent ones run in parallel. Track wave cards on the Board.
3. When every item is delivered the milestone turns **Ready to release**: review the EN/ZH release notes on the Board or in the Inbox `MILESTONE READY` card.
4. Release explicitly: tick *bump versions* (default on), optionally *create tag* / *push* (both default off), then confirm. The same flow is available via `POST /api/milestones/:id/release`, `super-work milestone release <id> --bump`, or approving the Inbox card (bump only).

### 6. Milestone Staging Branch & Squash Release (`v1.5.0`)
1. In **Dispatch → Milestone** pick **Integration mode = Milestone staging branch** (CLI: `super-work milestone create --name "v1.5.0 release" --version 1.5.0 --integration milestone_branch --route auto "req one" "req two"`). Choose `--route single_ticket` to skip epic/campaign splitting.
2. Items merge automatically into `super-work/milestone/<id>` (shown as a *Staging branch* badge) with no per-item signoff; your base branch is untouched until release.
3. When all items are delivered, approve the single **MILESTONE READY** card, or release explicitly: tick *Squash into one release commit* to get one clean commit (tree-identical to the merged result). CLI: `super-work milestone release <id> --bump --squash [-m "feat: release v1.5.0"]`; REST body: `{"bumpVersion":true,"squashReleaseCommit":true,"createTag":false,"pushRemote":false}`.
4. Released milestones move to the collapsible **Released History** section (version, release commit SHA, EN/ZH notes).
5. Engine health is available via `GET /api/system/engines` and MCP `manage_engine_health` (`list|reset|probe`).

### 7. Playbook Hygiene & Optional GitHub Release (`v1.6.0`)
1. Inbox notes are **no longer saved to the Playbook by default**. Pass `saveToPlaybook: true` (REST) to opt in; one-off notes such as "human approved continuation" or ticket ids are still skipped.
2. Audit: `super-work playbook audit` (REST `GET /api/playbooks/hygiene`, MCP `manage_playbook_hygiene {action:"audit"}`). Clean up: `super-work playbook prune` (disables noisy rules; add `--delete` to remove them) or `super-work doctor --prune-playbooks`. In the Web **Doctor** tab use the **Playbook Hygiene** card's *Disable Noisy Rules* button. REST prune accepts `{ repoId?, dryRun?, mode? }`.
3. The Flight Recorder panel now shows combined gate savings (scoped + rebase reuse) and engine-trip / spillover-quarantine counters.
4. Optional GitHub Release: `super-work milestone release <id> --bump --tag --push --github-release` (REST `createGithubRelease: true`; Web checkbox is enabled only when *tag* and *push* are ticked). Requires a milestone target version and an authenticated `gh`; invalid combinations are rejected before git is touched. Off by default.

## 4. Concurrency Best Practices & FAQ

1. **How do multiple Workers run truly in parallel without blocking each other?**
   - Assign disjoint **Mandate Allowed Paths** when dispatching tasks (e.g., `packages/core/**` and `packages/web/**`). Non-overlapping tickets run concurrently in separate `git worktree` directories; overlapping scopes are automatically serialized via `dependsOn`.
2. **What does `Repository has no commits (unborn HEAD)` mean?**
   - `git worktree add` requires at least one commit in the repository. Create an initial `git commit` before dispatching tasks.
3. **What if the CLI scan reports `Not Logged In`?**
   - Claude Code: run `claude auth login`
   - Codex CLI: run `codex login`
   - Gemini CLI: run `gemini` (OAuth) or set `GEMINI_API_KEY`
   - GitHub CLI: run `gh auth login`
   - Then click **Setup → Rescan** in the Web dashboard.
   - Tip: For self-hosted restarts on `super-work` itself, open **Env & LLM → Doctor & Hot Backup → Self-Host Reload** or run `super-work reload`.
4. **Where are runtime databases, worktrees, and Spill artifacts stored?**
   - Everything lives inside `.super-work/` (or `SUPER_WORK_DATA_DIR`), which is ignored by `.gitignore`. By default, delivered and cancelled worktree directories are automatically reclaimed while keeping committed branches viewable, or click **Worktrees** in the header strip to run manual GC.

## 5. Quick Self-Hosted Milestone & Digest Check

List your milestones and print the last 24 hours of run digest in Markdown to confirm a self-hosted instance is healthy:

```bash
super-work milestone list
super-work digest --hours 24 --markdown
```
