export interface McpJsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolHost {
  getHealth(): Promise<unknown>;
  listRepos(): Promise<unknown[]>;
  clarifySpec(args: Record<string, unknown>): Promise<unknown>;
  dispatchTicket(args: Record<string, unknown>): Promise<unknown>;
  dispatchEpic(args: Record<string, unknown>): Promise<unknown>;
  listTickets(args: Record<string, unknown>): Promise<unknown>;
  getTicketDetail(args: Record<string, unknown>): Promise<unknown>;
  listInbox(args: Record<string, unknown>): Promise<unknown>;
  resolveInbox(args: Record<string, unknown>): Promise<unknown>;
  searchMemoryAndCasebook(args: Record<string, unknown>): Promise<unknown>;
  triggerRoutine(args: Record<string, unknown>): Promise<unknown>;
  managePreview(args: Record<string, unknown>): Promise<unknown>;
  analyzeImpact(args: Record<string, unknown>): Promise<unknown>;
  manageCheckpoints(args: Record<string, unknown>): Promise<unknown>;
  mutateDagNode(args: Record<string, unknown>): Promise<unknown>;
}

export const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;

export const MCP_TOOL_DEFINITIONS = [
  {
    name: "clarify_spec",
    description:
      "Pre-flight repository exploration and spec clarification: matches affected paths, prior Casebook cases, acceptance criteria, and clarifying questions before dispatching.",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string", description: "Target repository ID" },
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Raw task goal or requirement" },
        template: { type: "string", enum: ["fast", "standard", "strict"] },
        answers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional map of clarification questionId -> answer",
        },
      },
      required: ["repoId", "title", "description"],
    },
  },
  {
    name: "dispatch_ticket",
    description:
      "Create and enqueue an isolated super-work Ticket (supports cross-ticket dependsOn and optional dual-engine Arena Duel).",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        template: { type: "string", enum: ["fast", "standard", "strict"] },
        allowedPaths: { type: "array", items: { type: "string" } },
        dependsOn: { type: "array", items: { type: "string" } },
        preferredEngine: { type: "string", enum: ["auto", "claude", "codex", "opencode", "mock"] },
        arenaMode: { type: "boolean" },
        arenaCompetitorEngine: { type: "string", enum: ["claude", "codex", "opencode", "mock"] },
        tddMode: { type: "boolean" },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
      },
      required: ["repoId", "title", "description"],
    },
  },
  {
    name: "dispatch_epic",
    description:
      "Preview or create a multi-subtask Epic DAG (set previewOnly=true to inspect the plan without queuing workers).",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        template: { type: "string", enum: ["fast", "standard", "strict"] },
        epicDeliveryMode: { type: "string", enum: ["unified", "per_subtask"] },
        previewOnly: { type: "boolean" },
      },
      required: ["repoId", "title", "description"],
    },
  },
  {
    name: "list_tickets",
    description: "List super-work tickets filtered optionally by repoId or status.",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string" },
        status: { type: "string" },
      },
    },
  },
  {
    name: "get_ticket_detail",
    description:
      "Get full ticket state, StageRuns, Spill artifacts (including screenshots), git diff, HandoverDigest, and Arena candidate diffs.",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" },
      },
      required: ["ticketId"],
    },
  },
  {
    name: "list_inbox",
    description: "List Attention Inbox items awaiting or resolved by human decisions.",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string" },
        status: { type: "string", enum: ["pending", "approved", "rejected"] },
      },
    },
  },
  {
    name: "resolve_inbox",
    description:
      "Approve or reject an Attention Inbox item (supports Arena winner selection, mandate expansion, budget override, or delivery action).",
    inputSchema: {
      type: "object",
      properties: {
        inboxId: { type: "string" },
        decision: { type: "string", enum: ["approved", "rejected"] },
        note: { type: "string" },
        expandMandate: { type: "boolean" },
        arenaWinnerId: { type: "string" },
        deliveryAction: { type: "string", enum: ["local_merge", "push_and_create_pr"] },
        budgetIncreaseUsd: { type: "number" },
      },
      required: ["inboxId", "decision"],
    },
  },
  {
    name: "search_memory_and_casebook",
    description:
      "Search Chain-of-Recall FTS5 memory hits and repository Casebook episodic cases for prior solutions and reverted warnings.",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "trigger_routine",
    description: "Trigger an immediate Probe-to-Promote autonomous patrol routine run by routineId.",
    inputSchema: {
      type: "object",
      properties: {
        routineId: { type: "string" },
      },
      required: ["routineId"],
    },
  },
  {
    name: "manage_preview",
    description:
      "List, start, renew, or stop live worktree preview servers on dynamic local ports.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "start", "renew", "stop"] },
        repoId: { type: "string" },
        ticketId: { type: "string" },
        candidateId: { type: "string" },
        previewId: { type: "string" },
        ttlMinutes: { type: "number" },
      },
      required: ["action"],
    },
  },
  {
    name: "analyze_impact",
    description:
      "Compute 1-hop direct and transitive reverse-import impact radius + exported symbol signatures for repository scope paths.",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
      },
      required: ["repoId", "paths"],
    },
  },
  {
    name: "manage_checkpoints",
    description:
      "List worktree stage checkpoints, compute incremental diffs between snapshots, or restore/fork a ticket checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "diff", "restore"] },
        ticketId: { type: "string" },
        checkpointId: { type: "string" },
        baseCheckpointId: { type: "string" },
        mode: { type: "string", enum: ["in_place", "fork"] },
        prompt: { type: "string" },
        preferredEngine: { type: "string", enum: ["auto", "claude", "codex", "opencode", "mock"] },
      },
      required: ["action", "ticketId"],
    },
  },
  {
    name: "mutate_dag_node",
    description:
      "Perform live surgery on a ticket/subtask DAG node (update engine/paths/description/dependencies/TDD/breakpoint, or pause/resume/rerun).",
    inputSchema: {
      type: "object",
      properties: {
        ticketId: { type: "string" },
        action: { type: "string", enum: ["update", "pause", "resume", "rerun"] },
        title: { type: "string" },
        description: { type: "string" },
        preferredEngine: { type: "string", enum: ["auto", "claude", "codex", "opencode", "mock"] },
        allowedPaths: { type: "array", items: { type: "string" } },
        dependsOn: { type: "array", items: { type: "string" } },
        tddMode: { type: "boolean" },
        pauseBeforeRun: { type: "boolean" },
      },
      required: ["ticketId"],
    },
  },
] as const;

export const MCP_RESOURCES = [
  {
    uri: "superwork://health",
    name: "Super-Work Daemon Health & Available Engines",
    mimeType: "application/json",
    description: "Live control plane LLM provider, available worker CLIs, and queue counters.",
  },
  {
    uri: "superwork://repos",
    name: "Registered Repositories & Sandbox Configs",
    mimeType: "application/json",
    description: "All registered repositories, modes, contracts, sandbox modes, and fallback chains.",
  },
  {
    uri: "superwork://inbox/pending",
    name: "Pending Attention Inbox Items",
    mimeType: "application/json",
    description: "High-signal pending approvals, escalations, Arena tiebreaks, and Epic replans.",
  },
] as const;

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): McpJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data !== undefined ? { code, message, data } : { code, message },
  };
}

function formatToolTextResult(data: unknown, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

async function handleSingleMcpRequest(
  req: McpJsonRpcRequest,
  host: McpToolHost,
): Promise<McpJsonRpcResponse | null> {
  const hasId = req.id !== undefined;
  const id = req.id ?? null;

  if (!req || typeof req.method !== "string") {
    return jsonRpcError(id, -32600, "Invalid JSON-RPC Request");
  }

  // Notifications carry no `id` and expect no JSON-RPC response object
  if (req.method.startsWith("notifications/") || (!hasId && req.method !== "initialize")) {
    return null;
  }

  const params = (req.params ?? {}) as Record<string, unknown>;

  try {
    switch (req.method) {
      case "initialize": {
        const clientVersion = String(params.protocolVersion ?? "").trim();
        const negotiated = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(clientVersion)
          ? clientVersion
          : MCP_PROTOCOL_VERSIONS[0];
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: negotiated,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: {
              name: "super-work",
              version: "0.9.0",
            },
          },
        };
      }

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: MCP_TOOL_DEFINITIONS },
        };

      case "tools/call": {
        const name = String(params.name ?? "").trim();
        const args = (
          params.arguments && typeof params.arguments === "object" ? params.arguments : {}
        ) as Record<string, unknown>;

        if (!name) {
          return jsonRpcError(id, -32602, "Tool name is required");
        }

        try {
          let result: unknown;
          switch (name) {
            case "clarify_spec":
              result = await host.clarifySpec(args);
              break;
            case "dispatch_ticket":
              result = await host.dispatchTicket(args);
              break;
            case "dispatch_epic":
              result = await host.dispatchEpic(args);
              break;
            case "list_tickets":
              result = await host.listTickets(args);
              break;
            case "get_ticket_detail":
              result = await host.getTicketDetail(args);
              break;
            case "list_inbox":
              result = await host.listInbox(args);
              break;
            case "resolve_inbox":
              result = await host.resolveInbox(args);
              break;
            case "search_memory_and_casebook":
              result = await host.searchMemoryAndCasebook(args);
              break;
            case "trigger_routine":
              result = await host.triggerRoutine(args);
              break;
            case "manage_preview":
              result = await host.managePreview(args);
              break;
            case "analyze_impact":
              result = await host.analyzeImpact(args);
              break;
            case "manage_checkpoints":
              result = await host.manageCheckpoints(args);
              break;
            case "mutate_dag_node":
              result = await host.mutateDagNode(args);
              break;
            default:
              return jsonRpcError(id, -32601, `Unknown tool: ${name}`);
          }
          return {
            jsonrpc: "2.0",
            id,
            result: formatToolTextResult(result, false),
          };
        } catch (err) {
          return {
            jsonrpc: "2.0",
            id,
            result: formatToolTextResult(
              { error: err instanceof Error ? err.message : String(err) },
              true,
            ),
          };
        }
      }

      case "resources/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { resources: MCP_RESOURCES },
        };

      case "resources/read": {
        const uri = String(params.uri ?? "").trim();
        if (!uri) {
          return jsonRpcError(id, -32602, "Resource uri is required");
        }
        let contentObj: unknown;
        if (uri === "superwork://health") {
          contentObj = await host.getHealth();
        } else if (uri === "superwork://repos") {
          contentObj = await host.listRepos();
        } else if (uri === "superwork://inbox/pending") {
          contentObj = await host.listInbox({ status: "pending" });
        } else {
          return jsonRpcError(id, -32002, `Unknown resource URI: ${uri}`);
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(contentObj, null, 2),
              },
            ],
          },
        };
      }

      default:
        return jsonRpcError(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    return jsonRpcError(id, -32603, err instanceof Error ? err.message : String(err));
  }
}

export async function handleMcpJsonRpcMessage(
  rawMessage: unknown,
  host: McpToolHost,
): Promise<McpJsonRpcResponse | McpJsonRpcResponse[] | null> {
  if (Array.isArray(rawMessage)) {
    if (rawMessage.length === 0) {
      return jsonRpcError(null, -32600, "Empty batch");
    }
    const results: McpJsonRpcResponse[] = [];
    for (const item of rawMessage) {
      const res = await handleSingleMcpRequest(item as McpJsonRpcRequest, host);
      if (res) results.push(res);
    }
    return results.length > 0 ? results : null;
  }

  return handleSingleMcpRequest(rawMessage as McpJsonRpcRequest, host);
}
