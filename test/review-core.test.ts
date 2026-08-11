import { describe, expect, it } from "vitest";
import {
  filterFindings,
  parseChangedLines,
  parseReviewOutput,
  shouldRequestChanges,
} from "../src/review-core.ts";

describe("parseChangedLines", () => {
  it("tracks added and deleted lines by the new path", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,3 @@",
      "-old one",
      "-old two",
      "+new one",
      "+new two",
      "+new three",
      "diff --git a/old.ts b/new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -7 +7 @@",
      "-before",
      "+after",
    ].join("\n");

    const changed = parseChangedLines(diff);
    expect([...changed.get("src/a.ts")!.left]).toEqual([10, 11]);
    expect([...changed.get("src/a.ts")!.right]).toEqual([10, 11, 12]);
    expect([...changed.get("new.ts")!.left]).toEqual([7]);
    expect([...changed.get("new.ts")!.right]).toEqual([7]);
  });

  it("uses the old path for a deleted file", () => {
    const diff = [
      "--- a/deleted.ts",
      "+++ /dev/null",
      "@@ -3 +0,0 @@",
      "-gone",
    ].join("\n");
    expect([...parseChangedLines(diff).get("deleted.ts")!.left]).toEqual([3]);
  });
});

describe("review output", () => {
  it("extracts fenced JSON and normalizes fields", () => {
    const review = parseReviewOutput(`Result:\n\`\`\`json
      {"summary":"Risk found","findings":[{
        "path":"./src/a.ts","line":10,"side":"right","severity":"HIGH",
        "title":"Drops writes","why":"A retry loses data","evidence":"caller retries",
        "suggested_fix":"persist before ack","confidence":0.91
      }]}
    \`\`\``);

    expect(review.findings[0]).toMatchObject({
      path: "src/a.ts",
      side: "RIGHT",
      severity: "high",
      suggestedFix: "persist before ack",
    });
  });

  it("filters low-confidence, unchanged-line, and duplicate findings", () => {
    const review = parseReviewOutput(JSON.stringify({
      summary: "summary",
      findings: [
        finding({ title: "real", confidence: 0.95 }),
        finding({ title: "real", confidence: 0.95 }),
        finding({ title: "weak", confidence: 0.4 }),
        finding({ title: "unchanged", line: 99, confidence: 0.99 }),
      ],
    }));
    const changed = new Map([["src/a.ts", { left: new Set<number>(), right: new Set([10]) }]]);
    const filtered = filterFindings(review, changed, 0.82, 8);
    expect(filtered.findings.map((item) => item.title)).toEqual(["real"]);
  });

  it("rejects control characters and traversal in model-provided paths", () => {
    const review = parseReviewOutput(JSON.stringify({
      summary: "summary",
      findings: [
        finding({ path: "../secret" }),
        finding({ path: "src/bad\nname.ts" }),
        finding({ path: "src\\windows.ts" }),
      ],
    }));
    expect(review.findings).toEqual([]);
  });
});

describe("request changes threshold", () => {
  const blocker = parseReviewOutput(JSON.stringify({
    summary: "x",
    findings: [finding({ severity: "blocker" })],
  })).findings;
  const high = parseReviewOutput(JSON.stringify({
    summary: "x",
    findings: [finding({ severity: "high" })],
  })).findings;

  it("blocks only at the configured severity", () => {
    expect(shouldRequestChanges(blocker, "blocker")).toBe(true);
    expect(shouldRequestChanges(high, "blocker")).toBe(false);
    expect(shouldRequestChanges(high, "high")).toBe(true);
    expect(shouldRequestChanges(blocker, "off")).toBe(false);
  });
});

function finding(overrides: Record<string, unknown> = {}) {
  return {
    path: "src/a.ts",
    line: 10,
    side: "RIGHT",
    severity: "medium",
    title: "bug",
    why: "observable failure",
    evidence: "specific evidence",
    suggestedFix: "small fix",
    confidence: 0.9,
    ...overrides,
  };
}
