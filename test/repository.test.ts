import { describe, expect, it, vi } from "vitest";

import {
  renderChangedFiles,
  renderDiffForFile,
  renderSearchResults,
  RepositoryTools,
  RepositoryWorkspace,
} from "../src/repository.ts";
import { GitHubApiError } from "../src/github.ts";
import { EvidenceCoverageTracker, mergeEvidenceCoverage } from "../src/evidence.ts";
import type { EvidenceCoverage } from "../src/evidence.ts";
import type { PullChangeSet, ReviewJob } from "../src/types.ts";

describe("shared repository renderers", () => {
  it("keeps production workspace output identical, valid, and within the transport budget", () => {
    const changes: PullChangeSet = {
      files: Array.from({ length: 110 }, (_, index) => ({
        path: `src/${"nested/".repeat(20)}${index}.ts`,
        status: "modified",
        additions: 80,
        deletions: 0,
        patch: Array.from(
          { length: 80 },
          (__, line) => `+line-${line + 1}:${"界".repeat(300)}`,
        ).join("\n"),
      })),
      diff: "",
      truncated: true,
      filesTruncated: false,
      diffTruncated: true,
    };
    const repository = new RepositoryWorkspace({} as never, {} as never, job(), changes);
    const targetPath = changes.files[0]!.path;

    const inventory = renderChangedFiles(changes, 0, 100);
    const patch = renderDiffForFile(changes, targetPath);

    expect(repository.changedFiles(0, 100)).toBe(inventory);
    expect(repository.diffForFile(targetPath)).toBe(patch);
    expect(() => JSON.parse(inventory)).not.toThrow();
    expect(() => JSON.parse(patch)).not.toThrow();
    expect(new TextEncoder().encode(inventory).byteLength).toBeLessThanOrEqual(12_000);
    expect(new TextEncoder().encode(patch).byteLength).toBeLessThanOrEqual(12_000);
  });

  it("keeps long code-search results parseable while preserving every path and line", () => {
    const matches = Array.from({ length: 20 }, (_, index) => ({
      path: `src/search/${index}.ts`,
      line: index + 10,
      fragment: `needle ${"界".repeat(2_000)}`,
    }));
    const rendered = renderSearchResults(matches, false);
    const parsed = JSON.parse(rendered) as {
      matches: Array<{ path: string; line: number; fragment?: string }>;
      truncated: boolean;
      fragmentsClipped?: boolean;
    };

    expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(12_000);
    expect(parsed).toMatchObject({ truncated: false, fragmentsClipped: true });
    expect(parsed.matches.map(({ path, line }) => ({ path, line }))).toEqual(
      matches.map(({ path, line }) => ({ path, line })),
    );
  });
});

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
  it("marks the actual annotated prompt diff truncated when coordinate prefixes cross the byte cap", () => {
    const diff = `@@ -0,0 +1,3500 @@\n${Array.from({ length: 3_500 }, () => "+x").join("\n")}`;
    expect(new TextEncoder().encode(diff).byteLength).toBeLessThan(40_000);
    const tools = new RepositoryTools({
      changes: {
        files: [{ path: "src/a.ts", status: "added", additions: 3_500, deletions: 0, patch: diff }],
        diff,
        truncated: false,
        diffTruncated: false,
      },
    } as unknown as RepositoryWorkspace);

    expect(tools.coverage()).toMatchObject({
      initialDiffTruncated: true,
      sufficient: false,
      limitations: [expect.stringContaining("initial cumulative diff was truncated")],
    });
  });

  it("does not mark an exact-sized code-search page as truncated without a larger total", async () => {
    const repository = new RepositoryWorkspace(
      {} as never,
      {
        searchCode: vi.fn(async () => ({
          matches: Array.from({ length: 10 }, (_, index) => ({ path: `src/${index}.ts`, fragment: "needle" })),
          truncated: false,
        })),
      } as never,
      job(),
      { files: [], diff: "", truncated: false },
    );
    const tools = new RepositoryTools(repository);

    const result = await tools.invoke("search_code", '{"query":"needle","limit":10}');

    expect(result.status).toBe("ok");
    expect(JSON.parse(result.content)).toMatchObject({ truncated: false });
    expect(tools.coverage().sufficient).toBe(true);
  });

  it("pages through the cumulative changed-file inventory", async () => {
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: Array.from({ length: 240 }, (_, index) => ({
          path: `src/${index}.ts`,
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-old\n+new",
        })),
        diff: "",
        truncated: false,
      },
    );
    const tools = new RepositoryTools(repository);

    const page = await tools.invoke("changed_files", '{"offset":100,"limit":50}');

    expect(page.status).toBe("ok");
    const parsed = JSON.parse(page.content) as {
      files: Array<{ path: string }>;
      offset: number;
      returned: number;
      total: number;
      hasMore: boolean;
      nextOffset: number;
    };
    expect(parsed).toMatchObject({
      offset: 100,
      returned: 50,
      total: 240,
      hasMore: true,
      nextOffset: 150,
    });
    expect(parsed.files).toHaveLength(50);
    expect(parsed.files[0]?.path).toBe("src/100.ts");
  });

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

  it("returns exact patch slices with actionable continuation metadata", async () => {
    const patch = Array.from({ length: 450 }, (_, index) => `+changed line ${index + 1}`).join("\n");
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{ path: "src/large.ts", status: "modified", additions: 450, deletions: 0, patch }],
        diff: "",
        truncated: false,
      },
    );
    const tools = new RepositoryTools(repository);

    const first = await tools.invoke("diff_for_file", '{"path":"src/large.ts"}');
    expect(first).toMatchObject({
      status: "truncated",
      suggestedAction: expect.stringContaining("patch_start_line 201"),
    });
    expect(first.suggestedAction).toEqual(expect.stringContaining("patch_end_line 450"));
    expect(JSON.parse(first.content)).toMatchObject({
      patchStartLine: 1,
      patchEndLine: 200,
      totalPatchLines: 450,
      nextPatchStartLine: 201,
      nextPatchEndLine: 450,
    });

    const recovered = await tools.invoke(
      "diff_for_file",
      '{"path":"src/large.ts","patch_start_line":201,"patch_end_line":260}',
    );
    expect(recovered.status).toBe("truncated");
    expect(JSON.parse(recovered.content)).toMatchObject({
      patchStartLine: 201,
      patchEndLine: 260,
      hasMoreBefore: true,
      hasMoreAfter: true,
    });
    expect(recovered.content).toContain("+changed line 201");
    expect(tools.coverage()).toMatchObject({
      sufficient: false,
      inspectedChangedFiles: 0,
      truncatedResults: 2,
    });
  });

  it("byte-bounds default patch slices as valid JSON with an exact contiguous prefix", async () => {
    const patch = Array.from(
      { length: 80 },
      (_, index) => `+line-${index + 1}:${"x".repeat(700)}`,
    ).join("\n");
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{ path: "src/generated.ts", status: "modified", additions: 80, deletions: 0, patch }],
        diff: "",
        truncated: true,
        diffTruncated: true,
      },
    );
    const tools = new RepositoryTools(repository);

    const first = await tools.invoke("diff_for_file", '{"path":"src/generated.ts"}');
    const parsed = JSON.parse(first.content) as {
      patch: string;
      patchStartLine: number;
      patchEndLine: number;
      nextPatchStartLine: number;
      nextPatchEndLine: number;
    };

    expect(first.status).toBe("truncated");
    expect(new TextEncoder().encode(first.content).byteLength).toBeLessThanOrEqual(12_000);
    expect(parsed.patchStartLine).toBe(1);
    expect(parsed.patchEndLine).toBeGreaterThan(1);
    expect(parsed.patchEndLine).toBeLessThan(80);
    expect(parsed.patch.split("\n")).toHaveLength(parsed.patchEndLine);
    expect(parsed.patch).toContain("+line-1:");
    expect(parsed.patch).toContain(`+line-${parsed.patchEndLine}:`);
    expect(parsed.patch).not.toContain(`+line-${parsed.patchEndLine + 1}:`);
    expect(parsed.nextPatchStartLine).toBe(parsed.patchEndLine + 1);
    expect(parsed.nextPatchEndLine).toBe(80);
    expect(first.evidence).toMatchObject({
      patchStartLine: 1,
      patchEndLine: parsed.patchEndLine,
      totalPatchLines: 80,
      patchIntervalComplete: true,
    });

    let nextStart = parsed.nextPatchStartLine;
    while (nextStart <= 80) {
      const result = await tools.invoke(
        "diff_for_file",
        JSON.stringify({ path: "src/generated.ts", patch_start_line: nextStart, patch_end_line: 80 }),
      );
      const content = JSON.parse(result.content) as {
        patchStartLine: number;
        patchEndLine: number;
        nextPatchStartLine?: number;
      };
      expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(12_000);
      expect(content.patchStartLine).toBe(nextStart);
      expect(content.patchEndLine).toBeGreaterThanOrEqual(nextStart);
      expect(result.evidence?.patchIntervalComplete).toBe(true);
      nextStart = content.nextPatchStartLine ?? 81;
    }

    expect(tools.coverage()).toMatchObject({
      sufficient: true,
      inspectedChangedFiles: 1,
      inspectedChangedPaths: ["src/generated.ts"],
      limitations: [],
      unresolvedEvidence: [],
      changedPatchCoverage: [{
        path: "src/generated.ts",
        totalPatchLines: 80,
        intervals: [{ start: 1, end: 81 }],
      }],
    });
  });

  it("byte-bounds explicit patch slices without granting credit for unreturned lines", async () => {
    const patch = Array.from(
      { length: 60 },
      (_, index) => `+line-${index + 1}:${"界".repeat(300)}`,
    ).join("\n");
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{ path: "src/utf8.ts", status: "modified", additions: 60, deletions: 0, patch }],
        diff: "",
        truncated: true,
        diffTruncated: true,
      },
    );
    const tools = new RepositoryTools(repository);

    const result = await tools.invoke(
      "diff_for_file",
      '{"path":"src/utf8.ts","patch_start_line":11,"patch_end_line":50}',
    );
    const content = JSON.parse(result.content) as {
      patch: string;
      patchStartLine: number;
      patchEndLine: number;
      nextPatchStartLine: number;
    };

    expect(result.status).toBe("truncated");
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(12_000);
    expect(content.patchStartLine).toBe(11);
    expect(content.patchEndLine).toBeGreaterThanOrEqual(11);
    expect(content.patchEndLine).toBeLessThan(50);
    expect(content.patch.split("\n")).toHaveLength(content.patchEndLine - 10);
    expect(content.nextPatchStartLine).toBe(content.patchEndLine + 1);
    expect(result.content).not.toContain("Gaston truncated this tool result");
    expect(result.evidence).toMatchObject({
      patchStartLine: 11,
      patchEndLine: content.patchEndLine,
      patchIntervalComplete: true,
    });
    expect(tools.coverage()).toMatchObject({
      inspectedChangedFiles: 0,
      changedPatchCoverage: [{
        path: "src/utf8.ts",
        totalPatchLines: 60,
        intervals: [{ start: 11, end: content.patchEndLine + 1 }],
      }],
    });
  });

  it("keeps an oversized ordinary patch line parseable and explicitly incomplete", async () => {
    const patch = ["@@ -1 +1 @@", `+TOKEN_START${"x".repeat(20_000)}TOKEN_END`].join("\n");
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{ path: "src/generated.ts", status: "modified", additions: 1, deletions: 1, patch }],
        diff: "",
        truncated: true,
        diffTruncated: true,
      },
    );
    const tools = new RepositoryTools(repository);

    const result = await tools.invoke(
      "diff_for_file",
      '{"path":"src/generated.ts","patch_start_line":2,"patch_end_line":2}',
    );
    const content = JSON.parse(result.content) as {
      patch: string;
      patchStartLine: number;
      patchEndLine: number;
      patchContentTruncated: boolean;
    };

    expect(result.status).toBe("truncated");
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(12_000);
    expect(content).toMatchObject({
      patchStartLine: 2,
      patchEndLine: 2,
      patchContentTruncated: true,
    });
    expect(content.patch).toContain("TOKEN_START");
    expect(content.patch).toContain("TOKEN_END");
    expect(result.content).not.toContain("Gaston truncated this tool result");
    expect(result.evidence).toMatchObject({
      patchStartLine: 2,
      patchEndLine: 2,
      patchIntervalComplete: false,
      complete: false,
    });
    expect(tools.coverage()).toMatchObject({
      inspectedChangedFiles: 0,
      changedPatchCoverage: [],
    });
  });

  it("recovers a 633-line patch in the default slice plus two inclusive continuation ranges", async () => {
    const patch = Array.from({ length: 633 }, (_, index) => `+line ${index + 1}`).join("\n");
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{ path: "src/large.ts", status: "modified", additions: 633, deletions: 0, patch }],
        diff: "",
        truncated: true,
        diffTruncated: true,
      },
    );
    const tools = new RepositoryTools(repository);

    const first = await tools.invoke("diff_for_file", '{"path":"src/large.ts"}');
    expect(first.suggestedAction).toContain("patch_start_line 201 and patch_end_line 600");
    expect(JSON.parse(first.content)).toMatchObject({
      patchStartLine: 1,
      patchEndLine: 200,
      nextPatchStartLine: 201,
      nextPatchEndLine: 600,
    });

    const second = await tools.invoke(
      "diff_for_file",
      '{"path":"src/large.ts","patch_start_line":201,"patch_end_line":600}',
    );
    expect(second.suggestedAction).toContain("patch_start_line 601 and patch_end_line 633");
    expect(JSON.parse(second.content)).toMatchObject({
      patchStartLine: 201,
      patchEndLine: 600,
      nextPatchStartLine: 601,
      nextPatchEndLine: 633,
    });
    expect(tools.coverage()).toMatchObject({
      inspectedChangedFiles: 0,
      unresolvedEvidence: [{
        scope: "diff_for_file:src/large.ts:201-600",
        changedPatchRange: { start: 601, end: 634 },
      }],
    });

    await tools.invoke(
      "diff_for_file",
      '{"path":"src/large.ts","patch_start_line":601,"patch_end_line":633}',
    );

    expect(tools.coverage()).toMatchObject({
      sufficient: true,
      inspectedChangedFiles: 1,
      inspectedChangedPaths: ["src/large.ts"],
      limitations: [],
      unresolvedEvidence: [],
      changedPatchCoverage: [{
        path: "src/large.ts",
        totalPatchLines: 633,
        intervals: [{ start: 1, end: 634 }],
      }],
    });
  });

  it("marks a changed file inspected only after exact patch intervals cover the whole patch", async () => {
    const patch = Array.from({ length: 450 }, (_, index) => `+line ${index + 1}`).join("\n");
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{ path: "src/large.ts", status: "modified", additions: 450, deletions: 0, patch }],
        diff: "",
        truncated: true,
        diffTruncated: true,
      },
    );
    const tools = new RepositoryTools(repository);

    await tools.invoke(
      "diff_for_file",
      '{"path":"src/large.ts","patch_start_line":1,"patch_end_line":200}',
    );
    await tools.invoke(
      "diff_for_file",
      '{"path":"src/large.ts","patch_start_line":201,"patch_end_line":400}',
    );
    expect(tools.coverage()).toMatchObject({
      sufficient: false,
      inspectedChangedFiles: 0,
      inspectedChangedPaths: [],
    });

    await tools.invoke(
      "diff_for_file",
      '{"path":"src/large.ts","patch_start_line":401,"patch_end_line":450}',
    );

    expect(tools.coverage()).toMatchObject({
      sufficient: true,
      inspectedChangedFiles: 1,
      inspectedChangedPaths: ["src/large.ts"],
      limitations: [],
      changedPatchCoverage: [{
        path: "src/large.ts",
        totalPatchLines: 450,
        intervals: [{ start: 1, end: 451 }],
      }],
    });
  });

  it("locates a large patch by source line instead of confusing it with a patch offset", async () => {
    const patch = [
      "@@ -10,2 +10,2 @@",
      "-old ten",
      "+new ten",
      " context eleven",
      "@@ -670,2 +670,3 @@",
      " context 670",
      "-old 671",
      "+new 671",
      "+target 672",
      " context 673",
      ...Array.from({ length: 300 }, (_, index) => `+tail ${674 + index}`),
    ].join("\n");
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{ path: "src/large.ts", status: "modified", additions: 302, deletions: 2, patch }],
        diff: "",
        truncated: false,
      },
    );
    const tools = new RepositoryTools(repository);

    const result = await tools.invoke(
      "diff_for_source_line",
      '{"path":"src/large.ts","source_line":672,"side":"RIGHT"}',
    );
    const content = JSON.parse(result.content);

    expect(content).toMatchObject({
      requestedSourceLine: 672,
      requestedSourceSide: "RIGHT",
      sourcePatchLine: 9,
    });
    expect(content.patch).toContain("+target 672");
    expect(content.patchStartLine).toBe(1);
    expect(content.patchEndLine).toBe(108);
    expect(result.status).toBe("ok");
    expect(tools.coverage()).toMatchObject({
      inspectedChangedFiles: 0,
      inspectedChangedPaths: [],
    });
  });

  it("does not reinterpret an out-of-range patch offset as a source line", async () => {
    const patch = [
      "@@ -350,106 +350,106 @@",
      ...Array.from({ length: 106 }, (_, index) => ` context source ${350 + index}`),
    ].join("\n");
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{ path: "src/agent-turn.ts", status: "modified", additions: 0, deletions: 0, patch }],
        diff: "",
        truncated: true,
        diffTruncated: true,
      },
    );
    const tools = new RepositoryTools(repository);

    const result = await tools.invoke(
      "diff_for_file",
      '{"path":"src/agent-turn.ts","patch_start_line":380,"patch_end_line":430}',
    );
    expect(result).toMatchObject({
      status: "invalid_arguments",
      errorCode: "invalid_tool_arguments",
      evidence: {
        scope: "diff_for_file:src/agent-turn.ts:380-430",
        sourceTargeted: false,
      },
    });
    expect(result.content).toContain("call diff_for_source_line");
  });

  it("returns actionable invalid evidence for an out-of-range patch offset that is not a source line", async () => {
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{
          path: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -7 +7 @@\n-old\n+new",
        }],
        diff: "",
        truncated: false,
      },
    );

    const result = await new RepositoryTools(repository).invoke(
      "diff_for_file",
      '{"path":"src/a.ts","patch_start_line":380,"patch_end_line":430}',
    );

    expect(result).toMatchObject({
      status: "invalid_arguments",
      errorCode: "invalid_tool_arguments",
      suggestedAction: expect.stringContaining("Correct the arguments"),
      evidence: {
        scope: "diff_for_file:src/a.ts:380-430",
        complete: false,
        changedPath: "src/a.ts",
        sourceTargeted: false,
      },
    });
    expect(result.content).toContain("exceeds this file's 3 patch lines");
    expect(result.content).toContain("use patch_start_line 1-3, or call diff_for_source_line with source_line and side");
  });

  it("keeps a source-targeted line in valid bounded JSON when its patch window exceeds 12 KB", async () => {
    const target = " target source line with the regression";
    const patch = [
      "@@ -1,300 +1,300 @@",
      ...Array.from({ length: 300 }, (_, index) => (
        index === 149 ? target : ` context ${index + 1} ${"x".repeat(180)}`
      )),
    ].join("\n");
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{ path: "src/generated.ts", status: "modified", additions: 0, deletions: 0, patch }],
        diff: "",
        truncated: false,
      },
    );

    const result = await new RepositoryTools(repository).invoke(
      "diff_for_source_line",
      '{"path":"src/generated.ts","source_line":150,"side":"RIGHT"}',
    );
    const content = JSON.parse(result.content) as {
      patch: string;
      patchStartLine: number;
      patchEndLine: number;
      sourcePatchLine: number;
    };

    expect(result.status).toBe("ok");
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(12_000);
    expect(content.patch).toContain(target);
    expect(content.patchStartLine).toBeLessThanOrEqual(content.sourcePatchLine);
    expect(content.patchEndLine).toBeGreaterThanOrEqual(content.sourcePatchLine);
    expect(content.patchEndLine - content.sourcePatchLine).toBeLessThanOrEqual(1 + content.sourcePatchLine - content.patchStartLine);
    expect(result.evidence).toMatchObject({
      complete: true,
      sourceTargeted: true,
      patchIntervalComplete: true,
    });
  });

  it("keeps oversized target-line JSON parseable and marks clipped source evidence incomplete", async () => {
    const patch = `@@ -1 +1 @@\n+TOKEN_START${"x".repeat(20_000)}TOKEN_END`;
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{ path: "src/generated.ts", status: "modified", additions: 1, deletions: 1, patch }],
        diff: "",
        truncated: false,
      },
    );

    const result = await new RepositoryTools(repository).invoke(
      "diff_for_source_line",
      '{"path":"src/generated.ts","source_line":1,"side":"RIGHT"}',
    );
    const content = JSON.parse(result.content) as { patch: string; patchContentTruncated: boolean };

    expect(result.status).toBe("truncated");
    expect(new TextEncoder().encode(result.content).byteLength).toBeLessThanOrEqual(12_000);
    expect(content).toMatchObject({ patchContentTruncated: true });
    expect(content.patch).toContain("TOKEN_START");
    expect(content.patch).toContain("TOKEN_END");
    expect(result.evidence).toMatchObject({
      complete: false,
      sourceTargeted: true,
      patchIntervalComplete: false,
    });
  });

  it("rejects a source line that is not in the requested patch side", async () => {
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{
          path: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -7 +7 @@\n-old\n+new",
        }],
        diff: "",
        truncated: false,
      },
    );
    const tools = new RepositoryTools(repository);

    const result = await tools.invoke(
      "diff_for_source_line",
      '{"path":"src/a.ts","source_line":8,"side":"RIGHT"}',
    );

    expect(result).toMatchObject({ status: "invalid_arguments", errorCode: "invalid_tool_arguments" });
  });

  it("keeps source-line hazards distinct across corrected lookups", async () => {
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{
          path: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -7 +7 @@\n-old\n+new",
        }],
        diff: "",
        truncated: true,
        diffTruncated: true,
      },
    );
    const tools = new RepositoryTools(repository);

    await tools.invoke(
      "diff_for_source_line",
      '{"path":"src/a.ts","source_line":8,"side":"RIGHT"}',
    );
    expect(tools.coverage().unresolvedEvidence).toHaveLength(1);

    const corrected = await tools.invoke(
      "diff_for_source_line",
      '{"path":"src/a.ts","source_line":7,"side":"RIGHT"}',
    );

    expect(corrected.status).toBe("ok");
    expect(tools.coverage()).toMatchObject({
      sufficient: false,
      inspectedChangedFiles: 0,
      inspectedChangedPaths: [],
      invalidArguments: 1,
      unresolvedEvidence: [{
        scope: "diff_for_file:src/a.ts:source:RIGHT:8",
        status: "invalid_arguments",
      }],
      limitations: [
        expect.stringContaining("inspect 1 more exact changed-file patch"),
        expect.stringContaining("Correct the arguments"),
      ],
    });
  });

  it("locates changed source text beginning with ++ or --", async () => {
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [{
          path: "src/operators.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -7 +7 @@\n---oldValue\n+++newValue",
        }],
        diff: "",
        truncated: false,
      },
    );
    const tools = new RepositoryTools(repository);

    const result = await tools.invoke(
      "diff_for_source_line",
      '{"path":"src/operators.ts","source_line":7,"side":"RIGHT"}',
    );

    expect(result.status).toBe("ok");
    expect(JSON.parse(result.content)).toMatchObject({ sourcePatchLine: 3 });
  });

  it("prefers a current path over an older rename alias with the same name", async () => {
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [
          {
            path: "src/renamed.ts",
            previousPath: "src/shared.ts",
            status: "renamed",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-old rename\n+new rename",
          },
          {
            path: "src/shared.ts",
            status: "added",
            additions: 1,
            deletions: 0,
            patch: "@@ -0,0 +1 @@\n+new file",
          },
        ],
        diff: "",
        truncated: false,
      },
    );

    const result = await new RepositoryTools(repository).invoke(
      "diff_for_file",
      '{"path":"src/shared.ts"}',
    );

    expect(JSON.parse(result.content)).toMatchObject({ path: "src/shared.ts", previousPath: null });
  });

  it("keeps oversized changed-file pages parseable and advances adaptive pagination without gaps", async () => {
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: Array.from({ length: 110 }, (_, index) => ({
          path: `src/${"nested/".repeat(20)}${index}.ts`,
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@\n-old\n+new",
        })),
        diff: "",
        truncated: false,
      },
    );
    const tools = new RepositoryTools(repository);

    const first = await tools.invoke("changed_files", '{"offset":0,"limit":100}');
    const parsed = JSON.parse(first.content) as {
      files: Array<{ path: string }>;
      returned: number;
      nextOffset: number;
      compact: boolean;
      adaptivePage: boolean;
    };
    const second = await tools.invoke(
      "changed_files",
      JSON.stringify({ offset: parsed.nextOffset, limit: 100 }),
    );
    const next = JSON.parse(second.content) as { files: Array<{ path: string }>; returned: number };

    expect(first.status).toBe("truncated");
    expect(second.status).toBe("ok");
    expect(new TextEncoder().encode(first.content).byteLength).toBeLessThanOrEqual(12_000);
    expect(parsed).toMatchObject({
      returned: 73,
      nextOffset: 73,
      compact: true,
      adaptivePage: true,
    });
    expect(parsed.files).toHaveLength(73);
    expect(next.returned).toBe(37);
    expect(next.files).toHaveLength(37);
    expect(first.evidence).toMatchObject({
      offset: 0,
      requested: 100,
      returned: 73,
      total: 110,
      returnedRangeComplete: true,
    });
    expect(next.files[0]?.path).toBe(`src/${"nested/".repeat(20)}${parsed.returned}.ts`);
    expect(first.suggestedAction).toContain(`offset ${parsed.returned}`);
    expect(tools.coverage()).toMatchObject({
      sufficient: true,
      truncatedResults: 1,
      limitations: [],
      unresolvedEvidence: [],
      completeChangedFileRanges: [{ start: 0, end: 110 }],
    });
  });

  it("keeps the unreturned tail of an adaptive changed-file page unresolved when it is skipped", async () => {
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: Array.from({ length: 110 }, (_, index) => ({
          path: `src/${"nested/".repeat(20)}${index}.ts`,
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@\n-old\n+new",
        })),
        diff: "",
        truncated: false,
      },
    );
    const tools = new RepositoryTools(repository);

    const first = await tools.invoke("changed_files", '{"offset":0,"limit":100}');
    const parsed = JSON.parse(first.content) as { returned: number; nextOffset: number };
    await tools.invoke("changed_files", '{"offset":100,"limit":100}');

    expect(first.status).toBe("truncated");
    expect(parsed).toMatchObject({ returned: 73, nextOffset: 73 });
    expect(tools.coverage()).toMatchObject({
      sufficient: false,
      unresolvedEvidence: [{
        scope: "changed_files:0:100",
        status: "truncated",
        changedFileRange: { start: parsed.returned, end: 100 },
      }],
      completeChangedFileRanges: [
        { start: 0, end: parsed.returned },
        { start: 100, end: 110 },
      ],
    });
  });

  it("uses compact JSON to preserve full 100-file pagination offsets when possible", async () => {
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: Array.from({ length: 110 }, (_, index) => ({
          path: `src/${"nested/".repeat(10)}${index}.ts`,
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@\n-old\n+new",
        })),
        diff: "",
        truncated: false,
      },
    );
    const tools = new RepositoryTools(repository);

    const page = await tools.invoke("changed_files", '{"offset":0,"limit":100}');
    const parsed = JSON.parse(page.content) as {
      files: Array<{ path: string }>;
      returned: number;
      nextOffset: number;
      compact: boolean;
      adaptivePage?: boolean;
    };

    expect(page.status).toBe("ok");
    expect(new TextEncoder().encode(page.content).byteLength).toBeLessThanOrEqual(12_000);
    expect(parsed).toMatchObject({ returned: 100, nextOffset: 100, compact: true });
    expect(parsed.adaptivePage).toBeUndefined();
    expect(parsed.files).toHaveLength(100);
    expect(tools.coverage()).toMatchObject({ sufficient: true, truncatedResults: 0, limitations: [] });
  });

  it("keeps a truncated read unresolved when an unrelated range succeeds", async () => {
    const tools = new RepositoryTools({
      changes: { files: [], diff: "", truncated: false },
      read: vi.fn(async (_path: string, _ref: string, start: number, end: number) => (
        start === 1
          ? "x".repeat(20_000)
          : JSON.stringify({ path: "src/a.ts", ref: "head", startLine: start, endLine: end, totalLines: 500, content: "safe" })
      )),
    } as unknown as RepositoryWorkspace);

    const broad = await tools.invoke(
      "read_file",
      '{"path":"src/a.ts","ref":"head","start_line":1,"end_line":400}',
    );
    const unrelated = await tools.invoke(
      "read_file",
      '{"path":"src/a.ts","ref":"head","start_line":100,"end_line":150}',
    );

    expect(broad.status).toBe("truncated");
    expect(unrelated.status).toBe("ok");
    expect(broad.evidence?.scope).toBe("read_file:head:src/a.ts:1-400");
    expect(unrelated.evidence?.scope).toBe("read_file:head:src/a.ts:100-150");
    expect(tools.coverage()).toMatchObject({ sufficient: false, limitations: [expect.any(String)] });
  });

  it("keeps truncated code-search indexes advisory rather than globally incomplete", async () => {
    const tools = new RepositoryTools({
      changes: { files: [], diff: "", truncated: false },
      search: vi.fn(async (_query: string, prefix: string | undefined) => renderSearchResults(
        prefix === "src/a" ? [{ path: "src/a.ts", line: 7, fragment: "x".repeat(20_000) }] : [],
        prefix === "src/a",
      )),
    } as unknown as RepositoryWorkspace);

    const broad = await tools.invoke(
      "search_code",
      '{"query":"needle","path_prefix":"src/a","limit":20}',
    );
    const unrelated = await tools.invoke(
      "search_code",
      '{"query":"needle","path_prefix":"src/b","limit":5}',
    );

    expect(broad.status).toBe("truncated");
    expect(unrelated.status).toBe("ok");
    expect(broad.evidence?.scope).toBe("search_code:needle:path=src/a:limit=20");
    expect(broad.evidence?.advisory).toBe(true);
    expect(unrelated.evidence?.scope).toBe("search_code:needle:path=src/b:limit=5");
    expect(tools.coverage()).toMatchObject({
      sufficient: true,
      truncatedResults: 1,
      limitations: [],
      unresolvedEvidence: [],
    });
    expect(tools.coverage().completedEvidenceScopes).not.toContain(broad.evidence?.scope);
  });

  it("counts canonical new paths once across dot, slash, and rename aliases", async () => {
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [
          {
            path: "src/current.ts",
            previousPath: "src/old.ts",
            status: "renamed",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
          {
            path: "src/other.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
        ],
        diff: "",
        truncated: true,
        diffTruncated: true,
      },
    );
    const tools = new RepositoryTools(repository);

    const dotAlias = await tools.invoke("diff_for_file", '{"path":"./src/current.ts"}');
    const slashAlias = await tools.invoke("diff_for_file", '{"path":"/src/current.ts"}');
    const renameAlias = await tools.invoke("diff_for_file", '{"path":"src/old.ts"}');

    expect(dotAlias.evidence?.scope).toBe("diff_for_file:src/current.ts");
    expect(slashAlias.evidence?.scope).toBe("diff_for_file:src/current.ts");
    expect(renameAlias.evidence?.scope).toBe("diff_for_file:src/current.ts");
    expect(tools.coverage()).toMatchObject({
      sufficient: false,
      inspectedChangedFiles: 1,
      inspectedChangedPaths: ["src/current.ts"],
      limitations: [expect.stringContaining("inspect 1 more exact changed-file patch")],
    });
  });

  it("keeps omitted patches incomplete after two other exact patches are inspected", async () => {
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      {
        files: [
          { path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
          { path: "src/b.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1 +1 @@\n-old\n+new" },
          { path: "src/omitted.ts", status: "modified", additions: 1, deletions: 1, patch: null },
        ],
        diff: "",
        truncated: true,
        diffTruncated: true,
      },
    );
    const tools = new RepositoryTools(repository);

    await tools.invoke("diff_for_file", '{"path":"src/a.ts"}');
    await tools.invoke("diff_for_file", '{"path":"src/b.ts"}');

    const coverage = tools.coverage();
    expect(coverage).toMatchObject({
      sufficient: false,
      inspectedChangedFiles: 2,
      limitations: [expect.stringContaining("GitHub omitted exact patches for 1 changed file")],
    });
    expect(mergeEvidenceCoverage(coverage, coverage)).toMatchObject({
      sufficient: false,
      inspectedChangedFiles: 2,
      limitations: [expect.stringContaining("GitHub omitted exact patches for 1 changed file")],
    });
  });

  it("ignores malformed legacy coverage limitations instead of crashing a resumed review", () => {
    const coverage = {
      sufficient: false,
      totalChangedFiles: 1,
      inspectedChangedFiles: 0,
      toolCalls: 0,
      okResults: 0,
      truncatedResults: 0,
      transientErrors: 0,
      permanentErrors: 0,
      invalidArguments: 0,
      initialDiffTruncated: false,
      limitations: [undefined, "exact patch unavailable"],
    } as unknown as EvidenceCoverage;

    expect(mergeEvidenceCoverage(coverage, coverage)).toMatchObject({
      sufficient: false,
      limitations: ["exact patch unavailable"],
    });
  });

  it("resolves a cached scoped limitation with complete evidence from a later retry", () => {
    const cached = {
      ...new EvidenceCoverageTracker({ totalChangedFiles: 100, initialDiffTruncated: false }).snapshot(),
      sufficient: false,
      limitations: ["changed_files: split inventory"],
      unresolvedEvidence: [{
        scope: "changed_files:0:100",
        status: "truncated" as const,
        limitation: "changed_files: split inventory",
        changedFileRange: { start: 0, end: 100 },
      }],
    };
    const recovered = {
      ...new EvidenceCoverageTracker({ totalChangedFiles: 100, initialDiffTruncated: false }).snapshot(),
      completeChangedFileRanges: [{ start: 0, end: 50 }, { start: 50, end: 100 }],
    };

    expect(mergeEvidenceCoverage(cached, recovered)).toMatchObject({
      sufficient: true,
      limitations: [],
      completeChangedFileRanges: [{ start: 0, end: 100 }],
    });
  });

  it("keeps a genuinely truncated GitHub changed-file listing incomplete after patch recovery", async () => {
    const files = Array.from({ length: 300 }, (_, index) => ({
      path: `src/${index}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1 @@\n-old\n+new",
    }));
    const repository = new RepositoryWorkspace(
      {} as never,
      {} as never,
      job(),
      { files, diff: "", truncated: true },
    );
    const tools = new RepositoryTools(repository);

    await tools.invoke("diff_for_file", '{"path":"src/0.ts"}');
    await tools.invoke("diff_for_file", '{"path":"src/1.ts"}');

    expect(tools.coverage()).toMatchObject({
      sufficient: false,
      totalChangedFiles: 300,
      inspectedChangedFiles: 2,
      limitations: [expect.stringContaining("GitHub truncated the changed-file listing")],
    });
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

  it.each([
    ["changed_files", '{"offset":"0"}', "changedFiles"],
    ["changed_files", '{"limit":101}', "changedFiles"],
    ["diff_for_file", '{"path":"src/a.ts","patch_start_line":"1"}', "diffForFile"],
    ["diff_for_source_line", '{"path":"src/a.ts","source_line":0,"side":"RIGHT"}', "diffForSourceLine"],
    ["repository_tree", '{"limit":"1"}', "tree"],
    ["repository_tree", '{"limit":501}', "tree"],
    ["read_file", '{"path":"src/a.ts","start_line":"300","end_line":420}', "read"],
    ["read_file", '{"path":"src/a.ts","start_line":1,"end_line":0}', "read"],
    ["search_code", '{"query":"needle","limit":"20"}', "search"],
    ["search_code", '{"query":"needle","limit":21}', "search"],
  ])("rejects malformed or out-of-range %s integers before repository access", async (name, raw, method) => {
    const repository = {
      changes: { files: [], diff: "", truncated: false },
      changedFiles: vi.fn(),
      diffForFile: vi.fn(),
      diffForSourceLine: vi.fn(),
      tree: vi.fn(),
      read: vi.fn(),
      search: vi.fn(),
    };
    const tools = new RepositoryTools(repository as unknown as RepositoryWorkspace);

    const result = await tools.invoke(name, raw);

    expect(result).toMatchObject({
      status: "invalid_arguments",
      retryable: false,
      errorCode: "invalid_tool_arguments",
      isError: true,
    });
    expect(repository[method as keyof typeof repository]).not.toHaveBeenCalled();
  });

  it("rejects mixed coordinates without fabricating a source-evidence identity", async () => {
    const repository = {
      changes: { files: [], diff: "", truncated: false },
      diffForFile: vi.fn(),
    };
    const result = await new RepositoryTools(repository as unknown as RepositoryWorkspace).invoke(
      "diff_for_file",
      '{"path":"src/a.ts","patch_start_line":1,"patch_end_line":3,"source_line":7,"side":"RIGHT"}',
    );

    expect(result).toMatchObject({
      status: "invalid_arguments",
      evidence: {
        scope: "diff_for_file:src/a.ts:1-3",
        changedPath: "src/a.ts",
        sourceTargeted: false,
      },
    });
    expect(repository.diffForFile).not.toHaveBeenCalled();
  });

  it.each([
    ["diff_for_file", '{"path":"src/a.ts","side":"typo"}', "diffForFile"],
    ["diff_for_file", '{"path":"src/a.ts","side":"RIGHT","unknown":true}', "diffForFile"],
    ["diff_for_file", '{"path":"src/a.ts","patch_start_line":1,"patch_end_line":3,"source_line":7,"side":"RIGHT"}', "diffForFile"],
    ["diff_for_source_line", '{"path":"src/a.ts","source_line":7,"side":"typo"}', "diffForSourceLine"],
    ["diff_for_source_line", '{"path":"src/a.ts","source_line":7}', "diffForSourceLine"],
    ["read_file", '{"path":"src/a.ts","ref":"typo","start_line":1,"end_line":20}', "read"],
    ["read_file", '{"path":"src/a.ts","ref":"head","start_line":1,"end_line":20,"unknown":true}', "read"],
    ["read_file", '{"path":"src/a.ts","ref":"head","start_line":1}', "read"],
    ["repository_tree", '{"prefix":42}', "tree"],
    ["search_code", '{"query":"needle","path_prefix":42}', "search"],
  ])("rejects enum, required-field, and unknown-key violations for %s", async (name, raw, method) => {
    const repository = {
      changes: { files: [], diff: "", truncated: false },
      changedFiles: vi.fn(),
      diffForFile: vi.fn(),
      diffForSourceLine: vi.fn(),
      tree: vi.fn(),
      read: vi.fn(),
      search: vi.fn(),
    };
    const result = await new RepositoryTools(repository as unknown as RepositoryWorkspace).invoke(name, raw);

    expect(result).toMatchObject({
      status: "invalid_arguments",
      errorCode: "invalid_tool_arguments",
      isError: true,
    });
    expect(repository[method as keyof typeof repository]).not.toHaveBeenCalled();
  });
});

describe("evidence coverage recovery", () => {
  it("clears a slice limitation only after its advertised inclusive recovery range is covered", () => {
    const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: false });
    const record = (
      scope: string,
      start: number,
      end: number,
      nextStart: number,
      nextEnd: number,
    ) => tracker.record("diff_for_file", {
      status: "truncated",
      content: "exact partial patch",
      retryable: false,
      suggestedAction: `Recover ${nextStart}-${nextEnd}.`,
      evidence: {
        scope,
        complete: false,
        changedPath: "src/a.ts",
        patchStartLine: start,
        patchEndLine: end,
        totalPatchLines: 1_000,
        patchIntervalComplete: true,
        nextPatchStartLine: nextStart,
        nextPatchEndLine: nextEnd,
        sourceTargeted: false,
      },
    }, "src/a.ts");

    record("first", 1, 200, 201, 600);
    record("short-recovery", 201, 599, 600, 999);
    expect(tracker.snapshot().unresolvedEvidence?.map((entry) => entry.scope)).toContain("first");

    record("last-advertised-line", 600, 600, 601, 1_000);

    expect(tracker.snapshot()).toMatchObject({
      inspectedChangedFiles: 0,
      unresolvedEvidence: [
        { scope: "short-recovery", changedPatchRange: { start: 600, end: 1_000 } },
        { scope: "last-advertised-line", changedPatchRange: { start: 601, end: 1_001 } },
      ],
      changedPatchCoverage: [{
        path: "src/a.ts",
        totalPatchLines: 1_000,
        intervals: [{ start: 1, end: 601 }],
      }],
    });
    expect(tracker.snapshot().unresolvedEvidence?.map((entry) => entry.scope)).not.toContain("first");
  });

  it("unions partial patch intervals recovered in separate phases", () => {
    const coverage = (start: number, end: number) => {
      const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: true });
      tracker.record("diff_for_file", {
        status: "truncated",
        content: "exact partial patch",
        retryable: false,
        suggestedAction: "Read the remaining exact patch lines.",
        evidence: {
          scope: `diff_for_file:src/a.ts:${start}-${end}`,
          complete: false,
          changedPath: "src/a.ts",
          patchStartLine: start,
          patchEndLine: end,
          totalPatchLines: 400,
          patchIntervalComplete: true,
          sourceTargeted: false,
        },
      }, "src/a.ts");
      return tracker.snapshot();
    };

    expect(mergeEvidenceCoverage(coverage(1, 200), coverage(201, 400))).toMatchObject({
      sufficient: true,
      inspectedChangedFiles: 1,
      inspectedChangedPaths: ["src/a.ts"],
      limitations: [],
      changedPatchCoverage: [{
        path: "src/a.ts",
        totalPatchLines: 400,
        intervals: [{ start: 1, end: 401 }],
      }],
    });
  });

  it("combines independently recovered patches without preserving stale truncation limitations", () => {
    const coverage = (path: string) => {
      const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 41, initialDiffTruncated: true });
      tracker.record("diff_for_file", {
        status: "ok",
        content: "exact patch",
        retryable: false,
        evidence: {
          scope: `diff_for_file:${path}`,
          complete: true,
          changedPath: path,
          patchStartLine: 1,
          patchEndLine: 3,
          totalPatchLines: 3,
          patchIntervalComplete: true,
          sourceTargeted: false,
        },
      }, path);
      return tracker.snapshot();
    };

    expect(mergeEvidenceCoverage(coverage("src/a.ts"), coverage("src/b.ts"))).toMatchObject({
      sufficient: true,
      totalChangedFiles: 41,
      inspectedChangedFiles: 2,
      limitations: [],
    });
  });

  it("does not double-count the same recovered patch across phases", () => {
    const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 41, initialDiffTruncated: true });
    tracker.record("diff_for_file", {
      status: "ok",
      content: "exact patch",
      retryable: false,
      evidence: {
        scope: "diff_for_file:src/a.ts",
        complete: true,
        changedPath: "src/a.ts",
        patchStartLine: 1,
        patchEndLine: 3,
        totalPatchLines: 3,
        patchIntervalComplete: true,
        sourceTargeted: false,
      },
    }, "src/a.ts");
    const merged = mergeEvidenceCoverage(tracker.snapshot(), tracker.snapshot());

    expect(merged).toMatchObject({
      sufficient: false,
      inspectedChangedFiles: 1,
      inspectedChangedPaths: ["src/a.ts"],
    });
  });

  it("preserves legacy count-only coverage conservatively without summing it", () => {
    const { changedPatchCoverage: _changedPatchCoverage, inspectedChangedPaths: _paths, ...legacy } =
      new EvidenceCoverageTracker({ totalChangedFiles: 4, initialDiffTruncated: true }).snapshot();
    const checkpoint: EvidenceCoverage = {
      ...legacy,
      inspectedChangedFiles: 1,
      sufficient: false,
      limitations: ["The initial cumulative diff was truncated; inspect 1 more exact changed-file patch."],
    };

    expect(mergeEvidenceCoverage(checkpoint, checkpoint)).toMatchObject({
      sufficient: false,
      inspectedChangedFiles: 1,
      limitations: [expect.stringContaining("inspect 1 more exact changed-file patch")],
    });
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
