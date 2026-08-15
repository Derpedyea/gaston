import type { WorkspaceClient } from "@cloudflare/computer";

import { EvidenceCoverageTracker, type EvidenceCoverage, type EvidenceResult } from "./evidence.ts";
import { pinnedDependencySource } from "./dependency-evidence.ts";
import { GitHubApiError, type GitHubClient } from "./github.ts";
import {
  RepositorySnapshot,
  type RepositorySnapshotReport,
} from "./repository-snapshot.ts";
import type {
  PullChangeSet,
  RepositoryEntry,
  RepositoryRef,
  ReviewJob,
} from "./types.ts";

const ROOT = "/gaston";
const RUN_ROOT = `${ROOT}/run`;
export const REVIEW_SESSION_DIFF_PATH = `${RUN_ROOT}/context/diff.patch`;
export const REVIEW_SESSION_FILES_PATH = `${RUN_ROOT}/context/session-files.json`;
const REF_CACHE_ROOT = `${ROOT}/cache/refs`;
const MAX_FILE_BYTES = 400_000;
const MAX_DEPENDENCY_LOCK_BYTES = 2_000_000;
const MAX_TOOL_RESULT_BYTES = 12_000;
export const INITIAL_DIFF_EXCERPT_BYTES = 40_000;
const DEFAULT_PATCH_LINES = 200;
const MAX_EXPLICIT_PATCH_LINES = 400;
const MAX_CACHED_REFS = 12;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1_000;
const BASE_POLICY_FILES = [
  ".gaston/review.md",
  "AGENTS.md",
  ".github/copilot-instructions.md",
  "CLAUDE.md",
] as const;
const MAX_POLICY_BYTES = 48_000;

export interface RepositoryCacheSnapshot {
  hits: number;
  misses: number;
  hitRate: number;
}

export interface RepositoryWorkspaceOptions {
  /** Materialize the exact PR-head archive into the immutable Computer cache. */
  snapshot?: boolean;
}

export class RepositoryWorkspace {
  readonly #workspace: WorkspaceClient;
  readonly #github: GitHubClient;
  readonly #job: ReviewJob;
  readonly #snapshot: RepositorySnapshot | null;
  readonly changes: PullChangeSet;
  #tree: RepositoryEntry[] | null = null;
  #treeTruncated = false;
  #cacheHits = 0;
  #cacheMisses = 0;
  #snapshotReport: RepositorySnapshotReport = { status: "disabled" };

  constructor(
    workspace: WorkspaceClient,
    github: GitHubClient,
    job: ReviewJob,
    changes: PullChangeSet,
    options: RepositoryWorkspaceOptions = {},
  ) {
    this.#workspace = workspace;
    this.#github = github;
    this.#job = job;
    this.changes = changes;
    this.#snapshot = options.snapshot === true
      ? new RepositorySnapshot({
        fs: workspace.fs,
        ref: job.headSha,
        cacheRoot: REF_CACHE_ROOT,
        loadArchive: (signal) => github.getRepositoryArchive(job, job.headSha, signal),
        loadInventory: (signal) => github.getRepositoryTree(job, job.headSha, signal),
        loadControlFile: (path, signal) => github.readFile(job, path, job.headSha, MAX_FILE_BYTES, signal),
      })
      : null;
  }

  async initialize(checks: Array<Record<string, unknown>>, signal?: AbortSignal): Promise<void> {
    await this.#workspace.fs.rm(RUN_ROOT, { recursive: true, force: true });
    await this.#workspace.fs.mkdir(`${RUN_ROOT}/context`, { recursive: true });
    await this.#workspace.fs.mkdir(REF_CACHE_ROOT, { recursive: true });
    await this.#pruneCache();
    await Promise.all([
      this.#workspace.fs.writeFile(`${RUN_ROOT}/context/pr.json`, JSON.stringify(this.#job, null, 2)),
      this.#workspace.fs.writeFile(`${RUN_ROOT}/context/checks.json`, JSON.stringify(checks, null, 2)),
      this.#workspace.fs.writeFile(REVIEW_SESSION_DIFF_PATH, this.changes.diff),
      this.#workspace.fs.writeFile(REVIEW_SESSION_FILES_PATH, JSON.stringify({
        files: this.changes.files.map((file) => ({
          path: file.path,
          ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patchAvailable: file.patch !== null,
        })),
        truncated: this.changes.filesTruncated ?? this.changes.truncated,
        diffTruncated: this.changes.diffTruncated ?? this.changes.truncated,
      })),
    ]);
    if (this.#snapshot !== null) {
      try {
        this.#snapshotReport = await this.#snapshot.ensure(signal);
      } catch (error) {
        throwIfAborted(signal);
        // A repository archive is an accuracy optimization, not a new review
        // availability dependency. Existing exact file/tree APIs remain the
        // safe fallback when a repository cannot be snapshotted.
        this.#snapshotReport = {
          status: "unavailable",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  snapshotReport(): RepositorySnapshotReport {
    return this.#snapshotReport;
  }

  cacheSnapshot(): RepositoryCacheSnapshot {
    const requests = this.#cacheHits + this.#cacheMisses;
    return {
      hits: this.#cacheHits,
      misses: this.#cacheMisses,
      hitRate: requests === 0 ? 0 : Number((this.#cacheHits / requests).toFixed(4)),
    };
  }

  changedFiles(offset = 0, limit = 100): string {
    return renderChangedFiles(this.changes, offset, limit);
  }

  diffForFile(
    path: string,
    patchStartLine?: number,
    patchEndLine?: number,
  ): string {
    return renderDiffForFile(
      this.changes,
      path,
      patchStartLine,
      patchEndLine,
    );
  }

  diffForSourceLine(
    path: string,
    sourceLine: number,
    sourceSide: "LEFT" | "RIGHT",
  ): string {
    return renderDiffForFile(
      this.changes,
      path,
      undefined,
      undefined,
      sourceLine,
      sourceSide,
    );
  }

  async tree(prefix: string, limit: number, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    await this.#loadTree(signal);
    const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
    if (normalizedPrefix) safePath(normalizedPrefix);
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const entries = this.#tree!
      .filter((entry) => !normalizedPrefix || entry.path === normalizedPrefix || entry.path.startsWith(`${normalizedPrefix}/`))
      .slice(0, boundedLimit);
    return JSON.stringify({
      entries,
      truncated: this.#treeTruncated || entries.length === boundedLimit,
    });
  }

  async read(
    path: string,
    ref: RepositoryRef,
    startLine: number,
    endLine: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const normalized = safePath(path);
    const content = await this.#cachedFile(normalized, ref, signal);
    const lines = content.split("\n");
    const start = Math.max(1, Math.min(Math.trunc(startLine), Math.max(1, lines.length)));
    const end = Math.max(start, Math.min(Math.trunc(endLine), start + 399, lines.length));
    const rendered = lines
      .slice(start - 1, end)
      .map((line, index) => `${start + index}: ${line}`)
      .join("\n");
    return JSON.stringify({ path: normalized, ref, startLine: start, endLine: end, totalLines: lines.length, content: rendered });
  }

  async search(
    query: string,
    pathPrefix: string | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const boundedLimit = Math.max(1, Math.min(limit, 20));
    if (pathPrefix) safePath(pathPrefix.replace(/\/$/, ""));
    if (this.#snapshot !== null) {
      const local = await this.#snapshot.search(query, pathPrefix, boundedLimit, signal);
      if (local !== undefined) return renderSearchResults(local.matches, local.truncated);
    }
    const result = await this.#github.searchCode(this.#job, query, pathPrefix, boundedLimit, signal);
    return renderSearchResults(result.matches, result.truncated);
  }

  async dependencySource(
    packageName: string,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<string> {
    return pinnedDependencySource({
      packageName,
      query,
      limit,
      readHeadFile: (path, readSignal) => this.#github.readFile(
        this.#job,
        path,
        this.#job.headSha,
        MAX_DEPENDENCY_LOCK_BYTES,
        readSignal,
      ),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async optionalBaseFile(path: string, signal?: AbortSignal): Promise<string> {
    try {
      return await this.#cachedFile(safePath(path), "base", signal);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof GitHubApiError && error.retryable) throw error;
      return "";
    }
  }

  async reviewPolicy(signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    let scopedPaths = scopedPolicyPaths(this.changes.files.flatMap((file) => (
      file.previousPath === undefined ? [file.path] : [file.path, file.previousPath]
    )));
    try {
      const tree = await this.#cachedTree(this.#job.baseSha, signal);
      const existing = new Set(tree.entries.filter((entry) => entry.type === "blob").map((entry) => entry.path));
      const confirmed = scopedPaths.filter((path) => existing.has(path));
      scopedPaths = tree.truncated
        ? [...confirmed, ...scopedPaths.filter((path) => !existing.has(path)).slice(0, 20)]
        : confirmed;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof GitHubApiError && error.retryable) throw error;
      scopedPaths = scopedPaths.slice(0, 20);
    }
    const paths = [...BASE_POLICY_FILES, ...scopedPaths];
    const sections = await Promise.all(paths.map(async (path) => ({
      path,
      content: (await this.optionalBaseFile(path, signal)).slice(
        0,
        (BASE_POLICY_FILES as readonly string[]).includes(path) ? 12_000 : 8_000,
      ).trim(),
    })));
    const selected: string[] = [];
    let bytes = 0;
    for (const { path, content } of sections) {
      if (!content) continue;
      const scope = path.endsWith("/AGENTS.md") ? ` (applies under ${path.slice(0, -"/AGENTS.md".length)}/)` : "";
      const section = `### ${path}${scope}\n${content}`;
      if (bytes + section.length > MAX_POLICY_BYTES) continue;
      selected.push(section);
      bytes += section.length + 2;
    }
    return selected.join("\n\n");
  }

  async #loadTree(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.#tree) return;
    const snapshotTree = await this.#snapshot?.tree();
    if (snapshotTree !== undefined) {
      this.#cacheHits++;
      this.#tree = snapshotTree.entries;
      this.#treeTruncated = snapshotTree.truncated;
      return;
    }
    const result = await this.#cachedTree(this.#job.headSha, signal);
    this.#tree = result.entries;
    this.#treeTruncated = result.truncated;
  }

  async #cachedTree(ref: string, signal?: AbortSignal): Promise<{ entries: RepositoryEntry[]; truncated: boolean }> {
    const cachePath = `${REF_CACHE_ROOT}/${ref}/tree.json`;
    if (await fileExists(this.#workspace, cachePath)) {
      this.#cacheHits++;
      const cached = JSON.parse(await this.#workspace.fs.readFile(cachePath, "utf8")) as {
        entries: RepositoryEntry[];
        truncated: boolean;
      };
      return cached;
    }
    this.#cacheMisses++;
    const result = await this.#github.getRepositoryTree(this.#job, ref, signal);
    throwIfAborted(signal);
    await this.#workspace.fs.mkdir(`${REF_CACHE_ROOT}/${ref}`, { recursive: true });
    await this.#workspace.fs.writeFile(cachePath, JSON.stringify(result));
    return result;
  }

  async #cachedFile(path: string, ref: RepositoryRef, signal?: AbortSignal): Promise<string> {
    throwIfAborted(signal);
    const sha = ref === "head" ? this.#job.headSha : this.#job.baseSha;
    if (ref === "head" && this.#snapshot !== null) {
      const snapshotContent = await this.#snapshot.read(path);
      if (snapshotContent !== undefined) {
        this.#cacheHits++;
        return snapshotContent;
      }
    }
    const cachePath = `${REF_CACHE_ROOT}/${sha}/files/${path}`;
    if (await fileExists(this.#workspace, cachePath)) {
      this.#cacheHits++;
      return this.#workspace.fs.readFile(cachePath, "utf8");
    }
    this.#cacheMisses++;
    const content = await this.#github.readFile(this.#job, path, sha, MAX_FILE_BYTES, signal);
    throwIfAborted(signal);
    const parent = cachePath.slice(0, cachePath.lastIndexOf("/"));
    await this.#workspace.fs.mkdir(parent, { recursive: true });
    await this.#workspace.fs.writeFile(cachePath, content);
    return content;
  }

  async #pruneCache(now = Date.now()): Promise<void> {
    let refs: Array<{ name: string; mtime: number }>;
    try {
      const entries = await this.#workspace.fs.readdir(REF_CACHE_ROOT, { limit: 1_000 });
      refs = (await Promise.all(entries
        .filter((entry) => entry.isDirectory)
        .map(async (entry) => ({
          name: entry.name,
          mtime: (await this.#workspace.fs.stat(`${REF_CACHE_ROOT}/${entry.name}`)).mtime,
        }))));
    } catch {
      return;
    }
    const protectedRefs = new Set([this.#job.baseSha, this.#job.headSha]);
    const newest = [...refs].sort((left, right) => right.mtime - left.mtime);
    await Promise.all(newest.map(async (entry, index) => {
      if (protectedRefs.has(entry.name)) return;
      if (index < MAX_CACHED_REFS && now - entry.mtime <= CACHE_TTL_MS) return;
      await this.#workspace.fs.rm(`${REF_CACHE_ROOT}/${entry.name}`, { recursive: true, force: true });
    }));
  }
}

/**
 * Render the immutable changed-file inventory exactly as it is exposed to a
 * review agent. Keeping this pure lets offline evaluators exercise the same
 * byte budget, pagination, and metadata contract as production.
 */
export function renderChangedFiles(
  changes: PullChangeSet,
  offset = 0,
  limit = 100,
): string {
  const boundedOffset = Math.max(0, Math.min(offset, changes.files.length));
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  const files = changes.files.slice(boundedOffset, boundedOffset + boundedLimit).map((file) => ({
    path: file.path,
    ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patchAvailable: file.patch !== null,
  }));
  return boundedChangedFilesPage(
    files,
    boundedOffset,
    boundedLimit,
    changes.files.length,
    changes.filesTruncated ?? false,
  );
}

/** Add trustworthy changed-source coordinates without modifying source text. */
export function annotateChangedSourceCoordinates(diff: string): string {
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;

  return diff.split("\n").map((line) => {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = true;
      return line;
    }
    if (!inHunk) return line;

    let annotated = line;
    if (line.startsWith("+")) {
      annotated = `[RIGHT:${newLine}] ${line}`;
      newLine++;
      newRemaining--;
    } else if (line.startsWith("-")) {
      annotated = `[LEFT:${oldLine}] ${line}`;
      oldLine++;
      oldRemaining--;
    } else if (line.startsWith(" ")) {
      oldLine++;
      newLine++;
      oldRemaining--;
      newRemaining--;
    }

    if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
    return annotated;
  }).join("\n");
}

interface SearchResultMatch {
  path: string;
  fragment: string;
  line?: number;
}

/**
 * Keep code-search discovery transport valid and path-preserving under the
 * tool byte cap. Search snippets are hints; exact proof still comes from an
 * immutable read_file or changed-patch tool call.
 */
export function renderSearchResults(
  matches: readonly SearchResultMatch[],
  sourceTruncated: boolean,
): string {
  const note = "Code search is a discovery index; use read_file with ref=head to verify current behavior.";
  const normalized = matches.slice(0, 20).map((match) => ({
    path: match.path,
    ...(match.line === undefined ? {} : { line: match.line }),
    fragment: match.fragment,
  }));
  const render = (
    selected: typeof normalized,
    fragmentLimit: number,
    transportTruncated = false,
  ): string => JSON.stringify({
    matches: selected.map((match) => ({
      path: match.path,
      ...(match.line === undefined ? {} : { line: match.line }),
      ...(fragmentLimit === 0 ? {} : {
        fragment: truncateEndBytes(match.fragment, fragmentLimit),
      }),
    })),
    returned: selected.length,
    totalReturnedBySource: normalized.length,
    truncated: sourceTruncated || transportTruncated,
    ...(fragmentLimit < Math.max(0, ...selected.map((match) => match.fragment.length))
      ? { fragmentsClipped: true }
      : {}),
    ...(transportTruncated ? { transportTruncated: true } : {}),
    note,
  });

  for (const fragmentLimit of [800, 400, 200, 100, 0]) {
    const candidate = render(normalized, fragmentLimit);
    if (byteLength(candidate) <= MAX_TOOL_RESULT_BYTES) return candidate;
  }

  // Pathological path lengths can still exceed the cap after dropping every
  // snippet. Return the largest valid prefix rather than corrupting JSON.
  let low = 0;
  let high = normalized.length;
  let fitted = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(normalized.slice(0, middle), 0, true);
    if (byteLength(candidate) <= MAX_TOOL_RESULT_BYTES) {
      fitted = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return render(normalized.slice(0, fitted), 0, true);
}

function truncateEndBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  const marker = "…";
  const markerBytes = byteLength(marker);
  return `${new TextDecoder().decode(encoded.slice(0, Math.max(0, maxBytes - markerBytes)))}${marker}`;
}

/**
 * Render one changed patch exactly as it is exposed to a review agent.
 * Consumers outside RepositoryWorkspace must use this function rather than
 * copying its coordinate and transport semantics.
 */
export function renderDiffForFile(
  changes: PullChangeSet,
  path: string,
  patchStartLine?: number,
  patchEndLine?: number,
  sourceLine?: number,
  sourceSide: "LEFT" | "RIGHT" = "RIGHT",
): string {
  const normalized = safePath(path);
  const file = changes.files.find((entry) => entry.path === normalized)
    ?? changes.files.find((entry) => entry.previousPath === normalized);
  if (!file) throw new Error("path is not changed by this pull request");
  if (!file.patch) {
    return JSON.stringify({
      path: file.path,
      patch: null,
      reason: "GitHub omitted this binary or oversized patch",
    });
  }

  const lines = file.patch.split("\n");
  let requestedSourceLine = sourceLine === undefined ? undefined : Math.trunc(sourceLine);
  let sourcePatchLine = requestedSourceLine === undefined
    ? undefined
    : patchLineForSourceLine(lines, requestedSourceLine, sourceSide);
  const requestedPatchStartLine = patchStartLine === undefined ? undefined : Math.trunc(patchStartLine);
  if (requestedSourceLine === undefined && requestedPatchStartLine !== undefined && requestedPatchStartLine > lines.length) {
    throw new InvalidToolArgumentsError(
      `patch_start_line ${requestedPatchStartLine} exceeds this file's ${lines.length} patch lines; use patch_start_line 1-${lines.length}, or call diff_for_source_line with source_line and side`,
    );
  }
  if (requestedSourceLine !== undefined && sourcePatchLine === undefined) {
    throw new InvalidToolArgumentsError(
      `${sourceSide} source line ${requestedSourceLine} is not present in this file's changed patch`,
    );
  }
  const explicitlyRanged = patchStartLine !== undefined || patchEndLine !== undefined || sourcePatchLine !== undefined;
  const sourceWindowStart = sourcePatchLine === undefined ? undefined : Math.max(1, sourcePatchLine - 100);
  const sourceWindowEnd = sourcePatchLine === undefined ? undefined : Math.min(lines.length, sourcePatchLine + 99);
  const startLine = Math.max(1, Math.min(Math.trunc(sourceWindowStart ?? patchStartLine ?? 1), lines.length));
  const endLine = Math.max(
    startLine,
    Math.min(
      Math.trunc(sourceWindowEnd ?? patchEndLine ?? startLine + DEFAULT_PATCH_LINES - 1),
      startLine + MAX_EXPLICIT_PATCH_LINES - 1,
      lines.length,
    ),
  );
  const render = (
    boundedStartLine: number,
    boundedEndLine: number,
    patch: string,
    patchContentTruncated = false,
  ): string => JSON.stringify({
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status,
      patchStartLine: boundedStartLine,
      patchEndLine: boundedEndLine,
      totalPatchLines: lines.length,
      ...(requestedSourceLine === undefined ? {} : {
        requestedSourceLine,
        requestedSourceSide: sourceSide,
        sourcePatchLine,
      }),
      patch,
      truncated: patchContentTruncated || (!explicitlyRanged && boundedEndLine < lines.length),
      ...(patchContentTruncated ? { patchContentTruncated: true } : {}),
      hasMoreBefore: boundedStartLine > 1,
      hasMoreAfter: boundedEndLine < lines.length,
      ...(boundedEndLine < lines.length
        ? {
            nextPatchStartLine: boundedEndLine + 1,
            nextPatchEndLine: Math.min(lines.length, boundedEndLine + MAX_EXPLICIT_PATCH_LINES),
          }
        : {}),
    });

  if (sourcePatchLine !== undefined) {
    return boundedSourcePatchResult(lines, sourcePatchLine, startLine, endLine, render);
  }
  return boundedPatchPrefixResult(lines, startLine, endLine, render);
}

function scopedPolicyPaths(changedPaths: string[]): string[] {
  const result = new Set<string>();
  for (const changedPath of changedPaths) {
    const parts = changedPath.split("/").slice(0, -1);
    for (let depth = parts.length; depth > 0; depth--) {
      result.add(`${parts.slice(0, depth).join("/")}/AGENTS.md`);
    }
  }
  return [...result]
    .sort((a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b))
    .slice(0, 80);
}

interface ChangedFilesPageEntry {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patchAvailable: boolean;
}

function boundedChangedFilesPage(
  files: ChangedFilesPageEntry[],
  offset: number,
  requested: number,
  total: number,
  listingTruncated: boolean,
): string {
  const render = (
    pageFiles: unknown[],
    compact = false,
    adaptivePage = false,
  ): string => {
    const end = offset + pageFiles.length;
    return JSON.stringify({
      files: pageFiles,
      offset,
      requested,
      returned: pageFiles.length,
      total,
      hasMore: end < total,
      ...(end < total ? { nextOffset: end } : {}),
      listingTruncated,
      ...(compact ? { compact: true } : {}),
      ...(adaptivePage ? { adaptivePage: true, truncated: true } : {}),
    });
  };

  const rich = render(files);
  if (byteLength(rich) <= MAX_TOOL_RESULT_BYTES) return rich;

  // The inventory's durable contract is the exact path and patch
  // availability. Drop prioritization hints before reducing the page size so
  // the common 100-path offsets remain usable whenever possible.
  const compactFiles = files.map((file) => ({
    path: file.path,
    ...(file.patchAvailable ? {} : { patchAvailable: false }),
  }));
  const compact = render(compactFiles, true);
  if (byteLength(compact) <= MAX_TOOL_RESULT_BYTES) return compact;

  // A repository may contain unusually long paths. Return the largest valid
  // prefix and advance nextOffset by exactly that prefix, rather than
  // transport-truncating JSON and making every path in the page unusable.
  let low = 1;
  let high = compactFiles.length;
  let fitted = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(compactFiles.slice(0, middle), true, true);
    if (byteLength(candidate) <= MAX_TOOL_RESULT_BYTES) {
      fitted = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (fitted > 0) return render(compactFiles.slice(0, fitted), true, true);

  // GitHub paths are far below this threshold in practice. Keep a valid,
  // parseable, explicitly incomplete response if an upstream fixture violates
  // that contract; never skip an exact path merely to advance pagination.
  return JSON.stringify({
    files: [],
    offset,
    requested,
    returned: 0,
    total,
    hasMore: offset < total,
    listingTruncated,
    compact: true,
    adaptivePage: true,
    truncated: true,
    reason: "The next changed path exceeds the tool result budget",
  });
}

function boundedSourcePatchResult(
  lines: string[],
  sourcePatchLine: number,
  initialStartLine: number,
  initialEndLine: number,
  render: (
    startLine: number,
    endLine: number,
    patch: string,
    patchContentTruncated?: boolean,
  ) => string,
): string {
  const renderWindow = (startLine: number, endLine: number): string => render(
    startLine,
    endLine,
    lines.slice(startLine - 1, endLine).join("\n"),
  );
  const result = renderWindow(initialStartLine, initialEndLine);
  if (byteLength(result) <= MAX_TOOL_RESULT_BYTES) return result;

  // Keep the largest contiguous, target-centered window that fits. The line
  // count has monotonic encoded size, so binary search avoids repeatedly
  // serializing a potentially multi-megabyte generated patch.
  const leftAvailable = sourcePatchLine - initialStartLine;
  const rightAvailable = initialEndLine - sourcePatchLine;
  const windowForCount = (count: number): { startLine: number; endLine: number } => {
    const surrounding = Math.max(0, count - 1);
    let left = Math.min(leftAvailable, Math.ceil(surrounding / 2));
    let right = Math.min(rightAvailable, surrounding - left);
    left += Math.min(leftAvailable - left, surrounding - left - right);
    right += Math.min(rightAvailable - right, surrounding - left - right);
    return { startLine: sourcePatchLine - left, endLine: sourcePatchLine + right };
  };
  let lowCount = 1;
  let highCount = initialEndLine - initialStartLine + 1;
  let fittedWindow: { startLine: number; endLine: number; result: string } | undefined;
  while (lowCount <= highCount) {
    const count = Math.floor((lowCount + highCount) / 2);
    const window = windowForCount(count);
    const candidate = renderWindow(window.startLine, window.endLine);
    if (byteLength(candidate) <= MAX_TOOL_RESULT_BYTES) {
      fittedWindow = { ...window, result: candidate };
      lowCount = count + 1;
    } else {
      highCount = count - 1;
    }
  }
  if (fittedWindow) return fittedWindow.result;

  // One pathological source line can itself exceed the transport budget. It
  // still remains identifiable in valid JSON, but mark the evidence truncated
  // so the reviewer cannot treat the clipped text as complete proof.
  const source = Array.from(lines[sourcePatchLine - 1] ?? "");
  const marker = " [... Gaston truncated this oversized target patch line ...] ";
  let low = 0;
  let high = source.length;
  let fitted = marker;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const head = Math.ceil(middle * 0.7);
    const tail = middle - head;
    const clipped = `${source.slice(0, head).join("")}${marker}${tail === 0 ? "" : source.slice(-tail).join("")}`;
    const candidate = render(sourcePatchLine, sourcePatchLine, clipped, true);
    if (byteLength(candidate) <= MAX_TOOL_RESULT_BYTES) {
      fitted = clipped;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return render(sourcePatchLine, sourcePatchLine, fitted, true);
}

function boundedPatchPrefixResult(
  lines: string[],
  initialStartLine: number,
  initialEndLine: number,
  render: (
    startLine: number,
    endLine: number,
    patch: string,
    patchContentTruncated?: boolean,
  ) => string,
): string {
  const renderRange = (endLine: number): string => render(
    initialStartLine,
    endLine,
    lines.slice(initialStartLine - 1, endLine).join("\n"),
  );
  const result = renderRange(initialEndLine);
  if (byteLength(result) <= MAX_TOOL_RESULT_BYTES) return result;

  // The line count has monotonic encoded size, so retain the largest exact
  // contiguous prefix of the requested interval that fits. Metadata reflects
  // the bytes actually returned and advertises the immediately following
  // interval, which lets the evidence tracker union retries without gaps.
  let lowEndLine = initialStartLine;
  let highEndLine = initialEndLine;
  let fitted: { endLine: number; result: string } | undefined;
  while (lowEndLine <= highEndLine) {
    const endLine = Math.floor((lowEndLine + highEndLine) / 2);
    const candidate = renderRange(endLine);
    if (byteLength(candidate) <= MAX_TOOL_RESULT_BYTES) {
      fitted = { endLine, result: candidate };
      lowEndLine = endLine + 1;
    } else {
      highEndLine = endLine - 1;
    }
  }
  if (fitted) return fitted.result;

  // A single pathological line cannot be represented exactly within the
  // transport budget. Preserve valid JSON and enough head/tail text to
  // identify it, but explicitly withhold exact interval credit.
  const source = Array.from(lines[initialStartLine - 1] ?? "");
  const marker = " [... Gaston truncated this oversized patch line ...] ";
  let low = 0;
  let high = source.length;
  let clippedLine = marker;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const head = Math.ceil(count * 0.7);
    const tail = count - head;
    const clipped = `${source.slice(0, head).join("")}${marker}${tail === 0 ? "" : source.slice(-tail).join("")}`;
    const candidate = render(initialStartLine, initialStartLine, clipped, true);
    if (byteLength(candidate) <= MAX_TOOL_RESULT_BYTES) {
      clippedLine = clipped;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return render(initialStartLine, initialStartLine, clippedLine, true);
}

export class RepositoryTools {
  readonly #repo: RepositoryWorkspace;
  readonly #results = new Map<string, Promise<EvidenceResult>>();
  readonly #coverage: EvidenceCoverageTracker;

  constructor(repo: RepositoryWorkspace) {
    this.#repo = repo;
    const totalChangedFiles = repo.changes?.files.length ?? 0;
    const filesTruncated = repo.changes?.filesTruncated
      ?? Boolean(repo.changes?.truncated && totalChangedFiles >= 300);
    const diffTruncated = repo.changes?.diffTruncated ?? repo.changes?.truncated;
    this.#coverage = new EvidenceCoverageTracker({
      totalChangedFiles,
      initialDiffTruncated: Boolean(
        diffTruncated
        || filesTruncated
        || byteLength(annotateChangedSourceCoordinates(repo.changes?.diff ?? "")) > INITIAL_DIFF_EXCERPT_BYTES,
      ),
      changedFileListingTruncated: filesTruncated,
      unavailablePatchPaths: repo.changes?.unavailablePatchPaths
        ?? repo.changes?.files.filter((file) => file.patch === null).map((file) => file.path)
        ?? [],
    });
  }

  coverage(): EvidenceCoverage {
    return this.#coverage.snapshot();
  }

  async invoke(name: string, rawArguments: string, signal?: AbortSignal): Promise<EvidenceResult> {
    throwIfAborted(signal);
    const key = `${name}:${canonicalArguments(rawArguments)}`;
    const current = this.#results.get(key);
    if (current) return current;
    const result = this.#invoke(name, rawArguments, signal);
    this.#results.set(key, result);
    return result;
  }

  async #invoke(name: string, rawArguments: string, signal?: AbortSignal): Promise<EvidenceResult> {
    let args: Record<string, unknown> | undefined;
    try {
      throwIfAborted(signal);
      args = parseArguments(rawArguments);
      validateToolArguments(name, args);
      let content: string;
      switch (name) {
        case "changed_files":
          content = this.#repo.changedFiles(
            integerArgument(args.offset, "offset", 0, 2_999, 0),
            integerArgument(args.limit, "limit", 1, 100, 100),
          );
          break;
        case "diff_for_file":
          content = this.#repo.diffForFile(
            requiredString(args.path, "path"),
            optionalIntegerArgument(args.patch_start_line, "patch_start_line", 1),
            optionalIntegerArgument(args.patch_end_line, "patch_end_line", 1),
          );
          break;
        case "diff_for_source_line":
          content = this.#repo.diffForSourceLine(
            requiredString(args.path, "path"),
            integerArgument(args.source_line, "source_line", 1, Number.MAX_SAFE_INTEGER, 1),
            args.side === "LEFT" ? "LEFT" : "RIGHT",
          );
          break;
        case "repository_tree":
          content = await this.#repo.tree(
            optionalString(args.prefix) ?? "",
            integerArgument(args.limit, "limit", 1, 500, 200),
            signal,
          );
          break;
        case "read_file":
          content = await this.#repo.read(
            requiredString(args.path, "path"),
            args.ref === "base" ? "base" : "head",
            integerArgument(args.start_line, "start_line", 1, Number.MAX_SAFE_INTEGER, 1),
            integerArgument(args.end_line, "end_line", 1, Number.MAX_SAFE_INTEGER, 300),
            signal,
          );
          break;
        case "search_code":
          content = await this.#repo.search(
            requiredString(args.query, "query"),
            optionalString(args.path_prefix),
            integerArgument(args.limit, "limit", 1, 20, 10),
            signal,
          );
          break;
        case "dependency_source":
          content = await this.#repo.dependencySource(
            requiredString(args.package, "package"),
            requiredString(args.query, "query"),
            integerArgument(args.limit, "limit", 1, 20, 10),
            signal,
          );
          break;
        default:
          throw new Error(`unknown tool: ${name}`);
      }
      throwIfAborted(signal);
      const evidenceTool = canonicalEvidenceTool(name);
      const evidenceArgs = canonicalEvidenceArguments(name, args) ?? {};
      const inferred = inferEvidence(evidenceTool, evidenceArgs, content);
      // Structured patch and changed-file responses enforce their own valid
      // JSON byte limits. Generic middle truncation is intentionally reserved
      // for prose-oriented tools whose contract is not JSON continuation.
      const bounded = evidenceTool === "diff_for_file" || name === "changed_files" || name === "search_code"
        ? { content, truncated: false }
        : truncateToolResult(content, MAX_TOOL_RESULT_BYTES);
      const inferredEvidence = inferred.evidence ?? {
        scope: evidenceScope(evidenceTool, evidenceArgs),
        complete: true,
      };
      const result: EvidenceResult = bounded.truncated
        ? {
            status: "truncated",
            content: bounded.content,
            retryable: false,
            evidence: {
              ...inferredEvidence,
              complete: false,
              ...(inferredEvidence.patchIntervalComplete === undefined
                ? {}
                : { patchIntervalComplete: false }),
            },
            suggestedAction: inferred.suggestedAction
              ?? "Request a narrower line range or more specific query once.",
          }
        : { ...inferred, content: bounded.content };
      this.#coverage.record(evidenceTool, result, changedPath(evidenceTool, content));
      return result;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof GitHubApiError && error.retryable) throw error;
      const invalid = error instanceof InvalidToolArgumentsError || error instanceof SyntaxError;
      const evidenceTool = canonicalEvidenceTool(name);
      const evidenceArgs = canonicalEvidenceArguments(name, args);
      const result: EvidenceResult = {
        status: invalid ? "invalid_arguments" : "permanent_error",
        content: error instanceof Error ? error.message : String(error),
        retryable: false,
        errorCode: invalid ? "invalid_tool_arguments" : errorCode(error),
        evidence: {
          scope: evidenceScope(evidenceTool, evidenceArgs),
          complete: false,
          ...evidenceIdentity(evidenceTool, evidenceArgs),
        },
        suggestedAction: invalid
          ? "Correct the arguments to match the tool schema and retry once."
          : "Treat this evidence source as unavailable; do not infer a clean result from it.",
        isError: true,
      };
      this.#coverage.record(
        evidenceTool,
        result,
        result.evidence?.changedPath,
      );
      return result;
    }
  }
}

function canonicalEvidenceTool(name: string): string {
  return name === "diff_for_source_line" ? "diff_for_file" : name;
}

function canonicalEvidenceArguments(
  name: string,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (args === undefined || name !== "diff_for_file") return args;
  return {
    ...(args.path === undefined ? {} : { path: args.path }),
    ...(args.patch_start_line === undefined ? {} : { patch_start_line: args.patch_start_line }),
    ...(args.patch_end_line === undefined ? {} : { patch_end_line: args.patch_end_line }),
  };
}

function truncateToolResult(content: string, maxBytes: number): { content: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(content);
  if (encoded.byteLength <= maxBytes) return { content, truncated: false };
  const marker = "\n\n[... Gaston truncated this tool result; use a narrower line range or query for complete evidence ...]\n\n";
  const markerBytes = new TextEncoder().encode(marker).byteLength;
  const available = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.ceil(available * 0.7);
  const tailBytes = available - headBytes;
  const decoder = new TextDecoder();
  const tail = tailBytes === 0 ? "" : decoder.decode(encoded.slice(-tailBytes));
  return { content: `${decoder.decode(encoded.slice(0, headBytes))}${marker}${tail}`, truncated: true };
}

function inferEvidence(name: string, args: Record<string, unknown>, content: string): EvidenceResult {
  const parsed = parseRecord(content);
  const sourceTargeted = name === "diff_for_file" && optionalInteger(args.source_line) !== undefined;
  const sourceTruncated = parsed?.truncated === true
    || parsed?.listingTruncated === true
    || (name === "diff_for_file" && !sourceTargeted && (parsed?.hasMoreBefore === true || parsed?.hasMoreAfter === true))
    || (name === "diff_for_file" && parsed?.patch === null);
  const evidence = {
    scope: evidenceScope(name, args, parsed),
    complete: !sourceTruncated,
    ...(name === "search_code" ? { advisory: true } : {}),
    ...numericCoverage(parsed),
    ...(name === "changed_files" && parsed?.adaptivePage === true
      ? { returnedRangeComplete: true }
      : {}),
    ...evidenceIdentity(name, args, parsed),
    ...patchIntervalEvidence(name, parsed, sourceTargeted),
  };
  if (sourceTruncated) {
    return {
      status: "truncated",
      content,
      retryable: false,
      evidence,
      suggestedAction: name === "diff_for_file"
        ? diffRecoveryAction(args, parsed)
        : name === "changed_files" && parsed?.listingTruncated === true
          ? "GitHub capped the cumulative changed-file inventory at 3,000 paths; report coverage as incomplete."
          : name === "changed_files" && parsed?.adaptivePage === true
            ? changedFilesRecoveryAction(parsed)
        : "Use a narrower prefix, range, or limit once to recover complete evidence.",
    };
  }
  return { status: "ok", content, retryable: false, evidence };
}

function parseRecord(content: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(content) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function numericCoverage(value: Record<string, unknown> | undefined): Pick<NonNullable<EvidenceResult["evidence"]>, "offset" | "requested" | "returned" | "total"> {
  const offset = typeof value?.offset === "number" ? value.offset : undefined;
  const requested = typeof value?.requested === "number" ? value.requested : undefined;
  const returned = typeof value?.returned === "number"
    ? value.returned
    : Array.isArray(value?.entries)
      ? value.entries.length
      : Array.isArray(value?.files)
        ? value.files.length
        : undefined;
  const total = typeof value?.total === "number" ? value.total : undefined;
  return {
    ...(offset === undefined ? {} : { offset }),
    ...(requested === undefined ? {} : { requested }),
    ...(returned === undefined ? {} : { returned }),
    ...(total === undefined ? {} : { total }),
  };
}

function evidenceScope(
  name: string,
  args: Record<string, unknown> | undefined,
  result?: Record<string, unknown>,
): string {
  const requestedPath = typeof args?.path === "string" ? args.path.trim() : "";
  const path = name === "diff_for_file" && typeof result?.path === "string"
    ? result.path.trim()
    : requestedPath;
  const ref = args?.ref === "base" ? "base" : "head";
  if (name === "diff_for_file") {
    const start = optionalInteger(args?.patch_start_line);
    const end = optionalInteger(args?.patch_end_line);
    const sourceLine = optionalInteger(args?.source_line);
    if (sourceLine !== undefined) {
      const side = result?.requestedSourceSide === "LEFT" || args?.side === "LEFT" ? "LEFT" : "RIGHT";
      return `${name}:${path}:source:${side}:${sourceLine}`;
    }
    return start === undefined && end === undefined
      ? `${name}:${path}`
      : `${name}:${path}:${start ?? 1}-${end ?? "default"}`;
  }
  if (name === "read_file") {
    const start = optionalInteger(result?.startLine) ?? optionalInteger(args?.start_line) ?? 1;
    const end = optionalInteger(result?.endLine) ?? optionalInteger(args?.end_line) ?? 300;
    return `${name}:${ref}:${path}:${start}-${end}`;
  }
  if (name === "changed_files") {
    return `${name}:${optionalInteger(args?.offset) ?? 0}:${optionalInteger(args?.limit) ?? 100}`;
  }
  if (name === "repository_tree") return `${name}:${typeof args?.prefix === "string" ? args.prefix.trim() : ""}`;
  if (name === "search_code") {
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    const prefix = typeof args?.path_prefix === "string"
      ? args.path_prefix.trim().replace(/\/$/, "")
      : "";
    const limit = Math.max(1, Math.min(optionalInteger(args?.limit) ?? 10, 20));
    return `${name}:${query}:path=${prefix}:limit=${limit}`;
  }
  if (name === "dependency_source") {
    const packageName = typeof args?.package === "string" ? args.package.trim() : "";
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    return `${name}:${packageName}:${query}`;
  }
  return name;
}

function evidenceIdentity(
  name: string,
  args: Record<string, unknown> | undefined,
  result?: Record<string, unknown>,
): Partial<NonNullable<EvidenceResult["evidence"]>> {
  if (name !== "diff_for_file") return {};
  const requestedPath = typeof args?.path === "string" ? args.path.trim().replace(/^\.\//, "").replace(/^\/+/, "") : "";
  const changedPath = typeof result?.path === "string" ? result.path.trim() : requestedPath;
  const sourceLine = optionalInteger(args?.source_line);
  const sourceTargeted = sourceLine !== undefined;
  const sourceSide = result?.requestedSourceSide === "LEFT" || args?.side === "LEFT" ? "LEFT" : "RIGHT";
  return {
    ...(changedPath ? { changedPath } : {}),
    sourceTargeted,
    ...(sourceTargeted ? { sourceLine, sourceSide } : {}),
    ...(sourceTargeted && (requestedPath || changedPath)
      ? { resolutionScope: `${name}:${requestedPath || changedPath}:source:${sourceSide}:${sourceLine}` }
      : {}),
  };
}

function patchIntervalEvidence(
  name: string,
  parsed: Record<string, unknown> | undefined,
  sourceTargeted: boolean,
): Partial<NonNullable<EvidenceResult["evidence"]>> {
  if (name !== "diff_for_file" || parsed?.patch === null) return {};
  const patchStartLine = optionalInteger(parsed?.patchStartLine);
  const patchEndLine = optionalInteger(parsed?.patchEndLine);
  const totalPatchLines = optionalInteger(parsed?.totalPatchLines);
  const nextPatchStartLine = optionalInteger(parsed?.nextPatchStartLine);
  const nextPatchEndLine = optionalInteger(parsed?.nextPatchEndLine);
  if (
    patchStartLine === undefined
    || patchEndLine === undefined
    || totalPatchLines === undefined
  ) return {};
  return {
    patchStartLine,
    patchEndLine,
    totalPatchLines,
    patchIntervalComplete: parsed?.patchContentTruncated !== true,
    sourceTargeted,
    ...(nextPatchStartLine === undefined || nextPatchEndLine === undefined
      ? {}
      : { nextPatchStartLine, nextPatchEndLine }),
  };
}

function changedPath(name: string, content: string): string | undefined {
  if (name !== "diff_for_file") return undefined;
  const parsed = parseRecord(content);
  return typeof parsed?.path === "string" ? parsed.path.trim() : undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof GitHubApiError) return `github_${error.status}`;
  return error instanceof Error ? error.name.toLowerCase() : "unknown_error";
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("review aborted");
}

function canonicalArguments(raw: string): string {
  try {
    return JSON.stringify(sortJson(JSON.parse(raw || "{}") as unknown));
  } catch {
    return raw.trim();
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, sortJson(entry)]));
}

function safePath(value: string): string {
  const path = value.trim().replace(/^\.\//, "").replace(/^\/+/, "");
  if (
    !path ||
    path.length > 1_000 ||
    /[\x00-\x1f\x7f\\]/.test(path) ||
    path.split("/").includes("..")
  ) {
    throw new Error("invalid repository-relative path");
  }
  return path;
}

function parseArguments(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw || "{}");
  } catch (error) {
    throw new InvalidToolArgumentsError(error instanceof Error ? error.message : "tool arguments are not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidToolArgumentsError("tool arguments must be an object");
  return value as Record<string, unknown>;
}

const TOOL_ARGUMENT_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  changed_files: new Set(["offset", "limit"]),
  diff_for_file: new Set(["path", "patch_start_line", "patch_end_line"]),
  diff_for_source_line: new Set(["path", "source_line", "side"]),
  repository_tree: new Set(["prefix", "limit"]),
  read_file: new Set(["path", "ref", "start_line", "end_line"]),
  search_code: new Set(["query", "path_prefix", "limit"]),
  dependency_source: new Set(["package", "query", "limit"]),
};

function validateToolArguments(name: string, args: Record<string, unknown>): void {
  const allowed = TOOL_ARGUMENT_KEYS[name];
  if (allowed === undefined) throw new InvalidToolArgumentsError(`unknown tool: ${name}`);
  const unknown = Object.keys(args).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new InvalidToolArgumentsError(`unexpected tool argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
  }
  switch (name) {
    case "diff_for_source_line":
      if (args.side !== undefined && args.side !== "LEFT" && args.side !== "RIGHT") {
        throw new InvalidToolArgumentsError("side must be LEFT or RIGHT");
      }
      if (args.source_line === undefined) {
        throw new InvalidToolArgumentsError("source_line is required");
      }
      if (args.side === undefined) {
        throw new InvalidToolArgumentsError("side is required");
      }
      break;
    case "repository_tree":
      optionalStringArgument(args.prefix, "prefix");
      break;
    case "read_file":
      if (args.ref !== "head" && args.ref !== "base") {
        throw new InvalidToolArgumentsError("ref must be head or base");
      }
      if (args.start_line === undefined) throw new InvalidToolArgumentsError("start_line is required");
      if (args.end_line === undefined) throw new InvalidToolArgumentsError("end_line is required");
      break;
    case "search_code":
      optionalStringArgument(args.path_prefix, "path_prefix");
      break;
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new InvalidToolArgumentsError(`${name} must be a non-empty string`);
  return value.trim();
}

class InvalidToolArgumentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidToolArgumentsError";
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringArgument(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new InvalidToolArgumentsError(`${name} must be a string`);
  }
}

function integerArgument(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  const parsed = optionalIntegerArgument(value, name, minimum, maximum);
  if (parsed === undefined) throw new InvalidToolArgumentsError(`${name} is required`);
  return parsed;
}

function optionalIntegerArgument(
  value: unknown,
  name: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    const range = maximum === Number.MAX_SAFE_INTEGER
      ? `an integer greater than or equal to ${minimum}`
      : `an integer from ${minimum} through ${maximum}`;
    throw new InvalidToolArgumentsError(`${name} must be ${range}`);
  }
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function diffRecoveryAction(
  args: Record<string, unknown>,
  parsed: Record<string, unknown> | undefined,
): string {
  const path = typeof args.path === "string" ? args.path.trim() : "the changed file";
  const nextStart = optionalInteger(parsed?.nextPatchStartLine);
  const nextEnd = optionalInteger(parsed?.nextPatchEndLine);
  if (nextStart !== undefined) {
    const total = optionalInteger(parsed?.totalPatchLines);
    const boundedEnd = Math.min(
      total ?? Number.MAX_SAFE_INTEGER,
      nextEnd ?? nextStart + MAX_EXPLICIT_PATCH_LINES - 1,
    );
    return `Call diff_for_file again for ${path} with one-based inclusive patch_start_line ${nextStart} and patch_end_line ${boundedEnd}.`;
  }
  return "Read the exact head/base file around the visible changed hunk lines before deciding.";
}

function changedFilesRecoveryAction(parsed: Record<string, unknown>): string {
  const nextOffset = optionalInteger(parsed.nextOffset);
  return nextOffset === undefined
    ? "Retry changed_files with a smaller limit; keep inventory coverage incomplete until every requested offset is returned."
    : `Continue changed_files at offset ${nextOffset}; keep inventory coverage incomplete until every skipped offset is returned.`;
}

function patchLineForSourceLine(
  patchLines: string[],
  target: number,
  side: "LEFT" | "RIGHT",
): number | undefined {
  if (target < 1) return undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (let index = 0; index < patchLines.length; index++) {
    const line = patchLines[index]!;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      if (side === "RIGHT" && newLine === target) return index + 1;
      newLine++;
    } else if (line.startsWith("-")) {
      if (side === "LEFT" && oldLine === target) return index + 1;
      oldLine++;
    } else if (line.startsWith(" ")) {
      if ((side === "RIGHT" ? newLine : oldLine) === target) return index + 1;
      oldLine++;
      newLine++;
    }
  }
  return undefined;
}

async function fileExists(workspace: WorkspaceClient, path: string): Promise<boolean> {
  try {
    await workspace.fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
