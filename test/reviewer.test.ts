import { describe, expect, it, vi } from "vitest";

import { withCheckpoint } from "../src/checkpoint.ts";
import { runOwnedOperations, shouldInterruptForAcceptedClaim } from "../src/coordinator.ts";
import type { EvidenceCoverage } from "../src/evidence.ts";
import {
  INCOMPLETE_VERIFICATION_LIMITATION,
  publicationPolicyForEvidence,
  shouldUseDirectDiscovery,
  WITHHELD_CONFIRMED_FINDING_LIMITATION,
} from "../src/review-core.ts";

describe("review checkpoints", () => {
  it("uses shallow discovery only when enabled and the entire diff evidence is complete", () => {
    expect(shouldUseDirectDiscovery("true", { sufficient: true })).toBe(true);
    expect(shouldUseDirectDiscovery("true", { sufficient: false })).toBe(false);
    expect(shouldUseDirectDiscovery("false", { sufficient: true })).toBe(false);
    expect(shouldUseDirectDiscovery(undefined, { sufficient: true })).toBe(false);
  });

  it("reuses completed work after a later retry", async () => {
    const values = new Map<string, unknown>();
    const compute = vi.fn(async () => ({ source: "specialist:behavior", review: { summary: "done", findings: [] } }));
    const get = async () => values.get("lens") as Awaited<ReturnType<typeof compute>> | undefined;
    const put = async (value: Awaited<ReturnType<typeof compute>>) => {
      values.set("lens", value);
    };

    await expect(withCheckpoint(get, put, compute)).resolves.toEqual({
      value: { source: "specialist:behavior", review: { summary: "done", findings: [] } },
      cached: false,
    });
    await expect(withCheckpoint(get, put, compute)).resolves.toEqual({
      value: { source: "specialist:behavior", review: { summary: "done", findings: [] } },
      cached: true,
    });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("does not save failed work", async () => {
    const put = vi.fn(async () => undefined);

    await expect(withCheckpoint(
      async () => undefined,
      put,
      async () => {
        throw new Error("provider failed");
      },
    )).rejects.toThrow("provider failed");
    expect(put).not.toHaveBeenCalled();
  });

  it("unions separate discovery and verification patch intervals before applying the complete-evidence threshold", () => {
    const discovery = coverage({
      sufficient: false,
      totalChangedFiles: 1,
      initialDiffTruncated: true,
      limitations: [
        "The initial cumulative diff was truncated; inspect 1 more exact changed-file patch.",
        "diff_for_file: recover the advertised tail",
      ],
      unresolvedEvidence: [{
        scope: "diff_for_file:src/a.ts",
        status: "truncated",
        limitation: "diff_for_file: recover the advertised tail",
        changedPatchPath: "src/a.ts",
        changedPatchRange: { start: 201, end: 451 },
      }],
      changedPatchCoverage: [{
        path: "src/a.ts",
        totalPatchLines: 450,
        intervals: [{ start: 1, end: 201 }],
      }],
    });
    const verification = coverage({
      sufficient: false,
      totalChangedFiles: 1,
      inspectedChangedFiles: 0,
      initialDiffTruncated: true,
      limitations: [
        "The initial cumulative diff was truncated; inspect 1 more exact changed-file patch.",
        "diff_for_file: partial tail in the resumed tracker",
      ],
      unresolvedEvidence: [{
        scope: "diff_for_file:src/a.ts:201-450",
        status: "truncated",
        limitation: "diff_for_file: partial tail in the resumed tracker",
        changedPatchPath: "src/a.ts",
      }],
      changedPatchCoverage: [{
        path: "src/a.ts",
        totalPatchLines: 450,
        intervals: [{ start: 201, end: 451 }],
      }],
    });

    const policy = publicationPolicyForEvidence(
      discovery,
      verification,
      false,
      "0.81",
      "0.93",
    );

    expect(policy.minConfidence).toBe(0.81);
    expect(policy.coverage).toMatchObject({
      sufficient: true,
      inspectedChangedFiles: 1,
      inspectedChangedPaths: ["src/a.ts"],
      limitations: [],
      changedPatchCoverage: [{
        path: "src/a.ts",
        totalPatchLines: 450,
        intervals: [{ start: 1, end: 451 }],
      }],
    });
  });

  it("uses the stricter configured floor when repository evidence remains incomplete", () => {
    const incomplete = coverage({
      sufficient: false,
      limitations: ["read_file: permanent error"],
      unresolvedEvidence: [{
        scope: "read_file:head:src/a.ts:1-40",
        status: "permanent_error",
        limitation: "read_file: permanent error",
      }],
    });

    expect(publicationPolicyForEvidence(
      coverage(),
      incomplete,
      false,
      "0.80",
      "0.91",
    )).toMatchObject({
      minConfidence: 0.91,
      coverage: { sufficient: false, limitations: ["read_file: permanent error"] },
    });
    expect(publicationPolicyForEvidence(
      coverage(),
      incomplete,
      false,
      "0.94",
      "0.91",
    ).minConfidence).toBe(0.94);
  });

  it("uses production confidence fallbacks for absent or malformed configuration", () => {
    expect(publicationPolicyForEvidence(
      coverage(),
      coverage(),
      false,
      undefined,
      undefined,
    ).minConfidence).toBe(0.80);
    expect(publicationPolicyForEvidence(
      coverage(),
      coverage({ sufficient: false, limitations: ["unavailable"] }),
      false,
      "not-a-number",
      "also-invalid",
    ).minConfidence).toBe(0.88);
  });

  it("turns an unresolved verification candidate into neutral incomplete coverage", () => {
    const policy = publicationPolicyForEvidence(
      coverage({ completedEvidenceScopes: ["diff_for_file:src/a.ts"] }),
      coverage({ completedEvidenceScopes: ["read_file:head:src/a.ts:1-20"] }),
      true,
      "0.80",
      "0.88",
    );

    expect(policy).toMatchObject({
      minConfidence: 0.88,
      coverage: {
        sufficient: false,
        limitations: [INCOMPLETE_VERIFICATION_LIMITATION],
        completedEvidenceScopes: [
          "diff_for_file:src/a.ts",
          "read_file:head:src/a.ts:1-20",
        ],
      },
    });
  });

  it("turns a policy-withheld confirmation into neutral coverage without mislabeling it unresolved", () => {
    const policy = publicationPolicyForEvidence(
      coverage(),
      coverage(),
      false,
      "0.80",
      "0.88",
      true,
    );

    expect(policy).toMatchObject({
      minConfidence: 0.88,
      coverage: {
        sufficient: false,
        limitations: [WITHHELD_CONFIRMED_FINDING_LIMITATION],
      },
    });
    expect(policy.coverage.limitations).not.toContain(INCOMPLETE_VERIFICATION_LIMITATION);
  });
});

describe("review lease fencing", () => {
  it("interrupts only older claimed work or an unclaimed preparation that cannot be newer", () => {
    const older = "2026-08-10T01:00:00.000Z";
    const current = "2026-08-10T02:00:00.000Z";
    const newer = "2026-08-10T03:00:00.000Z";

    expect(shouldInterruptForAcceptedClaim(undefined, older, 3, current)).toBe(true);
    expect(shouldInterruptForAcceptedClaim(undefined, current, 3, current)).toBe(true);
    expect(shouldInterruptForAcceptedClaim(undefined, newer, 3, current)).toBe(false);
    expect(shouldInterruptForAcceptedClaim(2, newer, 3, current)).toBe(true);
    expect(shouldInterruptForAcceptedClaim(3, older, 3, current)).toBe(false);
    expect(shouldInterruptForAcceptedClaim(4, older, 3, current)).toBe(false);
  });

  it("stops before summary, check completion, and outcome work when publication loses the lease", async () => {
    let ownsLease = true;
    const publish = vi.fn(async () => {
      // Models a review POST that committed just before a newer durable claim.
      ownsLease = false;
    });
    const summary = vi.fn(async () => undefined);
    const completeCheck = vi.fn(async () => undefined);
    const outcome = vi.fn(async () => undefined);

    const result = await runOwnedOperations(
      async () => ownsLease,
      [
        { name: "publish-review", run: publish },
        { name: "upsert-summary", run: summary },
        { name: "complete-check", run: completeCheck },
        { name: "persist-outcome", run: outcome },
      ],
    );

    expect(result).toEqual({
      status: "stale",
      operation: "publish-review",
      operationCommitted: true,
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(summary).not.toHaveBeenCalled();
    expect(completeCheck).not.toHaveBeenCalled();
    expect(outcome).not.toHaveBeenCalled();
  });

  it("reports an aborted publication as ambiguous when ownership is lost before its response arrives", async () => {
    let ownsLease = true;
    const publicationError = new DOMException("The operation was aborted", "AbortError");
    const publish = vi.fn(async () => {
      // The server may have committed the POST before the client observes this
      // abort, so a rejection cannot be treated as proof that nothing happened.
      ownsLease = false;
      throw publicationError;
    });
    const summary = vi.fn(async () => undefined);

    const result = await runOwnedOperations(
      async () => ownsLease,
      [
        { name: "publish-review", run: publish },
        { name: "upsert-summary", run: summary },
      ],
    );

    expect(result).toEqual({
      status: "stale",
      operation: "publish-review",
      operationCommitted: false,
      operationMayHaveCommitted: true,
      operationError: publicationError,
    });
    expect(publish).toHaveBeenCalledOnce();
    expect(summary).not.toHaveBeenCalled();
  });

  it("preserves ordinary error handling when a rejected operation still owns the lease", async () => {
    const dependencyError = new Error("GitHub rejected the write");

    await expect(runOwnedOperations(
      async () => true,
      [{
        name: "publish-review",
        run: async () => {
          throw dependencyError;
        },
      }],
    )).rejects.toBe(dependencyError);
  });

  it("does not begin a terminal operation after ownership is already gone", async () => {
    const terminalWrite = vi.fn(async () => undefined);

    await expect(runOwnedOperations(
      async () => false,
      [{ name: "complete-check", run: terminalWrite }],
    )).resolves.toEqual({
      status: "stale",
      operation: "complete-check",
      operationCommitted: false,
    });
    expect(terminalWrite).not.toHaveBeenCalled();
  });
});

function coverage(overrides: Partial<EvidenceCoverage> = {}): EvidenceCoverage {
  return {
    sufficient: true,
    totalChangedFiles: 0,
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
    completeChangedFileRanges: [],
    changedPatchCoverage: [],
    ...overrides,
  };
}
