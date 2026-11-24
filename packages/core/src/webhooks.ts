import { createHmac, timingSafeEqual } from "node:crypto";
import type { IngestTriggerInput } from "./ports.ts";
import type { InboxItemKind, RepoConfig } from "./types.ts";

export interface ActionTokenPayload {
  inboxId: string;
  ticketId: string;
  repoId: string;
  kind: InboxItemKind;
  exp: number;
}

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const mod = padded.length % 4;
  const full = mod === 0 ? padded : padded + "=".repeat(4 - mod);
  return Buffer.from(full, "base64").toString("utf8");
}

function constantTimeHexEqual(aHex: string, bHex: string): boolean {
  const a = aHex.trim().toLowerCase();
  const b = bHex.trim().toLowerCase();
  if (!a || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

export function computeHmacSha256Hex(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

export function verifyWebhookHmacSha256(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  const cleanSecret = secret.trim();
  const cleanHeader = (signatureHeader ?? "").trim();
  if (!cleanSecret || !cleanHeader) return false;
  const providedHex = cleanHeader.startsWith("sha256=") ? cleanHeader.slice(7) : cleanHeader;
  const expectedHex = computeHmacSha256Hex(rawBody, cleanSecret);
  return constantTimeHexEqual(providedHex, expectedHex);
}

export function signActionToken(payload: ActionTokenPayload, secret: string): string {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const sig = computeHmacSha256Hex(encodedPayload, secret.trim());
  return `${encodedPayload}.${sig}`;
}

export function verifyActionToken(
  token: string,
  secret: string,
  nowMs = Date.now(),
): { valid: true; payload: ActionTokenPayload } | { valid: false; reason: string } {
  const cleanSecret = secret.trim();
  if (!cleanSecret) {
    return { valid: false, reason: "Action signing secret is not configured" };
  }
  const parts = token.trim().split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: "Malformed action token" };
  }
  const [encodedPayload, providedSig] = parts;
  const expectedSig = computeHmacSha256Hex(encodedPayload, cleanSecret);
  if (!constantTimeHexEqual(providedSig, expectedSig)) {
    return { valid: false, reason: "Invalid action token signature" };
  }

  try {
    const parsed = JSON.parse(fromBase64Url(encodedPayload)) as Partial<ActionTokenPayload>;
    if (!parsed.inboxId || !parsed.ticketId || !parsed.repoId || !parsed.kind) {
      return { valid: false, reason: "Incomplete action token payload" };
    }
    if (typeof parsed.exp !== "number" || nowMs > parsed.exp) {
      return { valid: false, reason: "Action token has expired" };
    }
    return { valid: true, payload: parsed as ActionTokenPayload };
  } catch {
    return { valid: false, reason: "Corrupted action token payload" };
  }
}

export function normalizeGithubRepoSlug(raw?: string): string {
  if (!raw) return "";
  return raw
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

export function parseGithubWebhookEvent(
  eventName: string,
  payload: Record<string, unknown>,
  repos: RepoConfig[],
  explicitRepoId?: string,
): { matchedRepo?: RepoConfig; trigger?: IngestTriggerInput; ignoredReason?: string } {
  const repository = (payload.repository ?? {}) as Record<string, unknown>;
  const repoSlug = normalizeGithubRepoSlug(String(repository.full_name ?? ""));
  const repoName = String(repository.name ?? "").trim().toLowerCase();

  let matchedRepo: RepoConfig | undefined;
  if (explicitRepoId) {
    matchedRepo = repos.find((r) => r.id === explicitRepoId);
  }
  if (!matchedRepo && repoSlug) {
    matchedRepo = repos.find((r) => normalizeGithubRepoSlug(r.githubRepo) === repoSlug);
  }
  if (!matchedRepo && repoName) {
    matchedRepo = repos.find((r) => r.name.trim().toLowerCase() === repoName);
  }
  if (!matchedRepo) {
    return {
      ignoredReason: `No registered repo matches webhook repository '${repoSlug || explicitRepoId || "unknown"}'`,
    };
  }

  const ev = eventName.trim().toLowerCase();
  const action = String(payload.action ?? "").trim().toLowerCase();

  if (ev === "issues") {
    if (action !== "opened" && action !== "reopened" && action !== "labeled") {
      return { matchedRepo, ignoredReason: `Ignored issues action '${action}'` };
    }
    const issue = (payload.issue ?? {}) as Record<string, unknown>;
    const num = Number(issue.number ?? 0);
    if (!num) return { matchedRepo, ignoredReason: "Missing issue.number" };
    const title = String(issue.title ?? `GitHub Issue #${num}`);
    const body = String(issue.body ?? title);
    const author = String(((issue.user ?? {}) as Record<string, unknown>).login ?? "github");
    return {
      matchedRepo,
      trigger: {
        repoId: matchedRepo.id,
        source: "github_issue",
        externalRef: `github:issue:${num}:${action}:${String(issue.updated_at ?? "")}`,
        threadKey: `github:issue:${num}`,
        title: `#${num} ${title}`,
        rawText: body,
        payload: {
          webhookEvent: ev,
          action,
          issueNumber: num,
          author,
          url: issue.html_url,
        },
      },
    };
  }

  if (ev === "issue_comment") {
    if (action !== "created") {
      return { matchedRepo, ignoredReason: `Ignored issue_comment action '${action}'` };
    }
    const issue = (payload.issue ?? {}) as Record<string, unknown>;
    const comment = (payload.comment ?? {}) as Record<string, unknown>;
    const body = String(comment.body ?? "").trim();
    if (!body || body.startsWith("[super-work]")) {
      return { matchedRepo, ignoredReason: "Empty or self-emitted super-work comment" };
    }
    const num = Number(issue.number ?? 0);
    if (!num) return { matchedRepo, ignoredReason: "Missing issue.number" };
    const isPr = Boolean(issue.pull_request);
    const commentId = String(comment.id ?? Date.now());
    const author = String(((comment.user ?? {}) as Record<string, unknown>).login ?? "github");
    return {
      matchedRepo,
      trigger: {
        repoId: matchedRepo.id,
        source: isPr ? "github_pr" : "github_issue",
        externalRef: `github:comment:${commentId}`,
        threadKey: isPr ? `github:pr:${num}` : `github:issue:${num}`,
        title: `Comment on #${num}: ${String(issue.title ?? "")}`.trim(),
        rawText: `@${author}: ${body}`,
        payload: {
          webhookEvent: ev,
          action,
          number: num,
          commentId,
          author,
          url: comment.html_url,
        },
      },
    };
  }

  if (ev === "pull_request_review") {
    if (action !== "submitted") {
      return { matchedRepo, ignoredReason: `Ignored pull_request_review action '${action}'` };
    }
    const pr = (payload.pull_request ?? {}) as Record<string, unknown>;
    const review = (payload.review ?? {}) as Record<string, unknown>;
    const state = String(review.state ?? "").toLowerCase();
    const body = String(review.body ?? "").trim();
    if (state === "approved" && !body) {
      return { matchedRepo, ignoredReason: "Ignored empty PR approval review" };
    }
    const num = Number(pr.number ?? 0);
    if (!num) return { matchedRepo, ignoredReason: "Missing pull_request.number" };
    const reviewId = String(review.id ?? Date.now());
    const author = String(((review.user ?? {}) as Record<string, unknown>).login ?? "reviewer");
    return {
      matchedRepo,
      trigger: {
        repoId: matchedRepo.id,
        source: "github_pr",
        externalRef: `github:pr_review:${reviewId}`,
        threadKey: `github:pr:${num}`,
        title: `PR #${num} review (${state || "comment"}): ${String(pr.title ?? "")}`.trim(),
        rawText: body || `Review state: ${state}`,
        payload: {
          webhookEvent: ev,
          prNumber: num,
          reviewId,
          state,
          author,
          url: review.html_url,
        },
      },
    };
  }

  if (ev === "check_run" || ev === "workflow_run") {
    if (action !== "completed") {
      return { matchedRepo, ignoredReason: `Ignored ${ev} action '${action}'` };
    }
    const obj = (ev === "check_run" ? payload.check_run : payload.workflow_run) as
      | Record<string, unknown>
      | undefined;
    if (!obj) return { matchedRepo, ignoredReason: `Missing ${ev} payload` };
    const conclusion = String(obj.conclusion ?? "").toLowerCase();
    if (conclusion !== "failure" && conclusion !== "timed_out" && conclusion !== "action_required") {
      return { matchedRepo, ignoredReason: `Ignored ${ev} conclusion '${conclusion}'` };
    }
    const prs = Array.isArray(obj.pull_requests) ? (obj.pull_requests as Array<Record<string, unknown>>) : [];
    const prNum = Number(prs[0]?.number ?? 0);
    const runId = String(obj.id ?? Date.now());
    const name = String(obj.name ?? ev);
    const headBranch = String(
      obj.head_branch ??
        ((obj.check_suite as Record<string, unknown> | undefined)?.head_branch ?? "unknown"),
    );
    const output = (obj.output ?? {}) as Record<string, unknown>;
    const summaryText = [
      `CI ${ev} '${name}' ended with ${conclusion} on branch '${headBranch}'.`,
      output.title ? `Title: ${String(output.title)}` : "",
      output.summary ? `Summary: ${String(output.summary)}` : "",
      obj.html_url ? `Details: ${String(obj.html_url)}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    return {
      matchedRepo,
      trigger: {
        repoId: matchedRepo.id,
        source: "github_ci",
        externalRef: `github:${ev}:${runId}`,
        threadKey: prNum ? `github:pr:${prNum}` : `github:ci:${headBranch}:${runId}`,
        title: `CI failure: ${name}${prNum ? ` (PR #${prNum})` : ""}`,
        rawText: summaryText,
        payload: {
          webhookEvent: ev,
          runId,
          conclusion,
          prNumber: prNum || undefined,
          headBranch,
          url: obj.html_url,
        },
      },
    };
  }

  return { matchedRepo, ignoredReason: `Unsupported GitHub webhook event '${ev}'` };
}
