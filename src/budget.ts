export interface ReviewBudgetLimits {
  maxWallTimeMs: number;
  maxModelRequests: number;
  maxEstimatedInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
  modelRequestTimeoutMs: number;
}

export interface ReviewBudgetSnapshot {
  elapsedMs: number;
  modelRequests: number;
  estimatedInputTokens: number;
  reportedInputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
  remainingModelRequests: number;
  remainingWallTimeMs: number;
}

export interface ReportedModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export const DEFAULT_REVIEW_BUDGET: ReviewBudgetLimits = {
  maxWallTimeMs: 14 * 60_000,
  maxModelRequests: 15,
  maxEstimatedInputTokens: 250_000,
  maxOutputTokens: 128_000,
  maxCostUsd: 0.20,
  modelRequestTimeoutMs: 11 * 60_000,
};

type BudgetSnapshotObserver = (snapshot: ReviewBudgetSnapshot) => void;

export class ReviewBudgetExceededError extends Error {
  readonly reason: string;
  readonly snapshot: ReviewBudgetSnapshot;

  constructor(reason: string, snapshot: ReviewBudgetSnapshot) {
    super(`Review resource budget exhausted: ${reason}`);
    this.name = "ReviewBudgetExceededError";
    this.reason = reason;
    this.snapshot = snapshot;
  }
}

export class ReviewBudget {
  readonly limits: ReviewBudgetLimits;
  readonly signal: AbortSignal;
  readonly #startedAt: number;
  #modelRequests = 0;
  #estimatedInputTokens = 0;
  #reportedInputTokens = 0;
  #outputTokens = 0;
  #cachedTokens = 0;
  #reasoningTokens = 0;
  #costUsd = 0;
  #exhaustedReason: string | undefined;
  readonly #onSnapshot: BudgetSnapshotObserver | undefined;

  constructor(
    limits: ReviewBudgetLimits = DEFAULT_REVIEW_BUDGET,
    now = Date.now(),
    onSnapshot?: BudgetSnapshotObserver,
    restoredElapsedMs = 0,
  ) {
    this.limits = limits;
    const elapsedMs = Math.min(limits.maxWallTimeMs, nonNegative(restoredElapsedMs));
    this.#startedAt = now - elapsedMs;
    this.#onSnapshot = onSnapshot;
    this.signal = AbortSignal.timeout(Math.max(1, limits.maxWallTimeMs - elapsedMs));
  }

  static resume(
    limits: ReviewBudgetLimits,
    previous: ReviewBudgetSnapshot,
    now = Date.now(),
    onSnapshot?: BudgetSnapshotObserver,
  ): ReviewBudget {
    const elapsedMs = Math.min(limits.maxWallTimeMs, nonNegative(previous.elapsedMs));
    const budget = new ReviewBudget(limits, now, onSnapshot, elapsedMs);
    budget.#modelRequests = Math.floor(nonNegative(previous.modelRequests));
    budget.#estimatedInputTokens = Math.floor(nonNegative(previous.estimatedInputTokens));
    budget.#reportedInputTokens = Math.floor(nonNegative(previous.reportedInputTokens));
    budget.#outputTokens = Math.floor(nonNegative(previous.outputTokens));
    budget.#cachedTokens = Math.floor(nonNegative(previous.cachedTokens));
    budget.#reasoningTokens = Math.floor(nonNegative(previous.reasoningTokens));
    budget.#costUsd = nonNegative(previous.costUsd);
    if (budget.#reportedInputTokens > limits.maxEstimatedInputTokens) {
      budget.#exhaustedReason = "reported input-token limit";
    } else if (budget.#outputTokens > limits.maxOutputTokens) {
      budget.#exhaustedReason = "reported output-token limit";
    } else if (budget.#costUsd > limits.maxCostUsd) {
      budget.#exhaustedReason = "reported cost limit";
    }
    return budget;
  }

  reserveModelRequest(requestBytes: number, maxOutputTokens: number): ReviewBudgetSnapshot {
    this.throwIfExceeded();
    const estimatedInputTokens = Math.ceil(Math.max(0, requestBytes) / 4);
    if (this.#modelRequests + 1 > this.limits.maxModelRequests) {
      throw this.#error("model request limit");
    }
    if (this.#estimatedInputTokens + estimatedInputTokens > this.limits.maxEstimatedInputTokens) {
      throw this.#error("estimated input-token limit");
    }
    if (this.#outputTokens + maxOutputTokens > this.limits.maxOutputTokens) {
      throw this.#error("output-token limit");
    }
    if (this.#costUsd >= this.limits.maxCostUsd) {
      throw this.#error("cost limit");
    }

    this.#modelRequests++;
    this.#estimatedInputTokens += estimatedInputTokens;
    return this.#publishSnapshot();
  }

  recordUsage(usage: ReportedModelUsage): ReviewBudgetSnapshot {
    this.#reportedInputTokens += nonNegative(usage.inputTokens);
    this.#outputTokens += nonNegative(usage.outputTokens);
    this.#cachedTokens += nonNegative(usage.cachedTokens);
    this.#reasoningTokens += nonNegative(usage.reasoningTokens);
    this.#costUsd += nonNegative(usage.costUsd);
    if (this.#reportedInputTokens > this.limits.maxEstimatedInputTokens) {
      this.#exhaustedReason = "reported input-token limit";
    } else if (this.#outputTokens > this.limits.maxOutputTokens) {
      this.#exhaustedReason = "reported output-token limit";
    } else if (this.#costUsd > this.limits.maxCostUsd) {
      this.#exhaustedReason = "reported cost limit";
    }
    return this.#publishSnapshot();
  }

  throwIfExceeded(): void {
    if (this.#exhaustedReason) throw this.#error(this.#exhaustedReason);
    if (this.signal.aborted || this.remainingWallTimeMs() <= 0) {
      throw this.#error("wall-clock limit");
    }
  }

  shouldWrapUp(reservedModelRequests = 2): boolean {
    const snapshot = this.snapshot();
    return snapshot.remainingModelRequests <= Math.max(0, reservedModelRequests)
      || snapshot.remainingWallTimeMs <= this.limits.maxWallTimeMs * 0.35
      || snapshot.estimatedInputTokens >= this.limits.maxEstimatedInputTokens * 0.75
      || snapshot.outputTokens >= this.limits.maxOutputTokens * 0.75
      || snapshot.costUsd >= this.limits.maxCostUsd * 0.75;
  }

  remainingWallTimeMs(): number {
    return Math.max(0, this.limits.maxWallTimeMs - (Date.now() - this.#startedAt));
  }

  snapshot(): ReviewBudgetSnapshot {
    return {
      elapsedMs: Math.max(0, Date.now() - this.#startedAt),
      modelRequests: this.#modelRequests,
      estimatedInputTokens: this.#estimatedInputTokens,
      reportedInputTokens: this.#reportedInputTokens,
      outputTokens: this.#outputTokens,
      cachedTokens: this.#cachedTokens,
      reasoningTokens: this.#reasoningTokens,
      costUsd: Number(this.#costUsd.toFixed(8)),
      remainingModelRequests: Math.max(0, this.limits.maxModelRequests - this.#modelRequests),
      remainingWallTimeMs: this.remainingWallTimeMs(),
    };
  }

  #error(reason: string): ReviewBudgetExceededError {
    return new ReviewBudgetExceededError(reason, this.snapshot());
  }

  #publishSnapshot(): ReviewBudgetSnapshot {
    const snapshot = this.snapshot();
    this.#onSnapshot?.(snapshot);
    return snapshot;
  }
}

export function isReviewBudgetExceededError(error: unknown): error is ReviewBudgetExceededError {
  return error instanceof ReviewBudgetExceededError;
}

export function formatBudgetSummary(snapshot: ReviewBudgetSnapshot): string {
  const reported = snapshot.reportedInputTokens > 0
    ? snapshot.reportedInputTokens.toLocaleString("en-US")
    : `~${snapshot.estimatedInputTokens.toLocaleString("en-US")}`;
  return [
    `${snapshot.modelRequests} model request${snapshot.modelRequests === 1 ? "" : "s"}`,
    `${reported} input tokens`,
    `${snapshot.outputTokens.toLocaleString("en-US")} output tokens`,
    `${snapshot.cachedTokens.toLocaleString("en-US")} cached tokens`,
    `$${snapshot.costUsd.toFixed(4)}`,
    `${Math.round(snapshot.elapsedMs / 1_000)}s elapsed`,
  ].join(" · ");
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
