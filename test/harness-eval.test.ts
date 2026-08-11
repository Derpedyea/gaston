import { describe, expect, it } from "vitest";

import { evaluateHarness } from "../src/harness-eval.ts";
import type { ReviewBudgetSnapshot } from "../src/budget.ts";

describe("harness regression gates", () => {
  it("fails quality and resource regressions independently", () => {
    const budget: ReviewBudgetSnapshot = {
      elapsedMs: 10,
      modelRequests: 4,
      estimatedInputTokens: 100,
      reportedInputTokens: 100,
      outputTokens: 10,
      cachedTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.02,
      remainingModelRequests: 2,
      remainingWallTimeMs: 1_000,
    };
    const report = evaluateHarness([{
      name: "regression",
      output: { summary: "bad", findings: [] },
      expectation: {
        mustFind: ["src/a.ts:1:bug"],
        mustNotFind: [],
        maxModelRequests: 2,
        maxToolCalls: 1,
        maxCostUsd: 0.01,
      },
      budget,
      toolCalls: 3,
      elapsedMs: 10,
    }], {
      minPrecision: 1,
      minRecall: 1,
      maxP95ModelRequests: 2,
      maxP95ToolCalls: 1,
      maxP95CostUsd: 0.01,
    });

    expect(report.passed).toBe(false);
    expect(report.metrics.falseNegatives).toBe(1);
    expect(report.cases[0]!.failures).toEqual(expect.arrayContaining([
      expect.stringContaining("missing expected finding"),
      expect.stringContaining("model requests"),
      expect.stringContaining("tool calls"),
      expect.stringContaining("cost"),
    ]));
  });
});
