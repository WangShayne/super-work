import type { RequirementRouteKind } from "./autonomy.ts";

export type MilestoneStatus = "active" | "ready_to_release" | "released" | "cancelled";

export interface MilestoneItem {
  id: string;
  index: number;
  requirement: string;
  title: string;
  route: RequirementRouteKind;
  ticketId?: string;
  epicId?: string;
  campaignId?: string;
  waveIndex: number;
  allowedPaths: string[];
  dependsOnIndices: number[];
  status: "pending" | "running" | "delivered" | "failed" | "needs_human";
  summary?: string;
}

export type MilestoneIntegrationMode = "direct_main" | "milestone_branch";

export interface Milestone {
  id: string;
  repoId: string;
  name: string;
  targetVersion?: string;
  integrationMode?: MilestoneIntegrationMode;
  stagingBranch?: string;
  status: MilestoneStatus;
  items: MilestoneItem[];
  releaseNotesZh?: string;
  releaseNotesEn?: string;
  digestSummary?: string;
  releasedCommitSha?: string;
  releasedTag?: string;
  /** Transient (not persisted): set on the release response when a GitHub release was created. */
  githubReleaseUrl?: string;
  createdAt: string;
  updatedAt: string;
}
