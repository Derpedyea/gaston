import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";

import {
  pinnedNpmDependencySource,
  pinnedPythonDependencySource,
} from "../src/dependency-evidence.ts";

describe("pinned dependency evidence", () => {
  it("searches only a lockfile-pinned sdist after verifying its SHA-256", async () => {
    const archive = gzipSync(tar({
      "pydantic_ai_slim-2.27.0/pydantic_ai/usage.py": [
        "class RequestUsage:",
        "    input_tokens: int = 0",
        "    cache_read_tokens: int = 0",
        "",
      ].join("\n"),
    }));
    const digest = await sha256Hex(archive);
    const lock = `[[package]]
name = "pydantic-ai-slim"
version = "2.27.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/packages/example/pydantic_ai_slim-2.27.0.tar.gz", hash = "sha256:${digest}", size = ${archive.byteLength} }
`;

    const output = JSON.parse(await pinnedPythonDependencySource({
      packageName: "pydantic_ai",
      query: "cache_read_tokens",
      limit: 5,
      readHeadFile: async (path) => {
        expect(path).toBe("uv.lock");
        return lock;
      },
      fetcher: { fetch: async () => archive },
    })) as Record<string, unknown>;

    expect(output).toMatchObject({
      requestedPackage: "pydantic-ai",
      package: "pydantic-ai-slim",
      version: "2.27.0",
      sha256: digest,
      complete: true,
      matches: [{
        path: "pydantic_ai_slim-2.27.0/pydantic_ai/usage.py",
        line: 3,
      }],
    });
  });

  it("rejects artifact bytes that do not match the immutable lock digest", async () => {
    const expected = gzipSync(tar({ "pkg-1.0/source.py": "expected" }));
    const actual = new Uint8Array(expected);
    actual[actual.length - 1] = (actual[actual.length - 1] ?? 0) ^ 1;
    const digest = await sha256Hex(expected);

    await expect(pinnedPythonDependencySource({
      packageName: "pkg",
      query: "source",
      limit: 1,
      readHeadFile: async () => `[[package]]
name = "pkg"
version = "1.0"
sdist = { url = "https://files.pythonhosted.org/packages/example/pkg-1.0.tar.gz", hash = "sha256:${digest}", size = ${actual.byteLength} }
`,
      fetcher: { fetch: async () => actual },
    })).rejects.toThrow("digest mismatch");
  });

  it("searches a pnpm-pinned npm tarball and its hash-verified repository patch", async () => {
    const archive = gzipSync(tar({
      "package/src/list.ts": "export function settleAnchor(size: number) { return size > 0; }\n",
    }));
    const integrity = `sha512-${await sha512Base64(archive)}`;
    const patch = [
      "diff --git a/src/list.ts b/src/list.ts",
      "--- a/src/list.ts",
      "+++ b/src/list.ts",
      "@@ -1 +1 @@",
      "-export function settleAnchor(size: number) { return size > 0; }",
      "+export function settleAnchor(size: number) { return size >= 0; }",
      "",
    ].join("\n");
    const patchDigest = await sha256Hex(new TextEncoder().encode(patch));
    const metadata = new TextEncoder().encode(JSON.stringify({
      name: "@legendapp/list",
      version: "3.3.5",
      dist: {
        integrity,
        tarball: "https://registry.npmjs.org/@legendapp/list/-/list-3.3.5.tgz",
      },
    }));
    const files: Record<string, string> = {
      "pnpm-lock.yaml": `lockfileVersion: '9.0'\n\npatchedDependencies:\n  '@legendapp/list@3.3.5': ${patchDigest}\n\npackages:\n\n  '@legendapp/list@3.3.5':\n    resolution: {integrity: ${integrity}}\n`,
      "pnpm-workspace.yaml": `patchedDependencies:\n  "@legendapp/list@3.3.5": patches/@legendapp__list@3.3.5.patch\n`,
      "patches/@legendapp__list@3.3.5.patch": patch,
    };

    const output = JSON.parse(await pinnedNpmDependencySource({
      packageName: "@legendapp/list",
      query: "settleAnchor",
      limit: 5,
      readHeadFile: async (path) => {
        const content = files[path];
        if (content === undefined) throw new Error(`missing ${path}`);
        return content;
      },
      fetcher: {
        fetch: async (url) => url.includes("/-/") ? archive : metadata,
      },
    })) as Record<string, unknown>;

    expect(output).toMatchObject({
      ecosystem: "npm",
      package: "@legendapp/list",
      version: "3.3.5",
      integrity,
      patch: {
        path: "patches/@legendapp__list@3.3.5.patch",
        sha256: patchDigest,
      },
      complete: true,
    });
    expect(output.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "package/src/list.ts" }),
      expect.objectContaining({ path: "patches/@legendapp__list@3.3.5.patch" }),
    ]));
  });
});

function tar(files: Record<string, string>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [path, content] of Object.entries(files)) {
    const body = new TextEncoder().encode(content);
    const header = new Uint8Array(512);
    write(header, 0, 100, path);
    write(header, 100, 8, "0000644\0");
    write(header, 108, 8, "0000000\0");
    write(header, 116, 8, "0000000\0");
    write(header, 124, 12, `${body.byteLength.toString(8).padStart(11, "0")}\0`);
    header[156] = "0".charCodeAt(0);
    chunks.push(header, body, new Uint8Array((512 - body.byteLength % 512) % 512));
  }
  chunks.push(new Uint8Array(1_024));
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha512Base64(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", bytes);
  return Buffer.from(digest).toString("base64");
}
