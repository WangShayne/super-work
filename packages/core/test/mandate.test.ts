import { describe, expect, it } from "bun:test";
import {
  createDefaultMandate,
  mandateScopesOverlap,
  matchesPathScope,
  validateChangedFilesAgainstMandate,
} from "../src/mandate.ts";

describe("Mandate scope & guardrail enforcement", () => {
  it("matches explicit files, directory prefixes, and globs accurately", () => {
    expect(matchesPathScope("packages/core/src/index.ts", ["packages/core"])).toBe(true);
    expect(matchesPathScope("./packages/core/src/index.ts", ["packages/core/**"])).toBe(true);
    expect(matchesPathScope("packages/web/src/App.tsx", ["packages/core/**"])).toBe(false);
    expect(matchesPathScope("src/auth/login.ts", ["src/auth"])).toBe(true);
    expect(matchesPathScope("src/auth2/login.ts", ["src/auth"])).toBe(false);
  });

  it("blocks forbidden secrets and distinguishes forbiddenViolations vs scopeViolations", () => {
    const mandate = createDefaultMandate({ allowedPaths: ["packages/core/**"] });
    const res = validateChangedFilesAgainstMandate(
      ["packages/core/src/kernel.ts", ".env.local", "packages/web/src/App.tsx", "certs/dev.key"],
      mandate,
    );
    expect(res.ok).toBe(false);
    expect(res.violations).toEqual([".env.local", "packages/web/src/App.tsx", "certs/dev.key"]);
    expect(res.forbiddenViolations).toEqual([".env.local", "certs/dev.key"]);
    expect(res.scopeViolations).toEqual(["packages/web/src/App.tsx"]);
  });

  it("passes when all files stay inside allowedPaths and outside forbiddenPaths", () => {
    const mandate = createDefaultMandate({ allowedPaths: ["packages/core/**"] });
    const res = validateChangedFilesAgainstMandate(
      ["packages/core/src/kernel.ts", "packages/core/test/mandate.test.ts"],
      mandate,
    );
    expect(res.ok).toBe(true);
    expect(res.violations).toEqual([]);
  });

  it("detects overlapping vs disjoint Mandate scopes for concurrency serialization", () => {
    const core = createDefaultMandate({ allowedPaths: ["packages/core/**"] });
    const web = createDefaultMandate({ allowedPaths: ["packages/web/**"] });
    const coreKernel = createDefaultMandate({ allowedPaths: ["packages/core/src/kernel.ts"] });
    const rootAll = createDefaultMandate({ allowedPaths: ["**"] });
    const auth = createDefaultMandate({ allowedPaths: ["src/auth"] });
    const auth2 = createDefaultMandate({ allowedPaths: ["src/auth2"] });
    const topTs = createDefaultMandate({ allowedPaths: ["packages/*.ts"] });

    expect(mandateScopesOverlap(core, web)).toBe(false);
    expect(mandateScopesOverlap(auth, auth2)).toBe(false);
    expect(mandateScopesOverlap(topTs, core)).toBe(false);
    expect(mandateScopesOverlap(core, coreKernel)).toBe(true);
    expect(mandateScopesOverlap(core, rootAll)).toBe(true);
  });
});
