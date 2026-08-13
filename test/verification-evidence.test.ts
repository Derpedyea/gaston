import { describe, expect, it, vi } from "vitest";

import type { EvidenceCoverage, EvidenceResult, EvidenceTools } from "../src/evidence.ts";
import type { ReviewOutput } from "../src/types.ts";
import {
  prefetchVerificationAnchors,
  withOpaqueEvidenceHandles,
} from "../src/verification-evidence.ts";

describe("verification anchor evidence", () => {
  it("prefetches a compact exact-anchor capsule for every candidate", async () => {
    const invoke = vi.fn(async (_name: string, rawArguments: string) => {
      const args = JSON.parse(rawArguments) as { path: string; source_line: number; side: "LEFT" | "RIGHT" };
      return {
        status: "ok" as const,
        content: JSON.stringify({
          path: args.path,
          patchStartLine: 1,
          patchEndLine: 201,
          totalPatchLines: 201,
          requestedSourceLine: args.source_line,
          requestedSourceSide: args.side,
          sourcePatchLine: 101,
          patch: Array.from({ length: 201 }, (_, index) => `${index + 1}:${"context".repeat(40)}`).join("\n"),
          hasMoreBefore: false,
          hasMoreAfter: false,
        }),
        retryable: false,
        evidence: {
          scope: `diff_for_file:${args.path}:source:${args.side}:${args.source_line}`,
          complete: true,
          sourceTargeted: true,
          sourceLine: args.source_line,
          sourceSide: args.side,
          changedPath: args.path,
        },
      };
    });
    const tools: EvidenceTools = { invoke };

    const evidence = await prefetchVerificationAnchors([review()], tools);

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke).toHaveBeenNthCalledWith(1, "diff_for_source_line", JSON.stringify({
      path: "src/one.ts",
      source_line: 10,
      side: "RIGHT",
    }), undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, "diff_for_source_line", JSON.stringify({
      path: "src/two.ts",
      source_line: 20,
      side: "LEFT",
    }), undefined);
    expect(invoke).toHaveBeenNthCalledWith(3, "diff_for_source_line", JSON.stringify({
      path: "src/three.ts",
      source_line: 30,
      side: "RIGHT",
    }), undefined);
    expect(evidence.map((entry) => entry.candidateId)).toEqual([
      "GASTON-CANDIDATE-1",
      "GASTON-CANDIDATE-2",
      "GASTON-CANDIDATE-3",
    ]);
    expect(evidence.map((entry) => entry.result.evidence?.scope)).toEqual([
      "diff_for_file:src/one.ts:source:RIGHT:10",
      "diff_for_file:src/two.ts:source:LEFT:20",
      "diff_for_file:src/three.ts:source:RIGHT:30",
    ]);
    for (const entry of evidence) {
      expect(new TextEncoder().encode(entry.result.content).byteLength).toBeLessThanOrEqual(10_667);
      expect(JSON.parse(entry.result.content)).toMatchObject({
        verificationAnchorCapsule: true,
        requestedSourceLine: entry.line,
        requestedSourceSide: entry.side,
      });
    }
  });

  it("issues opaque handles and lets a complete narrow read supersede a broad truncated read", async () => {
    let calls = 0;
    const broadScope = "read_file:head:pydantic_ai_harness/compaction/_shared.py:1-400";
    const narrowScope = "read_file:head:pydantic_ai_harness/compaction/_shared.py:80-120";
    const inner: EvidenceTools = {
      async invoke(): Promise<EvidenceResult> {
        calls++;
        return calls === 1
          ? {
              status: "truncated",
              content: "broad partial read",
              retryable: false,
              evidence: { scope: broadScope, complete: false },
              suggestedAction: "Read a narrower range.",
            }
          : {
              status: "ok",
              content: "complete narrow read",
              retryable: false,
              evidence: { scope: narrowScope, complete: true },
            };
      },
      coverage(): EvidenceCoverage {
        return coverage({
          sufficient: calls < 1,
          toolCalls: calls,
          okResults: calls > 1 ? 1 : 0,
          truncatedResults: calls > 0 ? 1 : 0,
          limitations: calls > 0 ? ["read_file: Read a narrower range."] : [],
          unresolvedEvidence: calls > 0 ? [{
            scope: broadScope,
            status: "truncated",
            limitation: "read_file: Read a narrower range.",
          }] : [],
          completedEvidenceScopes: calls > 1 ? [narrowScope] : [],
        });
      },
    };
    const tools = withOpaqueEvidenceHandles(inner);

    const broad = await tools.invoke("read_file", JSON.stringify({
      path: "pydantic_ai_harness/compaction/_shared.py",
      ref: "head",
      start_line: 1,
      end_line: 400,
    }));
    const narrow = await tools.invoke("read_file", JSON.stringify({
      path: "pydantic_ai_harness/compaction/_shared.py",
      ref: "head",
      start_line: 80,
      end_line: 120,
    }));

    expect(broad.evidence?.scope).toBe("GASTON-EVIDENCE-1");
    expect(narrow.evidence?.scope).toBe("GASTON-EVIDENCE-2");
    expect(JSON.stringify([broad.evidence, narrow.evidence])).not.toContain("pydantic_ai_harness");
    expect(tools.coverage?.()).toMatchObject({
      sufficient: true,
      limitations: [],
      unresolvedEvidence: [],
      completedEvidenceScopes: ["GASTON-EVIDENCE-1", "GASTON-EVIDENCE-2"],
    });
  });
});

function review(): ReviewOutput {
  return {
    summary: "three candidates",
    findings: [
      finding("src/one.ts", 10, "RIGHT"),
      finding("src/two.ts", 20, "LEFT"),
      finding("src/three.ts", 30, "RIGHT"),
    ],
  };
}

function finding(path: string, line: number, side: "LEFT" | "RIGHT") {
  return {
    path,
    line,
    side,
    severity: "medium" as const,
    title: "candidate",
    why: "trigger to failure",
    evidence: "changed line",
    suggestedFix: "fix",
    confidence: 0.9,
  };
}

function coverage(overrides: Partial<EvidenceCoverage> = {}): EvidenceCoverage {
  return {
    sufficient: true,
    totalChangedFiles: 1,
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
    ...overrides,
  };
}
