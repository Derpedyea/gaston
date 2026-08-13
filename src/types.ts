export const REVIEW_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
]);

export type Severity = "blocker" | "high" | "medium" | "low";
export type DiffSide = "LEFT" | "RIGHT";

export interface ReviewJob {
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

export interface ManualReviewRequest {
  kind: "manual";
  deliveryId: string;
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  commentId: number;
  requestedBy: string;
  dashboardUrl?: string;
  queuedAt: string;
}

export type ReviewQueueMessage = ReviewJob | ManualReviewRequest;

export interface Finding {
  path: string;
  line: number;
  side: DiffSide;
  severity: Severity;
  title: string;
  why: string;
  evidence: string;
  suggestedFix: string;
  confidence: number;
}

export interface ReviewOutput {
  summary: string;
  findings: Finding[];
}

export type VerificationVerdictKind = "confirmed" | "refuted" | "insufficient";

/**
 * A parsed verifier entry. `valid` is harness-owned: malformed model entries
 * retain a usable candidate identity when possible so they cannot disappear
 * by omission or accidentally become a refutation.
 */
export interface VerificationVerdict {
  candidateId: string;
  verdict: VerificationVerdictKind | null;
  path: string;
  line: number | null;
  side: DiffSide | null;
  confidence: number | null;
  rationale: string;
  evidence: string;
  evidenceComplete: boolean | null;
  evidenceScopes: string[];
  valid: boolean;
}

export interface VerificationOutput {
  summary: string;
  verdicts: VerificationVerdict[];
}

export interface PullFileChange {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string | null;
}

export interface PullChangeSet {
  files: PullFileChange[];
  diff: string;
  truncated: boolean;
  filesTruncated?: boolean;
  diffTruncated?: boolean;
  /** Changed paths whose exact GitHub patch was omitted or discarded by the memory cap. */
  unavailablePatchPaths?: string[];
}

export interface RepositoryEntry {
  path: string;
  type: "blob" | "tree";
  size: number | null;
}

export type RepositoryRef = "base" | "head";

export interface ReviewOutcome {
  status: "completed" | "incomplete" | "duplicate" | "stale" | "budget_exhausted";
  findings: number;
  headSha: string;
}

export interface Env extends Cloudflare.Env {
  DASHBOARD_TOKEN?: string;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  OPENROUTER_API_KEY: string;
}

export interface PullRequestWebhook {
  action?: string;
  before?: string;
  after?: string;
  installation?: { id?: number };
  repository?: {
    name?: string;
    owner?: { login?: string };
  };
  pull_request?: {
    number?: number;
    title?: string;
    body?: string | null;
    draft?: boolean;
    base?: { ref?: string; sha?: string };
    head?: { sha?: string };
  };
}

export interface IssueCommentWebhook {
  action?: string;
  installation?: { id?: number };
  repository?: {
    name?: string;
    owner?: { login?: string };
  };
  issue?: {
    number?: number;
    pull_request?: { url?: string };
  };
  comment?: {
    id?: number;
    body?: string;
    author_association?: string;
    user?: { login?: string; type?: string };
  };
}
