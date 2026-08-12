import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleGitHubWebhook, toManualReviewRequest, toReviewJob, verifyWebhookSignature } from "../src/webhook.ts";
import type { Env } from "../src/types.ts";

afterEach(() => vi.unstubAllGlobals());

describe("verifyWebhookSignature", () => {
  it("matches GitHub's published SHA-256 test vector", async () => {
    const body = new TextEncoder().encode("Hello, World!").buffer as ArrayBuffer;
    const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    await expect(verifyWebhookSignature(body, signature, "It's a Secret to Everybody")).resolves.toBe(true);
    await expect(verifyWebhookSignature(body, signature, "wrong")).resolves.toBe(false);
  });
});

describe("toReviewJob", () => {
  const payload = {
    action: "synchronize",
    before: "c".repeat(40),
    after: "b".repeat(40),
    installation: { id: 123 },
    repository: { name: "repo", owner: { login: "owner" } },
    pull_request: {
      number: 42,
      title: "Fix it",
      body: "Details",
      draft: false,
      base: { ref: "main", sha: "a".repeat(40) },
      head: { sha: "b".repeat(40) },
    },
  };

  it("creates a bounded queue job for review actions", () => {
    expect(toReviewJob(payload, "delivery-1")).toMatchObject({
      installationId: 123,
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      headSha: "b".repeat(40),
      beforeSha: "c".repeat(40),
    });
  });

  it("only accepts a valid synchronize before SHA", () => {
    expect(toReviewJob({ ...payload, before: "not-a-sha" }, "x")).not.toHaveProperty("beforeSha");
    expect(toReviewJob({ ...payload, action: "opened" }, "x")).not.toHaveProperty("beforeSha");
  });

  it("ignores drafts and irrelevant actions", () => {
    expect(toReviewJob({ ...payload, action: "closed" }, "x")).toBeNull();
    expect(toReviewJob({
      ...payload,
      pull_request: { ...payload.pull_request, draft: true },
    }, "x")).toBeNull();
  });
});

describe("toManualReviewRequest", () => {
  const payload = {
    action: "created",
    installation: { id: 123 },
    repository: { name: "repo", owner: { login: "owner" } },
    issue: { number: 42, pull_request: { url: "https://api.github.com/repos/owner/repo/pulls/42" } },
    comment: {
      id: 99,
      body: "@gaston review",
      author_association: "MEMBER",
      user: { login: "maintainer", type: "User" },
    },
  };

  it.each([
    "@gaston",
    "@gaston review",
    "@Gaston full review",
    "please review\n@gaston-derpedyea-reviewer review",
  ])("accepts a trusted PR comment command: %s", (body) => {
    expect(toManualReviewRequest({
      ...payload,
      comment: { ...payload.comment, body },
    }, "delivery-2")).toMatchObject({
      kind: "manual",
      installationId: 123,
      owner: "owner",
      repo: "repo",
      pullNumber: 42,
      commentId: 99,
      requestedBy: "maintainer",
    });
  });

  it("accepts a signed issue_comment webhook and enqueues the manual request", async () => {
    const secret = "webhook-secret";
    const body = JSON.stringify(payload);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
    const signature = `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    const send = vi.fn(async () => undefined);
    const pending: Promise<unknown>[] = [];
    const waitUntil = vi.fn((promise: Promise<unknown>) => pending.push(promise));
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const githubFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/app/installations/123/access_tokens")) {
        return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      }
      expect(url).toBe("https://api.github.com/repos/owner/repo/issues/comments/99/reactions");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ content: "eyes" });
      return new Response(JSON.stringify({ id: 7, content: "eyes" }), { status: 201 });
    });
    vi.stubGlobal("fetch", githubFetch);
    const request = new Request("https://example.com/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-delivery": "delivery-3",
        "x-github-event": "issue_comment",
        "x-hub-signature-256": signature,
      },
      body,
    });

    const response = await handleGitHubWebhook(request, {
      GITHUB_APP_ID: "12345",
      GITHUB_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      GITHUB_WEBHOOK_SECRET: secret,
      REVIEW_QUEUE: { send },
    } as unknown as Env, { waitUntil });
    await Promise.all(pending);

    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: "manual",
      deliveryId: "delivery-3",
      pullNumber: 42,
      commentId: 99,
      dashboardUrl: "https://example.com",
    }), { contentType: "json" });
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(githubFetch).toHaveBeenCalledTimes(2);
  });

  it("ignores issue comments, untrusted users, bots, edits, and non-command prose", () => {
    expect(toManualReviewRequest({ ...payload, issue: { number: 42 } }, "x")).toBeNull();
    expect(toManualReviewRequest({
      ...payload,
      comment: { ...payload.comment, author_association: "NONE" },
    }, "x")).toBeNull();
    expect(toManualReviewRequest({
      ...payload,
      comment: { ...payload.comment, user: { login: "bot", type: "Bot" } },
    }, "x")).toBeNull();
    expect(toManualReviewRequest({ ...payload, action: "edited" }, "x")).toBeNull();
    expect(toManualReviewRequest({
      ...payload,
      comment: { ...payload.comment, body: "I wonder if @gaston reviews this" },
    }, "x")).toBeNull();
  });
});
