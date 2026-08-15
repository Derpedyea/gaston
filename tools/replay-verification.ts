import { emptyEvidenceCoverage, type EvidenceCoverage } from "../src/evidence.ts";
import { replayVerificationPublication } from "../src/verification-pipeline.ts";
import type { ChangedLines } from "../src/review-core.ts";
import type { ReviewOutput, VerificationOutput } from "../src/types.ts";

const artifactPath = process.argv[2];
if (!artifactPath) {
  throw new Error("usage: bun tools/replay-verification.ts <benchmark-artifact.json>");
}

const artifact = await Bun.file(artifactPath).json() as unknown;
const results = benchmarkResults(artifact);
const replays = results.flatMap((result) => {
  if (
    result.discovery === undefined
    || result.verification?.raw === undefined
    || result.verification.coverage === undefined
  ) {
    return [];
  }
  const changedLines = changedLinesFromValidatedDiscovery(result.discovery);
  const replay = replayVerificationPublication({
    discoveries: [result.discovery],
    verification: result.verification.raw,
    verificationCoverage: result.verification.coverage,
    changedLines,
    discoveryCoverage: result.discoveryCoverage ?? emptyEvidenceCoverage(changedLines.size),
    configuredBaseThreshold: "0.80",
    configuredIncompleteEvidenceFloor: "0.88",
    maxFindings: 8,
  });
  return [{
    case: result.case ?? "unknown",
    previouslyPublished: result.output?.findings.length ?? null,
    replayedPublished: replay.review.findings.length,
    fates: replay.resolution.candidateFates.map((fate) => ({
      candidateId: fate.candidateId,
      verification: fate.verification.reason,
      publication: fate.publication.reason,
    })),
  }];
});

console.log(JSON.stringify({
  artifact: artifactPath,
  replayedCases: replays.length,
  previouslyPublished: sumNullable(replays.map((result) => result.previouslyPublished)),
  replayedPublished: replays.reduce((sum, result) => sum + result.replayedPublished, 0),
  results: replays,
}, null, 2));

interface StoredResult {
  case?: string;
  discovery?: ReviewOutput;
  discoveryCoverage?: EvidenceCoverage;
  verification?: {
    raw?: VerificationOutput;
    coverage?: EvidenceCoverage;
  };
  output?: ReviewOutput;
}

function benchmarkResults(value: unknown): StoredResult[] {
  if (Array.isArray(value)) return value as StoredResult[];
  if (isRecord(value) && Array.isArray(value.results)) return value.results as StoredResult[];
  throw new Error("artifact must be a benchmark result array or contain a results array");
}

function changedLinesFromValidatedDiscovery(review: ReviewOutput): Map<string, ChangedLines> {
  const changedLines = new Map<string, ChangedLines>();
  for (const finding of review.findings) {
    const lines = changedLines.get(finding.path) ?? {
      left: new Set<number>(),
      right: new Set<number>(),
    };
    lines[finding.side === "LEFT" ? "left" : "right"].add(finding.line);
    changedLines.set(finding.path, lines);
  }
  return changedLines;
}

function sumNullable(values: Array<number | null>): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
