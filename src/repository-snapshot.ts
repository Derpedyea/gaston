import type { RepositoryEntry } from "./types.ts";

const SNAPSHOT_SCHEMA_VERSION = 2;

export const DEFAULT_REPOSITORY_SNAPSHOT_LIMITS = {
  maxCompressedBytes: 32_000_000,
  maxUnpackedBytes: 96_000_000,
  maxIndexedBytes: 64_000_000,
  maxFileBytes: 400_000,
  maxFiles: 20_000,
  maxTreeEntries: 60_000,
  maxMetadataBytes: 256_000,
  maxPathBytes: 2_048,
  maxIndexMetadataBytes: 12_000_000,
} as const;

export interface RepositoryArchive {
  body: ReadableStream<Uint8Array>;
  contentLength?: number;
}

export interface RepositorySnapshotFilesystem {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, content: string | Uint8Array): Promise<unknown>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  rm(path: string, options: { recursive: true; force: true }): Promise<unknown>;
}

export interface RepositorySnapshotLimits {
  maxCompressedBytes: number;
  maxUnpackedBytes: number;
  maxIndexedBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  maxTreeEntries: number;
  maxMetadataBytes: number;
  maxPathBytes: number;
  maxIndexMetadataBytes: number;
}

export interface RepositorySnapshotReport {
  status: "ready" | "reused" | "unavailable" | "disabled";
  indexedFiles?: number;
  indexedBytes?: number;
  omittedBinaryFiles?: number;
  omittedUnreadableFiles?: number;
  omittedOversizedFiles?: number;
  searchComplete?: boolean;
  reason?: string;
}

interface SnapshotFile {
  path: string;
  size: number;
}

interface SnapshotManifest {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION;
  ref: string;
  ready: true;
  files: SnapshotFile[];
  indexedBytes: number;
  omittedBinaryFiles: number;
  omittedUnreadableFiles: number;
  omittedOversizedFiles: number;
  searchComplete: boolean;
}

export interface SnapshotSearchResult {
  matches: Array<{ path: string; line: number; fragment: string }>;
  truncated: boolean;
}

interface RepositorySnapshotOptions {
  fs: RepositorySnapshotFilesystem;
  ref: string;
  cacheRoot: string;
  loadArchive(signal?: AbortSignal): Promise<RepositoryArchive>;
  loadInventory(signal?: AbortSignal): Promise<{ entries: RepositoryEntry[]; truncated: boolean }>;
  loadControlFile(path: string, signal?: AbortSignal): Promise<string>;
  limits?: Partial<RepositorySnapshotLimits>;
}

class SnapshotArchiveError extends Error {}

/**
 * An immutable, exact-ref repository view backed by Computer storage.
 *
 * Archive ingestion is deliberately private to this module. Callers only get
 * bounded read, tree, and literal-search operations; neither the review model
 * nor the rest of the harness receives a shell or an execution primitive.
 */
export class RepositorySnapshot {
  readonly #fs: RepositorySnapshotFilesystem;
  readonly #ref: string;
  readonly #snapshotRoot: string;
  readonly #filesRoot: string;
  readonly #manifestPath: string;
  readonly #treePath: string;
  readonly #loadArchive: RepositorySnapshotOptions["loadArchive"];
  readonly #loadInventory: RepositorySnapshotOptions["loadInventory"];
  readonly #loadControlFile: RepositorySnapshotOptions["loadControlFile"];
  readonly #limits: RepositorySnapshotLimits;
  #manifest: SnapshotManifest | null = null;
  #tree: { entries: RepositoryEntry[]; truncated: boolean } | null = null;

  constructor(options: RepositorySnapshotOptions) {
    this.#fs = options.fs;
    this.#ref = options.ref;
    this.#snapshotRoot = `${options.cacheRoot}/${options.ref}/snapshot-v${SNAPSHOT_SCHEMA_VERSION}`;
    this.#filesRoot = `${this.#snapshotRoot}/files`;
    this.#manifestPath = `${this.#snapshotRoot}/manifest.json`;
    this.#treePath = `${this.#snapshotRoot}/tree.json`;
    this.#loadArchive = options.loadArchive;
    this.#loadInventory = options.loadInventory;
    this.#loadControlFile = options.loadControlFile;
    this.#limits = { ...DEFAULT_REPOSITORY_SNAPSHOT_LIMITS, ...options.limits };
  }

  async ensure(signal?: AbortSignal): Promise<RepositorySnapshotReport> {
    throwIfAborted(signal);
    const cached = await this.#loadManifest();
    if (cached !== null) return reportFor(cached, "reused");

    const inventory = await this.#loadInventory(signal);
    throwIfAborted(signal);
    if (inventory.truncated) {
      return this.#discard("exact Git tree is truncated, so archive completeness cannot be certified");
    }
    if (inventory.entries.length > this.#limits.maxTreeEntries) {
      return this.#discard(`repository exceeds the ${this.#limits.maxTreeEntries}-tree-entry limit`);
    }
    const attributePaths = inventory.entries
      .filter((entry) => entry.type === "blob"
        && (entry.path === ".gitattributes" || entry.path.endsWith("/.gitattributes")))
      .map((entry) => entry.path);
    for (const path of attributePaths) {
      const attributes = await this.#loadControlFile(path, signal);
      throwIfAborted(signal);
      if (usesArchiveTransform(attributes)) {
        return this.#discard(`${path} uses export attributes, so the source archive is not an exact tree view`);
      }
    }

    const archive = await this.#loadArchive(signal);
    throwIfAborted(signal);
    if (archive.contentLength !== undefined && archive.contentLength > this.#limits.maxCompressedBytes) {
      await archive.body.cancel().catch(() => undefined);
      return this.#discard(`archive exceeds the ${this.#limits.maxCompressedBytes}-byte compressed limit`);
    }

    await this.#fs.rm(this.#snapshotRoot, { recursive: true, force: true });
    await this.#fs.mkdir(this.#filesRoot, { recursive: true });

    try {
      const result = await this.#materialize(archive.body, inventory.entries, signal);
      const treeJson = JSON.stringify(result.tree);
      const manifestJson = JSON.stringify(result.manifest);
      if (byteLength(treeJson) + byteLength(manifestJson) > this.#limits.maxIndexMetadataBytes) {
        throw new SnapshotArchiveError(
          `snapshot index exceeds the ${this.#limits.maxIndexMetadataBytes}-byte metadata limit`,
        );
      }
      await this.#fs.writeFile(this.#treePath, treeJson);
      // The ready marker is committed last. Partial or interrupted extraction
      // can therefore never become visible to repository reads or searches.
      await this.#fs.writeFile(this.#manifestPath, manifestJson);
      this.#manifest = result.manifest;
      this.#tree = result.tree;
      return reportFor(result.manifest, "ready");
    } catch (error) {
      throwIfAborted(signal);
      await this.#fs.rm(this.#snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof SnapshotArchiveError) {
        return { status: "unavailable", reason: error.message };
      }
      throw error;
    }
  }

  async read(path: string): Promise<string | undefined> {
    const manifest = await this.#loadManifest();
    if (manifest === null || !manifest.files.some((file) => file.path === path)) return undefined;
    return this.#fs.readFile(`${this.#filesRoot}/${path}`, "utf8");
  }

  async tree(): Promise<{ entries: RepositoryEntry[]; truncated: boolean } | undefined> {
    if (await this.#loadManifest() === null) return undefined;
    if (this.#tree !== null) return this.#tree;
    try {
      const parsed = JSON.parse(await this.#fs.readFile(this.#treePath, "utf8")) as unknown;
      if (!isSnapshotTree(parsed)) return undefined;
      this.#tree = parsed;
      return parsed;
    } catch {
      return undefined;
    }
  }

  async search(
    query: string,
    pathPrefix: string | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SnapshotSearchResult | undefined> {
    const manifest = await this.#loadManifest();
    if (manifest === null) return undefined;
    const needle = query.replace(/["\\\r\n]/g, " ").trim().slice(0, 100).toLowerCase();
    if (needle.length < 2) throw new Error("search query must contain at least two characters");
    const prefix = pathPrefix?.replace(/\/$/, "");
    const boundedLimit = Math.max(1, Math.min(limit, 20));
    const matches: SnapshotSearchResult["matches"] = [];

    for (const file of manifest.files) {
      throwIfAborted(signal);
      if (prefix && file.path !== prefix && !file.path.startsWith(`${prefix}/`)) continue;
      const content = await this.#fs.readFile(`${this.#filesRoot}/${file.path}`, "utf8");
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index]!.toLowerCase().includes(needle)) continue;
        if (matches.length === boundedLimit) {
          return { matches, truncated: true };
        }
        const start = Math.max(0, index - 2);
        const end = Math.min(lines.length, index + 3);
        matches.push({
          path: file.path,
          line: index + 1,
          fragment: lines
            .slice(start, end)
            .map((line, lineIndex) => `${start + lineIndex + 1}: ${line}`)
            .join("\n"),
        });
      }
    }
    return { matches, truncated: !manifest.searchComplete };
  }

  async #materialize(
    compressed: ReadableStream<Uint8Array>,
    inventory: RepositoryEntry[],
    signal?: AbortSignal,
  ): Promise<{
    manifest: SnapshotManifest;
    tree: { entries: RepositoryEntry[]; truncated: boolean };
  }> {
    const boundedCompressed = limitStream(
      compressed,
      this.#limits.maxCompressedBytes,
      "compressed archive",
      signal,
    );
    let decompressed: ReadableStream<Uint8Array>;
    try {
      decompressed = boundedCompressed.pipeThrough(new DecompressionStream("gzip"));
    } catch (error) {
      throw new SnapshotArchiveError(`archive is not valid gzip: ${errorMessage(error)}`);
    }
    const reader = new ByteReader(
      decompressed,
      this.#limits.maxUnpackedBytes,
      signal,
    );
    const files: SnapshotFile[] = [];
    const paths = new Set<string>();
    const regularSizes = new Map<string, number>();
    let archiveRoot: string | undefined;
    let pendingPath: string | undefined;
    let indexedBytes = 0;
    let omittedBinaryFiles = 0;
    let omittedUnreadableFiles = 0;
    let omittedOversizedFiles = 0;
    let entries = 0;

    try {
      while (true) {
        throwIfAborted(signal);
        const header = await reader.readExact(512, true);
        if (header === undefined || header.every((byte) => byte === 0)) break;
        validateTarChecksum(header);
        entries++;
        if (entries > this.#limits.maxFiles) {
          throw new SnapshotArchiveError(`archive exceeds the ${this.#limits.maxFiles}-entry limit`);
        }
        const size = tarSize(header);
        const type = header[156] ?? 0;
        const headerPath = tarPath(header);
        let body: Uint8Array | undefined;
        const isMetadata = type === 120 || type === 103 || type === 76;
        const isRegular = type === 0 || type === 48;

        if ((isMetadata && size <= this.#limits.maxMetadataBytes)
          || (isRegular && size <= this.#limits.maxFileBytes)) {
          body = await reader.readExact(size, false);
        } else {
          await reader.skip(size);
        }
        await reader.skip((512 - size % 512) % 512);

        if (type === 120 || type === 103) {
          if (body === undefined) throw new SnapshotArchiveError("tar metadata exceeds its size limit");
          const paxPath = parsePaxPath(body);
          if (type === 120 && paxPath !== undefined) pendingPath = paxPath;
          continue;
        }
        if (type === 76) {
          if (body === undefined) throw new SnapshotArchiveError("GNU tar path metadata exceeds its size limit");
          pendingPath = tarString(body).replace(/\n$/, "");
          continue;
        }

        const rawPath = pendingPath ?? headerPath;
        pendingPath = undefined;
        const stripped = stripArchiveRoot(rawPath, archiveRoot, this.#limits.maxPathBytes);
        archiveRoot = stripped.root;
        const path = stripped.path;
        if (path === "" || type === 53) continue;
        if (paths.has(path)) throw new SnapshotArchiveError(`archive contains duplicate path ${path}`);
        paths.add(path);
        if (!isRegular) continue;
        regularSizes.set(path, size);
        if (body === undefined) {
          omittedOversizedFiles++;
          continue;
        }
        if (body.includes(0)) {
          omittedBinaryFiles++;
          continue;
        }
        if (!isUtf8(body)) {
          omittedUnreadableFiles++;
          continue;
        }
        if (indexedBytes + body.byteLength > this.#limits.maxIndexedBytes) {
          throw new SnapshotArchiveError(`archive exceeds the ${this.#limits.maxIndexedBytes}-byte indexed-content limit`);
        }
        const target = `${this.#filesRoot}/${path}`;
        await this.#fs.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
        await this.#fs.writeFile(target, body);
        indexedBytes += body.byteLength;
        files.push({ path, size: body.byteLength });
      }
    } catch (error) {
      if (error instanceof SnapshotArchiveError) throw error;
      throwIfAborted(signal);
      throw new SnapshotArchiveError(`archive extraction failed: ${errorMessage(error)}`);
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    const expectedPaths = new Set(
      inventory.filter((entry) => entry.type === "blob").map((entry) => entry.path),
    );
    const missing = [...expectedPaths].find((path) => !paths.has(path));
    const unexpected = [...paths].find((path) => !expectedPaths.has(path));
    if (missing !== undefined || unexpected !== undefined) {
      throw new SnapshotArchiveError(
        missing !== undefined
          ? `source archive omits exact-tree path ${missing}`
          : `source archive contains unexpected path ${unexpected}`,
      );
    }
    const sizeMismatch = inventory.find((entry) => entry.type === "blob"
      && entry.size !== null
      && regularSizes.has(entry.path)
      && regularSizes.get(entry.path) !== entry.size);
    if (sizeMismatch !== undefined) {
      throw new SnapshotArchiveError(`source archive transforms exact-tree content at ${sizeMismatch.path}`);
    }
    const treeEntries = [...inventory].sort((left, right) => left.path.localeCompare(right.path));
    const manifest: SnapshotManifest = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      ref: this.#ref,
      ready: true,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
      indexedBytes,
      omittedBinaryFiles,
      omittedUnreadableFiles,
      omittedOversizedFiles,
      searchComplete: omittedOversizedFiles === 0 && omittedUnreadableFiles === 0,
    };
    return { manifest, tree: { entries: treeEntries, truncated: false } };
  }

  async #loadManifest(): Promise<SnapshotManifest | null> {
    if (this.#manifest !== null) return this.#manifest;
    try {
      const parsed = JSON.parse(await this.#fs.readFile(this.#manifestPath, "utf8")) as unknown;
      if (!isSnapshotManifest(parsed, this.#ref)) return null;
      this.#manifest = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  async #discard(reason: string): Promise<RepositorySnapshotReport> {
    await this.#fs.rm(this.#snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
    return { status: "unavailable", reason };
  }
}

function reportFor(
  manifest: SnapshotManifest,
  status: "ready" | "reused",
): RepositorySnapshotReport {
  return {
    status,
    indexedFiles: manifest.files.length,
    indexedBytes: manifest.indexedBytes,
    omittedBinaryFiles: manifest.omittedBinaryFiles,
    omittedUnreadableFiles: manifest.omittedUnreadableFiles,
    omittedOversizedFiles: manifest.omittedOversizedFiles,
    searchComplete: manifest.searchComplete,
  };
}

class ByteReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #maxBytes: number;
  readonly #signal: AbortSignal | undefined;
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  #total = 0;
  #done = false;

  constructor(stream: ReadableStream<Uint8Array>, maxBytes: number, signal?: AbortSignal) {
    this.#reader = stream.getReader();
    this.#maxBytes = maxBytes;
    this.#signal = signal;
  }

  async readExact(length: number, allowEnd: true): Promise<Uint8Array | undefined>;
  async readExact(length: number, allowEnd: false): Promise<Uint8Array>;
  async readExact(length: number, allowEnd: boolean): Promise<Uint8Array | undefined> {
    if (!Number.isSafeInteger(length) || length < 0) throw new SnapshotArchiveError("tar entry has an invalid size");
    while (this.#buffer.byteLength < length && !this.#done) {
      throwIfAborted(this.#signal);
      const { done, value } = await this.#reader.read();
      if (done) {
        this.#done = true;
        break;
      }
      this.#total += value.byteLength;
      if (this.#total > this.#maxBytes) {
        await this.#reader.cancel();
        throw new SnapshotArchiveError(`archive exceeds the ${this.#maxBytes}-byte uncompressed limit`);
      }
      this.#buffer = concatenate(this.#buffer, value);
    }
    if (this.#buffer.byteLength < length) {
      if (allowEnd && this.#buffer.byteLength === 0) return undefined;
      throw new SnapshotArchiveError("tar archive ended inside an entry");
    }
    const result = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.slice(length);
    return result;
  }

  async skip(length: number): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      const chunk = Math.min(remaining, 64 * 1_024);
      await this.readExact(chunk, false);
      remaining -= chunk;
    }
  }

  cancel(): Promise<void> {
    return this.#reader.cancel().then(() => undefined);
  }
}

function limitStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        throwIfAborted(signal);
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          controller.error(new SnapshotArchiveError(`${label} exceeds the ${maxBytes}-byte limit`));
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function tarPath(header: Uint8Array): string {
  const name = tarString(header.slice(0, 100));
  const prefix = tarString(header.slice(345, 500));
  return prefix ? `${prefix}/${name}` : name;
}

function tarSize(header: Uint8Array): number {
  const bytes = header.slice(124, 136);
  if ((bytes[0] ?? 0) >= 0x80) throw new SnapshotArchiveError("base-256 tar sizes are not supported");
  const text = tarString(bytes).trim().replace(/^0+/, "") || "0";
  if (!/^[0-7]+$/.test(text)) throw new SnapshotArchiveError("tar entry has an invalid size");
  const size = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new SnapshotArchiveError("tar entry has an invalid size");
  return size;
}

function validateTarChecksum(header: Uint8Array): void {
  const storedText = tarString(header.slice(148, 156)).trim().replace(/^0+/, "") || "0";
  if (!/^[0-7]+$/.test(storedText)) throw new SnapshotArchiveError("tar header has an invalid checksum");
  const stored = Number.parseInt(storedText, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index++) {
    actual += index >= 148 && index < 156 ? 32 : header[index]!;
  }
  if (stored !== actual) throw new SnapshotArchiveError("tar header checksum mismatch");
}

function parsePaxPath(bytes: Uint8Array): string | undefined {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let offset = 0;
  let path: string | undefined;
  while (offset < bytes.byteLength) {
    let space = offset;
    while (space < bytes.byteLength && bytes[space] !== 32) space++;
    if (space === bytes.byteLength) throw new SnapshotArchiveError("tar PAX metadata is malformed");
    const length = Number(decoder.decode(bytes.slice(offset, space)));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.byteLength) {
      throw new SnapshotArchiveError("tar PAX metadata has an invalid record length");
    }
    const record = decoder.decode(bytes.slice(space + 1, offset + length)).replace(/\n$/, "");
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

function stripArchiveRoot(
  rawPath: string,
  expectedRoot: string | undefined,
  maxPathBytes: number,
): { root: string; path: string } {
  const normalized = rawPath.replace(/\/$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || normalized.includes("\0")) {
    throw new SnapshotArchiveError("archive contains an unsafe path");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new SnapshotArchiveError("archive contains an unsafe path");
  }
  const root = parts[0]!;
  if (expectedRoot !== undefined && root !== expectedRoot) {
    throw new SnapshotArchiveError("archive entries do not share one immutable root");
  }
  const path = parts.slice(1).join("/");
  if (byteLength(path) > maxPathBytes) {
    throw new SnapshotArchiveError(`archive path exceeds the ${maxPathBytes}-byte limit`);
  }
  return { root, path };
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function tarString(bytes: Uint8Array): string {
  const zero = bytes.indexOf(0);
  return new TextDecoder().decode(zero === -1 ? bytes : bytes.slice(0, zero));
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left, 0);
  result.set(right, left.byteLength);
  return result;
}

function isSnapshotManifest(value: unknown, ref: string): value is SnapshotManifest {
  if (!isRecord(value)
    || value.schemaVersion !== SNAPSHOT_SCHEMA_VERSION
    || value.ref !== ref
    || value.ready !== true
    || !Array.isArray(value.files)
    || typeof value.indexedBytes !== "number"
    || typeof value.omittedBinaryFiles !== "number"
    || typeof value.omittedUnreadableFiles !== "number"
    || typeof value.omittedOversizedFiles !== "number"
    || typeof value.searchComplete !== "boolean") return false;
  return value.files.every((file) => isRecord(file)
    && typeof file.path === "string"
    && typeof file.size === "number");
}

function isSnapshotTree(value: unknown): value is { entries: RepositoryEntry[]; truncated: boolean } {
  return isRecord(value)
    && Array.isArray(value.entries)
    && typeof value.truncated === "boolean"
    && value.entries.every((entry) => isRecord(entry)
      && typeof entry.path === "string"
      && (entry.type === "blob" || entry.type === "tree")
      && (typeof entry.size === "number" || entry.size === null));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usesArchiveTransform(content: string): boolean {
  return content.split("\n").some((line) => {
    const rule = line.trim();
    if (!rule || /^#/.test(rule)) return false;
    return /(?:^|\s)[!+-]?export-(?:ignore|subst)(?:\s|=|$)/.test(rule);
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
