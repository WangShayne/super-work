export type ControlProbeToolName =
  | "search_symbols"
  | "read_file_slice"
  | "grep_literals"
  | "git_recent_commits";

export interface ControlProbeRequest {
  tool: ControlProbeToolName;
  path?: string;
  query?: string;
  startLine?: number;
  endLine?: number;
  limit?: number;
}

export interface ControlProbeStep {
  step: number;
  tool: ControlProbeToolName;
  inputSummary: string;
  outputSummary: string;
  matchedPaths: string[];
  durationMs: number;
}

export interface RepoProbeContextPack {
  deterministicSummary: string;
  matchedFiles: string[];
  recentCommits: string[];
  probeSteps: ControlProbeStep[];
}
