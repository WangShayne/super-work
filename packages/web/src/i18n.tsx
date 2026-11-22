import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type {
  InboxItem,
  OutboxEntry,
  PipelineTemplateId,
  StageKind,
  TicketStatus,
  WorkerEngineId,
} from "./types.ts";

export type Locale = "zh" | "en";

const STORAGE_KEY = "super-work:locale";

const MESSAGES = {
  zh: {
    "app.title": "super-work · 超级智能体决策指挥舱",
    "brand.badge": "超级智能体系统",
    "brand.subtitle": "路由调度 · 执行池 · 看门狗 · 事务发件箱",
    "header.noRepo": "暂未注册仓库",
    "header.registerRepoTitle": "注册代码仓库",
    "header.repoSettingsTitle": "当前仓库偏好设置",
    "header.mode.off": "关闭",
    "header.mode.offDesc": "仅接收事件不派单",
    "header.mode.observe": "观察·需审批",
    "header.mode.observeDesc": "拟单入收件箱待批",
    "header.mode.auto": "自动·免审",
    "header.mode.autoDesc": "全自动调度执行",
    "header.sse.live": "实时流已连接",
    "header.sse.reconnecting": "重连中",
    "header.watchdog": "看门狗",
    "header.controlPlanePrefix": "控制面",
    "header.outboxPrefix": "发件箱",
    "header.simulateEvent": "模拟事件",
    "header.dispatchTask": "派发任务",
    "header.langButton": "中文 / EN",
    "header.langTitle": "切换界面语言 (中文 / English)",
    "header.settings": "环境与模型",
    "header.settingsTitle": "本机 CLI 扫描与控制面模型配置",

    "strip.sse.label": "实时同步",
    "strip.sse.live": "已连接",
    "strip.sse.reconnecting": "重连中",
    "strip.sse.desc": "通过 SSE 长连接实时推送任务阶段切换、Agent 终端流式输出与收件箱审批提醒。",
    "strip.llm.label": "总控大脑",
    "strip.llm.desc": "控制面大模型：负责评估新事件意图、划分允许修改范围（Mandate）及看门狗异常诊断。点击即可切换模型。",
    "strip.engines.label": "Agent 分工",
    "strip.engines.coding": "编码",
    "strip.engines.review": "审查",
    "strip.engines.availableSuffix": "引擎可用",
    "strip.engines.desc": "流水线中默认由「编码引擎」在独立工作树编写代码并自测，再交由「审查引擎」独立交叉 Code Review。点击即可调整分工。",
    "strip.engines.detectedPrefix": "本机可用执行器：",
    "strip.watchdog.label": "防卡死巡检",
    "strip.watchdog.guarding": "守护中",
    "strip.watchdog.runningSuffix": "运行中",
    "strip.watchdog.alertSuffix": "项需介入",
    "strip.watchdog.desc": "Watchdog 看门狗：自动监测任务静默超时、连续相同报错死循环或代码 Diff 反复横跳；异常时先自动注入纠偏或换引擎重试，无效则升级到收件箱由你裁决。",
    "strip.outbox.label": "PR 交付队列",
    "strip.outbox.pendingSuffix": "待推送",
    "strip.outbox.desc": "Transactional Outbox：禁止 Agent 私自 git push 或建 PR；所有对外交付动作统一在此事务队列校验并自动 Rebase 后幂等发送。",
    "strip.worktrees.label": "工作树池",
    "strip.worktrees.clean": "已净空",
    "strip.worktrees.activeSuffix": "占用",
    "strip.worktrees.reclaimableSuffix": "可回收",
    "strip.worktrees.desc": "隔离 git worktree 工作区运行池：交付/取消默认自动回收目录，也可点击查看并一键 GC 清理历史冗余 worktree（保留 Git 分支记录）。",

    "nav.inbox": "决策收件箱",
    "nav.board": "态势看板",
    "nav.plugins": "插件管理",

    "plugins.title": "插件管理",
    "plugins.refresh": "刷新",
    "plugins.loading": "加载中…",
    "plugins.empty": "暂无已加载的插件",
    "plugins.loadFailed": "加载插件失败",
    "plugins.enable": "启用",
    "plugins.disable": "禁用",
    "plugins.enabledOk": "插件已启用",
    "plugins.disabledOk": "插件已禁用",
    "plugins.actionFailed": "操作失败",
    "plugins.configure": "配置",
    "plugins.noConfig": "该插件没有可配置项",
    "plugins.config.title": "插件配置",
    "plugins.config.save": "保存",
    "plugins.config.saveEnable": "保存并启用",
    "plugins.config.saving": "保存中…",
    "plugins.config.savedOk": "配置已保存",
    "plugins.config.secretKeep": "已设置;更新配置时需重新输入",
    "plugins.config.secretRequired": "密钥字段需重新输入:",
    "plugins.config.required": "必填项缺失:",
    "plugins.config.invalidJson": "JSON 格式无效:",
    "plugins.config.invalidNumber": "数字格式无效:",
    "plugins.kind.driver": "驱动",
    "plugins.kind.trigger": "触发器",
    "plugins.kind.outbox": "发件箱",
    "plugins.kind.llm": "大模型",
    "plugins.kind.tool": "工具",
    "plugins.state.loaded": "已加载",
    "plugins.state.enabled": "已启用",
    "plugins.state.disabled": "已禁用",
    "plugins.state.failed": "失败",

    "inbox.title": "决策收件箱",
    "inbox.subtitle": "高信噪比人工授权队列。Worker 平时静默并发执行，仅在触发边界门禁、异常升级或交付签发时打扰你。",
    "inbox.pendingSuffix": "项待决",
    "inbox.emptyTitle": "注意力零阻塞",
    "inbox.emptyDesc": "当前没有待审批方案、看门狗升级告警或授权边界拦截。可切换至态势看板或直接派发新任务。",
    "inbox.inspectDeepDive": "查看详情抽屉 →",
    "inbox.notePlaceholder": "可选：填写给 Worker 的指导意见或打回修改要求...",
    "inbox.reject": "驳回",
    "inbox.approve": "批准并继续",
    "inbox.recentTitle": "近期决策记录",

    "board.lane.triage": "评估与拟单",
    "board.lane.queued": "排队与规划",
    "board.lane.implementing": "编码实现中",
    "board.lane.review": "审查与发件",
    "board.lane.done": "待人工 / 已完成",
    "board.empty": "暂无任务",
    "board.waitingDepsPrefix": "等待",
    "board.waitingDepsSuffix": "个重叠作用域任务",
    "board.stagePrefix": "阶段",

    "drawer.loading": "加载中...",
    "drawer.cancelTask": "取消任务",
    "drawer.worktreeActive": "工作树在线",
    "drawer.worktreeCleaned": "工作树已回收 · 分支保留",
    "drawer.reclaimWorktree": "回收工作树",
    "drawer.tab.stream": "执行轨迹",
    "drawer.tab.diff": "Diff 与授权边界",
    "drawer.tab.recall": "链式召回",
    "drawer.tab.outbox": "发件箱",
    "drawer.attention": "注意：",
    "drawer.stageRunsTitle": "阶段流水线记录",
    "drawer.noStageRuns": "暂无阶段运行记录。",
    "drawer.liveEventsTitle": "实时 SSE 事件流",
    "drawer.listeningEvents": "正在监听当前任务的实时事件...",
    "drawer.mandateTitle": "不可变 Mandate 授权护栏",
    "drawer.allowedPaths": "允许修改路径",
    "drawer.forbiddenPaths": "禁止触碰路径",
    "drawer.diffTitle": "工作树 Git Diff",
    "drawer.noDiff": "当前工作树暂无代码变更。",
    "drawer.searchPlaceholder": "跨任务与 Spill 产物检索 SQLite FTS5 记忆...",
    "drawer.recallButton": "召回",
    "drawer.ftsHitsTitle": "FTS5 检索命中",
    "drawer.lineageTitle": "记忆血缘：触发器 → 会话串 → 内联记忆",
    "drawer.originTrigger": "来源触发器：",
    "drawer.planSummary": "内联方案摘要：",
    "drawer.threadUpdates": "已订阅 Thread 追加记录：",
    "drawer.spillTitle": "Spill 溢出产物（按需加载）",
    "drawer.noSpill": "暂无溢出产物。",
    "drawer.bytes": "字节",
    "drawer.hideSpill": "收起产物",
    "drawer.readSpill": "读取产物",
    "drawer.outboxTitle": "Transactional Outbox 外部副作用记录",
    "drawer.noOutbox": "当前任务暂无发件箱记录。",
    "drawer.outboxKey": "幂等键",
    "drawer.outboxAttempts": "尝试次数",
    "drawer.outboxError": "错误：",
    "drawer.threadPlaceholder": "向已订阅 Thread 发送追加指令（直通当前 Worker）...",
    "drawer.injectButton": "注入",

    "modal.dispatch.title": "派发研发任务",
    "modal.dispatch.taskTitle": "任务标题",
    "modal.dispatch.taskPlaceholder": "例如：为 API 网关添加限流中间件",
    "modal.dispatch.goalLabel": "目标与验收说明",
    "modal.dispatch.goalPlaceholder": "描述预期实现效果与自测验证要求...",
    "modal.dispatch.pipeline": "流水线模板",
    "modal.dispatch.engine": "执行引擎",
    "modal.dispatch.budget": "预算上限 ($)",
    "modal.dispatch.paths": "Mandate 允许修改路径（逗号分隔）",
    "modal.dispatch.pathsPlaceholder": "packages/core/**, packages/drivers/**",
    "modal.dispatch.cancel": "取消",
    "modal.dispatch.submitting": "派发中...",
    "modal.dispatch.submit": "立即派发",

    "modal.simulate.title": "模拟外部事件",
    "modal.simulate.descPrefix": "无需外部 Webhook，直接测试 Router 意图评估、",
    "modal.simulate.descMiddle": "与",
    "modal.simulate.descSuffix": "模式门禁以及 Thread 订阅直通路由。",
    "modal.simulate.source": "事件源",
    "modal.simulate.threadKey": "会话串标识 (Thread Key)",
    "modal.simulate.eventTitle": "事件标题",
    "modal.simulate.eventPlaceholder": "例如：#42 auth 中间件 CI 校验失败",
    "modal.simulate.eventBody": "事件内容（支持 scope:path/** 指定范围）",
    "modal.simulate.bodyPlaceholder": "描述故障现象或需求内容，可使用 scope:src/auth/** 提示授权路径。",
    "modal.simulate.cancel": "取消",
    "modal.simulate.submitting": "发送中...",
    "modal.simulate.submit": "触发事件",

    "modal.repo.title": "注册 Git 代码仓库",
    "modal.repo.name": "显示名称",
    "modal.repo.namePlaceholder": "my-service",
    "modal.repo.path": "本地仓库绝对路径",
    "modal.repo.pathPlaceholder": "/Users/you/work/my-service",
    "modal.repo.baseBranch": "基准分支",
    "modal.repo.initialMode": "初始自治模式",
    "modal.repo.githubRepo": "GitHub 仓库（可选，owner/repo）",
    "modal.repo.githubPlaceholder": "owner/repo",
    "modal.repo.cancel": "取消",
    "modal.repo.submit": "注册仓库",

    "modal.repoSettings.title": "仓库偏好设置",
    "modal.repoSettings.rootPath": "仓库根目录",
    "modal.repoSettings.defaultTemplate": "默认流水线模板",
    "modal.repoSettings.implEngine": "首选编码引擎",
    "modal.repoSettings.reviewEngine": "首选交叉审查引擎",
    "modal.repoSettings.autoCleanupLabel": "交付或取消后自动回收 Worktree 目录",
    "modal.repoSettings.autoCleanupDesc": "开启后，任务完成交付或取消时立即清理隔离目录（保留提交分支与 Diff 视图）。",
    "modal.repoSettings.save": "保存设置",
    "modal.repoSettings.saving": "保存中...",

    "modal.worktrees.title": "Worktree 工作树生命周期管理",
    "modal.worktrees.subtitle": "活跃执行中的工作树受保护不会被回收；已交付、已失败、已取消或孤儿目录可一键 GC 清理。",
    "modal.worktrees.empty": "工作树目录当前已全部净空。",
    "modal.worktrees.activeBadge": "执行中·受保护",
    "modal.worktrees.reclaimableBadge": "终态可回收",
    "modal.worktrees.orphanBadge": "孤儿目录",
    "modal.worktrees.reclaimOne": "回收",
    "modal.worktrees.gcButton": "一键 GC 清理可回收工作树",
    "modal.worktrees.gcing": "清理中...",
    "modal.worktrees.gcResultBanner": "已完成垃圾回收：共清理 {removed} 个工作树目录，跳过 {skipped} 个活跃任务目录。",
    "modal.worktrees.refresh": "刷新",
    "modal.worktrees.close": "关闭",

    "setup.title": "首次运行环境扫描与模型配置",
    "setup.settingsTitle": "系统环境与控制面模型设置",
    "setup.firstRunBanner": "检测到当前为首次启动：系统已自动扫描本机 CLI 工具链并给出引擎建议，请确认或配置控制面 LLM 后启用。",
    "setup.cliSectionTitle": "本机 CLI 工具链扫描",
    "setup.rescan": "重新扫描",
    "setup.scanning": "扫描中...",
    "setup.status.ready": "已就绪",
    "setup.status.detected": "已安装",
    "setup.status.unauth": "未登录",
    "setup.status.missing": "未安装",
    "setup.defaultImplEngine": "默认编码引擎",
    "setup.defaultReviewEngine": "默认交叉审查引擎",
    "setup.llmSectionTitle": "控制面大模型配置（Router / Watchdog）",
    "setup.preset.deepseek.title": "DeepSeek API",
    "setup.preset.deepseek.desc": "推荐 · 快速低成本结构化路由与 Watchdog 诊断",
    "setup.preset.openai.title": "OpenAI / 兼容接口",
    "setup.preset.openai.desc": "支持 OpenAI、Azure、OneAPI、Ollama 或任意兼容地址",
    "setup.preset.claude_cli.title": "复用本地 Claude CLI",
    "setup.preset.claude_cli.desc": "无工具受限模式 · 免额外 API Key",
    "setup.preset.codex_cli.title": "复用本地 Codex CLI",
    "setup.preset.codex_cli.desc": "只读沙箱结构化输出 · 免额外 API Key",
    "setup.preset.heuristic.title": "本地启发式引擎 (免配置)",
    "setup.preset.heuristic.desc": "零 Token 消耗 · 离线确定性规则路由与自愈",
    "setup.localDefaultPrefix": "本机默认:",
    "setup.workerProfilesTitle": "Worker CLI 模型与思考强度（全局默认）",
    "setup.workerProfilesHint": "留空则跟随本机 ~/.claude、~/.codex 或 ~/.config/opencode 的全局默认配置；填选后由 super-work 派发时按单透传覆盖，不改动原配置文件。",
    "setup.claudeProfileTitle": "Claude Code 默认参数",
    "setup.codexProfileTitle": "Codex CLI 默认参数",
    "setup.opencodeProfileTitle": "OpenCode CLI 默认参数",
    "setup.modelLabel": "模型（可选）",
    "setup.followLocalDefault": "跟随本机默认",
    "setup.effortLabel": "思考强度 (Effort)",
    "setup.effort.inherit": "跟随本机默认",
    "setup.effort.low": "low · 极速轻量",
    "setup.effort.medium": "medium · 均衡",
    "setup.effort.high": "high · 深度推理",
    "setup.effort.xhigh": "xhigh · 超高强度",
    "setup.effort.max": "max · 极限推理",
    "setup.cliLlmModel": "控制面 CLI 模型（可选）",
    "setup.cliLlmEffort": "控制面思考强度（推荐 low）",
    "modal.dispatch.modelOverride": "单任务模型覆盖（可选）",
    "modal.dispatch.effortOverride": "单任务思考强度",
    "modal.dispatch.inheritGlobal": "继承全局配置",
    "setup.baseUrl": "接口地址 (Base URL)",
    "setup.model": "模型名称 (Model)",
    "setup.apiKey": "API Key",
    "setup.apiKeySavedHint": "已安全保存密钥（留空保留现有密钥，输入新密钥将覆盖）",
    "setup.apiKeyPlaceholder": "输入 sk-... 密钥（仅保存在本地 SQLite 状态库，不会回传明文）",
    "setup.testConnection": "测试连接",
    "setup.testing": "检测中...",
    "setup.later": "暂不保存",
    "setup.saveActivate": "完成配置并启用",
    "setup.saving": "保存中...",
  },
  en: {
    "app.title": "super-work · Super-Agent Orchestrator",
    "brand.badge": "Super-Agent OS",
    "brand.subtitle": "Router · Worker Pool · Watchdog · Outbox",
    "header.noRepo": "No repo registered",
    "header.registerRepoTitle": "Register repository",
    "header.repoSettingsTitle": "Repository preferences",
    "header.mode.off": "OFF",
    "header.mode.offDesc": "Ingest only",
    "header.mode.observe": "OBSERVE",
    "header.mode.observeDesc": "Propose to Inbox",
    "header.mode.auto": "AUTO",
    "header.mode.autoDesc": "Autonomous dispatch",
    "header.sse.live": "Live SSE",
    "header.sse.reconnecting": "Reconnecting",
    "header.watchdog": "Watchdog",
    "header.controlPlanePrefix": "Control Plane",
    "header.outboxPrefix": "Outbox",
    "header.simulateEvent": "Simulate Event",
    "header.dispatchTask": "Dispatch Task",
    "header.langButton": "EN / 中文",
    "header.langTitle": "Switch UI Language (English / 中文)",
    "header.settings": "Env & LLM",
    "header.settingsTitle": "CLI Environment Scan & Control-Plane LLM Configuration",

    "strip.sse.label": "Live Sync",
    "strip.sse.live": "Connected",
    "strip.sse.reconnecting": "Reconnecting",
    "strip.sse.desc": "Streams real-time ticket state transitions, worker logs, and Attention Inbox notifications via Server-Sent Events.",
    "strip.llm.label": "Control Brain",
    "strip.llm.desc": "Control-Plane LLM: triages incoming triggers, defines Mandate path boundaries, and diagnoses Watchdog alerts. Click to switch models.",
    "strip.engines.label": "Agent Roles",
    "strip.engines.coding": "Coding",
    "strip.engines.review": "Review",
    "strip.engines.availableSuffix": "engines ready",
    "strip.engines.desc": "By default, the Coding engine implements and tests inside an isolated git worktree, then the Review engine runs an independent cross-check. Click to adjust.",
    "strip.engines.detectedPrefix": "Detected workers:",
    "strip.watchdog.label": "Anti-Stall Watchdog",
    "strip.watchdog.guarding": "Guarding",
    "strip.watchdog.runningSuffix": "running",
    "strip.watchdog.alertSuffix": "need attention",
    "strip.watchdog.desc": "Monitors stream silence timeouts, repeated identical errors, and A->B->A diff oscillation. Auto-injects hints or switches engines before escalating to your Inbox.",
    "strip.outbox.label": "PR Delivery Queue",
    "strip.outbox.pendingSuffix": "pending",
    "strip.outbox.desc": "Transactional Outbox: workers are blocked from running git push or creating PRs directly; all external side effects queue here after clean rebase.",
    "strip.worktrees.label": "Worktrees",
    "strip.worktrees.clean": "Clean",
    "strip.worktrees.activeSuffix": "active",
    "strip.worktrees.reclaimableSuffix": "reclaimable",
    "strip.worktrees.desc": "Isolated git worktree pool: directories are reclaimed automatically on terminal delivery/cancel by default, or inspect & trigger one-click GC while keeping branch history.",

    "nav.inbox": "Attention Inbox",
    "nav.board": "Mission Board",
    "nav.plugins": "Plugins",

    "plugins.title": "Plugin Management",
    "plugins.refresh": "Refresh",
    "plugins.loading": "Loading…",
    "plugins.empty": "No plugins loaded",
    "plugins.loadFailed": "Failed to load plugins",
    "plugins.enable": "Enable",
    "plugins.disable": "Disable",
    "plugins.enabledOk": "Plugin enabled",
    "plugins.disabledOk": "Plugin disabled",
    "plugins.actionFailed": "Action failed",
    "plugins.configure": "Configure",
    "plugins.noConfig": "This plugin has nothing to configure",
    "plugins.config.title": "Plugin Configuration",
    "plugins.config.save": "Save",
    "plugins.config.saveEnable": "Save & Enable",
    "plugins.config.saving": "Saving…",
    "plugins.config.savedOk": "Configuration saved",
    "plugins.config.secretKeep": "Already set; re-enter when updating config",
    "plugins.config.secretRequired": "Secret must be re-entered:",
    "plugins.config.required": "Missing required field:",
    "plugins.config.invalidJson": "Invalid JSON:",
    "plugins.config.invalidNumber": "Invalid number:",
    "plugins.kind.driver": "Driver",
    "plugins.kind.trigger": "Trigger",
    "plugins.kind.outbox": "Outbox",
    "plugins.kind.llm": "LLM",
    "plugins.kind.tool": "Tool",
    "plugins.state.loaded": "Loaded",
    "plugins.state.enabled": "Enabled",
    "plugins.state.disabled": "Disabled",
    "plugins.state.failed": "Failed",

    "inbox.title": "Attention Inbox",
    "inbox.subtitle": "High-signal decisions requiring human authorization. Workers execute silently until blocked or awaiting sign-off.",
    "inbox.pendingSuffix": "pending",
    "inbox.emptyTitle": "Attention Clear",
    "inbox.emptyDesc": "No pending approvals, Watchdog escalations, or Mandate blocks. Switch to Mission Board or dispatch a task to begin.",
    "inbox.inspectDeepDive": "Inspect Deep Dive →",
    "inbox.notePlaceholder": "Optional guidance / feedback note for the Worker...",
    "inbox.reject": "Reject",
    "inbox.approve": "Approve & Continue",
    "inbox.recentTitle": "Recent Decisions",

    "board.lane.triage": "Triage & Proposed",
    "board.lane.queued": "Queued & Planning",
    "board.lane.implementing": "Implementing",
    "board.lane.review": "Review & Outbox",
    "board.lane.done": "Needs Human / Done",
    "board.empty": "Empty",
    "board.waitingDepsPrefix": "Waiting on",
    "board.waitingDepsSuffix": "overlapping scope(s)",
    "board.stagePrefix": "Stage",

    "drawer.loading": "Loading...",
    "drawer.cancelTask": "Cancel",
    "drawer.worktreeActive": "Worktree Active",
    "drawer.worktreeCleaned": "Worktree Reclaimed · Branch Kept",
    "drawer.reclaimWorktree": "Reclaim Worktree",
    "drawer.tab.stream": "Execution Stream",
    "drawer.tab.diff": "Diff & Mandate",
    "drawer.tab.recall": "Chain of Recall",
    "drawer.tab.outbox": "Outbox",
    "drawer.attention": "Attention:",
    "drawer.stageRunsTitle": "Stage Pipeline Runs",
    "drawer.noStageRuns": "No stage runs recorded yet.",
    "drawer.liveEventsTitle": "Live SSE Event Trajectory",
    "drawer.listeningEvents": "Listening for live stream events on this ticket...",
    "drawer.mandateTitle": "Immutable Mandate Guardrail",
    "drawer.allowedPaths": "Allowed Paths",
    "drawer.forbiddenPaths": "Forbidden Paths",
    "drawer.diffTitle": "Worktree Unified Git Diff",
    "drawer.noDiff": "No diff produced in worktree yet.",
    "drawer.searchPlaceholder": "Search SQLite FTS5 memory across tickets & spill...",
    "drawer.recallButton": "Recall",
    "drawer.ftsHitsTitle": "FTS5 Search Results",
    "drawer.lineageTitle": "Lineage: Trigger → Thread → Inline Memory",
    "drawer.originTrigger": "Origin Trigger:",
    "drawer.planSummary": "Inline Plan Summary:",
    "drawer.threadUpdates": "Subscribed Thread Updates:",
    "drawer.spillTitle": "Spill Artifacts (Load On Demand)",
    "drawer.noSpill": "No spill artifacts written yet.",
    "drawer.bytes": "bytes",
    "drawer.hideSpill": "Hide Spill",
    "drawer.readSpill": "Read Spill",
    "drawer.outboxTitle": "Transactional Outbox Side-Effects",
    "drawer.noOutbox": "No Outbox side-effects queued for this ticket yet.",
    "drawer.outboxKey": "Key",
    "drawer.outboxAttempts": "Attempts",
    "drawer.outboxError": "Error:",
    "drawer.threadPlaceholder": "Send follow-up message on subscribed Thread (routes directly to this Worker)...",
    "drawer.injectButton": "Inject",

    "modal.dispatch.title": "Dispatch Task",
    "modal.dispatch.taskTitle": "Task Title",
    "modal.dispatch.taskPlaceholder": "e.g. Add rate limiter middleware",
    "modal.dispatch.goalLabel": "Goal & Acceptance Instructions",
    "modal.dispatch.goalPlaceholder": "Describe expected behavior and verification...",
    "modal.dispatch.pipeline": "Pipeline",
    "modal.dispatch.engine": "Worker Engine",
    "modal.dispatch.budget": "Max Budget ($)",
    "modal.dispatch.paths": "Mandate Allowed Paths (comma-separated)",
    "modal.dispatch.pathsPlaceholder": "packages/core/**, packages/drivers/**",
    "modal.dispatch.cancel": "Cancel",
    "modal.dispatch.submitting": "Dispatching...",
    "modal.dispatch.submit": "Dispatch",

    "modal.simulate.title": "Simulate External Event",
    "modal.simulate.descPrefix": "Test Router triage,",
    "modal.simulate.descMiddle": "vs",
    "modal.simulate.descSuffix": "gating, and Thread Subscription routing without waiting for external GitHub webhooks.",
    "modal.simulate.source": "Source",
    "modal.simulate.threadKey": "Thread Key",
    "modal.simulate.eventTitle": "Event Title",
    "modal.simulate.eventPlaceholder": "e.g. #42 CI failed on auth middleware",
    "modal.simulate.eventBody": "Event Body (supports scope:path/**)",
    "modal.simulate.bodyPlaceholder": "Describe bug report or CI failure. Use scope:src/auth/** to hint Mandate.",
    "modal.simulate.cancel": "Cancel",
    "modal.simulate.submitting": "Sending...",
    "modal.simulate.submit": "Emit Trigger",

    "modal.repo.title": "Register Git Repository",
    "modal.repo.name": "Display Name",
    "modal.repo.namePlaceholder": "my-service",
    "modal.repo.path": "Local Repository Path",
    "modal.repo.pathPlaceholder": "/Users/you/work/my-service",
    "modal.repo.baseBranch": "Base Branch",
    "modal.repo.initialMode": "Initial Mode",
    "modal.repo.githubRepo": "GitHub Repo (optional, owner/repo)",
    "modal.repo.githubPlaceholder": "owner/repo",
    "modal.repo.cancel": "Cancel",
    "modal.repo.submit": "Register",

    "modal.repoSettings.title": "Repository Preferences",
    "modal.repoSettings.rootPath": "Repository Root",
    "modal.repoSettings.defaultTemplate": "Default Pipeline Template",
    "modal.repoSettings.implEngine": "Preferred Implement Engine",
    "modal.repoSettings.reviewEngine": "Preferred Review Engine",
    "modal.repoSettings.autoCleanupLabel": "Auto-reclaim Worktree after delivery or cancellation",
    "modal.repoSettings.autoCleanupDesc": "Removes the isolated worktree directory upon terminal delivery/cancel while keeping branch history & Diff viewable.",
    "modal.repoSettings.save": "Save Preferences",
    "modal.repoSettings.saving": "Saving...",

    "modal.worktrees.title": "Worktree Pool & Garbage Collection",
    "modal.worktrees.subtitle": "Active worktrees are protected; terminal (delivered/failed/cancelled) or orphan directories can be reclaimed in one click.",
    "modal.worktrees.empty": "All worktree directories are currently clean.",
    "modal.worktrees.activeBadge": "Active · Protected",
    "modal.worktrees.reclaimableBadge": "Reclaimable",
    "modal.worktrees.orphanBadge": "Orphan Dir",
    "modal.worktrees.reclaimOne": "Reclaim",
    "modal.worktrees.gcButton": "GC Reclaimable Worktrees",
    "modal.worktrees.gcing": "Cleaning...",
    "modal.worktrees.gcResultBanner": "GC completed: reclaimed {removed} worktree directories, skipped {skipped} active.",
    "modal.worktrees.refresh": "Refresh",
    "modal.worktrees.close": "Close",

    "setup.title": "First-Run CLI Scan & LLM Setup",
    "setup.settingsTitle": "Environment & Control-Plane Settings",
    "setup.firstRunBanner": "First launch detected: super-work scanned your local CLI tools and recommended default engines. Confirm or configure your Control-Plane LLM below.",
    "setup.cliSectionTitle": "Local CLI Toolchain Scan",
    "setup.rescan": "Rescan",
    "setup.scanning": "Scanning...",
    "setup.status.ready": "Ready",
    "setup.status.detected": "Installed",
    "setup.status.unauth": "Not Logged In",
    "setup.status.missing": "Not Found",
    "setup.defaultImplEngine": "Default Implement Engine",
    "setup.defaultReviewEngine": "Default Review Engine",
    "setup.llmSectionTitle": "Control-Plane LLM (Router / Watchdog)",
    "setup.preset.deepseek.title": "DeepSeek API",
    "setup.preset.deepseek.desc": "Recommended · Fast, low-cost structured routing & Watchdog L2",
    "setup.preset.openai.title": "OpenAI / Compatible API",
    "setup.preset.openai.desc": "Works with OpenAI, custom gateways, or local Ollama endpoints",
    "setup.preset.claude_cli.title": "Reuse Local Claude CLI",
    "setup.preset.claude_cli.desc": "Restricted tool-less mode · Zero extra API key required",
    "setup.preset.codex_cli.title": "Reuse Local Codex CLI",
    "setup.preset.codex_cli.desc": "Read-only structured JSON exec · Zero extra API key",
    "setup.preset.heuristic.title": "Local Heuristic Engine (Zero-Config)",
    "setup.preset.heuristic.desc": "Zero token cost · Offline deterministic triage & recovery",
    "setup.localDefaultPrefix": "Local default:",
    "setup.workerProfilesTitle": "Worker CLI Model & Reasoning Effort (Global Defaults)",
    "setup.workerProfilesHint": "Leave unset to inherit ~/.claude, ~/.codex, or ~/.config/opencode defaults. Overrides are passed per-invocation via CLI flags without modifying your local config files.",
    "setup.claudeProfileTitle": "Claude Code Defaults",
    "setup.codexProfileTitle": "Codex CLI Defaults",
    "setup.opencodeProfileTitle": "OpenCode CLI Defaults",
    "setup.modelLabel": "Model (optional)",
    "setup.followLocalDefault": "Follow local CLI default",
    "setup.effortLabel": "Reasoning Effort",
    "setup.effort.inherit": "Follow local CLI default",
    "setup.effort.low": "low · Fast",
    "setup.effort.medium": "medium · Balanced",
    "setup.effort.high": "high · Deep",
    "setup.effort.xhigh": "xhigh · Extra High",
    "setup.effort.max": "max · Maximum",
    "setup.cliLlmModel": "Control-Plane CLI Model (optional)",
    "setup.cliLlmEffort": "Control-Plane Effort (recommend low)",
    "modal.dispatch.modelOverride": "Per-Task Model Override (optional)",
    "modal.dispatch.effortOverride": "Per-Task Effort",
    "modal.dispatch.inheritGlobal": "Inherit global default",
    "setup.baseUrl": "Base URL",
    "setup.model": "Model Name",
    "setup.apiKey": "API Key",
    "setup.apiKeySavedHint": "API key already stored locally (leave blank to keep existing key)",
    "setup.apiKeyPlaceholder": "Enter sk-... (persisted in local SQLite, masked in API responses)",
    "setup.testConnection": "Test Connection",
    "setup.testing": "Testing...",
    "setup.later": "Close",
    "setup.saveActivate": "Save & Activate",
    "setup.saving": "Saving...",
  },
} as const;

export type TranslationKey = keyof typeof MESSAGES.zh;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readInitialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
  } catch {
    // Ignore storage access errors
  }
  return "zh";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Ignore storage access errors
    }
  }, []);

  const toggleLocale = useCallback(() => {
    setLocale(locale === "zh" ? "en" : "zh");
  }, [locale, setLocale]);

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    document.title = MESSAGES[locale]["app.title"];
  }, [locale]);

  const t = useCallback((key: TranslationKey): string => MESSAGES[locale][key], [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, toggleLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used inside I18nProvider");
  }
  return ctx;
}

const TICKET_STATUS_LABELS: Record<TicketStatus, { zh: string; en: string }> = {
  triaging: { zh: "评估中", en: "triaging" },
  proposed: { zh: "拟单待批", en: "proposed" },
  queued: { zh: "排队中", en: "queued" },
  waiting_deps: { zh: "等待依赖", en: "waiting_deps" },
  planning: { zh: "规划中", en: "planning" },
  awaiting_plan_approval: { zh: "待批方案", en: "awaiting_plan_approval" },
  implementing: { zh: "编码实现", en: "implementing" },
  reviewing: { zh: "交叉审查", en: "reviewing" },
  rebasing: { zh: "变基验证", en: "rebasing" },
  watchdog_intervention: { zh: "看门狗介入", en: "watchdog_intervention" },
  needs_human: { zh: "待人工介入", en: "needs_human" },
  outbox_pending: { zh: "待发件交付", en: "outbox_pending" },
  delivered: { zh: "已交付", en: "delivered" },
  failed: { zh: "已失败", en: "failed" },
  cancelled: { zh: "已取消", en: "cancelled" },
};

const STAGE_LABELS: Record<StageKind, { zh: string; en: string }> = {
  plan: { zh: "规划 (plan)", en: "plan" },
  implement: { zh: "实现 (implement)", en: "implement" },
  review: { zh: "审查 (review)", en: "review" },
  rebase: { zh: "变基 (rebase)", en: "rebase" },
};

const TEMPLATE_LABELS: Record<PipelineTemplateId, { zh: string; en: string }> = {
  fast: { zh: "fast · 快速修复", en: "fast" },
  standard: { zh: "standard · 标准流程", en: "standard" },
  strict: { zh: "strict · 严格门禁", en: "strict" },
};

const INBOX_KIND_LABELS: Record<InboxItem["kind"], { zh: string; en: string }> = {
  mandate_violation: { zh: "越界授权拦截", en: "MANDATE VIOLATION" },
  watchdog_escalation: { zh: "看门狗升级告警", en: "WATCHDOG ESCALATION" },
  merge_conflict: { zh: "合并冲突待解", en: "MERGE CONFLICT" },
  plan_approval: { zh: "方案审批门禁", en: "PLAN APPROVAL" },
  outbox_signoff: { zh: "PR 交付签发", en: "PR SIGNOFF" },
  observe_proposal: { zh: "观察模式拟单", en: "OBSERVE PROPOSAL" },
};

const INBOX_STATUS_LABELS: Record<InboxItem["status"], { zh: string; en: string }> = {
  pending: { zh: "待处理", en: "PENDING" },
  approved: { zh: "已批准", en: "APPROVED" },
  rejected: { zh: "已驳回", en: "REJECTED" },
};

const OUTBOX_STATUS_LABELS: Record<OutboxEntry["status"], { zh: string; en: string }> = {
  awaiting_approval: { zh: "待签发", en: "awaiting_approval" },
  pending: { zh: "待投递", en: "pending" },
  processing: { zh: "投递中", en: "processing" },
  sent: { zh: "已投递", en: "sent" },
  failed: { zh: "投递失败", en: "failed" },
  cancelled: { zh: "已取消", en: "cancelled" },
};

export function formatTicketStatus(status: TicketStatus, locale: Locale): string {
  return TICKET_STATUS_LABELS[status][locale];
}

export function formatStage(stage: StageKind, locale: Locale): string {
  return STAGE_LABELS[stage][locale];
}

export function formatTemplate(template: PipelineTemplateId, locale: Locale): string {
  return TEMPLATE_LABELS[template][locale];
}

export function formatInboxKind(kind: InboxItem["kind"], locale: Locale): string {
  return INBOX_KIND_LABELS[kind][locale];
}

export function formatInboxStatus(status: InboxItem["status"], locale: Locale): string {
  return INBOX_STATUS_LABELS[status][locale];
}

export function formatOutboxStatus(status: OutboxEntry["status"], locale: Locale): string {
  return OUTBOX_STATUS_LABELS[status][locale];
}

export function formatEngineDisplayName(engine: WorkerEngineId, locale: Locale): string {
  switch (engine) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "mock":
      return locale === "zh" ? "Mock 演练" : "Mock";
  }
}

export function formatLlmProviderDisplay(rawProvider: string | undefined, locale: Locale): string {
  if (!rawProvider) {
    return locale === "zh" ? "未检测" : "Unknown";
  }
  if (rawProvider === "heuristic:local") {
    return locale === "zh" ? "本地规则 (免配置)" : "Local Heuristic";
  }
  if (rawProvider === "cli:claude-restricted" || rawProvider.startsWith("cli:claude")) {
    return rawProvider.includes("(") ? rawProvider.replace("cli:claude", "Claude CLI ") : "Claude CLI";
  }
  if (rawProvider.startsWith("cli:codex")) {
    return rawProvider.includes("(") ? rawProvider.replace("cli:codex", "Codex CLI ") : "Codex CLI";
  }
  if (rawProvider.startsWith("deepseek:")) {
    return `DeepSeek (${rawProvider.slice("deepseek:".length)})`;
  }
  if (rawProvider.startsWith("openai:")) {
    return `OpenAI (${rawProvider.slice("openai:".length)})`;
  }
  if (rawProvider.startsWith("custom:")) {
    return rawProvider.slice("custom:".length);
  }
  return rawProvider;
}
