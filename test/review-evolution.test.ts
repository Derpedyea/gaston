import { describe, expect, it } from "vitest";
import {
  buildReviewLedger,
  findingFingerprint,
  findingsNeedingInlineComment,
  outstandingPriorFindings,
  parseFindingMarker,
  renderFindingMarker,
  type ReviewLedger,
} from "../src/review-evolution.ts";
import type { Finding, ReviewJob } from "../src/types.ts";

describe("review evolution", () => {
  it("round-trips a stable hidden marker", () => {
    const marker = renderFindingMarker(finding());

    expect(parseFindingMarker(marker)).toBe(findingFingerprint(finding()));
    expect(findingFingerprint({ ...finding(), title: "  BUG   TITLE " })).toBe(findingFingerprint(finding()));
  });

  it("keeps open findings, clears resolved threads, and suppresses repeats", () => {
    const fingerprint = findingFingerprint(finding());
    const ledger = priorLedger(fingerprint);
    const open = outstandingPriorFindings(ledger, [{
      threadId: "thread-1",
      fingerprint,
      path: "src/index.ts",
      line: 4,
      title: "Bug title",
      severity: "high",
      resolved: false,
      outdated: true,
      body: "finding",
      replies: [],
    }]);

    expect(open).toHaveLength(1);
    expect(findingsNeedingInlineComment([finding()], open)).toEqual([]);
    expect(outstandingPriorFindings(ledger, [{ ...openThread(fingerprint), resolved: true }])).toEqual([]);
  });

  it("atomically advances head state while retaining historical resolutions", () => {
    const fingerprint = findingFingerprint(finding());
    const ledger = buildReviewLedger({
      job: job(),
      review: { summary: "clean", findings: [] },
      previous: priorLedger(fingerprint),
      threads: [{ ...openThread(fingerprint), resolved: true }],
      threadContextComplete: true,
      now: 123,
    });

    expect(ledger).toMatchObject({
      schemaVersion: 1,
      lastHeadSha: "b".repeat(40),
      updatedAt: 123,
      findings: [{ fingerprint, status: "resolved" }],
    });
  });
});

function finding(): Finding {
  return {
    path: "src/index.ts",
    line: 4,
    side: "RIGHT",
    severity: "high",
    title: "Bug title",
    why: "It fails.",
    evidence: "Changed line.",
    suggestedFix: "Fix it.",
    confidence: 0.95,
  };
}

function openThread(fingerprint: string) {
  return {
    threadId: "thread-1",
    fingerprint,
    path: "src/index.ts",
    line: 4,
    title: "Bug title",
    severity: "high" as const,
    resolved: false,
    outdated: false,
    body: "finding",
    replies: [],
  };
}

function priorLedger(fingerprint: string): ReviewLedger {
  return {
    schemaVersion: 1,
    baseSha: "a".repeat(40),
    lastHeadSha: "c".repeat(40),
    findings: [{
      fingerprint,
      path: "src/index.ts",
      line: 4,
      side: "RIGHT",
      severity: "high",
      title: "Bug title",
      status: "open",
      firstSeenHeadSha: "c".repeat(40),
      lastSeenHeadSha: "c".repeat(40),
    }],
    updatedAt: 1,
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
