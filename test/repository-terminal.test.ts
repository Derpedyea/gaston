import { describe, expect, it, vi } from "vitest";

import {
  ReadOnlyRepositoryFilesystem,
  REPOSITORY_TERMINAL_ROOT_POINTER,
  repositoryRelativePath,
} from "../src/repository-terminal-filesystem.ts";

const ROOT = `/gaston/cache/refs/${"a".repeat(40)}/snapshot-v2/files`;

describe("read-only repository terminal filesystem", () => {
  it("maps only /workspace paths into the exact-head snapshot", async () => {
    const readFile = vi.fn(async (path: string, encoding?: string) => {
      if (path === REPOSITORY_TERMINAL_ROOT_POINTER && encoding === "utf8") return ROOT;
      if (path === `${ROOT}/src/reviewer.ts` && encoding === "utf8") return "source";
      throw new Error(`unexpected read: ${path}`);
    });
    const fs = new ReadOnlyRepositoryFilesystem({ readFile } as never);

    await expect(fs.readFile("/workspace/src/reviewer.ts", "utf8")).resolves.toBe("source");
    expect(readFile).toHaveBeenNthCalledWith(1, REPOSITORY_TERMINAL_ROOT_POINTER, "utf8");
    expect(readFile).toHaveBeenNthCalledWith(2, `${ROOT}/src/reviewer.ts`, "utf8");
  });

  it("rejects lexical escapes before reading the host workspace", async () => {
    const readFile = vi.fn();
    const fs = new ReadOnlyRepositoryFilesystem({ readFile } as never);

    await expect(fs.readFile("/workspace/src/../../gaston/run/context/pr.json", "utf8"))
      .rejects.toMatchObject({ code: "EACCES" });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects every mutation with EROFS", () => {
    const fs = new ReadOnlyRepositoryFilesystem({} as never);

    expect(() => fs.writeFile()).toThrow(expect.objectContaining({ code: "EROFS" }));
    expect(() => fs.mkdir()).toThrow(expect.objectContaining({ code: "EROFS" }));
    expect(() => fs.rm()).toThrow(expect.objectContaining({ code: "EROFS" }));
    expect(() => fs.chmod()).toThrow(expect.objectContaining({ code: "EROFS" }));
    expect(() => fs.symlink()).toThrow(expect.objectContaining({ code: "EROFS" }));
  });
});

describe("repository terminal path normalization", () => {
  it.each([
    ["/workspace", ""],
    ["/workspace/src/a.ts", "src/a.ts"],
    ["src/a.ts", "src/a.ts"],
    ["/workspace/src/../test/a.ts", "test/a.ts"],
  ])("maps %s", (path, expected) => {
    expect(repositoryRelativePath(path)).toBe(expected);
  });

  it.each(["/", "/gaston", "/workspace/..", "../../gaston/run/context/pr.json"])(
    "rejects %s",
    (path) => {
      expect(() => repositoryRelativePath(path)).toThrow(expect.objectContaining({ code: "EACCES" }));
    },
  );
});
