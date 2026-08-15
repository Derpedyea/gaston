import { describe, expect, it, vi } from "vitest";

import { emptyEvidenceCoverage, type EvidenceCoverage, type EvidenceTools } from "../src/evidence.ts";
import {
  replayVerificationPublication,
  verifyAndPublish,
  type VerificationRunner,
} from "../src/verification-pipeline.ts";
import type { DiscoveryReview } from "../src/prompts.ts";
import type { Finding, PullChangeSet, ReviewJob, VerificationOutput } from "../src/types.ts";

describe("verification pipeline", () => {
  it("rescues a high-risk insufficient candidate and publishes it through the same policy", async () => {
    const outputs = [
      verification([
        verdict("GASTON-CANDIDATE-1", 10, "confirmed", "GASTON-EVIDENCE-1"),
        verdict(
          "GASTON-CANDIDATE-2",
          20,
          "insufficient",
          undefined,
          0.95,
          "repository_reachability",
          "Whether the changed branch is reachable from the production caller.",
        ),
      ]),
      verification([
        verdict("GASTON-CANDIDATE-2", 20, "confirmed", "GASTON-EVIDENCE-2"),
      ]),
    ];
    const runVerification = vi.fn<VerificationRunner["runVerification"]>(async () => outputs.shift()!);
    const result = await verifyAndPublish({
      runner: { runVerification },
      tools: anchorTools(),
      job: reviewJob(),
      discoveries: discoveries(),
      changes: changes(),
      policy: "",
      changedLines: new Map([["src/a.ts", {
        left: new Set<number>(),
        right: new Set([10, 20]),
      }]]),
      discoveryCoverage: emptyEvidenceCoverage(1),
      configuredBaseThreshold: "0.80",
      configuredIncompleteEvidenceFloor: "0.88",
      maxFindings: 8,
    });

    expect(runVerification).toHaveBeenCalledTimes(2);
    expect(runVerification.mock.calls[1]?.[0]).toContain("GASTON-CANDIDATE-2");
    expect(runVerification.mock.calls[1]?.[0]).not.toContain("GASTON-CANDIDATE-1\"]");
    expect(runVerification.mock.calls[1]?.[0]).toContain("repository_reachability");
    expect(runVerification.mock.calls[1]?.[0]).toContain("production caller");
    expect(runVerification.mock.calls[1]?.[0]).toContain("GASTON-EVIDENCE-2");
    expect(runVerification.mock.calls[1]?.[0]).toContain("+changed");
    expect(result.rescue).toMatchObject({
      attemptedCandidateId: "GASTON-CANDIDATE-2",
      succeeded: true,
    });
    expect(result.review.findings.map((finding) => finding.title)).toEqual([
      "first bug",
      "second bug",
    ]);
    expect(result.resolution.candidateFates.map((fate) => fate.publication.reason)).toEqual([
      "published",
      "published",
    ]);
  });

  it("rescues all routeable medium candidates in one batched evidence-completion call", async () => {
    const outputs = [
      verification([
        verdict(
          "GASTON-CANDIDATE-1",
          10,
          "insufficient",
          undefined,
          0.91,
          "repository_reachability",
          "Whether the production caller reaches the changed branch.",
        ),
        verdict(
          "GASTON-CANDIDATE-2",
          20,
          "insufficient",
          undefined,
          0.90,
          "repository_symbol",
          "Whether the repository helper enables shell spawning.",
        ),
      ]),
      verification([
        verdict("GASTON-CANDIDATE-1", 10, "confirmed", "GASTON-EVIDENCE-1"),
        verdict("GASTON-CANDIDATE-2", 20, "confirmed", "GASTON-EVIDENCE-2"),
      ]),
    ];
    const runVerification = vi.fn<VerificationRunner["runVerification"]>(async () => outputs.shift()!);
    const mediumDiscoveries = discoveries().map((entry) => ({
      ...entry,
      review: {
        ...entry.review,
        findings: entry.review.findings.map((entryFinding) => ({
          ...entryFinding,
          severity: "medium" as const,
        })),
      },
    }));

    const result = await verifyAndPublish({
      runner: { runVerification },
      tools: anchorTools(),
      job: reviewJob(),
      discoveries: mediumDiscoveries,
      changes: changes(),
      policy: "",
      changedLines: new Map([["src/a.ts", { left: new Set(), right: new Set([10, 20]) }]]),
      discoveryCoverage: emptyEvidenceCoverage(1),
      configuredBaseThreshold: "0.80",
      configuredIncompleteEvidenceFloor: "0.88",
      maxFindings: 8,
    });

    expect(runVerification).toHaveBeenCalledTimes(2);
    expect(runVerification.mock.calls[1]?.[0]).toContain("GASTON-CANDIDATE-1");
    expect(runVerification.mock.calls[1]?.[0]).toContain("GASTON-CANDIDATE-2");
    expect(runVerification.mock.calls[1]?.[0]).toContain("prove that the claimed versions, processes, or components can coexist");
    expect(result.review.findings.map((entry) => entry.title)).toEqual(["first bug", "second bug"]);
    expect(result.rescues).toHaveLength(2);
  });

  it("searches repository-wide for an explicitly missing symbol before rescue", async () => {
    const inner = anchorTools();
    const searchArguments: Array<Record<string, unknown>> = [];
    const readPaths: string[] = [];
    const tools: EvidenceTools = {
      coverage: () => inner.coverage!(),
      async invoke(name, rawArguments, signal) {
        const args = JSON.parse(rawArguments) as Record<string, unknown>;
        if (name === "search_code") {
          searchArguments.push(args);
          return {
            status: "ok",
            content: JSON.stringify({
              matches: args.path_prefix === undefined
                ? [{ path: "packages/shared/src/shell.ts", line: 42 }]
                : [{ path: "src/a.ts", line: 160 }],
            }),
            retryable: false,
            evidence: { scope: `search:${searchArguments.length}`, complete: true },
          };
        }
        if (name === "read_file") {
          readPaths.push(String(args.path));
          return {
            status: "ok",
            content: `${String(args.path)}: export function resolveSpawnCommand() { return { shell: true }; }`,
            retryable: false,
            evidence: { scope: "read:shared-shell", complete: true },
          };
        }
        return inner.invoke(name, rawArguments, signal);
      },
    };
    let call = 0;
    const runVerification = vi.fn<VerificationRunner["runVerification"]>(async () => {
      call++;
      return verification([
        verdict(
          "GASTON-CANDIDATE-1",
          10,
          "insufficient",
          undefined,
          0.95,
          "repository_symbol",
          "The definition of resolveSpawnCommand is needed.",
        ),
        ...(call === 1 ? [verdict("GASTON-CANDIDATE-2", 20, "refuted", "GASTON-EVIDENCE-2")] : []),
      ]);
    });

    await verifyAndPublish({
      runner: { runVerification },
      tools,
      job: reviewJob(),
      discoveries: discoveries(),
      changes: changes(),
      policy: "",
      changedLines: new Map([["src/a.ts", { left: new Set(), right: new Set([10, 20]) }]]),
      discoveryCoverage: emptyEvidenceCoverage(1),
      configuredBaseThreshold: "0.80",
      configuredIncompleteEvidenceFloor: "0.88",
      maxFindings: 8,
    });

    expect(searchArguments).toEqual([
      { query: "resolveSpawnCommand", path_prefix: "src", limit: 20 },
      { query: "resolveSpawnCommand", limit: 20 },
    ]);
    expect(runVerification.mock.calls[1]?.[0]).toContain("packages/shared/src/shell.ts");
    expect(readPaths).toContain("src/a.ts");
    expect(runVerification.mock.calls[1]?.[0]).toContain("resolveSpawnCommand() { return { shell: true }");
  });

  it("does not spend a rescue call on an evidence gap the available tools cannot route", async () => {
    const runVerification = vi.fn<VerificationRunner["runVerification"]>(async () => verification([
      verdict(
        "GASTON-CANDIDATE-1",
        10,
        "insufficient",
        undefined,
        0.95,
        "unknown",
        "Whether the external service performs undocumented normalization at runtime.",
      ),
      verdict("GASTON-CANDIDATE-2", 20, "refuted", "GASTON-EVIDENCE-2"),
    ]));

    const result = await verifyAndPublish({
      runner: { runVerification },
      tools: anchorTools(),
      job: reviewJob(),
      discoveries: discoveries(),
      changes: changes(),
      policy: "",
      changedLines: new Map([["src/a.ts", {
        left: new Set<number>(),
        right: new Set([10, 20]),
      }]]),
      discoveryCoverage: emptyEvidenceCoverage(1),
      configuredBaseThreshold: "0.80",
      configuredIncompleteEvidenceFloor: "0.88",
      maxFindings: 8,
    });

    expect(runVerification).toHaveBeenCalledTimes(1);
    expect(result.rescue).toBeUndefined();
    expect(result.rescueDecision).toEqual({
      candidateId: "GASTON-CANDIDATE-1",
      decision: "skipped_unrouteable",
      gapKind: "unknown",
    });
  });

  it("can isolate candidates into bounded path-local verification clusters", async () => {
    let call = 0;
    const runVerification = vi.fn<VerificationRunner["runVerification"]>(async () => {
      call++;
      return verification([
        verdict(`GASTON-CANDIDATE-${call}`, call === 1 ? 10 : 20, "confirmed", `GASTON-EVIDENCE-${call}`),
      ]);
    });
    const result = await verifyAndPublish({
      runner: { runVerification },
      tools: anchorTools(),
      job: reviewJob(),
      discoveries: discoveries(),
      changes: changes(),
      policy: "",
      changedLines: new Map([["src/a.ts", { left: new Set(), right: new Set([10, 20]) }]]),
      discoveryCoverage: emptyEvidenceCoverage(1),
      configuredBaseThreshold: "0.80",
      configuredIncompleteEvidenceFloor: "0.88",
      maxFindings: 8,
      verificationClusterSize: 1,
      rescueHighRisk: false,
    });

    expect(runVerification).toHaveBeenCalledTimes(2);
    expect(result.clusters).toEqual([["GASTON-CANDIDATE-1"], ["GASTON-CANDIDATE-2"]]);
    expect(result.review.findings).toHaveLength(2);
  });

  it("does not rescue a dependency gap after the dependency tool already failed", async () => {
    const inner = anchorTools();
    const tools: EvidenceTools = {
      coverage: () => inner.coverage!(),
      async invoke(name, rawArguments, signal) {
        if (name !== "dependency_source") return inner.invoke(name, rawArguments, signal);
        return {
          status: "permanent_error",
          content: "uv.lock is unavailable",
          retryable: false,
          evidence: { scope: "dependency_source:pydantic-ai:RequestUsage", complete: false },
        };
      },
    };
    const runVerification = vi.fn<VerificationRunner["runVerification"]>(async (_prompt, verifierTools) => {
      await verifierTools.invoke("dependency_source", JSON.stringify({
        package: "pydantic-ai",
        query: "RequestUsage",
      }));
      return verification([
        verdict(
          "GASTON-CANDIDATE-1",
          10,
          "insufficient",
          undefined,
          0.95,
          "dependency_contract",
          "Whether RequestUsage includes cached input tokens.",
        ),
        verdict("GASTON-CANDIDATE-2", 20, "refuted", "GASTON-EVIDENCE-2"),
      ]);
    });

    const result = await verifyAndPublish({
      runner: { runVerification },
      tools,
      job: reviewJob(),
      discoveries: discoveries(),
      changes: changes(),
      policy: "",
      changedLines: new Map([["src/a.ts", { left: new Set(), right: new Set([10, 20]) }]]),
      discoveryCoverage: emptyEvidenceCoverage(1),
      configuredBaseThreshold: "0.80",
      configuredIncompleteEvidenceFloor: "0.88",
      maxFindings: 8,
    });

    expect(runVerification).toHaveBeenCalledTimes(1);
    expect(result.rescueDecision).toEqual({
      decision: "skipped_unrouteable",
      candidateId: "GASTON-CANDIDATE-1",
      gapKind: "dependency_contract",
    });
  });

  it("replays a verifier transcript deterministically without another model call", () => {
    const input = {
      verification: verification([
        verdict("GASTON-CANDIDATE-1", 10, "confirmed", "proof:one", 0.79),
        verdict("GASTON-CANDIDATE-2", 20, "refuted", "proof:two"),
      ]),
      discoveries: discoveries().map(({ review }) => review),
      verificationCoverage: coverage(["proof:one", "proof:two"]),
      changedLines: new Map([["src/a.ts", {
        left: new Set<number>(),
        right: new Set([10, 20]),
      }]]),
      discoveryCoverage: emptyEvidenceCoverage(1),
      configuredBaseThreshold: "0.80",
      configuredIncompleteEvidenceFloor: "0.88",
      maxFindings: 8,
    };

    const first = replayVerificationPublication(input);
    const second = replayVerificationPublication(input);

    expect(second).toEqual(first);
    expect(first.resolution.candidateFates.map((fate) => ({
      verification: fate.verification.reason,
      publication: fate.publication.reason,
    }))).toEqual([
      { verification: "confirmed", publication: "below_confidence" },
      { verification: "refuted", publication: "not_confirmed" },
    ]);
  });
});

function discoveries(): DiscoveryReview[] {
  return [{
    source: "discovery",
    review: {
      summary: "two candidates",
      findings: [
        finding("first bug", 10, "blocker"),
        finding("second bug", 20, "high"),
      ],
    },
  }];
}

function finding(title: string, line: number, severity: Finding["severity"]): Finding {
  return {
    path: "src/a.ts",
    line,
    side: "RIGHT",
    severity,
    title,
    why: "trigger reaches changed line and fails",
    evidence: "changed expression",
    suggestedFix: "correct it",
    confidence: 0.95,
  };
}

function verification(verdicts: VerificationOutput["verdicts"]): VerificationOutput {
  return { summary: "verified", verdicts };
}

function verdict(
  candidateId: string,
  line: number,
  kind: "confirmed" | "refuted" | "insufficient",
  scope?: string,
  confidence = 0.95,
  missingEvidenceKind: VerificationOutput["verdicts"][number]["missingEvidenceKind"] = null,
  missingEvidence = "",
): VerificationOutput["verdicts"][number] {
  const complete = kind !== "insufficient";
  return {
    candidateId,
    verdict: kind,
    path: "src/a.ts",
    line,
    side: "RIGHT",
    confidence,
    rationale: "checked",
    evidence: complete ? "proof" : "gap",
    evidenceComplete: complete,
    evidenceScopes: scope === undefined ? [] : [scope],
    missingEvidenceKind,
    missingEvidence,
    valid: true,
  };
}

function anchorTools(): EvidenceTools {
  const completed: string[] = [];
  const changed: NonNullable<EvidenceCoverage["completedChangedPatchScopes"]> = [];
  return {
    async invoke(_name, rawArguments) {
      const args = JSON.parse(rawArguments) as { path: string; source_line: number; side: "LEFT" | "RIGHT" };
      const scope = `raw:${args.source_line}`;
      completed.push(scope);
      changed.push({
        scope,
        path: args.path,
        kind: "source",
        sourceLine: args.source_line,
        sourceSide: args.side,
      });
      return {
        status: "ok",
        content: JSON.stringify({
          path: args.path,
          requestedSourceLine: args.source_line,
          requestedSourceSide: args.side,
          sourcePatchLine: 1,
          patchStartLine: 1,
          patchEndLine: 1,
          patch: "+changed",
        }),
        retryable: false,
        evidence: {
          scope,
          complete: true,
          sourceTargeted: true,
          sourceLine: args.source_line,
          sourceSide: args.side,
          changedPath: args.path,
        },
      };
    },
    coverage: () => ({
      ...emptyEvidenceCoverage(1),
      inspectedChangedFiles: 1,
      toolCalls: completed.length,
      okResults: completed.length,
      completedEvidenceScopes: [...completed],
      completedChangedPatchScopes: [...changed],
    }),
  };
}

function coverage(scopes: string[]): EvidenceCoverage {
  return {
    ...emptyEvidenceCoverage(1),
    completedEvidenceScopes: scopes,
    completedChangedPatchScopes: scopes.map((scope, index) => ({
      scope,
      path: "src/a.ts",
      kind: "source",
      sourceLine: index === 0 ? 10 : 20,
      sourceSide: "RIGHT",
    })),
  };
}

function reviewJob(): ReviewJob {
  return {
    deliveryId: "delivery",
    installationId: 1,
    owner: "owner",
    repo: "repo",
    pullNumber: 1,
    title: "change",
    body: "",
    baseRef: "main",
    baseSha: "base",
    headSha: "head",
    queuedAt: "2026-01-01T00:00:00.000Z",
    trigger: "automatic",
  };
}

function changes(): PullChangeSet {
  return {
    files: [{
      path: "src/a.ts",
      status: "modified",
      additions: 2,
      deletions: 0,
      patch: "@@ -1 +1,2 @@\n+changed",
    }],
    diff: "",
    truncated: false,
  };
}

const _runnerTypeCheck: VerificationRunner | undefined = undefined;
void _runnerTypeCheck;
