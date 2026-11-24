import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { CliEnvironmentScanner, type CliCommandRunner } from "../src/index.ts";

describe("CliEnvironmentScanner", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const d of tempDirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });
  it("parses installed & authenticated CLIs and recommends claude/codex engines", async () => {
    const fakeRunner: CliCommandRunner = async (cmd) => {
      const bin = cmd[0] ?? "";
      const sub = cmd.slice(1).join(" ");

      if (bin.endsWith("claude")) {
        if (sub === "--version") return { exitCode: 0, stdout: "2.1.318 (Claude Code)", stderr: "" };
        if (sub === "auth status --json") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              loggedIn: true,
              authMethod: "oauth_token",
              apiProvider: "firstParty",
            }),
            stderr: "",
          };
        }
      }
      if (bin.endsWith("codex")) {
        if (sub === "--version") return { exitCode: 0, stdout: "codex-cli 0.166.0", stderr: "" };
        if (sub === "login status") return { exitCode: 0, stdout: "Logged in using ChatGPT", stderr: "" };
      }
      if (bin.endsWith("opencode")) {
        if (sub === "--version") return { exitCode: 0, stdout: "opencode v2.1.2", stderr: "" };
        if (sub.startsWith("auth list")) return { exitCode: 0, stdout: "[]", stderr: "" };
      }
      if (bin.endsWith("gemini")) {
        if (sub === "--version") return { exitCode: 0, stdout: "0.66.0", stderr: "" };
      }
      if (bin.endsWith("gh")) {
        if (sub === "--version") return { exitCode: 0, stdout: "gh version 2.96.0", stderr: "" };
        if (sub === "auth status") {
          return {
            exitCode: 0,
            stdout: "",
            stderr: "github.com\n  ✓ Logged in to github.com account WangShayne (keyring)",
          };
        }
      }
      if (bin.endsWith("git")) {
        if (sub === "--version") return { exitCode: 0, stdout: "git version 2.50.1", stderr: "" };
        if (sub === "config user.name") return { exitCode: 0, stdout: "Shayne Wang", stderr: "" };
      }
      if (bin.endsWith("bun")) {
        return { exitCode: 0, stdout: "1.3.10", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected" };
    };

    const emptyHome = await mkdtemp(join(tmpdir(), "sw-empty-home-"));
    tempDirs.push(emptyHome);

    const scanner = new CliEnvironmentScanner({
      homeDir: emptyHome,
      runCmd: fakeRunner,
      which: (bin) => `/usr/local/bin/${bin}`,
    });

    const report = await scanner.scanAll();
    expect(report.tools).toHaveLength(7);
    expect(report.recommendedImplementEngine).toBe("claude");
    expect(report.recommendedReviewEngine).toBe("codex");

    const claude = report.tools.find((t) => t.id === "claude")!;
    expect(claude.installed).toBe(true);
    expect(claude.authenticated).toBe(true);
    expect(claude.authSummary).toBe("oauth_token / firstParty");

    const gh = report.tools.find((t) => t.id === "gh")!;
    expect(gh.authenticated).toBe(true);
    expect(gh.authSummary).toBe("account WangShayne");
  });

  it("handles missing/unauthenticated CLIs and falls back to mock recommendations", async () => {
    const fakeRunner: CliCommandRunner = async (cmd) => {
      if (cmd[0]?.endsWith("claude") && cmd[1] === "auth") {
        return { exitCode: 1, stdout: JSON.stringify({ loggedIn: false }), stderr: "" };
      }
      if (cmd[0]?.endsWith("git") && cmd[1] === "config") {
        return { exitCode: 1, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "1.0.0", stderr: "" };
    };

    const emptyHome = await mkdtemp(join(tmpdir(), "sw-empty-home-"));
    tempDirs.push(emptyHome);

    const scanner = new CliEnvironmentScanner({
      homeDir: emptyHome,
      runCmd: fakeRunner,
      which: (bin) => (bin === "codex" ? null : `/bin/${bin}`),
    });

    const report = await scanner.scanAll();
    const claude = report.tools.find((t) => t.id === "claude")!;
    const codex = report.tools.find((t) => t.id === "codex")!;
    const git = report.tools.find((t) => t.id === "git")!;

    expect(claude.installed).toBe(true);
    expect(claude.authenticated).toBe(false);
    expect(codex.installed).toBe(false);
    expect(git.authenticated).toBe(false);
    // claude is installed even if unauthenticated, so it falls back to installed claude for implement
    expect(report.recommendedImplementEngine).toBe("claude");
  });

  it("extracts local default model and reasoning effort from ~/.claude/settings.json, ~/.codex/config.toml, and ~/.config/opencode", async () => {
    const home = await mkdtemp(join(tmpdir(), "sw-home-"));
    tempDirs.push(home);
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".config", "opencode"), { recursive: true });
    await mkdir(join(home, ".local", "state", "opencode"), { recursive: true });

    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ model: "sonnet", effortLevel: "high", secretToken: "ignore-me" }),
      "utf8",
    );
    await writeFile(
      join(home, ".codex", "config.toml"),
      [
        'model = "gpt-5.6-sol"',
        'model_reasoning_effort = "xhigh"',
        "[projects]",
        'model = "should-ignore-section"',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({
        model: "openai/gpt-5.6-sol",
        provider: { openai: { options: { apiKey: "secret-should-not-leak" } }, anthropic: {} },
      }),
      "utf8",
    );
    await writeFile(
      join(home, ".local", "state", "opencode", "model.json"),
      JSON.stringify({
        recent: ["openai/gpt-5.6-sol"],
        variant: { "openai/gpt-5.6-sol": "xhigh" },
      }),
      "utf8",
    );

    const scanner = new CliEnvironmentScanner({
      homeDir: home,
      which: (bin) => `/usr/bin/${bin}`,
      runCmd: async (cmd) => {
        if (cmd[0]?.endsWith("claude") && cmd.includes("--json")) {
          return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: "" };
        }
        if (cmd[0]?.endsWith("opencode") && cmd.includes("--format")) {
          return { exitCode: 0, stdout: "[]", stderr: "" };
        }
        return { exitCode: 0, stdout: "1.0.0", stderr: "" };
      },
    });

    const report = await scanner.scanAll();
    const claude = report.tools.find((t) => t.id === "claude")!;
    const codex = report.tools.find((t) => t.id === "codex")!;
    const opencode = report.tools.find((t) => t.id === "opencode")!;

    expect(claude.localDefaultModel).toBe("sonnet");
    expect(claude.localDefaultEffort).toBe("high");
    expect(codex.localDefaultModel).toBe("gpt-5.6-sol");
    expect(codex.localDefaultEffort).toBe("xhigh");
    expect(opencode.workerSupported).toBe(true);
    expect(opencode.authenticated).toBe(true);
    expect(opencode.authSummary).toBe("providers: openai, anthropic");
    expect(opencode.localDefaultModel).toBe("openai/gpt-5.6-sol");
    expect(opencode.localDefaultEffort).toBe("xhigh");
  });
});
