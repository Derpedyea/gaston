import type { EvidenceCoverage, EvidenceResult, EvidenceTools } from "./evidence.ts";
import type { VerificationAnchorEvidence } from "./prompts.ts";
import { verificationCandidateId } from "./review-core.ts";
import type { ReviewOutput } from "./types.ts";

const EVIDENCE_HANDLE_PREFIX = "GASTON-EVIDENCE";
const OBSERVATION_HANDLE_PREFIX = "GASTON-OBSERVATION";

/**
 * Keep repository paths and ranges in the harness-owned ledger while exposing
 * only short, opaque identities to the verifier. Complete results receive
 * citable proof handles; partial and failed results receive non-citable
 * observation handles. Recovery always creates a new proof handle instead of
 * promoting an observation whose full contents were never returned.
 */
export function withOpaqueEvidenceHandles(
  tools: EvidenceTools,
): OpaqueEvidenceTools {
  return new OpaqueVerificationEvidenceTools(tools);
}

export interface VerificationEvidenceDossierEntry {
  handle: string;
  tool: string;
  arguments: unknown;
  content: string;
}

export interface OpaqueEvidenceTools extends EvidenceTools {
  coverage(): EvidenceCoverage;
  dossier(handles: readonly string[], maxBytes?: number): VerificationEvidenceDossierEntry[];
  toolAvailability(name: string): "untried" | "succeeded" | "failed";
}

class OpaqueVerificationEvidenceTools implements EvidenceTools {
  readonly #inner: EvidenceTools;
  readonly #proofHandles = new Map<string, string>();
  readonly #observationHandles = new Map<string, string>();
  readonly #dossier = new Map<string, VerificationEvidenceDossierEntry>();
  readonly #toolStatuses = new Map<string, Set<EvidenceResult["status"]>>();
  #nextProofHandle = 1;
  #nextObservationHandle = 1;

  constructor(inner: EvidenceTools) {
    this.#inner = inner;
  }

  async invoke(name: string, rawArguments: string, signal?: AbortSignal): Promise<EvidenceResult> {
    const result = await this.#inner.invoke(name, rawArguments, signal);
    const statuses = this.#toolStatuses.get(name) ?? new Set();
    statuses.add(result.status);
    this.#toolStatuses.set(name, statuses);
    if (result.evidence === undefined) return result;

    const rawScope = result.evidence.scope;
    const complete = result.status === "ok" && result.evidence.complete === true;
    const handle = complete ? this.#proofHandle(rawScope) : this.#observationHandle(rawScope);
    const rawResolutionScope = result.evidence.resolutionScope;

    const mapped = {
      ...result,
      evidence: {
        ...result.evidence,
        scope: handle,
        ...(rawResolutionScope === undefined
          ? {}
          : { resolutionScope: this.#observationHandle(rawResolutionScope) }),
      },
    };
    if (complete) {
      this.#dossier.set(handle, {
        handle,
        tool: name,
        arguments: safeArguments(rawArguments),
        content: result.content,
      });
    }
    return mapped;
  }

  dossier(handles: readonly string[], maxBytes = 18_000): VerificationEvidenceDossierEntry[] {
    const result: VerificationEvidenceDossierEntry[] = [];
    const boundedMaximum = Math.max(0, maxBytes);
    for (const handle of new Set(handles)) {
      const entry = this.#dossier.get(handle);
      if (entry === undefined || boundedMaximum === 0) continue;
      const bounded = fitDossierEntry(result, entry, boundedMaximum);
      if (bounded === undefined) break;
      result.push(bounded);
    }
    return result;
  }

  toolAvailability(name: string): "untried" | "succeeded" | "failed" {
    const statuses = this.#toolStatuses.get(name);
    if (statuses === undefined) return "untried";
    return statuses.has("ok") ? "succeeded" : "failed";
  }

  coverage(): EvidenceCoverage {
    const raw = this.#inner.coverage?.();
    if (raw === undefined) {
      throw new Error("opaque verification evidence requires a coverage ledger");
    }
    const unresolved = (raw.unresolvedEvidence ?? []).map((entry) => ({
      ...entry,
      scope: this.#observationHandle(entry.scope),
    }));
    const completedEvidenceScopes = [...new Set(
      (raw.completedEvidenceScopes ?? []).map((scope) => this.#proofHandle(scope)),
    )].sort(handleOrder);
    const completedChangedPatchScopes = (raw.completedChangedPatchScopes ?? []).flatMap((entry) => {
      const handle = this.#proofHandles.get(entry.scope);
      return handle === undefined ? [] : [{ ...entry, scope: handle }];
    });

    return {
      ...raw,
      unresolvedEvidence: unresolved,
      completedEvidenceScopes,
      completedChangedPatchScopes,
    };
  }

  #proofHandle(scope: string): string {
    const existing = this.#proofHandles.get(scope);
    if (existing !== undefined) return existing;
    const handle = `${EVIDENCE_HANDLE_PREFIX}-${this.#nextProofHandle++}`;
    this.#proofHandles.set(scope, handle);
    return handle;
  }

  #observationHandle(scope: string): string {
    const existing = this.#observationHandles.get(scope);
    if (existing !== undefined) return existing;
    const handle = `${OBSERVATION_HANDLE_PREFIX}-${this.#nextObservationHandle++}`;
    this.#observationHandles.set(scope, handle);
    return handle;
  }
}

function fitDossierEntry(
  prefix: VerificationEvidenceDossierEntry[],
  entry: VerificationEvidenceDossierEntry,
  maxBytes: number,
): VerificationEvidenceDossierEntry | undefined {
  const bytes = new TextEncoder().encode(entry.content);
  let low = 0;
  let high = bytes.byteLength;
  let best: VerificationEvidenceDossierEntry | undefined;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const content = new TextDecoder().decode(bytes.slice(0, count));
    const candidate = {
      ...entry,
      content: count === bytes.byteLength ? content : `${content}…`,
    };
    if (byteLength(JSON.stringify([...prefix, candidate])) <= maxBytes) {
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return best;
}

function safeArguments(rawArguments: string): unknown {
  try {
    return JSON.parse(rawArguments) as unknown;
  } catch {
    return {};
  }
}

function handleOrder(left: string, right: string): number {
  const leftNumber = Number(left.slice(left.lastIndexOf("-") + 1));
  const rightNumber = Number(right.slice(right.lastIndexOf("-") + 1));
  return leftNumber - rightNumber || left.localeCompare(right);
}

/**
 * Reserve model-controlled verifier calls for semantic context by fetching a
 * compact exact changed-anchor capsule for every discovery candidate. The
 * phase-local tools retain the full evidence result for coverage accounting;
 * only the prompt copy is reduced to the target and nearby patch lines.
 */
export async function prefetchVerificationAnchors(
  discoveries: ReviewOutput[],
  tools: EvidenceTools,
  signal?: AbortSignal,
): Promise<VerificationAnchorEvidence[]> {
  const findings = discoveries.flatMap((review) => review.findings).slice(0, 12);
  const maxCapsuleBytes = Math.max(1_800, Math.floor(32_000 / Math.max(1, findings.length)));
  return Promise.all(findings.map(async (finding, index) => {
    const result = await tools.invoke("diff_for_source_line", JSON.stringify({
      path: finding.path,
      source_line: finding.line,
      side: finding.side,
    }), signal);
    return {
      candidateId: verificationCandidateId(finding.title) ?? `GASTON-CANDIDATE-${index + 1}`,
      path: finding.path,
      line: finding.line,
      side: finding.side,
      result: compactAnchorResult(result, maxCapsuleBytes),
    };
  }));
}

function compactAnchorResult(result: EvidenceResult, maxCapsuleBytes: number): EvidenceResult {
  if (result.status !== "ok") return result;
  try {
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    const patch = typeof parsed.patch === "string" ? parsed.patch : undefined;
    const patchStartLine = integer(parsed.patchStartLine);
    const patchEndLine = integer(parsed.patchEndLine);
    const sourcePatchLine = integer(parsed.sourcePatchLine);
    if (patch === undefined || patchStartLine === undefined || sourcePatchLine === undefined) {
      return fallbackCapsule(result);
    }
    const lines = patch.split("\n");
    const targetIndex = Math.max(0, Math.min(lines.length - 1, sourcePatchLine - patchStartLine));
    const capsuleForCount = (count: number): Record<string, unknown> => {
      const surrounding = Math.max(0, count - 1);
      let before = Math.min(targetIndex, Math.ceil(surrounding / 2));
      let after = Math.min(lines.length - targetIndex - 1, surrounding - before);
      before += Math.min(targetIndex - before, surrounding - before - after);
      after += Math.min(lines.length - targetIndex - 1 - after, surrounding - before - after);
      const firstIndex = targetIndex - before;
      const lastIndex = targetIndex + after;
      return {
        verificationAnchorCapsule: true,
        path: parsed.path,
        previousPath: parsed.previousPath,
        status: parsed.status,
        requestedSourceLine: parsed.requestedSourceLine,
        requestedSourceSide: parsed.requestedSourceSide,
        sourcePatchLine,
        patchStartLine: patchStartLine + firstIndex,
        patchEndLine: patchStartLine + lastIndex,
        originalPatchStartLine: patchStartLine,
        originalPatchEndLine: patchEndLine,
        totalPatchLines: parsed.totalPatchLines,
        patch: lines.slice(firstIndex, lastIndex + 1).join("\n"),
      };
    };
    let low = 1;
    let high = lines.length;
    let capsule = capsuleForCount(1);
    while (low <= high) {
      const count = Math.floor((low + high) / 2);
      const candidate = capsuleForCount(count);
      if (byteLength(JSON.stringify(candidate)) <= maxCapsuleBytes) {
        capsule = candidate;
        low = count + 1;
      } else {
        high = count - 1;
      }
    }
    let content = JSON.stringify(capsule);
    if (byteLength(content) > maxCapsuleBytes) {
      content = JSON.stringify({
        ...capsuleForCount(1),
        patch: clipUtf8(lines[targetIndex] ?? "", Math.max(200, maxCapsuleBytes - 700)),
      });
    }
    return {
      ...result,
      content,
    };
  } catch {
    return fallbackCapsule(result);
  }
}

function fallbackCapsule(result: EvidenceResult): EvidenceResult {
  return {
    ...result,
    content: JSON.stringify({
      verificationAnchorCapsule: true,
      rawEvidence: clipUtf8(result.content, 1_200),
    }),
  };
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function clipUtf8(value: string, maximumBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  const marker = "…";
  const markerBytes = new TextEncoder().encode(marker).byteLength;
  return `${new TextDecoder().decode(bytes.slice(0, Math.max(0, maximumBytes - markerBytes)))}${marker}`;
}
