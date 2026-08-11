import { describe, expect, it } from "vitest";

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
});
