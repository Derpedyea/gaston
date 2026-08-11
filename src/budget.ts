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
  maxWallTimeMs: 4 * 60_000,
  maxModelRequests: 6,
  maxEstimatedInputTokens: 250_000,
  maxOutputTokens: 48_000,
  maxCostUsd: 0.20,
  modelRequestTimeoutMs: 120_000,
};

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

  constructor(limits: ReviewBudgetLimits = DEFAULT_REVIEW_BUDGET, now = Date.now()) {
    this.limits = limits;
    this.#startedAt = now;
    this.signal = AbortSignal.timeout(limits.maxWallTimeMs);
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
    return this.snapshot();
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
    return this.snapshot();
  }

  throwIfExceeded(): void {
    if (this.#exhaustedReason) throw this.#error(this.#exhaustedReason);
    if (this.signal.aborted || this.remainingWallTimeMs() <= 0) {
      throw this.#error("wall-clock limit");
    }
  }

  shouldWrapUp(): boolean {
    const snapshot = this.snapshot();
    return snapshot.remainingModelRequests <= 2
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
