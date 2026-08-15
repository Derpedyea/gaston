import type {
  Finding,
  PullChangeSet,
  PullFileChange,
  RepositoryEntry,
  ReviewJob,
  ReviewOutput,
} from "./types.ts";
import type { RepositoryArchive } from "./repository-snapshot.ts";
import { formatBudgetSummary, type ReviewBudgetSnapshot } from "./budget.ts";
import type { EvidenceCoverage } from "./evidence.ts";
import { shouldRequestChanges } from "./review-core.ts";

const MAX_RETAINED_PATCH_BYTES = 2_000_000;
const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const CHECK_NAME = "Gaston review";
const RECONCILIATION_LOOKUP_BACKOFF_MS = [100, 300, 900] as const;

type Delay = (delayMs: number) => Promise<void>;

export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, status: number, detail: string) {
    super(`GitHub API ${method} ${path} failed (${status}): ${detail}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.method = method;
    this.path = path;
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

interface InstallationTokenResponse { token: string }

interface AuthenticatedGitHubApp {
  id?: number;
  slug?: string;
  events?: string[];
  permissions?: Record<string, string>;
}

interface GitHubActor {
  login?: string;
  type?: string;
}

interface GitHubAppIdentity {
  id: number;
  botLogin: string;
}

interface GitHubAppInstallation {
  events?: string[];
  permissions?: Record<string, string>;
  suspended_at?: string | null;
}

export interface GitHubAppReadiness {
  ok: boolean;
  requirements: {
    pullRequestEvent: boolean;
    issueCommentEvent: boolean;
    contentsRead: boolean;
    pullRequestsWrite: boolean;
    checksWrite: boolean;
    issuesWrite: boolean;
    installationsPresent: boolean;
    installationsReady: boolean;
  };
  installations: { total: number; ready: number };
}

export interface PullRequestState {
  number: number;
  title: string;
  body: string | null;
  head: { sha: string };
  base: { ref: string; sha: string };
  state: string;
  draft: boolean;
}

interface CheckRun {
  id: number;
  external_id: string | null;
  name: string;
  status: string;
}

interface CheckRunsResponse { check_runs: CheckRun[] }
export interface PullReview {
  id?: number;
  body: string | null;
  commit_id: string;
  user?: GitHubActor | null;
}
export interface ReviewComparisonIdentity { baseSha: string; headSha: string }
export interface PublishedReviewReconciliation {
  reviewId?: number;
  lookupAttempted: boolean;
  lookupError?: unknown;
  supersededByDifferentComparison: boolean;
  dismissalAttempted: boolean;
  dismissed: boolean;
  dismissalError?: unknown;
}
export interface QueuedCheckReconciliation {
  checkRunId?: number;
  lookupAttempted: boolean;
  lookupError?: unknown;
  supersededByDifferentComparison: boolean;
  supersedeAttempted: boolean;
  superseded: boolean;
  supersedeError?: unknown;
}
interface IssueComment {
  id: number;
  body: string | null;
  user?: GitHubActor | null;
  performed_via_github_app?: { id?: number } | null;
}
interface ReviewSummaryOptions { preserveExistingOnClean?: boolean }
interface PullFileResponse {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GitTreeResponse {
  truncated: boolean;
  tree: Array<{ path: string; type: "blob" | "tree" | "commit"; size?: number }>;
}

interface CodeSearchResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items: Array<{
    path: string;
    text_matches?: Array<{ fragment?: string; matches?: Array<{ text?: string }> }>;
  }>;
}

type ReactionContent = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

export class GitHubClient {
  readonly #token: string;
  readonly #appIdentity: GitHubAppIdentity;
  readonly #reconciliationDelay: Delay;

  private constructor(
    token: string,
    appIdentity: GitHubAppIdentity,
    reconciliationDelay: Delay = delay,
  ) {
    this.#token = token;
    this.#appIdentity = appIdentity;
    this.#reconciliationDelay = reconciliationDelay;
  }

  static async forInstallation(
    appId: string,
    privateKey: string,
    installationId: number,
    signal?: AbortSignal,
  ): Promise<GitHubClient> {
    const jwt = await createAppJwt(appId, privateKey);
    const [result, app] = await Promise.all([
      githubRequest<InstallationTokenResponse>(
        `/app/installations/${installationId}/access_tokens`,
        jwt,
        { method: "POST", ...signalInit(signal) },
      ),
      githubRequest<AuthenticatedGitHubApp>("/app", jwt, signalInit(signal)),
    ]);
    return new GitHubClient(result.token, authenticatedAppIdentity(appId, app));
  }

  getPull(job: ReviewJob, signal?: AbortSignal): Promise<PullRequestState> {
    return this.getPullByNumber(job.owner, job.repo, job.pullNumber, signal);
  }

  getPullByNumber(owner: string, repo: string, pullNumber: number, signal?: AbortSignal): Promise<PullRequestState> {
    return this.request(`/repos/${owner}/${repo}/pulls/${pullNumber}`, signalInit(signal));
  }

  reactToIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    content: ReactionContent,
  ): Promise<unknown> {
    return this.request(`/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  async getPullChanges(job: ReviewJob, signal?: AbortSignal): Promise<PullChangeSet> {
    const files: PullFileChange[] = [];
    let diffBytes = 0;
    let filesTruncated = false;
    let patchesTruncated = false;

    for (let page = 1; page <= 30; page++) {
      const batch = await this.request<PullFileResponse[]>(
        `/repos/${job.owner}/${job.repo}/pulls/${job.pullNumber}/files?per_page=100&page=${page}`,
        signalInit(signal),
      );
      for (const file of batch) {
        const sourcePatch = file.patch ?? null;
        const patchBytes = sourcePatch === null ? 0 : new TextEncoder().encode(sourcePatch).byteLength;
        const patch = sourcePatch !== null && diffBytes + patchBytes <= MAX_RETAINED_PATCH_BYTES
          ? sourcePatch
          : null;
        if (sourcePatch !== null && patch === null) patchesTruncated = true;
        const change: PullFileChange = {
          path: file.filename,
          ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch,
        };
        files.push(change);
        diffBytes += patchBytes && patch !== null ? patchBytes : 0;
      }
      if (batch.length < 100) break;
      // GitHub caps this endpoint at 3,000 files. A full final page cannot
      // prove whether the pull request contains additional changed paths.
      if (page === 30) filesTruncated = true;
    }

    return createChangeSet(
      files,
      filesTruncated,
      patchesTruncated || files.some((file) => file.patch === null),
    );
  }

  async getRepositoryTree(
    job: ReviewJob,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ entries: RepositoryEntry[]; truncated: boolean }> {
    const tree = await this.request<GitTreeResponse>(
      `/repos/${job.owner}/${job.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      signalInit(signal),
    );
    return {
      entries: tree.tree
        .filter((entry): entry is typeof entry & { type: "blob" | "tree" } => (
          entry.type === "blob" || entry.type === "tree"
        ))
        .slice(0, 100_000)
        .map((entry) => ({
          path: entry.path,
          type: entry.type,
          size: entry.size ?? null,
        })),
      truncated: tree.truncated || tree.tree.length > 100_000,
    };
  }

  /** Open GitHub's immutable, history-free archive for one exact commit. */
  async getRepositoryArchive(
    job: ReviewJob,
    ref: string,
    signal?: AbortSignal,
  ): Promise<RepositoryArchive> {
    const requestPath = `/repos/${job.owner}/${job.repo}/tarball/${encodeURIComponent(ref)}`;
    const response = await this.rawRequest(requestPath, {
      redirect: "follow",
      ...signalInit(signal),
    });
    const finalUrl = response.url ? new URL(response.url) : undefined;
    if (finalUrl !== undefined && (
      finalUrl.protocol !== "https:"
      || (finalUrl.hostname !== "api.github.com" && finalUrl.hostname !== "codeload.github.com")
    )) {
      throw new GitHubApiError("GET", requestPath, 502, "archive redirected to an unexpected host");
    }
    if (response.body === null) {
      throw new GitHubApiError("GET", requestPath, 502, "archive response has no body");
    }
    const declared = Number(response.headers.get("content-length"));
    return {
      body: response.body,
      ...(Number.isFinite(declared) && declared >= 0 ? { contentLength: declared } : {}),
    };
  }

  async readFile(
    job: ReviewJob,
    path: string,
    ref: string,
    maxBytes = 400_000,
    signal?: AbortSignal,
  ): Promise<string> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const requestPath = `/repos/${job.owner}/${job.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
    const response = await this.rawRequest(
      requestPath,
      { headers: { accept: "application/vnd.github.raw+json" }, ...signalInit(signal) },
    );
    try {
      return await readBoundedText(response, maxBytes, `file ${path}`);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new GitHubApiError("GET", requestPath, 503, `response stream failed: ${error.message}`);
      }
      throw error;
    }
  }

  async searchCode(
    job: ReviewJob,
    query: string,
    pathPrefix: string | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ matches: Array<{ path: string; fragment: string }>; truncated: boolean }> {
    const literal = query.replace(/["\\\r\n]/g, " ").trim().slice(0, 100);
    if (literal.length < 2) throw new Error("search query must contain at least two characters");
    const prefix = pathPrefix?.replace(/[^A-Za-z0-9_./-]/g, "").replace(/^\/+/, "").slice(0, 200);
    const q = `"${literal}" repo:${job.owner}/${job.repo}${prefix ? ` path:${prefix}` : ""}`;
    const result = await this.request<CodeSearchResponse>(
      `/search/code?q=${encodeURIComponent(q)}&per_page=${Math.max(1, Math.min(limit, 30))}`,
      { headers: { accept: "application/vnd.github.text-match+json" }, ...signalInit(signal) },
    );
    return {
      matches: result.items.slice(0, limit).map((item) => ({
        path: item.path,
        fragment: item.text_matches?.map((match) => match.fragment ?? "").join("\n").slice(0, 2_000) ?? "",
      })),
      truncated: result.incomplete_results === true || (result.total_count ?? result.items.length) > limit,
    };
  }

  async getOtherChecks(job: ReviewJob, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    const result = await this.request<{
      check_runs: Array<{
        name: string;
        status: string;
        conclusion: string | null;
        output?: { title?: string | null; summary?: string | null };
      }>;
    }>(`/repos/${job.owner}/${job.repo}/commits/${job.headSha}/check-runs?per_page=100`, signalInit(signal));

    return result.check_runs
      .filter((check) => check.name !== CHECK_NAME)
      .map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        title: check.output?.title?.slice(0, 300) ?? null,
        summary: check.output?.summary?.slice(0, 1_000) ?? null,
      }));
  }

  async ensureCheckRun(job: ReviewJob, signal?: AbortSignal): Promise<number> {
    return this.ensureCheckRunWithStatus(job, "in_progress", signal);
  }

  async ensureQueuedCheckRun(job: ReviewJob, signal?: AbortSignal): Promise<number> {
    return this.ensureCheckRunWithStatus(job, "queued", signal);
  }

  startCheckRun(job: ReviewJob, checkRunId: number, signal?: AbortSignal): Promise<unknown> {
    return this.request(`/repos/${job.owner}/${job.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...checkDetails(job),
        status: "in_progress",
        started_at: new Date().toISOString(),
        output: { title: "Reviewing pull request", summary: "Gaston is inspecting the change and repository context." },
      }),
      ...signalInit(signal),
    });
  }

  updateCheckProgress(
    job: ReviewJob,
    checkRunId: number,
    title: string,
    summary: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(`/repos/${job.owner}/${job.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...checkDetails(job),
        status: "in_progress",
        output: { title: title.slice(0, 255), summary: summary.slice(0, 4_000) },
      }),
      ...signalInit(signal),
    });
  }

  private async ensureCheckRunWithStatus(
    job: ReviewJob,
    status: "queued" | "in_progress",
    signal?: AbortSignal,
  ): Promise<number> {
    const existing = await this.#findLiveCheckRun(job, signal);
    if (existing) {
      if (status === "in_progress" && existing.status !== "in_progress") {
        await this.startCheckRun(job, existing.id, signal);
      }
      return existing.id;
    }

    const externalId = checkMarker(job);
    const queued = status === "queued";
    const created = await this.request<CheckRun>(`/repos/${job.owner}/${job.repo}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: CHECK_NAME,
        head_sha: job.headSha,
        external_id: externalId,
        ...checkDetails(job),
        status,
        ...(queued ? {} : { started_at: new Date().toISOString() }),
        output: queued
          ? { title: "Review queued", summary: "Gaston accepted this commit and will start after any earlier review for this pull request." }
          : { title: "Reviewing pull request", summary: "Gaston is inspecting the change and repository context." },
      }),
      ...signalInit(signal),
    });
    return created.id;
  }

  /**
   * Resolve a queued-check POST that completed, or may have completed, after
   * this review lost its durable lease. Check markers are execution-scoped, so
   * a different manual request for the same comparison cannot adopt this run's
   * check while its own POST is still in flight. Preserve a check explicitly
   * adopted by the durable owner, but cancel checks from a confirmed stale
   * execution even before the successor has persisted its own check ID.
   */
  async reconcileQueuedCheck(
    job: ReviewJob,
    knownCheckRunId: number | undefined,
    desiredComparison: ReviewComparisonIdentity | undefined,
    desiredCheckRunId = 0,
    desiredExecutionIsCurrent?: boolean,
  ): Promise<QueuedCheckReconciliation> {
    const supersededByDifferentComparison = desiredComparison !== undefined
      && !sameReviewComparison(job, desiredComparison);
    const supersededByDifferentExecution = desiredExecutionIsCurrent === false;
    let checkRunId = knownCheckRunId;
    let lookupAttempted = false;
    let lookupError: unknown;
    let supersedeAttempted = false;
    let superseded = false;
    let supersedeError: unknown;

    const staleOwner = supersededByDifferentComparison || supersededByDifferentExecution;
    if (staleOwner && checkRunId === undefined) {
      lookupAttempted = true;
      try {
        checkRunId = (await this.#findLiveCheckRunForReconciliation(job))?.id;
      } catch (error) {
        lookupError = error;
      }
    }

    const adoptedByDesiredExecution = desiredCheckRunId > 0 && checkRunId === desiredCheckRunId;
    const supersededDuplicateForSameComparison = desiredComparison !== undefined
      && !supersededByDifferentComparison
      && desiredCheckRunId > 0
      && checkRunId !== undefined
      && !adoptedByDesiredExecution;

    if ((staleOwner || supersededDuplicateForSameComparison)
      && checkRunId !== undefined
      && !adoptedByDesiredExecution) {
      supersedeAttempted = true;
      try {
        // Lease loss normally aborts the original request signal. This exact,
        // marker-scoped cleanup must be able to finish independently.
        await this.supersedeCheck(job, checkRunId);
        superseded = true;
      } catch (error) {
        supersedeError = error;
      }
    }

    return {
      ...(checkRunId === undefined ? {} : { checkRunId }),
      lookupAttempted,
      ...(lookupError === undefined ? {} : { lookupError }),
      supersededByDifferentComparison,
      supersedeAttempted,
      superseded,
      ...(supersedeError === undefined ? {} : { supersedeError }),
    };
  }

  async #findLiveCheckRunForReconciliation(job: ReviewJob): Promise<CheckRun | undefined> {
    let check = await this.#findLiveCheckRun(job);
    for (const delayMs of RECONCILIATION_LOOKUP_BACKOFF_MS) {
      if (check !== undefined) return check;
      await this.#reconciliationDelay(delayMs);
      check = await this.#findLiveCheckRun(job);
    }
    return check;
  }

  async #findLiveCheckRun(job: ReviewJob, signal?: AbortSignal): Promise<CheckRun | undefined> {
    const current = await this.request<CheckRunsResponse>(
      `/repos/${job.owner}/${job.repo}/commits/${job.headSha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&per_page=100`,
      signalInit(signal),
    );
    const externalId = checkMarker(job);
    return current.check_runs.find((check) => (
      check.external_id === externalId && check.status !== "completed"
    ));
  }

  completeCheck(
    job: ReviewJob,
    checkRunId: number,
    review: ReviewOutput,
    budget?: ReviewBudgetSnapshot,
    coverage?: EvidenceCoverage,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const findingCount = review.findings.length;
    const incomplete = coverage?.sufficient === false;
    return this.request(`/repos/${job.owner}/${job.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...checkDetails(job),
        status: "completed",
        completed_at: new Date().toISOString(),
        conclusion: findingCount === 0 && !incomplete ? "success" : "neutral",
        output: {
          title: incomplete && findingCount === 0
            ? "Review evidence incomplete"
            : findingCount === 0
            ? "No actionable bugs found"
            : `${findingCount} high-confidence ${findingCount === 1 ? "finding" : "findings"}`,
          summary: [
            renderSummary(review),
            ...(coverage === undefined ? [] : ["", renderCoverage(coverage)]),
            ...(budget === undefined ? [] : ["", `_Resource use: ${formatBudgetSummary(budget)}._`]),
          ].join("\n").slice(0, 60_000),
        },
      }),
      ...signalInit(signal),
    });
  }

  failCheck(job: ReviewJob, checkRunId: number, error: unknown, signal?: AbortSignal): Promise<unknown> {
    const message = error instanceof Error ? error.message : String(error);
    return this.request(`/repos/${job.owner}/${job.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...checkDetails(job),
        status: "completed",
        completed_at: new Date().toISOString(),
        conclusion: "failure",
        output: { title: "Review failed", summary: message.slice(0, 4_000) },
      }),
      ...signalInit(signal),
    });
  }

  stopCheckForBudget(
    job: ReviewJob,
    checkRunId: number,
    reason: string,
    budget: ReviewBudgetSnapshot,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.request(`/repos/${job.owner}/${job.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...checkDetails(job),
        status: "completed",
        completed_at: new Date().toISOString(),
        conclusion: "neutral",
        output: {
          title: "Review stopped at resource budget",
          summary: [
            `Gaston stopped safely at its ${reason}; it did not publish a partial or speculative review.`,
            "Push another commit or request a manual review after adjusting the configured budget.",
            "",
            `Resource use: ${formatBudgetSummary(budget)}.`,
          ].join("\n"),
        },
      }),
      ...signalInit(signal),
    });
  }

  supersedeCheck(job: ReviewJob, checkRunId: number, signal?: AbortSignal): Promise<unknown> {
    return this.request(`/repos/${job.owner}/${job.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        ...checkDetails(job),
        status: "completed",
        completed_at: new Date().toISOString(),
        conclusion: "cancelled",
        output: {
          title: "Review superseded",
          summary: "A newer commit arrived, so Gaston stopped this review and moved to the latest cumulative pull request diff.",
        },
      }),
      ...signalInit(signal),
    });
  }

  async findPublishedReview(job: ReviewJob, signal?: AbortSignal): Promise<PullReview | undefined> {
    const marker = `<!-- ${reviewMarker(job)} -->`;
    for (let page = 1; page <= 10; page++) {
      const reviews = await this.request<PullReview[]>(
        `/repos/${job.owner}/${job.repo}/pulls/${job.pullNumber}/reviews?per_page=100&page=${page}`,
        signalInit(signal),
      );
      const published = reviews.find((review) => (
        review.commit_id === job.headSha
        && review.body?.includes(marker)
        && isAppBot(review.user, this.#appIdentity)
      ));
      if (published) return published;
      if (reviews.length < 100) return undefined;
    }
    return undefined;
  }

  async hasPublishedReview(job: ReviewJob, signal?: AbortSignal): Promise<boolean> {
    return (await this.findPublishedReview(job, signal)) !== undefined;
  }

  /**
   * Resolve the outcome of a review POST whose response became ambiguous after
   * lease loss. Reconciliation deliberately does not reuse the aborted signal:
   * the marker lookup and best-effort dismissal must be allowed to finish.
   */
  async reconcilePublishedReview(
    job: ReviewJob,
    publishedReview: unknown,
    desiredComparison: ReviewComparisonIdentity | undefined,
  ): Promise<PublishedReviewReconciliation> {
    let reviewId = pullReviewId(publishedReview);
    let lookupAttempted = false;
    let lookupError: unknown;
    if (reviewId === undefined) {
      lookupAttempted = true;
      try {
        reviewId = pullReviewId(await this.#findPublishedReviewForReconciliation(job));
      } catch (error) {
        lookupError = error;
      }
    }

    // Missing/legacy coordinator state is not proof of a different comparison.
    const supersededByDifferentComparison = desiredComparison !== undefined
      && !sameReviewComparison(job, desiredComparison);
    let dismissalAttempted = false;
    let dismissed = false;
    let dismissalError: unknown;
    if (reviewId !== undefined && supersededByDifferentComparison) {
      dismissalAttempted = true;
      try {
        await this.dismissReview(
          job,
          reviewId,
          "Gaston review dismissed because a newer review request took ownership before publication completed.",
        );
        dismissed = true;
      } catch (error) {
        dismissalError = error;
      }
    }

    return {
      ...(reviewId === undefined ? {} : { reviewId }),
      lookupAttempted,
      ...(lookupError === undefined ? {} : { lookupError }),
      supersededByDifferentComparison,
      dismissalAttempted,
      dismissed,
      ...(dismissalError === undefined ? {} : { dismissalError }),
    };
  }

  /**
   * GitHub can briefly omit a review from the list endpoint after accepting its
   * POST. Keep this retry local to ambiguous-publication reconciliation: normal
   * lookups remain single-pass, and the finite schedule bounds wait time and API
   * traffic. No caller signal is accepted because lease loss already aborted it.
   */
  async #findPublishedReviewForReconciliation(job: ReviewJob): Promise<PullReview | undefined> {
    let published = await this.findPublishedReview(job);
    for (const delayMs of RECONCILIATION_LOOKUP_BACKOFF_MS) {
      if (published !== undefined) return published;
      await this.#reconciliationDelay(delayMs);
      published = await this.findPublishedReview(job);
    }
    return published;
  }

  publishReview(
    job: ReviewJob,
    review: ReviewOutput,
    requestChangesOn: string | undefined,
    signal?: AbortSignal,
  ): Promise<PullReview> {
    const comments = review.findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: renderInlineFinding(finding),
    }));
    return this.request(`/repos/${job.owner}/${job.repo}/pulls/${job.pullNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        commit_id: job.headSha,
        event: shouldRequestChanges(review.findings, requestChangesOn) ? "REQUEST_CHANGES" : "COMMENT",
        body: `<!-- ${reviewMarker(job)} -->\n${renderSummary(review)}`,
        comments,
      }),
      ...signalInit(signal),
    });
  }

  dismissReview(
    job: ReviewJob,
    reviewId: number,
    message: string,
    signal?: AbortSignal,
  ): Promise<PullReview> {
    return this.request(
      `/repos/${job.owner}/${job.repo}/pulls/${job.pullNumber}/reviews/${reviewId}/dismissals`,
      {
        method: "PUT",
        body: JSON.stringify({ message: message.slice(0, 1_000) }),
        ...signalInit(signal),
      },
    );
  }

  async upsertReviewSummary(
    job: ReviewJob,
    review: ReviewOutput,
    signal?: AbortSignal,
    options: ReviewSummaryOptions = {},
  ): Promise<void> {
    const marker = `<!-- gaston-summary:${job.pullNumber} -->`;
    let existing: IssueComment | undefined;
    for (let page = 1; page <= 10; page++) {
      const comments = await this.request<IssueComment[]>(
        `/repos/${job.owner}/${job.repo}/issues/${job.pullNumber}/comments?per_page=100&page=${page}`,
        signalInit(signal),
      );
      existing = comments.find((comment) => (
        comment.body?.includes(marker) && isAppIssueComment(comment, this.#appIdentity)
      ));
      if (existing || comments.length < 100) break;
    }
    if (!existing && review.findings.length === 0) return;
    if (existing && review.findings.length === 0 && options.preserveExistingOnClean === true) return;

    const body = `${marker}\n${renderSummary(review)}\n\n_Last reviewed commit: \`${job.headSha.slice(0, 12)}\`._`;
    if (existing) {
      await this.request(`/repos/${job.owner}/${job.repo}/issues/comments/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
        ...signalInit(signal),
      });
      return;
    }
    await this.request(`/repos/${job.owner}/${job.repo}/issues/${job.pullNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
      ...signalInit(signal),
    });
  }

  private request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    return githubRequest<T>(path, this.#token, init);
  }

  private rawRequest(path: string, init?: RequestInit): Promise<Response> {
    return githubRawRequest(path, this.#token, init);
  }
}

export async function getGitHubAppReadiness(appId: string, privateKey: string): Promise<GitHubAppReadiness> {
  const jwt = await createAppJwt(appId, privateKey);
  const [app, installations] = await Promise.all([
    githubRequest<AuthenticatedGitHubApp>("/app", jwt),
    githubRequest<GitHubAppInstallation[]>("/app/installations?per_page=100", jwt),
  ]);
  const events = new Set(app.events ?? []);
  const permissions = app.permissions ?? {};
  const readyInstallations = installations.filter((installation) => (
    installation.suspended_at == null
    && new Set(installation.events ?? []).has("pull_request")
    && new Set(installation.events ?? []).has("issue_comment")
    && hasPermission(installation.permissions?.contents, "read")
    && hasPermission(installation.permissions?.pull_requests, "write")
    && hasPermission(installation.permissions?.checks, "write")
    && hasPermission(installation.permissions?.issues, "write")
  ));
  const requirements = {
    pullRequestEvent: events.has("pull_request"),
    issueCommentEvent: events.has("issue_comment"),
    contentsRead: hasPermission(permissions.contents, "read"),
    pullRequestsWrite: hasPermission(permissions.pull_requests, "write"),
    checksWrite: hasPermission(permissions.checks, "write"),
    issuesWrite: hasPermission(permissions.issues, "write"),
    installationsPresent: installations.length > 0,
    installationsReady: installations.length > 0 && readyInstallations.length === installations.length,
  };
  return {
    ok: Object.values(requirements).every(Boolean),
    requirements,
    installations: { total: installations.length, ready: readyInstallations.length },
  };
}

function authenticatedAppIdentity(
  configuredAppId: string,
  app: AuthenticatedGitHubApp,
): GitHubAppIdentity {
  const expectedId = Number(configuredAppId);
  if (!Number.isSafeInteger(expectedId) || expectedId <= 0 || app.id !== expectedId) {
    throw new Error("GitHub returned an unexpected authenticated App identity");
  }
  if (typeof app.slug !== "string" || app.slug.length === 0) {
    throw new Error("GitHub did not return the authenticated App slug");
  }
  return {
    id: expectedId,
    botLogin: `${app.slug}[bot]`.toLowerCase(),
  };
}

function isAppBot(actor: GitHubActor | null | undefined, app: GitHubAppIdentity): boolean {
  return actor?.type?.toLowerCase() === "bot"
    && actor.login?.toLowerCase() === app.botLogin;
}

function isAppIssueComment(comment: IssueComment, app: GitHubAppIdentity): boolean {
  if (!isAppBot(comment.user, app)) return false;
  const attributedAppId = comment.performed_via_github_app?.id;
  return attributedAppId === undefined || attributedAppId === app.id;
}

function hasPermission(actual: string | undefined, required: "read" | "write"): boolean {
  if (required === "read") return actual === "read" || actual === "write" || actual === "admin";
  return actual === "write" || actual === "admin";
}

function renderCoverage(coverage: EvidenceCoverage): string {
  const headline = coverage.sufficient
    ? "Evidence coverage: complete for the bounded review inputs."
    : "Evidence coverage: incomplete; Gaston did not treat unavailable evidence as a clean review.";
  const counts = [
    `${coverage.totalChangedFiles} changed files`,
    `${coverage.inspectedChangedFiles} exact changed-file patches inspected`,
    `${coverage.toolCalls} repository calls`,
    `${coverage.truncatedResults} truncated results`,
    `${coverage.permanentErrors + coverage.transientErrors} tool errors`,
  ].join(" · ");
  return [
    headline,
    counts,
    ...coverage.limitations.slice(0, 8).map((limitation) => `- ${limitation}`),
  ].join("\n");
}

export async function createAppJwt(appId: string, privateKeyPem: string, now = Date.now()): Promise<string> {
  if (!/^\d+$/.test(appId)) throw new Error("GITHUB_APP_ID must be numeric");
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const issuedAt = Math.floor(now / 1_000) - 60;
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: appId })));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(privateKeyPem).buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

function reviewMarker(job: ReviewJob): string {
  return `gaston-review:${job.pullNumber}:${job.baseSha}:${job.headSha}`;
}

/**
 * Check runs are unique per executable request, while published review
 * comments intentionally remain unique per base/head comparison. Automatic
 * redeliveries share an execution; each manual command starts a fresh one. */
function checkMarker(job: ReviewJob): string {
  const execution = job.trigger === "manual" ? `manual:${job.deliveryId}` : "automatic";
  return `${reviewMarker(job)}:${execution}`;
}

function sameReviewComparison(job: ReviewJob, desired: ReviewComparisonIdentity): boolean {
  return desired.baseSha === job.baseSha && desired.headSha === job.headSha;
}

function pullReviewId(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || !("id" in value)) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function checkDetails(job: ReviewJob): { details_url?: string } {
  if (!job.dashboardUrl) return {};
  try {
    const url = new URL(job.dashboardUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      return {};
    }
    url.pathname = "/";
    url.search = new URLSearchParams({
      repo: `${job.owner}/${job.repo}`,
      pr: String(job.pullNumber),
    }).toString();
    url.hash = "";
    return { details_url: url.toString() };
  } catch {
    return {};
  }
}

function renderSummary(review: ReviewOutput): string {
  const lines = [review.summary];
  if (review.findings.length > 0) {
    lines.push("", "### Findings");
    for (const finding of review.findings) {
      lines.push(`- **${finding.severity.toUpperCase()}** \`${finding.path}:${finding.line}\` — ${finding.title}`);
    }
  }
  lines.push("", "_Generated by Gaston's Computer-backed harness; only independently verified, changed-line findings are shown._");
  return lines.join("\n").slice(0, 60_000);
}

function renderInlineFinding(finding: Finding): string {
  return [
    `**${finding.severity.toUpperCase()}: ${finding.title}**`,
    "",
    finding.why,
    "",
    `Evidence: ${finding.evidence}`,
    "",
    `Suggested fix: ${finding.suggestedFix}`,
    "",
    `Confidence: ${Math.round(finding.confidence * 100)}%`,
  ].join("\n").slice(0, 60_000);
}

async function githubRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await githubRawRequest(path, token, init);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function signalInit(signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? {} : { signal };
}

async function githubRawRequest(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "gaston-pr-reviewer",
        "x-github-api-version": API_VERSION,
        ...init.headers,
      },
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new GitHubApiError(
      init.method ?? "GET",
      path,
      503,
      `transport failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    const body = await response.text();
    throw new GitHubApiError(init.method ?? "GET", path, response.status, body.slice(0, 1_000));
  }
  return response;
}

function renderUnifiedDiff(
  files: PullFileChange[],
  maxBytes: number,
): { diff: string; truncated: boolean } {
  let result = "";
  for (const file of files) {
    if (!file.patch) continue;
    const oldPath = file.status === "added" ? "/dev/null" : `a/${file.previousPath ?? file.path}`;
    const newPath = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
    const block = [
      `diff --git a/${file.previousPath ?? file.path} b/${file.path}`,
      `--- ${oldPath}`,
      `+++ ${newPath}`,
      file.patch,
      "",
    ].join("\n");
    if (result.length + block.length > maxBytes) return { diff: result, truncated: true };
    result += block;
  }
  return { diff: result, truncated: false };
}

function createChangeSet(
  files: PullFileChange[],
  filesTruncated: boolean,
  diffTruncated: boolean,
): PullChangeSet {
  const rendered = renderUnifiedDiff(files, 2_000_000);
  const aggregateTruncated = diffTruncated || rendered.truncated;
  return {
    files,
    diff: rendered.diff,
    truncated: filesTruncated || aggregateTruncated,
    filesTruncated,
    diffTruncated: aggregateTruncated,
    unavailablePatchPaths: files.filter((file) => file.patch === null).map((file) => file.path),
  };
}

async function readBoundedText(response: Response, maxBytes: number, label: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte read limit`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds the ${maxBytes}-byte read limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.includes(0)) throw new Error(`${label} is binary`);
  return new TextDecoder("utf-8").decode(bytes);
}

function pemToBytes(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, "\n");
  const isPkcs1 = normalized.includes("-----BEGIN RSA PRIVATE KEY-----");
  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  if (!base64) throw new Error("GITHUB_PRIVATE_KEY is empty or is not an RSA private key");
  const binary = atob(base64);
  const der = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return isPkcs1 ? wrapPkcs1AsPkcs8(der) : der;
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithmIdentifier = new Uint8Array([
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  const privateKey = derValue(0x04, pkcs1);
  return derValue(0x30, concatenate(version, rsaAlgorithmIdentifier, privateKey));
}

function derValue(tag: number, body: Uint8Array): Uint8Array {
  return concatenate(new Uint8Array([tag]), derLength(body.length), body);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) bytes.unshift(remaining & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
