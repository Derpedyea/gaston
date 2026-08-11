import type { WorkspaceClient } from "@cloudflare/computer";

import { EvidenceCoverageTracker, type EvidenceCoverage, type EvidenceResult } from "./evidence.ts";
import { GitHubApiError, type GitHubClient } from "./github.ts";
import type {
  PullChangeSet,
  RepositoryEntry,
  RepositoryRef,
  ReviewJob,
} from "./types.ts";

const ROOT = "/gaston";
const RUN_ROOT = `${ROOT}/run`;
const REF_CACHE_ROOT = `${ROOT}/cache/refs`;
const MAX_FILE_BYTES = 400_000;
const MAX_TOOL_RESULT_BYTES = 12_000;
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

export class RepositoryWorkspace {
  readonly #workspace: WorkspaceClient;
  readonly #github: GitHubClient;
  readonly #job: ReviewJob;
  readonly changes: PullChangeSet;
  #tree: RepositoryEntry[] | null = null;
  #treeTruncated = false;
  #cacheHits = 0;
  #cacheMisses = 0;

  constructor(workspace: WorkspaceClient, github: GitHubClient, job: ReviewJob, changes: PullChangeSet) {
    this.#workspace = workspace;
    this.#github = github;
    this.#job = job;
    this.changes = changes;
  }

  async initialize(checks: Array<Record<string, unknown>>): Promise<void> {
    await this.#workspace.fs.rm(RUN_ROOT, { recursive: true, force: true });
    await this.#workspace.fs.mkdir(`${RUN_ROOT}/context`, { recursive: true });
    await this.#workspace.fs.mkdir(REF_CACHE_ROOT, { recursive: true });
    await this.#pruneCache();
    await Promise.all([
      this.#workspace.fs.writeFile(`${RUN_ROOT}/context/pr.json`, JSON.stringify(this.#job, null, 2)),
      this.#workspace.fs.writeFile(`${RUN_ROOT}/context/checks.json`, JSON.stringify(checks, null, 2)),
      this.#workspace.fs.writeFile(`${RUN_ROOT}/context/diff.patch`, this.changes.diff),
      this.#workspace.fs.writeFile(`${RUN_ROOT}/context/files.json`, JSON.stringify(this.changes.files, null, 2)),
    ]);
  }

  cacheSnapshot(): RepositoryCacheSnapshot {
    const requests = this.#cacheHits + this.#cacheMisses;
    return {
      hits: this.#cacheHits,
      misses: this.#cacheMisses,
      hitRate: requests === 0 ? 0 : Number((this.#cacheHits / requests).toFixed(4)),
    };
  }

  changedFiles(limit = 300): string {
    const files = this.changes.files.slice(0, limit).map((file) => ({
      path: file.path,
      ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patchAvailable: file.patch !== null,
    }));
    return JSON.stringify({ files, truncated: this.changes.truncated || this.changes.files.length > limit });
  }

  diffForFile(path: string): string {
    const normalized = safePath(path);
    const file = this.changes.files.find((entry) => entry.path === normalized || entry.previousPath === normalized);
    if (!file) throw new Error("path is not changed by this pull request");
    if (!file.patch) return JSON.stringify({ path: file.path, patch: null, reason: "GitHub omitted this binary or oversized patch" });
    return JSON.stringify({
      path: file.path,
      previousPath: file.previousPath ?? null,
      status: file.status,
      patch: file.patch.slice(0, 120_000),
      truncated: file.patch.length > 120_000,
    });
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
    const matches = await this.#github.searchCode(this.#job, query, pathPrefix, boundedLimit, signal);
    return JSON.stringify({
      matches,
      note: "GitHub code search is a discovery index; use read_file with ref=head to verify current PR behavior.",
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

export class RepositoryTools {
  readonly #repo: RepositoryWorkspace;
  readonly #results = new Map<string, Promise<EvidenceResult>>();
  readonly #coverage: EvidenceCoverageTracker;

  constructor(repo: RepositoryWorkspace) {
    this.#repo = repo;
    this.#coverage = new EvidenceCoverageTracker({
      totalChangedFiles: repo.changes?.files.length ?? 0,
      initialDiffTruncated: Boolean(
        repo.changes?.truncated
        || (repo.changes?.files.length ?? 0) > 300
        || byteLength(repo.changes?.diff ?? "") > 40_000,
      ),
    });
  }

  coverage(): EvidenceCoverage {
    return this.#coverage.snapshot();
  }

  recordHarnessResult(name: string, result: EvidenceResult): void {
    this.#coverage.record(name, result);
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
      let content: string;
      switch (name) {
        case "changed_files":
          content = this.#repo.changedFiles(integer(args.limit, 300));
          break;
        case "diff_for_file":
          content = this.#repo.diffForFile(requiredString(args.path, "path"));
          break;
        case "repository_tree":
          content = await this.#repo.tree(optionalString(args.prefix) ?? "", integer(args.limit, 200), signal);
          break;
        case "read_file":
          content = await this.#repo.read(
            requiredString(args.path, "path"),
            args.ref === "base" ? "base" : "head",
            integer(args.start_line, 1),
            integer(args.end_line, 300),
            signal,
          );
          break;
        case "search_code":
          content = await this.#repo.search(
            requiredString(args.query, "query"),
            optionalString(args.path_prefix),
            integer(args.limit, 10),
            signal,
          );
          break;
        default:
          throw new Error(`unknown tool: ${name}`);
      }
      throwIfAborted(signal);
      const inferred = inferEvidence(name, args, content);
      const bounded = truncateToolResult(content, MAX_TOOL_RESULT_BYTES);
      const inferredEvidence = inferred.evidence ?? { scope: evidenceScope(name, args), complete: true };
      const result: EvidenceResult = bounded.truncated
        ? {
            status: "truncated",
            content: bounded.content,
            retryable: false,
            evidence: { ...inferredEvidence, complete: false },
            suggestedAction: "Request a narrower line range or more specific query once.",
          }
        : { ...inferred, content: bounded.content };
      this.#coverage.record(name, result, changedPath(name, args));
      return result;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof GitHubApiError && error.retryable) throw error;
      const invalid = error instanceof InvalidToolArgumentsError || error instanceof SyntaxError;
      const result: EvidenceResult = {
        status: invalid ? "invalid_arguments" : "permanent_error",
        content: error instanceof Error ? error.message : String(error),
        retryable: false,
        errorCode: invalid ? "invalid_tool_arguments" : errorCode(error),
        evidence: { scope: evidenceScope(name, args), complete: false },
        suggestedAction: invalid
          ? "Correct the arguments to match the tool schema and retry once."
          : "Treat this evidence source as unavailable; do not infer a clean result from it.",
        isError: true,
      };
      this.#coverage.record(name, result, changedPath(name, args));
      return result;
    }
  }
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
  const sourceTruncated = parsed?.truncated === true
    || (name === "diff_for_file" && parsed?.patch === null);
  const evidence = {
    scope: evidenceScope(name, args),
    complete: !sourceTruncated,
    ...numericCoverage(parsed),
  };
  if (sourceTruncated) {
    return {
      status: "truncated",
      content,
      retryable: false,
      evidence,
      suggestedAction: name === "diff_for_file"
        ? "Read the exact head/base file around the changed lines before deciding."
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

function numericCoverage(value: Record<string, unknown> | undefined): Pick<NonNullable<EvidenceResult["evidence"]>, "requested" | "returned"> {
  const requested = typeof value?.requested === "number" ? value.requested : undefined;
  const returned = typeof value?.returned === "number"
    ? value.returned
    : Array.isArray(value?.entries)
      ? value.entries.length
      : Array.isArray(value?.files)
        ? value.files.length
        : undefined;
  return {
    ...(requested === undefined ? {} : { requested }),
    ...(returned === undefined ? {} : { returned }),
  };
}

function evidenceScope(name: string, args: Record<string, unknown> | undefined): string {
  const path = typeof args?.path === "string" ? args.path.trim() : "";
  const ref = args?.ref === "base" ? "base" : "head";
  if (name === "diff_for_file") return `${name}:${path}`;
  if (name === "read_file") return `${name}:${ref}:${path}`;
  if (name === "repository_tree") return `${name}:${typeof args?.prefix === "string" ? args.prefix.trim() : ""}`;
  if (name === "search_code") return `${name}:${typeof args?.query === "string" ? args.query.trim() : ""}`;
  return name;
}

function changedPath(name: string, args: Record<string, unknown> | undefined): string | undefined {
  return (name === "diff_for_file" || name === "read_file") && typeof args?.path === "string"
    ? args.path.trim()
    : undefined;
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
    return JSON.stringify(JSON.parse(raw || "{}"));
  } catch {
    return raw.trim();
  }
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

function integer(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

async function fileExists(workspace: WorkspaceClient, path: string): Promise<boolean> {
  try {
    await workspace.fs.stat(path);
    return true;
  } catch {
    return false;
  }
}
