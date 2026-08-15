import { DurableObject } from "cloudflare:workers";
import {
  type DurableObjectStorageLike,
  getWorkspace,
  type WorkspaceOptions,
  WorkspaceProxy,
  withWorkspace,
} from "@cloudflare/computer";

import {
  DEFAULT_MAX_OUTPUT_TOKENS_PER_REQUEST,
  DEFAULT_VERIFICATION_MAX_OUTPUT_TOKENS_PER_REQUEST,
  ReviewAgent,
  reviewProviderRouteFromEnv,
} from "./agent.ts";
import type { EvidenceCoverage } from "./evidence.ts";
import {
  DEFAULT_REVIEW_BUDGET,
  formatBudgetSummary,
  isReviewBudgetExceededError,
  ReviewBudget,
  type ReviewBudgetSnapshot,
} from "./budget.ts";
import { withCheckpoint } from "./checkpoint.ts";
import {
  LatestHeadCoordinator,
  type CoordinatorStorage,
  type DurableReviewState,
  type OwnedOperation,
  type ReviewPhase,
  runOwnedOperations,
  shouldInterruptForAcceptedClaim,
} from "./coordinator.ts";
import { GitHubClient, type ReviewComparisonIdentity } from "./github.ts";
import { errorMessage, logError, logInfo } from "./log.ts";
import { discoveryPrompt, REVIEW_LENS } from "./prompts.ts";
import {
  filterFindings,
  parseChangedFileLines,
  reconcileCleanRerunWithPriorReview,
  shouldUseDirectDiscovery,
} from "./review-core.ts";
import {
  RepositoryTools,
  RepositoryWorkspace,
  REVIEW_SESSION_DIFF_PATH,
  REVIEW_SESSION_FILES_PATH,
} from "./repository.ts";
import { RetryableReviewError, shouldRetryReviewError } from "./retry.ts";
import type {
  ReviewSessionFile,
  ReviewSessionSnapshot,
  StoredReviewSession,
} from "./session.ts";
import type { Env, Finding, ReviewJob, ReviewOutcome, ReviewOutput } from "./types.ts";
import { verifyAndPublish } from "./verification-pipeline.ts";

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
}

interface ClaimedReview extends PreparedReview {
  checkRunId: number;
}

type ReviewPreparation = PreparedReview | { outcome: ReviewOutcome };

interface ActiveReview {
  runKey: string;
  headSha: string;
  queuedAt: string;
  controller: AbortController;
  generation?: number;
  promise: Promise<ReviewOutcome> | null;
}

interface ExecutionLease {
  runKey: string;
  generation: number;
}

const REVIEW_SESSION_KEY = "session:latest:v1";

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
    if (current?.promise) return current.promise;

    let controller = new AbortController();
    const active: ActiveReview = {
      runKey: key,
      headSha: job.headSha,
      queuedAt: job.queuedAt,
      controller,
      promise: null,
    };
    const run = this.#prepare(job, controller.signal)
      .then(async (prepared) => {
        if ("outcome" in prepared) return prepared.outcome;
        if (controller.signal.aborted) return staleOutcome(job);

        // A request must prove that its head is live before claiming, but it
        // creates no potentially shared check run until it owns the lease.
        const claim = await this.#coordinator.claim(job, key, 0);
        const lease: ExecutionLease = { runKey: key, generation: claim.generation };
        if (!claim.accepted) {
          logInfo("review.claim_rejected", {
            ...reviewLogFields(job),
            desiredRunKey: claim.state.desiredRunKey,
            generation: claim.generation,
          });
          return staleOutcome(job);
        }
        if (controller.signal.aborted) {
          // The claim transaction may have been in flight when an equal-time
          // claimant cancelled this preparation. Revive it only if that
          // transaction itself won the durable later-claim tie.
          if (!(await this.#coordinator.isCurrent(key, claim.generation))) {
            return staleOutcome(job);
          }
          controller = new AbortController();
          active.controller = controller;
          logInfo("review.equal_time_claim_revived", {
            ...reviewLogFields(job),
            generation: claim.generation,
          });
        }
        active.generation = claim.generation;

        // The durable claim is committed before the in-memory cancellation.
        // The map only accelerates interruption; correctness comes from the
        // generation checks that also survive Durable Object restarts.
        for (const [activeKey, candidate] of this.#active) {
          if (
            activeKey === key
            || !shouldInterruptForAcceptedClaim(
              candidate.generation,
              candidate.queuedAt,
              claim.generation,
              job.queuedAt,
            )
            || candidate.controller.signal.aborted
          ) continue;
          candidate.controller.abort(new Error(`review superseded by durable generation ${claim.generation}`));
          logInfo("review.cancellation_requested", {
            ...reviewLogFields(job),
            supersededHeadSha: candidate.headSha,
            supersededRunKey: candidate.runKey,
            generation: claim.generation,
          });
        }

        // Only the new durable owner closes a prior run's check. The rejected
        // worker never touches a check that a same-head run may still share.
        const priorCheckRunId = claim.supersededState?.checkRunId ?? 0;
        if (priorCheckRunId > 0) {
          const cancellation = await runOwnedOperations(
            () => this.#ownsLease(lease, controller.signal),
            [{
              name: "supersede-prior-check",
              run: async () => {
                await prepared.github.supersedeCheck(job, priorCheckRunId, controller.signal).catch((error) => {
                  logError("review.prior_check_supersede_failed", {
                    ...reviewLogFields(job),
                    checkRunId: priorCheckRunId,
                    error: errorMessage(error),
                  });
                });
              },
            }],
          );
          if (cancellation.status === "stale") {
            return this.#finishWithoutOwnership(job, "claim", priorCheckRunId, cancellation);
          }
        }

        let checkRunId: number;
        try {
          if (!(await this.#ownsLease(lease, controller.signal))) {
            return this.#finishWithoutOwnership(job, "queue", 0);
          }
          checkRunId = await prepared.github.ensureQueuedCheckRun(job, controller.signal);
        } catch (error) {
          if (!(await this.#ownsLease(lease, controller.signal))) {
            logError("review.queued_check_state_unknown_after_lease_loss", {
              ...reviewLogFields(job),
              error: errorMessage(error),
            });
            this.#reconcileQueuedCheckAfterLeaseLoss(job, prepared.github, undefined);
            return this.#finishWithoutOwnership(job, "queue", 0);
          }
          throw error;
        }
        if (!(await this.#ownsLease(lease, controller.signal))) {
          logInfo("review.queued_check_committed_after_lease_loss", {
            ...reviewLogFields(job),
            checkRunId,
          });
          this.#reconcileQueuedCheckAfterLeaseLoss(job, prepared.github, checkRunId);
          return this.#finishWithoutOwnership(job, "queue", checkRunId);
        }
        if (!(await this.#startSession(job, lease, checkRunId, claim.state.phase))) {
          logInfo("review.queued_check_unrecorded_after_lease_loss", {
            ...reviewLogFields(job),
            checkRunId,
          });
          this.#reconcileQueuedCheckAfterLeaseLoss(job, prepared.github, checkRunId);
          return this.#finishWithoutOwnership(job, "queue", checkRunId);
        }
        logInfo("review.queued", { ...reviewLogFields(job), checkRunId });
        return this.#enqueueClaimedRun(
          job,
          { github: prepared.github, checkRunId },
          controller.signal,
          lease,
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) throw error;
        logInfo("review.preparation_cancelled", {
          ...reviewLogFields(job),
          error: errorMessage(error),
        });
        return staleOutcome(job);
      })
      .finally(() => this.#active.delete(key));
    active.promise = run;
    this.#active.set(key, active);
    return run;
  }

  #enqueueClaimedRun(
    job: ReviewJob,
    prepared: ClaimedReview,
    signal: AbortSignal,
    lease: ExecutionLease,
  ): Promise<ReviewOutcome> {
    // Only accepted work enters the serialized execution tail. A slow stale
    // preparation therefore cannot hold the current live head behind it.
    const predecessor = this.#tail;
    const execution = predecessor.then(() => this.#run(job, prepared, signal, lease));
    this.#tail = execution.then(() => undefined, () => undefined);
    return execution;
  }

  async sessionRevision(): Promise<number | undefined> {
    return (await this.ctx.storage.get<StoredReviewSession>(REVIEW_SESSION_KEY))?.revision;
  }

  async session(): Promise<ReviewSessionSnapshot | undefined> {
    const stored = await this.ctx.storage.get<StoredReviewSession>(REVIEW_SESSION_KEY);
    if (stored === undefined) return undefined;

    let diff = "";
    let files: ReviewSessionFile[] = [];
    let changesTruncated = false;
    try {
      if (!stored.artifactsReady) {
        return { ...stored, files, diff, changesTruncated };
      }
      using workspace = await getWorkspace(this);
      const [storedDiff, storedFiles] = await Promise.all([
        workspace.fs.readFile(REVIEW_SESSION_DIFF_PATH, "utf8"),
        workspace.fs.readFile(REVIEW_SESSION_FILES_PATH, "utf8"),
      ]);
      const artifact = JSON.parse(storedFiles) as { files?: ReviewSessionFile[]; truncated?: boolean };
      diff = storedDiff;
      files = artifact.files ?? [];
      changesTruncated = artifact.truncated === true;
    } catch {
      // The workspace artifacts are created during discovery. Queued and
      // starting sessions intentionally return an empty change set.
    }

    return { ...stored, files, diff, changesTruncated };
  }

  async #startSession(
    job: ReviewJob,
    lease: ExecutionLease,
    checkRunId: number,
    phase: ReviewPhase,
  ): Promise<boolean> {
    return this.#coordinator.transitionIfCurrent(
      lease.runKey,
      lease.generation,
      phase,
      checkRunId,
      async (transaction) => {
        const current = await transaction.get<StoredReviewSession>(REVIEW_SESSION_KEY);
        await transaction.put<StoredReviewSession>(REVIEW_SESSION_KEY, {
          schemaVersion: 1,
          revision: (current?.revision ?? 0) + 1,
          runKey: lease.runKey,
          artifactsReady: false,
          job,
          phase,
          checkRunId,
          updatedAt: Date.now(),
          progressTitle: "Review accepted",
        });
      },
    );
  }

  #ownsLease(lease: ExecutionLease, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return this.#coordinator.isCurrent(lease.runKey, lease.generation);
  }

  #finishWithoutOwnership(
    job: ReviewJob,
    phase: string,
    checkRunId: number,
    operation?: { operation: string; operationCommitted: boolean },
  ): ReviewOutcome {
    logInfo("review.superseded_without_terminal_write", {
      ...reviewLogFields(job),
      phase,
      checkRunId,
      operation: operation?.operation,
      operationCommitted: operation?.operationCommitted,
    });
    return staleOutcome(job);
  }

  #reconcileQueuedCheckAfterLeaseLoss(
    job: ReviewJob,
    github: GitHubClient,
    checkRunId: number | undefined,
  ): void {
    this.ctx.waitUntil(
      this.#coordinator.state()
        .then((state) => github.reconcileQueuedCheck(
          job,
          checkRunId,
          reviewComparison(state),
          state?.checkRunId ?? 0,
          state === undefined ? undefined : state.desiredRunKey === completionKey(job),
        ))
        .then((reconciliation) => {
          const fields = {
            ...reviewLogFields(job),
            checkRunId: reconciliation.checkRunId,
            lookupAttempted: reconciliation.lookupAttempted,
            supersededByDifferentComparison: reconciliation.supersededByDifferentComparison,
            supersedeAttempted: reconciliation.supersedeAttempted,
            superseded: reconciliation.superseded,
          };
          if (reconciliation.lookupError !== undefined) {
            logError("review.stale_queued_check_lookup_failed", {
              ...fields,
              error: errorMessage(reconciliation.lookupError),
            });
          }
          if (reconciliation.supersedeError !== undefined) {
            logError("review.stale_queued_check_supersede_failed", {
              ...fields,
              error: errorMessage(reconciliation.supersedeError),
            });
          } else if (reconciliation.superseded) {
            logInfo("review.stale_queued_check_superseded", fields);
          } else {
            logInfo("review.stale_queued_check_reconciled", fields);
          }
        })
        .catch((error) => {
          logError("review.stale_queued_check_reconciliation_failed", {
            ...reviewLogFields(job),
            checkRunId,
            error: errorMessage(error),
          });
        }),
    );
  }

  async #updateSession(
    lease: ExecutionLease,
    patch: Partial<Omit<StoredReviewSession, "schemaVersion" | "revision" | "runKey" | "job">>,
  ): Promise<boolean> {
    return this.#coordinator.mutateIfCurrent(lease.runKey, lease.generation, async (transaction) => {
      const current = await transaction.get<StoredReviewSession>(REVIEW_SESSION_KEY);
      if (current?.runKey !== lease.runKey) return;
      await transaction.put<StoredReviewSession>(REVIEW_SESSION_KEY, {
        ...current,
        ...patch,
        revision: current.revision + 1,
        updatedAt: Date.now(),
      });
    });
  }

  async #markSessionPhase(
    lease: ExecutionLease,
    phase: ReviewPhase,
    checkRunId?: number,
    patch: Partial<Omit<StoredReviewSession, "schemaVersion" | "revision" | "runKey" | "job" | "phase" | "checkRunId">> = {},
  ): Promise<boolean> {
    return this.#coordinator.transitionIfCurrent(
      lease.runKey,
      lease.generation,
      phase,
      checkRunId,
      async (transaction) => {
        const current = await transaction.get<StoredReviewSession>(REVIEW_SESSION_KEY);
        if (current?.runKey !== lease.runKey) return;
        await transaction.put<StoredReviewSession>(REVIEW_SESSION_KEY, {
          ...current,
          ...patch,
          phase,
          ...(checkRunId === undefined ? {} : { checkRunId }),
          revision: current.revision + 1,
          updatedAt: Date.now(),
        });
      },
    );
  }

  async #prepare(job: ReviewJob, signal: AbortSignal): Promise<ReviewPreparation> {
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
      signal,
    );
    const pull = await github.getPull(job, signal);
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

    return { github };
  }

  async #run(
    job: ReviewJob,
    prepared: ClaimedReview,
    signal: AbortSignal,
    lease: ExecutionLease,
  ): Promise<ReviewOutcome> {
    const key = completionKey(job);
    const { github, checkRunId } = prepared;
    const budgetStorageKey = budgetKey(job);
    const limits = reviewBudgetLimits(this.env);
    const previousBudget = await this.ctx.storage.get<ReviewBudgetSnapshot>(budgetStorageKey);
    const persistBudget = (snapshot: ReviewBudgetSnapshot) => {
      const write = this.ctx.storage.put(budgetStorageKey, snapshot);
      this.ctx.waitUntil(write);
    };
    const budget = previousBudget === undefined
      ? new ReviewBudget(limits, Date.now(), persistBudget)
      : ReviewBudget.resume(limits, previousBudget, Date.now(), persistBudget);
    let preserveBudgetForRetry = false;
    if (previousBudget !== undefined) {
      logInfo("review.budget_resumed", {
        ...reviewLogFields(job),
        ...budget.snapshot(),
      });
    }
    try {
      if (!(await this.#ownsLease(lease, signal))) {
        return this.#finishWithoutOwnership(job, "start", checkRunId);
      }
      if (!(await this.#markSessionPhase(lease, "starting", checkRunId))) {
        return this.#finishWithoutOwnership(job, "start", checkRunId);
      }
      const pull = await github.getPull(job, signal);
      if (
        pull.state !== "open" ||
        pull.draft ||
        pull.head.sha !== job.headSha ||
        pull.base.sha !== job.baseSha
      ) {
        return await this.#finishSuperseded(job, github, checkRunId, "start", lease, signal);
      }
      if (!(await this.#ownsLease(lease, signal))) {
        return this.#finishWithoutOwnership(job, "start", checkRunId);
      }

      const startResult = await runOwnedOperations(
        () => this.#ownsLease(lease, signal),
        [{ name: "start-check", run: async () => { await github.startCheckRun(job, checkRunId, signal); } }],
      );
      if (startResult.status === "stale") {
        return this.#finishWithoutOwnership(job, "start", checkRunId, startResult);
      }
      logInfo("review.started", { ...reviewLogFields(job), checkRunId });
      const analysisCheckpoint = analysisKey(job);
      const { value: analysis, cached: cachedAnalysis } = await withCheckpoint(
        () => this.ctx.storage.get<AnalysisResult>(analysisCheckpoint),
        (value) => this.ctx.storage.put(analysisCheckpoint, value),
        () => this.#analyze(job, github, checkRunId, signal, budget, lease),
      );
      let { review, inlineFindings, coverage } = analysis;
      let preserveExistingSummary = false;
      if (inlineFindings.length === 0) {
        const priorReviewForSameComparison = await github.hasPublishedReview(job, signal);
        if (!(await this.#ownsLease(lease, signal))) {
          return this.#finishWithoutOwnership(job, "analysis", checkRunId);
        }
        const reconciliation = reconcileCleanRerunWithPriorReview(
          review,
          coverage,
          priorReviewForSameComparison,
        );
        review = reconciliation.review;
        coverage = reconciliation.coverage;
        preserveExistingSummary = reconciliation.preserveExistingSummary;
        if (preserveExistingSummary) {
          logInfo("review.clean_rerun_preserved_prior_findings", {
            ...reviewLogFields(job),
            checkRunId,
          });
        }
      }
      logInfo("review.analysis_ready", {
        ...reviewLogFields(job),
        cached: cachedAnalysis,
        findings: review.findings.length,
        coverageSufficient: coverage.sufficient,
        coverageLimitations: coverage.limitations,
      });
      if (!(await this.#updateSession(lease, {
        review,
        coverage,
        budget: budget.snapshot(),
        progressTitle: "Preparing GitHub review",
      }))) {
        return this.#finishWithoutOwnership(job, "publish", checkRunId);
      }
      if (!(await this.#markSessionPhase(lease, "publishing", checkRunId))) {
        return this.#finishWithoutOwnership(job, "publish", checkRunId);
      }
      const latest = await github.getPull(job, signal);
      if (
        latest.state !== "open" ||
        latest.head.sha !== job.headSha ||
        latest.base.sha !== job.baseSha
      ) {
        return await this.#finishSuperseded(job, github, checkRunId, "publish", lease, signal);
      }
      if (!(await this.#ownsLease(lease, signal))) {
        return this.#finishWithoutOwnership(job, "publish", checkRunId);
      }

      let publishInlineReview = false;
      if (inlineFindings.length > 0) {
        publishInlineReview = !(await github.hasPublishedReview(job, signal));
        if (!(await this.#ownsLease(lease, signal))) {
          return this.#finishWithoutOwnership(job, "publish", checkRunId);
        }
      }

      type TerminalOperation = "publish-review" | "upsert-summary" | "complete-check";
      let publishedReview: unknown;
      const terminalOperations: Array<OwnedOperation<TerminalOperation>> = [];
      if (publishInlineReview) {
        terminalOperations.push({
          name: "publish-review",
          run: async () => {
            publishedReview = await github.publishReview(
              job,
              { ...review, findings: inlineFindings },
              this.env.REQUEST_CHANGES_ON,
              signal,
            );
          },
        });
      }
      terminalOperations.push(
        {
          name: "upsert-summary",
          run: async () => {
            await github.upsertReviewSummary(job, review, signal, {
              preserveExistingOnClean: preserveExistingSummary,
            }).catch((error) => {
              logError("review.summary_failed", { ...reviewLogFields(job), error: errorMessage(error) });
            });
          },
        },
        {
          name: "complete-check",
          run: async () => {
            await github.completeCheck(job, checkRunId, review, budget.snapshot(), coverage, signal);
          },
        },
      );
      const terminalResult = await runOwnedOperations(
        () => this.#ownsLease(lease, signal),
        terminalOperations,
      );
      if (terminalResult.status === "stale") {
        if (
          terminalResult.operation === "publish-review"
          && (terminalResult.operationCommitted || terminalResult.operationMayHaveCommitted === true)
        ) {
          const currentState = await this.#coordinator.state();
          const desiredComparison = reviewComparison(currentState);
          const supersededByDifferentComparison = desiredComparison !== undefined
            && (desiredComparison.baseSha !== job.baseSha || desiredComparison.headSha !== job.headSha);
          const responseAmbiguous = terminalResult.operationMayHaveCommitted === true;
          logError(responseAmbiguous
            ? "review.publication_response_ambiguous_after_lease_loss"
            : "review.publication_committed_after_lease_loss", {
            ...reviewLogFields(job),
            checkRunId,
            responseAmbiguous,
            reconciliationScheduled: true,
            supersededByDifferentComparison,
            potentiallyIrretractable: supersededByDifferentComparison,
            ...(terminalResult.operationError === undefined
              ? {}
              : { error: errorMessage(terminalResult.operationError) }),
          });
          this.ctx.waitUntil(
            github.reconcilePublishedReview(
              job,
              publishedReview,
              desiredComparison,
            ).then((reconciliation) => {
              const reconciliationFields = {
                ...reviewLogFields(job),
                checkRunId,
                reviewId: reconciliation.reviewId,
                lookupAttempted: reconciliation.lookupAttempted,
                supersededByDifferentComparison: reconciliation.supersededByDifferentComparison,
                dismissalAttempted: reconciliation.dismissalAttempted,
                dismissed: reconciliation.dismissed,
              };
              if (reconciliation.lookupError !== undefined) {
                logError("review.stale_publication_lookup_failed", {
                  ...reconciliationFields,
                  error: errorMessage(reconciliation.lookupError),
                });
              }
              if (reconciliation.dismissalError !== undefined) {
                logError("review.stale_publication_dismissal_failed", {
                  ...reconciliationFields,
                  error: errorMessage(reconciliation.dismissalError),
                });
              } else if (reconciliation.dismissed) {
                logInfo("review.stale_publication_dismissed", {
                  ...reconciliationFields,
                });
              } else {
                logInfo("review.stale_publication_reconciled", reconciliationFields);
              }
            }).catch((error) => {
              logError("review.stale_publication_reconciliation_failed", {
                ...reviewLogFields(job),
                checkRunId,
                error: errorMessage(error),
              });
            }),
          );
        } else if (terminalResult.operationMayHaveCommitted === true) {
          logError("review.terminal_operation_response_ambiguous_after_lease_loss", {
            ...reviewLogFields(job),
            checkRunId,
            operation: terminalResult.operation,
            error: terminalResult.operationError === undefined
              ? undefined
              : errorMessage(terminalResult.operationError),
          });
        } else if (terminalResult.operationCommitted) {
          logInfo("review.terminal_operation_committed_after_lease_loss", {
            ...reviewLogFields(job),
            checkRunId,
            operation: terminalResult.operation,
          });
        }
        return this.#finishWithoutOwnership(job, "publish", checkRunId, terminalResult);
      }

      const outcome: ReviewOutcome = {
        status: coverage.sufficient ? "completed" : "incomplete",
        findings: review.findings.length,
        headSha: job.headSha,
      };
      if (!(await this.#commitOutcome(
        key,
        lease,
        checkRunId,
        outcome,
        budget.snapshot(),
        outcome.status === "completed" ? "Review complete" : "Review complete with limited evidence",
        signal,
      ))) {
        return this.#finishWithoutOwnership(job, "outcome", checkRunId);
      }
      logInfo("review.completed", { ...reviewLogFields(job), checkRunId, findings: outcome.findings });
      return outcome;
    } catch (error) {
      if (!(await this.#ownsLease(lease, signal))) {
        return this.#finishWithoutOwnership(job, "analysis", checkRunId);
      }
      if (isReviewBudgetExceededError(error)) {
        return await this.#finishBudgetExhausted(
          job,
          github,
          checkRunId,
          error.snapshot,
          error.reason,
          lease,
          signal,
        );
      }
      const retryable = shouldRetryReviewError(error);
      if (retryable && (job.queueAttempt ?? 1) <= 3) {
        await this.ctx.storage.put(budgetStorageKey, budget.snapshot());
        const retryResult = await runOwnedOperations(
          () => this.#ownsLease(lease, signal),
          [{
            name: "retry-check",
            run: async () => {
              await github.updateCheckProgress(
                job,
                checkRunId,
                "Review interrupted; retrying",
                `A transient dependency error interrupted attempt ${job.queueAttempt ?? 1}. Gaston will resume on this same check run.`,
                signal,
              ).catch(() => undefined);
            },
          }],
        );
        if (retryResult.status === "stale") {
          return this.#finishWithoutOwnership(job, "retry", checkRunId, retryResult);
        }
        if (!(await this.#markSessionPhase(lease, "interrupted", checkRunId, {
          budget: budget.snapshot(),
          progressTitle: "Review interrupted; retrying",
        }))) {
          return this.#finishWithoutOwnership(job, "retry", checkRunId);
        }
        preserveBudgetForRetry = true;
        logError("review.retry_scheduled", {
          ...reviewLogFields(job),
          checkRunId,
          queueAttempt: job.queueAttempt ?? 1,
          error: errorMessage(error),
        });
        throw new RetryableReviewError(error);
      }
      const failureResult = await runOwnedOperations(
        () => this.#ownsLease(lease, signal),
        [{
          name: "fail-check",
          run: async () => { await github.failCheck(job, checkRunId, error, signal).catch(() => undefined); },
        }],
      );
      if (failureResult.status === "stale") {
        return this.#finishWithoutOwnership(job, "failure", checkRunId, failureResult);
      }
      if (!(await this.#markSessionPhase(lease, "interrupted", checkRunId, {
        progressTitle: "Review failed",
      }))) {
        return this.#finishWithoutOwnership(job, "failure", checkRunId);
      }
      logError("review.failed", { ...reviewLogFields(job), checkRunId, error: errorMessage(error) });
      throw retryable ? new RetryableReviewError(error) : error;
    } finally {
      if (!preserveBudgetForRetry) {
        await this.ctx.storage.delete(budgetStorageKey).catch((error) => {
          logError("review.budget_cleanup_failed", {
            ...reviewLogFields(job),
            error: errorMessage(error),
          });
        });
      }
    }
  }

  #commitOutcome(
    key: string,
    lease: ExecutionLease,
    checkRunId: number,
    outcome: ReviewOutcome,
    budget: ReviewBudgetSnapshot,
    progressTitle: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return this.#coordinator.transitionIfCurrent(
      lease.runKey,
      lease.generation,
      "completed",
      checkRunId,
      async (transaction) => {
        await transaction.put(key, outcome);
        const current = await transaction.get<StoredReviewSession>(REVIEW_SESSION_KEY);
        if (current?.runKey !== lease.runKey) return;
        await transaction.put<StoredReviewSession>(REVIEW_SESSION_KEY, {
          ...current,
          phase: "completed",
          checkRunId,
          outcome,
          budget,
          progressTitle,
          revision: current.revision + 1,
          updatedAt: Date.now(),
        });
      },
    );
  }

  async #finishBudgetExhausted(
    job: ReviewJob,
    github: GitHubClient,
    checkRunId: number,
    snapshot: ReviewBudgetSnapshot,
    reason: string,
    lease: ExecutionLease,
    signal: AbortSignal,
  ): Promise<ReviewOutcome> {
    const outcome: ReviewOutcome = { status: "budget_exhausted", findings: 0, headSha: job.headSha };
    const terminalResult = await runOwnedOperations(
      () => this.#ownsLease(lease, signal),
      [{
        name: "budget-check",
        run: async () => {
          await github.stopCheckForBudget(job, checkRunId, reason, snapshot, signal).catch((error) => {
            logError("review.budget_check_failed", {
              ...reviewLogFields(job),
              checkRunId,
              error: errorMessage(error),
            });
          });
        },
      }],
    );
    if (terminalResult.status === "stale") {
      return this.#finishWithoutOwnership(job, "budget", checkRunId, terminalResult);
    }
    if (!(await this.#commitOutcome(
      completionKey(job),
      lease,
      checkRunId,
      outcome,
      snapshot,
      `Review stopped at the ${reason}`,
      signal,
    ))) {
      return this.#finishWithoutOwnership(job, "budget", checkRunId);
    }
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
    signal: AbortSignal,
  ): Promise<ReviewOutcome> {
    const outcome = staleOutcome(job);
    const terminalResult = await runOwnedOperations(
      () => this.#ownsLease(lease, signal),
      [{
        name: "supersede-check",
        run: async () => {
          await github.supersedeCheck(job, checkRunId, signal).catch((error) => {
            logError("review.superseded_check_failed", {
              ...reviewLogFields(job),
              checkRunId,
              error: errorMessage(error),
            });
          });
        },
      }],
    );
    if (terminalResult.status === "stale") {
      return this.#finishWithoutOwnership(job, phase, checkRunId, terminalResult);
    }
    if (!(await this.#markSessionPhase(lease, "superseded", checkRunId, {
      outcome,
      progressTitle: "Superseded by a newer pull request head",
    }))) {
      return this.#finishWithoutOwnership(job, phase, checkRunId);
    }
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
    if (!(await this.#markSessionPhase(lease, "discovery", checkRunId))) {
      throw new Error("review superseded before discovery");
    }
    const [changes, checks] = await Promise.all([
      github.getPullChanges(job, signal),
      github.getOtherChecks(job, signal),
    ]);
    using workspace = await getWorkspace(this);
    const repository = new RepositoryWorkspace(workspace, github, job, changes, { snapshot: true });
    await repository.initialize(checks, signal);
    logInfo("review.repository_snapshot", {
      ...reviewLogFields(job),
      ...repository.snapshotReport(),
    });
    if (!(await this.#updateSession(lease, {
      artifactsReady: true,
      progressTitle: "Loaded cumulative pull request changes",
      budget: budget.snapshot(),
    }))) {
      throw new Error("review superseded while loading repository evidence");
    }
    const policy = await repository.reviewPolicy(signal);
    const model = this.env.REVIEW_MODEL ?? "openai/gpt-5.6-luna";
    const providerRoute = reviewProviderRouteFromEnv(
      model,
      this.env.REVIEW_PROVIDER,
      this.env.REVIEW_REQUIRE_ZDR,
    );
    const maxOutputTokensPerRequest = Math.round(boundedNumber(
      this.env.REVIEW_MODEL_MAX_OUTPUT_TOKENS,
      DEFAULT_MAX_OUTPUT_TOKENS_PER_REQUEST,
      2_000,
      384_000,
    ));
    const agentOptions = {
      apiKey: this.env.OPENROUTER_API_KEY,
      model,
      reasoningEffort: this.env.REVIEW_REASONING_EFFORT ?? "max",
      repository: `${job.owner}/${job.repo}`,
      signal,
      budget,
      ...providerRoute,
      maxOutputTokensPerRequest,
      requireInitialToolCall: booleanSetting(this.env.REVIEW_REQUIRE_INITIAL_TOOL_CALL, false),
      maxExplorationTurns: Math.round(boundedNumber(
        this.env.REVIEW_MAX_EXPLORATION_TURNS,
        1,
        1,
        2,
      )),
    };
    const agent = new ReviewAgent(agentOptions);
    const verificationAgent = new ReviewAgent({
      ...agentOptions,
      maxOutputTokensPerRequest: Math.min(
        maxOutputTokensPerRequest,
        DEFAULT_VERIFICATION_MAX_OUTPUT_TOKENS_PER_REQUEST,
      ),
    });
    const verificationRescueAgent = new ReviewAgent({
      ...agentOptions,
      maxOutputTokensPerRequest: Math.min(
        maxOutputTokensPerRequest,
        DEFAULT_VERIFICATION_MAX_OUTPUT_TOKENS_PER_REQUEST,
      ),
      maxExplorationTurns: 2,
    });
    const discoveryTools = new RepositoryTools(repository);
    const directDiscovery = shouldUseDirectDiscovery(
      this.env.REVIEW_DIRECT_DISCOVERY,
      discoveryTools.coverage(),
    );

    // Validate findings against every per-file patch returned by GitHub, not
    // only the bounded aggregate excerpt used in the model prompt/dashboard.
    const changedLines = parseChangedFileLines(changes.files);
    if (!(await this.#updateProgress(
      job,
      github,
      checkRunId,
      "Scanning changed code",
      budget.snapshot(),
      lease,
      signal,
    ))) {
      throw new Error("review superseded before discovery progress update");
    }
    const startedAt = Date.now();
    const checkpoint = lensCheckpointKey(job, REVIEW_LENS.id);
    const { value: discovery, cached } = await withCheckpoint(
      () => this.ctx.storage.get<DiscoveryResult>(checkpoint),
      (value) => this.ctx.storage.put(checkpoint, value),
      async () => {
        const review = filterFindings(
          directDiscovery
            ? await agent.runDirectReview(
                discoveryPrompt(job, changes, checks, policy, REVIEW_LENS),
                "discovery",
              )
            : await agent.run(
                discoveryPrompt(job, changes, checks, policy, REVIEW_LENS),
                discoveryTools,
                "discovery",
              ),
          changedLines,
          0,
          12,
        );
        return {
          source: directDiscovery ? "direct-discovery" : "discovery",
          review,
          coverage: discoveryTools.coverage(),
        };
      },
    );
    logInfo("review.discovery_completed", {
      ...reviewLogFields(job),
      cached,
      direct: directDiscovery,
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

    if (!(await this.#updateProgress(
      job,
      github,
      checkRunId,
      "Verifying candidate findings",
      budget.snapshot(),
      lease,
      signal,
    ))) {
      throw new Error("review superseded before verification progress update");
    }
    if (!(await this.#markSessionPhase(lease, "verification", checkRunId))) {
      throw new Error("review superseded before verification");
    }
    const maxFindings = Math.round(boundedNumber(this.env.REVIEW_MAX_FINDINGS, 8, 1, 20));
    const {
      coverage,
      minConfidence,
      review,
      resolution: publicationResolution,
      rescue,
    } = await verifyAndPublish({
      runner: verificationAgent,
      rescueRunner: verificationRescueAgent,
      tools: new RepositoryTools(repository),
      job,
      discoveries: candidates,
      changes,
      policy,
      signal,
      changedLines,
      discoveryCoverage: discovery.coverage,
      configuredBaseThreshold: this.env.REVIEW_MIN_CONFIDENCE,
      configuredIncompleteEvidenceFloor: this.env.REVIEW_INCOMPLETE_EVIDENCE_MIN_CONFIDENCE,
      maxFindings,
    });
    logInfo("review.repository_cache", {
      ...reviewLogFields(job),
      ...repository.cacheSnapshot(),
      coverageSufficient: coverage.sufficient,
      publicationMinConfidence: minConfidence,
      verificationCandidates: publicationResolution.candidateCount,
      verificationConfirmed: publicationResolution.confirmedCandidateIds.length,
      verificationRefuted: publicationResolution.refutedCandidateIds.length,
      verificationInsufficient: publicationResolution.insufficientCandidateIds.length,
      verificationInvalidEntries: publicationResolution.invalidVerdictCount,
      verificationConfirmedWithheld: publicationResolution.withheldConfirmedCandidateCount,
      verificationRescueCandidate: rescue?.attemptedCandidateId,
      verificationRescueSucceeded: rescue?.succeeded,
      verificationRescueError: rescue?.error,
      verificationCandidateFates: JSON.stringify(publicationResolution.candidateFates.map((fate) => ({
        candidateId: fate.candidateId,
        verification: fate.verification.reason,
        publication: fate.publication.reason,
      }))),
    });
    return { review, inlineFindings: review.findings, coverage };
  }

  async #updateProgress(
    job: ReviewJob,
    github: GitHubClient,
    checkRunId: number,
    title: string,
    snapshot: ReviewBudgetSnapshot,
    lease: ExecutionLease,
    signal: AbortSignal,
  ): Promise<boolean> {
    const result = await runOwnedOperations(
      () => this.#ownsLease(lease, signal),
      [{
        name: "progress-check",
        run: async () => {
          await github.updateCheckProgress(
            job,
            checkRunId,
            title,
            formatBudgetSummary(snapshot),
            signal,
          ).catch((error) => {
            logError("review.progress_failed", { ...reviewLogFields(job), checkRunId, error: errorMessage(error) });
          });
        },
      }],
    );
    if (result.status === "stale") return false;
    return this.#updateSession(lease, { progressTitle: title, budget: snapshot });
  }
}

function staleOutcome(job: ReviewJob): ReviewOutcome {
  return { status: "stale", findings: 0, headSha: job.headSha };
}

/** A pre-migration coordinator record has no base SHA, so it is deliberately
 * treated as unknown rather than evidence that a different comparison won. */
function reviewComparison(
  state: DurableReviewState | undefined,
): ReviewComparisonIdentity | undefined {
  return state?.desiredBaseSha === undefined
    ? undefined
    : { baseSha: state.desiredBaseSha, headSha: state.desiredHeadSha };
}

function completionKey(job: ReviewJob): string {
  const automatic = `completed:${job.baseSha}:${job.headSha}`;
  return job.trigger === "manual" ? `${automatic}:manual:${job.deliveryId}` : automatic;
}

function analysisKey(job: ReviewJob): string {
  return `analysis:${job.baseSha}:${job.headSha}:${executionScope(job)}`;
}

function budgetKey(job: ReviewJob): string {
  return `budget:${job.baseSha}:${job.headSha}:${executionScope(job)}`;
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

function booleanSetting(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value.trim().toLowerCase() === "true") return true;
  if (value.trim().toLowerCase() === "false") return false;
  return fallback;
}

function reviewBudgetLimits(env: Env) {
  return {
    // Queue consumers have a 15-minute platform wall; retain one minute for
    // setup, publication, and acknowledgement outside the active review budget.
    maxWallTimeMs: boundedNumber(env.REVIEW_MAX_WALL_TIME_MS, DEFAULT_REVIEW_BUDGET.maxWallTimeMs, 30_000, 14 * 60_000),
    maxModelRequests: Math.round(boundedNumber(env.REVIEW_MAX_MODEL_REQUESTS, DEFAULT_REVIEW_BUDGET.maxModelRequests, 2, 30)),
    maxEstimatedInputTokens: Math.round(boundedNumber(env.REVIEW_MAX_INPUT_TOKENS, DEFAULT_REVIEW_BUDGET.maxEstimatedInputTokens, 10_000, 2_000_000)),
    maxOutputTokens: Math.round(boundedNumber(env.REVIEW_MAX_OUTPUT_TOKENS, DEFAULT_REVIEW_BUDGET.maxOutputTokens, 2_000, 200_000)),
    maxCostUsd: boundedNumber(env.REVIEW_MAX_COST_USD, DEFAULT_REVIEW_BUDGET.maxCostUsd, 0.001, 100),
    modelRequestTimeoutMs: boundedNumber(env.REVIEW_MODEL_TIMEOUT_MS, DEFAULT_REVIEW_BUDGET.modelRequestTimeoutMs, 5_000, 12 * 60_000),
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
