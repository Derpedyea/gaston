import type { EvidenceCoverage, EvidenceResult, EvidenceTools } from "./evidence.ts";
import type { VerificationAnchorEvidence } from "./prompts.ts";
import type { ReviewOutput } from "./types.ts";

const EVIDENCE_HANDLE_PREFIX = "GASTON-EVIDENCE";

interface IncompleteRead {
  handle: string;
  path: string;
  ref: "base" | "head";
  startLine: number;
  endLine: number;
}

/**
 * Keep repository paths and ranges in the harness-owned ledger while exposing
 * only short, opaque evidence identities to the verifier. This removes exact
 * string transcription from the trust boundary. A successful narrow read can
 * also supersede an earlier truncated read of the same file range; the broad
 * handle remains auditable, but no longer poisons an otherwise complete proof.
 */
export function withOpaqueEvidenceHandles(
  tools: EvidenceTools,
): EvidenceTools & { coverage(): EvidenceCoverage } {
  return new OpaqueVerificationEvidenceTools(tools);
}

class OpaqueVerificationEvidenceTools implements EvidenceTools {
  readonly #inner: EvidenceTools;
  readonly #handles = new Map<string, string>();
  readonly #incompleteReads = new Map<string, IncompleteRead>();
  readonly #supersededHandles = new Set<string>();
  #nextHandle = 1;

  constructor(inner: EvidenceTools) {
    this.#inner = inner;
  }

  async invoke(name: string, rawArguments: string, signal?: AbortSignal): Promise<EvidenceResult> {
    const result = await this.#inner.invoke(name, rawArguments, signal);
    if (result.evidence === undefined) return result;

    const rawScope = result.evidence.scope;
    const handle = this.#handle(rawScope);
    const rawResolutionScope = result.evidence.resolutionScope;
    const read = name === "read_file" ? readIdentity(rawArguments) : undefined;
    if (read !== undefined) {
      if (result.status === "ok" && result.evidence.complete === true) {
        for (const incomplete of this.#incompleteReads.values()) {
          if (
            incomplete.path === read.path
            && incomplete.ref === read.ref
            && read.startLine >= incomplete.startLine
            && read.endLine <= incomplete.endLine
          ) {
            this.#supersededHandles.add(incomplete.handle);
          }
        }
      } else {
        this.#incompleteReads.set(handle, { handle, ...read });
      }
    }

    return {
      ...result,
      evidence: {
        ...result.evidence,
        scope: handle,
        ...(rawResolutionScope === undefined
          ? {}
          : { resolutionScope: this.#handle(rawResolutionScope) }),
      },
    };
  }

  coverage(): EvidenceCoverage {
    const raw = this.#inner.coverage?.();
    if (raw === undefined) {
      throw new Error("opaque verification evidence requires a coverage ledger");
    }
    const unresolved = (raw.unresolvedEvidence ?? []).map((entry) => ({
      ...entry,
      scope: this.#handles.get(entry.scope) ?? entry.scope,
    }));
    const remainingUnresolved = unresolved.filter((entry) => (
      !this.#supersededHandles.has(entry.scope)
    ));
    const allUnresolvedLimitations = new Set(unresolved.map((entry) => entry.limitation));
    const remainingUnresolvedLimitations = new Set(
      remainingUnresolved.map((entry) => entry.limitation),
    );
    const limitations = raw.limitations.filter((limitation) => (
      !allUnresolvedLimitations.has(limitation)
      || remainingUnresolvedLimitations.has(limitation)
    ));
    const completedEvidenceScopes = [...new Set([
      ...(raw.completedEvidenceScopes ?? []).flatMap((scope) => {
        const handle = this.#handles.get(scope);
        return handle === undefined ? [] : [handle];
      }),
      ...this.#supersededHandles,
    ])].sort(handleOrder);
    const completedChangedPatchScopes = (raw.completedChangedPatchScopes ?? []).flatMap((entry) => {
      const handle = this.#handles.get(entry.scope);
      return handle === undefined ? [] : [{ ...entry, scope: handle }];
    });

    return {
      ...raw,
      sufficient: limitations.length === 0,
      limitations,
      unresolvedEvidence: remainingUnresolved,
      completedEvidenceScopes,
      completedChangedPatchScopes,
    };
  }

  #handle(scope: string): string {
    const existing = this.#handles.get(scope);
    if (existing !== undefined) return existing;
    const handle = `${EVIDENCE_HANDLE_PREFIX}-${this.#nextHandle++}`;
    this.#handles.set(scope, handle);
    return handle;
  }
}

function readIdentity(rawArguments: string): Omit<IncompleteRead, "handle"> | undefined {
  try {
    const parsed = JSON.parse(rawArguments || "{}") as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const args = parsed as Record<string, unknown>;
    if (typeof args.path !== "string" || args.path.trim().length === 0) return undefined;
    const startLine = positiveInteger(args.start_line, 1);
    const endLine = positiveInteger(args.end_line, 300);
    if (endLine < startLine) return undefined;
    return {
      path: args.path.trim().replace(/^\.\//, "").replace(/^\/+/, ""),
      ref: args.ref === "base" ? "base" : "head",
      startLine,
      endLine,
    };
  } catch {
    return undefined;
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
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
      candidateId: `GASTON-CANDIDATE-${index + 1}`,
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
