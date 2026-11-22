import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { LlmProviderPreset, SystemSetupConfig, WorkerEngineId } from "@super-work/core";
import { nowIso } from "@super-work/core";
import {
  CliEnvironmentScanner,
  SqliteStateStore,
  testControlPlaneLLMConnection,
} from "@super-work/drivers";

const dataDir = resolve(process.env.SUPER_WORK_DATA_DIR ?? join(process.cwd(), ".super-work"));
await mkdir(dataDir, { recursive: true });
const store = new SqliteStateStore(join(dataDir, "super-work.db"));
const scanner = new CliEnvironmentScanner();

console.log("=== super-work CLI 环境扫描与初始化向导 ===\n");
const scanReport = await scanner.scanAll();
await store.setSystemSetting("last_cli_scan", scanReport);

for (const tool of scanReport.tools) {
  const state = !tool.installed
    ? "未安装"
    : tool.authenticated === false
      ? "未登录"
      : tool.authenticated === true
        ? "已就绪"
        : "已检测";
  console.log(
    `- ${tool.name.padEnd(18)} | ${state.padEnd(6)} | ${tool.version ?? "-"} | ${tool.authSummary ?? tool.binaryPath ?? "-"}`,
  );
}

console.log(
  `\n推荐引擎: 编码=${scanReport.recommendedImplementEngine}, 审查=${scanReport.recommendedReviewEngine}\n`,
);

const isAuto = process.argv.includes("--auto");
const existing = await store.getSystemSetting<SystemSetupConfig>("setup_config");

let llmPreset: LlmProviderPreset = existing?.llmPreset ?? "heuristic";
let llmBaseUrl = existing?.llmBaseUrl ?? "https://api.deepseek.com/v1";
let llmModel = existing?.llmModel ?? "deepseek-chat";
let llmApiKey = existing?.llmApiKey;
let preferredImplementEngine: WorkerEngineId = scanReport.recommendedImplementEngine;
let preferredReviewEngine: WorkerEngineId = scanReport.recommendedReviewEngine;

if (isAuto) {
  if (process.env.DEEPSEEK_API_KEY) {
    llmPreset = "deepseek";
    llmBaseUrl = process.env.SUPER_WORK_LLM_BASE_URL ?? "https://api.deepseek.com/v1";
    llmModel = process.env.SUPER_WORK_LLM_MODEL ?? "deepseek-chat";
    llmApiKey = process.env.DEEPSEEK_API_KEY;
  } else if (process.env.OPENAI_API_KEY) {
    llmPreset = "openai";
    llmBaseUrl = process.env.SUPER_WORK_LLM_BASE_URL ?? "https://api.openai.com/v1";
    llmModel = process.env.SUPER_WORK_LLM_MODEL ?? "gpt-4o-mini";
    llmApiKey = process.env.OPENAI_API_KEY;
  } else if (scanReport.tools.find((t) => t.id === "claude")?.authenticated) {
    llmPreset = "claude_cli";
  } else {
    llmPreset = "heuristic";
  }
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("请选择控制面 LLM 方案:");
    console.log("  1) DeepSeek API (https://api.deepseek.com/v1)");
    console.log("  2) OpenAI / 自定义兼容接口");
    console.log("  3) 复用本地 Claude CLI (无工具模式，零额外 Key)");
    console.log("  4) 本地启发式引擎 (免配置、零 Token 消耗)");
    const choice = (await rl.question("输入选项 [1-4，默认 4]: ")).trim() || "4";

    if (choice === "1") {
      llmPreset = "deepseek";
      llmBaseUrl =
        (await rl.question("Base URL [https://api.deepseek.com/v1]: ")).trim() ||
        "https://api.deepseek.com/v1";
      llmModel = (await rl.question("Model [deepseek-chat]: ")).trim() || "deepseek-chat";
      const key = (await rl.question("API Key (留空保留已有或跳过): ")).trim();
      if (key) llmApiKey = key;
    } else if (choice === "2") {
      llmPreset = "openai";
      llmBaseUrl =
        (await rl.question("Base URL [https://api.openai.com/v1]: ")).trim() ||
        "https://api.openai.com/v1";
      llmModel = (await rl.question("Model [gpt-4o-mini]: ")).trim() || "gpt-4o-mini";
      const key = (await rl.question("API Key: ")).trim();
      if (key) llmApiKey = key;
    } else if (choice === "3") {
      llmPreset = "claude_cli";
      llmBaseUrl = "";
      llmModel = "claude-cli";
    } else {
      llmPreset = "heuristic";
      llmBaseUrl = "";
      llmModel = "heuristic";
    }

    const implAns = (
      await rl.question(`默认编码引擎 [${preferredImplementEngine}]: `)
    ).trim() as WorkerEngineId;
    if (implAns) preferredImplementEngine = implAns;

    const revAns = (
      await rl.question(`默认审查引擎 [${preferredReviewEngine}]: `)
    ).trim() as WorkerEngineId;
    if (revAns) preferredReviewEngine = revAns;
  } finally {
    rl.close();
  }
}

const probe = await testControlPlaneLLMConnection({
  llmPreset,
  llmBaseUrl,
  llmModel,
  llmApiKey,
});
console.log(`\n连接检测: ${probe.ok ? "通过" : "提示"} — ${probe.message}`);

const nextConfig: SystemSetupConfig = {
  initialized: true,
  llmPreset,
  llmBaseUrl,
  llmModel,
  llmEffort: existing?.llmEffort ?? "low",
  llmApiKey,
  preferredImplementEngine,
  preferredReviewEngine,
  claudeProfile: existing?.claudeProfile ?? {},
  codexProfile: existing?.codexProfile ?? {},
  opencodeProfile: existing?.opencodeProfile ?? {},
  updatedAt: nowIso(),
};
await store.setSystemSetting("setup_config", nextConfig);

const repos = await store.listRepos();
for (const repo of repos) {
  await store.upsertRepo({
    ...repo,
    preferredImplementEngine,
    preferredReviewEngine,
    updatedAt: nowIso(),
  });
}

console.log(`已保存配置至 ${join(dataDir, "super-work.db")} (provider=${probe.providerName})`);
store.close();
