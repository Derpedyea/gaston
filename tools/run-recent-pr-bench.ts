import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_VERIFICATION_MAX_OUTPUT_TOKENS_PER_REQUEST,
  ReviewAgent,
} from "../src/agent.ts";
import { ReviewBudget, type ReviewBudgetLimits } from "../src/budget.ts";
import { pinnedDependencySource } from "../src/dependency-evidence.ts";
import {
  emptyEvidenceCoverage,
  type EvidenceCoverage,
  type EvidenceResult,
  type EvidenceTools,
} from "../src/evidence.ts";
import { GitHubApiError } from "../src/github.ts";
import { discoveryPrompt, REVIEW_LENS } from "../src/prompts.ts";
import {
  RepositorySnapshot,
  type RepositorySnapshotFilesystem,
} from "../src/repository-snapshot.ts";
import {
  aggregateRecentPrScores,
  scoreRecentPrCase,
  type RecentPrBenchCase,
  type RecentPrBenchCorpus,
} from "../src/recent-pr-bench.ts";
import {
  renderChangedFiles,
  renderDiffForFile,
  renderSearchResults,
  RepositoryTools,
  type RepositoryWorkspace,
} from "../src/repository.ts";
import {
  filterFindings,
  parseChangedFileLines,
  shouldUseDirectDiscovery,
} from "../src/review-core.ts";
import type {
  PullChangeSet,
  PullFileChange,
  RepositoryEntry,
  RepositoryRef,
  ReviewJob,
  ReviewOutput,
} from "../src/types.ts";
import { verifyAndPublish } from "../src/verification-pipeline.ts";

const corpusPath = option("--corpus");
const corpusUrl = corpusPath === undefined
  ? new URL("../benchmarks/recent-bot-prs.json", import.meta.url)
  : pathToFileURL(resolve(corpusPath));
const corpus = await Bun.file(corpusUrl).json() as RecentPrBenchCorpus;
const mode = process.argv.includes("--run") ? "run" : "validate";
const selection = option("--case") ?? "all";
const model = option("--model") ?? "openai/gpt-5.6-luna";
const provider = option("--provider") ?? (model.includes("gpt-5.6-luna") ? "openai" : "digitalocean");
const effort = effortOption(option("--effort") ?? "max");
const structuredOutputMode = structuredOutputOption(option("--structured-output") ?? "json_schema");
const allowDataCollection = process.argv.includes("--allow-data-collection");
const maxCostUsd = numberOption("--max-cost-usd", 0.25, 0.001, 5);
const verificationClusterSize = option("--verification-cluster-size") === undefined
  ? undefined
  : numberOption("--verification-cluster-size", 1, 1, 12);
const outputPath = option("--output");
const discoveryArtifactPath = option("--discovery-artifact");
const seededDiscovery = discoveryArtifactPath === undefined
  ? undefined
  : await loadSeededDiscoveries(discoveryArtifactPath);
const selectableCases = seededDiscovery === undefined
  ? corpus.cases
  : corpus.cases.filter((fixture) => seededDiscovery.reviews.has(fixture.id));
const selectedCases = selection === "all"
  ? selectableCases
  : selectableCases.filter((fixture) => fixture.id === selection);
if (selectedCases.length === 0) {
  throw new Error(`unknown case ${selection}; expected all or ${selectableCases.map((entry) => entry.id).join(", ")}`);
}

interface CompareResponse {
  status: string;
  ahead_by: number;
  behind_by: number;
  total_commits: number;
  merge_base_commit: { sha: string };
  files?: Array<{
    filename: string;
    previous_filename?: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
}

interface ToolTraceEntry {
  phase: "discovery" | "verification";
  name: string;
  arguments: string;
  status: string;
  scope?: string;
  bytes: number;
}

class BenchCaseFailure extends Error {
  readonly budget: ReturnType<ReviewBudget["snapshot"]>;
  readonly elapsedMs: number;

  constructor(error: unknown, budget: ReturnType<ReviewBudget["snapshot"]>, elapsedMs: number) {
    super(errorMessage(error), { cause: error });
    this.name = "BenchCaseFailure";
    this.budget = budget;
    this.elapsedMs = elapsedMs;
  }
}

async function main(): Promise<void> {
  const github = new PublicGitHub(await githubToken());
  const prepared = [];
  const validationFailures: string[] = [];
  const seen = new Set<string>();
  for (const fixture of selectedCases) {
    if (seen.has(fixture.id)) validationFailures.push(`${fixture.id}: duplicate case ID`);
    seen.add(fixture.id);
    try {
      const snapshot = await prepareSnapshot(github, fixture);
      prepared.push(snapshot);
      validationFailures.push(...validateSnapshot(snapshot));
    } catch (error) {
      validationFailures.push(`${fixture.id}: ${errorMessage(error)}`);
    }
  }
  const validation = {
    passed: validationFailures.length === 0,
    corpus: corpus.name,
    corpusSha256: await digest(await Bun.file(corpusUrl).text()),
    cases: selectedCases.length,
    labels: selectedCases.reduce((count, fixture) => count + fixture.labels.length, 0),
    failures: validationFailures,
  };
  if (mode === "validate" || !validation.passed) {
    await renderAndExit({ mode, validation }, outputPath, validation.passed ? 0 : 1);
  }

  const apiKey = await openRouterKey();
  const fingerprint = await harnessFingerprint(corpusUrl);
  const results = [];
  for (const snapshot of prepared) {
    process.stderr.write(`[bench] ${model} ${snapshot.fixture.id}\n`);
    try {
      results.push(await runCase(snapshot, {
        apiKey,
        model,
        provider,
        effort,
        structuredOutputMode,
        allowDataCollection,
        maxCostUsd,
        verificationClusterSize,
        fingerprint,
        seededDiscovery: seededDiscovery?.reviews.get(snapshot.fixture.id),
      }));
    } catch (error) {
      const failure = error instanceof BenchCaseFailure ? error : undefined;
      const failedOutput = { summary: "Evaluation failed before a publishable review was produced.", findings: [] };
      results.push({
        case: snapshot.fixture.id,
        repository: snapshot.fixture.repository,
        pullNumber: snapshot.fixture.pullNumber,
        status: "failed" as const,
        error: errorMessage(error),
        output: failedOutput,
        discovery: failedOutput,
        discoveryScore: scoreRecentPrCase(snapshot.fixture, failedOutput),
        score: scoreRecentPrCase(snapshot.fixture, failedOutput),
        budget: failure?.budget ?? emptyBudget(),
        elapsedMs: failure?.elapsedMs ?? 0,
        costUsd: failure?.budget.costUsd ?? 0,
        failed: true,
      });
    }
  }
  const completedFingerprint = await harnessFingerprint(corpusUrl);
  const fingerprintStable = completedFingerprint === fingerprint;
  const metrics = aggregateRecentPrScores(results.map((entry) => ({
    score: entry.score,
    output: entry.output,
    costUsd: entry.costUsd,
    elapsedMs: entry.elapsedMs,
    failed: entry.failed,
  })));
  const discoveryMetrics = aggregateRecentPrScores(results.map((entry) => ({
    score: entry.discoveryScore,
    output: entry.discovery,
    costUsd: entry.costUsd,
    elapsedMs: entry.elapsedMs,
    failed: entry.failed,
  })));
  await renderAndExit({
    schemaVersion: 1,
    mode,
    generatedAt: new Date().toISOString(),
    validation,
    configuration: {
      model,
      provider,
      effort,
      structuredOutputMode,
      allowDataCollection,
      maxCostUsdPerCase: maxCostUsd,
      verificationClusterSize,
      directDiscoveryWhenComplete: true,
      maxExplorationTurns: 1,
      minimumConfidence: 0.8,
      incompleteEvidenceMinimumConfidence: 0.88,
      harnessFingerprint: fingerprint,
      completedHarnessFingerprint: completedFingerprint,
      fingerprintStable,
      repositoryPolicyMode: "omitted-exact-base-policy-not-loaded",
      ...(seededDiscovery === undefined ? {} : {
        discoveryMode: "seeded-artifact",
        discoveryArtifactSha256: seededDiscovery.sha256,
        discoveryModel: seededDiscovery.model,
      }),
    },
    metrics,
    discoveryMetrics,
    results,
  }, outputPath, results.some((entry) => entry.failed) || !fingerprintStable ? 1 : 0);
}

async function prepareSnapshot(github: PublicGitHub, fixture: RecentPrBenchCase) {
  const [owner, repo] = splitRepository(fixture.repository);
  const compare = await github.json<CompareResponse>(
    `/repos/${owner}/${repo}/compare/${fixture.baseSha}...${fixture.headSha}`,
  );
  const files: PullFileChange[] = (compare.files ?? []).map((file) => ({
    path: file.filename,
    ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch ?? null,
  }));
  const filesTruncated = files.length >= 300;
  const diffTruncated = files.some((file) => file.patch === null);
  const changes = createChangeSet(files, filesTruncated, diffTruncated);
  const job: ReviewJob = {
    deliveryId: `recent-bench-${fixture.id}`,
    installationId: 0,
    owner,
    repo,
    pullNumber: fixture.pullNumber,
    title: fixture.title,
    body: "",
    baseRef: "frozen-base",
    baseSha: fixture.baseSha,
    headSha: fixture.headSha,
    queuedAt: corpus.frozenAt,
    trigger: "manual",
  };
  const backend = new SnapshotRepositoryBackend(github, job, changes);
  await backend.initialize();
  const policy = await loadReviewPolicy(backend, changes);
  return { fixture, compare, changes, job, backend, policy };
}

function validateSnapshot(snapshot: Awaited<ReturnType<typeof prepareSnapshot>>): string[] {
  const failures: string[] = [];
  const { fixture, compare, changes } = snapshot;
  if (!/^[a-f0-9]{40}$/.test(fixture.baseSha) || !/^[a-f0-9]{40}$/.test(fixture.headSha)) {
    failures.push(`${fixture.id}: invalid immutable SHA`);
  }
  if (compare.status !== "ahead" || compare.behind_by !== 0 || compare.merge_base_commit.sha !== fixture.baseSha) {
    failures.push(`${fixture.id}: base/head is not an exact forward comparison`);
  }
  const expectedCommitCount = fixture.expectedCommitCount ?? 1;
  if (!Number.isSafeInteger(expectedCommitCount) || expectedCommitCount < 1) {
    failures.push(`${fixture.id}: expectedCommitCount must be a positive integer`);
  } else if (compare.total_commits !== expectedCommitCount) {
    failures.push(
      `${fixture.id}: expected ${expectedCommitCount} commits in reviewed snapshot, got ${compare.total_commits}`,
    );
  }
  if (changes.files.length === 0) failures.push(`${fixture.id}: comparison contains no changed files`);
  if (changes.filesTruncated) failures.push(`${fixture.id}: comparison hit GitHub's 300-file compare ceiling`);
  const changed = parseChangedFileLines(changes.files);
  for (const label of fixture.labels) {
    const lines = changed.get(label.path)?.[label.side === "RIGHT" ? "right" : "left"];
    const intersects = lines !== undefined && [...lines].some((line) => line >= label.lineStart && line <= label.lineEnd);
    if (!intersects) failures.push(`${fixture.id}/${label.id}: label range does not intersect a changed ${label.side} line`);
    if (label.requiredTermGroups.some((group) => group.length === 0)) {
      failures.push(`${fixture.id}/${label.id}: empty required term group`);
    }
  }
  return failures;
}

async function runCase(
  snapshot: Awaited<ReturnType<typeof prepareSnapshot>>,
  config: {
    apiKey: string;
    model: string;
    provider: string;
    effort: "high" | "xhigh" | "max";
    structuredOutputMode: "json_schema" | "json_object";
    allowDataCollection: boolean;
    maxCostUsd: number;
    verificationClusterSize?: number;
    fingerprint: string;
    seededDiscovery?: {
      review: ReviewOutput;
      coverage?: EvidenceCoverage;
    };
  },
) {
  const trace: ToolTraceEntry[] = [];
  const limits: ReviewBudgetLimits = {
    maxWallTimeMs: 14 * 60_000,
    modelRequestTimeoutMs: 11 * 60_000,
    maxModelRequests: 15,
    maxEstimatedInputTokens: 250_000,
    maxOutputTokens: 128_000,
    maxCostUsd: config.maxCostUsd,
  };
  const budget = new ReviewBudget(limits);
  const startedAt = Date.now();
  try {
    const agent = new ReviewAgent({
    apiKey: config.apiKey,
    model: config.model,
    reasoningEffort: config.effort,
    repository: snapshot.fixture.repository,
    budget,
    maxOutputTokensPerRequest: 64_000,
    requireInitialToolCall: false,
    maxExplorationTurns: 1,
    provider: config.provider,
    requireZdr: false,
    structuredOutputMode: config.structuredOutputMode,
    allowDataCollection: config.allowDataCollection,
    });
    const verificationAgent = new ReviewAgent({
      apiKey: config.apiKey,
      model: config.model,
      reasoningEffort: config.effort,
      repository: snapshot.fixture.repository,
      budget,
      maxOutputTokensPerRequest: DEFAULT_VERIFICATION_MAX_OUTPUT_TOKENS_PER_REQUEST,
      requireInitialToolCall: false,
      maxExplorationTurns: 1,
      provider: config.provider,
      requireZdr: false,
      structuredOutputMode: config.structuredOutputMode,
      allowDataCollection: config.allowDataCollection,
    });
    const verificationRescueAgent = new ReviewAgent({
      apiKey: config.apiKey,
      model: config.model,
      reasoningEffort: config.effort,
      repository: snapshot.fixture.repository,
      budget,
      maxOutputTokensPerRequest: DEFAULT_VERIFICATION_MAX_OUTPUT_TOKENS_PER_REQUEST,
      requireInitialToolCall: false,
      maxExplorationTurns: 2,
      provider: config.provider,
      requireZdr: false,
      structuredOutputMode: config.structuredOutputMode,
      allowDataCollection: config.allowDataCollection,
    });
    const changedLines = parseChangedFileLines(snapshot.changes.files);
  const discoveryTools = config.seededDiscovery === undefined
    ? new TracedEvidenceTools(snapshot.backend, "discovery", trace)
    : undefined;
  const directDiscovery = config.seededDiscovery !== undefined
    || shouldUseDirectDiscovery("true", discoveryTools!.coverage());
  const discovery = filterFindings(
    config.seededDiscovery?.review
      ?? (directDiscovery
        ? await agent.runDirectReview(
            discoveryPrompt(snapshot.job, snapshot.changes, [], snapshot.policy, REVIEW_LENS),
            "discovery",
          )
        : await agent.run(
            discoveryPrompt(snapshot.job, snapshot.changes, [], snapshot.policy, REVIEW_LENS),
            discoveryTools!,
            "discovery",
          )),
    changedLines,
    0,
    12,
  );
  const discoveryCoverage = config.seededDiscovery?.coverage
    ?? (discoveryTools?.coverage() ?? seededDiscoveryCoverage(snapshot.changes.files.length));
  let output: ReviewOutput = discovery;
  let finalCoverage = discoveryCoverage;
  let verification: unknown;
  if (discovery.findings.length > 0) {
    const finalized = await verifyAndPublish({
      runner: verificationAgent,
      rescueRunner: verificationRescueAgent,
      tools: new TracedEvidenceTools(snapshot.backend, "verification", trace),
      job: snapshot.job,
      discoveries: [{
        source: config.seededDiscovery !== undefined
          ? "seeded-discovery"
          : directDiscovery ? "direct-discovery" : "discovery",
        review: discovery,
      }],
      changes: snapshot.changes,
      policy: snapshot.policy,
      signal: budget.signal,
      changedLines,
      discoveryCoverage,
      configuredBaseThreshold: "0.80",
      configuredIncompleteEvidenceFloor: "0.88",
      maxFindings: 8,
      ...(config.verificationClusterSize === undefined
        ? {}
        : { verificationClusterSize: config.verificationClusterSize }),
    });
    output = finalized.review;
    finalCoverage = finalized.coverage;
    verification = {
      raw: finalized.raw,
      initialRaw: finalized.initialRaw,
      resolution: finalized.resolution,
      coverage: finalized.verificationCoverage,
      publicationMinConfidence: finalized.minConfidence,
      rescue: finalized.rescue,
      rescueDecision: finalized.rescueDecision,
      clusters: finalized.clusters,
    };
  }
  const budgetSnapshot = budget.snapshot();
    return {
    case: snapshot.fixture.id,
    repository: snapshot.fixture.repository,
    pullNumber: snapshot.fixture.pullNumber,
    status: "completed" as const,
    snapshot: {
      baseSha: snapshot.fixture.baseSha,
      headSha: snapshot.fixture.headSha,
      changedFiles: snapshot.changes.files.length,
      diffBytes: byteLength(snapshot.changes.diff),
      harnessFingerprint: config.fingerprint,
    },
    directDiscovery,
    discovery,
    discoveryCoverage,
    ...(verification === undefined ? {} : { verification }),
    output,
    discoveryScore: scoreRecentPrCase(snapshot.fixture, discovery),
    score: scoreRecentPrCase(snapshot.fixture, output),
    coverage: finalCoverage,
    toolTrace: trace,
    budget: budgetSnapshot,
    elapsedMs: Date.now() - startedAt,
    costUsd: budgetSnapshot.costUsd,
    failed: false,
    };
  } catch (error) {
    throw new BenchCaseFailure(error, budget.snapshot(), Date.now() - startedAt);
  }
}

class TracedEvidenceTools implements EvidenceTools {
  readonly #inner: RepositoryTools;
  readonly #phase: "discovery" | "verification";
  readonly #trace: ToolTraceEntry[];

  constructor(
    backend: SnapshotRepositoryBackend,
    phase: "discovery" | "verification",
    trace: ToolTraceEntry[],
  ) {
    this.#inner = new RepositoryTools(backend as unknown as RepositoryWorkspace);
    this.#phase = phase;
    this.#trace = trace;
  }

  coverage(): EvidenceCoverage {
    return this.#inner.coverage();
  }

  async invoke(name: string, rawArguments: string, signal?: AbortSignal): Promise<EvidenceResult> {
    const result = await this.#inner.invoke(name, rawArguments, signal);
    this.#trace.push({
      phase: this.#phase,
      name,
      arguments: rawArguments,
      status: result.status,
      ...(result.evidence?.scope === undefined ? {} : { scope: result.evidence.scope }),
      bytes: byteLength(result.content),
    });
    return result;
  }
}

class SnapshotRepositoryBackend {
  readonly changes: PullChangeSet;
  readonly #github: PublicGitHub;
  readonly #job: ReviewJob;
  readonly #snapshot: RepositorySnapshot;
  #treeByRef = new Map<string, Promise<{ entries: RepositoryEntry[]; truncated: boolean }>>();
  #fileByRef = new Map<string, Promise<string>>();

  constructor(github: PublicGitHub, job: ReviewJob, changes: PullChangeSet) {
    this.#github = github;
    this.#job = job;
    this.changes = changes;
    this.#snapshot = new RepositorySnapshot({
      fs: new MemorySnapshotFilesystem(),
      ref: job.headSha,
      cacheRoot: "/bench",
      loadArchive: (signal) => github.repositoryArchive(job, job.headSha, signal),
      loadInventory: (signal) => github.repositoryTree(job, job.headSha, signal),
      loadControlFile: (path, signal) => github.readFile(job, path, job.headSha, signal),
    });
  }

  async initialize(): Promise<void> {
    await this.#snapshot.ensure();
  }

  changedFiles(offset = 0, limit = 100): string {
    return renderChangedFiles(this.changes, offset, limit);
  }

  diffForFile(path: string, patchStartLine?: number, patchEndLine?: number): string {
    return renderDiffForFile(this.changes, path, patchStartLine, patchEndLine);
  }

  diffForSourceLine(path: string, sourceLine: number, sourceSide: "LEFT" | "RIGHT"): string {
    return renderDiffForFile(this.changes, path, undefined, undefined, sourceLine, sourceSide);
  }

  async tree(prefix: string, limit: number, signal?: AbortSignal): Promise<string> {
    const { entries, truncated } = await this.#snapshot.tree()
      ?? await this.repositoryTree(this.#job.headSha, signal);
    const normalized = prefix.trim().replace(/^\/+|\/+$/g, "");
    const selected = entries.filter((entry) => (
      !normalized || entry.path === normalized || entry.path.startsWith(`${normalized}/`)
    )).slice(0, Math.max(1, Math.min(limit, 500)));
    return JSON.stringify({ entries: selected, truncated: truncated || selected.length === limit });
  }

  async read(
    path: string,
    ref: RepositoryRef,
    startLine: number,
    endLine: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const content = await this.readExact(path, ref, signal);
    const lines = content.split("\n");
    const start = Math.max(1, Math.min(Math.trunc(startLine), Math.max(1, lines.length)));
    const end = Math.max(start, Math.min(Math.trunc(endLine), start + 399, lines.length));
    return JSON.stringify({
      path,
      ref,
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      content: lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n"),
    });
  }

  async search(query: string, pathPrefix: string | undefined, limit: number, signal?: AbortSignal): Promise<string> {
    const local = await this.#snapshot.search(query, pathPrefix, limit, signal);
    if (local !== undefined) return renderSearchResults(local.matches, local.truncated);
    const candidates = await this.#github.searchPaths(this.#job, query, pathPrefix, limit * 3, signal);
    const matches: Array<{ path: string; line: number; fragment: string }> = [];
    const needle = query.toLowerCase();
    for (const path of candidates) {
      if (matches.length >= limit) break;
      try {
        const lines = (await this.readExact(path, "head", signal)).split("\n");
        const index = lines.findIndex((line) => line.toLowerCase().includes(needle));
        if (index === -1) continue;
        matches.push({
          path,
          line: index + 1,
          fragment: lines.slice(Math.max(0, index - 2), index + 3).join("\n"),
        });
      } catch {
        // Default-branch search is advisory; a path may not exist at the frozen head.
      }
    }
    return renderSearchResults(matches, candidates.length >= limit * 3 || matches.length >= limit);
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
        readSignal,
        2_000_000,
      ),
      ...(signal === undefined ? {} : { signal }),
    });
  }

  repositoryTree(ref: string, signal?: AbortSignal) {
    const cached = this.#treeByRef.get(ref);
    if (cached) return cached;
    const request = this.#github.repositoryTree(this.#job, ref, signal);
    this.#treeByRef.set(ref, request);
    return request;
  }

  readExact(path: string, ref: RepositoryRef, signal?: AbortSignal): Promise<string> {
    if (ref === "head") {
      return this.#snapshot.read(path).then((content) => (
        content === undefined ? this.#readExactFromGitHub(path, ref, signal) : content
      ));
    }
    return this.#readExactFromGitHub(path, ref, signal);
  }

  #readExactFromGitHub(path: string, ref: RepositoryRef, signal?: AbortSignal): Promise<string> {
    const sha = ref === "base" ? this.#job.baseSha : this.#job.headSha;
    const key = `${sha}:${path}`;
    const cached = this.#fileByRef.get(key);
    if (cached) return cached;
    const request = this.#github.readFile(this.#job, path, sha, signal);
    this.#fileByRef.set(key, request);
    return request;
  }
}

class PublicGitHub {
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  async json<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.request(path, { signal });
    return response.json() as Promise<T>;
  }

  async repositoryTree(job: ReviewJob, ref: string, signal?: AbortSignal) {
    const tree = await this.json<{
      truncated: boolean;
      tree: Array<{ path: string; type: string; size?: number }>;
    }>(`/repos/${job.owner}/${job.repo}/git/trees/${ref}?recursive=1`, signal);
    return {
      entries: tree.tree.filter((entry) => entry.type === "blob" || entry.type === "tree")
        .slice(0, 100_000)
        .map((entry) => ({
          path: entry.path,
          type: entry.type as "blob" | "tree",
          size: entry.size ?? null,
        })),
      truncated: tree.truncated || tree.tree.length > 100_000,
    };
  }

  async repositoryArchive(job: ReviewJob, ref: string, signal?: AbortSignal) {
    const response = await this.request(
      `/repos/${job.owner}/${job.repo}/tarball/${encodeURIComponent(ref)}`,
      { redirect: "follow", signal },
    );
    if (response.body === null) throw new Error("GitHub repository archive has no body");
    const declared = Number(response.headers.get("content-length"));
    return {
      body: response.body,
      ...(Number.isFinite(declared) && declared >= 0 ? { contentLength: declared } : {}),
    };
  }

  async readFile(
    job: ReviewJob,
    path: string,
    ref: string,
    signal?: AbortSignal,
    maxBytes = 400_000,
  ): Promise<string> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const response = await this.request(
      `/repos/${job.owner}/${job.repo}/contents/${encoded}?ref=${ref}`,
      { headers: { accept: "application/vnd.github.raw+json" }, signal },
    );
    const text = await response.text();
    if (byteLength(text) > maxBytes) throw new Error(`file ${path} exceeds the ${maxBytes}-byte read limit`);
    if (text.includes("\0")) throw new Error(`file ${path} is binary`);
    return text;
  }

  async searchPaths(
    job: ReviewJob,
    query: string,
    pathPrefix: string | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const literal = query.replace(/["\\\r\n]/g, " ").trim().slice(0, 100);
    const prefix = pathPrefix?.replace(/[^A-Za-z0-9_./-]/g, "").replace(/^\/+/, "").slice(0, 200);
    const q = `"${literal}" repo:${job.owner}/${job.repo}${prefix ? ` path:${prefix}` : ""}`;
    const result = await this.json<{ items: Array<{ path: string }> }>(
      `/search/code?q=${encodeURIComponent(q)}&per_page=${Math.max(1, Math.min(limit, 100))}`,
      signal,
    );
    return result.items.map((entry) => entry.path);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.#token}`,
        "user-agent": "gaston-recent-pr-bench",
        "x-github-api-version": "2026-03-10",
        ...init.headers,
      },
    });
    if (response.ok) return response;
    const detail = (await response.text()).slice(0, 1_000);
    throw new GitHubApiError(init.method ?? "GET", path, response.status, detail);
  }
}

class MemorySnapshotFilesystem implements RepositorySnapshotFilesystem {
  readonly #files = new Map<string, Uint8Array>();

  async readFile(path: string, _encoding: "utf8"): Promise<string> {
    const content = this.#files.get(path);
    if (content === undefined) throw new Error(`snapshot file does not exist: ${path}`);
    return new TextDecoder().decode(content);
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    this.#files.set(
      path,
      typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content),
    );
  }

  async mkdir(_path: string, _options: { recursive: true }): Promise<void> {}

  async rm(path: string, _options: { recursive: true; force: true }): Promise<void> {
    for (const candidate of this.#files.keys()) {
      if (candidate === path || candidate.startsWith(`${path}/`)) this.#files.delete(candidate);
    }
  }

  async stat(path: string): Promise<unknown> {
    if (!this.#files.has(path)) throw new Error(`snapshot file does not exist: ${path}`);
    return {};
  }
}

async function loadReviewPolicy(_backend: SnapshotRepositoryBackend, _changes: PullChangeSet): Promise<string> {
  // The benchmark intentionally omits repository policy rather than risk
  // mixing mutable/default-branch instructions into an exact historical head.
  // The production path still loads base-SHA policy; this limitation is
  // recorded in every report through the empty policy field.
  return "";
}

function createChangeSet(files: PullFileChange[], filesTruncated: boolean, diffTruncated: boolean): PullChangeSet {
  let diff = "";
  let renderedTruncated = false;
  for (const file of files) {
    if (!file.patch) continue;
    const oldPath = file.status === "added" ? "/dev/null" : `a/${file.previousPath ?? file.path}`;
    const newPath = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
    const block = [
      `diff --git a/${file.previousPath ?? file.path} b/${file.path}`,
      `--- ${oldPath}`,
      `+++ ${newPath}`,
      file.patch,
      "",
    ].join("\n");
    if (byteLength(diff + block) > 2_000_000) {
      renderedTruncated = true;
      break;
    }
    diff += block;
  }
  return {
    files,
    diff,
    truncated: filesTruncated || diffTruncated || renderedTruncated,
    filesTruncated,
    diffTruncated: diffTruncated || renderedTruncated,
    unavailablePatchPaths: files.filter((file) => file.patch === null).map((file) => file.path),
  };
}

async function harnessFingerprint(activeCorpusUrl: URL): Promise<string> {
  const paths = [
    "src/agent.ts",
    "src/dependency-evidence.ts",
    "src/evidence.ts",
    "src/prompts.ts",
    "src/repository.ts",
    "src/repository-snapshot.ts",
    "src/review-core.ts",
    "src/types.ts",
    "src/verification-evidence.ts",
    "src/verification-pipeline.ts",
    "src/recent-pr-bench.ts",
    "tools/run-recent-pr-bench.ts",
  ];
  const chunks = [];
  for (const path of paths) chunks.push(path, "\0", await Bun.file(resolve(path)).text(), "\0");
  chunks.push("active-corpus", "\0", await Bun.file(activeCorpusUrl).text(), "\0");
  return digest(chunks.join(""));
}

async function githubToken(): Promise<string> {
  if (process.env.GITHUB_TOKEN?.trim()) return process.env.GITHUB_TOKEN.trim();
  const child = Bun.spawnSync(["gh", "auth", "token"]);
  if (child.exitCode !== 0) throw new Error("GitHub authentication is unavailable");
  return new TextDecoder().decode(child.stdout).trim();
}

async function openRouterKey(): Promise<string> {
  if (process.env.OPENROUTER_API_KEY?.trim()) return process.env.OPENROUTER_API_KEY.trim();
  const env = await Bun.file(new URL("../.env", import.meta.url)).text();
  const prefix = "OPENROUTER_API_KEY=";
  const assignment = env.split(/\r?\n/).find((line) => line.startsWith(prefix));
  const value = assignment?.slice(prefix.length).trim();
  if (!value) throw new Error("OPENROUTER_API_KEY is not configured");
  return value;
}

function splitRepository(repository: string): [string, string] {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) throw new Error(`invalid repository ${repository}`);
  return parts as [string, string];
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

interface SeededDiscoveryArtifact {
  sha256: string;
  model: string | undefined;
  reviews: Map<string, { review: ReviewOutput; coverage?: EvidenceCoverage }>;
}

async function loadSeededDiscoveries(path: string): Promise<SeededDiscoveryArtifact> {
  const content = await Bun.file(path).text();
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
    throw new Error("discovery artifact must contain a results array");
  }
  const reviews = new Map<string, { review: ReviewOutput; coverage?: EvidenceCoverage }>();
  for (const result of parsed.results) {
    if (!isRecord(result) || typeof result.case !== "string" || !isReviewOutput(result.discovery)) {
      continue;
    }
    reviews.set(result.case, {
      review: result.discovery,
      ...(isEvidenceCoverage(result.discoveryCoverage)
        ? { coverage: result.discoveryCoverage }
        : {}),
    });
  }
  if (reviews.size === 0) throw new Error("discovery artifact contains no reusable discoveries");
  const configuration = isRecord(parsed.configuration) ? parsed.configuration : undefined;
  return {
    sha256: await digest(content),
    model: typeof configuration?.model === "string" ? configuration.model : undefined,
    reviews,
  };
}

function seededDiscoveryCoverage(totalChangedFiles: number): EvidenceCoverage {
  const coverage = emptyEvidenceCoverage(totalChangedFiles);
  return {
    ...coverage,
    sufficient: false,
    limitations: ["Discovery evidence coverage was unavailable in the seeded artifact."],
  };
}

function isReviewOutput(value: unknown): value is ReviewOutput {
  return isRecord(value)
    && typeof value.summary === "string"
    && Array.isArray(value.findings);
}

function isEvidenceCoverage(value: unknown): value is EvidenceCoverage {
  return isRecord(value)
    && typeof value.sufficient === "boolean"
    && Array.isArray(value.limitations);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effortOption(value: string): "high" | "xhigh" | "max" {
  if (value === "high" || value === "xhigh" || value === "max") return value;
  throw new Error("--effort must be high, xhigh, or max");
}

function structuredOutputOption(value: string): "json_schema" | "json_object" {
  if (value === "json_schema" || value === "json_object") return value;
  throw new Error("--structured-output must be json_schema or json_object");
}

function numberOption(name: string, fallback: number, min: number, max: number): number {
  const raw = option(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number from ${min} to ${max}`);
  }
  return value;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyBudget() {
  return {
    elapsedMs: 0,
    modelRequests: 0,
    estimatedInputTokens: 0,
    reportedInputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    remainingModelRequests: 0,
    remainingWallTimeMs: 0,
  };
}

async function renderAndExit(value: unknown, path: string | undefined, exitCode: number): Promise<never> {
  const rendered = `${JSON.stringify(value, null, 2)}\n`;
  if (path) await Bun.write(path, rendered);
  else process.stdout.write(rendered);
  process.exit(exitCode);
}

await main();
