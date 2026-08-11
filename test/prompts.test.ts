import { describe, expect, it } from "vitest";

import { discoveryPrompt, REVIEW_LENS, verificationPrompt } from "../src/prompts.ts";
import type { PullChangeSet, ReviewJob } from "../src/types.ts";

describe("review prompt budgets", () => {
  it("bounds oversized discovery input while retaining instructions and a truncation marker", () => {
    const prompt = discoveryPrompt(
      { ...job(), body: "body".repeat(20_000) },
      changes("diff".repeat(50_000)),
      [{ summary: "check".repeat(10_000) }],
      "policy".repeat(20_000),
      REVIEW_LENS,
    );

    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(72_000);
    expect(prompt).toContain("Gaston truncated");
    expect(prompt).toContain('"findings"');
  });

  it("bounds oversized verification candidates without losing the output contract", () => {
    const prompt = verificationPrompt(
      job(),
      [{
        source: "discovery",
        review: {
          summary: "summary".repeat(10_000),
          findings: Array.from({ length: 12 }, (_, index) => ({
            path: `src/${index}.ts`,
            line: index + 1,
            side: "RIGHT" as const,
            severity: "high" as const,
            title: "title",
            why: "why".repeat(1_000),
            evidence: "evidence".repeat(1_000),
            suggestedFix: "fix".repeat(1_000),
            confidence: 0.95,
          })),
        },
      }],
      changes(""),
      "policy".repeat(20_000),
    );

    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(72_000);
    expect(prompt).toContain("Gaston truncated the discovery candidates");
    expect(prompt).toContain("Output exactly one JSON object");
  });
});

function changes(diff: string): PullChangeSet {
  return {
    diff,
    truncated: false,
    files: Array.from({ length: 300 }, (_, index) => ({
      path: `src/very-long-directory-name-${index}/file-${index}.ts`,
      status: "modified",
      additions: 10,
      deletions: 5,
      patch: null,
    })),
  };
}

function job(): ReviewJob {
  return {
    deliveryId: "delivery",
    installationId: 1,
    owner: "owner",
    repo: "repo",
    pullNumber: 1,
    title: "title",
    body: "body",
    baseRef: "main",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    queuedAt: "2026-08-10T00:00:00.000Z",
    trigger: "automatic",
  };
}
