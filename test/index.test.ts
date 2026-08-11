import { describe, expect, it } from "vitest";

import { manualReviewJob } from "../src/review-job.ts";
import { reviewRetryDelaySeconds, shouldRetryReviewError } from "../src/retry.ts";

describe("queue retry classification", () => {
  it("acknowledges permanent OpenRouter key failures", () => {
    expect(shouldRetryReviewError(new Error(
      "OpenRouter discovery:state request failed (403): Key limit exceeded (weekly limit)",
    ))).toBe(false);
    expect(shouldRetryReviewError(new Error(
      "OPENROUTER_API_KEY is malformed; expected a full sk-or-v1-… API key",
    ))).toBe(false);
  });

  it("retries rate limits, provider failures, and transport errors", () => {
    expect(shouldRetryReviewError(new Error(
      "OpenRouter discovery:state request failed (429): rate limited",
    ))).toBe(true);
    expect(shouldRetryReviewError(new Error(
      "OpenRouter verification completion failed (502): provider unavailable",
    ))).toBe(true);
    expect(shouldRetryReviewError(new TypeError("Network connection lost"))).toBe(true);
    expect(shouldRetryReviewError(new Error(
      "Retryable review dependency failure: OpenRouter discovery request failed after 3 attempts",
    ))).toBe(true);
  });

  it("does not mislabel deterministic harness failures as transient dependencies", () => {
    expect(shouldRetryReviewError(new Error(
      "OpenRouter repeatedly returned invalid review JSON: findings must be an array",
    ))).toBe(false);
    expect(shouldRetryReviewError(new Error("unexpected invariant violation"))).toBe(false);
  });

  it("does not retry permanent GitHub API responses", () => {
    expect(shouldRetryReviewError(new Error(
      "GitHub API GET /repos/owner/repo/pulls/1 failed (404): not found",
    ))).toBe(false);
    expect(shouldRetryReviewError(new Error(
      "GitHub API POST /repos/owner/repo/check-runs failed (422): invalid",
    ))).toBe(false);
  });

  it("backs transient retries off quickly and caps the delay", () => {
    expect([1, 2, 3, 4, 10].map(reviewRetryDelaySeconds)).toEqual([5, 15, 45, 120, 120]);
  });
});

describe("manual review hydration", () => {
  it("builds a full review job from the current pull request state", () => {
    expect(manualReviewJob({
      kind: "manual",
      deliveryId: "delivery-2",
      installationId: 123,
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      commentId: 99,
      requestedBy: "maintainer",
      queuedAt: "2026-08-11T00:00:00.000Z",
    }, {
      number: 42,
      title: "Review me",
      body: "Details",
      state: "open",
      draft: false,
      base: { ref: "main", sha: "a".repeat(40) },
      head: { sha: "b".repeat(40) },
    })).toMatchObject({
      trigger: "manual",
      requestedBy: "maintainer",
      baseRef: "main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    });
  });
});
