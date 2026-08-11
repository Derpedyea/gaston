import { describe, expect, it } from "vitest";

import { validateHistoricalCorpus, type HistoricalCorpus } from "../src/historical-corpus.ts";

describe("historical PR corpus", () => {
  it("validates a public-safe synthetic corpus with a cumulative head sequence", () => {
    const pullRequests = Array.from({ length: 25 }, (_, index) => ({
      repository: "example/repository",
      number: index + 1,
      title: `Synthetic pull request ${index + 1}`,
      state: "MERGED",
      baseRefName: "main",
      baseRefOid: "a".repeat(40),
      headRefOid: index === 0 ? "f".repeat(40) : `${(index % 9) + 1}`.repeat(40),
      url: `https://example.invalid/pull/${index + 1}`,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      heads: index === 0
        ? ["b".repeat(40), "c".repeat(40), "d".repeat(40), "e".repeat(40), "f".repeat(40)]
        : [`${(index % 9) + 1}`.repeat(40)],
      fileCount: 1,
      labels: index === 0
        ? { mustFind: ["src/example.ts:1:synthetic finding"], mustNotFind: [] }
        : { mustFind: [], mustNotFind: [] },
    }));
    const corpus: HistoricalCorpus = {
      capturedAt: "2026-01-01T00:00:00Z",
      source: "Synthetic public test data",
      pullRequests,
    };
    const report = validateHistoricalCorpus(corpus);

    expect(report).toMatchObject({ passed: true, pullRequests: 25 });
    expect(report.headTransitions).toBeGreaterThanOrEqual(4);
  });
});
