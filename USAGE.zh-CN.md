[English](./USAGE.md) | [简体中文](./USAGE.zh-CN.md)

# super-work 使用指南

本指南介绍如何完成 `super-work` 的首次运行环境扫描、控制面大模型配置，以及如何在日常研发中使用决策指挥舱进行异步多任务编排。

---

## 一、 首次运行：CLI 自动扫描与控制面 LLM 配置

`super-work` 采用**控制面 + 执行面**分离架构：
- **执行面（Worker）**：直接复用本机安装的 Coding Agent CLI（`claude`、`codex`、`opencode` 等）。
- **控制面（Router / Watchdog）**：负责新事件分诊、任务作用域划分以及异常卡死诊断。

### 方式 A：Web 指挥舱可视化向导（推荐）

1. 启动服务并打开看板 `http://localhost:5173`：
   ```bash
   bun run dev
   ```
2. 首次启动且尚未完成初始化时，系统会自动弹出 **「首次运行环境扫描与模型配置」** 向导（此后也可随时点击右上角 **环境与模型** 按钮再次打开）：
   - **本机 CLI 工具链扫描**：自动探测 `claude`、`codex`、`opencode`、`gh`、`git`、`bun` 的安装路径、版本、登录认证状态（`已就绪` / `未登录` / `未安装`）以及 `~/.claude/settings.json`、`~/.codex/config.toml`、`~/.config/opencode/opencode.json` 中的本机默认模型与思考强度。
   - **默认引擎与 CLI 模型/强度档位**：分别为 `Claude Code`、`Codex CLI` 与 `OpenCode CLI` 配置全局默认模型和思考强度（`low` / `medium` / `high` / `xhigh` / `max`）；留空则沿用本机全局配置文件，填写后由 `super-work` 在派单时透传 `--model` / `--effort`、`-m` / `-c model_reasoning_effort` 或 `provider/model#variant`，**派发任务弹窗也支持对单个任务做临时覆盖**。
   - **控制面大模型配置**：从五种方案中任选其一，点击 **「测试连接」** 验证延迟与连通性，再点击 **「完成配置并启用」**（保存后立即热生效，无需重启进程）：

| 方案 | 适用场景 | 费用与依赖 |
| :--- | :--- | :--- |
| **DeepSeek API**（默认推荐） | 日常高频路由与 Watchdog L2 语义诊断 | 需 `DEEPSEEK_API_KEY`，接口 `https://api.deepseek.com/v1`，模型 `deepseek-chat` |
| **OpenAI / 兼容接口** | 接入 OpenAI、Azure、OneAPI 或本地 Ollama | 填写对应 `Base URL`、`Model` 与 `API Key` |
| **复用本地 Claude CLI** | 已登录 Claude Code 且不想单独申请 API Key | 零额外密钥，支持指定模型与思考强度（推荐 `low`） |
| **复用本地 Codex CLI** | 已登录 Codex CLI 且不想单独申请 API Key | 零额外密钥，只读结构化输出，支持指定模型与思考强度（推荐 `low`） |
| **本地启发式引擎** | 离线演练、Mock 测试或零控制面 Token 消耗 | 免配置、零网络请求 |

### 方式 B：终端交互 / 全自动配置命令

也可以在启动前通过终端命令完成扫描与写入：

```bash
# 交互式扫描并引导配置
bun run setup

# 非交互模式：按扫描结果与当前环境变量自动写入最佳配置
bun run setup -- --auto
```

---

## 二、 界面三层导航与核心概念速查

### 1. 顶部控制栏
- **仓库切换、`+` 注册与偏好设置按钮**：自动识别当前工作区 Git 仓库并绑定远程 `owner/repo`；点击仓库旁的 **「偏好设置」** 图标可按仓库单独调整默认流水线模板（`fast`/`standard`/`strict`）、首选编码/审查引擎、基准分支以及 **交付/取消后自动回收 Worktree** 开关。
- **自治模式开关**：
  - `关闭 (off)`：仅记录事件触发器，不生成任务。
  - `观察 (observe)`（推荐初上手）：收到外部事件后仅**拟单**放入「决策收件箱」等你点头确认，绝不私自改代码。
  - `自动 (auto)`：收到高信噪比事件后直接入队执行，仅在触发审批门禁或异常升级时通知你。
- **状态指示灯**：实时展示 `实时同步`（SSE）、`总控大脑`、`Agent 分工`、`防卡死巡检`、`PR 交付队列` 与 **`工作树池`（点击可查看在跑/可回收目录并一键 GC 清理）**，以及 `环境与模型` / `中文 / EN` 切换。

### 2. 三层信息结构与 `@super-work/cli`
1. **决策收件箱（Attention Inbox）**：聚合 `观察模式拟单`、`方案审批门禁`、`越界授权拦截`（普通越界保留改动支持 **「一键扩权并继续」**）、`看门狗升级告警`、`合并冲突待解`、`PR 交付签发`、`每日预算触顶` 与 `PR 评审/CI 返修` 八类高信噪比决策。
2. **态势看板（Mission Board）**：五列泳道实时展示所有任务状态、PR 关联徽章与 Epic 集成进度。
3. **效能与预算（Metrics & Budget）**：展示当日预算水位进度条、端到端交付成功率、累计花费及按引擎统计的平均阶段耗时。
4. **下钻详情抽屉 & 命令行客户端（`bun run cli` / `super-work`）**：
   - `super-work up [-d]`：前台或后台守护模式拉起本地服务。
   - `super-work status`、`dispatch <title> -d <desc> [--wait]`、`epic <title> [--preview-only|--wait]`、`inbox list|approve <id> [--expand-mandate]`、`logs <ticketId> [-f]`、`watch [--repo <id>|--ticket <id>]`、`revert <ticketId>`、`playbook [list|add|toggle|delete|sync --export]`：在终端直接派单、管理经验库、追踪含 Epic 子任务的实时 SSE、回放历史日志或安全回滚合入（支持 `--token` / `SUPER_WORK_TOKEN` 与 `--auto-start`）。

### 3. 三种流水线模板对比

| 模板 | 阶段流水线 | 人工门禁 | 适用场景 |
| :--- | :--- | :--- | :--- |
| `fast` | `implement` → `rebase` | 无 | 明确的小型 Bug 修复、文档或样式微调 |
| `standard` | `plan` → `implement` → `review` → `rebase` | 仅异常或越界时介入 | 日常功能开发（编码与审查可配异构引擎交叉验证） |
| `strict` | `plan` → `implement` → `review` → `rebase` | 强制 `方案审批` + `PR 交付签发` | 核心模块改造、鉴权/支付等高风险改动 |

---

## 三、 四大实战工作流

### 1. 主动派发研发任务与设置 Mandate 边界（含 Epic 拆单 DAG）
1. 点击右上角 **「派发任务」**：
   - **单任务派发**：填写任务标题与目标说明，选择流水线模板、执行引擎及可选单任务模型/思考强度覆盖，并在 **Mandate 允许修改路径** 中收敛授权目录（触及越界或 `.env*` / `*.pem` / `*.key` 将自动回滚并告警）。
   - **复杂需求拆单 (Epic DAG)**：切换到 Epic 标签页，默认使用 **统一集成分支 `super-work/epic/<id>`**（也可切回逐子单独立交付），描述跨模块需求后点击 **「AI 预览拆单 DAG」**，可直接编辑每条子任务的模板、描述、授权路径与前置依赖关系；全部子任务汇入集成分支后由内核执行全局终验与单轮集成自愈，最终聚合提交 1 个 PR 或 1 次本地合入。

### 2. 观察模式下模拟 / 监听 GitHub 事件并审批（含 PR 返修闭环）
1. 保持顶部自治模式为 **`观察`**，点击 **「模拟事件」**（或由内置的 `GhCliPollingSource` 自动轮询已绑定的 GitHub 仓库 Issue / PR Review / Actions CI 失败日志）。
2. 当已提 PR 收到外部 Review 意见或 CI 失败时：内核会自动过滤 `[super-work]` 自身评论，在 `auto` 模式下直接唤醒原分支轻量修复、跑通本地校验后增量 `git push` 更新同一个 PR 并自动评论回复（单 PR 最多自动返修 3 轮；`observe` 模式先推送至收件箱待批）。
3. 提交后，事件会先经过 `MasterAssessor` 评估，随后在 **决策收件箱** 出现一条「观察模式拟单」。
4. 你可在输入框补充额外提示，点击 **「批准并继续」**，任务立即转入独立 `git worktree` 开始执行。

### 3. 文件树 Diff 审查台、定向文件返修与链式召回
1. 在态势看板点击任一任务，打开 **下钻详情抽屉**：
   - **执行轨迹**：查看各阶段耗时、花费与实时 SSE 事件流。
   - **Diff 与授权边界**：通过 **文件树 Diff 审查台** 查看分文件 `+`/`-` 统计与折叠代码块，浏览内联 **结构化对抗审查清单（`blocker`/`major`/`nit`）**，还可点击任意文件右上角 **「针对此文件返修」** 直接注入精准修复指令。
   - **链式召回**：沿 `Trigger → Thread → Inline 摘要 → Spill 溢出产物`（含结构化 JSON `review_report` 与 `test_log`）溯源，或用 FTS5 搜索历史经验。
2. **Thread 订阅追问**：在抽屉底部输入框发送补充要求，消息直接注入活跃 `Thread`。

### 4. 工程契约 (`super-work.json`)、自进化经验库、主动通知与一键安全回滚
- 在 **仓库偏好设置** 的三个标签页中，除设置并发/每日预算上限（触顶后推送 `每日预算触顶` 审批卡）外，还可在 **工程契约** 页配置 `setupCommands` Worktree 预热命令、附加 `forbiddenPaths`、仓库 `conventions` 并双向 **同步/导出 `super-work.json`**；在 **Playbook 经验库** 页查看、置顶、启停自动提炼或人类批注沉淀的避坑规则。
- 在 **环境与模型设置** 底部配置 **主动注意力触达**（勾选 macOS 原生系统通知与飞书/Slack/Discord/通用 JSON Webhook，仅在 Inbox 阻塞待办、最终交付与任务失败时发送）并一键 **「发送测试通知」**。
- 通过 `local_merge`（统一 `--no-ff` 生成单点 Merge Commit）本地合入主干后，抽屉顶部提供 **「一键安全回滚」** 按钮（或运行 `super-work revert <ticketId>`），执行非破坏性 `git revert -m 1` 生成反向提交。

---

## 四、 多任务并发最佳实践与常见问题（FAQ）

1. **如何让多个 Worker 真正并发而不互相排队？**
   - 派发任务时为不同任务填写互不重叠的 **Mandate 允许修改路径**（例如任务 A 填 `packages/core/**`，任务 B 填 `packages/web/**`）。当检测到两个任务路径无交集时，内核会在各自独立的 `git worktree` 中全速并发；只有路径存在重叠时才会自动通过 `dependsOn` 串行排队，避免 Merge 冲突。
2. **提示 `Repository has no commits (unborn HEAD)` 怎么办？**
   - `git worktree add` 要求目标仓库至少已有一次提交。先在仓库根目录完成一次 `git commit` 即可。
3. **扫描显示 CLI「未登录」怎么处理？**
   - Claude Code：在终端运行 `claude auth login`
   - Codex CLI：在终端运行 `codex login`
   - GitHub CLI：在终端运行 `gh auth login`
   - 完成后在网页端点击 **设置 → 重新扫描** 即可更新为「已就绪」。
4. **在哪里查看或清理工作树与数据库？**
   - 所有运行时状态库（`super-work.db`）、Spill 产物与临时 `worktrees/` 均隔离存放在 `.super-work/`（或 `SUPER_WORK_DATA_DIR` 指定目录）下，且已被 `.gitignore` 忽略；开启仓库的「自动回收 Worktree」后，任务交付或取消时会自动回收工作树目录（仍保留分支 Diff 可回看），也可以点击状态栏 **「工作树池」** 一键 GC 清理历史或孤儿目录。
