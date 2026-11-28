[English](./ARCHITECTURE.md) | [简体中文](./ARCHITECTURE.zh-CN.md)

# `super-work` Architecture & Core Contracts

Grounded in the design principles of DeepSeek Harness team's *"Exploring Super-agent Design: Towards a More Autonomous Agent System"*, this document specifies the layered architecture, state machine transitions, and hexagonal contracts of `super-work`.

> **Design Principle**: The primary bottleneck is **human attention bandwidth**, not single-turn LLM capability. `super-work` decouples persistent lightweight triage/supervision from isolated coding execution, ensuring external side effects are strictly gated through an idempotent `Transactional Outbox`.

---

## 1. System Overview

```mermaid
flowchart TB
    subgraph Sources["Event Sources"]
        WebInput["Local Web Command Center"]
        GhPoller["GhCliPollingSource (gh CLI)"]
        ExtHook["Future Adapters (Webhooks / IM Bots)"]
    end

    subgraph ControlPlane["Control Plane (@super-work/core)"]
        Intake["EventIntakeRouter & Thread Subscriptions"]
        Assessor["MasterAssessor (ControlPlaneLLM)"]
        Scheduler["SuperWorkKernel & Stage Pipeline"]
        Watchdog["TwoTierWatchdog (L1 Probes + L2 Diagnosis)"]
        Outbox["OutboxProcessor (Transactional Outbox)"]
    end

    subgraph MemoryState["State & Tiered Memory"]
        SQLite["SqliteStateStore (bun:sqlite WAL + FTS5)"]
        SpillStore["FsArtifactStore (Spill Blobs)"]
    end

    subgraph DataPlane["Isolated Execution Plane (@super-work/drivers)"]
        MandateGuard["Mandate Guardrails & GitWorktreeProvider"]
        Claude["ClaudeCodeDriver"]
        Codex["CodexDriver"]
        OpenCode["OpenCodeDriver"]
        Gemini["GeminiCliDriver"]
        Mock["MockWorkerDriver"]
    end

    Sources --> Intake
    Intake -->|"New thread"| Assessor
    Intake -->|"Subscribed thread"| Scheduler
    Assessor -->|"Ticket + Mandate"| Scheduler
    Scheduler <--> SQLite
    Scheduler <--> SpillStore
    Scheduler --> MandateGuard
    MandateGuard --> Claude
    MandateGuard --> Codex
    MandateGuard --> OpenCode
    MandateGuard --> Gemini
    MandateGuard --> Mock
    Watchdog -.->|"Stream & Diff health checks"| MandateGuard
    Watchdog -.->|"Hint / Switch Engine / Escalate"| Scheduler
    Scheduler -->|"After clean Rebase"| Outbox
    Outbox -->|"Idempotent Push / PR / Comment"| GhPoller
```

---

## 2. Ticket Stage Pipeline State Machine

```mermaid
stateDiagram-v2
    [*] --> triaging: Trigger ingested
    triaging --> proposed: observe mode
    proposed --> queued: Inbox approved
    triaging --> queued: auto mode (no overlap)
    triaging --> waiting_deps: auto mode (overlapping Mandate)

    waiting_deps --> queued: Dependencies delivered
    waiting_deps --> needs_human: Dependency failed/cancelled

    queued --> planning: standard / strict template
    queued --> implementing: fast template

    planning --> awaiting_plan_approval: strict template gate
    awaiting_plan_approval --> queued: Plan approved (next stage implement)
    planning --> queued: standard template (next stage implement)

    implementing --> queued: Mandate diff ok -> review or rebase
    implementing --> needs_human: Mandate violation reverted
    implementing --> queued: Watchdog INJECT_HINT or SWITCH_ENGINE
    implementing --> needs_human: Watchdog ESCALATE_HUMAN

    reviewing --> queued: Approved -> rebase
    reviewing --> queued: Rejected -> implement with feedback
    reviewing --> needs_human: Review retries exhausted

    rebasing --> outbox_pending: Rebase clean -> enqueue Outbox
    rebasing --> queued: Conflict -> implement self-heal
    rebasing --> needs_human: Conflict retries exhausted

    needs_human --> queued: Human approval / Thread follow-up
    outbox_pending --> delivered: OutboxExecutor succeeded
    delivered --> [*]
```

---

## 3. Core Contracts & Mechanisms

### 3.1 `Mandate` & Concurrency Scope Governance
Defined in [mandate.ts](./packages/core/src/mandate.ts):
- **Immutable Scope**: Each `Ticket` receives a `Mandate` specifying `allowedPaths`, `forbiddenPaths` (always merging `DEFAULT_FORBIDDEN_PATHS`: `.env`, `.env.*`, `**/.env`, `**/.env.*`, `**/*.pem`, `**/*.key`), `allowNetwork`, `allowExternalSideEffects: false`, `maxCostUsd`, `maxDurationSec`, and `maxStageRetries`.
- **Pre-dispatch Serialization**: `mandateScopesOverlap(a, b)` checks wildcard and directory-prefix intersections against active non-terminal tickets in the same repository. Overlapping tickets automatically enter `dependsOn` (`waiting_deps`); disjoint scopes run concurrently in separate worktrees.
- **Dual Guardrails**:
  - **Pre-turn**: Worker drivers map stage permissions to CLI flags (`plan` / `review` run in read-only/plan mode; `implement` blocks `Bash(git push*)`, `Bash(gh pr *)`, `Bash(gh issue *)`).
  - **Post-turn**: `validateChangedFilesAgainstMandate(...)` inspects `GitWorktreeProvider.getChangedFiles(...)`. Violations are reverted via `revertPaths(...)` and escalated as `mandate_violation` items in the Attention Inbox.

### 3.2 Unified `WorkerDriver` & Cross-Engine Handover
Defined in [ports.ts](./packages/core/src/ports.ts) and implemented in `packages/drivers/src/workers/`:
- All worker drivers emit normalized `WorkerStreamEvent` streams (`session_started`, `thought`, `tool_use`, `tool_result`, `text`, `usage`, `completed`, `error`).
- **Same-engine resume**: Captures `nativeSessions[engine]` (`session_id` for `ClaudeCodeDriver`, `thread_id` for `CodexDriver`, `sessionID` for `OpenCodeDriver`) and resumes via `--resume` / `exec resume` / `--session`.
- **Cross-engine handover**: Between stages (e.g., `ClaudeCodeDriver` for `implement` → `CodexDriver` or `OpenCodeDriver` for `review`) or after a `SWITCH_ENGINE` recovery, `MemoryManager` synthesizes concise `InlineMemory` handover notes without leaking giant raw transcripts into the next model's context window.

### 3.3 `Inline & Spill` + `Chain of Recall`
Implemented in [memory.ts](./packages/core/src/memory.ts), [sqlite-state-store.ts](./packages/drivers/src/storage/sqlite-state-store.ts), and [fs-artifact-store.ts](./packages/drivers/src/storage/fs-artifact-store.ts):
- **Inline**: Compact `goal`, `acceptanceCriteria`, `planSummary`, `stageNotes`, `threadUpdates`, and `activeHint` stored on the `Ticket`.
- **Spill**: Full JSONL worker transcripts and unified `git diff` patches persisted as files under `<dataDir>/artifacts/<ticketId>/` and metadata-linked in SQLite `artifacts`.
- **Chain of Recall**: `SqliteStateStore.recallChain(ticketId)` reconstructs `Trigger -> Thread -> Ticket -> StageRuns -> SpillArtifacts`, augmented by sanitized `bun:sqlite` FTS5 search (`tokenizeFtsQuery`) across past tickets and stage notes.

### 3.4 Two-Tier `Watchdog`
Implemented in [watchdog.ts](./packages/core/src/watchdog.ts):
- **L1 Deterministic Probes (Zero LLM Cost)**: Detects `hard_budget_exceeded` (cost/duration ceiling), `repeated_error` (`>= 3` consecutive normalized error signatures), `diff_oscillation` (`A -> B -> A` worktree diff hash cycles), `silence_timeout`, and `budget_burn` (`>= 80%` cost spent with zero file edits).
- **L2 Semantic Diagnosis**: Invoked only upon an L1 `WatchdogSignal` (and within `maxStageRetries`). `ControlPlaneLLM.diagnoseWatchdog(...)` returns `CONTINUE`, `INJECT_HINT`, `SWITCH_ENGINE`, or `ESCALATE_HUMAN`.

### 3.5 `Transactional Outbox` & Rebase Gate
Implemented in [outbox.ts](./packages/core/src/outbox.ts) and [gh-cli-source.ts](./packages/drivers/src/sources/gh-cli-source.ts):
- Before delivery, `SuperWorkKernel` runs `GitWorktreeProvider.rebaseOntoBase(...)`. Merge conflicts trigger a self-heal `implement` retry or a `merge_conflict` Inbox item.
- Clean rebases enqueue an idempotent `OutboxEntry` (`idempotency_key` unique constraint in SQLite WAL). `OutboxProcessor.processDueEntries()` atomically claims due rows via `claimNextOutboxEntries` and executes `GhOutboxExecutor` (pushing & opening a GitHub PR when remote + `gh` are configured, or recording local branch readiness for local-only repos).
- **Worktree Lifecycle & GC**: When `repo.autoCleanupWorktree` is enabled (default), terminal `delivered` and `cancelled` tickets automatically reclaim their isolated worktree directory while retaining branch commits (`GET /api/tickets/:id` resolves diffs cleanly across Live Worktree → Branch Diff → Spill `diff` artifact). Stale or orphan directories can also be inspected and reclaimed via `/api/worktrees/gc`.
- **Deterministic Verification Gate**: When `repo.verificationCommands` is configured, `SuperWorkKernel` runs every command inside the worktree after `implement` and `rebase`, persisting full output as a `test_log` Spill artifact and emitting `verification_completed`. Failures automatically re-queue `implement` with diagnostic context or escalate after `maxStageRetries`.
- **Dual-Channel Delivery & Unified Epic Staging (`v0.4.0`)**: Epics default to a unified staging branch `super-work/epic/<epicId>` (with optional `per_subtask` fallback). After all subtasks merge into the staging branch, `finalizeUnifiedEpic` runs a final base-branch rebase and global verification gate (with 1 auto-fixup retry round) before opening a single consolidated PR or atomic `local_merge`.
- **Crash Recovery & Graded Mandate Expansion**: `SuperWorkKernel.recoverInterruptedRuns()` recovers orphaned active tickets and `processing` outbox entries without losing worktree state, `nativeSessions`, or `stageRetries`; `validateChangedFilesAgainstMandate` separates `forbiddenViolations` (reverted immediately) from `scopeViolations` (preserved pending Inbox `expandMandate` approval without re-running the worker).
- **PR Follow-up Loop, Repo Quotas & CLI**: `GhCliPollingSource` ingests PR reviews and `gh run view --log-failed` outputs while skipping `[super-work]` comments, triggering same-branch incremental updates (`GhOutboxExecutor`, capped at 3 rounds); `tick()` enforces per-repo `maxConcurrentWorkers` and soft `dailyBudgetUsd` caps alongside `/api/metrics` and `@super-work/cli`.
- **Repo Contracts (`super-work.json`), Self-Evolving Playbook & Worktree Warmup (`v0.5.0`)**: `GitWorktreeProvider.loadRepoContract` / `writeRepoContract` syncs shared engineering settings (`verificationCommands`, `setupCommands`, `forbiddenPaths`, `conventions`, shared `playbook`) from `super-work.json` while isolating personal runtime knobs in SQLite; `prepareWorkspace` executes `setupCommands` cleanly on fresh worktrees; closed-loop post-failure deliveries (`maybeDistillClosedLoopLesson`) and Inbox resolution notes (`distillHumanNoteToRule`) populate `playbook_entries` (`formatPlaybookContext` caps prompt injection at Top 8 rules / `<= 1200` chars).
- **Structured Adversarial Review, Safe `--no-ff` Revert & High-Signal Push**: `selectReviewEngine` prefers heterogeneous real engines (never falling back to `mock` for real code); `parseReviewReport` enforces `blocker`/`major` rework thresholds while passing `nit`-only reviews with persisted JSON `review_report` artifacts; `local_merge` uses `--no-ff` and records `mergedCommitSha` for non-destructive `git revert -m 1` via `revertMergedCommit`; `NotificationDispatcher` filters low-signal churn and delivers Inbox/delivery/failure alerts to macOS desktop notifications and Feishu/Slack/Discord/HMAC-signed Webhooks alongside `SUPER_WORK_TOKEN`-protected filtered `/api/events`.

### 3.6 `v1.0.0` GA Reliability, Code Review & Modularization Upgrades
- **Kernel Modularization (`packages/core/src/kernel/*`)**: Orchestration subdomains (Routines, Arena Duel, Adaptive Epic Replan, Stage Checkpoints & DAG Mutation, Line Review Comments, System Doctor & SQLite Hot Backups, and `SpanRecorder`) are decomposed into clean coordinator modules behind `KernelCoordinatorContext`, preserving 100% compatibility on `SuperWorkKernel`.
- **Confidence-Scored Delivery Risk Gate ([risk.ts](./packages/core/src/risk.ts))**: `evaluateTicketRisk(...)` scores `0–100` from diff lines, file spread, `sensitivePaths`, symbol fanout, visual pixel delta, retries/conflict history, minus verified TDD/static/smoke/review confidence deductions. Under `deliveryGatePolicy: "risk_gated"`, scores exceeding `riskThreshold` (default `35`) hold delivery in `outbox_signoff` (`"always_auto"` remains the non-breaking default).
- **Line-Anchored Review Studio ([review-comments-coordinator.ts](./packages/core/src/kernel/review-comments-coordinator.ts))**: Synchronizes AI `ReviewFinding` records into SQLite `ticket_review_comments`, accepts multi-line human baskets (`comment_only` vs `request_changes` rewinding to `implement`), and automatically marks open comments `resolved` when the subsequent `implement` pass modifies those files and clears verification.
- **3-Way Semantic Rebase Conflict Resolver ([conflict-resolver.ts](./packages/core/src/conflict-resolver.ts))**: Upon rebase conflicts, saves a `pre_rebase_conflict` hidden checkpoint, prepares a clean lockfile-free 3-way conflict workspace via `GitWorktreeProvider.prepareThreeWayConflictWorkspace`, runs at most 1 bounded resolution turn honoring `lockedTestPaths` + Mandate, verifies static/smoke gates, and rolls back to the checkpoint with full `ConflictSemanticContext` Inbox escalation if checks fail.
- **Stage Spans, System Doctor, Hot Backup & Composable Blueprints ([blueprints.ts](./packages/core/src/blueprints.ts))**: Records inline `StageSpan[]` waterfalls per `StageRun`; runs `SystemDoctor` diagnostics & cleanup across SQLite integrity, orphan worktrees, expired previews, and stale checkpoint Git refs alongside `VACUUM INTO` hot backups; resolves 5 built-in + custom `super-work.json` Task Blueprints under strict `explicit > blueprint > repo` precedence.

### 3.7 `v1.1.0` Agentic Control Plane, Live Steer & Golden Eval Platform
- **Hybrid Read-Only Control Plane Probing ([readonly-repo-prober.ts](./packages/drivers/src/workspace/readonly-repo-prober.ts))**: Pairs Layer 1 `<50ms` deterministic symbol/slice/git pre-probes (`HeuristicControlLLM` compatible) with a bounded 2-round Layer 2 read-only tool loop (`search_symbols`, `read_file_slice`, `grep_literals`, `git_recent_commits`) on `SpecStudio`, `EpicPlanner`, `Watchdog L2`, and path-ambiguous `triageTrigger`. All probe targets are strictly jailed to `repo.rootPath` via `isProbePathAllowed` + `realpath`, blocking `forbiddenPaths`, `.env*`, `*.pem`, and `*.key`.
- **Chief-of-Staff Omnibox & Batch Triage ([chief.ts](./packages/core/src/chief.ts))**: `runChiefOfStaffQuery` (`POST /api/chief/ask`, `super-work ask`) answers cross-repo operational questions from live tickets, metrics, FTS5 recall, and codebase probes while returning confirmation-gated `ChiefActionSuggestion[]` (never mutating automatically). Attention Inbox & `POST /api/inbox/batch-resolve` support multi-select & `Select Low-Risk` triage.
- **Mid-Turn Live Steer, Worker `[ASK_HUMAN]` & Tool Profiler ([tool-profiler.ts](./packages/core/src/tool-profiler.ts))**: `steerTicket(...)` aborts an in-flight turn via `abort("live_steer")` without incrementing `stageRetries` or polluting `failedEngines`, preserves the worktree and `nativeSessions`, prepends `[LIVE STEER]` to `activeHint`, and resumes smoothly. `extractWorkerClarificationRequest(...)` pauses on structured `[ASK_HUMAN]` blocks (max 1 per ticket) into `clarification_request` Inbox cards—or auto-adopts `recommendedOption` in `auto` mode. `buildStageToolProfile(...)` computes zero-LLM tool frequency, errors, and FIFO-matched latency per `StageRun`.
- **Golden Eval Suite, Atomic Backup Restore & Knowledge Bundles ([eval-coordinator.ts](./packages/core/src/kernel/eval-coordinator.ts), [knowledge-bundle-coordinator.ts](./packages/core/src/kernel/knowledge-bundle-coordinator.ts))**: `eval_cases` and `eval_runs` replay delivered tasks across multiple engines inside detached `<dataDir>/eval-worktrees/` directories with automatic `finally` cleanup and zero side effects on live tables. `SqliteStateStore.restoreFromBackup(...)` guards active runs, validates target snapshots via `PRAGMA quick_check`, creates an automatic `pre-restore` snapshot, swaps the DB file (cleaning `-wal`/`-shm`), and re-runs idempotent migrations. Repo Knowledge Bundles export/import Playbook + Casebook + Blueprints JSON cleanly; MCP upgrades to `1.1.0` with **19 tools**.

### 3.8 `v1.2.0` Goal Campaigns, Speculative Merge Train, Daemon Service & Lifecycle Contract Hardening
- **3-Layer Structural Split ([sqlite-schema.ts](./packages/drivers/src/storage/sqlite-schema.ts), [sqlite-mappers.ts](./packages/drivers/src/storage/sqlite-mappers.ts), [kernel.ts](./packages/core/src/kernel.ts), [app.ts](./packages/server/src/app.ts))**: Extracts SQLite DDL & row mapping out of `sqlite-state-store.ts`, separates core runtime coordinators into focused `kernel/*` modules (`campaign-coordinator.ts`, `merge-train-coordinator.ts`, `lifecycle-hooks.ts`, `contract-playbook-coordinator.ts`, `epic-lifecycle-coordinator.ts`, `inbox-resolution-coordinator.ts`, `stage-execution-coordinator.ts`), and groups Hono REST/MCP/webhook handlers into `packages/server/src/routes/*`.
- **Metric-Driven `GoalCampaign` ([campaign.ts](./packages/core/src/campaign.ts), [campaign-coordinator.ts](./packages/core/src/kernel/campaign-coordinator.ts))**: Benchmarks initial baseline metrics at `targetRef` via detached `metric-worktrees/`, dispatches sequential autonomous optimization waves onto an isolated `staging_branch` (`super-work/campaign/<id>`) or `per_wave_merge`, parses deterministic numeric output, executes **monotonic regression rollback** (`resetBranchRef`) on regressions/failures while logging pitfall lessons, and trips a 2-wave plateau / budget / max-iteration fuse into `campaign_paused` Inbox approval.
- **Speculative Parallel Merge Train & Cross-Repo Barrier ([merge-train.ts](./packages/core/src/merge-train.ts), [merge-train-coordinator.ts](./packages/core/src/kernel/merge-train-coordinator.ts))**: Evaluates `local_merge` deliveries under repo locks. Single-entry queues matching unchanged `baseBranch` HEAD with no pending barrier take `Smart-Bypass` zero-overhead fast path; larger queues build cumulative `--no-ff` slots (max 3) inside `train-worktrees/`, fast-forwarding `baseBranch` once to the deepest passing prefix while preserving individual merge SHAs so single-ticket `git revert -m 1` stays intact, bisecting/ejecting the first failing slot (`evaluateSpeculativePrefix`). Multi-repo Epics default to `barrierGroupId` (`releaseBarrier`), eagerly persisting `HandoverDigest` upon entering `barrier_waiting` so downstream cross-repo siblings avoid deadlocks.
- **Deterministic Hooks, Immutable `super-work.json` & `ServiceManager` ([lifecycle-hooks.ts](./packages/core/src/kernel/lifecycle-hooks.ts), [service-manager.ts](./packages/drivers/src/env/service-manager.ts))**: Enforces `IMMUTABLE_REPO_PATHS` (`super-work.json`, `**/super-work.json`) as OS-sandbox read-only (`readOnlyPaths`) and auto-reverted `forbiddenViolations` (`canExpandMandate: false`); executes blocking `pre_deliver` and non-blocking `post_deliver` / `on_escalate` hooks using `buildSanitizedWorkerEnv` (`SUPER_WORK_HOOK_*`); provides zero-dep `launchd` / `systemd --user` service units with `127.0.0.1` loopback guard, `10 MB` log rotation, and **21 MCP tools (`1.2.0`)**.

### 3.15 `v1.8.1` Unified Peer Model Pool & Role Binding
- **Peer `ModelProfile` registry**: CLI (`cliEngine`: claude / codex / opencode / gemini) and API (`apiProtocol`: deepseek / openai / anthropic / ollama) models share one `ModelProfile` shape in `SystemSetupConfig.modelProfiles`. Three role bindings (`controlModelId` = `heuristic` | id, `implementModelId` / `reviewModelId` = `auto` | id) select among them; `normalizeSystemSetupConfig` resolves dangling ids to `heuristic` / `auto`. Built-in CLI profiles carry `builtinCli: true`.
- **Delete semantics** ([setup-system-routes.ts](./packages/server/src/routes/setup-system-routes.ts), [setup-worker-helpers.ts](./packages/server/src/routes/setup-worker-helpers.ts)): `POST /api/setup/configure` accepts `deleteModelProfileIds`. `applyProfileDeletions` removes custom profiles (unknown ids are ignored, so deletes are idempotent) and throws `SetupValidationError` (HTTP 400) for `builtinCli` profiles before anything is persisted. Roles that referenced a deleted id fall back to `heuristic` / `auto`, and repos pinning it get `implementModelId` / `reviewModelId` reset to `auto` independently of `syncRepos`. Binding a role to an id deleted in the same request is rejected.
- **`ModelRegistryStudio`** ([ModelRegistryStudio.tsx](./packages/web/src/components/setup/ModelRegistryStudio.tsx), [ModelProfileCard.tsx](./packages/web/src/components/setup/ModelProfileCard.tsx), [ModelProfileForm.tsx](./packages/web/src/components/setup/ModelProfileForm.tsx), [modelTemplates.ts](./packages/web/src/components/setup/modelTemplates.ts)): the single two-stage UI (① Model Pool cards with Auto Pool switch, `POST /api/setup/test-model`, inline edit and 2-step delete, 8 equal add-templates; ② three role selectors listing only `ready` profiles) embedded in Settings → *Models & Roles* and reused by `CustomizeSetupForm` / `SetupWizardModal`. Role changes call `configureSetup` (plus `patchRepo` for the selected repo) and never clobber `auto`.
- **Per-task model pinning**: `HeroComposer` (*Options → Model*) and the DeepDive `SteerBar` pick from ready profiles and send `preferredModelId` (`preferredEngine: "auto"` clears a pin); the Web only imports types from `@super-work/core/types`.
- **Foundations (earlier in v1.8.1)**:
- **`ApiWorkerDriver` (`api` engine)**: native agent worker over DeepSeek / OpenAI-compatible / Anthropic-compatible HTTP APIs; its tool loop is jailed to the ticket worktree. `WorkerEngineId` gains `"api"`, configured by `apiWorkerProfile` (`preset`, `baseUrl`, `model`, `effort`, `apiKey`).
- **CLI relay injection**: `claudeProfile` / `codexProfile` / `opencodeProfile` / `geminiProfile` accept an optional `baseUrl` + `apiKey`, injected per invocation as `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `GOOGLE_GEMINI_BASE_URL`. Raw keys are persisted server-side only; `GET /api/setup/status` exposes `hasApiKey` + `maskedApiKey` (`PublicEngineProfile`), and `clearApiKey` removes a saved key.
- **`POST /api/setup/test-worker`** ([setup-system-routes.ts](./packages/server/src/routes/setup-system-routes.ts)): tests an API preset or CLI relay and returns `{ ok, latencyMs, message }`; a saved key is used only when `useSavedKey` is set.
- **`syncRepos`**: `persistSetupConfig(nextConfig, syncRepos = true)` only overwrites each repo's `preferredImplementEngine` / `preferredReviewEngine` when `syncRepos !== false`, so saving credentials or notifications keeps a repo on `auto`.
- **Versioning**: workspace packages, `GET /api/mcp` and the JSON-RPC `initialize` `serverInfo.version` report `1.8.1` (27 tools); Web badge `v1.8.1`.

### 3.14 `v1.8.0` Super-Agent First — Consumer Surface, Pro Engine
- **Layering**: the Web UI is a thin *consumer surface* (Home / History / Settings, 1-row 4-item HeaderBar, streamlined DeepDiveDrawer with a permanent Steer bar) over the unchanged engine; advanced capabilities live in the collapsible Settings → Developer / Engine Room. No kernel contract changed.
- **`AutonomyPreset`** ([autonomy-preset.ts](./packages/core/src/autonomy-preset.ts)): `guarded` (`always_signoff`) / `smart` (`risk_gated`, threshold 35) / `autonomous` (`always_auto`) — *Guarded / Smart / Autonomous*, all with `mode: auto`, `sandboxMode: balanced`, `smart_tiered` verification. Expanded by `POST /api/repos` and `PATCH /api/repos/:id` via `getAutonomyPresetPatch`; explicit fields always win, and automatic re-syncs never overwrite user PATCH overrides. `normalizeAutonomyPreset` is the single input gate (REST bodies, `.super-work.json` contracts): it accepts canonical names and maps the legacy aliases `copilot` / `standard` / `autopilot` to `guarded` / `smart` / `autonomous`, so existing DB rows and contracts keep working without migration. `inferAutonomyPreset` derives the dial position for repos with no stored preset. The Web mirrors these helpers browser-purely in `utils/superAgent.ts` (type-only imports from core); the dial is rendered in the Hero Composer's context toolbar, below the single-bar HeaderBar.
- **Zero-config onboarding**: `POST /api/setup/quick-start` ([setup-system-routes.ts](./packages/server/src/routes/setup-system-routes.ts)) scans CLIs and selects `claude_cli` → `codex_cli` → `heuristic`; `POST /api/repos/detect` ([repo-routes.ts](./packages/server/src/routes/repo-routes.ts), `detectRepoDefaults` in [repo-autodetect.ts](./packages/core/src/repo-autodetect.ts)) is read-only and returns name, base branch, stack label (bun / node / rust / python / go), verification commands, `smart_tiered` strategy and `standard` preset.
- **Human verb taxonomy**: `classifyInboxHumanAction` ([inbox-taxonomy.ts](./packages/core/src/inbox-taxonomy.ts)) maps every inbox kind to `approve` / `answer` / `unblock`; the Web keeps a browser-pure mirror in `utils/superAgent.ts` (type-only core imports) together with `humanTicketPhase`, `formatScopeTokens` / `withScopeTokens` (explicit `scope:<glob>` tokens parsed by `extractScopeTags` in `intake.ts` into `mandate.allowedPaths`).
- **CLI**: `super-work do "<requirement>" [--preview] [--wait] [--milestone <vX.Y.Z>]` is the primary verb over `POST /api/intake` (`previewOnly` for `--preview`).
- **Versioning**: workspace packages, `GET /api/mcp` and the JSON-RPC `initialize` `serverInfo.version` ([mcp-protocol.ts](./packages/core/src/mcp-protocol.ts)) reported `1.8.0` at that release (27 tools; superseded by `1.8.1`, see §3.15); Web badge was `v1.8`.

### 3.13 `v1.7.0` Resilience & Watchdog 2.0 Observability (Wave 2)
- **Tiered Circuit Breaker**: `isPersistentEngineFailure` / `getCooldownMsForFailureKind` ([engine-health.ts](./packages/core/src/engine-health.ts)) — transient 15 min, persistent 24 h. Web mirrors the predicate locally in `DoctorBackupPanel.tsx` (no core runtime import) to render the *persistent trip* vs *temporary cooldown* badge.
- **Watchdog 2.0 / Flake Retry KPIs**: `buildRunDigestReport` ([digest.ts](./packages/core/src/digest.ts)) adds `resilience.watchdogExtensions` (`watchdog_extended`) and `resilience.flakeRetries` (`flake_retried`) only when non-zero, so existing `toEqual` consumers are unaffected; Markdown (zh/en) adds a line per non-zero counter. Flight Recorder shows both beside Watchdog switches.
- **Type-only subpath**: `@super-work/core` exports `./types` (`./src/types.ts`); `@super-work/web` declares core as a `workspace:*` devDependency (prep for Wave 3 type deduplication). The impact planner keeps resolving `core → web` through `workspace:*`.
- **Also in v1.7.0**: Milestone Boot Canary, Flake Retry, Safe-Refactor concurrent scheduling + auto RefactorGuard, Adaptive Watchdog 2.0 (Wave 1). MCP `1.7.0` (27 tools), CLI `v1.7.0`, Web badge `v1.7`.

### 3.12 `v1.6.0` Playbook Hygiene, Flight Recorder KPIs & Optional GitHub Release (Wave 2)
- **Hygiene evaluator ([playbook-hygiene.ts](./packages/core/src/playbook-hygiene.ts))**: zero-dependency `evaluatePlaybookRuleHygiene(rule, source?, { pinned? })` flags one-off approval / continuation / ticket-run notes (case-insensitive patterns, ticket-id regex, short status-report approvals without constraint verbs) and never flags `repo_contract` or pinned rules; `auditPlaybookEntries` builds a `PlaybookHygieneReport`.
- **Inbox opt-in**: `resolveInboxItemOp` persists a note to the Playbook only when `saveToPlaybook === true` **and** the note passes hygiene; noisy notes are skipped without failing the resolution.
- **Governance**: `Kernel.auditPlaybookHygiene` / `pruneNoisyPlaybooks` ([contract-playbook-coordinator.ts](./packages/core/src/kernel/contract-playbook-coordinator.ts)); default mode `disable` (`enabled:false`, `suspect:true`), `delete` removes the entry, `dryRun` only reports. `runSystemDoctor` ([doctor-backup-coordinator.ts](./packages/core/src/kernel/doctor-backup-coordinator.ts)) adds a `playbook_hygiene` check (fix = disable). Surfaces: REST `GET /api/playbooks/hygiene`, `POST /api/playbooks/hygiene/prune`; CLI `playbook audit|prune [--delete]`, `doctor --prune-playbooks`; MCP `manage_playbook_hygiene`; Web Doctor card.
- **Flight Recorder**: `RunDigestReport.gateReuse` (from `gate_reused`) and `resilience` (`engine_tripped`, `spillover_quarantined`); the Markdown adds a reuse line only when reuse occurred. `classifyEngineError` treats `free usage limit` / `subscribe to opencode` as deterministic `quota_exhausted`.
- **Optional GitHub Release**: `executeMilestoneRelease` accepts `createGithubRelease`; it requires a version plus `createTag` and `pushRemote` and a passing `gh auth status`, all validated **before** any git mutation. After push it runs `gh release create v<version> --notes-file <tmp>` and returns `githubReleaseUrl` (transient, not persisted). A `gh` failure after push is reported without rolling back the pushed tag.
- **MCP `1.6.0` (27 tools)**: adds `manage_playbook_hygiene`; `manage_milestones` accepts `createGithubRelease`. Web badge `v1.6`.

### 3.11 `v1.5.0` Milestone Staging Branch & Clean Squash Release (Pillars A + B + C + D)
- **Staging ([milestone-coordinator.ts](./packages/core/src/kernel/milestone-coordinator.ts), [stage-execution-coordinator.ts](./packages/core/src/kernel/stage-execution-coordinator.ts))**: with `integrationMode: "milestone_branch"`, `createMilestoneOp` sets `stagingBranch = super-work/milestone/<id>`, creates it off `repo.baseBranch` via `WorkspaceProvider.ensureBranchExists`, and stamps `targetBranch` + `always_auto` gate policy (and `startPoint` for single tickets) on every item ticket/subtask. Delivery for tickets with `milestoneId` and a non-base `targetBranch` goes through `mergeWaveToTargetStagingBranch` (no Outbox, so no `outbox_signoff`), and the self-host Boot Canary is skipped because it only fires for merges into `repo.baseBranch`. `preferredRoute` is forwarded to Smart Intake preview.
- **Single signoff**: `syncMilestonesOp` moves the milestone to `ready_to_release` once all items are delivered and raises ONE `milestone_ready` Inbox item. `releaseMilestoneOp` forwards `stagingBranch`, `squashReleaseCommit` and `releaseCommitMessage` to `executeMilestoneRelease`.
- **Release ([git-worktree-provider.ts](./packages/drivers/src/workspace/git-worktree-provider.ts))**: refuses a dirty tracked tree, records `preReleaseSha`, merges the staging branch `--no-ff`, deletes it, optionally bumps `package.json` versions, and when squashing runs `reset --soft <preReleaseSha>` + one commit then verifies `HEAD^{tree}` is unchanged (restoring the previous HEAD and throwing otherwise). Tag only with `createTag`, push only with `pushRemote`.
- **Persistence**: `milestones.integration_mode` / `milestones.staging_branch` columns (additive `ensureColumn` migration); `tickets.target_branch` already existed.
- **MCP `1.5.0` (26 tools)**: adds `manage_engine_health` (`list|reset|probe`) and extends `manage_milestones` with `integrationMode`, `preferredRoute`, `squashReleaseCommit`, `releaseCommitMessage`. Web adds the staging badge, squash opt-in, selectors and a collapsible Released History archive.

### 3.10 `v1.4.0` Milestone Waves & Controlled Release (Pillars A + B + C + D)
- **Milestone coordinator ([milestone.ts](./packages/core/src/milestone.ts), [milestone-coordinator.ts](./packages/core/src/kernel/milestone-coordinator.ts))**: `createMilestoneOp` previews each requirement through Smart Intake, `planMilestoneWaves` computes topological `waveIndex`/`dependsOnIndices` from `allowedPaths` overlap, and items are dispatched with cross-wave `dependsOn` (items behind a goal campaign are dispatched lazily). `syncMilestonesOp` runs from the scheduler tick, maps ticket/epic/campaign status onto items and, once all are `delivered`, synthesizes bilingual release notes (`synthesizeMilestoneReleaseNotes` + `buildRunDigestReport`), records a `milestone_ready` FlightEvent and raises a `milestone_ready` Inbox item. `releaseMilestoneOp` is **explicit-only** (REST `POST /api/milestones/:id/release`, CLI, Inbox signoff) and delegates to `WorkspaceProvider.executeMilestoneRelease`, where version bump, annotated tag and push are independently opt-in.
- **Persistence ([sqlite-schema.ts](./packages/drivers/src/storage/sqlite-schema.ts), [git-worktree-provider.ts](./packages/drivers/src/workspace/git-worktree-provider.ts))**: new `milestones` table, `tickets.milestone_id` column migration, and `executeMilestoneRelease` (clean-tree guard, `chore(release): bump version to v<version>` commit on `baseBranch`).
- **Pillars A/C/D** (scoped verification gate, surgical symbol/line map + hotspot radar, SQLite Flight Recorder + Run Digest) feed the same release notes and digest telemetry. MCP `1.4.0` exposes **25 tools** (`manage_milestones`, `get_run_digest`); Web adds a lazy `MilestonePanel`, a Milestone dispatch tab and Inbox release-notes preview.

### 3.9 `v1.3.0` Self-Hosting Readiness, Smart Intake & `GeminiCliDriver`
- **Unified Smart Requirement Intake ([intake.ts](./packages/core/src/intake.ts), [router.ts](./packages/core/src/router.ts))**: Accepts raw natural-language requirements (`POST /api/intake`, `/api/intake/preview`, `super-work intake`, MCP `dispatch_requirement`), pairs `ReadOnlyRepoProber` context with `ControlPlaneLLM.planRequirementIntake` / deterministic `heuristicPlanRequirementIntake`, and routes cleanly into narrowed `single_ticket`, multi-package `epic_dag`, or metric-validated `goal_campaign`.
- **Self-Hosting Contract & Safe Boot Canary + Drain Reload ([self-host-coordinator.ts](./packages/core/src/kernel/self-host-coordinator.ts), [self-host-runner.ts](./packages/drivers/src/env/self-host-runner.ts), [scripts/dev.ts](./scripts/dev.ts))**: Syncs `defaultMode` and `defaultDeliveryChannel` from `super-work.json` at daemon startup. Whenever a non-doc-only `local_merge` lands on `selfRepoRoot` `baseBranch`, `BunSelfHostRunner` runs `bun run build` plus a cold-boot ephemeral canary server (`SUPER_WORK_CANARY_MODE=1`, probing `GET /api/health`); on pass, `SuperWorkKernel` stops dispatching new runs (`isDraining()`), waits for active runs/flushes to drain, checkpoints SQLite WAL (`PRAGMA wal_checkpoint(TRUNCATE)`), and exits with `RELOAD_EXIT_CODE = 75` for supervisor respawn (`scripts/dev.ts` / `launchd` / `systemd`). On failure, `handleSelfHostPostMergeOp` automatically `git revert`s the commit, keeps the live daemon healthy, and escalates a pending Inbox item.
- **Native 4-Engine Pool, Loopback Sandbox, Monorepo Symlinks & Non-Starving Outbox ([gemini-cli-driver.ts](./packages/drivers/src/workers/gemini-cli-driver.ts), [os-sandbox.ts](./packages/drivers/src/sandbox/os-sandbox.ts), [sqlite-state-store.ts](./packages/drivers/src/storage/sqlite-state-store.ts))**: Adds `GeminiCliDriver` (`-p -o stream-json --skip-trust --approval-mode plan|yolo`, buffered delta streaming), preserves `localhost:*` loopback in Seatbelt `balanced` mode (while locking down `strict`), mirrors monorepo `packages/*` into detached worktree `node_modules/`, cleans MergeTrain checkpoint refs upon delivery, eliminates Outbox `local_merge` barrier starvation via SQL `NOT IN` exclusions, and upgrades MCP to `1.3.0` with **23 tools**.
