import { describe, expect, it, vi } from "vitest";

import { RepositoryTools, RepositoryWorkspace } from "../src/repository.ts";
import { GitHubApiError } from "../src/github.ts";
import type { ReviewJob } from "../src/types.ts";

describe("RepositoryWorkspace policy", () => {
  it("loads supported guidance only from the base commit", async () => {
    const workspace = {
      fs: {
        stat: vi.fn(async () => { throw new Error("not cached"); }),
        mkdir: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => undefined),
        readFile: vi.fn(async () => ""),
      },
    };
    const github = {
      getRepositoryTree: vi.fn(async () => ({
        entries: [{ path: "src/payments/AGENTS.md", type: "blob", size: 30 }],
        truncated: false,
      })),
      readFile: vi.fn(async (_job: ReviewJob, path: string, ref: string) => {
        expect(ref).toBe("a".repeat(40));
        if (path === ".gaston/review.md") return "Protect billing invariants.";
        if (path === "AGENTS.md") return "Use repository-specific evidence.";
        if (path === "src/payments/AGENTS.md") return "Treat cents as integers.";
        throw new Error("missing");
      }),
    };
    const repository = new RepositoryWorkspace(
      workspace as never,
      github as never,
      job(),
      {
        files: [{ path: "src/payments/charge.ts", status: "modified", additions: 1, deletions: 1, patch: "" }],
        diff: "",
        truncated: false,
      },
    );

    await expect(repository.reviewPolicy()).resolves.toBe([
      "### .gaston/review.md",
      "Protect billing invariants.",
      "",
      "### AGENTS.md",
      "Use repository-specific evidence.",
      "",
      "### src/payments/AGENTS.md (applies under src/payments/)",
      "Treat cents as integers.",
    ].join("\n"));
  });
});

describe("RepositoryTools", () => {
  it("memoizes duplicate reads without limiting productive calls", async () => {
    const read = vi.fn(async (path: string) => `contents of ${path}`);
    const tools = new RepositoryTools({ read } as unknown as RepositoryWorkspace);
    const args = '{"path":"src/a.ts","ref":"head","start_line":1,"end_line":20}';

    const duplicates = await Promise.all([
      tools.invoke("read_file", args),
      tools.invoke("read_file", `  ${args}  `),
    ]);
    expect(duplicates[0]).toEqual(duplicates[1]);
    expect(read).toHaveBeenCalledTimes(1);

    const productive = await Promise.all(Array.from({ length: 50 }, (_, index) => (
      tools.invoke(
        "read_file",
        JSON.stringify({ path: `src/${index}.ts`, ref: "head", start_line: 1, end_line: 20 }),
      )
    )));
    expect(productive.every((result) => !result.isError)).toBe(true);
    expect(read).toHaveBeenCalledTimes(51);
  });

  it("passes cancellation into repository reads and marks bounded head-tail previews", async () => {
    const source = `start:${"x".repeat(20_000)}:end`;
    const read = vi.fn(async (
      _path: string,
      _ref: string,
      _start: number,
      _end: number,
      signal?: AbortSignal,
    ) => {
      expect(signal).toBe(controller.signal);
      return source;
    });
    const controller = new AbortController();
    const tools = new RepositoryTools({ read } as unknown as RepositoryWorkspace);

    const result = await tools.invoke(
      "read_file",
      '{"path":"src/a.ts","ref":"head","start_line":1,"end_line":400}',
      controller.signal,
    );

    expect(result.content).toContain("start:");
    expect(result.content).toContain(":end");
    expect(result.content).toContain("Gaston truncated this tool result");
    expect(result.status).toBe("truncated");
    expect(tools.coverage()).toMatchObject({ sufficient: false, truncatedResults: 1 });
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(12_000);
  });

  it("rejects immediately when a review signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("superseded"));
    const tools = new RepositoryTools({ read: vi.fn() } as unknown as RepositoryWorkspace);

    await expect(tools.invoke("read_file", '{"path":"src/a.ts"}', controller.signal))
      .rejects.toThrow("superseded");
  });

  it("propagates transient GitHub failures to the queue instead of presenting them as evidence", async () => {
    const tools = new RepositoryTools({
      changes: { files: [], diff: "", truncated: false },
      search: vi.fn(async () => {
        throw new GitHubApiError("GET", "/search/code", 503, "overloaded");
      }),
    } as unknown as RepositoryWorkspace);

    await expect(tools.invoke("search_code", '{"query":"symbol"}'))
      .rejects.toThrow("GitHub API GET /search/code failed (503)");
  });

  it("marks invalid tool arguments as a recoverable evidence hazard", async () => {
    const tools = new RepositoryTools({
      changes: { files: [], diff: "", truncated: false },
      read: vi.fn(),
    } as unknown as RepositoryWorkspace);

    const result = await tools.invoke("read_file", '{"path":"src/a.ts"');

    expect(result).toMatchObject({
      status: "invalid_arguments",
      retryable: false,
      errorCode: "invalid_tool_arguments",
      isError: true,
    });
    expect(tools.coverage()).toMatchObject({ sufficient: false, invalidArguments: 1 });
  });
});

describe("RepositoryWorkspace cache", () => {
  it("clears per-run context while preserving immutable SHA caches", async () => {
    const removed: string[] = [];
    const written: string[] = [];
    const workspace = {
      fs: {
        rm: vi.fn(async (path: string) => { removed.push(path); }),
        mkdir: vi.fn(async () => undefined),
        readdir: vi.fn(async () => []),
        writeFile: vi.fn(async (path: string) => { written.push(path); }),
      },
    };
    const repository = new RepositoryWorkspace(
      workspace as never,
      {} as never,
      job(),
      { files: [], diff: "", truncated: false },
    );

    await repository.initialize([]);

    expect(removed).toEqual(["/gaston/run"]);
    expect(removed).not.toContain("/gaston");
    expect(written).toEqual(expect.arrayContaining([
      "/gaston/run/context/pr.json",
      "/gaston/run/context/diff.patch",
    ]));
  });
});

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
