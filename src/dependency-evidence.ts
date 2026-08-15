const MAX_ARCHIVE_BYTES = 6_000_000;
const MAX_UNPACKED_BYTES = 30_000_000;
const MAX_SOURCE_FILE_BYTES = 2_000_000;
const MAX_ARCHIVE_FILES = 12_000;

export interface DependencyArtifactFetcher {
  fetch(url: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface PinnedDependencySourceInput {
  packageName: string;
  query: string;
  limit: number;
  readHeadFile(path: string, signal?: AbortSignal): Promise<string>;
  signal?: AbortSignal;
  fetcher?: DependencyArtifactFetcher;
}

export interface PinnedNpmDependencySourceInput extends PinnedDependencySourceInput {}

/** Search whichever immutable lock ecosystem contains the requested package. */
export async function pinnedDependencySource(
  input: PinnedDependencySourceInput,
): Promise<string> {
  let pythonError: unknown;
  try {
    return await pinnedPythonDependencySource(input);
  } catch (error) {
    pythonError = error;
  }
  try {
    return await pinnedNpmDependencySource(input);
  } catch (npmError) {
    throw new Error(
      `dependency is unavailable from supported immutable locks (uv: ${errorMessage(pythonError)}; pnpm: ${errorMessage(npmError)})`,
    );
  }
}

/**
 * Resolve a Python package from the exact PR-head uv.lock, verify the locked
 * sdist SHA-256, and search its source without executing dependency code.
 */
export async function pinnedPythonDependencySource(
  input: PinnedDependencySourceInput,
): Promise<string> {
  const packageName = normalizePackage(input.packageName);
  if (!packageName || !input.query.trim()) throw new Error("package and query must be non-empty");
  const lock = await input.readHeadFile("uv.lock", input.signal);
  const pinned = lockedSdist(lock, packageName);
  const artifact = await (input.fetcher ?? registryArtifactFetcher).fetch(pinned.url, input.signal);
  if (artifact.byteLength !== pinned.size) {
    throw new Error(`locked artifact size mismatch for ${packageName}@${pinned.version}`);
  }
  const digest = await sha256Hex(artifact);
  if (digest !== pinned.sha256) {
    throw new Error(`locked artifact digest mismatch for ${packageName}@${pinned.version}`);
  }
  const unpacked = await gunzip(artifact);
  const matches = searchTar(unpacked, input.query, Math.max(1, Math.min(input.limit, 20)));
  return JSON.stringify({
    ecosystem: "pypi",
    requestedPackage: packageName,
    package: pinned.name,
    version: pinned.version,
    artifactUrl: pinned.url,
    sha256: pinned.sha256,
    lockfile: "uv.lock",
    query: input.query,
    matches,
    complete: true,
  });
}

/**
 * Resolve an npm package from the exact PR-head pnpm lock, verify the registry
 * tarball's SHA-512 SRI, and include any hash-verified pnpm patch in the search.
 */
export async function pinnedNpmDependencySource(
  input: PinnedNpmDependencySourceInput,
): Promise<string> {
  const packageName = normalizeNpmPackage(input.packageName);
  if (!packageName || !input.query.trim()) throw new Error("package and query must be non-empty");
  const lock = await input.readHeadFile("pnpm-lock.yaml", input.signal);
  const pinned = lockedNpmPackage(lock, packageName);
  const fetcher = input.fetcher ?? registryArtifactFetcher;
  const metadataUrl = `https://registry.npmjs.org/${npmRegistryName(packageName)}/${encodeURIComponent(pinned.version)}`;
  const metadataBytes = await fetcher.fetch(metadataUrl, input.signal);
  if (metadataBytes.byteLength > MAX_SOURCE_FILE_BYTES) {
    throw new Error(`npm metadata exceeds the size limit for ${packageName}@${pinned.version}`);
  }
  const metadata = parseNpmMetadata(metadataBytes, packageName, pinned.version);
  if (metadata.integrity !== pinned.integrity) {
    throw new Error(`registry integrity disagrees with pnpm-lock.yaml for ${packageName}@${pinned.version}`);
  }
  const artifact = await fetcher.fetch(metadata.tarball, input.signal);
  if (artifact.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("locked dependency artifact exceeds the compressed size limit");
  }
  const actualIntegrity = `sha512-${await sha512Base64(artifact)}`;
  if (actualIntegrity !== pinned.integrity) {
    throw new Error(`locked artifact integrity mismatch for ${packageName}@${pinned.version}`);
  }
  const unpacked = await gunzip(artifact);
  const boundedLimit = Math.max(1, Math.min(input.limit, 20));
  const matches = searchTar(unpacked, input.query, boundedLimit);
  const patch = await lockedNpmPatch(input, lock, `${packageName}@${pinned.version}`);
  if (patch !== undefined && matches.length < boundedLimit) {
    matches.push(...searchText(
      patch.path,
      patch.content,
      input.query,
      boundedLimit - matches.length,
    ));
  }
  return JSON.stringify({
    ecosystem: "npm",
    requestedPackage: packageName,
    package: packageName,
    version: pinned.version,
    integrity: pinned.integrity,
    artifactUrl: metadata.tarball,
    lockfile: "pnpm-lock.yaml",
    ...(patch === undefined ? {} : {
      patch: { path: patch.path, sha256: patch.sha256 },
    }),
    query: input.query,
    matches,
    complete: true,
  });
}

const registryArtifactFetcher: DependencyArtifactFetcher = {
  async fetch(url, signal) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:"
      || (parsed.hostname !== "files.pythonhosted.org" && parsed.hostname !== "registry.npmjs.org")
    ) {
      throw new Error("locked dependency artifact host is not allowed");
    }
    const response = await fetch(parsed.toString(), {
      redirect: "error",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new Error(`dependency registry returned HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) {
      throw new Error("locked dependency artifact exceeds the compressed size limit");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error("locked dependency artifact exceeds the compressed size limit");
    }
    return bytes;
  },
};

function lockedNpmPackage(lock: string, requestedName: string): {
  version: string;
  integrity: string;
} {
  const packagesHeader = lock.match(/^packages:\s*$/m);
  if (packagesHeader?.index === undefined) throw new Error("pnpm-lock.yaml has no packages section");
  const packagesTail = lock.slice(packagesHeader.index + packagesHeader[0].length);
  const nextRoot = packagesTail.match(/^[^\s#][^\n]*:\s*$/m);
  const packages = nextRoot?.index === undefined
    ? packagesTail
    : packagesTail.slice(0, nextRoot.index);
  const entries: Array<{ name: string; version: string; integrity: string }> = [];
  const header = /^  (?:'([^']+)'|"([^"]+)"|([^'"\s][^:]*)):\s*$/gm;
  const matches = [...packages.matchAll(header)];
  for (let index = 0; index < matches.length; index++) {
    const key = matches[index]![1] ?? matches[index]![2] ?? matches[index]![3] ?? "";
    const split = key.lastIndexOf("@");
    if (split <= 0) continue;
    const name = normalizeNpmPackage(key.slice(0, split));
    const version = key.slice(split + 1);
    const start = (matches[index]!.index ?? 0) + matches[index]![0].length;
    const end = matches[index + 1]?.index ?? packages.length;
    const integrity = packages.slice(start, end).match(/resolution:\s*\{[^}\n]*integrity:\s*([^,}\s]+)[^}\n]*\}/)?.[1];
    if (integrity !== undefined) entries.push({ name, version, integrity });
  }
  const exact = entries.filter((entry) => entry.name === requestedName);
  if (exact.length === 0) throw new Error(`pnpm-lock.yaml has no registry package for ${requestedName}`);
  if (exact.length > 1) throw new Error(`pnpm-lock.yaml has multiple versions of ${requestedName}; package is ambiguous`);
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(exact[0]!.integrity)) {
    throw new Error(`pnpm-lock.yaml integrity is not SHA-512 for ${requestedName}@${exact[0]!.version}`);
  }
  return exact[0]!;
}

function parseNpmMetadata(
  bytes: Uint8Array,
  packageName: string,
  version: string,
): { integrity: string; tarball: string } {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`registry metadata is invalid JSON for ${packageName}@${version}`);
  }
  if (!isRecord(value) || !isRecord(value.dist)) {
    throw new Error(`registry metadata has no dist contract for ${packageName}@${version}`);
  }
  const integrity = value.dist.integrity;
  const tarball = value.dist.tarball;
  if (typeof integrity !== "string" || typeof tarball !== "string") {
    throw new Error(`registry metadata has incomplete dist data for ${packageName}@${version}`);
  }
  const parsedTarball = new URL(tarball);
  if (parsedTarball.protocol !== "https:" || parsedTarball.hostname !== "registry.npmjs.org") {
    throw new Error(`registry tarball host is not allowed for ${packageName}@${version}`);
  }
  return { integrity, tarball: parsedTarball.toString() };
}

async function lockedNpmPatch(
  input: PinnedNpmDependencySourceInput,
  lock: string,
  packageKey: string,
): Promise<{ path: string; sha256: string; content: string } | undefined> {
  const escapedKey = escapeRegExp(packageKey);
  const hash = lock.match(new RegExp(`^  ['"]?${escapedKey}['"]?:\\s*([a-f0-9]{64})\\s*$`, "m"))?.[1];
  if (hash === undefined) return undefined;
  const workspace = await input.readHeadFile("pnpm-workspace.yaml", input.signal);
  const rawPath = workspace.match(new RegExp(`^  ['"]?${escapedKey}['"]?:\\s*([^\\n#]+)`, "m"))?.[1]?.trim();
  const path = rawPath?.replace(/^['"]|['"]$/g, "");
  if (!path || path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error(`pnpm workspace has no safe patch path for ${packageKey}`);
  }
  const content = await input.readHeadFile(path, input.signal);
  const actual = await sha256Hex(new TextEncoder().encode(content));
  if (actual !== hash) throw new Error(`locked patch digest mismatch for ${packageKey}`);
  return { path, sha256: hash, content };
}

function lockedSdist(lock: string, requestedName: string): {
  name: string;
  version: string;
  url: string;
  sha256: string;
  size: number;
} {
  const packages = lock.split(/^\[\[package\]\]\s*$/m).slice(1).flatMap((block) => {
    const name = block.match(/^name\s*=\s*"([^"]+)"\s*$/m)?.[1];
    const normalizedName = normalizePackage(name ?? "");
    if (!normalizedName) return [];
    const version = block.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
    const sdist = block.match(/^sdist\s*=\s*\{\s*url\s*=\s*"([^"]+)",\s*hash\s*=\s*"sha256:([a-f0-9]{64})",\s*size\s*=\s*(\d+)/m);
    if (version === undefined || sdist === null) return [];
    const size = Number(sdist[3]);
    return [{ name: normalizedName, version, url: sdist[1]!, sha256: sdist[2]!, size }];
  });
  const exact = packages.filter((entry) => entry.name === requestedName);
  const matches = exact.length > 0
    ? exact
    : packages.filter((entry) => entry.name.startsWith(`${requestedName}-`));
  if (matches.length === 0) throw new Error(`uv.lock has no registry sdist for ${requestedName}`);
  if (matches.length > 1) throw new Error(`uv.lock has multiple versions of ${requestedName}; package is ambiguous`);
  if (!Number.isSafeInteger(matches[0]!.size) || matches[0]!.size < 1 || matches[0]!.size > MAX_ARCHIVE_BYTES) {
    throw new Error(`locked artifact size is invalid for ${matches[0]!.name}@${matches[0]!.version}`);
  }
  return matches[0]!;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const result = new Uint8Array(await new Response(stream).arrayBuffer());
  if (result.byteLength > MAX_UNPACKED_BYTES) {
    throw new Error("locked dependency artifact exceeds the uncompressed size limit");
  }
  return result;
}

function searchTar(bytes: Uint8Array, query: string, limit: number): Array<{
  path: string;
  line: number;
  content: string;
}> {
  const decoder = new TextDecoder();
  const needle = query.toLowerCase();
  const matches: Array<{ path: string; line: number; content: string }> = [];
  let offset = 0;
  let files = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header.slice(0, 100));
    const prefix = tarString(header.slice(345, 500));
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = tarString(header.slice(124, 136)).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.byteLength) {
      throw new Error("locked dependency sdist contains an invalid tar entry");
    }
    const type = header[156];
    files++;
    if (files > MAX_ARCHIVE_FILES) throw new Error("locked dependency sdist has too many files");
    if ((type === 0 || type === 48) && size <= MAX_SOURCE_FILE_BYTES && isSearchable(path)) {
      const content = decoder.decode(bytes.slice(offset + 512, offset + 512 + size));
      const lines = content.split("\n");
      for (let index = 0; index < lines.length && matches.length < limit; index++) {
        if (!lines[index]!.toLowerCase().includes(needle)) continue;
        const start = Math.max(0, index - 3);
        const end = Math.min(lines.length, index + 4);
        matches.push({
          path,
          line: index + 1,
          content: lines.slice(start, end).map((line, lineIndex) => `${start + lineIndex + 1}: ${line}`).join("\n"),
        });
      }
    }
    if (matches.length >= limit) break;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return matches;
}

function searchText(
  path: string,
  content: string,
  query: string,
  limit: number,
): Array<{ path: string; line: number; content: string }> {
  const needle = query.toLowerCase();
  const lines = content.split("\n");
  const matches: Array<{ path: string; line: number; content: string }> = [];
  for (let index = 0; index < lines.length && matches.length < limit; index++) {
    if (!lines[index]!.toLowerCase().includes(needle)) continue;
    const start = Math.max(0, index - 3);
    const end = Math.min(lines.length, index + 4);
    matches.push({
      path,
      line: index + 1,
      content: lines.slice(start, end).map((line, lineIndex) => `${start + lineIndex + 1}: ${line}`).join("\n"),
    });
  }
  return matches;
}

function isSearchable(path: string): boolean {
  return /\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|md|rst|toml|json|txt)$/i.test(path)
    && !path.split("/").includes("..")
    && !path.startsWith("/");
}

function tarString(bytes: Uint8Array): string {
  const zero = bytes.indexOf(0);
  return new TextDecoder().decode(zero === -1 ? bytes : bytes.slice(0, zero));
}

function normalizePackage(value: string): string {
  return value.trim().toLowerCase().replace(/[_.]+/g, "-");
}

function normalizeNpmPackage(value: string): string {
  return value.trim().toLowerCase();
}

function npmRegistryName(value: string): string {
  return encodeURIComponent(value).replace(/^%40/i, "@");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha512Base64(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}
