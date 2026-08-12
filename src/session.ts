import type { ReviewBudgetSnapshot } from "./budget.ts";
import type { EvidenceCoverage } from "./evidence.ts";

export type ReviewSessionPhase =
  | "queued"
  | "starting"
  | "discovery"
  | "verification"
  | "publishing"
  | "completed"
  | "interrupted"
  | "superseded";

export interface ReviewSessionJob {
  deliveryId: string;
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  title: string;
  body: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
  beforeSha?: string;
  queuedAt: string;
  trigger: "automatic" | "manual";
  requestedBy?: string;
  dashboardUrl?: string;
  queueAttempt?: number;
}

export interface ReviewSessionFinding {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  severity: "blocker" | "high" | "medium" | "low";
  title: string;
  why: string;
  evidence: string;
  suggestedFix: string;
  confidence: number;
}

export interface ReviewSessionReview {
  summary: string;
  findings: ReviewSessionFinding[];
}

export interface ReviewSessionOutcome {
  status: "completed" | "incomplete" | "duplicate" | "stale" | "budget_exhausted";
  findings: number;
  headSha: string;
}

export interface ReviewSessionFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patchAvailable: boolean;
}

export interface StoredReviewSession {
  schemaVersion: 1;
  revision: number;
  runKey: string;
  artifactsReady: boolean;
  job: ReviewSessionJob;
  phase: ReviewSessionPhase;
  checkRunId: number;
  updatedAt: number;
  progressTitle?: string;
  budget?: ReviewBudgetSnapshot;
  review?: ReviewSessionReview;
  coverage?: EvidenceCoverage;
  outcome?: ReviewSessionOutcome;
}

export interface ReviewSessionSnapshot extends StoredReviewSession {
  files: ReviewSessionFile[];
  diff: string;
  changesTruncated: boolean;
}
