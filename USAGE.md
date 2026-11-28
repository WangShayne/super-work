<p align="center">
  <strong>English</strong> · <a href="./USAGE.zh-CN.md">简体中文</a> · <a href="./README.md">README</a> · <a href="./ARCHITECTURE.md">Architecture</a>
</p>

# `super-work` Usage Guide

This guide walks you through first-run onboarding, configuring the Dual-Harness Model Pool, navigating the Web Command Center & CLI, and running day-to-day autonomous engineering and release workflows (`v1.8.3`).

---

## Table of Contents

1. [Zero-to-First-Delivery Onboarding](#1-zero-to-first-delivery-onboarding)
2. [Configuring Models & Roles (Dual-Harness Studio)](#2-configuring-models--roles-dual-harness-studio)
3. [Web Command Center Tour](#3-web-command-center-tour)
4. [Everyday Autonomous Workflows](#4-everyday-autonomous-workflows)
5. [Milestones & 1-Click Release Publishing](#5-milestones--1-click-release-publishing)
6. [Developer Engine Room: Memory, Evals, Backups & Operations](#6-developer-engine-room-memory-evals-backups--operations)
7. [CLI & MCP Reference](#7-cli--mcp-reference)
8. [Concurrency Best Practices & FAQ](#8-concurrency-best-practices--faq)

---

## 1. Zero-to-First-Delivery Onboarding

Three steps take you from a fresh clone to your first verified delivery:

### Step 1 — Start the Daemon & Web UI

```bash
bun install && bun run build
bun run dev
# Daemon API + SSE: http://127.0.0.1:4318
# Web Command Center: http://localhost:5173
```

*(Prefer terminal-only setup? Run `bun run setup` interactively or `bun run setup -- --auto`.)*

### Step 2 — 1-Click Zero-Config Setup
When you open `http://localhost:5173` for the first time, the **Setup Wizard** scans your machine for `claude`, `codex`, `opencode`, `gemini`, `gh`, `git`, and `bun`:
- Click **Start with Recommended Defaults** (`POST /api/setup/quick-start`) to auto-bind your best signed-in CLI (`claude` → `codex` → local heuristic) with zero API keys required, **or**
- Click **Customize LLM & Engines** to configure API models (DeepSeek, OpenAI, Anthropic, Ollama) and role bindings directly.

### Step 3 — Register a Repository & State a Requirement
1. Click **`+`** beside the repository pill in the **Hero Composer** and choose a local Git repository path. `super-work` runs a read-only probe (`POST /api/repos/detect`) to auto-fill the repo name, base branch, tech stack (Bun / Node / Rust / Python / Go), and verification commands.
2. Type what you want built, fixed, or refactored into the **Hero Composer** (or run `super-work do "<requirement>"`). Append `scope:<glob>` (e.g. `scope:packages/server/**`) whenever you want to pin allowed paths explicitly.

### Choosing Your Autonomy Dial

Right below the requirement input, pick how much authority `super-work` exercises on the selected repository:

| Preset | Gate Policy | Behavior |
| :--- | :--- | :--- |
| **Guarded** (`guarded`) | `always_signoff` | Codes, tests, and cross-reviews autonomously, then pauses before **every** merge/PR for your approval |
| **Smart** (`smart`, default) | `risk_gated` (threshold `35`) | Auto-ships verified low-risk changes; pauses for sign-off on high-risk diffs or `sensitivePaths` |
| **Autonomous** (`autonomous`) | `always_auto` | End-to-end delivery; interrupts you **only** on real blockers (merge conflicts, scope violations, budget caps) |

> **Backward compatibility**: Legacy preset names (`copilot` → `guarded`, `standard` → `smart`, `autopilot` → `autonomous`) in `super-work.json` or REST requests are normalized automatically. Explicit `PATCH /api/repos/:id` overrides are never clobbered by re-syncs.

---

## 2. Configuring Models & Roles (Dual-Harness Studio)

Open **Settings → Models & Roles** to manage the unified peer **Model Pool**.

`super-work` wraps one deterministic **Outer Governance Harness** (isolated worktree, Mandate, gates, cross-review, Outbox) around two pluggable **Inner Harnesses**:
- **Native CLI Harness** (`claude` / `codex` / `opencode` / `gemini`): Reuses your flat-rate local subscription and co-trained coding tools.
- **Built-in API Harness** (`DeepSeek` / `OpenAI-compatible` / `Anthropic-compatible` / `Local Ollama`): Calls HTTP directly with a lightweight worktree-jailed tool loop.

### 1. Assign the Three Roles (or Click a Smart Recipe)
At the top of **Models & Roles**:
- **1-Click Smart Recipes** appear dynamically based on your ready profiles:
  - *API control + subscription CLI coding*
  - *Dual-CLI heterogeneous review*
  - *Pure API autonomy*
  - *Smart auto-routing across the pool*
- **Three Role Selectors** save immediately when changed:
  1. **Control Model**: Understands requirements, splits DAGs, routes engines, and diagnoses Watchdog alerts (*Local heuristic* uses zero tokens).
  2. **Implement Worker Model**: Writes and verifies code inside isolated `git worktree` sandboxes (*Auto-pick best* routes via Bandit telemetry).
  3. **Cross-Review Model**: Independently audits the diff (*Auto heterogeneous* automatically picks a different model from Implement to prevent self-review blind spots).
- **Anti-Pattern Advisor**: Warns if Implement and Review share the same model, if Control is left on heuristics while AI models are ready, if the Auto pool is empty, or if a custom profile is incomplete — with **1-click fix buttons**.

### 2. Add, Discover (`/models`) & Test Profiles
1. Click **+ Add Model** and choose a template from either track (DeepSeek, OpenAI / Compatible, Anthropic / Compatible, Local Ollama, or a local CLI variant).
2. Fill in **Base URL** and **API Key** (Ollama / `localhost` needs no key), then click **Fetch Models** (`POST /api/setup/models` / `POST /api/setup/model`). `super-work` probes `/models`, `/v1/models`, `/model`, `/v1/model` (plus Ollama `/api/tags`) and renders real upstream model IDs as clickable filterable chips.
3. For CLI profiles, expand **Advanced: custom relay gateway** if you want per-invocation `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `GOOGLE_GEMINI_BASE_URL` + relay key injection without modifying your local `~/.claude` or `~/.codex` files (**Fetch relay models** works here too).
4. Click **Test Connection** (`POST /api/setup/test-model`) to verify latency, then **Save Model**. Toggle **Allow auto-rotation** on any card to include/exclude it from `Auto` mode without restricting manual selection.

---

## 3. Web Command Center Tour

The UI is organized around a single **HeaderBar** (`v1.8.3` badge + Live Health Dot · **Home / History / Settings** tabs · `⌘K` Chief-of-Staff · `ZH / EN` switch) and three workspaces:

### 1. Home
- **Hero Composer**:
  - **Starter Chips** (`Fix a bug`, `Build a feature`, `Safe refactor`, `Cut a release`): Stay visible after selection (`aria-pressed` + `×`). Click the active chip again or click **Clear** to cancel and reset scaffold/release state; switch directly between chips at any time; your custom typed text and custom Options are preserved.
  - **Options (`▾`)**: Toggle *Release Milestone mode*, specify `allowedPaths` (`scope:<glob>`), pin a `ModelProfile` for this run, or cap budget (`$`).
  - **Preview Plan** vs **Run** (`⌘⏎` / `Ctrl+Enter`): Inspect the predicted route (`Single Task`, `Multi-Step Plan`, or `Optimization Loop`) before dispatching.
- **Needs You**: Groups pending human decisions into **Approve** (outbox sign-off, plan approval, observe proposal, milestone ready, arena tie-break), **Answer** (worker clarification, epic re-plan), and **Unblock** (mandate violation, watchdog escalation, merge conflict, budget cap, PR follow-up, paused campaign), with multi-select batch actions.
- **Live Work**: Each running mission row displays a live ticking elapsed clock, the latest structured step badge + headline, a compact `Plan · Code · Review · Merge` stage bar, and an inline **Live (n)** console toggle showing the last 6 steps without opening the drawer.

### 2. DeepDive Drawer
Click any mission row to open the slide-over inspection cockpit:
- **Overview Tab**:
  - **Inline Decision Cards**: If a ticket is paused in `needs_human` or `outbox_pending`, its interactive `NeedsYouCard` renders **right at the top of the drawer** so you can answer clarifications, expand Mandate, or approve merges immediately.
  - **Live Execution Feed**: Phase-aware status badge (`SSE Live` while working, amber `Awaiting your decision` when paused for human input, `Execution finished` when terminal), category filters (`All` / `Tools` / `Thoughts` / `Stages & gates`), auto-scroll toggle, and automatic stage-run timeline synthesis for historical tickets.
  - **Stage Runs & Waterfall**: Per-stage cost, engine, `Scoped Gate` time-saved badges, `StageSpan` duration bars, and `StageToolProfile` call/error heatmaps.
- **Changes Tab**: Per-file collapsible **Diff Studio**, Arena candidate switcher, `+` line-anchored comments feeding the **Review Basket** (`Save Comments Only` vs `Request Changes`), and Mandate scope summary.
- **More (`▾`)**: Access **Chain of Recall** (FTS5 memory + on-demand Spill artifacts), **Outbox**, **Stage Checkpoints** (view incremental diffs, `Restore & Re-steer`, or `Fork New Ticket`), **Start Live Preview**, **Save Golden Eval**, **Reclaim Worktree**, and **1-Click Safe Revert**.
- **Bottom Steer Bar**: While a worker is actively running (`planning` / `spec_testing` / `implementing` / `reviewing`), sends a zero-penalty **Live Steer** (`POST /api/tickets/:id/steer`, optionally switching models mid-flight); otherwise appends a follow-up message to the ticket's thread.

### 3. History & Settings (Engine Room)
- **History**: Switch between **Timeline & Releases** (active & archived Milestones + ticket search/status filters) and **Board / DAG** (5-column live swimlanes + interactive SVG **DAG Studio** with node breakpoints and live scope/dependency surgery).
- **Settings**: Top-level **Essentials** (Repository & Branch, Autonomy Level, Daily Budget, Models & Roles, Notifications) plus the collapsible **Developer / Engine Room** with 5 tabs: *Contract & Gates*, *Memory*, *Automation*, *Operations*, and *Observability & Health*.

---

## 4. Everyday Autonomous Workflows

### Pipeline Templates

| Template | Stages | Human Gates | Typical Use Case |
| :--- | :--- | :--- | :--- |
| `fast` | `implement` → `rebase` | Blockers / policy only | Focused bug fixes, small UI/config/docs updates |
| `standard` | `plan` → `implement` → `review` → `rebase` | Risk gate / blockers | Everyday features with heterogeneous cross-review |
| `strict` | `plan` → `implement` → `review` → `rebase` | Mandatory `Plan Approval` + `Outbox Signoff` | Auth, billing, schema migrations, core contracts |

### Workflow A — Single Ticket, Multi-Subtask Epic DAG, or Goal Campaign
- **Implicit Smart Intake**: Drop a requirement into the Hero Composer or `super-work do "..."`. Single-module work becomes a `single_ticket`; multi-module or multi-repo work decomposes into a concurrent `epic_dag` (merging cleanly onto `super-work/epic/<id>` with one consolidated verification gate); prompts with an executable metric (`metric: \`bun run bench\` target: 120`) launch an iterative `goal_campaign` with automatic regression rollback.
- **Pre-Flight Spec Clarification**: For ambiguous tasks, run `super-work dispatch "..." --clarify` (or `POST /api/specs/clarify`) to inspect 1-hop / 2+ hop symbol impact radius and answer structured pre-flight questions before coding begins.
- **Red-Green TDD Guard (`--tdd`)**: Inserts a `spec_test` stage before `implement` that writes failing tests first and locks those test files read-only inside the OS sandbox (`lockedTestPaths`) so the implementation worker cannot weaken or delete tests to pass.

### Workflow B — GitHub Issues, PR Review & CI Auto-Followup
- Bind `githubRepo` (`owner/repo`) in Repository Settings (or configure inbound `POST /api/webhooks/github` with `GITHUB_WEBHOOK_SECRET`).
- When an open PR created by `super-work` receives human review comments or failing GitHub Actions checks (`gh run view --log-failed`), `super-work` ignores its own `[super-work]` comments, wakes up the existing branch, fixes and verifies locally, pushes incremental commits to the same PR, and replies (capped at 3 rounds).

### Workflow C — Handling Scope Guardrails & Merge Conflicts Without Lost Work
- **Mandate Expansion**: Touches to `.env*`, `*.pem`, `*.key`, or `super-work.json` are reverted immediately. If a worker edits an ordinary file outside `allowedPaths`, those edits remain safely staged in the worktree and raise a `MANDATE VIOLATION` card — click **Expand Mandate & Continue** to widen the scope and run verification without re-running the LLM turn.
- **3-Way Semantic Conflict Resolution**: If `main` advances while a ticket is running, `rebase` automatically snapshots a `pre_rebase_conflict` checkpoint and runs a bounded 3-way semantic resolution turn verified against all gates (escalating cleanly with `ours`/`theirs` summaries if conflicts remain).

---

## 5. Milestones & 1-Click Release Publishing

`super-work` supports **two** release workflows — multi-item backlog waves and direct base-branch releases:

### Mode A — Direct Release (Code Already Merged on `main`)
When your features and fixes are already merged onto `main` and you want `super-work` to consolidate commits, bump versions, create an annotated Git tag, and push to `origin`:
1. On **Home**, click the **Cut a release** (`发布版本`) chip, enter the target version (e.g. `v1.8.3`) and optional title, and **leave the text box blank** (or write release housekeeping notes like `"consolidate commits, tag v1.8.3 and push"`), then click **Create Release Milestone**.
2. Because no coding worker turn is needed, `super-work` immediately places a **`Milestone Ready`** card under **Needs You** on Home.
3. Review the synthesized EN/ZH Release Notes (`Technical details ▾`), confirm the inline options:
   - **Bump `package.json` versions** (updates root + `packages/*/package.json` if needed)
   - **Squash into one release commit** (losslessly collapses unpushed `origin/main..HEAD` commits into one clean release commit and verifies 100% `HEAD^{tree}` SHA parity)
   - **Create Git tag** (`vX.Y.Z` annotated tag; fails fast before mutating history if the tag already exists)
   - **Push to remote** (`git push origin <baseBranch>` + tag)
   - **Create GitHub Release** (requires authenticated `gh` + tag + push)
   - Optional custom release commit message (e.g. `feat: release v1.8.3`)
4. Click **Release** (`执行发布`) — or click **Reject** (`POST /api/milestones/:id/cancel`) to cancel the milestone cleanly.

### Mode B — Multi-Requirement Backlog Waves
1. Click **Cut a release**, enter `vX.Y.Z`, and list **one remaining feature/fix requirement per line**.
2. `planMilestoneWaves` schedules non-overlapping requirements concurrently in Wave 1 and serializes overlapping paths into Wave 2+.
3. Choose `direct_main` (default) or `milestone_branch` (`super-work milestone create --integration milestone_branch` — merges all items onto `super-work/milestone/<id>` with zero mid-flight sign-offs). Once every item delivers, the same **`Milestone Ready`** card appears on Home for 1-click release.

---

## 6. Developer Engine Room: Memory, Evals, Backups & Operations

Open **Settings → Developer / Engine Room** (or press `⌘K` / `Ctrl+K`):

1. **Contract & Gates**: Sync or export team-shared `super-work.json` (`verificationCommands`, `setupCommands`, `forbiddenPaths`, `conventions`, `deliveryGatePolicy`, `riskThreshold`, `sensitivePaths`, `smokeCheck` + headless CDP `browserCheck`, and `pre_deliver` / `post_deliver` / `on_escalate` lifecycle hooks).
2. **Memory (Playbook & Casebook)**:
   - Curate reusable **Playbook** rules (inbox resolution notes only enter the Playbook on explicit `saveToPlaybook: true` opt-in and pass anti-noise hygiene checks).
   - Search **Casebook** episodic history or export/import portable JSON **Knowledge Bundles** (`super-work bundle export/import`).
3. **Automation**: Manage **Scheduled Patrols** (Probe-to-Promote routines with active-hour windows) and **Goal Campaigns** (metric sparklines, wave history, pause/resume/deliver).
4. **Operations**: Inspect/GC **Worktrees**, flush or eject slots in the **Speculative Merge Train**, **Simulate Triggers**, or check OS `launchd` / `systemd --user` daemon status.
5. **Observability & Health**:
   - **Flight Recorder**: Inspect 24h / 7d / All-time KPIs (delivery rate, scoped + reused gate time saved, Boot Canary reloads/rollbacks, Watchdog switches/extensions, flake retries) and copy EN/ZH Markdown digests (`super-work digest --hours 24 --markdown`).
   - **Engine Circuit Breaker**: View engine health; transient failures cool down for 15 min while persistent quota/auth/model errors trip for 24 h with 1-click **Reset** / **Re-probe**.
   - **System Doctor & SQLite Hot Backups**: Run integrity, worktree, preview, Playbook hygiene (`Disable Noisy Rules`), and **Codebase Hotspot Radar (`> 1,500` lines → 1-click Spawn Safe-Refactor)** checks; create zero-lock `VACUUM INTO` backups and run verified **Atomic Hot Restore** (`pre-restore` safety backup automatic).
   - **Golden Eval Suite**: Replay saved benchmark tickets across multiple engines inside isolated `eval-worktrees/` with zero impact on live state.

---

## 7. CLI & MCP Reference

```bash
# Core daily flow
super-work do "<requirement>" [--preview] [--wait] [--milestone vX.Y.Z]
super-work status
super-work watch [--repo <repoId>] [--ticket <ticketId>]
super-work logs <ticketId> [-f]

# Human decisions & live control
super-work inbox [list | approve <id> | reject <id> | batch --low-risk --approve]
super-work steer <ticketId> "<instruction>" [--engine <engine>]
super-work ask "<question about queue, blockers, or codebase>"
super-work revert <ticketId>

# Milestones, campaigns & merge train
super-work milestone [list | create --name <n> --version <v> [reqs...] | show <id> | release <id> --bump --squash --tag --push [--github-release]]
super-work campaign [list | start <id> | pause <id> | deliver <id>]
super-work train [list | flush | eject <entryId>]

# Governance, diagnostics, daemon & MCP
super-work playbook [list | add "<rule>" | audit | prune [--delete] | sync [--export]]
super-work doctor [--fix] [--prune-playbooks]
super-work backup [list | create | restore <backupId>]
super-work eval [list | save <ticketId> | run <caseId> --engines claude,codex]
super-work reload [--skip-canary] [--force]
super-work up [-d] [--host 127.0.0.1] [--port 4318]
super-work service [install | uninstall | start | stop | status | logs]
super-work mcp
```

---

## 8. Concurrency Best Practices & FAQ

1. **How do multiple Workers run in parallel without stepping on each other?**
   Pin disjoint `scope:<glob>` paths (e.g. `scope:packages/core/**` and `scope:packages/web/**`). Disjoint scopes execute concurrently in separate `git worktree` directories; overlapping scopes serialize automatically via `waiting_deps` (`dependsOn`).
2. **Why does dispatch say `Repository has no commits (unborn HEAD)`?**
   `git worktree add` requires at least one commit on your base branch. Run `git commit --allow-empty -m "chore: init"` (or commit your initial files) first.
3. **A CLI engine shows `Not Ready` / `Not Logged In` — how do I fix it?**
   Sign in locally (`claude auth login`, `codex login`, `gemini`, or `gh auth login`), then click **Rescan CLI** in **Settings → Models & Roles** — or add an API model profile (`DeepSeek` / `OpenAI` / `Anthropic` / `Ollama`) directly in the same panel.
4. **Where are SQLite databases, worktrees, and logs stored?**
   Everything lives under `.super-work/` (or `SUPER_WORK_DATA_DIR`), which is git-ignored. Terminal worktrees are reclaimed automatically when `Auto-reclaim Worktree` is enabled, while branch commits and Spill diffs remain viewable in History.
