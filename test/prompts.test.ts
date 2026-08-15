import { describe, expect, it } from "vitest";

import { discoveryPrompt, REVIEW_LENS, verificationPrompt } from "../src/prompts.ts";
import type { PullChangeSet, ReviewJob } from "../src/types.ts";

describe("review prompt budgets", () => {
  it("bounds oversized discovery input while retaining instructions and a truncation marker", () => {
    const prompt = discoveryPrompt(
      { ...job(), body: "body".repeat(20_000) },
      changes("diff".repeat(50_000)),
      [{ summary: "check".repeat(10_000) }],
      "policy".repeat(20_000),
      REVIEW_LENS,
    );

    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(72_000);
    expect(prompt).toContain("Gaston truncated");
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain("Issue-list discovery is recall-oriented");
    expect(prompt).toContain("Perform a local-delta pass over every visible changed hunk");
    expect(prompt).toContain("wrong names, fields, operators, polarity, arguments, return values, methods/statuses");
    expect(prompt).toContain("SQL/HTML/JavaScript interpolation");
    expect(prompt).toContain("vacuous or self-defeating tests");
    expect(prompt).toContain("Prefer a direct changed-line contradiction over a more elaborate multi-hop hypothesis");
    expect(prompt).toContain("normalization and validation asymmetry");
    expect(prompt).toContain("permission composition and trust boundaries");
    expect(prompt).toContain("one explicit repository fact remains to be checked by the verifier");
    expect(prompt).toContain('"proofObligations"');
    expect(prompt).toContain('"falsifier"');
  });

  it("bounds oversized verification candidates without losing the output contract", () => {
    const prompt = verificationPrompt(
      job(),
      [{
        source: "discovery",
        review: {
          summary: "summary".repeat(10_000),
          findings: Array.from({ length: 12 }, (_, index) => ({
            path: `src/${index}.ts`,
            line: index + 1,
            side: "RIGHT" as const,
            severity: "high" as const,
            title: `[GASTON-CANDIDATE-${index + 1}] title`,
            why: "why".repeat(1_000),
            evidence: "evidence".repeat(1_000),
            suggestedFix: "fix".repeat(1_000),
            confidence: 0.95,
          })),
        },
      }],
      changes(""),
      "policy".repeat(20_000),
      [1, 2].map((index) => ({
        candidateId: `GASTON-CANDIDATE-${index}`,
        path: `src/${index - 1}.ts`,
        line: index,
        side: "RIGHT" as const,
        result: {
          status: "ok" as const,
          content: `anchor-${index}-${"x".repeat(11_000)}`,
          retryable: false,
          evidence: {
            scope: `diff_for_file:src/${index - 1}.ts:source:RIGHT:${index}`,
            complete: true,
          },
        },
      })),
    );

    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(72_000);
    for (let index = 1; index <= 12; index++) {
      expect(prompt).toContain(`[GASTON-CANDIDATE-${index}]`);
    }
    expect(prompt).not.toContain("Gaston truncated the discovery candidates");
    expect(prompt).toContain("Output exactly one JSON object");
    expect(prompt).toContain("return exactly one verdict entry for it");
    expect(prompt).toContain('"verdict": "confirmed|refuted|insufficient"');
    expect(prompt).toContain('"evidenceScopes"');
    expect(prompt).toContain("A lack of proof is `insufficient`, never `refuted`");
    expect(prompt).toContain("Executable tests, benchmarks, workflows, and manifests remain eligible");
    expect(prompt).toContain("absence of a guard alone is not proof");
    expect(prompt).toContain("can establish reachability without production telemetry");
    expect(prompt).toContain("prove every causal link from repository evidence");
    expect(prompt).toContain("Require pinned source or an executable contract for non-obvious");
    expect(prompt).toContain("anchor-1-");
    expect(prompt).toContain("anchor-2-");
    expect(prompt).toContain("diff_for_file:src/0.ts:source:RIGHT:1");
    expect(prompt).toContain("diff_for_file:src/1.ts:source:RIGHT:2");
  });

  it("includes harness-fetched exact anchor evidence before verifier tool selection", () => {
    const prompt = verificationPrompt(
      job(),
      [{
        source: "discovery",
        review: {
          summary: "candidate",
          findings: [{
            path: "src/permissions.ts",
            line: 48,
            side: "RIGHT",
            severity: "high",
            title: "[GASTON-CANDIDATE-1] admin requires owner",
            why: "An admin-only member is rejected because the changed condition uses &&.",
            evidence: "The changed guard requires both roles.",
            suggestedFix: "Use ||.",
            confidence: 0.98,
            proofObligations: {
              trigger: "admin-only member",
              changedBehavior: "requires both roles",
              executionPath: "authorization guard",
              observableFailure: "valid admin is rejected",
              falsifier: "all admins are owners",
              unresolvedFact: "",
            },
          }],
        },
      }],
      changes(""),
      "",
      [{
        candidateId: "GASTON-CANDIDATE-1",
        path: "src/permissions.ts",
        line: 48,
        side: "RIGHT",
        result: {
          status: "ok",
          content: JSON.stringify({ path: "src/permissions.ts", requestedSourceLine: 48, patch: "+const allowed = isAdmin && isOwner;" }),
          retryable: false,
          evidence: {
            scope: "diff_for_file:src/permissions.ts:source:RIGHT:48",
            complete: true,
            sourceTargeted: true,
            sourceLine: 48,
            sourceSide: "RIGHT",
            changedPath: "src/permissions.ts",
          },
        },
      }],
    );

    expect(prompt).toContain("Harness-fetched exact candidate anchors");
    expect(prompt).toContain("diff_for_file:src/permissions.ts:source:RIGHT:48");
    expect(prompt).toContain("+const allowed = isAdmin && isOwner;");
    expect(prompt).toContain("Spend verifier tool calls on callers, guards, schemas, and invariants beyond these anchors");
    expect(prompt).not.toContain('"trigger": "admin-only member"');
    expect(prompt).not.toContain('"falsifier": "all admins are owners"');
    expect(prompt).toContain('"falsificationTarget": "all admins are owners"');
  });

  it("keeps verifier input blind to discovery rationale and confidence", () => {
    const prompt = verificationPrompt(
      job(),
      [{
        source: "discovery-secret-source",
        review: {
          summary: "discovery-secret-summary",
          findings: [{
            path: "src/permissions.ts",
            line: 48,
            side: "RIGHT",
            severity: "high",
            title: "[GASTON-CANDIDATE-1] admin requires owner",
            why: "discovery-secret-causal-story",
            evidence: "discovery-secret-evidence-claim",
            suggestedFix: "discovery-secret-proposed-fix",
            confidence: 0.987654,
          }],
        },
      }],
      changes(""),
      "",
    );

    expect(prompt).toContain("[GASTON-CANDIDATE-1] admin requires owner");
    expect(prompt).toContain('"path": "src/permissions.ts"');
    expect(prompt).not.toContain("discovery-secret-source");
    expect(prompt).not.toContain("discovery-secret-summary");
    expect(prompt).not.toContain("discovery-secret-causal-story");
    expect(prompt).not.toContain("discovery-secret-evidence-claim");
    expect(prompt).not.toContain("discovery-secret-proposed-fix");
    expect(prompt).not.toContain("0.987654");
  });

  it("discloses the causal hypothesis only in a focused post-blind rescue", () => {
    const discoveries = [{
      source: "discovery",
      review: {
        summary: "candidate",
        findings: [{
          path: "src/permissions.ts",
          line: 48,
          side: "RIGHT" as const,
          severity: "high" as const,
          title: "[GASTON-CANDIDATE-1] admin requires owner",
          why: "the changed conjunction rejects admin-only members",
          evidence: "the caller permits either role",
          suggestedFix: "restore the disjunction",
          confidence: 0.98,
        }],
      },
    }];
    const prompt = verificationPrompt(job(), discoveries, changes(""), "", [], {
      candidateId: "GASTON-CANDIDATE-1",
      missingEvidenceKind: "repository_symbol",
      missingEvidence: "Whether the caller permits either role.",
      discoveryHypothesis: {
        why: discoveries[0]!.review.findings[0]!.why,
        evidence: discoveries[0]!.review.findings[0]!.evidence,
      },
      dossier: [],
      routingEvidence: [],
    });

    expect(prompt).toContain("disclosed only after the blind first pass");
    expect(prompt).toContain("the changed conjunction rejects admin-only members");
    expect(prompt).toContain("the caller permits either role");
    expect(prompt).not.toContain("restore the disjunction");
    expect(prompt).not.toContain("0.98");
  });

  it("reports the number of file rows that are actually visible", () => {
    const prompt = discoveryPrompt(job(), changes(""), [], "", REVIEW_LENS);
    const match = prompt.match(/Changed-file overview \((\d+) of 300 files/);

    expect(match).not.toBeNull();
    const visible = Number(match![1]);
    expect(visible).toBeLessThan(300);
    expect(prompt).toContain(`src/very-long-directory-name-${visible - 1}/file-${visible - 1}.ts`);
    expect(prompt).not.toContain(`src/very-long-directory-name-${visible}/file-${visible}.ts`);
  });

  it("annotates changed hunk lines with source coordinates before excerpt truncation", () => {
    const diff = [
      "diff --git a/src/operators.ts b/src/operators.ts",
      "--- a/src/operators.ts",
      "+++ b/src/operators.ts",
      "@@ -7,3 +7,4 @@ function update()",
      " context seven",
      "---oldValue",
      "+++newValue",
      "+extraValue",
      " context nine",
      "--- a/src/next.ts",
      "+++ b/src/next.ts",
      "@@ -40 +50 @@",
      "-before",
      "+after",
    ].join("\n");

    const prompt = discoveryPrompt(job(), changes(diff), [], "", REVIEW_LENS);

    expect(prompt).toContain("[LEFT:8] ---oldValue");
    expect(prompt).toContain("[RIGHT:8] +++newValue");
    expect(prompt).toContain("[RIGHT:9] +extraValue");
    expect(prompt).toContain("[LEFT:40] -before");
    expect(prompt).toContain("[RIGHT:50] +after");
    expect(prompt).not.toContain("[LEFT:7] --- a/src/operators.ts");
    expect(prompt).not.toContain("[RIGHT:7] +++ b/src/operators.ts");
    expect(prompt).not.toContain("[LEFT:10] --- a/src/next.ts");
    expect(prompt).not.toContain("[RIGHT:10] +++ b/src/next.ts");
    expect(prompt).toContain("prefixes identify source coordinates");
  });

  it("adds source-coordinate metadata before enforcing the 40 KB diff excerpt budget", () => {
    const diff = [
      "diff --git a/src/large.ts b/src/large.ts",
      "--- a/src/large.ts",
      "+++ b/src/large.ts",
      "@@ -1,0 +1,3000 @@",
      ...Array.from({ length: 3_000 }, (_, index) => `+changed-${index + 1}-${"x".repeat(20)}`),
    ].join("\n");

    const prompt = discoveryPrompt(job(), changes(diff), [], "", REVIEW_LENS);
    const excerpt = prompt.split("Initial diff excerpt")[1]?.split("\n\nThis is a full cumulative PR review.")[0] ?? "";

    expect(new TextEncoder().encode(excerpt).byteLength).toBeLessThanOrEqual(41_000);
    expect(excerpt).toContain("[RIGHT:1] +changed-1-");
    expect(excerpt).toContain("Gaston truncated the initial diff");
  });

  it("stratifies oversized diffs so middle-file changed lines remain visible", () => {
    const fileSection = (name: string, marker: string): string => [
      `diff --git a/src/${name}.ts b/src/${name}.ts`,
      `--- a/src/${name}.ts`,
      `+++ b/src/${name}.ts`,
      "@@ -1,0 +1,900 @@",
      ...Array.from({ length: 900 }, (_, index) => `+${marker}-${index + 1}-${"x".repeat(30)}`),
    ].join("\n");
    const prompt = discoveryPrompt(
      job(),
      changes([
        fileSection("first", "FIRST-MARKER"),
        fileSection("middle", "MIDDLE-MARKER"),
        fileSection("last", "LAST-MARKER"),
      ].join("\n")),
      [],
      "",
      REVIEW_LENS,
    );

    expect(prompt).toContain("src/first.ts");
    expect(prompt).toContain("src/middle.ts");
    expect(prompt).toContain("src/last.ts");
    expect(prompt).toContain("MIDDLE-MARKER");
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(72_000);
  });

  it("stratifies oversized single-file diffs so middle hunks remain visible", () => {
    const hunk = (oldLine: number, marker: string): string => [
      `@@ -${oldLine},0 +${oldLine},700 @@`,
      ...Array.from({ length: 700 }, (_, index) => `+${marker}-${index + 1}-${"x".repeat(32)}`),
    ].join("\n");
    const prompt = discoveryPrompt(
      job(),
      changes([
        "diff --git a/src/large.ts b/src/large.ts",
        "--- a/src/large.ts",
        "+++ b/src/large.ts",
        hunk(1, "FIRST-HUNK"),
        hunk(1000, "MIDDLE-HUNK"),
        hunk(2000, "LAST-HUNK"),
      ].join("\n")),
      [],
      "",
      REVIEW_LENS,
    );

    expect(prompt).toContain("FIRST-HUNK");
    expect(prompt).toContain("MIDDLE-HUNK");
    expect(prompt).toContain("LAST-HUNK");
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(72_000);
  });
});

function changes(diff: string): PullChangeSet {
  return {
    diff,
    truncated: false,
    files: Array.from({ length: 300 }, (_, index) => ({
      path: `src/very-long-directory-name-${index}/file-${index}.ts`,
      status: "modified",
      additions: 10,
      deletions: 5,
      patch: null,
    })),
  };
}

function job(): ReviewJob {
  return {
    deliveryId: "delivery",
    installationId: 1,
    owner: "owner",
    repo: "repo",
    pullNumber: 1,
    title: "title",
    body: "body",
    baseRef: "main",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    queuedAt: "2026-08-10T00:00:00.000Z",
    trigger: "automatic",
  };
}
