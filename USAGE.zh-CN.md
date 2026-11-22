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

### 2. 三层信息结构
1. **决策收件箱（Attention Inbox）**：聚合 `观察模式拟单`、`方案审批门禁`、`越界授权拦截`、`看门狗升级告警`、`合并冲突待解`、`PR 交付签发` 六类高信噪比决策。
2. **态势看板（Mission Board）**：五列泳道实时展示所有任务状态（`评估与拟单` → `排队与规划` → `编码实现中` → `审查与发件` → `待人工 / 已完成`）。
3. **下钻详情抽屉（Deep Dive Drawer）**：点击任意任务卡片或收件箱条目的「查看详情抽屉 →」即可打开，包含 `执行轨迹`、`Diff 与授权边界`、`链式召回`、`发件箱` 四大视图与底部追问栏。

### 3. 三种流水线模板对比

| 模板 | 阶段流水线 | 人工门禁 | 适用场景 |
| :--- | :--- | :--- | :--- |
| `fast` | `implement` → `rebase` | 无 | 明确的小型 Bug 修复、文档或样式微调 |
| `standard` | `plan` → `implement` → `review` → `rebase` | 仅异常或越界时介入 | 日常功能开发（编码与审查可配异构引擎交叉验证） |
| `strict` | `plan` → `implement` → `review` → `rebase` | 强制 `方案审批` + `PR 交付签发` | 核心模块改造、鉴权/支付等高风险改动 |

---

## 三、 四大实战工作流

### 1. 主动派发研发任务与设置 Mandate 边界
1. 点击右上角 **「派发任务」**。
2. 填写任务标题与目标说明，选择流水线模板（如 `standard`）和首选引擎（如 `claude` 或先用 `mock` 体验全流程）。
3. 在 **Mandate 允许修改路径** 中收敛授权目录（例如 `packages/core/**, packages/drivers/**`）：
   - Worker 修改超出授权范围或触及 `.env*` / `*.pem` / `*.key` 时，内核会自动回滚越界变更并在收件箱生成拦截卡片。

### 2. 观察模式下模拟 / 监听 GitHub 事件并审批
1. 保持顶部自治模式为 **`观察`**，点击 **「模拟事件」**（或由内置的 `GhCliPollingSource` 自动轮询已绑定的 GitHub 仓库 Issue / PR / CI）。
2. 在事件内容中可用 `scope:src/auth/**` 提示预期作用域。
3. 提交后，事件会先经过 `MasterAssessor` 评估，随后在 **决策收件箱** 出现一条「观察模式拟单」。
4. 你可在输入框补充额外提示，点击 **「批准并继续」**，任务立即转入独立 `git worktree` 开始执行。

### 3. 在详情抽屉跟踪执行、通过 Thread 订阅追问与链式召回
1. 在态势看板点击任一运行中或已完成的任务，打开 **下钻详情抽屉**：
   - **执行轨迹**：查看各阶段耗时、花费与实时 SSE 事件流。
   - **Diff 与授权边界**：核对当前工作树相对于基准分支的统一 `git diff`。
   - **链式召回**：沿 `Trigger → Thread → Inline 摘要 → Spill 溢出产物` 溯源；点击 **「读取产物」** 按需加载完整 JSONL 执行日志或补丁，或使用顶部 FTS5 搜索框跨任务回忆历史经验。
2. **Thread 订阅追问**：在抽屉底部的输入框直接发送补充要求（例如“请同时补一个边界单测”），消息会直接注入该任务对应的活跃 `Thread` 上下文，无需另开新单。

### 4. 处理看门狗升级与严格模式 PR 签发
- 当 Worker 连续遇到相同错误、文件 Diff 发生 `A -> B -> A` 振荡或静默超时时，**看门狗** 会先尝试自动注入纠偏提示或切换备用引擎（例如从 `claude` 切至 `codex`）自愈；若超出重试上限，会在收件箱生成 **看门狗升级告警** 交由你裁决。
- 在 `strict` 模式下，Rebase 通过后会暂停在 `outbox_pending`，待你在收件箱点击 **「批准并继续」** 完成 `PR 交付签发` 后，由 `Transactional Outbox` 幂等推送分支并创建 PR。

---

## 四、 插件管理面板

在主导航中打开 **插件管理** 标签(英文界面为 **Plugins**),位于 **决策收件箱** 与 **态势看板** 之后。每一行展示插件名称、版本、`kind`、capabilities、状态徽标(`loaded` / `enabled` / `disabled` / `failed`),`failed` 插件还会显示错误信息。

- **刷新**:通过 `GET /api/plugins` 重新加载列表。
- **启用 / 停用开关**:启用或停用插件,并以消息反馈结果。激活失败的插件会变为 `failed` 并显示错误,不影响其他插件。
- **配置**:仅对声明了 `configSchema` 的插件可用。抽屉按 schema 属性逐项渲染字段(enum → 下拉、boolean → 复选框、number、string;`array` / `object` 以 JSON 文本编辑),并提示缺失的必填项以及无效的 JSON / 数字。
  - **保存** 将配置应用到已启用的插件;**保存并启用** 则带上该配置启用尚未启用的插件。
  - **Secret** 属性以密码框呈现,由服务端掩码为 `****`,既不会返回也不会持久化;每次更新配置时都需要重新输入。

### 编写并加载插件

1. 创建 `<pluginsDir>/my-plugin/plugin.json`:
   ```json
   {
     "id": "my-plugin",
     "name": "My Plugin",
     "version": "1.0.0",
     "kind": "tool",
     "capabilities": ["example"],
     "configSchema": {
       "type": "object",
       "properties": { "token": { "type": "string", "secret": true } },
       "required": ["token"]
     }
   }
   ```
2. 添加入口 `index.ts`(或在 manifest 中用 `main` 指向它),导出 `activate` 以及可选的 `deactivate`:
   ```ts
   export default {
     activate: (config: Record<string, unknown>) => ({ token: config.token }),
     deactivate: (instance: unknown) => {},
   };
   ```
3. drivers 的 `PluginLoader` 通过 `discover()` / `load(path)` 加载它;随后可在面板中启用,或调用 `POST /api/plugins/my-plugin/enable`。

> 随附的服务端目前接入的是内存版加载器(见 [ARCHITECTURE.zh-CN.md §3.6](./ARCHITECTURE.zh-CN.md)),因此面板只管理注册到该加载器的插件;待 drivers 的 `PluginLoader` 在此注入后,目录发现与内置驱动插件(`worker-claude-code`、`worker-codex`、`worker-opencode`、`worker-mock`、`llm-heuristic`、`outbox-gh`)才会出现在面板中。

---

## 五、 多任务并发最佳实践与常见问题（FAQ）

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
