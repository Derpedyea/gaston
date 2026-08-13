import type { Finding, ReviewOutput } from "./types.ts";

export interface RecentPrBenchLabel {
  id: string;
  path: string;
  side: "LEFT" | "RIGHT";
  lineStart: number;
  lineEnd: number;
  rootCause: string;
  requiredTermGroups: string[][];
  reviewUrl: string;
  fixSha: string;
}

export interface RecentPrBenchCase {
  id: string;
  repository: string;
  pullNumber: number;
  title: string;
  baseSha: string;
  headSha: string;
  bots: string[];
  labels: RecentPrBenchLabel[];
}

export interface RecentPrBenchCorpus {
  schemaVersion: number;
  name: string;
  frozenAt: string;
  description: string;
  cases: RecentPrBenchCase[];
}

export interface RecentPrFindingMatch {
  findingIndex: number;
  labelId: string;
  pathMatched: boolean;
  sideMatched: boolean;
  lineMatched: boolean;
  matchedTermGroups: boolean[];
  exactMatch: boolean;
}

export interface RecentPrCaseScore {
  labels: number;
  deterministicTruePositives: number;
  deterministicFalseNegatives: number;
  unmatchedFindingsPendingAdjudication: number;
  matches: RecentPrFindingMatch[];
}

/**
 * Deterministic lower-bound scorer for a public, consumed regression corpus.
 * Unmatched findings are deliberately not called false positives: real PRs
 * can contain legitimate defects outside the frozen bot-derived labels.
 */
export function scoreRecentPrCase(
  fixture: RecentPrBenchCase,
  output: ReviewOutput,
): RecentPrCaseScore {
  const possible = output.findings.flatMap((finding, findingIndex) => (
    fixture.labels.map((label) => matchFinding(finding, findingIndex, label))
  ));
  const selected: RecentPrFindingMatch[] = [];
  const usedFindings = new Set<number>();
  for (const label of fixture.labels) {
    const match = possible.find((candidate) => (
      candidate.labelId === label.id
      && candidate.exactMatch
      && !usedFindings.has(candidate.findingIndex)
    ));
    if (!match) continue;
    selected.push(match);
    usedFindings.add(match.findingIndex);
  }
  return {
    labels: fixture.labels.length,
    deterministicTruePositives: selected.length,
    deterministicFalseNegatives: fixture.labels.length - selected.length,
    unmatchedFindingsPendingAdjudication: output.findings.length - usedFindings.size,
    matches: possible,
  };
}

export function aggregateRecentPrScores(
  cases: Array<{ score: RecentPrCaseScore; output: ReviewOutput; costUsd: number; elapsedMs: number; failed?: boolean }>,
) {
  const labels = sum(cases.map((entry) => entry.score.labels));
  const deterministicTruePositives = sum(cases.map((entry) => entry.score.deterministicTruePositives));
  const publishedFindings = sum(cases.map((entry) => entry.output.findings.length));
  const unmatchedFindingsPendingAdjudication = sum(
    cases.map((entry) => entry.score.unmatchedFindingsPendingAdjudication),
  );
  return {
    cases: cases.length,
    failedCases: cases.filter((entry) => entry.failed).length,
    labels,
    deterministicTruePositives,
    deterministicFalseNegatives: labels - deterministicTruePositives,
    deterministicRecallLowerBound: ratio(deterministicTruePositives, labels),
    publishedFindings,
    unmatchedFindingsPendingAdjudication,
    strictPrecisionLowerBound: ratio(deterministicTruePositives, publishedFindings),
    totalCostUsd: Number(sum(cases.map((entry) => entry.costUsd)).toFixed(8)),
    medianElapsedMs: percentile(cases.map((entry) => entry.elapsedMs), 0.5),
  };
}

function matchFinding(
  finding: Finding,
  findingIndex: number,
  label: RecentPrBenchLabel,
): RecentPrFindingMatch {
  const text = [finding.title, finding.why, finding.evidence, finding.suggestedFix]
    .join(" ")
    .toLowerCase();
  const pathMatched = finding.path === label.path;
  const sideMatched = finding.side === label.side;
  const lineMatched = finding.line >= label.lineStart && finding.line <= label.lineEnd;
  const matchedTermGroups = label.requiredTermGroups.map((terms) => (
    terms.some((term) => text.includes(term.toLowerCase()))
  ));
  return {
    findingIndex,
    labelId: label.id,
    pathMatched,
    sideMatched,
    lineMatched,
    matchedTermGroups,
    exactMatch: pathMatched && sideMatched && lineMatched && matchedTermGroups.every(Boolean),
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}
