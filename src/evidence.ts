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
  recordHarnessResult?(name: string, result: EvidenceResult): void;
}

interface CoverageOptions {
  totalChangedFiles: number;
  initialDiffTruncated: boolean;
}

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
      if (tool === "diff_for_file" && changedPath) this.#inspectedChangedFiles.add(changedPath);
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
    const limitations = [
      ...(this.#options.initialDiffTruncated
        ? ["The initial cumulative diff or changed-file listing was truncated."]
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
