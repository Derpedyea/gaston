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
      expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
      if (String(input) === "https://api.github.com/app") {
        return new Response(JSON.stringify({
          events: ["pull_request"],
          permissions: { contents: "read", pull_requests: "write", checks: "write", issues: "write" },
        }), { status: 200 });
      }
      expect(String(input)).toBe("https://api.github.com/app/installations?per_page=100");
      return new Response(JSON.stringify([{
        events: ["pull_request"],
        permissions: { contents: "read", pull_requests: "write", checks: "write" },
        suspended_at: null,
      }]), { status: 200 });
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
        installationsPresent: true,
        installationsReady: false,
      },
      installations: { total: 1, ready: 0 },
    });
  });
});

describe("GitHubClient review state", () => {
  it("binds marker lookups to the authenticated App identity returned by GitHub", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const marker = `<!-- gaston-review:1:${job().baseSha}:${job().headSha} -->`;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app/installations/1/access_tokens")) {
        return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      }
      if (url === "https://api.github.com/app") {
        return new Response(JSON.stringify({ id: 12_345, slug: "gaston" }), { status: 200 });
      }
      expect(url).toContain("/pulls/1/reviews?");
      return new Response(JSON.stringify([{
        id: 77,
        body: marker,
        commit_id: job().headSha,
        user: { login: "Gaston[bot]", type: "Bot" },
      }]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const client = await GitHubClient.forInstallation(
      "12345",
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      1,
    );

    await expect(client.hasPublishedReview(job())).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails closed when GitHub returns a different authenticated App id", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/access_tokens")) {
        return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
      }
      expect(url).toBe("https://api.github.com/app");
      return new Response(JSON.stringify({ id: 98_765, slug: "attacker" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(GitHubClient.forInstallation(
      "12345",
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      1,
    )).rejects.toThrow("unexpected authenticated App identity");
  });

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

  it("opens a history-free repository archive at the exact requested commit", async () => {
    const bytes = new Uint8Array([31, 139, 8, 0]);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`https://api.github.com/repos/owner/repo/tarball/${job().headSha}`);
      expect(init?.redirect).toBe("follow");
      return new Response(bytes, {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      });
    });
    vi.stubGlobal("fetch", fetch);

    const archive = await testClient().getRepositoryArchive(job(), job().headSha);

    expect(archive.contentLength).toBe(bytes.byteLength);
    await expect(new Response(archive.body).arrayBuffer()).resolves.toHaveProperty("byteLength", bytes.byteLength);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("paginates the cumulative file set beyond the previous 300-file cap", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      const count = page <= 3 ? 100 : 1;
      return new Response(JSON.stringify(Array.from({ length: count }, (_, index) => ({
        filename: `src/page-${page}-${index}.ts`,
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      }))), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const changes = await testClient().getPullChanges(job());

    expect(changes.files).toHaveLength(301);
    expect(changes.files.at(-1)?.path).toBe("src/page-4-0.ts");
    expect(changes.filesTruncated).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("marks an omitted per-file patch as incomplete instead of a clean full diff", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      filename: "src/oversized.ts",
      status: "modified",
      additions: 20_000,
      deletions: 20_000,
    }]), { status: 200 })));

    const changes = await testClient().getPullChanges(job());

    expect(changes.files[0]?.patch).toBeNull();
    expect(changes).toMatchObject({
      truncated: true,
      diffTruncated: true,
      unavailablePatchPaths: ["src/oversized.ts"],
    });
  });

  it("bounds retained patch memory and marks the omitted remainder incomplete", async () => {
    const largePatch = `@@ -1 +1 @@\n-${"a".repeat(600_000)}\n+${"b".repeat(600_000)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      {
        filename: "src/first.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: largePatch,
      },
      {
        filename: "src/second.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: largePatch,
      },
    ]), { status: 200 })));

    const changes = await testClient().getPullChanges(job());

    expect(changes.files.map((file) => file.patch === null)).toEqual([false, true]);
    expect(changes).toMatchObject({
      truncated: true,
      diffTruncated: true,
      unavailablePatchPaths: ["src/second.ts"],
    });
    expect(changes.diff).toContain("src/first.ts");
    expect(changes.diff).not.toContain("src/second.ts");
  });

  it("marks the GitHub 3,000-file ceiling as incomplete", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
        filename: `src/page-${page}-${index}.ts`,
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      }))), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const changes = await testClient().getPullChanges(job());

    expect(changes.files).toHaveLength(3_000);
    expect(changes).toMatchObject({ truncated: true, filesTruncated: true });
    expect(fetch).toHaveBeenCalledTimes(30);
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

  it("terminally closes a known old-head queued check after a different-head takeover", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("/check-runs/77");
      expect(init?.method).toBe("PATCH");
      expect(init?.signal).toBeUndefined();
      expect(JSON.parse(String(init?.body))).toMatchObject({
        status: "completed",
        conclusion: "cancelled",
      });
      return new Response(JSON.stringify({ id: 77 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(testClient().reconcileQueuedCheck(
      job(),
      77,
      { baseSha: "c".repeat(40), headSha: "d".repeat(40) },
    )).resolves.toEqual({
      checkRunId: 77,
      lookupAttempted: false,
      supersededByDifferentComparison: true,
      supersedeAttempted: true,
      superseded: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("finds an ambiguously-created old-head check by exact marker before closing it", async () => {
    const externalId = `gaston-review:1:${job().baseSha}:${job().headSha}:automatic`;
    const delays: number[] = [];
    let lookupCount = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(init?.signal).toBeUndefined();
      if (url.includes(`/commits/${job().headSha}/check-runs?`)) {
        lookupCount += 1;
        return new Response(JSON.stringify({ check_runs: lookupCount === 1 ? [] : [
          { id: 70, external_id: "another-run", name: "Gaston review", status: "queued" },
          { id: 77, external_id: externalId, name: "Gaston review", status: "queued" },
        ] }), { status: 200 });
      }
      expect(url).toContain("/check-runs/77");
      expect(init?.method).toBe("PATCH");
      return new Response(JSON.stringify({ id: 77 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await testClient(async (delayMs) => {
      delays.push(delayMs);
    }).reconcileQueuedCheck(job(), undefined, { baseSha: "c".repeat(40), headSha: "d".repeat(40) });

    expect(result).toEqual({
      checkRunId: 77,
      lookupAttempted: true,
      supersededByDifferentComparison: true,
      supersedeAttempted: true,
      superseded: true,
    });
    expect(delays).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("preserves a queued check for the same comparison across manual deliveries or unknown state", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    const client = testClient();

    const firstManual = { ...job(), trigger: "manual" as const, deliveryId: "manual-1" };
    await expect(client.reconcileQueuedCheck(firstManual, 77, {
      baseSha: firstManual.baseSha,
      headSha: firstManual.headSha,
    })).resolves.toEqual({
      checkRunId: 77,
      lookupAttempted: false,
      supersededByDifferentComparison: false,
      supersedeAttempted: false,
      superseded: false,
    });
    await expect(client.reconcileQueuedCheck(job(), undefined, undefined)).resolves.toEqual({
      lookupAttempted: false,
      supersededByDifferentComparison: false,
      supersedeAttempted: false,
      superseded: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a queued check when the successor keeps the head but changes the base", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("PATCH");
      return new Response(JSON.stringify({ id: 77 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(testClient().reconcileQueuedCheck(job(), 77, {
      baseSha: "c".repeat(40),
      headSha: job().headSha,
    })).resolves.toMatchObject({
      supersededByDifferentComparison: true,
      supersedeAttempted: true,
      superseded: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("cancels a duplicate stale check when the same comparison owns a different check id", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("/check-runs/77");
      expect(init?.method).toBe("PATCH");
      return new Response(JSON.stringify({ id: 77 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(testClient().reconcileQueuedCheck(job(), 77, {
      baseSha: job().baseSha,
      headSha: job().headSha,
    }, 88)).resolves.toMatchObject({
      checkRunId: 77,
      supersededByDifferentComparison: false,
      supersedeAttempted: true,
      superseded: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves the same check id adopted by a same-comparison successor", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(testClient().reconcileQueuedCheck(job(), 77, {
      baseSha: job().baseSha,
      headSha: job().headSha,
    }, 77)).resolves.toMatchObject({
      checkRunId: 77,
      supersededByDifferentComparison: false,
      supersedeAttempted: false,
      superseded: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a stale manual check when same-comparison check POSTs overlap before either id is persisted", async () => {
    let resolveFirstPost!: (response: Response) => void;
    let resolveSecondPost!: (response: Response) => void;
    let markFirstPostStarted!: () => void;
    let markSecondPostStarted!: () => void;
    const firstPostResponse = new Promise<Response>((resolve) => { resolveFirstPost = resolve; });
    const secondPostResponse = new Promise<Response>((resolve) => { resolveSecondPost = resolve; });
    const firstPostStarted = new Promise<void>((resolve) => { markFirstPostStarted = resolve; });
    const secondPostStarted = new Promise<void>((resolve) => { markSecondPostStarted = resolve; });
    const postBodies: Array<Record<string, unknown>> = [];
    const supersededIds: number[] = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/commits/") && url.includes("/check-runs?")) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      if (url.endsWith("/check-runs") && init?.method === "POST") {
        postBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (postBodies.length === 1) {
          markFirstPostStarted();
          return firstPostResponse;
        }
        markSecondPostStarted();
        return secondPostResponse;
      }
      const matchedCheck = url.match(/\/check-runs\/(\d+)$/);
      if (matchedCheck && init?.method === "PATCH") {
        supersededIds.push(Number(matchedCheck[1]));
        return new Response(JSON.stringify({ id: Number(matchedCheck[1]) }), { status: 200 });
      }
      throw new Error(`unexpected GitHub request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const client = testClient();
    const firstManual = { ...job(), trigger: "manual" as const, deliveryId: "manual-1" };
    const successor = { ...firstManual, deliveryId: "manual-2" };

    const firstEnsure = client.ensureQueuedCheckRun(firstManual);
    await firstPostStarted;
    const successorEnsure = client.ensureQueuedCheckRun(successor);
    await secondPostStarted;
    resolveFirstPost(new Response(JSON.stringify({ id: 77 }), { status: 201 }));
    await expect(firstEnsure).resolves.toBe(77);

    await expect(client.reconcileQueuedCheck(
      firstManual,
      77,
      { baseSha: successor.baseSha, headSha: successor.headSha },
      0,
      false,
    )).resolves.toMatchObject({
      checkRunId: 77,
      supersedeAttempted: true,
      superseded: true,
    });

    resolveSecondPost(new Response(JSON.stringify({ id: 88 }), { status: 201 }));
    await expect(successorEnsure).resolves.toBe(88);
    expect(postBodies.map((body) => body.external_id)).toEqual([
      `gaston-review:${job().pullNumber}:${job().baseSha}:${job().headSha}:manual:manual-1`,
      `gaston-review:${job().pullNumber}:${job().baseSha}:${job().headSha}:manual:manual-2`,
    ]);
    expect(supersededIds).toEqual([77]);
  });

  it("finds and cancels an ambiguously-created check from a stale same-comparison execution", async () => {
    const firstManual = { ...job(), trigger: "manual" as const, deliveryId: "manual-1" };
    const staleMarker = `gaston-review:${job().pullNumber}:${job().baseSha}:${job().headSha}:manual:manual-1`;
    const successorMarker = `gaston-review:${job().pullNumber}:${job().baseSha}:${job().headSha}:manual:manual-2`;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(init?.signal).toBeUndefined();
      if (url.includes("/commits/") && url.includes("/check-runs?")) {
        return new Response(JSON.stringify({ check_runs: [
          { id: 77, external_id: staleMarker, name: "Gaston review", status: "queued" },
          { id: 88, external_id: successorMarker, name: "Gaston review", status: "queued" },
        ] }), { status: 200 });
      }
      expect(url).toContain("/check-runs/77");
      expect(init?.method).toBe("PATCH");
      return new Response(JSON.stringify({ id: 77 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await expect(testClient().reconcileQueuedCheck(
      firstManual,
      undefined,
      { baseSha: firstManual.baseSha, headSha: firstManual.headSha },
      0,
      false,
    )).resolves.toMatchObject({
      checkRunId: 77,
      lookupAttempted: true,
      supersededByDifferentComparison: false,
      supersedeAttempted: true,
      superseded: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reuses and preserves one execution-scoped check across automatic redeliveries", async () => {
    const automaticMarker = `gaston-review:${job().pullNumber}:${job().baseSha}:${job().headSha}:automatic`;
    const postBodies: Array<Record<string, unknown>> = [];
    let created = false;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/commits/") && url.includes("/check-runs?")) {
        return new Response(JSON.stringify({
          check_runs: created
            ? [{ id: 77, external_id: automaticMarker, name: "Gaston review", status: "queued" }]
            : [],
        }), { status: 200 });
      }
      if (url.endsWith("/check-runs") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        postBodies.push(body);
        created = true;
        return new Response(JSON.stringify({ id: 77, ...body }), { status: 201 });
      }
      throw new Error(`unexpected GitHub request: ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    const client = testClient();
    const redelivery = { ...job(), deliveryId: "delivery-2" };

    await expect(client.ensureQueuedCheckRun(job())).resolves.toBe(77);
    await expect(client.ensureQueuedCheckRun(redelivery)).resolves.toBe(77);
    await expect(client.reconcileQueuedCheck(
      job(),
      77,
      { baseSha: redelivery.baseSha, headSha: redelivery.headSha },
      0,
      true,
    )).resolves.toMatchObject({
      checkRunId: 77,
      supersedeAttempted: false,
      superseded: false,
    });
    expect(postBodies).toHaveLength(1);
    expect(postBodies[0]).toMatchObject({ external_id: automaticMarker });
  });

  it("ignores an exact review marker forged by a user or a different GitHub App", async () => {
    const marker = `<!-- gaston-review:1:${job().baseSha}:${job().headSha} -->`;
    const fetch = vi.fn(async () => new Response(JSON.stringify([
      {
        id: 70,
        body: marker,
        commit_id: job().headSha,
        user: { login: "gaston[bot]", type: "User" },
      },
      {
        id: 71,
        body: marker,
        commit_id: job().headSha,
        user: { login: "other-app[bot]", type: "Bot" },
      },
      { id: 72, body: marker, commit_id: job().headSha },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(testClient().hasPublishedReview(job())).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("skips forged review markers and finds the authenticated App's review", async () => {
    const marker = `<!-- gaston-review:1:${job().baseSha}:${job().headSha} -->`;
    const fetch = vi.fn(async () => new Response(JSON.stringify([
      {
        id: 70,
        body: marker,
        commit_id: job().headSha,
        user: { login: "attacker", type: "User" },
      },
      { id: 77, body: marker, commit_id: job().headSha, user: appBot() },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await expect(testClient().findPublishedReview(job())).resolves.toMatchObject({ id: 77 });
  });

  it("reconciles an ambiguous publication by exact marker without reusing the aborted signal", async () => {
    const aborted = new AbortController();
    aborted.abort(new DOMException("superseded", "AbortError"));
    const marker = `<!-- gaston-review:1:${job().baseSha}:${job().headSha} -->`;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(init?.signal).toBeUndefined();
      if (url.includes("/pulls/1/reviews?")) {
        return new Response(JSON.stringify([
          { id: 70, body: marker, commit_id: "c".repeat(40) },
          { id: 71, body: "<!-- another-review -->", commit_id: job().headSha },
          { id: 77, body: `${marker}\nreview body`, commit_id: job().headSha, user: appBot() },
        ]), { status: 200 });
      }
      expect(url).toContain("/pulls/1/reviews/77/dismissals");
      expect(init?.method).toBe("PUT");
      return new Response(JSON.stringify({ id: 77, body: marker, commit_id: job().headSha }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await testClient().reconcilePublishedReview(
      job(),
      undefined,
      { baseSha: "c".repeat(40), headSha: "d".repeat(40) },
    );

    expect(result).toEqual({
      reviewId: 77,
      lookupAttempted: true,
      supersededByDifferentComparison: true,
      dismissalAttempted: true,
      dismissed: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries an initially invisible exact-marker review before dismissing it", async () => {
    const marker = `<!-- gaston-review:1:${job().baseSha}:${job().headSha} -->`;
    const delays: number[] = [];
    let lookupCount = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(init?.signal).toBeUndefined();
      if (url.includes("/pulls/1/reviews?")) {
        lookupCount += 1;
        return new Response(JSON.stringify(lookupCount === 1 ? [] : [
          { id: 77, body: `${marker}\nreview body`, commit_id: job().headSha, user: appBot() },
        ]), { status: 200 });
      }
      expect(url).toContain("/pulls/1/reviews/77/dismissals");
      expect(init?.method).toBe("PUT");
      return new Response(JSON.stringify({ id: 77, body: marker, commit_id: job().headSha }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await testClient(async (delayMs) => {
      delays.push(delayMs);
    }).reconcilePublishedReview(job(), undefined, { baseSha: "c".repeat(40), headSha: "d".repeat(40) });

    expect(result).toEqual({
      reviewId: 77,
      lookupAttempted: true,
      supersededByDifferentComparison: true,
      dismissalAttempted: true,
      dismissed: true,
    });
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("bounds reconciliation retries when the exact-marker review stays invisible", async () => {
    const delays: number[] = [];
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeUndefined();
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await testClient(async (delayMs) => {
      delays.push(delayMs);
    }).reconcilePublishedReview(job(), undefined, { baseSha: "c".repeat(40), headSha: "d".repeat(40) });

    expect(result).toEqual({
      lookupAttempted: true,
      supersededByDifferentComparison: true,
      dismissalAttempted: false,
      dismissed: false,
    });
    expect(delays).toHaveLength(3);
    expect(delays.every((delayMs) => delayMs > 0)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("never dismisses an ambiguous publication for the same comparison across manual deliveries or unknown state", async () => {
    const marker = `<!-- gaston-review:1:${job().baseSha}:${job().headSha} -->`;
    const fetch = vi.fn(async () => new Response(JSON.stringify([
      { id: 77, body: marker, commit_id: job().headSha, user: appBot() },
    ]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = testClient();

    const firstManual = { ...job(), trigger: "manual" as const, deliveryId: "manual-1" };
    await expect(client.reconcilePublishedReview(firstManual, undefined, {
      baseSha: firstManual.baseSha,
      headSha: firstManual.headSha,
    })).resolves.toEqual({
      reviewId: 77,
      lookupAttempted: true,
      supersededByDifferentComparison: false,
      dismissalAttempted: false,
      dismissed: false,
    });
    await expect(client.reconcilePublishedReview(job(), undefined, undefined)).resolves.toEqual({
      reviewId: 77,
      lookupAttempted: true,
      supersededByDifferentComparison: false,
      dismissalAttempted: false,
      dismissed: false,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reconciles a stale review when the successor keeps the head but changes the base", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain("/pulls/1/reviews/77/dismissals");
      expect(init?.method).toBe("PUT");
      return new Response(JSON.stringify({ id: 77 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const current = job();
    await expect(testClient().reconcilePublishedReview(
      current,
      { id: 77 },
      { baseSha: "c".repeat(40), headSha: current.headSha },
    )).resolves.toMatchObject({
      reviewId: 77,
      supersededByDifferentComparison: true,
      dismissalAttempted: true,
      dismissed: true,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("updates the existing persistent summary instead of creating another", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/issues/1/comments?")) {
        return new Response(JSON.stringify([
          appIssueComment(9, "<!-- gaston-summary:1 -->\nold"),
        ]), { status: 200 });
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

  it("preserves an existing finding summary on an explicitly non-clean rerun", async () => {
    const existingBody = "<!-- gaston-summary:1 -->\nPrior confirmed finding";
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain("/issues/1/comments?");
      return new Response(JSON.stringify([appIssueComment(9, existingBody)]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    await testClient().upsertReviewSummary(
      job(),
      { summary: "This rerun is not clean.", findings: [] },
      undefined,
      { preserveExistingOnClean: true },
    );

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("creates its own summary instead of patching a forged marker comment", async () => {
    const requests: Array<{ url: string; method: string }> = [];
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      if (url.includes("/issues/1/comments?")) {
        return new Response(JSON.stringify([
          {
            id: 7,
            body: "<!-- gaston-summary:1 -->\nforged by user",
            user: { login: "attacker", type: "User" },
          },
          {
            id: 8,
            body: "<!-- gaston-summary:1 -->\nforged by another App",
            user: appBot(),
            performed_via_github_app: { id: 98_765 },
          },
        ]), { status: 200 });
      }
      expect(url).toBe("https://api.github.com/repos/owner/repo/issues/1/comments");
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify(appIssueComment(9, String(init?.body))), { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);

    await testClient().upsertReviewSummary(job(), {
      summary: "one confirmed finding",
      findings: [{
        path: "src/index.ts",
        line: 4,
        side: "RIGHT",
        severity: "high",
        title: "Bug",
        why: "It fails.",
        evidence: "The changed line throws.",
        suggestedFix: "Handle the error.",
        confidence: 0.95,
      }],
    });

    expect(requests).toEqual([
      { url: expect.stringContaining("/issues/1/comments?"), method: "GET" },
      { url: "https://api.github.com/repos/owner/repo/issues/1/comments", method: "POST" },
    ]);
  });

  it("forwards one cancellation signal through review, summary, and terminal check writes", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/issues/1/comments?")) {
        return new Response(JSON.stringify([
          appIssueComment(9, "<!-- gaston-summary:1 -->\nold"),
        ]), { status: 200 });
      }
      if (url.endsWith("/reviews")) {
        return new Response(JSON.stringify({ id: 77, body: "review", commit_id: job().headSha }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 9 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    const client = testClient();
    const review = {
      summary: "one finding",
      findings: [{
        path: "src/index.ts",
        line: 4,
        side: "RIGHT" as const,
        severity: "high" as const,
        title: "Bug",
        why: "It fails.",
        evidence: "The changed line throws.",
        suggestedFix: "Handle the error.",
        confidence: 0.95,
      }],
    };
    const budget = {
      elapsedMs: 1,
      modelRequests: 1,
      estimatedInputTokens: 1,
      reportedInputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.001,
      remainingModelRequests: 1,
      remainingWallTimeMs: 1,
    };

    await client.publishReview(job(), review, undefined, controller.signal);
    await client.upsertReviewSummary(job(), review, controller.signal);
    await client.completeCheck(job(), 10, review, undefined, undefined, controller.signal);
    await client.failCheck(job(), 10, new Error("failed"), controller.signal);
    await client.stopCheckForBudget(job(), 10, "limit", budget, controller.signal);
    await client.supersedeCheck(job(), 10, controller.signal);
    await client.dismissReview(job(), 77, "Superseded", controller.signal);

    expect(fetch).toHaveBeenCalledTimes(8);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.signal).toBe(controller.signal);
    }
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
            external_id: `gaston-review:${job().pullNumber}:${job().baseSha}:${job().headSha}:automatic`,
            name: "Gaston review",
            status: "completed",
          }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: 10,
        external_id: `gaston-review:${job().pullNumber}:${job().baseSha}:${job().headSha}:automatic`,
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
      details_url: "https://gaston.example/?repo=owner%2Frepo&pr=1",
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
      details_url: "https://gaston.example/?repo=owner%2Frepo&pr=1",
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

function testClient(reconciliationDelay?: (delayMs: number) => Promise<void>): GitHubClient {
  return Reflect.construct(
    GitHubClient as unknown as Function,
    [
      "token",
      { id: 12_345, botLogin: "gaston[bot]" },
      ...(reconciliationDelay === undefined ? [] : [reconciliationDelay]),
    ],
  ) as GitHubClient;
}

function appBot(): { login: string; type: "Bot" } {
  return { login: "gaston[bot]", type: "Bot" };
}

function appIssueComment(id: number, body: string): Record<string, unknown> {
  return {
    id,
    body,
    user: appBot(),
    performed_via_github_app: { id: 12_345 },
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
    dashboardUrl: "https://gaston.example",
    queuedAt: "2026-08-10T00:00:00.000Z",
    trigger: "automatic",
  };
}
