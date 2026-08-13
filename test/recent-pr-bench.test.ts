import { describe, expect, it } from "vitest";

import { aggregateRecentPrScores, scoreRecentPrCase, type RecentPrBenchCase } from "../src/recent-pr-bench.ts";

const fixture: RecentPrBenchCase = {
  id: "case",
  repository: "owner/repo",
  pullNumber: 1,
  title: "change",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  bots: ["reviewer[bot]"],
  labels: [{
    id: "bug",
    path: "src/a.ts",
    side: "RIGHT",
    lineStart: 10,
    lineEnd: 12,
    rootCause: "A stale cache key reuses the wrong head.",
    requiredTermGroups: [["cache"], ["stale", "wrong"], ["head", "commit"]],
    reviewUrl: "https://github.com/owner/repo/pull/1#discussion_r1",
    fixSha: "c".repeat(40),
  }],
};

describe("recent PR benchmark scoring", () => {
  it("matches semantic concepts at the frozen changed-line range", () => {
    const output = {
      summary: "one issue",
      findings: [{
        path: "src/a.ts",
        line: 11,
        side: "RIGHT" as const,
        severity: "high" as const,
        title: "Cache returns stale data",
        why: "The symbolic head key can reuse content from the wrong commit.",
        evidence: "The changed cache expression omits the commit SHA.",
        suggestedFix: "Key by commit SHA.",
        confidence: 0.95,
      }],
    };
    expect(scoreRecentPrCase(fixture, output)).toMatchObject({
      deterministicTruePositives: 1,
      deterministicFalseNegatives: 0,
      unmatchedFindingsPendingAdjudication: 0,
    });
  });

  it("does not mislabel novel findings as false positives", () => {
    const output = {
      summary: "different issue",
      findings: [{
        path: "src/b.ts",
        line: 2,
        side: "RIGHT" as const,
        severity: "medium" as const,
        title: "Different defect",
        why: "A separate runtime path fails.",
        evidence: "Changed code proves it.",
        suggestedFix: "Fix the path.",
        confidence: 0.9,
      }],
    };
    const score = scoreRecentPrCase(fixture, output);
    expect(score.unmatchedFindingsPendingAdjudication).toBe(1);
    expect(aggregateRecentPrScores([{ score, output, costUsd: 0.01, elapsedMs: 20 }])).toMatchObject({
      deterministicRecallLowerBound: 0,
      strictPrecisionLowerBound: 0,
      unmatchedFindingsPendingAdjudication: 1,
    });
  });
});
