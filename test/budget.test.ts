import { describe, expect, it, vi } from "vitest";

import {
  formatBudgetSummary,
  ReviewBudget,
  ReviewBudgetExceededError,
  type ReviewBudgetLimits,
} from "../src/budget.ts";

const limits: ReviewBudgetLimits = {
  maxWallTimeMs: 60_000,
  maxModelRequests: 2,
  maxEstimatedInputTokens: 1_000,
  maxOutputTokens: 500,
  maxCostUsd: 0.01,
  modelRequestTimeoutMs: 5_000,
};

describe("ReviewBudget", () => {
  it("accounts for retries and refuses a request beyond the shared request cap", () => {
    const budget = new ReviewBudget(limits);

    budget.reserveModelRequest(400, 100);
    budget.reserveModelRequest(400, 100);

    expect(() => budget.reserveModelRequest(400, 100)).toThrowError(ReviewBudgetExceededError);
    expect(budget.snapshot()).toMatchObject({
      modelRequests: 2,
      estimatedInputTokens: 200,
      remainingModelRequests: 0,
    });
  });

  it("stops before a request whose estimated context or output can exceed the cap", () => {
    const inputBudget = new ReviewBudget({ ...limits, maxEstimatedInputTokens: 100 });
    const outputBudget = new ReviewBudget({ ...limits, maxOutputTokens: 99 });

    expect(() => inputBudget.reserveModelRequest(404, 10)).toThrow("estimated input-token limit");
    expect(() => outputBudget.reserveModelRequest(40, 100)).toThrow("output-token limit");
  });

  it("records provider usage and exposes a concise operator summary", () => {
    const budget = new ReviewBudget(limits);
    budget.reserveModelRequest(400, 100);
    const snapshot = budget.recordUsage({
      inputTokens: 80,
      outputTokens: 20,
      cachedTokens: 50,
      reasoningTokens: 5,
      costUsd: 0.004,
    });

    expect(snapshot).toMatchObject({
      reportedInputTokens: 80,
      outputTokens: 20,
      cachedTokens: 50,
      reasoningTokens: 5,
      costUsd: 0.004,
    });
    expect(formatBudgetSummary(snapshot)).toContain("80 input tokens");
    expect(formatBudgetSummary(snapshot)).toContain("$0.0040");
  });

  it("marks reported overspend and stops before another model call", () => {
    const budget = new ReviewBudget(limits);
    budget.reserveModelRequest(400, 100);
    budget.recordUsage({
      inputTokens: 80,
      outputTokens: 20,
      cachedTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.02,
    });

    expect(() => budget.reserveModelRequest(400, 100)).toThrow("reported cost limit");
  });

  it("resumes cumulative resource use without charging queue backoff as active wall time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T00:00:00.000Z"));
    try {
      const firstDelivery = new ReviewBudget(limits);
      firstDelivery.reserveModelRequest(400, 100);
      firstDelivery.recordUsage({
        inputTokens: 80,
        outputTokens: 20,
        cachedTokens: 50,
        reasoningTokens: 5,
        costUsd: 0.004,
      });
      vi.advanceTimersByTime(5_000);
      const persisted = firstDelivery.snapshot();

      // A queue backoff is not active review time, but its prior model spend
      // must survive the redelivery.
      vi.advanceTimersByTime(120_000);
      const redelivery = ReviewBudget.resume(limits, persisted);

      expect(redelivery.snapshot()).toMatchObject({
        elapsedMs: 5_000,
        modelRequests: 1,
        estimatedInputTokens: 100,
        reportedInputTokens: 80,
        outputTokens: 20,
        cachedTokens: 50,
        reasoningTokens: 5,
        costUsd: 0.004,
        remainingModelRequests: 1,
        remainingWallTimeMs: 55_000,
      });
      redelivery.reserveModelRequest(400, 100);
      expect(() => redelivery.reserveModelRequest(400, 100)).toThrow("model request limit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes durable snapshots after both reservation and reported usage", () => {
    const snapshots: Array<ReturnType<ReviewBudget["snapshot"]>> = [];
    const budget = new ReviewBudget(limits, Date.now(), (snapshot) => snapshots.push(snapshot));

    budget.reserveModelRequest(400, 100);
    budget.recordUsage({
      inputTokens: 80,
      outputTokens: 20,
      cachedTokens: 50,
      reasoningTokens: 5,
      costUsd: 0.004,
    });

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toMatchObject({ modelRequests: 1, estimatedInputTokens: 100, outputTokens: 0 });
    expect(snapshots[1]).toMatchObject({ modelRequests: 1, reportedInputTokens: 80, outputTokens: 20 });
  });

  it("can reserve every physical attempt needed for finalization", () => {
    const budget = new ReviewBudget({ ...limits, maxModelRequests: 9 });
    for (let request = 0; request < 6; request++) budget.reserveModelRequest(4, 1);

    expect(budget.shouldWrapUp()).toBe(false);
    expect(budget.shouldWrapUp(3)).toBe(true);
  });
});
