import { protocolDefaultBaseUrl } from "@super-work/core";
import type { ApiModelProtocol, CliEngineId, ModelProfileKind, SystemSetupConfig } from "@super-work/core";
import { discoverModelsFromEndpoint } from "@super-work/drivers";
import type { Context } from "hono";
import type { ServerRouteContext } from "./context.ts";

interface ListModelsBody {
  id?: string;
  kind?: ModelProfileKind;
  cliEngine?: CliEngineId;
  apiProtocol?: ApiModelProtocol;
  baseUrl?: string;
  apiKey?: string;
  useSavedKey?: boolean;
}

/** v1.8.2 POST /api/setup/models (alias /api/setup/model): live upstream model listing for the model form. */
export function registerListModelsRoute(ctx: ServerRouteContext): void {
  const handler = async (c: Context) => {
    const body = (await c.req.json().catch(() => null)) as ListModelsBody | null;
    if (!body || (body.kind !== "cli" && body.kind !== "api")) {
      return c.json({ error: "kind must be 'cli' or 'api'" }, 400);
    }
    let baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    if (baseUrl) {
      let parsed: URL;
      try {
        parsed = new URL(baseUrl);
      } catch {
        return c.json({ error: "baseUrl must be a valid http(s) URL" }, 400);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return c.json({ error: "baseUrl must use http: or https:" }, 400);
      }
    } else if (body.kind === "api") {
      baseUrl = protocolDefaultBaseUrl(body.apiProtocol ?? "openai");
    } else {
      return c.json({ error: "baseUrl is required" }, 400);
    }
    let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey && body.useSavedKey && body.id) {
      const saved = await ctx.stateStore.getSystemSetting<SystemSetupConfig>("setup_config");
      apiKey = saved?.modelProfiles?.find((p) => p.id === body.id)?.apiKey?.trim() ?? "";
    }
    return c.json(
      await discoverModelsFromEndpoint({
        kind: body.kind,
        protocol: body.apiProtocol,
        cliEngine: body.cliEngine,
        baseUrl,
        apiKey,
      }),
    );
  };
  ctx.app.post("/api/setup/models", handler);
  ctx.app.post("/api/setup/model", handler);
}
