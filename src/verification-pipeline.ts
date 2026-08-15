import type { EvidenceCoverage, EvidenceResult, EvidenceTools } from "./evidence.ts";
import {
  type DiscoveryReview,
  verificationPrompt,
  type VerificationAnchorEvidence,
} from "./prompts.ts";
import {
  finalizeVerificationPublication,
  type FinalizedVerificationPublication,
  resolveVerificationVerdicts,
  tagVerificationCandidates,
  verificationCandidateId,
  type ChangedLines,
} from "./review-core.ts";
import type {
  PullChangeSet,
  ReviewJob,
  ReviewOutput,
  VerificationOutput,
} from "./types.ts";
import {
  prefetchVerificationAnchors,
  withOpaqueEvidenceHandles,
} from "./verification-evidence.ts";

export interface VerificationRunner {
  runVerification(prompt: string, tools: EvidenceTools): Promise<VerificationOutput>;
}

export interface VerificationPublicationConfig {
  changedLines: Map<string, ChangedLines>;
  discoveryCoverage: EvidenceCoverage;
  configuredBaseThreshold: string | undefined;
  configuredIncompleteEvidenceFloor: string | undefined;
  maxFindings: number;
}

export interface ReplayVerificationInput extends VerificationPublicationConfig {
  discoveries: ReviewOutput[];
  verification: VerificationOutput;
  verificationCoverage: EvidenceCoverage;
}

export interface ReplayVerificationResult extends FinalizedVerificationPublication {
  candidates: ReviewOutput[];
}

/**
 * Re-run the deterministic trust and publication boundary over a saved model
 * transcript. No repository or model access occurs, so policy changes can be
 * regression-tested against historical verifier output.
 */
export function replayVerificationPublication(
  input: ReplayVerificationInput,
): ReplayVerificationResult {
  const candidates = tagVerificationCandidates(input.discoveries);
  const resolution = resolveVerificationVerdicts(
    input.verification,
    candidates,
    input.verificationCoverage,
  );
  return {
    ...finalizeVerificationPublication(resolution, {
      changedLines: input.changedLines,
      discoveryCoverage: input.discoveryCoverage,
      verificationCoverage: input.verificationCoverage,
      configuredBaseThreshold: input.configuredBaseThreshold,
      configuredIncompleteEvidenceFloor: input.configuredIncompleteEvidenceFloor,
      maxFindings: input.maxFindings,
    }),
    candidates,
  };
}

export interface VerificationPipelineInput extends VerificationPublicationConfig {
  runner: VerificationRunner;
  rescueRunner?: VerificationRunner;
  tools: EvidenceTools;
  job: ReviewJob;
  discoveries: DiscoveryReview[];
  changes: PullChangeSet;
  policy: string;
  signal?: AbortSignal;
  /** Allow one batched evidence-completion pass for routeable unresolved candidates. */
  rescueHighRisk?: boolean;
  /** Experimental maximum per cold verifier context; defaults to one full batch. */
  verificationClusterSize?: number;
}

export interface VerificationRescueResult {
  attemptedCandidateId: string;
  succeeded: boolean;
  output?: VerificationOutput;
  error?: string;
}

export interface VerificationPipelineResult extends FinalizedVerificationPublication {
  raw: VerificationOutput;
  initialRaw: VerificationOutput;
  verificationCoverage: EvidenceCoverage;
  candidates: ReviewOutput[];
  anchors: VerificationAnchorEvidence[];
  rescue?: VerificationRescueResult;
  rescues: VerificationRescueResult[];
  rescueDecision: VerificationRescueDecision;
  rescueDecisions: VerificationRescueDecision[];
  clusters: string[][];
}

export type VerificationRescueDecision =
  | { decision: "disabled" | "no_candidate" }
  | {
      decision: "attempted" | "skipped_unrouteable";
      candidateId: string;
      gapKind: NonNullable<FinalizedVerificationPublication["resolution"]["candidateFates"][number]["verification"]["missingEvidenceKind"]>;
    };

const MAX_RESCUE_CANDIDATES = 8;

/**
 * Own the complete verification boundary: candidate identity, exact anchors,
 * opaque evidence, optional bounded rescue, verdict reduction, and publication.
 * Production and evaluation callers use this same path so benchmark recall
 * cannot diverge from deployed behavior.
 */
export async function verifyAndPublish(
  input: VerificationPipelineInput,
): Promise<VerificationPipelineResult> {
  const candidates = tagVerificationCandidates(input.discoveries.map(({ review }) => review));
  const taggedDiscoveries = input.discoveries.map((discovery, index) => ({
    ...discovery,
    review: candidates[index]!,
  }));
  const tools = withOpaqueEvidenceHandles(input.tools);
  const anchors = await prefetchVerificationAnchors(candidates, tools, input.signal);
  const clusters = verificationClusters(taggedDiscoveries, input.verificationClusterSize);
  const initialOutputs = await Promise.all(clusters.map((cluster) => input.runner.runVerification(
    verificationPrompt(
      input.job,
      cluster,
      input.changes,
      input.policy,
      anchors.filter((anchor) => cluster.some(({ review }) => review.findings.some((finding) => (
        verificationCandidateId(finding.title) === anchor.candidateId
      )))),
    ),
    tools,
  )));
  const initialRaw = mergeVerificationOutputs(initialOutputs);
  let raw = initialRaw;
  let verificationCoverage = tools.coverage();
  const initialResolution = resolveVerificationVerdicts(raw, candidates, verificationCoverage);
  const rescueSelections = (input.rescueHighRisk ?? true)
    ? selectRescueCandidates(initialResolution, tools)
    : [{ decision: "disabled" as const }];
  const rescueFates = rescueSelections.flatMap((selection) => (
    selection.decision === "attempted" ? [selection.fate] : []
  ));
  const rescueRoutes = new Map(await Promise.all(rescueFates.map(async (fate) => ([
    fate.candidateId,
    await prefetchRescueRoute(fate, tools, input.signal),
  ] as const))));
  let rescues: VerificationRescueResult[] = [];
  if (rescueFates.length > 0) {
    try {
      const rescueContexts = rescueFates.map((rescueFate) => {
        const routingEvidence = rescueRoutes.get(rescueFate.candidateId) ?? [];
        return {
          candidateId: rescueFate.candidateId,
          missingEvidenceKind: rescueFate.verification.missingEvidenceKind!,
          missingEvidence: rescueFate.verification.missingEvidence,
          discoveryHypothesis: {
            why: rescueFate.finding.why,
            evidence: rescueFate.finding.evidence,
            ...(rescueFate.finding.proofObligations === undefined
              ? {}
              : { proofObligations: rescueFate.finding.proofObligations }),
          },
          dossier: tools.dossier([
            ...rescueFate.verification.evidenceScopes,
            ...routingEvidence.flatMap((entry) => entry.result.evidence?.complete === true
              ? [entry.result.evidence.scope]
              : []),
            ...anchors
              .filter((anchor) => anchor.candidateId === rescueFate.candidateId)
              .flatMap((anchor) => anchor.result.evidence?.scope ?? []),
          ]),
          routingEvidence: routingEvidence.map((entry) => ({
            tool: entry.tool,
            arguments: entry.arguments,
            status: entry.result.status,
            handle: entry.result.evidence?.scope ?? "unavailable",
            complete: entry.result.evidence?.complete === true,
            content: clipUtf8(entry.result.content, 4_000),
          })),
        };
      });
      const output = await (input.rescueRunner ?? input.runner).runVerification(
        verificationPrompt(
          input.job,
          [{
            source: "verification-rescue",
            review: {
              summary: "Batched evidence completion for unresolved candidates.",
              findings: rescueFates.map((fate) => candidateFinding(candidates, fate.candidateId)),
            },
          }],
          input.changes,
          input.policy,
          anchors.filter((anchor) => rescueFates.some((fate) => fate.candidateId === anchor.candidateId)),
          rescueContexts,
        ),
        tools,
      );
      rescues = rescueFates.map((fate) => ({
        attemptedCandidateId: fate.candidateId,
        succeeded: false,
        output,
      }));
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason ?? error;
      rescues = rescueFates.map((fate) => ({
        attemptedCandidateId: fate.candidateId,
        succeeded: false,
        error: errorMessage(error),
      }));
    }
  }
  for (const rescue of rescues) {
    if (rescue.output !== undefined) {
      raw = mergeRescueVerdict(raw, rescue.output, rescue.attemptedCandidateId);
    }
  }
  if (rescues.length > 0) verificationCoverage = tools.coverage();

  const replayed = replayVerificationPublication({
    discoveries: input.discoveries.map(({ review }) => review),
    verification: raw,
    verificationCoverage,
    changedLines: input.changedLines,
    discoveryCoverage: input.discoveryCoverage,
    configuredBaseThreshold: input.configuredBaseThreshold,
    configuredIncompleteEvidenceFloor: input.configuredIncompleteEvidenceFloor,
    maxFindings: input.maxFindings,
  });
  for (const rescue of rescues) {
    rescue.succeeded = replayed.resolution.candidateFates.some((fate) => (
      fate.candidateId === rescue.attemptedCandidateId
      && fate.verification.state !== "insufficient"
    ));
  }

  const rescueDecisions = rescueSelections.map(publicRescueDecision);
  const rescue = rescues[0];

  return {
    ...replayed,
    raw,
    initialRaw,
    verificationCoverage,
    anchors,
    clusters: clusters.map((cluster) => cluster.flatMap(({ review }) => review.findings.flatMap((finding) => (
      verificationCandidateId(finding.title) ?? []
    )))),
    rescueDecision: rescueDecisions[0] ?? { decision: "no_candidate" },
    rescueDecisions,
    rescues,
    ...(rescue === undefined ? {} : { rescue }),
  };
}

interface RescueRouteEntry {
  tool: string;
  arguments: Record<string, unknown>;
  result: EvidenceResult;
}

async function prefetchRescueRoute(
  fate: FinalizedVerificationPublication["resolution"]["candidateFates"][number],
  tools: EvidenceTools,
  signal?: AbortSignal,
): Promise<RescueRouteEntry[]> {
  if (fate.verification.state !== "insufficient") return [];
  const target = [
    fate.verification.missingEvidence,
    fate.finding.proofObligations?.unresolvedFact,
    fate.finding.proofObligations?.falsifier,
    fate.finding.title,
  ].filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");
  const queries = routeIdentifiers(target);
  if (queries.length === 0) return [];

  const dependencyPackage = fate.verification.missingEvidenceKind === "dependency_contract"
    ? routePackageName(target)
    : undefined;
  if (dependencyPackage !== undefined) {
    const argumentsValue = { package: dependencyPackage, query: queries[0]!, limit: 20 };
    return [{
      tool: "dependency_source",
      arguments: argumentsValue,
      result: await tools.invoke("dependency_source", JSON.stringify(argumentsValue), signal),
    }];
  }

  const entries: RescueRouteEntry[] = [];
  for (const query of queries) {
    const scopedArguments = { query, path_prefix: routePathPrefix(fate.finding.path), limit: 20 };
    entries.push({
      tool: "search_code",
      arguments: scopedArguments,
      result: await tools.invoke("search_code", JSON.stringify(scopedArguments), signal),
    });
  }

  // A deciding helper or schema often lives outside the candidate's feature
  // directory. Keep the scoped search for nearby callers, but do not let it be
  // the only route when the first pass explicitly names a missing symbol.
  if (
    fate.verification.missingEvidenceKind === "repository_symbol"
    || fate.verification.missingEvidenceKind === "repository_reachability"
    || fate.verification.missingEvidenceKind === "runtime_semantics"
  ) {
    for (const query of queries) {
      const globalArguments = { query, limit: 20 };
      entries.push({
        tool: "search_code",
        arguments: globalArguments,
        result: await tools.invoke("search_code", JSON.stringify(globalArguments), signal),
      });
    }
  }

  const paths = entries
    .filter((entry) => entry.tool === "search_code")
    .flatMap((entry) => searchResultPaths(entry.result.content, fate.finding.path, target))
    .filter((entry, index, all) => all.findIndex((other) => other.path === entry.path) === index)
    .slice(0, 6);
  const reads = await Promise.all(paths.map(async ({ path, line }) => {
    const startLine = Math.max(1, (line ?? 121) - 120);
    const readArguments = {
      path,
      ref: "head",
      start_line: startLine,
      end_line: startLine + 240,
    };
    return {
      tool: "read_file",
      arguments: readArguments,
      result: await tools.invoke("read_file", JSON.stringify(readArguments), signal),
    } satisfies RescueRouteEntry;
  }));
  entries.push(...reads);
  return entries;
}

function routeIdentifiers(value: string): string[] {
  const quoted = [...value.matchAll(/`([^`]+)`/g)]
    .flatMap((match) => match[1]?.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
  const tokens = [...quoted, ...(value.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [])];
  return tokens.filter((token, index, all) => (
    token.length >= 3
    && token.length <= 80
    && (/[a-z0-9_$][A-Z]/.test(token) || /[_$]/.test(token))
    && all.indexOf(token) === index
  )).slice(0, 3);
}

function routePackageName(value: string): string | undefined {
  const scoped = value.match(/@[a-z0-9_.-]+\/[a-z0-9_.-]+/i)?.[0];
  if (scoped !== undefined) return scoped.toLowerCase();
  const beforeVersion = value.match(/\b([A-Za-z][A-Za-z0-9_.-]+)\s+v?\d+\.\d+(?:\.\d+)?/i)?.[1];
  if (beforeVersion !== undefined) return beforeVersion.toLowerCase();
  return undefined;
}

function routePathPrefix(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.slice(0, Math.max(1, segments.length - 1)).join("/");
}

function searchResultPaths(
  content: string,
  candidatePath: string,
  target: string,
): Array<{ path: string; line?: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.matches)) return [];
  const targetWords = new Set((target.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []));
  const unique = new Map<string, { path: string; line?: number; score: number }>();
  for (const value of parsed.matches) {
    if (!isRecord(value) || typeof value.path !== "string") continue;
    const path = value.path;
    if (path.split("/").includes("..") || path.startsWith("/")) continue;
    const lower = path.toLowerCase();
    const isTest = /(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)|\.(?:test|spec)\./.test(lower);
    const overlap = [...targetWords].filter((word) => lower.includes(word)).length;
    const semantic = /(view|store|thread|message|hydrate|load|adapter|provider|runtime)/.test(lower) ? 2 : 0;
    const candidateFile = path === candidatePath ? 2 : 0;
    const line = typeof value.line === "number" && Number.isInteger(value.line) && value.line > 0
      ? value.line
      : undefined;
    const entry = { path, ...(line === undefined ? {} : { line }), score: overlap * 3 + semantic + candidateFile - (isTest ? 4 : 0) };
    const existing = unique.get(path);
    if (existing === undefined || entry.score > existing.score) unique.set(path, entry);
  }
  return [...unique.values()]
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .map(({ path, line }) => ({ path, ...(line === undefined ? {} : { line }) }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipUtf8(value: string, maximumBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  const marker = "…";
  const markerBytes = new TextEncoder().encode(marker).byteLength;
  return `${new TextDecoder().decode(bytes.slice(0, Math.max(0, maximumBytes - markerBytes)))}${marker}`;
}

function verificationClusters(
  discoveries: DiscoveryReview[],
  requestedSize: number | undefined,
): DiscoveryReview[][] {
  if (requestedSize === undefined) return [discoveries];
  const findings = discoveries.flatMap(({ source, review }) => review.findings.map((finding) => ({
    source,
    summary: review.summary,
    finding,
  })));
  const clusterSize = Math.max(1, Math.min(Math.trunc(requestedSize), 12));
  if (clusterSize >= findings.length) return [discoveries];
  const byPath = new Map<string, typeof findings>();
  for (const entry of findings) {
    const group = byPath.get(entry.finding.path) ?? [];
    group.push(entry);
    byPath.set(entry.finding.path, group);
  }
  const result: DiscoveryReview[][] = [];
  for (const pathGroup of byPath.values()) {
    for (let offset = 0; offset < pathGroup.length; offset += clusterSize) {
      const slice = pathGroup.slice(offset, offset + clusterSize);
      result.push(slice.map((entry) => ({
        source: entry.source,
        review: { summary: entry.summary, findings: [entry.finding] },
      })));
    }
  }
  return result;
}

function mergeVerificationOutputs(outputs: VerificationOutput[]): VerificationOutput {
  return {
    summary: outputs.map((output) => output.summary).join(" ").slice(0, 4_000),
    verdicts: outputs.flatMap((output) => output.verdicts),
  };
}

type InternalRescueSelection =
  | { decision: "disabled" | "no_candidate" }
  | { decision: "skipped_unrouteable"; candidateId: string; gapKind: NonNullable<FinalizedVerificationPublication["resolution"]["candidateFates"][number]["verification"]["missingEvidenceKind"]> }
  | { decision: "attempted"; fate: FinalizedVerificationPublication["resolution"]["candidateFates"][number] };

function selectRescueCandidates(
  resolution: FinalizedVerificationPublication["resolution"],
  tools: ReturnType<typeof withOpaqueEvidenceHandles>,
): InternalRescueSelection[] {
  const severityRank = { blocker: 0, high: 1, medium: 2, low: 3 } as const;
  const eligible = resolution.candidateFates
    .filter((fate) => (
      fate.verification.state === "insufficient"
      && fate.finding.severity !== "low"
    ))
    .sort((left, right) => (
      severityRank[left.finding.severity] - severityRank[right.finding.severity]
      || right.finding.confidence - left.finding.confidence
    ));
  const routeable = eligible.filter((fate) => (
    fate.verification.missingEvidenceKind === "repository_reachability"
    || fate.verification.missingEvidenceKind === "repository_symbol"
    || fate.verification.missingEvidenceKind === "dependency_contract"
      && tools.toolAvailability("dependency_source") !== "failed"
    || fate.verification.missingEvidenceKind === "runtime_semantics"
    || fate.verification.missingEvidenceKind === "tool_failure"
  )).slice(0, MAX_RESCUE_CANDIDATES);
  if (routeable.length > 0) {
    return routeable.map((fate) => ({ decision: "attempted" as const, fate }));
  }
  const first = eligible[0];
  if (first !== undefined && first.verification.missingEvidenceKind !== null) {
    return [{
      decision: "skipped_unrouteable",
      candidateId: first.candidateId,
      gapKind: first.verification.missingEvidenceKind,
    }];
  }
  return [{ decision: "no_candidate" }];
}

function publicRescueDecision(selection: InternalRescueSelection): VerificationRescueDecision {
  return selection.decision === "attempted"
    ? {
        decision: "attempted",
        candidateId: selection.fate.candidateId,
        gapKind: selection.fate.verification.missingEvidenceKind!,
      }
    : selection;
}

function candidateFinding(candidates: ReviewOutput[], candidateId: string): ReviewOutput["findings"][number] {
  const finding = candidates
    .flatMap((review) => review.findings)
    .find((entry) => verificationCandidateId(entry.title) === candidateId);
  if (finding === undefined) throw new Error(`missing tagged rescue candidate ${candidateId}`);
  return finding;
}

function mergeRescueVerdict(
  initial: VerificationOutput,
  rescue: VerificationOutput,
  candidateId: string,
): VerificationOutput {
  return {
    summary: `${initial.summary} Rescue: ${rescue.summary}`.slice(0, 4_000),
    verdicts: [
      ...initial.verdicts.filter((verdict) => verdict.candidateId !== candidateId),
      ...rescue.verdicts.filter((verdict) => verdict.candidateId === candidateId),
    ],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
