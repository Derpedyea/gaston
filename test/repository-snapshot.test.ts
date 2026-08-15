import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import { RepositoryWorkspace } from "../src/repository.ts";
import {
  RepositorySnapshot,
  type RepositorySnapshotFilesystem,
} from "../src/repository-snapshot.ts";
import type { ReviewJob } from "../src/types.ts";
import type { RepositoryEntry } from "../src/types.ts";

describe("RepositorySnapshot", () => {
  it("materializes one immutable root and exposes bounded read, tree, and literal search", async () => {
    const fs = new MemoryFilesystem();
    const archive = archiveStream({
      "owner-repo-deadbeef/src/caller.ts": "export function caller(input: string) {\n  return RUN(input);\n}\n",
      "owner-repo-deadbeef/src/run.ts": "export function run(input: string) {\n  return input.trim();\n}\n",
      "owner-repo-deadbeef/assets/logo.bin": new Uint8Array([1, 0, 2, 3]),
    });
    const snapshot = snapshotFor(fs, archive, {}, [
      "src/caller.ts",
      "src/run.ts",
      "assets/logo.bin",
    ]);

    await expect(snapshot.ensure()).resolves.toMatchObject({
      status: "ready",
      indexedFiles: 2,
      omittedBinaryFiles: 1,
      searchComplete: true,
    });
    await expect(snapshot.read("src/run.ts")).resolves.toContain("input.trim");
    await expect(snapshot.read("assets/logo.bin")).resolves.toBeUndefined();
    await expect(snapshot.search("run(input)", undefined, 10)).resolves.toMatchObject({
      matches: [{ path: "src/caller.ts", line: 2 }],
      truncated: false,
    });
    await expect(snapshot.tree()).resolves.toMatchObject({
      entries: expect.arrayContaining([
        { path: "assets/logo.bin", type: "blob", size: null },
        { path: "src", type: "tree", size: null },
        { path: "src/run.ts", type: "blob", size: null },
      ]),
      truncated: false,
    });
  });

  it("rejects traversal and never publishes a partially extracted snapshot", async () => {
    const fs = new MemoryFilesystem();
    const snapshot = snapshotFor(fs, archiveStream({
      "owner-repo-deadbeef/src/safe.ts": "safe\n",
      "owner-repo-deadbeef/../escape.ts": "escape\n",
    }), {}, ["src/safe.ts"]);

    await expect(snapshot.ensure()).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("unsafe path"),
    });
    await expect(snapshot.read("src/safe.ts")).resolves.toBeUndefined();
    expect(fs.paths()).not.toContain(expect.stringContaining("manifest.json"));
  });

  it("rejects archives that cannot represent the exact Git tree", async () => {
    const fs = new MemoryFilesystem();
    const incomplete = snapshotFor(fs, archiveStream({
      "owner-repo-deadbeef/src/included.ts": "included\n",
    }), {}, ["src/included.ts", "test/export-ignored.test.ts"]);

    await expect(incomplete.ensure()).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("omits exact-tree path test/export-ignored.test.ts"),
    });

    const archiveLoader = vi.fn(async () => ({
      body: archiveStream({ "owner-repo-deadbeef/src/index.ts": "index\n" }),
    }));
    const transformed = new RepositorySnapshot({
      fs,
      ref: "attribute-ref",
      cacheRoot: "/cache",
      loadArchive: archiveLoader,
      loadInventory: async () => ({
        entries: inventoryFor([".gitattributes", "src/index.ts"]),
        truncated: false,
      }),
      loadControlFile: async () => "test/ export-ignore\nsrc/index.ts export-subst\n",
    });

    await expect(transformed.ensure()).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("uses export attributes"),
    });
    expect(archiveLoader).not.toHaveBeenCalled();

    const sizeTransformed = new RepositorySnapshot({
      fs,
      ref: "size-transformed-ref",
      cacheRoot: "/cache",
      loadArchive: async () => ({
        body: archiveStream({ "owner-repo-deadbeef/src/index.ts": "expanded archive content\n" }),
      }),
      loadInventory: async () => ({
        entries: [{ path: "src/index.ts", type: "blob", size: 5 }],
        truncated: false,
      }),
      loadControlFile: async () => { throw new Error("unexpected control-file read"); },
    });
    await expect(sizeTransformed.ensure()).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("transforms exact-tree content"),
    });
  });

  it("fails closed on repository limits and reuses only a completed exact-ref snapshot", async () => {
    const fs = new MemoryFilesystem();
    const tooLarge = snapshotFor(fs, archiveStream({
      "owner-repo-deadbeef/src/large.ts": "x".repeat(100),
    }), { maxIndexedBytes: 50 }, ["src/large.ts"]);
    await expect(tooLarge.ensure()).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("indexed-content limit"),
    });

    const ready = snapshotFor(fs, archiveStream({
      "owner-repo-deadbeef/src/ready.ts": "export const ready = true;\n",
    }), {}, ["src/ready.ts"]);
    await expect(ready.ensure()).resolves.toMatchObject({ status: "ready" });

    const loader = vi.fn(async () => { throw new Error("archive should not be fetched twice"); });
    const reused = new RepositorySnapshot({
      fs,
      ref: "deadbeef",
      cacheRoot: "/cache",
      loadArchive: loader,
      loadInventory: async () => { throw new Error("inventory should not be fetched twice"); },
      loadControlFile: async () => { throw new Error("control file should not be fetched twice"); },
    });
    await expect(reused.ensure()).resolves.toMatchObject({ status: "reused" });
    expect(loader).not.toHaveBeenCalled();
  });
});

describe("RepositoryWorkspace snapshot routing", () => {
  it("finds an exact-head callsite even when the remote GitHub search fixture misses it", async () => {
    const fs = new MemoryFilesystem();
    const remoteSearch = vi.fn(async () => ({
      matches: [{ path: "src/implementation.ts", fragment: "function dangerousCall" }],
      truncated: false,
    }));
    const github = {
      getRepositoryArchive: vi.fn(async () => ({
        body: archiveStream({
          "owner-repo-head/src/implementation.ts": "export function dangerousCall() { return 1; }\n",
          "owner-repo-head/src/hidden-caller.ts": "export const value = dangerousCall();\n",
        }),
      })),
      searchCode: remoteSearch,
      readFile: vi.fn(async () => { throw new Error("snapshot read unexpectedly fell back"); }),
      getRepositoryTree: vi.fn(async () => ({
        entries: inventoryFor(["src/implementation.ts", "src/hidden-caller.ts"]),
        truncated: false,
      })),
    };
    const repository = new RepositoryWorkspace(
      { fs } as never,
      github as never,
      reviewJob(),
      { files: [], diff: "", truncated: false },
      { snapshot: true },
    );

    await repository.initialize([]);
    const search = JSON.parse(await repository.search("dangerousCall", undefined, 10)) as {
      matches: Array<{ path: string; line?: number }>;
    };

    expect(search.matches.map((match) => match.path)).toEqual([
      "src/hidden-caller.ts",
      "src/implementation.ts",
    ]);
    expect(search.matches.every((match) => typeof match.line === "number")).toBe(true);
    expect(remoteSearch).not.toHaveBeenCalled();
    await expect(repository.read("src/hidden-caller.ts", "head", 1, 10)).resolves.toContain("dangerousCall");
    await expect(repository.tree("src", 10)).resolves.toContain("src/hidden-caller.ts");
  });
});

function snapshotFor(
  fs: MemoryFilesystem,
  body: ReadableStream<Uint8Array>,
  limits: ConstructorParameters<typeof RepositorySnapshot>[0]["limits"] = {},
  paths: string[] = [],
): RepositorySnapshot {
  return new RepositorySnapshot({
    fs,
    ref: "deadbeef",
    cacheRoot: "/cache",
    loadArchive: async () => ({ body }),
    loadInventory: async () => ({ entries: inventoryFor(paths), truncated: false }),
    loadControlFile: async () => { throw new Error("unexpected control-file read"); },
    limits,
  });
}

function inventoryFor(paths: string[]): RepositoryEntry[] {
  const directories = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return [
    ...[...directories].map((path): RepositoryEntry => ({ path, type: "tree", size: null })),
    ...paths.map((path): RepositoryEntry => ({ path, type: "blob", size: null })),
  ];
}

class MemoryFilesystem implements RepositorySnapshotFilesystem {
  readonly #files = new Map<string, Uint8Array>();
  readonly #directories = new Set<string>(["/"]);

  async readFile(path: string, _encoding: "utf8"): Promise<string> {
    const value = this.#files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return new TextDecoder().decode(value);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
    this.#files.set(path, bytes);
  }

  async mkdir(path: string, options: { recursive: true }): Promise<void> {
    expect(options.recursive).toBe(true);
    const parts = path.split("/").filter(Boolean);
    for (let index = 1; index <= parts.length; index++) this.#directories.add(`/${parts.slice(0, index).join("/")}`);
  }

  async rm(path: string, _options: { recursive: true; force: true }): Promise<void> {
    for (const candidate of [...this.#files.keys()]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.#files.delete(candidate);
    }
    for (const candidate of [...this.#directories]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.#directories.delete(candidate);
    }
  }

  async stat(path: string): Promise<{ mtime: number }> {
    if (!this.#files.has(path) && !this.#directories.has(path)) throw new Error(`ENOENT: ${path}`);
    return { mtime: Date.now() };
  }

  async readdir(): Promise<never[]> {
    return [];
  }

  paths(): string[] {
    return [...this.#files.keys()];
  }
}

function archiveStream(files: Record<string, string | Uint8Array>): ReadableStream<Uint8Array> {
  const compressed = new Uint8Array(gzipSync(tar(files)));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed);
      controller.close();
    },
  });
}

function tar(files: Record<string, string | Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [path, content] of Object.entries(files)) {
    const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const header = new Uint8Array(512);
    write(header, 0, 100, path);
    write(header, 100, 8, "0000644\0");
    write(header, 108, 8, "0000000\0");
    write(header, 116, 8, "0000000\0");
    write(header, 124, 12, `${body.byteLength.toString(8).padStart(11, "0")}\0`);
    header[156] = "0".charCodeAt(0);
    header.fill(32, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    write(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, body, new Uint8Array((512 - body.byteLength % 512) % 512));
  }
  chunks.push(new Uint8Array(1_024));
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function write(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(new TextEncoder().encode(value).slice(0, length), offset);
}

function reviewJob(): ReviewJob {
  return {
    deliveryId: "delivery",
    installationId: 1,
    owner: "owner",
    repo: "repo",
    pullNumber: 1,
    title: "title",
    body: "body",
    baseRef: "main",
    baseSha: "base",
    headSha: "head",
    queuedAt: "2026-08-15T00:00:00.000Z",
    trigger: "automatic",
  };
}
