import type { DiffSide, Finding, ReviewOutput, Severity } from "./types.ts";

const SEVERITIES = new Set<Severity>(["blocker", "high", "medium", "low"]);
const SIDES = new Set<DiffSide>(["LEFT", "RIGHT"]);

export interface ChangedLines {
  left: Set<number>;
  right: Set<number>;
}

export function parseReviewOutput(raw: string): ReviewOutput {
  const parsed = JSON.parse(extractJson(raw)) as unknown;
  if (!isRecord(parsed)) throw new Error("review output must be a JSON object");

  const summary = cleanText(parsed.summary, 4_000) || "Reviewed the pull request.";
  if (!Array.isArray(parsed.findings)) {
    throw new Error("review output must contain a findings array");
  }

  const findings = parsed.findings.flatMap((value): Finding[] => {
    if (!isRecord(value)) return [];

    const path = normalizePath(value.path);
    const line = integer(value.line);
    const side = typeof value.side === "string" ? value.side.toUpperCase() : "RIGHT";
    const severity = typeof value.severity === "string" ? value.severity.toLowerCase() : "";
    const confidence = number(value.confidence);
    const title = cleanText(value.title, 200);
    const why = cleanText(value.why, 2_000);
    const evidence = cleanText(value.evidence, 2_000);
    const suggestedFix = cleanText(value.suggestedFix ?? value.suggested_fix, 2_000);

    if (
      !path ||
      line === null ||
      line < 1 ||
      !SIDES.has(side as DiffSide) ||
      !SEVERITIES.has(severity as Severity) ||
      confidence === null ||
      !title ||
      !why ||
      !evidence ||
      !suggestedFix
    ) {
      return [];
    }

    return [{
      path,
      line,
      side: side as DiffSide,
      severity: severity as Severity,
      title,
      why,
      evidence,
      suggestedFix,
      confidence: Math.max(0, Math.min(1, confidence)),
    }];
  });

  return { summary, findings };
}

export function filterFindings(
  review: ReviewOutput,
  changedLines: Map<string, ChangedLines>,
  minConfidence: number,
  maxFindings: number,
): ReviewOutput {
  const seen = new Set<string>();
  const findings = review.findings
    .filter((finding) => {
      if (finding.confidence < minConfidence) return false;
      const lines = changedLines.get(finding.path);
      if (!lines) return false;
      const valid = finding.side === "LEFT" ? lines.left : lines.right;
      if (!valid.has(finding.line)) return false;

      const key = `${finding.path}:${finding.side}:${finding.line}:${finding.title.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareFindings)
    .slice(0, Math.max(0, maxFindings));

  return { summary: review.summary, findings };
}

export function parseChangedLines(diff: string): Map<string, ChangedLines> {
  const result = new Map<string, ChangedLines>();
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let active: ChangedLines | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("--- ")) {
      oldPath = parseDiffPath(rawLine.slice(4), "a/");
      inHunk = false;
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      newPath = parseDiffPath(rawLine.slice(4), "b/");
      const path = newPath ?? oldPath;
      if (path) {
        active = result.get(path) ?? { left: new Set<number>(), right: new Set<number>() };
        result.set(path, active);
      } else {
        active = null;
      }
      inHunk = false;
      continue;
    }

    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }

    if (!inHunk || !active) continue;
    if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
      active.right.add(newLine++);
    } else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      active.left.add(oldLine++);
    } else if (rawLine.startsWith(" ")) {
      oldLine++;
      newLine++;
    } else if (rawLine.startsWith("diff --git ")) {
      inHunk = false;
      active = null;
      oldPath = null;
      newPath = null;
    }
  }

  return result;
}

export function shouldRequestChanges(findings: Finding[], configured: string | undefined): boolean {
  const threshold = (configured ?? "blocker").toLowerCase();
  if (threshold === "off") return false;
  if (threshold === "high") {
    return findings.some((finding) => finding.severity === "blocker" || finding.severity === "high");
  }
  return findings.some((finding) => finding.severity === "blocker");
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced?.startsWith("{") && fenced.endsWith("}")) return fenced;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("review model did not return a JSON object");
}

function parseDiffPath(value: string, prefix: string): string | null {
  const path = value.trim();
  if (path === "/dev/null") return null;
  const unquoted = path.startsWith('"') && path.endsWith('"')
    ? decodeGitQuotedPath(path.slice(1, -1))
    : path;
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : unquoted;
}

function decodeGitQuotedPath(value: string): string {
  return value
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function normalizePath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.trim().replace(/^\.\//, "").replace(/^\//, "");
  if (!path || /[\x00-\x1f\x7f\\]/.test(path) || path.split("/").includes("..")) return "";
  return path.slice(0, 1_000);
}

function compareFindings(a: Finding, b: Finding): number {
  const rank: Record<Severity, number> = { blocker: 0, high: 1, medium: 2, low: 3 };
  return rank[a.severity] - rank[b.severity] || b.confidence - a.confidence;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
