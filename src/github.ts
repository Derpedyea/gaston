import type {
  Finding,
  PullChangeSet,
  PullFileChange,
  RepositoryEntry,
  ReviewJob,
  ReviewOutput,
} from "./types.ts";
import { formatBudgetSummary, type ReviewBudgetSnapshot } from "./budget.ts";
import type { EvidenceCoverage } from "./evidence.ts";
import { shouldRequestChanges } from "./review-core.ts";

const API = "https://api.github.com";
const API_VERSION = "2026-03-10";
const CHECK_NAME = "Gaston review";

export class GitHubApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;

  constructor(method: string, path: string, status: number, detail: string) {
    super(`GitHub API ${method} ${path} failed (${status}): ${detail}`);
    this.name = "GitHubApiError";
    this.status = status;
    this.method = method;
    this.path = path;
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

interface InstallationTokenResponse { token: string }

interface AuthenticatedGitHubApp {
  events?: string[];
  permissions?: Record<string, string>;
}

export interface GitHubAppReadiness {
  ok: boolean;
  requirements: {
    pullRequestEvent: boolean;
    issueCommentEvent: boolean;
    contentsRead: boolean;
    pullRequestsWrite: boolean;
    checksWrite: boolean;
    issuesWrite: boolean;
  };
}

export interface PullRequestState {
  number: number;
  title: string;
  body: string | null;
  head: { sha: string };
  base: { ref: string; sha: string };
  state: string;
  draft: boolean;
}

interface CheckRun {
  id: number;
  external_id: string | null;
  name: string;
  status: string;
}

interface CheckRunsResponse { check_runs: CheckRun[] }
interface PullReview { body: string | null; commit_id: string }
interface IssueComment { id: number; body: string | null }
interface PullFileResponse {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GitTreeResponse {
  truncated: boolean;
  tree: Array<{ path: string; type: "blob" | "tree" | "commit"; size?: number }>;
}

interface CodeSearchResponse {
  items: Array<{
    path: string;
    text_matches?: Array<{ fragment?: string; matches?: Array<{ text?: string }> }>;
  }>;
}

type ReactionContent = "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes";

export class GitHubClient {
  readonly #token: string;

  private constructor(token: string) {
    this.#token = token;
  }

  static async forInstallation(appId: string, privateKey: string, installationId: number): Promise<GitHubClient> {
    const jwt = await createAppJwt(appId, privateKey);
    const result = await githubRequest<InstallationTokenResponse>(
      `/app/installations/${installationId}/access_tokens`,
      jwt,
      { method: "POST" },
    );
    return new GitHubClient(result.token);
  }

  getPull(job: ReviewJob, signal?: AbortSignal): Promise<PullRequestState> {
    return this.getPullByNumber(job.owner, job.repo, job.pullNumber, signal);
  }

  getPullByNumber(owner: string, repo: string, pullNumber: number, signal?: AbortSignal): Promise<PullRequestState> {
    return this.request(`/repos/${owner}/${repo}/pulls/${pullNumber}`, signalInit(signal));
  }

  reactToIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    content: ReactionContent,
  ): Promise<unknown> {
    return this.request(`/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`, {
      method: "POST",
      body: JSON.stringify({ content }),
    });
  }

  async getPullChanges(job: ReviewJob, signal?: AbortSignal): Promise<PullChangeSet> {
    const files: PullFileChange[] = [];
    let truncated = false;
    let diffBytes = 0;

    for (let page = 1; page <= 3; page++) {
      const batch = await this.request<PullFileResponse[]>(
        `/repos/${job.owner}/${job.repo}/pulls/${job.pullNumber}/files?per_page=100&page=${page}`,
        signalInit(signal),
      );
      for (const file of batch) {
        const patch = file.patch ?? null;
        const change: PullFileChange = {
          path: file.filename,
          ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          patch,
        };
        files.push(change);
        diffBytes += patch?.length ?? 0;
      }
      if (batch.length < 100) break;
      if (page === 3) truncated = true;
    }

    return createChangeSet(files, truncated || diffBytes > 2_000_000);
  }

  async getRepositoryTree(
    job: ReviewJob,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ entries: RepositoryEntry[]; truncated: boolean }> {
    const tree = await this.request<GitTreeResponse>(
      `/repos/${job.owner}/${job.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      signalInit(signal),
    );
    return {
      entries: tree.tree
        .filter((entry): entry is typeof entry & { type: "blob" | "tree" } => (
          entry.type === "blob" || entry.type === "tree"
        ))
        .slice(0, 100_000)
        .map((entry) => ({
          path: entry.path,
          type: entry.type,
          size: entry.size ?? null,
        })),
      truncated: tree.truncated || tree.tree.length > 100_000,
    };
  }

  async readFile(
    job: ReviewJob,
    path: string,
    ref: string,
    maxBytes = 400_000,
    signal?: AbortSignal,
  ): Promise<string> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const requestPath = `/repos/${job.owner}/${job.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
    const response = await this.rawRequest(
      requestPath,
      { headers: { accept: "application/vnd.github.raw+json" }, ...signalInit(signal) },
    );
    try {
      return await readBoundedText(response, maxBytes, `file ${path}`);
    } catch (error) {
      if (error instanceof TypeError) {
        throw new GitHubApiError("GET", requestPath, 503, `response stream failed: ${error.message}`);
      }
      throw error;
    }
  }

  async searchCode(
    job: ReviewJob,
    query: string,
    pathPrefix: string | undefined,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Array<{ path: string; fragment: string }>> {
    const literal = query.replace(/["\\\r\n]/g, " ").trim().slice(0, 100);
    if (literal.length < 2) throw new Error("search query must contain at least two characters");
    const prefix = pathPrefix?.replace(/[^A-Za-z0-9_./-]/g, "").replace(/^\/+/, "").slice(0, 200);
    const q = `"${literal}" repo:${job.owner}/${job.repo}${prefix ? ` path:${prefix}` : ""}`;
    const result = await this.request<CodeSearchResponse>(
      `/search/code?q=${encodeURIComponent(q)}&per_page=${Math.max(1, Math.min(limit, 30))}`,
      { headers: { accept: "application/vnd.github.text-match+json" }, ...signalInit(signal) },
    );
    return result.items.slice(0, limit).map((item) => ({
      path: item.path,
      fragment: item.text_matches?.map((match) => match.fragment ?? "").join("\n").slice(0, 2_000) ?? "",
    }));
  }

  async getOtherChecks(job: ReviewJob, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
    const result = await this.request<{
      check_runs: Array<{
        name: string;
        status: string;
        conclusion: string | null;
        output?: { title?: string | null; summary?: string | null };
      }>;
    }>(`/repos/${job.owner}/${job.repo}/commits/${job.headSha}/check-runs?per_page=100`, signalInit(signal));

    return result.check_runs
      .filter((check) => check.name !== CHECK_NAME)
      .map((check) => ({
        name: check.name,
        status: check.status,
        conclusion: check.conclusion,
        title: check.output?.title?.slice(0, 300) ?? null,
        summary: check.output?.summary?.slice(0, 1_000) ?? null,
      }));
  }

  async ensureCheckRun(job: ReviewJob): Promise<number> {
    return this.ensureCheckRunWithStatus(job, "in_progress");
  }

  async ensureQueuedCheckRun(job: ReviewJob): Promise<number> {
    return this.ensureCheckRunWithStatus(job, "queued");
  }

  startCheckRun(job: ReviewJob, checkRunId: number): Promise<unknown> {
    return this.request(`/repos/${job.owner}/${job.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "in_progress",
        started_at: new Date().toISOString(),
        output: { title: "Reviewing pull request", summary: "Gaston is inspecting the change and repository context." },
      }),
    });
  }

  updateCheckProgress(
    job: ReviewJob,
    checkRunId: number,
    title: string,
    summary: string,
  ): Promise<unknown> {
    return this.request(`/repos/${job.owner}/${job.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "in_progress",
        output: { title: title.slice(0, 255), summary: summary.slice(0, 4_000) },
      }),
    });
  }

  private async ensureCheckRunWithStatus(job: ReviewJob, status: "queued" | "in_progress"): Promise<number> {
    const externalId = reviewMarker(job);
    const current = await this.request<CheckRunsResponse>(
      `/repos/${job.owner}/${job.repo}/commits/${job.headSha}/check-runs?check_name=${encodeURIComponent(CHECK_NAME)}&per_page=100`,
    );
    const existing = current.check_runs.find((check) => (
      check.external_id === externalId && check.status !== "completed"
    ));
    if (existing) {
      if (status === "in_progress" && existing.status !== "in_progress") {
        await this.startCheckRun(job, existing.id);
      }
      return existing.id;
    }

    const queued = status === "queued";
    const created = await this.request<CheckRun>(`/repos/${job.owner}/${job.repo}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: CHECK_NAME,
        head_sha: job.headSha,
        external_id: externalId,
        status,
        ...(queued ? {} : { started_at: new Date().toISOString() }),
        output: queued
          ? { title: "Review queued", summary: "Gaston accepted this commit and will start after any earlier review for this pull request." }
          : { title: "Reviewing pull request", summary: "Gaston is inspecting the change and repository context." },
      }),
    });
    return created.id;
  }

  completeCheck(
    job: ReviewJob,
    checkRunId: number,
    review: ReviewOutput,
    budget?: ReviewBudgetSnapshot,
    coverage?: EvidenceCoverage,
  ): Promise<unknown> {
    const findingCount = review.findings.length;
    const incomplete = coverage?.sufficient === false;
    return this.request(`/repos/${job.owner}/${job.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "completed",
        completed_at: new Date().toISOString(),
        conclusion: findingCount === 0 && !incomplete ? "success" : "neutral",
        output: {
          title: incomplete && findingCount === 0
            ? "Review evidence incomplete"
            : findingCount === 0
            ? "No actionable bugs found"
            : `${findingCount} high-confidence ${findingCount === 1 ? "finding" : "findings"}`,
          summary: [
            renderSummary(review),
            ...(coverage === undefined ? [] : ["", renderCoverage(coverage)]),
            ...(budget === undefined ? [] : ["", `_Resource use: ${formatBudgetSummary(budget)}._`]),
          ].join("\n").slice(0, 60_000),
        },
      }),
    });
  }

  failCheck(job: ReviewJob, checkRunId: number, error: unknown): Promise<unknown> {
    const message = error instanceof Error ? error.message : String(error);
    return this.request(`/repos/${job.owner}/${job.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "completed",
        completed_at: new Date().toISOString(),
        conclusion: "failure",
        output: { title: "Review failed", summary: message.slice(0, 4_000) },
      }),
    });
  }

  stopCheckForBudget(
    job: ReviewJob,
    checkRunId: number,
    reason: string,
    budget: ReviewBudgetSnapshot,
  ): Promise<unknown> {
    return this.request(`/repos/${job.owner}/${job.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "completed",
        completed_at: new Date().toISOString(),
        conclusion: "neutral",
        output: {
          title: "Review stopped at resource budget",
          summary: [
            `Gaston stopped safely at its ${reason}; it did not publish a partial or speculative review.`,
            "Push another commit or request a manual review after adjusting the configured budget.",
            "",
            `Resource use: ${formatBudgetSummary(budget)}.`,
          ].join("\n"),
        },
      }),
    });
  }

  supersedeCheck(job: ReviewJob, checkRunId: number): Promise<unknown> {
    return this.request(`/repos/${job.owner}/${job.repo}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "completed",
        completed_at: new Date().toISOString(),
        conclusion: "cancelled",
        output: {
          title: "Review superseded",
          summary: "A newer commit arrived, so Gaston stopped this review and moved to the latest cumulative pull request diff.",
        },
      }),
    });
  }

  async hasPublishedReview(job: ReviewJob, signal?: AbortSignal): Promise<boolean> {
    const marker = `<!-- ${reviewMarker(job)} -->`;
    for (let page = 1; page <= 10; page++) {
      const reviews = await this.request<PullReview[]>(
        `/repos/${job.owner}/${job.repo}/pulls/${job.pullNumber}/reviews?per_page=100&page=${page}`,
        signalInit(signal),
      );
      if (reviews.some((review) => review.commit_id === job.headSha && review.body?.includes(marker))) return true;
      if (reviews.length < 100) return false;
    }
    return false;
  }

  publishReview(job: ReviewJob, review: ReviewOutput, requestChangesOn: string | undefined): Promise<unknown> {
    const comments = review.findings.map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: renderInlineFinding(finding),
    }));
    return this.request(`/repos/${job.owner}/${job.repo}/pulls/${job.pullNumber}/reviews`, {
      method: "POST",
      body: JSON.stringify({
        commit_id: job.headSha,
        event: shouldRequestChanges(review.findings, requestChangesOn) ? "REQUEST_CHANGES" : "COMMENT",
        body: `<!-- ${reviewMarker(job)} -->\n${renderSummary(review)}`,
        comments,
      }),
    });
  }

  async upsertReviewSummary(job: ReviewJob, review: ReviewOutput): Promise<void> {
    const marker = `<!-- gaston-summary:${job.pullNumber} -->`;
    let existing: IssueComment | undefined;
    for (let page = 1; page <= 10; page++) {
      const comments = await this.request<IssueComment[]>(
        `/repos/${job.owner}/${job.repo}/issues/${job.pullNumber}/comments?per_page=100&page=${page}`,
      );
      existing = comments.find((comment) => comment.body?.includes(marker));
      if (existing || comments.length < 100) break;
    }
    if (!existing && review.findings.length === 0) return;

    const body = `${marker}\n${renderSummary(review)}\n\n_Last reviewed commit: \`${job.headSha.slice(0, 12)}\`._`;
    if (existing) {
      await this.request(`/repos/${job.owner}/${job.repo}/issues/comments/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
      return;
    }
    await this.request(`/repos/${job.owner}/${job.repo}/issues/${job.pullNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  private request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    return githubRequest<T>(path, this.#token, init);
  }

  private rawRequest(path: string, init?: RequestInit): Promise<Response> {
    return githubRawRequest(path, this.#token, init);
  }
}

export async function getGitHubAppReadiness(appId: string, privateKey: string): Promise<GitHubAppReadiness> {
  const jwt = await createAppJwt(appId, privateKey);
  const app = await githubRequest<AuthenticatedGitHubApp>("/app", jwt);
  const events = new Set(app.events ?? []);
  const permissions = app.permissions ?? {};
  const requirements = {
    pullRequestEvent: events.has("pull_request"),
    issueCommentEvent: events.has("issue_comment"),
    contentsRead: hasPermission(permissions.contents, "read"),
    pullRequestsWrite: hasPermission(permissions.pull_requests, "write"),
    checksWrite: hasPermission(permissions.checks, "write"),
    issuesWrite: hasPermission(permissions.issues, "write"),
  };
  return { ok: Object.values(requirements).every(Boolean), requirements };
}

function hasPermission(actual: string | undefined, required: "read" | "write"): boolean {
  if (required === "read") return actual === "read" || actual === "write" || actual === "admin";
  return actual === "write" || actual === "admin";
}

function renderCoverage(coverage: EvidenceCoverage): string {
  const headline = coverage.sufficient
    ? "Evidence coverage: complete for the bounded review inputs."
    : "Evidence coverage: incomplete; Gaston did not treat unavailable evidence as a clean review.";
  const counts = [
    `${coverage.totalChangedFiles} changed files`,
    `${coverage.inspectedChangedFiles} exact changed-file patches inspected`,
    `${coverage.toolCalls} repository calls`,
    `${coverage.truncatedResults} truncated results`,
    `${coverage.permanentErrors + coverage.transientErrors} tool errors`,
  ].join(" · ");
  return [
    headline,
    counts,
    ...coverage.limitations.slice(0, 8).map((limitation) => `- ${limitation}`),
  ].join("\n");
}

export async function createAppJwt(appId: string, privateKeyPem: string, now = Date.now()): Promise<string> {
  if (!/^\d+$/.test(appId)) throw new Error("GITHUB_APP_ID must be numeric");
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const issuedAt = Math.floor(now / 1_000) - 60;
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: appId })));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(privateKeyPem).buffer as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

function reviewMarker(job: ReviewJob): string {
  return `gaston-review:${job.pullNumber}:${job.baseSha}:${job.headSha}`;
}

function renderSummary(review: ReviewOutput): string {
  const lines = [review.summary];
  if (review.findings.length > 0) {
    lines.push("", "### Findings");
    for (const finding of review.findings) {
      lines.push(`- **${finding.severity.toUpperCase()}** \`${finding.path}:${finding.line}\` — ${finding.title}`);
    }
  }
  lines.push("", "_Generated by Gaston's Computer-backed harness with DeepSeek V4 Flash; only independently verified, changed-line findings are shown._");
  return lines.join("\n").slice(0, 60_000);
}

function renderInlineFinding(finding: Finding): string {
  return [
    `**${finding.severity.toUpperCase()}: ${finding.title}**`,
    "",
    finding.why,
    "",
    `Evidence: ${finding.evidence}`,
    "",
    `Suggested fix: ${finding.suggestedFix}`,
    "",
    `Confidence: ${Math.round(finding.confidence * 100)}%`,
  ].join("\n").slice(0, 60_000);
}

async function githubRequest<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await githubRawRequest(path, token, init);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function signalInit(signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? {} : { signal };
}

async function githubRawRequest(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "gaston-pr-reviewer",
        "x-github-api-version": API_VERSION,
        ...init.headers,
      },
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new GitHubApiError(
      init.method ?? "GET",
      path,
      503,
      `transport failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    const body = await response.text();
    throw new GitHubApiError(init.method ?? "GET", path, response.status, body.slice(0, 1_000));
  }
  return response;
}

function renderUnifiedDiff(files: PullFileChange[], maxBytes: number): string {
  let result = "";
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
    if (result.length + block.length > maxBytes) break;
    result += block;
  }
  return result;
}

function createChangeSet(files: PullFileChange[], truncated: boolean): PullChangeSet {
  return {
    files,
    diff: renderUnifiedDiff(files, 2_000_000),
    truncated,
  };
}

async function readBoundedText(response: Response, maxBytes: number, label: string): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte read limit`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${label} exceeds the ${maxBytes}-byte read limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (bytes.includes(0)) throw new Error(`${label} is binary`);
  return new TextDecoder("utf-8").decode(bytes);
}

function pemToBytes(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, "\n");
  const isPkcs1 = normalized.includes("-----BEGIN RSA PRIVATE KEY-----");
  const base64 = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  if (!base64) throw new Error("GITHUB_PRIVATE_KEY is empty or is not an RSA private key");
  const binary = atob(base64);
  const der = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return isPkcs1 ? wrapPkcs1AsPkcs8(der) : der;
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithmIdentifier = new Uint8Array([
    0x30, 0x0d,
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  ]);
  const privateKey = derValue(0x04, pkcs1);
  return derValue(0x30, concatenate(version, rsaAlgorithmIdentifier, privateKey));
}

function derValue(tag: number, body: Uint8Array): Uint8Array {
  return concatenate(new Uint8Array([tag]), derLength(body.length), body);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length]);
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>>= 8) bytes.unshift(remaining & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
