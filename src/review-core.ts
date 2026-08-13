import { mergeEvidenceCoverage, type EvidenceCoverage } from "./evidence.ts";
import type {
  DiffSide,
  Finding,
  PullFileChange,
  ReviewOutput,
  Severity,
  VerificationOutput,
  VerificationVerdict,
} from "./types.ts";

const SEVERITIES = new Set<Severity>(["blocker", "high", "medium", "low"]);
const SIDES = new Set<DiffSide>(["LEFT", "RIGHT"]);

export const DEFAULT_REVIEW_MIN_CONFIDENCE = 0.80;
export const DEFAULT_REVIEW_INCOMPLETE_EVIDENCE_MIN_CONFIDENCE = 0.88;
export const INCOMPLETE_VERIFICATION_LIMITATION = "Independent verification left one or more discovery candidates unresolved.";
export const WITHHELD_CONFIRMED_FINDING_LIMITATION = "One or more independently confirmed findings were withheld by publication policy.";
export const PRIOR_SAME_COMPARISON_FINDING_LIMITATION = "A prior Gaston review for this exact base/head comparison contains findings; a later clean stochastic rerun cannot clear them.";

export function shouldUseDirectDiscovery(
  setting: string | undefined,
  coverage: Pick<EvidenceCoverage, "sufficient">,
): boolean {
  return setting?.trim().toLowerCase() === "true" && coverage.sufficient;
}

export interface ChangedLines {
  left: Set<number>;
  right: Set<number>;
}

const VERIFICATION_CANDIDATE_PREFIX = "GASTON-CANDIDATE";

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

/**
 * Parse verifier output without dropping malformed entries. Keeping an entry's
 * candidate identity, when one is recoverable, lets the resolver turn a bad or
 * duplicate verdict into `insufficient` instead of treating omission as a
 * refutation. Only a malformed top-level envelope is repairable by the agent.
 */
export function parseVerificationOutput(raw: string): VerificationOutput {
  const parsed = JSON.parse(extractJson(raw)) as unknown;
  if (!isRecord(parsed)) throw new Error("verification output must be a JSON object");
  if (Object.keys(parsed).some((key) => key !== "summary" && key !== "verdicts")) {
    throw new Error("verification output contains unexpected top-level fields");
  }
  const summary = cleanText(parsed.summary, 4_000);
  if (!summary) throw new Error("verification output must contain a non-empty summary");
  if (!Array.isArray(parsed.verdicts)) {
    throw new Error("verification output must contain a verdicts array");
  }

  return {
    summary,
    verdicts: parsed.verdicts.map(parseVerificationVerdict),
  };
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

/**
 * Incomplete repository evidence cannot justify the same publication boundary
 * as a fully inspected review. The incomplete-evidence setting is a floor: a
 * stricter global threshold must continue to win.
 */
export function confidenceThresholdForEvidence(
  coverageSufficient: boolean,
  baseThreshold = DEFAULT_REVIEW_MIN_CONFIDENCE,
  incompleteEvidenceFloor = DEFAULT_REVIEW_INCOMPLETE_EVIDENCE_MIN_CONFIDENCE,
): number {
  return coverageSufficient
    ? baseThreshold
    : Math.max(baseThreshold, incompleteEvidenceFloor);
}

export interface CleanRerunReconciliation {
  review: ReviewOutput;
  coverage: EvidenceCoverage;
  preserveExistingSummary: boolean;
}

/**
 * A manual rerun is a new stochastic execution, not a new code comparison. A
 * clean sample therefore cannot revoke findings already published for the same
 * immutable base/head pair. Keep the new check neutral and preserve the prior
 * summary; a rerun that finds anything still follows the normal publication
 * path so newly discovered bugs are never suppressed.
 */
export function reconcileCleanRerunWithPriorReview(
  review: ReviewOutput,
  coverage: EvidenceCoverage,
  priorReviewForSameComparison: boolean,
): CleanRerunReconciliation {
  if (!priorReviewForSameComparison || review.findings.length > 0) {
    return { review, coverage, preserveExistingSummary: false };
  }
  return {
    review: {
      summary: "This rerun found no additional actionable bugs, but a prior Gaston review for this exact base/head comparison contains findings. Those findings remain in force, so this rerun is not a clean-review assertion.",
      findings: [],
    },
    coverage: {
      ...coverage,
      sufficient: false,
      limitations: [...new Set([
        PRIOR_SAME_COMPARISON_FINDING_LIMITATION,
        ...coverage.limitations,
      ])].slice(0, 20),
    },
    preserveExistingSummary: true,
  };
}

/**
 * Resolve the publication ledger and confidence boundary from separate phase
 * trackers. Verification deliberately owns a fresh evidence tracker so a cold
 * verifier cannot cite a scope that only discovery completed. Repository
 * coverage still unions both phases for the terminal check.
 */
export function publicationPolicyForEvidence(
  discoveryCoverage: EvidenceCoverage,
  verificationCoverage: EvidenceCoverage,
  verificationIncomplete: boolean,
  configuredBaseThreshold: string | undefined,
  configuredIncompleteEvidenceFloor: string | undefined,
  confirmedFindingWithheld = false,
): { coverage: EvidenceCoverage; minConfidence: number } {
  const merged = mergeEvidenceCoverage(discoveryCoverage, verificationCoverage);
  const verificationLimitations = [
    ...(verificationIncomplete ? [INCOMPLETE_VERIFICATION_LIMITATION] : []),
    ...(confirmedFindingWithheld ? [WITHHELD_CONFIRMED_FINDING_LIMITATION] : []),
  ];
  const coverage: EvidenceCoverage = verificationLimitations.length > 0
    ? {
        ...merged,
        sufficient: false,
        limitations: [...new Set([
          ...merged.limitations,
          ...verificationLimitations,
        ])].slice(0, 20),
      }
    : merged;
  const baseThreshold = boundedConfidence(
    configuredBaseThreshold,
    DEFAULT_REVIEW_MIN_CONFIDENCE,
  );
  const incompleteEvidenceFloor = boundedConfidence(
    configuredIncompleteEvidenceFloor,
    DEFAULT_REVIEW_INCOMPLETE_EVIDENCE_MIN_CONFIDENCE,
  );
  return {
    coverage,
    minConfidence: confidenceThresholdForEvidence(
      coverage.sufficient,
      baseThreshold,
      incompleteEvidenceFloor,
    ),
  };
}

function boundedConfidence(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
}

/** Give each discovery a harness-owned identity before placing it in the
 * untrusted verifier prompt. The input identity rides in the title so it stays
 * attached to the complete original claim; the verifier must copy it into the
 * required candidateId field of its separate verdict schema.
 */
export function tagVerificationCandidates(discoveries: ReviewOutput[]): ReviewOutput[] {
  let candidate = 0;
  return discoveries.map((review) => ({
    ...review,
    findings: review.findings.map((finding) => ({
      ...finding,
      title: `[${VERIFICATION_CANDIDATE_PREFIX}-${++candidate}] ${stripCandidateTag(finding.title)}`,
    })),
  }));
}

export interface VerificationResolution {
  review: ReviewOutput;
  candidateCount: number;
  confirmedCandidateIds: string[];
  refutedCandidateIds: string[];
  insufficientCandidateIds: string[];
  invalidVerdictCount: number;
  /** Ambiguity in the verifier ledger, before publication policy is applied. */
  verificationIncomplete: boolean;
  /** Confirmed candidates removed by confidence, anchor, dedupe, or count policy. */
  withheldConfirmedCandidateCount: number;
  /** Terminal completeness, including confirmed findings withheld at publication. */
  incomplete: boolean;
}

/**
 * Reduce exactly one explicit verifier verdict per discovery candidate. Any
 * ambiguity is fail-closed as `insufficient`: missing, duplicate, malformed,
 * unknown, anchor-mismatched, or unsupported entries can never refute a
 * candidate. Confirmed findings preserve discovery-authored prose and anchors;
 * only the verifier confidence crosses the trust boundary.
 */
export function resolveVerificationVerdicts(
  verification: VerificationOutput,
  discoveries: ReviewOutput[],
  completedEvidence: Pick<EvidenceCoverage, "completedEvidenceScopes" | "completedChangedPatchScopes">,
): VerificationResolution {
  const completedEvidenceScopes = new Set(completedEvidence.completedEvidenceScopes ?? []);
  const completedChangedPatchScopes = completedEvidence.completedChangedPatchScopes ?? [];
  const candidates = new Map(discoveries.flatMap((review) => review.findings.flatMap((finding) => {
    const id = candidateId(finding.title);
    return id === undefined ? [] : [[id, finding] as const];
  })));
  const entries = new Map<string, VerificationVerdict[]>();
  let invalidVerdictCount = 0;
  for (const verdict of verification.verdicts) {
    if (!verdict.candidateId || !candidates.has(verdict.candidateId)) {
      invalidVerdictCount++;
      continue;
    }
    const current = entries.get(verdict.candidateId) ?? [];
    current.push(verdict);
    entries.set(verdict.candidateId, current);
  }

  const findings: Finding[] = [];
  const confirmedCandidateIds: string[] = [];
  const refutedCandidateIds: string[] = [];
  const insufficientCandidateIds: string[] = [];
  for (const [id, candidate] of candidates) {
    const candidateVerdicts = entries.get(id) ?? [];
    if (candidateVerdicts.length !== 1) {
      insufficientCandidateIds.push(id);
      continue;
    }
    const [verdict] = candidateVerdicts;
    if (
      verdict === undefined
      || !verdict.valid
      || verdict.path !== candidate.path
      || verdict.side !== candidate.side
      || verdict.line !== candidate.line
      || verdict.verdict === null
    ) {
      insufficientCandidateIds.push(id);
      continue;
    }
    if (verdict.verdict === "insufficient") {
      insufficientCandidateIds.push(id);
      continue;
    }
    // Both terminal verdicts need a complete, auditable evidence claim, and
    // every model-cited scope must exist in the harness-owned effective
    // completion ledger. Unsupported `refuted` output is deliberately not a
    // veto, even when the model labels its own evidence complete.
    if (
      verdict.evidenceComplete !== true
      || !verdict.evidence
      || verdict.evidenceScopes.length === 0
      || verdict.evidenceScopes.some((scope) => !completedEvidenceScopes.has(scope))
      || !verdict.evidenceScopes.some((scope) => completedChangedPatchScopes.some((entry) => (
        entry.scope === scope
        && entry.path === candidate.path
        && (
          entry.kind === "complete_patch"
          || entry.kind === "source"
            && entry.sourceLine === candidate.line
            && entry.sourceSide === candidate.side
        )
      )))
    ) {
      insufficientCandidateIds.push(id);
      continue;
    }
    if (verdict.verdict === "refuted") {
      refutedCandidateIds.push(id);
      continue;
    }
    confirmedCandidateIds.push(id);
    findings.push({
      ...candidate,
      title: stripCandidateTag(candidate.title),
      confidence: verdict.confidence!,
    });
  }

  const verificationIncomplete = insufficientCandidateIds.length > 0 || invalidVerdictCount > 0;
  return {
    review: { summary: verification.summary, findings },
    candidateCount: candidates.size,
    confirmedCandidateIds,
    refutedCandidateIds,
    insufficientCandidateIds,
    invalidVerdictCount,
    verificationIncomplete,
    withheldConfirmedCandidateCount: 0,
    incomplete: verificationIncomplete,
  };
}

export interface VerificationPublicationOptions {
  changedLines: Map<string, ChangedLines>;
  discoveryCoverage: EvidenceCoverage;
  verificationCoverage: EvidenceCoverage;
  configuredBaseThreshold: string | undefined;
  configuredIncompleteEvidenceFloor: string | undefined;
  maxFindings: number;
}

export interface FinalizedVerificationPublication {
  review: ReviewOutput;
  coverage: EvidenceCoverage;
  minConfidence: number;
  resolution: VerificationResolution;
}

/**
 * Apply terminal publication policy and reconcile it back into completeness.
 * Every finding in resolution.review already has a complete, candidate-bound
 * verifier proof, so unrelated repository or candidate limitations must not
 * raise that finding's confidence threshold. Those limitations still keep the
 * aggregate review non-clean and remain visible in coverage.
 */
export function finalizeVerificationPublication(
  resolution: VerificationResolution,
  options: VerificationPublicationOptions,
): FinalizedVerificationPublication {
  const confirmedFindingThreshold = boundedConfidence(
    options.configuredBaseThreshold,
    DEFAULT_REVIEW_MIN_CONFIDENCE,
  );
  let policy = publicationPolicyForEvidence(
    options.discoveryCoverage,
    options.verificationCoverage,
    resolution.verificationIncomplete,
    options.configuredBaseThreshold,
    options.configuredIncompleteEvidenceFloor,
  );
  let filtered = filterFindings(
    resolution.review,
    options.changedLines,
    confirmedFindingThreshold,
    options.maxFindings,
  );
  let reconciled = reconcilePublishedConfirmations(resolution, filtered);

  if (reconciled.withheldConfirmedCandidateCount > 0) {
    policy = publicationPolicyForEvidence(
      options.discoveryCoverage,
      options.verificationCoverage,
      resolution.verificationIncomplete,
      options.configuredBaseThreshold,
      options.configuredIncompleteEvidenceFloor,
      true,
    );
    filtered = filterFindings(
      resolution.review,
      options.changedLines,
      confirmedFindingThreshold,
      options.maxFindings,
    );
    reconciled = reconcilePublishedConfirmations(resolution, filtered);
  }

  return {
    review: summarizeVerificationPublication(filtered, reconciled),
    coverage: policy.coverage,
    minConfidence: confirmedFindingThreshold,
    resolution: reconciled,
  };
}

function reconcilePublishedConfirmations(
  resolution: VerificationResolution,
  published: ReviewOutput,
): VerificationResolution {
  const withheldConfirmedCandidateCount = Math.max(
    0,
    resolution.confirmedCandidateIds.length - published.findings.length,
  );
  return {
    ...resolution,
    withheldConfirmedCandidateCount,
    incomplete: resolution.verificationIncomplete || withheldConfirmedCandidateCount > 0,
  };
}

/** Ensure an incomplete verifier response can never be presented as clean or disproved. */
export function summarizeVerificationPublication(
  review: ReviewOutput,
  resolution: VerificationResolution,
): ReviewOutput {
  if (resolution.incomplete) {
    const unresolved = resolution.insufficientCandidateIds.length;
    const invalid = resolution.invalidVerdictCount;
    const withheld = resolution.withheldConfirmedCandidateCount;
    const details = [
      ...(unresolved === 0
        ? []
        : [`${unresolved} candidate${unresolved === 1 ? "" : "s"} lacked one valid, complete verdict`]),
      ...(invalid === 0
        ? []
        : [`${invalid} verifier entr${invalid === 1 ? "y was" : "ies were"} unknown or malformed`]),
      ...(withheld === 0
        ? []
        : [`${withheld} independently confirmed candidate${withheld === 1 ? " was" : "s were"} withheld by publication policy`]),
    ].join("; ");
    const publication = review.findings.length === 0
      ? withheld > 0
        ? "No finding was published; policy-withheld confirmations keep this review non-clean."
        : "No unresolved candidate was published."
      : `${review.findings.length} independently confirmed finding${review.findings.length === 1 ? " was" : "s were"} published; incomplete or policy-withheld candidates were not published.`;
    return {
      summary: `Verification incomplete: ${details || "the verifier response was ambiguous"}. ${publication}`,
      findings: review.findings,
    };
  }
  if (review.findings.length === 0) {
    return {
      summary: resolution.refutedCandidateIds.length === resolution.candidateCount
        ? "No actionable bugs survived independent verification; every candidate was refuted with complete repository evidence."
        : "No actionable bugs survived independent verification and changed-line validation.",
      findings: [],
    };
  }
  return review;
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
    if (rawLine.startsWith("diff --git ")) {
      inHunk = false;
      active = null;
      oldPath = null;
      newPath = null;
      continue;
    }

    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }

    // Once a hunk starts, a source line whose content begins with ++ or -- is
    // encoded as +++... or ---.... It is code, not a file header.
    if (inHunk && active) {
      if (rawLine.startsWith("+")) {
        active.right.add(newLine++);
      } else if (rawLine.startsWith("-")) {
        active.left.add(oldLine++);
      } else if (rawLine.startsWith(" ")) {
        oldLine++;
        newLine++;
      }
      continue;
    }

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
  }

  return result;
}

export function parseChangedFileLines(files: PullFileChange[]): Map<string, ChangedLines> {
  const result = new Map<string, ChangedLines>();
  for (const file of files) {
    if (!file.patch) continue;
    const oldPath = file.status === "added" ? "/dev/null" : `a/${file.previousPath ?? file.path}`;
    const newPath = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
    const parsed = parseChangedLines([
      `--- ${oldPath}`,
      `+++ ${newPath}`,
      file.patch,
    ].join("\n"));
    for (const [path, lines] of parsed) {
      const current = result.get(path) ?? { left: new Set<number>(), right: new Set<number>() };
      for (const line of lines.left) current.left.add(line);
      for (const line of lines.right) current.right.add(line);
      result.set(path, current);
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

function candidateId(title: string): string | undefined {
  return title.match(new RegExp(`^\\[(${VERIFICATION_CANDIDATE_PREFIX}-\\d+)\\]\\s+`))?.[1];
}

function parseVerificationVerdict(value: unknown): VerificationVerdict {
  const record = isRecord(value) ? value : {};
  const expectedKeys = new Set([
    "candidateId",
    "verdict",
    "path",
    "line",
    "side",
    "confidence",
    "rationale",
    "evidence",
    "evidenceComplete",
    "evidenceScopes",
  ]);
  const candidateIdValue = cleanText(record.candidateId, 100);
  const candidateId = /^GASTON-CANDIDATE-[1-9]\d*$/.test(candidateIdValue)
    ? candidateIdValue
    : "";
  const verdict = record.verdict === "confirmed"
      || record.verdict === "refuted"
      || record.verdict === "insufficient"
    ? record.verdict
    : null;
  const path = normalizePath(record.path);
  const line = integer(record.line);
  const side = record.side === "LEFT" || record.side === "RIGHT" ? record.side : null;
  const confidence = number(record.confidence);
  const rationale = cleanText(record.rationale, 2_000);
  const evidence = cleanText(record.evidence, 2_000);
  const evidenceComplete = typeof record.evidenceComplete === "boolean"
    ? record.evidenceComplete
    : null;
  const evidenceScopes = Array.isArray(record.evidenceScopes)
    ? record.evidenceScopes.map((scope) => cleanText(scope, 500)).filter(Boolean)
    : [];
  const scopesValid = Array.isArray(record.evidenceScopes)
    && record.evidenceScopes.every((scope) => typeof scope === "string" && cleanText(scope, 500).length > 0)
    && new Set(evidenceScopes).size === evidenceScopes.length;
  const confidenceValid = confidence !== null && confidence >= 0 && confidence <= 1;
  const valid = isRecord(value)
    && Object.keys(record).every((key) => expectedKeys.has(key))
    && Object.keys(record).length === expectedKeys.size
    && candidateId.length > 0
    && verdict !== null
    && path.length > 0
    && line !== null
    && line > 0
    && side !== null
    && confidenceValid
    && rationale.length > 0
    && evidenceComplete !== null
    && scopesValid;
  return {
    candidateId,
    verdict,
    path,
    line,
    side,
    confidence: confidenceValid ? confidence : null,
    rationale,
    evidence,
    evidenceComplete,
    evidenceScopes,
    valid,
  };
}

function stripCandidateTag(title: string): string {
  return title.replace(new RegExp(`^\\[${VERIFICATION_CANDIDATE_PREFIX}-\\d+\\]\\s+`), "");
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
