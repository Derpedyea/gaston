import { describe, expect, it, vi } from "vitest";

import { manualReviewJob } from "../src/review-job.ts";
import { reviewRetryDelaySeconds, shouldRetryReviewError } from "../src/retry.ts";
import { handleReviewSessionApi } from "../src/session-api.ts";

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
      dashboardUrl: "https://gaston.example",
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
      dashboardUrl: "https://gaston.example",
      baseRef: "main",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    });
  });
});

describe("review session API", () => {
  it("stays unavailable until a dashboard secret is configured", async () => {
    const response = await handleReviewSessionApi(
      new Request("https://gaston.example/api/reviews/owner/repo/42"),
      { REVIEWER: { getByName: vi.fn() } },
    );

    expect(response.status).toBe(404);
  });

  it("authenticates, routes to the per-PR object, and supports conditional polling", async () => {
    const session = {
      schemaVersion: 1 as const,
      revision: 7,
      runKey: "run",
      artifactsReady: true,
      job: {
        deliveryId: "delivery",
        installationId: 1,
        owner: "owner",
        repo: "repo",
        pullNumber: 42,
        title: "Review me",
        body: "",
        baseRef: "main",
        baseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        queuedAt: "2026-08-12T00:00:00.000Z",
        trigger: "automatic" as const,
      },
      phase: "discovery" as const,
      checkRunId: 9,
      updatedAt: 1,
      files: [],
      diff: "",
      changesTruncated: false,
    };
    const stub = {
      sessionRevision: vi.fn(async () => 7),
      session: vi.fn(async () => session),
    };
    const getByName = vi.fn(() => stub);
    const env = {
      DASHBOARD_TOKEN: "dashboard-secret",
      REVIEWER_GENERATION: "14",
      REVIEWER: { getByName },
    };

    const unauthorized = await handleReviewSessionApi(
      new Request("https://gaston.example/api/reviews/owner/repo/42"),
      env,
    );
    expect(unauthorized.status).toBe(401);
    expect(getByName).not.toHaveBeenCalled();

    const response = await handleReviewSessionApi(
      new Request("https://gaston.example/api/reviews/owner/repo/42", {
        headers: { authorization: "Bearer dashboard-secret" },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"7"');
    await expect(response.json()).resolves.toMatchObject({ revision: 7, phase: "discovery" });
    expect(getByName).toHaveBeenCalledWith("14:owner/repo#42");

    const unchanged = await handleReviewSessionApi(
      new Request("https://gaston.example/api/reviews/owner/repo/42", {
        headers: {
          authorization: "Bearer dashboard-secret",
          "if-none-match": '"7"',
        },
      }),
      env,
    );
    expect(unchanged.status).toBe(304);
    expect(stub.session).toHaveBeenCalledTimes(1);
  });
});
