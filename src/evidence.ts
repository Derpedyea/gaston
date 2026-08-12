export type EvidenceStatus =
  | "ok"
  | "truncated"
  | "transient_error"
  | "permanent_error"
  | "invalid_arguments";

export interface EvidenceSlice {
  scope: string;
  complete: boolean;
  requested?: number;
  returned?: number;
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
  toolCalls: number;
  okResults: number;
  truncatedResults: number;
  transientErrors: number;
  permanentErrors: number;
  invalidArguments: number;
  initialDiffTruncated: boolean;
  limitations: string[];
}

export interface EvidenceTools {
  invoke(name: string, rawArguments: string, signal?: AbortSignal): Promise<EvidenceResult>;
  coverage?(): EvidenceCoverage;
}

interface CoverageOptions {
  totalChangedFiles: number;
  initialDiffTruncated: boolean;
  changedFileListingTruncated?: boolean;
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
  readonly #unresolved = new Map<string, { status: EvidenceStatus; limitation: string }>();
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
    if (result.status === "ok" && result.evidence?.complete !== false) {
      this.#unresolved.delete(scope);
      if (tool === "read_file" && changedPath) this.#unresolved.delete(`diff_for_file:${changedPath}`);
      if (tool === "diff_for_file" && changedPath) {
        // A bounded exact patch slice is the intended recovery for an
        // oversized full-patch response and the initial prompt excerpt.
        this.#unresolved.delete(`diff_for_file:${changedPath}`);
        this.#inspectedChangedFiles.add(changedPath);
      }
      return;
    }

    if (result.status !== "ok") {
      this.#unresolved.set(scope, {
        status: result.status,
        limitation: result.suggestedAction
          ? `${tool}: ${result.suggestedAction}`
          : `${tool}: ${result.status.replaceAll("_", " ")}`,
      });
    }
  }

  snapshot(): EvidenceCoverage {
    const unresolved = [...this.#unresolved.values()];
    const requiredPatches = requiredPatchesForTruncatedDiff(
      this.#options.totalChangedFiles,
      this.#options.initialDiffTruncated,
    );
    const missingPatches = Math.max(0, requiredPatches - this.#inspectedChangedFiles.size);
    const limitations = [
      ...(this.#options.changedFileListingTruncated
        ? ["GitHub truncated the changed-file listing, so some changed paths may be unavailable."]
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
      toolCalls: this.#toolCalls,
      okResults: this.#okResults,
      truncatedResults: this.#truncatedResults,
      transientErrors: this.#transientErrors,
      permanentErrors: this.#permanentErrors,
      invalidArguments: this.#invalidArguments,
      initialDiffTruncated: this.#options.initialDiffTruncated,
      limitations: [...new Set(limitations)].slice(0, 20),
    };
  }
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
  const inspectedChangedFiles = Math.min(
    totalChangedFiles,
    left.inspectedChangedFiles + right.inspectedChangedFiles,
  );
  const initialDiffTruncated = left.initialDiffTruncated || right.initialDiffTruncated;
  const missingPatches = Math.max(
    0,
    requiredPatchesForTruncatedDiff(totalChangedFiles, initialDiffTruncated) - inspectedChangedFiles,
  );
  const limitations = [...new Set([
    ...left.limitations,
    ...right.limitations,
  ].filter((limitation) => !limitation.startsWith(INITIAL_DIFF_RECOVERY_LIMITATION_PREFIX)))];
  if (missingPatches > 0) limitations.unshift(initialDiffRecoveryLimitation(missingPatches));
  const boundedLimitations = limitations.slice(0, 20);
  return {
    sufficient: boundedLimitations.length === 0,
    totalChangedFiles,
    inspectedChangedFiles,
    toolCalls: left.toolCalls + right.toolCalls,
    okResults: left.okResults + right.okResults,
    truncatedResults: left.truncatedResults + right.truncatedResults,
    transientErrors: left.transientErrors + right.transientErrors,
    permanentErrors: left.permanentErrors + right.permanentErrors,
    invalidArguments: left.invalidArguments + right.invalidArguments,
    initialDiffTruncated,
    limitations: boundedLimitations,
  };
}

export function emptyEvidenceCoverage(totalChangedFiles = 0): EvidenceCoverage {
  return {
    sufficient: true,
    totalChangedFiles,
    inspectedChangedFiles: 0,
    toolCalls: 0,
    okResults: 0,
    truncatedResults: 0,
    transientErrors: 0,
    permanentErrors: 0,
    invalidArguments: 0,
    initialDiffTruncated: false,
    limitations: [],
  };
}
