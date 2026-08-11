import type { ReviewBudgetSnapshot } from "./budget.ts";
import type { Finding, ReviewOutput } from "./types.ts";

export interface HarnessExpectation {
  mustFind: string[];
  mustNotFind: string[];
  maxModelRequests: number;
  maxToolCalls: number;
  maxCostUsd: number;
}

export interface HarnessCaseResult {
  name: string;
  output: ReviewOutput;
  expectation: HarnessExpectation;
  budget: ReviewBudgetSnapshot;
  toolCalls: number;
  elapsedMs: number;
}

export interface HarnessGates {
  minPrecision: number;
  minRecall: number;
  maxP95ModelRequests: number;
  maxP95ToolCalls: number;
  maxP95CostUsd: number;
}

export interface HarnessReport {
  passed: boolean;
  cases: Array<{ name: string; passed: boolean; failures: string[] }>;
  metrics: {
    precision: number;
    recall: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    p95ModelRequests: number;
    p95ToolCalls: number;
    p95CostUsd: number;
  };
  gateFailures: string[];
}

export function findingKey(finding: Pick<Finding, "path" | "line" | "title">): string {
  return `${finding.path}:${finding.line}:${finding.title}`;
}

export function evaluateHarness(results: HarnessCaseResult[], gates: HarnessGates): HarnessReport {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const cases = results.map((result) => {
    const actual = new Set(result.output.findings.map(findingKey));
    const expected = new Set(result.expectation.mustFind);
    const forbidden = new Set(result.expectation.mustNotFind);
    const failures: string[] = [];
    for (const key of expected) {
      if (actual.has(key)) truePositives++;
      else {
        falseNegatives++;
        failures.push(`missing expected finding: ${key}`);
      }
    }
    for (const key of actual) {
      if (!expected.has(key)) {
        falsePositives++;
        failures.push(`unexpected finding: ${key}`);
      }
      if (forbidden.has(key)) failures.push(`forbidden finding: ${key}`);
    }
    if (result.budget.modelRequests > result.expectation.maxModelRequests) {
      failures.push(`model requests ${result.budget.modelRequests} > ${result.expectation.maxModelRequests}`);
    }
    if (result.toolCalls > result.expectation.maxToolCalls) {
      failures.push(`tool calls ${result.toolCalls} > ${result.expectation.maxToolCalls}`);
    }
    if (result.budget.costUsd > result.expectation.maxCostUsd) {
      failures.push(`cost $${result.budget.costUsd} > $${result.expectation.maxCostUsd}`);
    }
    return { name: result.name, passed: failures.length === 0, failures };
  });

  const precision = ratio(truePositives, truePositives + falsePositives);
  const recall = ratio(truePositives, truePositives + falseNegatives);
  const p95ModelRequests = percentile(results.map((result) => result.budget.modelRequests), 0.95);
  const p95ToolCalls = percentile(results.map((result) => result.toolCalls), 0.95);
  const p95CostUsd = percentile(results.map((result) => result.budget.costUsd), 0.95);
  const gateFailures: string[] = [];
  if (precision < gates.minPrecision) gateFailures.push(`precision ${precision} < ${gates.minPrecision}`);
  if (recall < gates.minRecall) gateFailures.push(`recall ${recall} < ${gates.minRecall}`);
  if (p95ModelRequests > gates.maxP95ModelRequests) gateFailures.push(`p95 model requests ${p95ModelRequests} > ${gates.maxP95ModelRequests}`);
  if (p95ToolCalls > gates.maxP95ToolCalls) gateFailures.push(`p95 tool calls ${p95ToolCalls} > ${gates.maxP95ToolCalls}`);
  if (p95CostUsd > gates.maxP95CostUsd) gateFailures.push(`p95 cost $${p95CostUsd} > $${gates.maxP95CostUsd}`);

  return {
    passed: cases.every((result) => result.passed) && gateFailures.length === 0,
    cases,
    metrics: {
      precision,
      recall,
      truePositives,
      falsePositives,
      falseNegatives,
      p95ModelRequests,
      p95ToolCalls,
      p95CostUsd,
    },
    gateFailures,
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Number((numerator / denominator).toFixed(4));
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}
