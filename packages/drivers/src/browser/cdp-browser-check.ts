import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BrowserCheckConfig,
  BrowserCheckSummary,
  BrowserRouteCheckResult,
} from "@super-work/core";
import { spawn } from "node:child_process";

export interface BrowserCheckExecutionResult {
  summary: BrowserCheckSummary;
  rawScreenshots: Array<{ routeIndex: number; path: string; bytes: Uint8Array }>;
}

const DEFAULT_BROWSER_PATHS_DARWIN = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const DEFAULT_BROWSER_NAMES = [
  "google-chrome",
  "chromium",
  "chromium-browser",
  "chrome",
  "brave-browser",
];

export function detectLocalBrowserBinary(customPath?: string): string | null {
  const envPath = customPath?.trim() || process.env.SUPER_WORK_CHROME_PATH?.trim();
  if (envPath && (existsSync(envPath) || Bun.which(envPath))) {
    return Bun.which(envPath) ?? envPath;
  }
  if (process.platform === "darwin") {
    for (const candidate of DEFAULT_BROWSER_PATHS_DARWIN) {
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const name of DEFAULT_BROWSER_NAMES) {
    const found = Bun.which(name);
    if (found) return found;
  }
  return null;
}

class MinimalCdpClient {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private eventListeners = new Set<(method: string, params: Record<string, unknown>) => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
          result?: Record<string, unknown>;
          error?: { code?: number; message?: string };
        };
        if (typeof msg.id === "number") {
          const entry = this.pending.get(msg.id);
          if (entry) {
            this.pending.delete(msg.id);
            if (msg.error) {
              entry.reject(new Error(msg.error.message ?? `CDP error ${msg.error.code ?? ""}`));
            } else {
              entry.resolve(msg.result ?? {});
            }
          }
          return;
        }
        if (msg.method) {
          for (const listener of this.eventListeners) {
            listener(msg.method, msg.params ?? {});
          }
        }
      } catch {
        // Ignore malformed CDP frames
      }
    });
  }

  static connect(wsUrl: string, timeoutMs = 8_000): Promise<MinimalCdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new Error(`Timed out connecting to CDP WebSocket (${wsUrl})`));
      }, timeoutMs);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new MinimalCdpClient(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`Failed connecting to CDP WebSocket (${wsUrl})`));
      });
    });
  }

  onEvent(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });

      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  close(): void {
    for (const entry of this.pending.values()) {
      entry.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

export async function runCdpBrowserCheck(
  baseUrl: string,
  config: BrowserCheckConfig,
  options?: {
    chromeBinaryPath?: string;
    cdpWsUrlOverride?: string;
  },
): Promise<BrowserCheckExecutionResult> {
  const routes =
    config.paths && config.paths.length > 0
      ? config.paths.map((p) => (p.startsWith("/") ? p : `/${p}`))
      : ["/"];
  const viewportWidth = Math.max(320, Math.min(2560, config.viewportWidth ?? 1440));
  const viewportHeight = Math.max(240, Math.min(2000, config.viewportHeight ?? 900));
  const timeoutMs = Math.max(2_000, Math.min(60_000, config.timeoutMs ?? 15_000));

  let browserWsUrl = options?.cdpWsUrlOverride;
  let userDataDir: string | null = null;
  let child: ReturnType<typeof spawn> | null = null;

  if (!browserWsUrl) {
    const bin = detectLocalBrowserBinary(options?.chromeBinaryPath);
    if (!bin) {
      return {
        summary: {
          executed: false,
          skippedReason: "No local Chrome/Chromium/Brave binary detected",
          ok: true,
          routes: [],
          summary: "Browser check skipped cleanly (no local Chromium binary found)",
        },
        rawScreenshots: [],
      };
    }

    userDataDir = await mkdtemp(join(tmpdir(), "sw-cdp-profile-"));
    child = spawn(
      bin,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-extensions",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank",
      ],
      {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    browserWsUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
      let errBuf = "";
      const timer = setTimeout(() => {
        rejectUrl(new Error(`Timed out waiting for headless browser DevTools endpoint: ${errBuf.slice(-400)}`));
      }, 10_000);

      child?.once("exit", (code) => {
        clearTimeout(timer);
        rejectUrl(new Error(`Headless browser exited early (code=${code}): ${errBuf.slice(-400)}`));
      });
      child?.once("error", (err) => {
        clearTimeout(timer);
        rejectUrl(err);
      });
      child?.stderr?.on("data", (chunk: Buffer | string) => {
        errBuf += String(chunk);
        const match = errBuf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match && match[1]) {
          clearTimeout(timer);
          resolveUrl(match[1]);
        }
      });
    });
  }

  let client: MinimalCdpClient | null = null;
  const rawScreenshots: Array<{ routeIndex: number; path: string; bytes: Uint8Array }> = [];
  const routeResults: BrowserRouteCheckResult[] = [];

  try {
    client = await MinimalCdpClient.connect(browserWsUrl, timeoutMs);

    // Attach to a clean page target (or reuse first target when talking directly to a page WS)
    let sessionId: string | undefined;
    if (browserWsUrl.includes("/devtools/browser")) {
      const targetRes = await client.send("Target.createTarget", { url: "about:blank" });
      const targetId = String(targetRes.targetId ?? "");
      if (!targetId) {
        throw new Error("CDP Target.createTarget did not return a targetId");
      }
      const attachRes = await client.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      sessionId = typeof attachRes.sessionId === "string" ? attachRes.sessionId : undefined;
    }

    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Network.enable", {}, sessionId);
    await client.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: viewportWidth,
        height: viewportHeight,
        deviceScaleFactor: 1,
        mobile: false,
      },
      sessionId,
    );

    const normalizedBase = baseUrl.replace(/\/+$/, "");

    for (let i = 0; i < routes.length; i += 1) {
      const routePath = routes[i]!;
      const targetUrl = `${normalizedBase}${routePath}`;
      const started = Date.now();

      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      const failedRequests: string[] = [];
      let mainDocStatus: number | undefined;
      let loadedResolve!: () => void;
      const loadedPromise = new Promise<void>((res) => {
        loadedResolve = res;
      });

      const unsubscribe = client.onEvent((method, params) => {
        if (method === "Page.loadEventFired") {
          loadedResolve();
          return;
        }
        if (method === "Runtime.exceptionThrown") {
          const details = (params.exceptionDetails ?? {}) as Record<string, unknown>;
          const exc = (details.exception ?? {}) as Record<string, unknown>;
          const msg = String(exc.description ?? details.text ?? "Uncaught page exception");
          pageErrors.push(msg.slice(0, 300));
          return;
        }
        if (method === "Runtime.consoleAPICalled") {
          if (params.type === "error") {
            const args = Array.isArray(params.args)
              ? (params.args as Array<Record<string, unknown>>)
              : [];
            const text = args
              .map((a) => String(a.value ?? a.description ?? ""))
              .filter(Boolean)
              .join(" ");
            if (text) consoleErrors.push(text.slice(0, 300));
          }
          return;
        }
        if (method === "Network.responseReceived") {
          const resp = (params.response ?? {}) as Record<string, unknown>;
          const status = Number(resp.status ?? 0);
          const url = String(resp.url ?? "");
          if (url === targetUrl || url === `${targetUrl}/`) {
            mainDocStatus = status;
          }
          if (status >= 500) {
            failedRequests.push(`${status} ${url}`);
          }
        }
      });

      try {
        await client.send("Page.navigate", { url: targetUrl }, sessionId, timeoutMs);
        await Promise.race([
          loadedPromise,
          new Promise<void>((r) => setTimeout(r, Math.min(timeoutMs, 6_000))),
        ]);
        await new Promise<void>((r) => setTimeout(r, 150));

        let missingSelector: string | undefined;
        if (config.waitForSelector?.trim()) {
          const selector = config.waitForSelector.trim();
          const evalRes = await client.send(
            "Runtime.evaluate",
            {
              expression: `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
              returnByValue: true,
            },
            sessionId,
          );
          const value = (evalRes.result as { value?: unknown } | undefined)?.value;
          if (!value) {
            missingSelector = selector;
          }
        }

        const stepErrors: string[] = [];
        if (config.steps && config.steps.length > 0 && (i === 0 || routes.length === 1)) {
          for (const step of config.steps) {
            const stepTimeout = Math.max(200, Math.min(timeoutMs, step.timeoutMs ?? 3_000));
            const selJson = JSON.stringify(step.selector ?? "");
            const valJson = JSON.stringify(step.value ?? "");
            const actionJson = JSON.stringify(step.action);
            const expr = `(async () => {
              const action = ${actionJson};
              const sel = ${selJson};
              const val = ${valJson};
              const deadline = Date.now() + ${stepTimeout};
              const findEl = () => sel ? document.querySelector(sel) : null;
              if (action === "waitForSelector") {
                while (Date.now() < deadline) {
                  if (findEl()) return { ok: true };
                  await new Promise((r) => setTimeout(r, 40));
                }
                return { ok: false, error: "waitForSelector timeout: " + sel };
              }
              if (action === "waitForText") {
                while (Date.now() < deadline) {
                  const targetEl = sel ? findEl() : document.body;
                  const txt = targetEl ? (targetEl.innerText || targetEl.textContent || "") : "";
                  if (txt.includes(val)) return { ok: true };
                  await new Promise((r) => setTimeout(r, 40));
                }
                return { ok: false, error: "waitForText timeout: " + val };
              }
              if (action === "click") {
                let el = null;
                while (Date.now() < deadline) {
                  el = findEl();
                  if (el) break;
                  await new Promise((r) => setTimeout(r, 40));
                }
                if (!el) return { ok: false, error: "click target not found: " + sel };
                el.click();
                return { ok: true };
              }
              if (action === "fill") {
                let el = null;
                while (Date.now() < deadline) {
                  el = findEl();
                  if (el) break;
                  await new Promise((r) => setTimeout(r, 40));
                }
                if (!el) return { ok: false, error: "fill target not found: " + sel };
                const proto = el instanceof HTMLTextAreaElement
                  ? HTMLTextAreaElement.prototype
                  : el instanceof HTMLInputElement
                    ? HTMLInputElement.prototype
                    : null;
                const desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
                if (desc && desc.set) desc.set.call(el, val);
                else el.value = val;
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                return { ok: true };
              }
              if (action === "press") {
                const el = (sel ? findEl() : document.activeElement) || document.body;
                if (!el) return { ok: false, error: "press target not found: " + sel };
                el.dispatchEvent(new KeyboardEvent("keydown", { key: val || "Enter", bubbles: true }));
                el.dispatchEvent(new KeyboardEvent("keyup", { key: val || "Enter", bubbles: true }));
                return { ok: true };
              }
              return { ok: false, error: "Unknown step action: " + action };
            })()`;
            try {
              const stepRes = await client.send(
                "Runtime.evaluate",
                { expression: expr, awaitPromise: true, returnByValue: true },
                sessionId,
                stepTimeout + 2_000,
              );
              const valObj = (stepRes.result as { value?: unknown } | undefined)?.value;
              if (stepRes.exceptionDetails) {
                stepErrors.push(`${step.action}(${step.selector ?? step.value ?? ""}): exception`);
                break;
              }
              if (valObj === false) {
                stepErrors.push(`${step.action}(${step.selector ?? step.value ?? ""}): failed`);
                break;
              }
              if (valObj && typeof valObj === "object" && (valObj as { ok?: boolean }).ok === false) {
                stepErrors.push(
                  String((valObj as { error?: string }).error ?? `${step.action} failed`),
                );
                break;
              }
            } catch (err) {
              stepErrors.push(
                `${step.action}: ${err instanceof Error ? err.message : String(err)}`,
              );
              break;
            }
          }
          await new Promise<void>((r) => setTimeout(r, 120));
        }

        const shot = await client.send(
          "Page.captureScreenshot",
          { format: "png" },
          sessionId,
          timeoutMs,
        );
        if (typeof shot.data === "string" && shot.data.length > 0) {
          rawScreenshots.push({
            routeIndex: i,
            path: routePath,
            bytes: new Uint8Array(Buffer.from(shot.data, "base64")),
          });
        }

        const routeOk =
          pageErrors.length === 0 &&
          failedRequests.length === 0 &&
          stepErrors.length === 0 &&
          !missingSelector &&
          (mainDocStatus === undefined || mainDocStatus < 500) &&
          (!config.failOnConsoleError || consoleErrors.length === 0);

        routeResults.push({
          path: routePath,
          url: targetUrl,
          ok: routeOk,
          status: mainDocStatus,
          consoleErrors,
          pageErrors,
          failedRequests,
          ...(stepErrors.length > 0 ? { stepErrors } : {}),
          missingSelector,
          durationMs: Math.max(1, Date.now() - started),
        });
      } finally {
        unsubscribe();
      }
    }

    const ok = routeResults.every((r) => r.ok);
    const failedRoutes = routeResults.filter((r) => !r.ok);
    const summaryText = ok
      ? `Browser gate passed across ${routeResults.length} route(s)`
      : `Browser gate failed on ${failedRoutes
          .map((r) => {
            const errs = [
              ...r.pageErrors,
              ...r.failedRequests,
              ...(r.stepErrors ?? []),
              ...(r.missingSelector ? [`missing selector ${r.missingSelector}`] : []),
              ...(config.failOnConsoleError ? r.consoleErrors : []),
            ];
            return `${r.path} (${errs.slice(0, 2).join("; ") || "route error"})`;
          })
          .join(", ")}`;

    return {
      summary: {
        executed: true,
        ok,
        routes: routeResults,
        summary: summaryText,
      },
      rawScreenshots,
    };
  } finally {
    client?.close();
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      setTimeout(() => {
        if (child?.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // ignore
          }
        }
      }, 600).unref();
    }
    if (userDataDir) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
