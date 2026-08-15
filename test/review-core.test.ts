import { describe, expect, it } from "vitest";
import { emptyEvidenceCoverage, EvidenceCoverageTracker, mergeEvidenceCoverage } from "../src/evidence.ts";
import {
  confidenceThresholdForEvidence,
  finalizeVerificationPublication,
  filterFindings,
  parseChangedFileLines,
  parseChangedLines,
  parseReviewOutput,
  parseVerificationOutput,
  PRIOR_SAME_COMPARISON_FINDING_LIMITATION,
  reconcileCleanRerunWithPriorReview,
  resolveVerificationVerdicts,
  shouldRequestChanges,
  summarizeVerificationPublication,
  tagVerificationCandidates,
} from "../src/review-core.ts";

describe("same-comparison clean reruns", () => {
  it("keeps a clean rerun neutral when an immutable comparison already has findings", () => {
    const result = reconcileCleanRerunWithPriorReview(
      { summary: "No bugs found.", findings: [] },
      emptyEvidenceCoverage(1),
      true,
    );

    expect(result).toMatchObject({
      preserveExistingSummary: true,
      review: { findings: [] },
      coverage: {
        sufficient: false,
        limitations: [PRIOR_SAME_COMPARISON_FINDING_LIMITATION],
      },
    });
    expect(result.review.summary).toContain("not a clean-review assertion");
  });

  it("does not suppress a newly found bug on the rerun", () => {
    const review = parseReviewOutput(JSON.stringify({
      summary: "A new bug survived verification.",
      findings: [finding({ title: "newly discovered bug" })],
    }));
    const coverage = emptyEvidenceCoverage(1);

    expect(reconcileCleanRerunWithPriorReview(review, coverage, true)).toEqual({
      review,
      coverage,
      preserveExistingSummary: false,
    });
  });
});

describe("parseChangedLines", () => {
  it("tracks added and deleted lines by the new path", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,2 +10,3 @@",
      "-old one",
      "-old two",
      "+new one",
      "+new two",
      "+new three",
      "diff --git a/old.ts b/new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -7 +7 @@",
      "-before",
      "+after",
    ].join("\n");

    const changed = parseChangedLines(diff);
    expect([...changed.get("src/a.ts")!.left]).toEqual([10, 11]);
    expect([...changed.get("src/a.ts")!.right]).toEqual([10, 11, 12]);
    expect([...changed.get("new.ts")!.left]).toEqual([7]);
    expect([...changed.get("new.ts")!.right]).toEqual([7]);
  });

  it("uses the old path for a deleted file", () => {
    const diff = [
      "--- a/deleted.ts",
      "+++ /dev/null",
      "@@ -3 +0,0 @@",
      "-gone",
    ].join("\n");
    expect([...parseChangedLines(diff).get("deleted.ts")!.left]).toEqual([3]);
  });

  it("tracks changed lines from every per-file patch beyond the aggregate excerpt", () => {
    const changed = parseChangedFileLines([
      {
        path: "src/first.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
      {
        path: "src/beyond-excerpt.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -40,0 +41 @@\n+important",
      },
    ]);

    expect([...changed.get("src/first.ts")!.right]).toEqual([1]);
    expect([...changed.get("src/beyond-excerpt.ts")!.right]).toEqual([41]);
  });

  it("treats source text beginning with ++ or -- as changed code inside a hunk", () => {
    const diff = [
      "diff --git a/src/operators.ts b/src/operators.ts",
      "--- a/src/operators.ts",
      "+++ b/src/operators.ts",
      "@@ -7 +7 @@",
      "---oldValue",
      "+++newValue",
    ].join("\n");

    const changed = parseChangedLines(diff).get("src/operators.ts")!;
    expect([...changed.left]).toEqual([7]);
    expect([...changed.right]).toEqual([7]);
  });
});

describe("review output", () => {
  it("extracts fenced JSON and normalizes fields", () => {
    const review = parseReviewOutput(`Result:\n\`\`\`json
      {"summary":"Risk found","findings":[{
        "path":"./src/a.ts","line":10,"side":"right","severity":"HIGH",
        "title":"Drops writes","why":"A retry loses data","evidence":"caller retries",
        "suggested_fix":"persist before ack","confidence":0.91
      }]}
    \`\`\``);

    expect(review.findings[0]).toMatchObject({
      path: "src/a.ts",
      side: "RIGHT",
      severity: "high",
      suggestedFix: "persist before ack",
    });
  });

  it("filters low-confidence, unchanged-line, and duplicate findings", () => {
    const review = parseReviewOutput(JSON.stringify({
      summary: "summary",
      findings: [
        finding({ title: "real", confidence: 0.95 }),
        finding({ title: "real", confidence: 0.95 }),
        finding({ title: "weak", confidence: 0.4 }),
        finding({ title: "unchanged", line: 99, confidence: 0.99 }),
      ],
    }));
    const changed = new Map([["src/a.ts", { left: new Set<number>(), right: new Set([10]) }]]);
    const filtered = filterFindings(review, changed, 0.82, 8);
    expect(filtered.findings.map((item) => item.title)).toEqual(["real"]);
  });

  it("raises the publication threshold only while evidence coverage is incomplete", () => {
    const changed = new Map([["src/a.ts", { left: new Set<number>(), right: new Set([10]) }]]);
    const select = (
      confidence: number,
      coverageSufficient: boolean,
      baseThreshold = 0.80,
      incompleteEvidenceFloor = 0.88,
    ) => filterFindings(parseReviewOutput(JSON.stringify({
      summary: "verified",
      findings: [finding({ title: `candidate-${confidence}`, confidence })],
    })), changed, confidenceThresholdForEvidence(
      coverageSufficient,
      baseThreshold,
      incompleteEvidenceFloor,
    ), 8).findings;

    expect(select(0.82, true)).toHaveLength(1);
    expect(select(0.82, false)).toHaveLength(0);
    expect(select(0.88, false)).toHaveLength(1);
    expect(select(0.90, false, 0.91, 0.88)).toHaveLength(0);
    expect(confidenceThresholdForEvidence(false, 0.91, 0.88)).toBe(0.91);
  });

  it("never relocates a finding from unchanged nearby code onto a changed line", () => {
    const review = parseReviewOutput(JSON.stringify({
      summary: "summary",
      findings: [finding({ line: 12, side: "RIGHT", title: "pre-existing nearby behavior" })],
    }));
    const changed = new Map([[
      "src/a.ts",
      { left: new Set<number>(), right: new Set([10]) },
    ]]);

    expect(filterFindings(review, changed, 0.82, 8).findings).toEqual([]);
  });

  it("rejects control characters and traversal in model-provided paths", () => {
    const review = parseReviewOutput(JSON.stringify({
      summary: "summary",
      findings: [
        finding({ path: "../secret" }),
        finding({ path: "src/bad\nname.ts" }),
        finding({ path: "src\\windows.ts" }),
      ],
    }));
    expect(review.findings).toEqual([]);
  });
});

describe("tri-state verification", () => {
  it("preserves discovery prose and its exact changed anchor for confirmed findings", () => {
    const tagged = taggedDiscovery([
      finding({
        title: "drops writes",
        why: "original causal proof",
        evidence: "original discovery evidence",
        suggestedFix: "original fix",
      }),
    ]);
    const resolution = resolveVerificationVerdicts(verification([
      verdict("GASTON-CANDIDATE-1", {
        confidence: 0.94,
        rationale: "rewritten verifier prose",
        evidence: "independent verifier evidence",
      }),
    ]), [tagged], completedScopes());

    expect(resolution.review.findings).toEqual([
      expect.objectContaining({
        title: "drops writes",
        why: "original causal proof",
        evidence: "original discovery evidence",
        suggestedFix: "original fix",
        path: "src/a.ts",
        line: 10,
        side: "RIGHT",
        confidence: 0.94,
      }),
    ]);
    expect(resolution.confirmedCandidateIds).toEqual(["GASTON-CANDIDATE-1"]);
    expect(resolution.candidateFates).toEqual([
      expect.objectContaining({
        candidateId: "GASTON-CANDIDATE-1",
        verification: expect.objectContaining({
          state: "confirmed",
          reason: "confirmed",
          confidence: 0.94,
        }),
        publication: { state: "pending", reason: null },
      }),
    ]);
    expect(resolution.incomplete).toBe(false);
  });

  it("records confirmed, evidence-backed refuted, and explicit insufficient verdicts separately", () => {
    const tagged = taggedDiscovery([
      finding({ title: "confirmed", line: 10 }),
      finding({ title: "refuted", line: 11 }),
      finding({ title: "unresolved", line: 12 }),
    ]);
    const resolution = resolveVerificationVerdicts(verification([
      verdict("GASTON-CANDIDATE-1", { line: 10, verdict: "confirmed" }),
      verdict("GASTON-CANDIDATE-2", { line: 11, verdict: "refuted" }),
      verdict("GASTON-CANDIDATE-3", {
        line: 12,
        verdict: "insufficient",
        evidenceComplete: false,
        evidenceScopes: [],
        missingEvidenceKind: "repository_reachability",
        missingEvidence: "Whether the production caller reaches this branch.",
      }),
    ]), [tagged], completedScopes());

    expect(resolution.review.findings.map((entry) => entry.title)).toEqual(["confirmed"]);
    expect(resolution.refutedCandidateIds).toEqual(["GASTON-CANDIDATE-2"]);
    expect(resolution.insufficientCandidateIds).toEqual(["GASTON-CANDIDATE-3"]);
    expect(resolution.incomplete).toBe(true);
  });

  it("turns missing and duplicate candidate verdicts into insufficient", () => {
    const tagged = taggedDiscovery([
      finding({ title: "duplicate", line: 10 }),
      finding({ title: "omitted", line: 11 }),
    ]);
    const duplicate = verdict("GASTON-CANDIDATE-1", { line: 10 });
    const resolution = resolveVerificationVerdicts(
      verification([duplicate, duplicate]),
      [tagged],
      completedScopes(),
    );

    expect(resolution.review.findings).toEqual([]);
    expect(resolution.refutedCandidateIds).toEqual([]);
    expect(resolution.insufficientCandidateIds).toEqual([
      "GASTON-CANDIDATE-1",
      "GASTON-CANDIDATE-2",
    ]);
    expect(resolution.candidateFates.map((entry) => entry.verification.reason)).toEqual([
      "duplicate_verdict",
      "missing_verdict",
    ]);
  });

  it("does not let unknown, malformed, or anchor-mismatched entries become refutations", () => {
    const tagged = taggedDiscovery([
      finding({ title: "malformed", line: 10 }),
      finding({ title: "wrong anchor", line: 20 }),
    ]);
    const malformed = {
      ...verdict("GASTON-CANDIDATE-1", { verdict: "refuted", line: 10 }),
      unexpected: true,
    };
    const resolution = resolveVerificationVerdicts(verification([
      malformed,
      verdict("GASTON-CANDIDATE-2", { verdict: "refuted", line: 21 }),
      verdict("GASTON-CANDIDATE-999", { verdict: "refuted" }),
    ]), [tagged], completedScopes());

    expect(resolution.refutedCandidateIds).toEqual([]);
    expect(resolution.insufficientCandidateIds).toEqual([
      "GASTON-CANDIDATE-1",
      "GASTON-CANDIDATE-2",
    ]);
    expect(resolution.invalidVerdictCount).toBe(1);
    expect(resolution.incomplete).toBe(true);
  });

  it("downgrades an unsupported refutation to insufficient", () => {
    const tagged = taggedDiscovery([finding({ title: "needs evidence" })]);
    const resolution = resolveVerificationVerdicts(verification([
      verdict("GASTON-CANDIDATE-1", {
        verdict: "refuted",
        evidence: "",
        evidenceComplete: false,
        evidenceScopes: [],
      }),
    ]), [tagged], completedScopes());

    expect(resolution.refutedCandidateIds).toEqual([]);
    expect(resolution.insufficientCandidateIds).toEqual(["GASTON-CANDIDATE-1"]);
    expect(resolution.review.findings).toEqual([]);
  });

  it("retains malformed candidate entries for fail-closed resolution and rejects a malformed envelope", () => {
    const parsed = verification([{
      ...verdict("GASTON-CANDIDATE-1"),
      confidence: "high",
    }]);
    expect(parsed.verdicts[0]).toMatchObject({
      candidateId: "GASTON-CANDIDATE-1",
      valid: false,
    });
    expect(() => parseVerificationOutput(JSON.stringify({
      summary: "checked",
      verdicts: [],
      findings: [],
    }))).toThrow("unexpected top-level fields");
  });

  it("requires every terminal verdict scope to exist in the completed evidence ledger", () => {
    const tagged = taggedDiscovery([
      finding({ title: "invented scope", line: 10 }),
      finding({ title: "unresolved scope", line: 11 }),
      finding({ title: "truncated scope", line: 12 }),
      finding({ title: "completed scope", line: 13 }),
    ]);
    const resolution = resolveVerificationVerdicts(verification([
      verdict("GASTON-CANDIDATE-1", {
        line: 10,
        verdict: "confirmed",
        evidenceScopes: ["diff_for_file:src/a.ts", "diff_for_file:src/invented.ts"],
      }),
      verdict("GASTON-CANDIDATE-2", {
        line: 11,
        verdict: "refuted",
        evidenceScopes: ["read_file:head:src/a.ts:1-40"],
      }),
      verdict("GASTON-CANDIDATE-3", {
        line: 12,
        verdict: "confirmed",
        evidenceScopes: ["diff_for_file:src/partial.ts:1-200"],
      }),
      verdict("GASTON-CANDIDATE-4", {
        line: 13,
        verdict: "confirmed",
      }),
    ]), [tagged], completedScopes());

    expect(resolution.review.findings.map((entry) => entry.title)).toEqual(["completed scope"]);
    expect(resolution.refutedCandidateIds).toEqual([]);
    expect(resolution.insufficientCandidateIds).toEqual([
      "GASTON-CANDIDATE-1",
      "GASTON-CANDIDATE-2",
      "GASTON-CANDIDATE-3",
    ]);
  });

  it("accepts exact patch slice scopes only after same-phase recovery completes the patch", () => {
    const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: true });
    recordExactPatchSlice(tracker, "diff_for_file:src/a.ts", 1, 200, 400, 201, 400);
    const tagged = taggedDiscovery([finding({ title: "recovered patch" })]);
    const terminal = verification([verdict("GASTON-CANDIDATE-1", {
      evidenceScopes: ["diff_for_file:src/a.ts", "diff_for_file:src/a.ts:201-400"],
    })]);

    expect(resolveVerificationVerdicts(
      terminal,
      [tagged],
      tracker.snapshot(),
    ).insufficientCandidateIds).toEqual(["GASTON-CANDIDATE-1"]);

    recordExactPatchSlice(tracker, "diff_for_file:src/a.ts:201-400", 201, 400, 400);
    const coverage = tracker.snapshot();
    const resolution = resolveVerificationVerdicts(
      terminal,
      [tagged],
      coverage,
    );

    expect(coverage).toMatchObject({ sufficient: true, limitations: [] });
    expect(coverage.completedEvidenceScopes).toEqual(expect.arrayContaining([
      "diff_for_file:src/a.ts",
      "diff_for_file:src/a.ts:201-400",
      "diff_for_file:src/a.ts:complete-patch",
    ]));
    expect(resolution.confirmedCandidateIds).toEqual(["GASTON-CANDIDATE-1"]);
    expect(resolution.insufficientCandidateIds).toEqual([]);
  });

  it("does not treat a recovered next window as a complete patch before the full interval union", () => {
    const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: false });
    recordExactPatchSlice(tracker, "diff_for_file:src/a.ts", 1, 200, 1_000, 201, 400);
    recordExactPatchSlice(tracker, "diff_for_file:src/a.ts:201-400", 201, 400, 1_000, 401, 800);
    const tagged = taggedDiscovery([finding({ title: "candidate beyond a recovered prefix" })]);
    const terminal = verification([verdict("GASTON-CANDIDATE-1", {
      evidenceScopes: ["diff_for_file:src/a.ts"],
    })]);
    const partial = tracker.snapshot();

    expect(partial).toMatchObject({ sufficient: false, inspectedChangedFiles: 0 });
    expect(partial.completedEvidenceScopes).toContain("diff_for_file:src/a.ts");
    expect(partial.completedChangedPatchScopes).toContainEqual({
      scope: "diff_for_file:src/a.ts",
      path: "src/a.ts",
      kind: "bounded_patch",
    });
    expect(resolveVerificationVerdicts(
      terminal,
      [tagged],
      partial,
    ).insufficientCandidateIds).toEqual(["GASTON-CANDIDATE-1"]);

    recordExactPatchSlice(tracker, "diff_for_file:src/a.ts:401-800", 401, 800, 1_000, 801, 1_000);
    recordExactPatchSlice(tracker, "diff_for_file:src/a.ts:801-1000", 801, 1_000, 1_000);
    const complete = tracker.snapshot();

    expect(complete).toMatchObject({ sufficient: true, inspectedChangedFiles: 1 });
    expect(complete.completedChangedPatchScopes).toContainEqual({
      scope: "diff_for_file:src/a.ts",
      path: "src/a.ts",
      kind: "complete_patch",
    });
    expect(resolveVerificationVerdicts(
      terminal,
      [tagged],
      complete,
    ).confirmedCandidateIds).toEqual(["GASTON-CANDIDATE-1"]);
  });

  it("promotes exact slice scopes when cached phase coverage completes their interval union", () => {
    const first = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: true });
    recordExactPatchSlice(first, "diff_for_file:src/a.ts:1-200", 1, 200, 400);
    const second = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: true });
    recordExactPatchSlice(second, "diff_for_file:src/a.ts:201-400", 201, 400, 400);
    const merged = mergeEvidenceCoverage(first.snapshot(), second.snapshot());
    const tagged = taggedDiscovery([finding({ title: "cached recovery" })]);
    const resolution = resolveVerificationVerdicts(verification([
      verdict("GASTON-CANDIDATE-1", {
        evidenceScopes: ["diff_for_file:src/a.ts:1-200", "diff_for_file:src/a.ts:201-400"],
      }),
    ]), [tagged], merged);

    expect(merged).toMatchObject({ sufficient: true, limitations: [] });
    expect(merged.completedEvidenceScopes).toEqual(expect.arrayContaining([
      "diff_for_file:src/a.ts:1-200",
      "diff_for_file:src/a.ts:201-400",
      "diff_for_file:src/a.ts:complete-patch",
    ]));
    expect(resolution.confirmedCandidateIds).toEqual(["GASTON-CANDIDATE-1"]);
    expect(resolution.insufficientCandidateIds).toEqual([]);
  });

  it("keeps recovered cached scopes bounded until merged coverage spans the entire patch", () => {
    const first = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: false });
    recordExactPatchSlice(first, "diff_for_file:src/a.ts:1-200", 1, 200, 1_000, 201, 400);
    recordExactPatchSlice(first, "diff_for_file:src/a.ts:201-400", 201, 400, 1_000, 401, 800);
    const second = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: false });
    recordExactPatchSlice(second, "diff_for_file:src/a.ts:401-800", 401, 800, 1_000, 801, 1_000);
    const partial = mergeEvidenceCoverage(first.snapshot(), second.snapshot());
    const tagged = taggedDiscovery([finding({ title: "cached partial candidate" })]);
    const terminal = verification([verdict("GASTON-CANDIDATE-1", {
      evidenceScopes: ["diff_for_file:src/a.ts:1-200"],
    })]);

    expect(partial).toMatchObject({ sufficient: false, inspectedChangedFiles: 0 });
    expect(partial.completedChangedPatchScopes).toContainEqual({
      scope: "diff_for_file:src/a.ts:1-200",
      path: "src/a.ts",
      kind: "bounded_patch",
    });
    expect(resolveVerificationVerdicts(
      terminal,
      [tagged],
      partial,
    ).insufficientCandidateIds).toEqual(["GASTON-CANDIDATE-1"]);

    const last = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: false });
    recordExactPatchSlice(last, "diff_for_file:src/a.ts:801-1000", 801, 1_000, 1_000);
    const complete = mergeEvidenceCoverage(partial, last.snapshot());

    expect(complete).toMatchObject({ sufficient: true, inspectedChangedFiles: 1 });
    expect(complete.completedChangedPatchScopes).toContainEqual({
      scope: "diff_for_file:src/a.ts:1-200",
      path: "src/a.ts",
      kind: "complete_patch",
    });
    expect(resolveVerificationVerdicts(
      terminal,
      [tagged],
      complete,
    ).confirmedCandidateIds).toEqual(["GASTON-CANDIDATE-1"]);
  });

  it("requires a completed verification patch scope for the candidate's own path", () => {
    const tagged = taggedDiscovery([finding({ path: "src/a.ts", title: "candidate" })]);
    const unrelatedOnly = {
      completedEvidenceScopes: ["diff_for_file:src/b.ts", "read_file:head:src/a.ts:1-40"],
      completedChangedPatchScopes: [{
        scope: "diff_for_file:src/b.ts",
        path: "src/b.ts",
        kind: "complete_patch" as const,
      }],
    };
    const resolution = resolveVerificationVerdicts(verification([
      verdict("GASTON-CANDIDATE-1", {
        evidenceScopes: ["diff_for_file:src/b.ts", "read_file:head:src/a.ts:1-40"],
      }),
    ]), [tagged], unrelatedOnly);

    expect(resolution.confirmedCandidateIds).toEqual([]);
    expect(resolution.insufficientCandidateIds).toEqual(["GASTON-CANDIDATE-1"]);
  });

  it.each([
    ["RIGHT", 999],
    ["LEFT", 10],
  ])("does not let a completed %s source lookup at line %i certify another anchor", (sourceSide, sourceLine) => {
    const scope = `diff_for_file:src/a.ts:source:${sourceSide}:${sourceLine}`;
    const tagged = taggedDiscovery([finding({ path: "src/a.ts", side: "RIGHT", line: 10 })]);
    const resolution = resolveVerificationVerdicts(verification([
      verdict("GASTON-CANDIDATE-1", { evidenceScopes: [scope] }),
    ]), [tagged], {
      completedEvidenceScopes: [scope],
      completedChangedPatchScopes: [{
        scope,
        path: "src/a.ts",
        kind: "source",
        sourceSide: sourceSide as "LEFT" | "RIGHT",
        sourceLine,
      }],
    });

    expect(resolution.confirmedCandidateIds).toEqual([]);
    expect(resolution.insufficientCandidateIds).toEqual(["GASTON-CANDIDATE-1"]);
  });

  it("labels unresolved publication as verification incomplete, never clean or disproved", () => {
    const tagged = taggedDiscovery([finding({ title: "unresolved" })]);
    const resolution = resolveVerificationVerdicts(verification([]), [tagged], completedScopes());
    const review = summarizeVerificationPublication(resolution.review, resolution);

    expect(review.summary).toContain("Verification incomplete");
    expect(review.summary).toContain("No unresolved candidate was published");
    expect(review.summary.toLowerCase()).not.toContain("clean");
    expect(review.summary.toLowerCase()).not.toContain("disproved");
  });

  it("keeps a confirmed finding withheld by confidence explicitly incomplete", () => {
    const tagged = taggedDiscovery([finding({ title: "confirmed below threshold" })]);
    const resolution = resolveVerificationVerdicts(verification([
      verdict("GASTON-CANDIDATE-1", { confidence: 0.79 }),
    ]), [tagged], completedScopes());
    const coverage = new EvidenceCoverageTracker({
      totalChangedFiles: 0,
      initialDiffTruncated: false,
    }).snapshot();

    const publication = finalizeVerificationPublication(resolution, {
      changedLines: new Map([["src/a.ts", {
        left: new Set<number>(),
        right: new Set([10]),
      }]]),
      discoveryCoverage: coverage,
      verificationCoverage: coverage,
      configuredBaseThreshold: "0.80",
      configuredIncompleteEvidenceFloor: "0.88",
      maxFindings: 8,
    });

    expect(publication.review.findings).toEqual([]);
    expect(publication.review.summary).toContain("Verification incomplete");
    expect(publication.review.summary).toContain("independently confirmed candidate was withheld");
    expect(publication.resolution).toMatchObject({
      incomplete: true,
      withheldConfirmedCandidateCount: 1,
    });
    expect(publication.resolution.candidateFates[0]?.publication).toEqual({
      state: "withheld",
      reason: "below_confidence",
    });
    expect(publication.coverage.sufficient).toBe(false);
  });

  it("does not let unrelated incomplete evidence cut five complete confirmations to two", () => {
    const scores = [0.91, 0.90, 0.87, 0.85, 0.81];
    const tagged = taggedDiscovery(scores.map((confidence, index) => finding({
      title: `canonical bug ${index + 1}`,
      line: index + 10,
      confidence,
    })));
    const resolution = resolveVerificationVerdicts(verification(scores.map((confidence, index) => (
      verdict(`GASTON-CANDIDATE-${index + 1}`, {
        line: index + 10,
        confidence,
      })
    ))), [tagged], completedScopes());
    const complete = emptyEvidenceCoverage(1);
    const unrelatedIncomplete = {
      ...emptyEvidenceCoverage(1),
      sufficient: false,
      limitations: ["An unrelated broad read was truncated."],
    };

    const publication = finalizeVerificationPublication(resolution, {
      changedLines: new Map([["src/a.ts", {
        left: new Set<number>(),
        right: new Set([10, 11, 12, 13, 14]),
      }]]),
      discoveryCoverage: complete,
      verificationCoverage: unrelatedIncomplete,
      configuredBaseThreshold: "0.80",
      configuredIncompleteEvidenceFloor: "0.88",
      maxFindings: 8,
    });

    expect(resolution.confirmedCandidateIds).toHaveLength(5);
    expect(publication.review.findings.map((entry) => entry.title)).toEqual([
      "canonical bug 1",
      "canonical bug 2",
      "canonical bug 3",
      "canonical bug 4",
      "canonical bug 5",
    ]);
    expect(publication.minConfidence).toBe(0.80);
    expect(publication.coverage.sufficient).toBe(false);
  });

  it("accounts for max-findings truncation before allowing a clean terminal outcome", () => {
    const tagged = taggedDiscovery([
      finding({ title: "first confirmation", line: 10 }),
      finding({ title: "second confirmation", line: 11 }),
    ]);
    const resolution = resolveVerificationVerdicts(verification([
      verdict("GASTON-CANDIDATE-1", { line: 10, confidence: 0.95 }),
      verdict("GASTON-CANDIDATE-2", { line: 11, confidence: 0.94 }),
    ]), [tagged], completedScopes());
    const coverage = new EvidenceCoverageTracker({
      totalChangedFiles: 0,
      initialDiffTruncated: false,
    }).snapshot();

    const publication = finalizeVerificationPublication(resolution, {
      changedLines: new Map([["src/a.ts", {
        left: new Set<number>(),
        right: new Set([10, 11]),
      }]]),
      discoveryCoverage: coverage,
      verificationCoverage: coverage,
      configuredBaseThreshold: "0.80",
      configuredIncompleteEvidenceFloor: "0.88",
      maxFindings: 1,
    });

    expect(publication.review.findings.map((entry) => entry.title)).toEqual(["first confirmation"]);
    expect(publication.resolution.withheldConfirmedCandidateCount).toBe(1);
    expect(publication.resolution.candidateFates.map((entry) => entry.publication)).toEqual([
      { state: "published", reason: "published" },
      { state: "withheld", reason: "finding_cap" },
    ]);
    expect(publication.coverage.sufficient).toBe(false);
  });

  it("still allows a clean terminal outcome when every candidate is conclusively refuted", () => {
    const tagged = taggedDiscovery([finding({ title: "false alarm" })]);
    const resolution = resolveVerificationVerdicts(verification([
      verdict("GASTON-CANDIDATE-1", { verdict: "refuted" }),
    ]), [tagged], completedScopes());
    const coverage = new EvidenceCoverageTracker({
      totalChangedFiles: 0,
      initialDiffTruncated: false,
    }).snapshot();

    const publication = finalizeVerificationPublication(resolution, {
      changedLines: new Map([["src/a.ts", {
        left: new Set<number>(),
        right: new Set([10]),
      }]]),
      discoveryCoverage: coverage,
      verificationCoverage: coverage,
      configuredBaseThreshold: "0.80",
      configuredIncompleteEvidenceFloor: "0.88",
      maxFindings: 8,
    });

    expect(publication.review.findings).toEqual([]);
    expect(publication.review.summary).toContain("every candidate was refuted");
    expect(publication.resolution).toMatchObject({
      verificationIncomplete: false,
      withheldConfirmedCandidateCount: 0,
      incomplete: false,
    });
    expect(publication.coverage.sufficient).toBe(true);
  });
});

describe("request changes threshold", () => {
  const blocker = parseReviewOutput(JSON.stringify({
    summary: "x",
    findings: [finding({ severity: "blocker" })],
  })).findings;
  const high = parseReviewOutput(JSON.stringify({
    summary: "x",
    findings: [finding({ severity: "high" })],
  })).findings;

  it("blocks only at the configured severity", () => {
    expect(shouldRequestChanges(blocker, "blocker")).toBe(true);
    expect(shouldRequestChanges(high, "blocker")).toBe(false);
    expect(shouldRequestChanges(high, "high")).toBe(true);
    expect(shouldRequestChanges(blocker, "off")).toBe(false);
  });
});

function finding(overrides: Record<string, unknown> = {}) {
  return {
    path: "src/a.ts",
    line: 10,
    side: "RIGHT",
    severity: "medium",
    title: "bug",
    why: "observable failure",
    evidence: "specific evidence",
    suggestedFix: "small fix",
    confidence: 0.9,
    ...overrides,
  };
}

function taggedDiscovery(findings: ReturnType<typeof finding>[]) {
  return tagVerificationCandidates([{
    summary: "candidate batch",
    findings: findings as ReturnType<typeof parseReviewOutput>["findings"],
  }])[0]!;
}

function verification(verdicts: unknown[]) {
  return parseVerificationOutput(JSON.stringify({ summary: "checked", verdicts }));
}

function verdict(candidateId: string, overrides: Record<string, unknown> = {}) {
  return {
    candidateId,
    verdict: "confirmed",
    path: "src/a.ts",
    line: 10,
    side: "RIGHT",
    confidence: 0.9,
    rationale: "independent causal analysis",
    evidence: "repository evidence",
    evidenceComplete: true,
    evidenceScopes: ["diff_for_file:src/a.ts"],
    missingEvidenceKind: null,
    missingEvidence: "",
    ...overrides,
  };
}

function completedScopes() {
  return {
    completedEvidenceScopes: ["diff_for_file:src/a.ts"],
    completedChangedPatchScopes: [{
      scope: "diff_for_file:src/a.ts",
      path: "src/a.ts",
      kind: "complete_patch" as const,
    }],
  };
}

function recordExactPatchSlice(
  tracker: EvidenceCoverageTracker,
  scope: string,
  start: number,
  end: number,
  total: number,
  nextStart?: number,
  nextEnd?: number,
) {
  tracker.record("diff_for_file", {
    status: "truncated",
    content: "exact partial patch",
    retryable: false,
    suggestedAction: "Read the remaining exact patch lines.",
    evidence: {
      scope,
      complete: false,
      changedPath: "src/a.ts",
      patchStartLine: start,
      patchEndLine: end,
      totalPatchLines: total,
      patchIntervalComplete: true,
      sourceTargeted: false,
      ...(nextStart === undefined || nextEnd === undefined
        ? {}
        : { nextPatchStartLine: nextStart, nextPatchEndLine: nextEnd }),
    },
  }, "src/a.ts");
}
