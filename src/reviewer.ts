import { DurableObject } from "cloudflare:workers";
import {
  type DurableObjectStorageLike,
  getWorkspace,
  type WorkspaceOptions,
  WorkspaceProxy,
  withWorkspace,
} from "@cloudflare/computer";

import { ReviewAgent } from "./agent.ts";
import type { EvidenceCoverage } from "./evidence.ts";
import {
  DEFAULT_REVIEW_BUDGET,
  formatBudgetSummary,
  isReviewBudgetExceededError,
  ReviewBudget,
  type ReviewBudgetSnapshot,
} from "./budget.ts";
import { withCheckpoint } from "./checkpoint.ts";
import { LatestHeadCoordinator, type CoordinatorStorage } from "./coordinator.ts";
import { GitHubClient } from "./github.ts";
import { errorMessage, logError, logInfo } from "./log.ts";
import { discoveryPrompt, REVIEW_LENS, verificationPrompt } from "./prompts.ts";
import { filterFindings, parseChangedLines } from "./review-core.ts";
import { RepositoryTools, RepositoryWorkspace } from "./repository.ts";
import { shouldRetryReviewError } from "./retry.ts";
import type { Env, Finding, ReviewJob, ReviewOutcome, ReviewOutput } from "./types.ts";

export { WorkspaceProxy };

class ReviewerBase extends DurableObject<Env> {}

interface AnalysisResult {
  review: ReviewOutput;
  inlineFindings: Finding[];
  coverage: EvidenceCoverage;
}

interface DiscoveryResult {
  source: string;
  review: ReviewOutput;
  coverage: EvidenceCoverage;
}

interface PreparedReview {
  github: GitHubClient;
  checkRunId: number;
}

type ReviewPreparation = PreparedReview | { outcome: ReviewOutcome };

interface ActiveReview {
  runKey: string;
  headSha: string;
  controller: AbortController;
  promise: Promise<ReviewOutcome>;
}

interface ExecutionLease {
  runKey: string;
  generation: number;
}

function workspaceOptions(self: InstanceType<typeof ReviewerBase>): WorkspaceOptions {
  const { ctx } = self as unknown as { ctx: DurableObjectState };
  return {
    storage: ctx.storage as unknown as DurableObjectStorageLike,
    waitUntil: (promise) => ctx.waitUntil(promise),
  };
}

export class Reviewer extends withWorkspace(ReviewerBase, workspaceOptions) {
  readonly #active = new Map<string, ActiveReview>();
  readonly #coordinator = new LatestHeadCoordinator(this.ctx.storage as CoordinatorStorage);
  #tail: Promise<void> = Promise.resolve();

  review(job: ReviewJob): Promise<ReviewOutcome> {
    const key = completionKey(job);
    const current = this.#active.get(key);
    if (current) return current.promise;

    const controller = new AbortController();
    const predecessor = this.#tail;
    const run = this.#prepare(job)
      .then(async (prepared) => {
        if ("outcome" in prepared) return prepared.outcome;

        const claim = await this.#coordinator.claim(job, key, prepared.checkRunId);
        const lease: ExecutionLease = { runKey: key, generation: claim.generation };
        if (!claim.accepted) {
          return this.#finishSuperseded(job, prepared.github, prepared.checkRunId, "claim", lease);
        }

        // The durable claim is committed before the in-memory cancellation.
        // The map only accelerates interruption; correctness comes from the
        // generation checks that also survive Durable Object restarts.
        for (const [activeKey, active] of this.#active) {
          if (activeKey === key || active.controller.signal.aborted) continue;
          active.controller.abort(new Error(`review superseded by durable generation ${claim.generation}`));
          logInfo("review.cancellation_requested", {
            ...reviewLogFields(job),
            supersededHeadSha: active.headSha,
            supersededRunKey: active.runKey,
            generation: claim.generation,
          });
        }
        return predecessor.then(() => this.#run(job, prepared, controller.signal, lease));
      })
      .finally(() => this.#active.delete(key));
    // A stale delayed delivery may resolve during #prepare without waiting for
    // its predecessor. Keep that predecessor in the tail chain so the stale
    // job cannot accidentally make a still-running review look idle.
    this.#tail = Promise.all([
      predecessor,
      run.then(() => undefined, () => undefined),
    ]).then(() => undefined);
    this.#active.set(key, { runKey: key, headSha: job.headSha, controller, promise: run });
    return run;
  }

  async #prepare(job: ReviewJob): Promise<ReviewPreparation> {
    const key = completionKey(job);
    const completed = await this.ctx.storage.get<ReviewOutcome>(key);
    if (completed && completed.status !== "stale") {
      logInfo("review.duplicate", reviewLogFields(job));
      return { outcome: { ...completed, status: "duplicate" } };
    }
    // Older deployments persisted cancelled/stale outcomes as if they were
    // successful completions. Clear that poison marker so a redelivery or a
    // manual request can actually review the head.
    if (completed) await this.ctx.storage.delete(key);

    const github = await GitHubClient.forInstallation(
      this.env.GITHUB_APP_ID,
      this.env.GITHUB_PRIVATE_KEY,
      job.installationId,
    );
    const pull = await github.getPull(job);
    if (
      pull.state !== "open" ||
      pull.draft ||
      pull.head.sha !== job.headSha ||
      pull.base.sha !== job.baseSha
    ) {
      const outcome: ReviewOutcome = { status: "stale", findings: 0, headSha: job.headSha };
      logInfo("review.stale", { ...reviewLogFields(job), phase: "prepare" });
      return { outcome };
    }

    const checkRunId = await github.ensureQueuedCheckRun(job);
    logInfo("review.queued", { ...reviewLogFields(job), checkRunId });
    return { github, checkRunId };
  }

  async #run(
    job: ReviewJob,
    prepared: PreparedReview,
    signal: AbortSignal,
    lease: ExecutionLease,
  ): Promise<ReviewOutcome> {
    const key = completionKey(job);
    const { github, checkRunId } = prepared;
    const budget = new ReviewBudget(reviewBudgetLimits(this.env));
    try {
      if (signal.aborted || !(await this.#coordinator.isCurrent(lease.runKey, lease.generation))) {
        return await this.#finishSuperseded(job, github, checkRunId, "start", lease);
      }
      if (!(await this.#coordinator.markPhase(lease.runKey, lease.generation, "starting", checkRunId))) {
        return await this.#finishSuperseded(job, github, checkRunId, "start", lease);
      }
      const pull = await github.getPull(job, signal);
      if (
        pull.state !== "open" ||
        pull.draft ||
        pull.head.sha !== job.headSha ||
        pull.base.sha !== job.baseSha
      ) {
        return await this.#finishSuperseded(job, github, checkRunId, "start", lease);
      }

      await github.startCheckRun(job, checkRunId);
      logInfo("review.started", { ...reviewLogFields(job), checkRunId });
      const analysisCheckpoint = analysisKey(job);
      const { value: analysis, cached: cachedAnalysis } = await withCheckpoint(
        () => this.ctx.storage.get<AnalysisResult>(analysisCheckpoint),
        (value) => this.ctx.storage.put(analysisCheckpoint, value),
        () => this.#analyze(job, github, checkRunId, signal, budget, lease),
      );
      const { review, inlineFindings, coverage } = analysis;
      logInfo("review.analysis_ready", {
        ...reviewLogFields(job),
        cached: cachedAnalysis,
        findings: review.findings.length,
        coverageSufficient: coverage.sufficient,
        coverageLimitations: coverage.limitations,
      });
      if (!(await this.#coordinator.markPhase(lease.runKey, lease.generation, "publishing", checkRunId))) {
        return await this.#finishSuperseded(job, github, checkRunId, "publish", lease);
      }
      const latest = await github.getPull(job, signal);
      if (
        latest.state !== "open" ||
        latest.head.sha !== job.headSha ||
        latest.base.sha !== job.baseSha ||
        !(await this.#coordinator.isCurrent(lease.runKey, lease.generation))
      ) {
        return await this.#finishSuperseded(job, github, checkRunId, "publish", lease);
      }

      if (inlineFindings.length > 0 && !(await github.hasPublishedReview(job, signal))) {
        await github.publishReview(job, { ...review, findings: inlineFindings }, this.env.REQUEST_CHANGES_ON);
      }
      await github.upsertReviewSummary(job, review).catch((error) => {
        logError("review.summary_failed", { ...reviewLogFields(job), error: errorMessage(error) });
      });
      await github.completeCheck(job, checkRunId, review, budget.snapshot(), coverage);
      await this.#coordinator.markPhase(lease.runKey, lease.generation, "completed", checkRunId);

      const outcome: ReviewOutcome = {
        status: coverage.sufficient ? "completed" : "incomplete",
        findings: review.findings.length,
        headSha: job.headSha,
      };
      await this.ctx.storage.put({
        [key]: outcome,
      });
      logInfo("review.completed", { ...reviewLogFields(job), checkRunId, findings: outcome.findings });
      return outcome;
    } catch (error) {
      if (signal.aborted || !(await this.#coordinator.isCurrent(lease.runKey, lease.generation))) {
        return await this.#finishSuperseded(job, github, checkRunId, "analysis", lease);
      }
      if (isReviewBudgetExceededError(error)) {
        return await this.#finishBudgetExhausted(job, github, checkRunId, error.snapshot, error.reason, lease);
      }
      if (shouldRetryReviewError(error) && (job.queueAttempt ?? 1) <= 3) {
        await github.updateCheckProgress(
          job,
          checkRunId,
          "Review interrupted; retrying",
          `A transient dependency error interrupted attempt ${job.queueAttempt ?? 1}. Gaston will resume on this same check run.`,
        ).catch(() => undefined);
        logError("review.retry_scheduled", {
          ...reviewLogFields(job),
          checkRunId,
          queueAttempt: job.queueAttempt ?? 1,
          error: errorMessage(error),
        });
        await this.#coordinator.markPhase(lease.runKey, lease.generation, "interrupted", checkRunId);
        throw error;
      }
      await github.failCheck(job, checkRunId, error).catch(() => undefined);
      logError("review.failed", { ...reviewLogFields(job), checkRunId, error: errorMessage(error) });
      throw error;
    }
  }

  async #finishBudgetExhausted(
    job: ReviewJob,
    github: GitHubClient,
    checkRunId: number,
    snapshot: ReviewBudgetSnapshot,
    reason: string,
    lease: ExecutionLease,
  ): Promise<ReviewOutcome> {
    const outcome: ReviewOutcome = { status: "budget_exhausted", findings: 0, headSha: job.headSha };
    await github.stopCheckForBudget(job, checkRunId, reason, snapshot).catch((error) => {
      logError("review.budget_check_failed", {
        ...reviewLogFields(job),
        checkRunId,
        error: errorMessage(error),
      });
    });
    await this.ctx.storage.put(completionKey(job), outcome);
    await this.#coordinator.markPhase(lease.runKey, lease.generation, "completed", checkRunId);
    logInfo("review.budget_exhausted", {
      ...reviewLogFields(job),
      checkRunId,
      reason,
      ...snapshot,
    });
    return outcome;
  }

  async #finishSuperseded(
    job: ReviewJob,
    github: GitHubClient,
    checkRunId: number,
    phase: string,
    lease: ExecutionLease,
  ): Promise<ReviewOutcome> {
    const outcome: ReviewOutcome = { status: "stale", findings: 0, headSha: job.headSha };
    await github.supersedeCheck(job, checkRunId).catch((error) => {
      logError("review.superseded_check_failed", {
        ...reviewLogFields(job),
        checkRunId,
        error: errorMessage(error),
      });
    });
    await this.#coordinator.markPhase(lease.runKey, lease.generation, "superseded", checkRunId);
    logInfo("review.superseded", { ...reviewLogFields(job), phase, checkRunId });
    return outcome;
  }

  async #analyze(
    job: ReviewJob,
    github: GitHubClient,
    checkRunId: number,
    signal: AbortSignal,
    budget: ReviewBudget,
    lease: ExecutionLease,
  ): Promise<AnalysisResult> {
    if (!(await this.#coordinator.markPhase(lease.runKey, lease.generation, "discovery", checkRunId))) {
      throw new Error("review superseded before discovery");
    }
    const [changes, checks] = await Promise.all([
      github.getPullChanges(job, signal),
      github.getOtherChecks(job, signal),
    ]);
    using workspace = await getWorkspace(this);
    const repository = new RepositoryWorkspace(workspace, github, job, changes);
    await repository.initialize(checks);
    const policy = await repository.reviewPolicy(signal);
    const agent = new ReviewAgent({
      apiKey: this.env.OPENROUTER_API_KEY,
      model: this.env.REVIEW_MODEL ?? "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: this.env.REVIEW_REASONING_EFFORT ?? "high",
      repository: `${job.owner}/${job.repo}`,
      signal,
      budget,
    });
    const tools = new RepositoryTools(repository);

    const changedLines = parseChangedLines(changes.diff);
    await this.#updateProgress(job, github, checkRunId, "Scanning changed code", budget.snapshot());
    const startedAt = Date.now();
    const checkpoint = lensCheckpointKey(job, REVIEW_LENS.id);
    const { value: discovery, cached } = await withCheckpoint(
      () => this.ctx.storage.get<DiscoveryResult>(checkpoint),
      (value) => this.ctx.storage.put(checkpoint, value),
      async () => {
        const review = filterFindings(
          await agent.run(
            discoveryPrompt(job, changes, checks, policy, REVIEW_LENS),
            tools,
            "discovery",
          ),
          changedLines,
          0,
          12,
        );
        return { source: "discovery", review, coverage: tools.coverage() };
      },
    );
    logInfo("review.discovery_completed", {
      ...reviewLogFields(job),
      cached,
      durationMs: Date.now() - startedAt,
      findings: discovery.review.findings.length,
      cacheHits: repository.cacheSnapshot().hits,
      cacheMisses: repository.cacheSnapshot().misses,
      cacheHitRate: repository.cacheSnapshot().hitRate,
      ...budget.snapshot(),
    });
    const candidates = [discovery];
    if (candidates.every(({ review }) => review.findings.length === 0)) {
      const coverage = discovery.coverage;
      const review = {
        summary: !coverage.sufficient
          ? "No actionable bugs were proved, but the evidence coverage was incomplete; this is not a clean-review assertion."
          : "No actionable bugs survived bounded discovery and changed-line validation.",
        findings: [],
      };
      return { review, inlineFindings: [], coverage };
    }

    await this.#updateProgress(job, github, checkRunId, "Verifying candidate findings", budget.snapshot());
    if (!(await this.#coordinator.markPhase(lease.runKey, lease.generation, "verification", checkRunId))) {
      throw new Error("review superseded before verification");
    }
    const verified = await agent.run(
      verificationPrompt(job, candidates, changes, policy),
      tools,
      "verification",
    );
    const minConfidence = boundedNumber(this.env.REVIEW_MIN_CONFIDENCE, 0.82, 0, 1);
    const maxFindings = Math.round(boundedNumber(this.env.REVIEW_MAX_FINDINGS, 8, 1, 20));
    const filtered = filterFindings(verified, changedLines, minConfidence, maxFindings);
    const review = filtered.findings.length === 0
      ? { summary: "No actionable bugs survived independent verification and changed-line validation.", findings: [] }
      : filtered;
    const verificationCoverage = tools.coverage();
    const coverage = cached
      ? mergeCoverage(discovery.coverage, verificationCoverage)
      : verificationCoverage;
    logInfo("review.repository_cache", {
      ...reviewLogFields(job),
      ...repository.cacheSnapshot(),
    });
    return { review, inlineFindings: review.findings, coverage };
  }

  async #updateProgress(
    job: ReviewJob,
    github: GitHubClient,
    checkRunId: number,
    title: string,
    snapshot: ReviewBudgetSnapshot,
  ): Promise<void> {
    await github.updateCheckProgress(job, checkRunId, title, formatBudgetSummary(snapshot)).catch((error) => {
      logError("review.progress_failed", { ...reviewLogFields(job), checkRunId, error: errorMessage(error) });
    });
  }
}

function mergeCoverage(left: EvidenceCoverage, right: EvidenceCoverage): EvidenceCoverage {
  const limitations = [...new Set([...left.limitations, ...right.limitations])].slice(0, 20);
  return {
    sufficient: left.sufficient && right.sufficient && limitations.length === 0,
    totalChangedFiles: Math.max(left.totalChangedFiles, right.totalChangedFiles),
    inspectedChangedFiles: Math.min(
      Math.max(left.totalChangedFiles, right.totalChangedFiles),
      left.inspectedChangedFiles + right.inspectedChangedFiles,
    ),
    toolCalls: left.toolCalls + right.toolCalls,
    okResults: left.okResults + right.okResults,
    truncatedResults: left.truncatedResults + right.truncatedResults,
    transientErrors: left.transientErrors + right.transientErrors,
    permanentErrors: left.permanentErrors + right.permanentErrors,
    invalidArguments: left.invalidArguments + right.invalidArguments,
    initialDiffTruncated: left.initialDiffTruncated || right.initialDiffTruncated,
    limitations,
  };
}

function completionKey(job: ReviewJob): string {
  const automatic = `completed:${job.baseSha}:${job.headSha}`;
  return job.trigger === "manual" ? `${automatic}:manual:${job.deliveryId}` : automatic;
}

function analysisKey(job: ReviewJob): string {
  return `analysis:${job.baseSha}:${job.headSha}:${executionScope(job)}`;
}

function lensCheckpointKey(job: ReviewJob, lens: string): string {
  return `lens:${job.baseSha}:full:${job.headSha}:${executionScope(job)}:${lens}`;
}

function executionScope(job: ReviewJob): string {
  return job.trigger === "manual" ? `manual:${job.deliveryId}` : "automatic";
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function reviewBudgetLimits(env: Env) {
  return {
    maxWallTimeMs: boundedNumber(env.REVIEW_MAX_WALL_TIME_MS, DEFAULT_REVIEW_BUDGET.maxWallTimeMs, 30_000, 15 * 60_000),
    maxModelRequests: Math.round(boundedNumber(env.REVIEW_MAX_MODEL_REQUESTS, DEFAULT_REVIEW_BUDGET.maxModelRequests, 2, 30)),
    maxEstimatedInputTokens: Math.round(boundedNumber(env.REVIEW_MAX_INPUT_TOKENS, DEFAULT_REVIEW_BUDGET.maxEstimatedInputTokens, 10_000, 2_000_000)),
    maxOutputTokens: Math.round(boundedNumber(env.REVIEW_MAX_OUTPUT_TOKENS, DEFAULT_REVIEW_BUDGET.maxOutputTokens, 2_000, 200_000)),
    maxCostUsd: boundedNumber(env.REVIEW_MAX_COST_USD, DEFAULT_REVIEW_BUDGET.maxCostUsd, 0.001, 100),
    modelRequestTimeoutMs: boundedNumber(env.REVIEW_MODEL_TIMEOUT_MS, DEFAULT_REVIEW_BUDGET.modelRequestTimeoutMs, 5_000, 4 * 60_000),
  };
}

function reviewLogFields(job: ReviewJob): Record<string, string | number | undefined> {
  return {
    deliveryId: job.deliveryId,
    installationId: job.installationId,
    owner: job.owner,
    repo: job.repo,
    pullNumber: job.pullNumber,
    headSha: job.headSha,
    trigger: job.trigger,
    requestedBy: job.requestedBy,
    queueAttempt: job.queueAttempt,
  };
}
