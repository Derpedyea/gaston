export type EvidenceStatus =
  | "ok"
  | "truncated"
  | "transient_error"
  | "permanent_error"
  | "invalid_arguments";

export interface EvidenceSlice {
  scope: string;
  complete: boolean;
  /** Discovery-only evidence may be incomplete without making exact patch
   * coverage globally insufficient. It can never certify a verifier verdict. */
  advisory?: boolean;
  /** A broader retry identity used only to clear a corrected tool hazard. */
  resolutionScope?: string;
  offset?: number;
  requested?: number;
  returned?: number;
  total?: number;
  /** An adaptive changed-files response returned this exact prefix intact. */
  returnedRangeComplete?: boolean;
  /** Exact patch coordinates are one-based and inclusive. */
  patchStartLine?: number;
  patchEndLine?: number;
  totalPatchLines?: number;
  patchIntervalComplete?: boolean;
  /** The next advertised exact patch slice; both endpoints are one-based and inclusive. */
  nextPatchStartLine?: number;
  nextPatchEndLine?: number;
  sourceTargeted?: boolean;
  sourceLine?: number;
  sourceSide?: "LEFT" | "RIGHT";
  changedPath?: string;
}

export interface EvidenceResult {
  status: EvidenceStatus;
  content: string;
  retryable: boolean;
  errorCode?: string;
  evidence?: EvidenceSlice;
  suggestedAction?: string;
  /** Kept for compatibility with older adapters; status is authoritative. */
  isError?: boolean;
}

export interface EvidenceCoverage {
  sufficient: boolean;
  totalChangedFiles: number;
  inspectedChangedFiles: number;
  /** Exact paths are retained so cached discovery and verification cannot double-count one patch. */
  inspectedChangedPaths?: string[];
  toolCalls: number;
  okResults: number;
  truncatedResults: number;
  transientErrors: number;
  permanentErrors: number;
  invalidArguments: number;
  initialDiffTruncated: boolean;
  limitations: string[];
  /** Structured state lets a later retry resolve a cached scoped limitation. */
  unresolvedEvidence?: UnresolvedEvidenceSnapshot[];
  completedEvidenceScopes?: string[];
  /** Structured identity for completed patch evidence; scope strings alone
   * are ambiguous because repository paths may contain colons or range-like
   * suffixes. Verifier trust uses this path binding, never string parsing. */
  completedChangedPatchScopes?: CompletedChangedPatchScope[];
  completeChangedFileRanges?: ChangedFileRange[];
  /** Exact non-source-targeted patch slices, retained for cross-phase union. */
  changedPatchCoverage?: ChangedPatchCoverage[];
}

export interface UnresolvedEvidenceSnapshot {
  scope: string;
  status: EvidenceStatus;
  limitation: string;
  changedFileRange?: ChangedFileRange;
  changedPatchPath?: string;
  /** A one-based, half-open patch interval that supersedes this limitation. */
  changedPatchRange?: ChangedFileRange;
}

export interface EvidenceTools {
  invoke(name: string, rawArguments: string, signal?: AbortSignal): Promise<EvidenceResult>;
  coverage?(): EvidenceCoverage;
}

interface CoverageOptions {
  totalChangedFiles: number;
  initialDiffTruncated: boolean;
  changedFileListingTruncated?: boolean;
  unavailablePatchPaths?: readonly string[];
}

export interface ChangedFileRange {
  start: number;
  end: number;
}

export interface ChangedPatchCoverage {
  path: string;
  totalPatchLines: number;
  /** One-based, half-open patch-line intervals. */
  intervals: ChangedFileRange[];
}

export interface CompletedChangedPatchScope {
  scope: string;
  path: string;
  /** A bounded patch scope has recovered its immediate truncation hazard, but
   * cannot certify an arbitrary candidate anchor until the whole patch union
   * is complete. */
  kind: "complete_patch" | "bounded_patch" | "source";
  sourceLine?: number;
  sourceSide?: "LEFT" | "RIGHT";
}

const MAX_REQUIRED_PATCHES_FOR_TRUNCATED_DIFF = 2;
export const INITIAL_DIFF_RECOVERY_LIMITATION_PREFIX = "The initial cumulative diff was truncated;";

/**
 * Accumulates observable evidence quality behind one small interface. A later
 * complete result for the same scope resolves an earlier tool hazard, while
 * source-level truncation remains visible for the whole review.
 */
export class EvidenceCoverageTracker {
  readonly #options: CoverageOptions;
  readonly #inspectedChangedFiles = new Set<string>();
  readonly #unresolved = new Map<string, {
    status: EvidenceStatus;
    limitation: string;
    changedFileRange?: ChangedFileRange;
    changedPatchPath?: string;
    changedPatchRange?: ChangedFileRange;
  }>();
  readonly #completedScopes = new Set<string>();
  readonly #completedChangedPatchScopes = new Map<string, CompletedChangedPatchScope>();
  #completeChangedFileRanges: ChangedFileRange[] = [];
  readonly #changedPatchCoverage = new Map<string, ChangedPatchCoverage>();
  #toolCalls = 0;
  #okResults = 0;
  #truncatedResults = 0;
  #transientErrors = 0;
  #permanentErrors = 0;
  #invalidArguments = 0;

  constructor(options: CoverageOptions) {
    this.#options = options;
  }

  record(tool: string, result: EvidenceResult, changedPath?: string): void {
    this.#toolCalls++;
    switch (result.status) {
      case "ok":
        this.#okResults++;
        break;
      case "truncated":
        this.#truncatedResults++;
        break;
      case "transient_error":
        this.#transientErrors++;
        break;
      case "permanent_error":
        this.#permanentErrors++;
        break;
      case "invalid_arguments":
        this.#invalidArguments++;
        break;
    }

    const scope = result.evidence?.scope ?? tool;
    const resolutionScope = result.evidence?.resolutionScope;
    const canonicalChangedPath = result.evidence?.changedPath ?? changedPath;
    if (tool === "changed_files" && result.evidence?.returnedRangeComplete === true) {
      const range = changedFileRange(result.evidence);
      if (range) {
        this.#completeChangedFileRanges = mergeRanges([...this.#completeChangedFileRanges, range]);
        this.#resolveCoveredChangedFileRanges();
      }
    }
    if (
      tool === "diff_for_file"
      && canonicalChangedPath
      && (result.status === "ok" || result.status === "truncated")
      && result.evidence?.sourceTargeted !== true
      && result.evidence?.patchIntervalComplete === true
    ) {
      this.#recordPatchInterval(canonicalChangedPath, result.evidence);
    }
    if (result.status === "ok" && result.evidence?.complete !== false) {
      this.#completedScopes.add(scope);
      if (tool === "diff_for_file" && canonicalChangedPath) {
        this.#recordCompletedPatchScope(scope, canonicalChangedPath, result.evidence);
      }
      this.#unresolved.delete(scope);
      if (resolutionScope) {
        this.#completedScopes.add(resolutionScope);
        if (tool === "diff_for_file" && canonicalChangedPath) {
          this.#recordCompletedPatchScope(resolutionScope, canonicalChangedPath, result.evidence);
        }
        this.#unresolved.delete(resolutionScope);
      }
      if (tool === "changed_files") {
        const range = changedFileRange(result.evidence);
        if (range) {
          this.#completeChangedFileRanges = mergeRanges([...this.#completeChangedFileRanges, range]);
          this.#resolveCoveredChangedFileRanges();
        }
      }
      return;
    }

    if (result.status !== "ok") {
      // Tree/search indexes help locate exact evidence, but an incomplete
      // index is not itself a missing changed-patch proof. Keep the status in
      // diagnostics while preventing speculative browsing from poisoning the
      // whole review's coverage. Because it is not completed, a verifier
      // still cannot cite this scope for a terminal verdict.
      if (result.evidence?.advisory === true) return;
      const range = tool === "changed_files"
        ? result.evidence?.returnedRangeComplete === true
          ? missingChangedFileRange(result.evidence)
          : changedFileRange(result.evidence)
        : undefined;
      const unresolvedScope = result.status === "invalid_arguments"
        ? resolutionScope ?? scope
        : scope;
      const changedPatchRange = tool === "diff_for_file"
        && canonicalChangedPath
        && result.evidence?.sourceTargeted !== true
        && result.evidence?.patchIntervalComplete === true
          ? advertisedPatchRange(result.evidence)
          : undefined;
      this.#unresolved.set(unresolvedScope, {
        status: result.status,
        limitation: result.suggestedAction
          ? `${tool}: ${result.suggestedAction}`
          : `${tool}: ${result.status.replaceAll("_", " ")}`,
        ...(range === undefined ? {} : { changedFileRange: range }),
        ...(tool === "diff_for_file"
          && canonicalChangedPath
          && result.evidence?.sourceTargeted !== true
            ? { changedPatchPath: canonicalChangedPath }
            : {}),
        ...(changedPatchRange === undefined ? {} : { changedPatchRange }),
      });
      this.#resolveCoveredChangedFileRanges();
      this.#resolveCoveredChangedPatches();
    }
  }

  #recordPatchInterval(path: string, evidence: EvidenceSlice): void {
    const start = evidence.patchStartLine;
    const inclusiveEnd = evidence.patchEndLine;
    const total = evidence.totalPatchLines;
    if (
      start === undefined
      || inclusiveEnd === undefined
      || total === undefined
      || !Number.isInteger(start)
      || !Number.isInteger(inclusiveEnd)
      || !Number.isInteger(total)
      || start < 1
      || inclusiveEnd < start
      || total < inclusiveEnd
    ) return;

    const previous = this.#changedPatchCoverage.get(path);
    const totalPatchLines = Math.max(total, previous?.totalPatchLines ?? 0);
    const intervals = mergeRanges([
      ...(previous?.intervals ?? []),
      { start, end: inclusiveEnd + 1 },
    ]);
    this.#changedPatchCoverage.set(path, { path, totalPatchLines, intervals });
    if (rangeCovered({ start: 1, end: totalPatchLines + 1 }, intervals)) {
      this.#inspectedChangedFiles.add(path);
      for (const [scope, entry] of this.#completedChangedPatchScopes) {
        if (entry.path === path && entry.kind === "bounded_patch") {
          this.#completedChangedPatchScopes.set(scope, { ...entry, kind: "complete_patch" });
        }
      }
      const completePatchScope = `diff_for_file:${path}:complete-patch`;
      this.#completedScopes.add(completePatchScope);
      this.#completedChangedPatchScopes.set(completePatchScope, {
        scope: completePatchScope,
        path,
        kind: "complete_patch",
      });
    }
    this.#resolveCoveredChangedPatches();
  }

  #resolveCoveredChangedFileRanges(): void {
    for (const [scope, unresolved] of this.#unresolved) {
      if (
        unresolved.changedFileRange
        && rangeCovered(unresolved.changedFileRange, this.#completeChangedFileRanges)
      ) {
        this.#unresolved.delete(scope);
        this.#completedScopes.add(scope);
      }
    }
  }

  #resolveCoveredChangedPatches(): void {
    for (const [scope, unresolved] of this.#unresolved) {
      if (!unresolved.changedPatchPath) continue;
      const coverage = this.#changedPatchCoverage.get(unresolved.changedPatchPath);
      const advertisedRangeCovered = unresolved.changedPatchRange !== undefined
        && coverage !== undefined
        && rangeCovered(unresolved.changedPatchRange, coverage.intervals);
      const completePatchCovered = this.#inspectedChangedFiles.has(unresolved.changedPatchPath);
      if (advertisedRangeCovered || completePatchCovered) {
        this.#unresolved.delete(scope);
        this.#completedScopes.add(scope);
        this.#completedChangedPatchScopes.set(scope, {
          scope,
          path: unresolved.changedPatchPath,
          kind: completePatchCovered ? "complete_patch" : "bounded_patch",
        });
      }
    }
  }

  #recordCompletedPatchScope(scope: string, path: string, evidence: EvidenceSlice | undefined): void {
    if (
      evidence?.sourceTargeted === true
      && evidence.sourceLine !== undefined
      && evidence.sourceSide !== undefined
    ) {
      this.#completedChangedPatchScopes.set(scope, {
        scope,
        path,
        kind: "source",
        sourceLine: evidence.sourceLine,
        sourceSide: evidence.sourceSide,
      });
      return;
    }
    this.#completedChangedPatchScopes.set(scope, { scope, path, kind: "complete_patch" });
  }

  snapshot(): EvidenceCoverage {
    const unresolved = [...this.#unresolved.values()];
    const requiredPatches = requiredPatchesForTruncatedDiff(
      this.#options.totalChangedFiles,
      this.#options.initialDiffTruncated,
    );
    const missingPatches = Math.max(0, requiredPatches - this.#inspectedChangedFiles.size);
    const unavailablePatchCount = new Set(this.#options.unavailablePatchPaths ?? []).size;
    const limitations = [
      ...(this.#options.changedFileListingTruncated
        ? ["GitHub truncated the changed-file listing, so some changed paths may be unavailable."]
        : []),
      ...(unavailablePatchCount > 0
        ? [unavailablePatchLimitation(unavailablePatchCount)]
        : []),
      ...(missingPatches > 0
        ? [initialDiffRecoveryLimitation(missingPatches)]
        : []),
      ...unresolved.map((entry) => entry.limitation),
    ];
    return {
      sufficient: limitations.length === 0,
      totalChangedFiles: this.#options.totalChangedFiles,
      inspectedChangedFiles: this.#inspectedChangedFiles.size,
      inspectedChangedPaths: [...this.#inspectedChangedFiles].sort(),
      toolCalls: this.#toolCalls,
      okResults: this.#okResults,
      truncatedResults: this.#truncatedResults,
      transientErrors: this.#transientErrors,
      permanentErrors: this.#permanentErrors,
      invalidArguments: this.#invalidArguments,
      initialDiffTruncated: this.#options.initialDiffTruncated,
      limitations: [...new Set(limitations)].slice(0, 20),
      unresolvedEvidence: [...this.#unresolved.entries()].map(([scope, entry]) => ({
        scope,
        status: entry.status,
        limitation: entry.limitation,
        ...(entry.changedFileRange === undefined ? {} : { changedFileRange: { ...entry.changedFileRange } }),
        ...(entry.changedPatchPath === undefined ? {} : { changedPatchPath: entry.changedPatchPath }),
        ...(entry.changedPatchRange === undefined ? {} : { changedPatchRange: { ...entry.changedPatchRange } }),
      })),
      completedEvidenceScopes: [...this.#completedScopes].sort(),
      completedChangedPatchScopes: [...this.#completedChangedPatchScopes.values()]
        .sort((left, right) => left.scope.localeCompare(right.scope) || left.path.localeCompare(right.path)),
      completeChangedFileRanges: this.#completeChangedFileRanges.map((range) => ({ ...range })),
      changedPatchCoverage: [...this.#changedPatchCoverage.values()]
        .map((entry) => ({
          path: entry.path,
          totalPatchLines: entry.totalPatchLines,
          intervals: entry.intervals.map((range) => ({ ...range })),
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  }
}

function changedFileRange(evidence: EvidenceSlice | undefined): ChangedFileRange | undefined {
  if (
    evidence?.offset === undefined
    || evidence.returned === undefined
    || !Number.isInteger(evidence.offset)
    || !Number.isInteger(evidence.returned)
    || evidence.offset < 0
    || evidence.returned <= 0
  ) {
    return undefined;
  }
  return { start: evidence.offset, end: evidence.offset + evidence.returned };
}

function missingChangedFileRange(evidence: EvidenceSlice | undefined): ChangedFileRange | undefined {
  if (
    evidence?.offset === undefined
    || evidence.requested === undefined
    || evidence.returned === undefined
    || evidence.total === undefined
    || !Number.isInteger(evidence.offset)
    || !Number.isInteger(evidence.requested)
    || !Number.isInteger(evidence.returned)
    || !Number.isInteger(evidence.total)
    || evidence.offset < 0
    || evidence.requested < 1
    || evidence.returned < 0
    || evidence.total < 0
  ) {
    return undefined;
  }
  const start = evidence.offset + evidence.returned;
  const end = Math.min(evidence.offset + evidence.requested, evidence.total);
  return end > start ? { start, end } : undefined;
}

function advertisedPatchRange(evidence: EvidenceSlice | undefined): ChangedFileRange | undefined {
  const start = evidence?.nextPatchStartLine;
  const inclusiveEnd = evidence?.nextPatchEndLine;
  if (
    start === undefined
    || inclusiveEnd === undefined
    || !Number.isInteger(start)
    || !Number.isInteger(inclusiveEnd)
    || start < 1
    || inclusiveEnd < start
  ) {
    return undefined;
  }
  return { start, end: inclusiveEnd + 1 };
}

function mergeRanges(ranges: ChangedFileRange[]): ChangedFileRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: ChangedFileRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  return merged;
}

function rangeCovered(target: ChangedFileRange, complete: ChangedFileRange[]): boolean {
  return complete.some((range) => range.start <= target.start && range.end >= target.end);
}

function unavailablePatchLimitation(count: number): string {
  return `GitHub omitted exact patches for ${count} changed ${count === 1 ? "file" : "files"}; those source changes remain unavailable for complete evidence.`;
}

export function requiredPatchesForTruncatedDiff(
  totalChangedFiles: number,
  initialDiffTruncated: boolean,
): number {
  if (!initialDiffTruncated) return 0;
  return Math.min(Math.max(0, totalChangedFiles), MAX_REQUIRED_PATCHES_FOR_TRUNCATED_DIFF);
}

export function initialDiffRecoveryLimitation(missingPatches: number): string {
  return `${INITIAL_DIFF_RECOVERY_LIMITATION_PREFIX} inspect ${missingPatches} more exact changed-file ${missingPatches === 1 ? "patch" : "patches"}.`;
}

export function mergeEvidenceCoverage(left: EvidenceCoverage, right: EvidenceCoverage): EvidenceCoverage {
  const totalChangedFiles = Math.max(left.totalChangedFiles, right.totalChangedFiles);
  const changedPatchCoverage = mergeChangedPatchCoverage([
    ...(left.changedPatchCoverage ?? []),
    ...(right.changedPatchCoverage ?? []),
  ]);
  const completelyCoveredPaths = changedPatchCoverage
    .filter((entry) => patchCoverageComplete(entry))
    .map((entry) => entry.path);
  const inspectedChangedPaths = [...new Set([
    ...completelyCoveredPaths,
    // A checkpoint without interval state predates exact slice accounting.
    // Preserve its path claims, but never infer additional paths from counts.
    ...(left.changedPatchCoverage === undefined ? left.inspectedChangedPaths ?? [] : []),
    ...(right.changedPatchCoverage === undefined ? right.inspectedChangedPaths ?? [] : []),
  ])].sort();
  const legacyUnknownCount = Math.max(
    left.changedPatchCoverage === undefined ? left.inspectedChangedFiles : 0,
    right.changedPatchCoverage === undefined ? right.inspectedChangedFiles : 0,
  );
  // Old persisted checkpoints may lack path identities. Taking the maximum is
  // deliberately conservative: summing could count the same patch twice.
  const inspectedChangedFiles = Math.min(
    totalChangedFiles,
    Math.max(inspectedChangedPaths.length, legacyUnknownCount),
  );
  const initialDiffTruncated = left.initialDiffTruncated || right.initialDiffTruncated;
  const missingPatches = Math.max(
    0,
    requiredPatchesForTruncatedDiff(totalChangedFiles, initialDiffTruncated) - inspectedChangedFiles,
  );
  const structuredEntries = [
    ...(left.unresolvedEvidence ?? []),
    ...(right.unresolvedEvidence ?? []),
  ];
  const completedEvidenceScopeSet = new Set([
    ...(left.completedEvidenceScopes ?? []),
    ...(right.completedEvidenceScopes ?? []),
    ...completelyCoveredPaths.map((path) => `diff_for_file:${path}:complete-patch`),
  ]);
  const completedChangedPatchScopeMap = new Map<string, CompletedChangedPatchScope>();
  for (const entry of [
    ...(left.completedChangedPatchScopes ?? []),
    ...(right.completedChangedPatchScopes ?? []),
    ...completelyCoveredPaths.map((path) => ({
      scope: `diff_for_file:${path}:complete-patch`,
      path,
      kind: "complete_patch" as const,
    })),
  ]) {
    if (
      typeof entry.scope === "string"
      && entry.scope
      && typeof entry.path === "string"
      && entry.path
      && (entry.kind === "complete_patch" || entry.kind === "bounded_patch" || entry.kind === "source")
    ) {
      completedChangedPatchScopeMap.set(entry.scope, (
        entry.kind === "bounded_patch" && inspectedChangedPaths.includes(entry.path)
          ? { ...entry, kind: "complete_patch" }
          : entry
      ));
    }
  }
  const completeChangedFileRanges = mergeRanges([
    ...(left.completeChangedFileRanges ?? []),
    ...(right.completeChangedFileRanges ?? []),
  ]);
  const unresolvedByScope = new Map<string, UnresolvedEvidenceSnapshot>();
  for (const entry of structuredEntries) unresolvedByScope.set(entry.scope, entry);
  for (const scope of completedEvidenceScopeSet) unresolvedByScope.delete(scope);
  for (const [scope, entry] of unresolvedByScope) {
    if (entry.changedFileRange && rangeCovered(entry.changedFileRange, completeChangedFileRanges)) {
      unresolvedByScope.delete(scope);
      completedEvidenceScopeSet.add(scope);
      continue;
    }
    if (
      entry.changedPatchPath
      && (
        inspectedChangedPaths.includes(entry.changedPatchPath)
        || entry.changedPatchRange !== undefined
          && changedPatchRangeCovered(entry.changedPatchPath, entry.changedPatchRange, changedPatchCoverage)
      )
    ) {
      const completePatchCovered = inspectedChangedPaths.includes(entry.changedPatchPath);
      unresolvedByScope.delete(scope);
      completedEvidenceScopeSet.add(scope);
      completedChangedPatchScopeMap.set(scope, {
        scope,
        path: entry.changedPatchPath,
        kind: completePatchCovered ? "complete_patch" : "bounded_patch",
      });
    }
  }
  const structuredLimitationTexts = new Set(structuredEntries.map((entry) => entry.limitation));
  const limitations = [...new Set([
    ...left.limitations,
    ...right.limitations,
  ].filter((limitation): limitation is string => (
    typeof limitation === "string"
    && !limitation.startsWith(INITIAL_DIFF_RECOVERY_LIMITATION_PREFIX)
    && !structuredLimitationTexts.has(limitation)
  )))];
  limitations.push(...[...unresolvedByScope.values()].map((entry) => entry.limitation));
  if (missingPatches > 0) limitations.unshift(initialDiffRecoveryLimitation(missingPatches));
  const boundedLimitations = [...new Set(limitations)].slice(0, 20);
  return {
    sufficient: boundedLimitations.length === 0,
    totalChangedFiles,
    inspectedChangedFiles,
    ...(left.changedPatchCoverage === undefined && left.inspectedChangedPaths === undefined
      || right.changedPatchCoverage === undefined && right.inspectedChangedPaths === undefined
      ? {}
      : { inspectedChangedPaths }),
    toolCalls: left.toolCalls + right.toolCalls,
    okResults: left.okResults + right.okResults,
    truncatedResults: left.truncatedResults + right.truncatedResults,
    transientErrors: left.transientErrors + right.transientErrors,
    permanentErrors: left.permanentErrors + right.permanentErrors,
    invalidArguments: left.invalidArguments + right.invalidArguments,
    initialDiffTruncated,
    limitations: boundedLimitations,
    unresolvedEvidence: [...unresolvedByScope.values()],
    completedEvidenceScopes: [...completedEvidenceScopeSet].sort(),
    completedChangedPatchScopes: [...completedChangedPatchScopeMap.values()]
      .sort((left, right) => left.scope.localeCompare(right.scope) || left.path.localeCompare(right.path)),
    completeChangedFileRanges,
    changedPatchCoverage,
  };
}

function mergeChangedPatchCoverage(entries: ChangedPatchCoverage[]): ChangedPatchCoverage[] {
  const byPath = new Map<string, ChangedPatchCoverage>();
  for (const entry of entries) {
    if (
      typeof entry?.path !== "string"
      || !entry.path
      || !Number.isInteger(entry.totalPatchLines)
      || entry.totalPatchLines < 1
      || !Array.isArray(entry.intervals)
    ) continue;
    const previous = byPath.get(entry.path);
    const validIntervals = entry.intervals.filter((range) => (
      Number.isInteger(range?.start)
      && Number.isInteger(range?.end)
      && range.start >= 1
      && range.end > range.start
      && range.end <= entry.totalPatchLines + 1
    ));
    byPath.set(entry.path, {
      path: entry.path,
      // If persisted snapshots disagree, the larger total is safer: it cannot
      // accidentally promote a partial patch to complete coverage.
      totalPatchLines: Math.max(entry.totalPatchLines, previous?.totalPatchLines ?? 0),
      intervals: mergeRanges([
        ...(previous?.intervals ?? []),
        ...validIntervals,
      ]),
    });
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function patchCoverageComplete(entry: ChangedPatchCoverage): boolean {
  return rangeCovered({ start: 1, end: entry.totalPatchLines + 1 }, entry.intervals);
}

function changedPatchRangeCovered(
  path: string,
  range: ChangedFileRange,
  coverage: ChangedPatchCoverage[],
): boolean {
  const entry = coverage.find((candidate) => candidate.path === path);
  return entry !== undefined && rangeCovered(range, entry.intervals);
}

export function emptyEvidenceCoverage(totalChangedFiles = 0): EvidenceCoverage {
  return {
    sufficient: true,
    totalChangedFiles,
    inspectedChangedFiles: 0,
    inspectedChangedPaths: [],
    toolCalls: 0,
    okResults: 0,
    truncatedResults: 0,
    transientErrors: 0,
    permanentErrors: 0,
    invalidArguments: 0,
    initialDiffTruncated: false,
    limitations: [],
    unresolvedEvidence: [],
    completedEvidenceScopes: [],
    completedChangedPatchScopes: [],
    completeChangedFileRanges: [],
    changedPatchCoverage: [],
  };
}
