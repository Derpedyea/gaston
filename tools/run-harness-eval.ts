import { ReviewAgent } from "../src/agent.ts";
import { ReviewBudget } from "../src/budget.ts";
import type { EvidenceResult, EvidenceTools } from "../src/evidence.ts";
import { evaluateHarness, type HarnessCaseResult, type HarnessGates } from "../src/harness-eval.ts";

interface ReplayResponse {
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

interface ReplayTool extends EvidenceResult {
  name: string;
}

interface ReplayCase {
  name: string;
  phase: string;
  responses: ReplayResponse[];
  tools: ReplayTool[];
  expected: HarnessCaseResult["expectation"];
}

interface ReplayCorpus {
  gates: HarnessGates;
  cases: ReplayCase[];
}

const corpus = await Bun.file(new URL("../test/fixtures/harness-replay.json", import.meta.url)).json() as ReplayCorpus;
const results: HarnessCaseResult[] = [];
const reportLog = console.log.bind(console);
const reportWarn = console.warn.bind(console);
const reportError = console.error.bind(console);
console.log = () => undefined;
console.warn = () => undefined;
console.error = () => undefined;
for (const fixture of corpus.cases) {
  let responseIndex = 0;
  let toolIndex = 0;
  const budget = new ReviewBudget();
  const modelFetch: typeof fetch = async () => {
    const replay = fixture.responses[responseIndex++];
    if (!replay) throw new Error(`Replay ${fixture.name} exhausted model responses`);
    return new Response(JSON.stringify(replay.body), {
      status: replay.status ?? 200,
      headers: { "content-type": "application/json", ...replay.headers },
    });
  };
  const tools: EvidenceTools = {
    async invoke(name): Promise<EvidenceResult> {
      const replay = fixture.tools[toolIndex++];
      if (!replay) throw new Error(`Replay ${fixture.name} exhausted tool results`);
      if (replay.name !== name) throw new Error(`Replay ${fixture.name} expected ${replay.name}, received ${name}`);
      const { name: _name, ...result } = replay;
      return result;
    },
  };
  const startedAt = Date.now();
  const output = await new ReviewAgent({
    apiKey: `sk-or-v1-${"x".repeat(64)}`,
    model: "deepseek/deepseek-v4-flash-0731",
    reasoningEffort: "high",
    repository: "replay/corpus",
    budget,
    modelFetch,
  }).run("Review the replay fixture.", tools, fixture.phase);
  results.push({
    name: fixture.name,
    output,
    expectation: fixture.expected,
    budget: budget.snapshot(),
    toolCalls: toolIndex,
    elapsedMs: Date.now() - startedAt,
  });
}

const report = evaluateHarness(results, corpus.gates);
console.log = reportLog;
console.warn = reportWarn;
console.error = reportError;
reportLog(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
