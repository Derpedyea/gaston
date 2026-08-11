import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppJwt, getGitHubAppReadiness, GitHubClient } from "../src/github.ts";
import type { ReviewJob } from "../src/types.ts";

afterEach(() => vi.unstubAllGlobals());

describe("createAppJwt", () => {
  it.each(["pkcs8", "pkcs1"] as const)("signs a JWT from a %s GitHub App key", async (type) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type }).toString();
    const jwt = await createAppJwt("12345", pem, Date.UTC(2026, 7, 10));
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    expect(payload).toMatchObject({ iss: "12345" });
    expect(payload.exp - payload.iat).toBe(600);
  });
});

describe("getGitHubAppReadiness", () => {
  it("reports a missing issue_comment subscription without exposing credentials", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/app");
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      return new Response(JSON.stringify({
        events: ["pull_request"],
        permissions: { contents: "read", pull_requests: "write", checks: "write", issues: "write" },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(getGitHubAppReadiness("12345", pem)).resolves.toEqual({
      ok: false,
      requirements: {
        pullRequestEvent: true,
        issueCommentEvent: false,
        contentsRead: true,
        pullRequestsWrite: true,
        checksWrite: true,
        issuesWrite: true,
      },
    });
  });
});

describe("GitHubClient review state", () => {
  it("acknowledges a manual-review issue comment with an eyes reaction", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/repos/owner/repo/issues/comments/99/reactions");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ content: "eyes" });
      return new Response(JSON.stringify({ id: 7, content: "eyes" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);

    await testClient().reactToIssueComment("owner", "repo", 99, "eyes");

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("always loads the cumulative pull-request file set instead of only the latest commit range", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/repos/owner/repo/pulls/1/files?per_page=100&page=1");
      expect(String(input)).not.toContain("/compare/");
      return new Response(JSON.stringify([
        {
          filename: "src/from-first-commit.ts",
          status: "added",
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1 @@\n+first",
        },
        {
          filename: "src/from-second-commit.ts",
          status: "added",
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1 @@\n+second",
        },
      ]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const changes = await testClient().getPullChanges({ ...job(), beforeSha: "c".repeat(40) });

    expect(changes.files.map((file) => file.path)).toEqual([
      "src/from-first-commit.ts",
      "src/from-second-commit.ts",
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("classifies transport failures as retryable GitHub errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connection reset");
    }));

    const error = await testClient().getPull(job()).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "GitHubApiError",
      status: 503,
      retryable: true,
    });
    expect(String(error)).toContain("transport failed: connection reset");
  });

  it("updates the existing persistent summary instead of creating another", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/issues/1/comments?")) {
        return new Response(JSON.stringify([{ id: 9, body: "<!-- gaston-summary:1 -->\nold" }]), { status: 200 });
      }
      expect(url).toContain("/issues/comments/9");
      expect(init?.method).toBe("PATCH");
      expect(String(init?.body)).toContain("new summary");
      return new Response(JSON.stringify({ id: 9 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await testClient().upsertReviewSummary(job(), { summary: "new summary", findings: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("creates a fresh check run when the prior run is already completed", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
      });
      if (requests.length === 1) {
        return new Response(JSON.stringify({
          check_runs: [{
            id: 9,
            external_id: `gaston-review:${job().pullNumber}:${job().baseSha}:${job().headSha}`,
            name: "Gaston review",
            status: "completed",
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: 10,
        external_id: `gaston-review:${job().pullNumber}:${job().baseSha}:${job().headSha}`,
        name: "Gaston review",
        status: "in_progress",
      }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(testClient().ensureCheckRun(job())).resolves.toBe(10);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ method: "POST" });
    expect(requests[1]!.url).toMatch(/\/check-runs$/);
    expect(JSON.parse(requests[1]!.body)).toMatchObject({ status: "in_progress" });
  });

  it("creates a queued check before a serialized review starts", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
      });
      if (requests.length === 1) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 10, name: "Gaston review", status: "queued" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(testClient().ensureQueuedCheckRun(job())).resolves.toBe(10);
    expect(JSON.parse(requests[1]!.body)).toMatchObject({
      status: "queued",
      output: { title: "Review queued" },
    });
  });

  it("starts a queued check when its serialized turn begins", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Response(
      String(init?.body),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetch);

    await testClient().startCheckRun(job(), 10);

    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
      status: "in_progress",
      output: { title: "Reviewing pull request" },
    });
  });

  it("publishes bounded-phase progress on the active check", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Response(
      String(init?.body),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetch);

    await testClient().updateCheckProgress(job(), 10, "Verifying candidate findings", "4 requests · 90s elapsed");

    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
      status: "in_progress",
      output: {
        title: "Verifying candidate findings",
        summary: "4 requests · 90s elapsed",
      },
    });
  });

  it("reports resource-budget exhaustion as neutral with usage evidence", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Response(
      String(init?.body),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetch);

    await testClient().stopCheckForBudget(job(), 10, "wall-clock limit", {
      elapsedMs: 240_000,
      modelRequests: 6,
      estimatedInputTokens: 200_000,
      reportedInputTokens: 190_000,
      outputTokens: 12_000,
      cachedTokens: 80_000,
      reasoningTokens: 2_000,
      costUsd: 0.12,
      remainingModelRequests: 0,
      remainingWallTimeMs: 0,
    });

    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Review stopped at resource budget" },
    });
    expect(String(fetch.mock.calls[0]![1]?.body)).toContain("190,000 input tokens");
  });

  it("marks superseded work as cancelled instead of successful", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Response(
      String(init?.body),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetch);

    await testClient().supersedeCheck(job(), 10);

    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
      output: { title: "Review superseded" },
    });
  });

  it("reports incomplete evidence as neutral instead of a clean success", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Response(
      String(init?.body),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetch);

    await testClient().completeCheck(
      job(),
      10,
      { summary: "No bug was proved.", findings: [] },
      undefined,
      {
        sufficient: false,
        totalChangedFiles: 4,
        inspectedChangedFiles: 1,
        toolCalls: 2,
        okResults: 1,
        truncatedResults: 1,
        transientErrors: 0,
        permanentErrors: 0,
        invalidArguments: 0,
        initialDiffTruncated: true,
        limitations: ["The initial cumulative diff was truncated."],
      },
    );

    const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({
      status: "completed",
      conclusion: "neutral",
      output: { title: "Review evidence incomplete" },
    });
    expect(body.output.summary).toContain("did not treat unavailable evidence as a clean review");
  });
});

function testClient(): GitHubClient {
  return Reflect.construct(GitHubClient as unknown as Function, ["token"]) as GitHubClient;
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
