import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewAgent } from "../src/agent.ts";
import { ReviewBudget } from "../src/budget.ts";
import { EvidenceCoverageTracker, type EvidenceResult } from "../src/evidence.ts";
import type { RepositoryTools } from "../src/repository.ts";

const TEST_API_KEY = `sk-or-v1-${"x".repeat(64)}`;

describe("ReviewAgent", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects a truncated OpenRouter credential before making a request", () => {
    expect(() => new ReviewAgent({
      apiKey: "1",
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    })).toThrow(
      "OPENROUTER_API_KEY is malformed; expected a full sk-or-v1-… API key (received 1 characters, prefix match: false)",
    );
  });

  it("rejects a reasoning downgrade", () => {
    expect(() => new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "low",
      repository: "owner/repo",
    })).toThrow("REVIEW_REASONING_EFFORT must be high, xhigh, or max; Gaston does not downgrade review reasoning");
  });

  it("uses a recall-oriented discovery objective and a strict verification objective", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const content = requests.length === 1
        ? '{"summary":"searched","findings":[]}'
        : '{"summary":"verified","verdicts":[]}';
      return jsonResponse({ choices: [{ message: { content } }] });
    }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });
    const tools = { invoke: vi.fn() } as unknown as RepositoryTools;

    await expect(agent.run("discover", tools, "discovery")).resolves.toMatchObject({ findings: [] });
    await expect(agent.runVerification("verify", tools)).resolves.toMatchObject({ verdicts: [] });

    const discoverySystem = (requests[0]!.messages as Array<{ role: string; content: string }>)[0]!.content;
    const verificationSystem = (requests[1]!.messages as Array<{ role: string; content: string }>)[0]!.content;
    expect(discoverySystem).toContain("recall-oriented issue-list discovery");
    expect(discoverySystem).toContain("independent strict verifier gates publication");
    expect(verificationSystem).toContain("strict falsification phase");
    expect(verificationSystem).toContain("extremely low false-positive rate");
  });

  it("runs complete-diff discovery as one structured request without offering tools", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({
        choices: [{ message: { content: '{"summary":"scanned once","findings":[]}' } }],
      });
    }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "openai/gpt-5.6-luna",
      provider: "openai",
      reasoningEffort: "max",
      repository: "owner/repo",
    });

    await expect(agent.runDirectReview("complete diff", "discovery"))
      .resolves.toEqual({ summary: "scanned once", findings: [] });

    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("tools");
    expect(requests[0]).not.toHaveProperty("tool_choice");
    expect(requests[0]!.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("No repository tools are available or needed"),
      }),
    ]));
    expect(requests[0]!.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "gaston_review", strict: true },
    });
  });

  it.each(["xhigh", "max"] as const)(
    "sends the configured %s reasoning tier and private provider policy",
    async (reasoningEffort) => {
      const requests: Array<Record<string, unknown>> = [];
      vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return jsonResponse({ choices: [{ message: { content: '{"summary":"done","findings":[]}' } }] });
      }));
      const agent = new ReviewAgent({
        apiKey: TEST_API_KEY,
        model: "deepseek/deepseek-v4-flash-0731",
        reasoningEffort,
        repository: "owner/repo",
        providerOnly: ["open-inference/fp8"],
        requireZdr: true,
      });

      await agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "discovery");

      expect(requests[0]!.reasoning).toEqual({ effort: reasoningEffort });
      expect(requests[0]!.provider).toEqual({
        allow_fallbacks: true,
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
        only: ["open-inference/fp8"],
      });
    },
  );

  it("starts Luna Max with full output headroom to avoid a duplicate length retry", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse({ choices: [{ message: { content: '{"summary":"done","findings":[]}' } }] });
    }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "openai/gpt-5.6-luna",
      provider: "openai",
      reasoningEffort: "max",
      repository: "owner/repo",
      maxOutputTokensPerRequest: 64_000,
    });

    await expect(agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "discovery"))
      .resolves.toMatchObject({ findings: [] });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.max_tokens).toBe(64_000);
  });

  it("executes requested tools and returns validated review JSON", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        return jsonResponse({
          choices: [{
            message: {
              content: null,
              reasoning_details: [{ type: "reasoning.text", text: "Need the exact source." }],
              tool_calls: [{
                id: "call-1",
                type: "function",
                function: { name: "Read_File", arguments: '{"path":"src/a.ts"}' },
              }],
            },
          }],
        });
      }
      return jsonResponse({
        choices: [{ message: { content: '{"summary":"clean","findings":[]}' } }],
      });
    }));

    const invoke = vi.fn(async () => ({ content: "1: export const answer = 42;" }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
      requireInitialToolCall: true,
    });
    const result = await agent.run("review", { invoke } as unknown as RepositoryTools, "discovery");

    expect(result).toEqual({ summary: "clean", findings: [] });
    expect(invoke).toHaveBeenCalledWith("read_file", '{"path":"src/a.ts"}', expect.any(AbortSignal));
    const secondMessages = requests[1]!.messages as Array<{
      role: string;
      tool_call_id?: string;
      reasoning_details?: unknown[];
    }>;
    expect(secondMessages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "call-1" }));
    expect(secondMessages).toContainEqual(expect.objectContaining({
      role: "assistant",
      reasoning_details: [{ type: "reasoning.text", text: "Need the exact source." }],
    }));
    expect(requests[0]!.parallel_tool_calls).toBeUndefined();
    expect(requests[0]!.tool_choice).toBe("required");
    expect(requests[1]!.tool_choice).toBeUndefined();
    expect(requests[0]!.reasoning).toEqual({ effort: "high" });
    expect(requests[1]!.reasoning).toEqual({ effort: "high" });
    expect(requests[0]!.max_tokens).toBe(32_000);
    expect(requests[1]!.max_tokens).toBe(32_000);
    expect(requests[0]!.temperature).toBeUndefined();
    expect(requests[0]!.session_id).toMatch(/^gaston:owner\/repo:discovery:/);
    expect(requests[1]!.session_id).toBe(requests[0]!.session_id);
  });

  it("does not let a failed tool satisfy required repository evidence", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [toolCall("bad", "read_file", "{}")],
        } }] });
      }
      if (body.tools !== undefined) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [toolCall("good", "read_file", '{"path":"src/a.ts"}')],
        } }] });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"done","findings":[]}' } }] });
    }));
    const invoke = vi.fn(async (_name: string, rawArguments: string) => (
      rawArguments === "{}"
        ? { status: "invalid_arguments" as const, content: "path required", retryable: false }
        : { status: "ok" as const, content: "1: safe", retryable: false }
    ));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
      requireInitialToolCall: true,
    });

    await expect(agent.run("review", { invoke }, "discovery"))
      .resolves.toEqual({ summary: "done", findings: [] });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(requests[0]!.tool_choice).toBe("required");
    expect(requests[1]!.tool_choice).toBe("required");
    expect(requests.at(-1)!.tools).toBeUndefined();
  });

  it("fails closed when every required repository tool call fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ choices: [{ message: {
      content: null,
      tool_calls: [toolCall("bad", "read_file", "{}")],
    } }] })));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
      requireInitialToolCall: true,
    });

    await expect(agent.run("review", {
      invoke: vi.fn(async () => ({
        status: "invalid_arguments" as const,
        content: "path required",
        retryable: false,
      })),
    }, "discovery")).rejects.toThrow("Required repository evidence was unavailable");
  });

  it("normalizes common read-file line range aliases", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return body.tools === undefined
        ? jsonResponse({ choices: [{ message: { content: '{"summary":"done","findings":[]}' } }] })
        : jsonResponse({ choices: [{ message: {
            content: null,
            tool_calls: [toolCall(
              "read",
              "read_file",
              '{"path":"src/a.ts","line_start":"700","line_end":"900"}',
            )],
          } }] });
    }));
    const invoke = vi.fn(async () => ({ status: "ok" as const, content: "700: safe", retryable: false }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await agent.run("review", { invoke }, "discovery");

    expect(invoke).toHaveBeenCalledWith(
      "read_file",
      '{"path":"src/a.ts","start_line":700,"end_line":900}',
      expect.any(AbortSignal),
    );
  });

  it.each([
    ["changed_files", '{"offset":"100","limit":"25"}', "changed_files", '{"offset":100,"limit":25}'],
    [
      "diff_for_file",
      '{"path":"src/a.ts","patch_start_line":"1","patch_end_line":"1","source_line":"380"}',
      "diff_for_source_line",
      '{"path":"src/a.ts","source_line":380,"side":"RIGHT"}',
    ],
    [
      "diff_for_file",
      '{"path":"src/a.ts","patch_start_line":"1","patch_end_line":"400","source_line":"1","side":"RIGHT"}',
      "diff_for_file",
      '{"path":"src/a.ts","patch_start_line":1,"patch_end_line":400}',
    ],
    [
      "diff_for_file",
      '{"path":"src/a.ts","patch_start_line":"1","patch_end_line":"200","source_line":"40","side":"RIGHT"}',
      "diff_for_file",
      '{"path":"src/a.ts","patch_start_line":1,"patch_end_line":200}',
    ],
    ["repository_tree", '{"prefix":"src","limit":"500"}', "repository_tree", '{"prefix":"src","limit":500}'],
    ["search_code", '{"query":"needle","limit":"20"}', "search_code", '{"query":"needle","limit":20}'],
  ])("normalizes canonical decimal strings and legacy coordinates for %s", async (name, raw, invokedName, expected) => {
    let request = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      request++;
      return request === 1
        ? jsonResponse({ choices: [{ message: {
            content: null,
            tool_calls: [toolCall("evidence", name, raw)],
          } }] })
        : jsonResponse({ choices: [{ message: { content: '{"summary":"done","findings":[]}' } }] });
    }));
    const invoke = vi.fn(async () => ({ status: "ok" as const, content: "exact evidence", retryable: false }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await agent.run("review", { invoke }, "discovery");

    expect(invoke).toHaveBeenCalledWith(invokedName, expected, expect.any(AbortSignal));
  });

  it("reuses semantically identical tool arguments with reordered object keys", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }> };
      const hasEvidence = body.messages?.some((message) => message.role === "tool") === true;
      return hasEvidence
        ? jsonResponse({ choices: [{ message: { content: '{"summary":"done","findings":[]}' } }] })
        : jsonResponse({ choices: [{ message: {
            content: null,
            tool_calls: [
              toolCall("first", "read_file", '{"path":"src/a.ts","ref":"head","start_line":1,"end_line":20}'),
              toolCall("second", "read_file", '{"end_line":"20","start_line":"1","ref":"head","path":"src/a.ts"}'),
            ],
          } }] });
    }));
    const invoke = vi.fn(async () => ({ status: "ok" as const, content: "1: safe", retryable: false }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", { invoke }, "discovery"))
      .resolves.toEqual({ summary: "done", findings: [] });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("canonicalizes legacy mixed diff coordinates before cache and execution", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }> };
      const hasEvidence = body.messages?.some((message) => message.role === "tool") === true;
      return hasEvidence
        ? jsonResponse({ choices: [{ message: { content: '{"summary":"done","findings":[]}' } }] })
        : jsonResponse({ choices: [{ message: {
            content: null,
            tool_calls: [
              toolCall(
                "legacy",
                "diff_for_file",
                '{"path":"src/a.ts","patch_start_line":1,"patch_end_line":400,"source_line":1,"side":"RIGHT"}',
              ),
              toolCall(
                "canonical",
                "diff_for_file",
                '{"path":"src/a.ts","patch_start_line":1,"patch_end_line":400}',
              ),
            ],
          } }] });
    }));
    const invoke = vi.fn(async () => ({ status: "ok" as const, content: "exact patch", retryable: false }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "max",
      repository: "owner/repo",
    });

    await expect(agent.run("review", { invoke }, "discovery"))
      .resolves.toEqual({ summary: "done", findings: [] });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      "diff_for_file",
      '{"path":"src/a.ts","patch_start_line":1,"patch_end_line":400}',
      expect.any(AbortSignal),
    );
  });

  it("allows one targeted evidence follow-up when configured", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [toolCall("patch", "diff_for_file", '{"path":"src/a.ts"}')],
        } }] });
      }
      if (requests.length === 2) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [toolCall("caller", "read_file", '{"path":"src/caller.ts","ref":"head","start_line":1,"end_line":40}')],
        } }] });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"checked","findings":[]}' } }] });
    }));
    const invoke = vi.fn(async (name: string) => ({
      status: "ok" as const,
      content: `evidence from ${name}`,
      retryable: false,
    }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
      maxExplorationTurns: 2,
    });

    await expect(agent.run("review", { invoke }, "discovery"))
      .resolves.toEqual({ summary: "checked", findings: [] });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(3);
    const followUpMessages = requests[1]!.messages as Array<{ role: string; content?: string }>;
    expect(followUpMessages.at(-1)?.content).toContain("single highest-risk unresolved candidate");
  });

  it("offers a patch-only continuation when the one-turn inventory first reveals paths", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [toolCall("inventory", "changed_files", '{"offset":0,"limit":100}')],
        } }] });
      }
      if (body.tools !== undefined) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [toolCall("patch", "diff_for_file", '{"path":"src/risky.ts"}')],
        } }] });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"checked","findings":[]}' } }] });
    }));
    const invoke = vi.fn(async (name: string, _rawArguments: string): Promise<EvidenceResult> => name === "changed_files"
      ? {
          status: "ok",
          content: JSON.stringify({
            files: [
              { path: "src/risky.ts", patchAvailable: true },
              { path: "assets/logo.png", patchAvailable: false },
            ],
          }),
          retryable: false,
          evidence: { scope: "changed_files:0:100", complete: true },
        }
      : {
          status: "ok",
          content: "exact patch",
          retryable: false,
          evidence: { scope: "diff_for_file:src/risky.ts", complete: true },
        });
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
      maxExplorationTurns: 1,
    });

    await expect(agent.run("review", { invoke }, "discovery"))
      .resolves.toEqual({ summary: "checked", findings: [] });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(3);
    expect((requests[1]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name))
      .toEqual(["diff_for_file"]);
    const continuation = requests[1]!.messages as Array<{ content?: string }>;
    expect(continuation.at(-1)?.content).toContain('"src/risky.ts"');
    expect(continuation.at(-1)?.content).not.toContain("assets/logo.png");
  });

  it("continues an adaptive inventory patch through at most two exact recovery rounds", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [toolCall("inventory", "changed_files", '{"offset":0,"limit":100}')],
        } }] });
      }
      if (requests.length === 2) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [toolCall("first-patch", "diff_for_file", '{"path":"src/large.ts"}')],
        } }] });
      }
      if (requests.length === 3) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [
            toolCall("broadened-range", "diff_for_file", '{"path":"src/large.ts","patch_start_line":202,"patch_end_line":450}'),
            toolCall("first-continuation", "diff_for_file", '{"path":"src/large.ts","patch_start_line":201,"patch_end_line":450}'),
          ],
        } }] });
      }
      if (requests.length === 4) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [
            toolCall("second-continuation", "diff_for_file", '{"path":"src/large.ts","patch_start_line":351,"patch_end_line":450}'),
          ],
        } }] });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"inventory patch recovered","findings":[]}' } }] });
    }));

    const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: true });
    const invoke = vi.fn(async (name: string, rawArguments: string): Promise<EvidenceResult> => {
      if (name === "changed_files") {
        const result: EvidenceResult = {
          status: "ok",
          content: JSON.stringify({ files: [{ path: "src/large.ts", patchAvailable: true }] }),
          retryable: false,
          evidence: { scope: "changed_files:0:100", complete: true },
        };
        tracker.record(name, result);
        return result;
      }
      const args = JSON.parse(rawArguments) as { path: string; patch_start_line?: number; patch_end_line?: number };
      const start = args.patch_start_line ?? 1;
      const requestedEnd = args.patch_end_line ?? 200;
      const end = start === 201 && requestedEnd === 450 ? 350 : requestedEnd;
      const nextStart = end < 450 ? end + 1 : undefined;
      const result: EvidenceResult = {
        status: "truncated",
        content: `exact patch ${start}-${end}`,
        retryable: false,
        evidence: {
          scope: `diff_for_file:${args.path}:${start}-${end}`,
          complete: false,
          changedPath: args.path,
          patchStartLine: start,
          patchEndLine: end,
          totalPatchLines: 450,
          patchIntervalComplete: true,
          sourceTargeted: false,
          ...(nextStart === undefined ? {} : {
            nextPatchStartLine: nextStart,
            nextPatchEndLine: 450,
          }),
        },
      };
      tracker.record(name, result, args.path);
      return result;
    });
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", {
      invoke,
      coverage: () => tracker.snapshot(),
    }, "discovery")).resolves.toEqual({ summary: "inventory patch recovered", findings: [] });

    expect(invoke.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ["changed_files", '{"offset":0,"limit":100}'],
      ["diff_for_file", '{"path":"src/large.ts"}'],
      ["diff_for_file", '{"path":"src/large.ts","patch_start_line":201,"patch_end_line":450}'],
      ["diff_for_file", '{"path":"src/large.ts","patch_start_line":351,"patch_end_line":450}'],
    ]);
    expect(tracker.snapshot()).toMatchObject({
      sufficient: true,
      inspectedChangedFiles: 1,
      inspectedChangedPaths: ["src/large.ts"],
      limitations: [],
      toolCalls: 4,
    });
    const firstRecoveryMessages = requests[2]!.messages as Array<{ role?: string; content?: string }>;
    expect(firstRecoveryMessages.at(-1)?.content).toContain("recovery round 1 of 2");
    expect(firstRecoveryMessages.at(-1)?.content).toContain(
      'diff_for_file {"path":"src/large.ts","patch_start_line":201,"patch_end_line":450}',
    );
    const secondRecoveryMessages = requests[3]!.messages as Array<{ role?: string; content?: string }>;
    expect(secondRecoveryMessages.at(-1)?.content).toContain("recovery round 2 of 2 (the final round)");
    expect(secondRecoveryMessages.at(-1)?.content).toContain(
      'diff_for_file {"path":"src/large.ts","patch_start_line":351,"patch_end_line":450}',
    );
    const finalMessages = requests[4]!.messages as Array<{ role?: string; content?: string }>;
    expect(finalMessages.some((message) => (
      message.role === "tool"
      && message.content?.includes("was not offered for this exact patch continuation")
    ))).toBe(true);
    expect(requests.slice(1, 4).every((request) => (
      (request.tools as Array<{ function: { name: string } }>).every((tool) => tool.function.name === "diff_for_file")
    ))).toBe(true);
    expect(requests[4]!.tools).toBeUndefined();
    expect(requests).toHaveLength(5);
  });

  it("rejects tools not offered during a patch-only continuation before cache or execution", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [toolCall("inventory", "changed_files", '{"offset":0,"limit":100}')],
        } }] });
      }
      if (body.tools !== undefined) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [
            toolCall("cached-inventory", "changed_files", '{"offset":0,"limit":100}'),
            toolCall("source", "read_file", '{"path":"src/risky.ts","ref":"head","start_line":1,"end_line":40}'),
            toolCall("search", "search_code", '{"query":"risky"}'),
            toolCall("patch", "diff_for_file", '{"path":"src/risky.ts"}'),
          ],
        } }] });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"checked","findings":[]}' } }] });
    }));
    const invoke = vi.fn(async (name: string, _rawArguments: string): Promise<EvidenceResult> => name === "changed_files"
      ? {
          status: "ok",
          content: JSON.stringify({ files: [{ path: "src/risky.ts", patchAvailable: true }] }),
          retryable: false,
          evidence: { scope: "changed_files:0:100", complete: true },
        }
      : {
          status: "ok",
          content: "exact patch",
          retryable: false,
          evidence: { scope: "diff_for_file:src/risky.ts", complete: true },
        });
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
      maxExplorationTurns: 1,
    });

    await expect(agent.run("review", { invoke }, "discovery"))
      .resolves.toEqual({ summary: "checked", findings: [] });

    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["changed_files", "diff_for_file"]);
    expect((requests[1]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name))
      .toEqual(["diff_for_file"]);
    const finalMessages = requests[2]!.messages as Array<{ role: string; content?: string }>;
    const rejected = finalMessages.filter((message) => message.role === "tool" && message.content?.includes("tool_not_offered"));
    expect(rejected).toHaveLength(3);
    expect(rejected.map((message) => (
      JSON.parse(message.content!) as { result: string }
    ).result)).toEqual([
      'Tool "changed_files" was not offered in this request.',
      'Tool "read_file" was not offered in this request.',
      'Tool "search_code" was not offered in this request.',
    ]);
  });

  it("restricts an inventory patch continuation to the exact paths that unlocked it", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [toolCall("inventory", "changed_files", '{"offset":0,"limit":100}')],
        } }] });
      }
      if (body.tools !== undefined) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [
            toolCall("outside", "diff_for_file", '{"path":"src/not-returned.ts"}'),
            toolCall("exact", "diff_for_file", '{"path":"src/returned.ts"}'),
          ],
        } }] });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"checked","findings":[]}' } }] });
    }));
    const invoke = vi.fn(async (name: string, _rawArguments: string): Promise<EvidenceResult> => name === "changed_files"
      ? {
          status: "ok",
          content: JSON.stringify({ files: [{ path: "src/returned.ts", patchAvailable: true }] }),
          retryable: false,
          evidence: { scope: "changed_files:0:100", complete: true },
        }
      : {
          status: "ok",
          content: "exact patch",
          retryable: false,
          evidence: { scope: "diff_for_file:src/returned.ts", complete: true },
        });
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", { invoke }, "discovery"))
      .resolves.toEqual({ summary: "checked", findings: [] });

    expect(invoke.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ["changed_files", '{"offset":0,"limit":100}'],
      ["diff_for_file", '{"path":"src/returned.ts"}'],
    ]);
    const finalMessages = requests[2]!.messages as Array<{ role: string; content?: string }>;
    const rejection = finalMessages.find((message) => (
      message.role === "tool" && message.content?.includes("src/not-returned.ts")
    ));
    expect(rejection?.content).toContain("was not offered for this inventory patch continuation");
  });

  it("forces exact patch retrieval before accepting a final answer when the initial diff is truncated", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1) {
        return jsonResponse({ choices: [{ message: { content: '{"summary":"premature","findings":[]}' } }] });
      }
      if (requests.length === 2) {
        return jsonResponse({
          choices: [{
            message: {
              content: null,
              tool_calls: [
                toolCall("patch-a", "diff_for_file", '{"path":"src/a.ts"}'),
                toolCall("patch-b", "diff_for_file", '{"path":"src/b.ts"}'),
              ],
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"patches inspected","findings":[]}' } }] });
    }));

    const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 21, initialDiffTruncated: true });
    const invoke = vi.fn(async (name: string, rawArguments: string): Promise<EvidenceResult> => {
      const path = String((JSON.parse(rawArguments) as { path: string }).path);
      const result: EvidenceResult = {
        status: "ok",
        content: `exact patch for ${path}`,
        retryable: false,
        evidence: {
          scope: `diff_for_file:${path}`,
          complete: true,
          changedPath: path,
          patchStartLine: 1,
          patchEndLine: 3,
          totalPatchLines: 3,
          patchIntervalComplete: true,
          sourceTargeted: false,
        },
      };
      tracker.record(name, result, path);
      return result;
    });
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", {
      invoke,
      coverage: () => tracker.snapshot(),
    }, "discovery")).resolves.toEqual({ summary: "patches inspected", findings: [] });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(tracker.snapshot().inspectedChangedFiles).toBe(2);
    expect(requests).toHaveLength(3);
    expect(requests[1]!.tools).toBeDefined();
    expect((requests[1]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name))
      .toEqual(["diff_for_file"]);
    const recoveryMessages = requests[1]!.messages as Array<{ role: string; content?: string }>;
    expect(recoveryMessages.at(-1)?.content).toContain("only 0 of 2 required exact changed-file patches");
    expect(recoveryMessages.at(-1)?.content).toContain("Use diff_for_file now");
  });

  it("closes an adaptive byte-fit gap with one final exact patch continuation", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [toolCall("initial", "diff_for_file", '{"path":"src/large.ts"}')],
        } }] });
      }
      if (requests.length === 2) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [
            toolCall("middle", "diff_for_file", '{"path":"src/large.ts","patch_start_line":"201","patch_end_line":"600"}'),
            toolCall("tail", "diff_for_file", '{"path":"src/large.ts","patch_start_line":"601","patch_end_line":"633"}'),
          ],
        } }] });
      }
      if (requests.length === 3) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [
            toolCall("shifted-gap", "diff_for_file", '{"path":"src/large.ts","patch_start_line":"502","patch_end_line":"633"}'),
            toolCall("exact-gap", "diff_for_file", '{"path":"src/large.ts","patch_start_line":"501","patch_end_line":"633"}'),
          ],
        } }] });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"fully recovered","findings":[]}' } }] });
    }));

    const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: true });
    const invoke = vi.fn(async (name: string, rawArguments: string): Promise<EvidenceResult> => {
      const args = JSON.parse(rawArguments) as { path: string; patch_start_line?: number; patch_end_line?: number };
      const start = args.patch_start_line ?? 1;
      const requestedEnd = args.patch_end_line ?? 200;
      // Simulate the repository transport fitting the requested 201-600
      // interval to a smaller valid-JSON byte prefix. The speculative tail
      // request still succeeds, but 501-600 remains uncovered until the newly
      // advertised exact continuation is copied.
      const end = start === 201 && requestedEnd === 600 ? 500 : requestedEnd;
      const nextStart = end < 633 ? end + 1 : undefined;
      const result: EvidenceResult = {
        status: "truncated",
        content: `exact patch ${start}-${end}`,
        retryable: false,
        ...(nextStart === undefined ? {} : { suggestedAction: `Recover from ${nextStart}.` }),
        evidence: {
          scope: `diff_for_file:${args.path}:${start}-${end}`,
          complete: false,
          changedPath: args.path,
          patchStartLine: start,
          patchEndLine: end,
          totalPatchLines: 633,
          patchIntervalComplete: true,
          sourceTargeted: false,
          ...(nextStart === undefined ? {} : {
            nextPatchStartLine: nextStart,
            nextPatchEndLine: Math.min(633, nextStart + 399),
          }),
        },
      };
      tracker.record(name, result, args.path);
      return result;
    });
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", {
      invoke,
      coverage: () => tracker.snapshot(),
    }, "discovery")).resolves.toEqual({ summary: "fully recovered", findings: [] });

    expect(invoke.mock.calls.map(([, args]) => args)).toEqual([
      '{"path":"src/large.ts"}',
      '{"path":"src/large.ts","patch_start_line":201,"patch_end_line":600}',
      '{"path":"src/large.ts","patch_start_line":601,"patch_end_line":633}',
      '{"path":"src/large.ts","patch_start_line":501,"patch_end_line":633}',
    ]);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(tracker.snapshot()).toMatchObject({
      sufficient: true,
      inspectedChangedFiles: 1,
      inspectedChangedPaths: ["src/large.ts"],
      limitations: [],
    });
    const recoveryMessages = requests[1]!.messages as Array<{ content?: string }>;
    expect(recoveryMessages.at(-1)?.content).toContain(
      'diff_for_file {"path":"src/large.ts","patch_start_line":201,"patch_end_line":600}',
    );
    expect(recoveryMessages.at(-1)?.content).toContain(
      'diff_for_file {"path":"src/large.ts","patch_start_line":601,"patch_end_line":633}',
    );
    const finalContinuationMessages = requests[2]!.messages as Array<{ role?: string; content?: string }>;
    expect(finalContinuationMessages.at(-1)?.content).toContain("recovery round 2 of 2 (the final round)");
    expect(finalContinuationMessages.at(-1)?.content).toContain(
      'diff_for_file {"path":"src/large.ts","patch_start_line":501,"patch_end_line":633}',
    );
    expect(finalContinuationMessages.at(-1)?.content).not.toContain(
      'diff_for_file {"path":"src/large.ts","patch_start_line":502,"patch_end_line":633}',
    );
    const finalMessages = requests[3]!.messages as Array<{ role?: string; content?: string }>;
    expect(finalMessages.some((message) => (
      message.role === "tool"
      && message.content?.includes("was not offered for this exact patch continuation")
    ))).toBe(true);
    expect((requests[2]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name))
      .toEqual(["diff_for_file"]);
    expect(requests[3]!.tools).toBeUndefined();
    expect(requests).toHaveLength(4);
  });

  it("keeps the final exact continuation reachable after a full four-call evidence batch", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [
            toolCall("initial-patch", "diff_for_file", '{"path":"src/large.ts"}'),
            toolCall("caller", "read_file", '{"path":"src/caller.ts","ref":"head","start_line":1,"end_line":80}'),
            toolCall("base", "read_file", '{"path":"src/caller.ts","ref":"base","start_line":1,"end_line":80}'),
            toolCall("search", "search_code", '{"query":"large"}'),
          ],
        } }] });
      }
      if (requests.length === 2) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [
            toolCall("middle", "diff_for_file", '{"path":"src/large.ts","patch_start_line":201,"patch_end_line":600}'),
            toolCall("tail", "diff_for_file", '{"path":"src/large.ts","patch_start_line":601,"patch_end_line":633}'),
          ],
        } }] });
      }
      if (requests.length === 3) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [
            toolCall("exact-gap", "diff_for_file", '{"path":"src/large.ts","patch_start_line":501,"patch_end_line":633}'),
          ],
        } }] });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"fully recovered after broad batch","findings":[]}' } }] });
    }));

    const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: true });
    const invoke = vi.fn(async (name: string, rawArguments: string): Promise<EvidenceResult> => {
      const args = JSON.parse(rawArguments) as {
        path?: string;
        patch_start_line?: number;
        patch_end_line?: number;
      };
      if (name !== "diff_for_file") {
        const complete: EvidenceResult = {
          status: "ok",
          content: "complete semantic context",
          retryable: false,
          evidence: { scope: `${name}:${args.path ?? "large"}`, complete: true },
        };
        tracker.record(name, complete);
        return complete;
      }
      const start = args.patch_start_line ?? 1;
      const requestedEnd = args.patch_end_line ?? 200;
      const end = start === 201 && requestedEnd === 600 ? 500 : requestedEnd;
      const nextStart = end < 633 ? end + 1 : undefined;
      const result: EvidenceResult = {
        status: "truncated",
        content: `exact patch ${start}-${end}`,
        retryable: false,
        evidence: {
          scope: `diff_for_file:src/large.ts:${start}-${end}`,
          complete: false,
          changedPath: "src/large.ts",
          patchStartLine: start,
          patchEndLine: end,
          totalPatchLines: 633,
          patchIntervalComplete: true,
          sourceTargeted: false,
          ...(nextStart === undefined ? {} : {
            nextPatchStartLine: nextStart,
            nextPatchEndLine: Math.min(633, nextStart + 399),
          }),
        },
      };
      tracker.record(name, result, "src/large.ts");
      return result;
    });
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", {
      invoke,
      coverage: () => tracker.snapshot(),
    }, "verification")).resolves.toEqual({
      summary: "fully recovered after broad batch",
      findings: [],
    });

    expect(invoke).toHaveBeenCalledTimes(7);
    expect(invoke.mock.calls.at(-1)?.[1]).toBe(
      '{"path":"src/large.ts","patch_start_line":501,"patch_end_line":633}',
    );
    expect(tracker.snapshot()).toMatchObject({ sufficient: true, limitations: [] });
    expect(requests).toHaveLength(4);
  });

  it("does not add a second recovery round when the first batch covers its advertised patch range", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [toolCall("initial", "diff_for_file", '{"path":"src/large.ts"}')],
        } }] });
      }
      if (requests.length === 2) {
        return jsonResponse({ choices: [{ message: {
          content: null,
          tool_calls: [
            toolCall("middle", "diff_for_file", '{"path":"src/large.ts","patch_start_line":201,"patch_end_line":600}'),
            toolCall("tail", "diff_for_file", '{"path":"src/large.ts","patch_start_line":601,"patch_end_line":633}'),
          ],
        } }] });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"recovered once","findings":[]}' } }] });
    }));

    const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 1, initialDiffTruncated: true });
    const invoke = vi.fn(async (name: string, rawArguments: string): Promise<EvidenceResult> => {
      const args = JSON.parse(rawArguments) as { path: string; patch_start_line?: number; patch_end_line?: number };
      const start = args.patch_start_line ?? 1;
      const end = args.patch_end_line ?? 200;
      const nextStart = end < 633 ? end + 1 : undefined;
      const result: EvidenceResult = {
        status: "truncated",
        content: `exact patch ${start}-${end}`,
        retryable: false,
        evidence: {
          scope: `diff_for_file:${args.path}:${start}-${end}`,
          complete: false,
          changedPath: args.path,
          patchStartLine: start,
          patchEndLine: end,
          totalPatchLines: 633,
          patchIntervalComplete: true,
          sourceTargeted: false,
          ...(nextStart === undefined ? {} : {
            nextPatchStartLine: nextStart,
            nextPatchEndLine: Math.min(633, nextStart + 399),
          }),
        },
      };
      tracker.record(name, result, args.path);
      return result;
    });
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", {
      invoke,
      coverage: () => tracker.snapshot(),
    }, "discovery")).resolves.toEqual({ summary: "recovered once", findings: [] });

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(tracker.snapshot().sufficient).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests[2]!.tools).toBeUndefined();
  });

  it("uses the recovery turn for patches when successful broad calls did not recover a truncated initial diff", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (requests.length === 1) {
        return jsonResponse({
          choices: [{
            message: {
              content: null,
              tool_calls: [
                toolCall("files", "changed_files", "{}"),
                toolCall("tree", "repository_tree", '{"prefix":"src"}'),
                toolCall("search", "search_code", '{"query":"handler"}'),
                toolCall("source", "read_file", '{"path":"src/a.ts","ref":"head","start_line":1,"end_line":40}'),
              ],
            },
          }],
        });
      }
      if (requests.length === 2) {
        return jsonResponse({
          choices: [{
            message: {
              content: null,
              tool_calls: [toolCall("patch", "diff_for_file", '{"path":"src/a.ts"}')],
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"recovered","findings":[]}' } }] });
    }));

    const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 21, initialDiffTruncated: true });
    const invoke = vi.fn(async (name: string, rawArguments: string): Promise<EvidenceResult> => {
      const args = JSON.parse(rawArguments) as { path?: string };
      const result: EvidenceResult = {
        status: "ok",
        content: "complete evidence",
        retryable: false,
        evidence: {
          scope: `${name}:${args.path ?? "result"}`,
          complete: true,
          ...(name === "diff_for_file" && args.path
            ? {
                changedPath: args.path,
                patchStartLine: 1,
                patchEndLine: 3,
                totalPatchLines: 3,
                patchIntervalComplete: true,
                sourceTargeted: false,
              }
            : {}),
        },
      };
      tracker.record(name, result, name === "diff_for_file" ? args.path : undefined);
      return result;
    });
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", {
      invoke,
      coverage: () => tracker.snapshot(),
    }, "discovery")).resolves.toEqual({ summary: "recovered", findings: [] });

    expect(invoke).toHaveBeenCalledTimes(5);
    expect(tracker.snapshot().inspectedChangedFiles).toBe(1);
    expect((requests[1]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name))
      .toEqual(["diff_for_file"]);
    const recoveryMessages = requests[1]!.messages as Array<{ content?: string }>;
    expect(recoveryMessages.at(-1)?.content).toContain("must retrieve code changes");
  });

  it("continues truncated-diff recovery when a multi-file review inspected only one exact patch", async () => {
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (requests.length === 1) {
        return jsonResponse({
          choices: [{
            message: {
              content: null,
              tool_calls: [
                toolCall("patch-a", "diff_for_file", '{"path":"src/a.ts"}'),
                toolCall("source", "read_file", '{"path":"src/a.ts","ref":"head","start_line":1,"end_line":40}'),
                toolCall("tree", "repository_tree", '{"prefix":"src"}'),
                toolCall("search", "search_code", '{"query":"handler"}'),
              ],
            },
          }],
        });
      }
      if (body.tools !== undefined) {
        return jsonResponse({
          choices: [{
            message: {
              content: null,
              tool_calls: [toolCall("patch-b", "diff_for_file", '{"path":"src/b.ts"}')],
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"recovered","findings":[]}' } }] });
    }));

    const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 41, initialDiffTruncated: true });
    const invoke = vi.fn(async (name: string, rawArguments: string): Promise<EvidenceResult> => {
      const args = JSON.parse(rawArguments) as { path?: string };
      const result: EvidenceResult = {
        status: "ok",
        content: "complete evidence",
        retryable: false,
        evidence: {
          scope: `${name}:${args.path ?? "result"}`,
          complete: true,
          ...(name === "diff_for_file" && args.path
            ? {
                changedPath: args.path,
                patchStartLine: 1,
                patchEndLine: 3,
                totalPatchLines: 3,
                patchIntervalComplete: true,
                sourceTargeted: false,
              }
            : {}),
        },
      };
      tracker.record(name, result, name === "diff_for_file" ? args.path : undefined);
      return result;
    });
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", {
      invoke,
      coverage: () => tracker.snapshot(),
    }, "discovery")).resolves.toEqual({ summary: "recovered", findings: [] });

    expect(invoke).toHaveBeenCalledTimes(5);
    expect(tracker.snapshot()).toMatchObject({
      sufficient: true,
      totalChangedFiles: 41,
      inspectedChangedFiles: 2,
      toolCalls: 5,
      truncatedResults: 0,
      limitations: [],
    });
    expect((requests[1]!.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name))
      .toEqual(["diff_for_file"]);
  });

  it("fails closed on an OpenRouter error", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "bad key" } }, 401));
    vi.stubGlobal("fetch", fetchMock);
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });
    await expect(agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "discovery:security"))
      .rejects.toThrow("OpenRouter discovery:security request failed (401): bad key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers from a transient connection loss with same-model provider fallback enabled", async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown>> = [];
    let attempts = 0;
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      attempts++;
      if (attempts === 1) throw new TypeError("Network connection lost.");
      return jsonResponse({ choices: [{ message: { content: '{"summary":"recovered","findings":[]}' } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    const review = agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "discovery:operations");
    const assertion = expect(review).resolves.toEqual({ summary: "recovered", findings: [] });
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]!.provider).toEqual({
      allow_fallbacks: true,
      require_parameters: true,
      data_collection: "deny",
    });
  });

  it("recovers when two consecutive provider transports fail transiently", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts++;
      if (attempts <= 2) throw new TypeError("Network connection lost.");
      return jsonResponse({ choices: [{ message: { content: '{"summary":"recovered","findings":[]}' } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    const review = agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "discovery");
    const assertion = expect(review).resolves.toEqual({ summary: "recovered", findings: [] });
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses the configured per-request output allowance instead of an 8k hard cap", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const metadataHeaders: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      metadataHeaders.push(new Headers(init?.headers).get("x-openrouter-experimental-metadata"));
      return jsonResponse({ choices: [{ message: { content: '{"summary":"roomy","findings":[]}' } }] });
    }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
      maxOutputTokensPerRequest: 32_000,
    });

    await expect(agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "discovery"))
      .resolves.toEqual({ summary: "roomy", findings: [] });

    expect(bodies[0]!.max_tokens).toBe(32_000);
    expect(metadataHeaders).toEqual(["enabled"]);
  });

  it("retries a malformed successful provider response inside the request loop", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts++;
      return attempts === 1
        ? new Response("upstream proxy returned HTML", { status: 200 })
        : jsonResponse({ choices: [{ message: { content: '{"summary":"recovered","findings":[]}' } }] });
    }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    const review = agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "discovery");
    const assertion = expect(review).resolves.toEqual({ summary: "recovered", findings: [] });
    await vi.runAllTimersAsync();
    await assertion;

    expect(attempts).toBe(2);
  });

  it("excludes a provider after a top-level typed availability error", async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? jsonResponse({
          provider: "DeepInfra",
          error: { code: 502, message: "unavailable", metadata: { error_type: "provider_unavailable" } },
        }, 502)
        : jsonResponse({ choices: [{ message: { content: '{"summary":"fallback","findings":[]}' } }] });
    }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    const review = agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "discovery");
    const assertion = expect(review).resolves.toEqual({ summary: "fallback", findings: [] });
    await vi.runAllTimersAsync();
    await assertion;

    expect(bodies[1]!.provider).toMatchObject({ ignore: ["deepinfra"] });
  });

  it("aborts in-flight model work when a newer pull request head supersedes it", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      setTimeout(() => reject(new Error("model request still running")), 1);
    }));
    vi.stubGlobal("fetch", fetchMock);
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
      signal: controller.signal,
    });

    const review = agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "discovery:state");
    controller.abort(new Error("review superseded by a newer head"));

    await expect(review).rejects.toThrow("review superseded by a newer head");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves an empty DeepSeek reasoning field across a tool turn", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return bodies.length === 1
        ? jsonResponse({
          choices: [{
            message: {
              content: null,
              reasoning: "",
              reasoning_details: [],
              tool_calls: [{
                id: "call-empty-reasoning",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
              }],
            },
          }],
        })
        : jsonResponse({ choices: [{ message: { content: '{"summary":"clean","findings":[]}' } }] });
    }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run(
      "review",
      { invoke: vi.fn(async () => ({ content: "evidence" })) } as unknown as RepositoryTools,
      "discovery",
    )).resolves.toEqual({ summary: "clean", findings: [] });

    const messages = bodies[1]!.messages as Array<Record<string, unknown>>;
    expect(messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      reasoning: "",
      reasoning_details: [],
    }));
  });

  it("aborts an in-flight repository tool when a newer head supersedes the review", async () => {
    const controller = new AbortController();
    let requests = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      requests++;
      return jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call-slow",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"src/slow.ts"}' },
            }],
          },
        }],
      });
    }));
    const invoke = vi.fn(async (_name: string, _args: string, signal?: AbortSignal) => (
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
    ));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
      signal: controller.signal,
    });

    const review = agent.run("review", { invoke } as unknown as RepositoryTools, "discovery");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    controller.abort(new Error("review superseded by a newer head"));

    await expect(review).rejects.toThrow("review superseded by a newer head");
    expect(requests).toBe(1);
  });

  it("reports the review phase after transient retries are exhausted", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Network connection lost.");
    });
    vi.stubGlobal("fetch", fetchMock);
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    const review = agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "verification");
    const assertion = expect(review).rejects.toThrow(
      "OpenRouter verification request failed after 3 attempts: Network connection lost.",
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries an output-exhausted completion with more headroom and high reasoning", async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? jsonResponse({
          model: "deepseek/deepseek-v4-flash-0731",
          provider: "DeepInfra",
          choices: [{
            message: { content: null, reasoning: "spent the output budget" },
            finish_reason: "length",
            native_finish_reason: "max_tokens",
          }],
          usage: {
            prompt_tokens: 28_792,
            completion_tokens: 8_000,
            completion_tokens_details: { reasoning_tokens: 8_000 },
          },
        })
        : jsonResponse({ choices: [{ message: { content: '{"summary":"recovered","findings":[]}' } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    const review = agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "discovery:state");
    const assertion = expect(review).resolves.toEqual({ summary: "recovered", findings: [] });
    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[1]!.provider).toMatchObject({ ignore: ["deepinfra"] });
    expect(bodies[0]!.reasoning).toEqual({ effort: "high" });
    expect(bodies[1]!.reasoning).toEqual({ effort: "high" });
    expect(bodies[0]!.max_tokens).toBe(32_000);
    expect(bodies[1]!.max_tokens).toBe(64_000);
  });

  it("expands finalization headroom without lowering reasoning", async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.tools !== undefined) {
        return jsonResponse({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "read-finalization-evidence",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
              }],
            },
          }],
        });
      }
      if (Number(body.max_tokens) > 32_000) {
        return jsonResponse({
          choices: [{ message: { content: '{"summary":"finalized","findings":[]}' } }],
          usage: {
            prompt_tokens: 17_078,
            completion_tokens: 22,
            completion_tokens_details: { reasoning_tokens: 6_000 },
          },
        });
      }
      return jsonResponse({
        provider: "Fireworks",
        choices: [{
          message: { content: null, reasoning: "spent the entire output allowance" },
          finish_reason: "length",
          native_finish_reason: "length",
        }],
        usage: {
          prompt_tokens: 17_078,
          completion_tokens: 32_000,
          completion_tokens_details: { reasoning_tokens: 32_000 },
        },
      });
    }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    const review = agent.run(
      "review",
      { invoke: vi.fn(async () => ({ content: "1: evidence" })) } as unknown as RepositoryTools,
      "discovery",
    );
    const assertion = expect(review).resolves.toEqual({ summary: "finalized", findings: [] });
    await vi.runAllTimersAsync();
    await assertion;

    expect(bodies).toHaveLength(3);
    expect(bodies[1]!.tools).toBeUndefined();
    expect(bodies[2]!.tools).toBeUndefined();
    expect(bodies[1]!.reasoning).toEqual({ effort: "high" });
    expect(bodies[2]!.reasoning).toEqual({ effort: "high" });
    expect(bodies[1]!.max_tokens).toBe(32_000);
    expect(bodies[2]!.max_tokens).toBe(64_000);
  });

  it("accounts for usage reported by a failed provider attempt", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts++;
      return attempts === 1
        ? jsonResponse({
          provider: "DeepInfra",
          error: { code: 503, message: "overloaded", metadata: { error_type: "provider_overloaded" } },
          usage: { prompt_tokens: 111, completion_tokens: 7, cost: 0.001 },
        }, 503)
        : jsonResponse({
          choices: [{ message: { content: '{"summary":"recovered","findings":[]}' } }],
          usage: { prompt_tokens: 222, completion_tokens: 8, cost: 0.002 },
        });
    }));
    const budget = new ReviewBudget();
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
      budget,
    });

    const review = agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "discovery");
    const assertion = expect(review).resolves.toEqual({ summary: "recovered", findings: [] });
    await vi.runAllTimersAsync();
    await assertion;

    expect(budget.snapshot()).toMatchObject({
      reportedInputTokens: 333,
      outputTokens: 15,
      costUsd: 0.003,
    });
  });

  it("fails closed on an empty non-retryable upstream rejection", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response("", { status: 400 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run(
      "review",
      { invoke: vi.fn() } as unknown as RepositoryTools,
      "discovery:state",
    )).rejects.toThrow("invalid JSON (400)");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bodies[0]!.provider).toEqual({
      allow_fallbacks: true,
      require_parameters: true,
      data_collection: "deny",
    });
    expect(bodies[0]!.reasoning).toBeDefined();
  });

  it("repairs malformed final JSON once without tools", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? jsonResponse({ choices: [{ message: { content: "not json" } }] })
        : jsonResponse({ choices: [{ message: { content: '{"summary":"repaired","findings":[]}' } }] });
    }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", { invoke: vi.fn() } as unknown as RepositoryTools, "verification"))
      .resolves.toEqual({ summary: "repaired", findings: [] });
    expect(bodies[1]!.tools).toBeUndefined();
    expect(bodies[1]!.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "gaston_review", strict: true },
    });
  });

  it("uses the strict tri-state schema when repairing verification output", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? jsonResponse({ choices: [{ message: { content: "not json" } }] })
        : jsonResponse({ choices: [{ message: { content: JSON.stringify({
            summary: "checked every candidate",
            verdicts: [{
              candidateId: "GASTON-CANDIDATE-1",
              verdict: "insufficient",
              path: "src/a.ts",
              line: 10,
              side: "RIGHT",
              confidence: 0.5,
              rationale: "the exact base file was unavailable",
              evidence: "read_file returned a permanent error",
              evidenceComplete: false,
              evidenceScopes: [],
            }],
          }) } }] });
    }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.runVerification(
      "verify",
      { invoke: vi.fn() } as unknown as RepositoryTools,
    )).resolves.toMatchObject({
      summary: "checked every candidate",
      verdicts: [{
        candidateId: "GASTON-CANDIDATE-1",
        verdict: "insufficient",
        valid: true,
      }],
    });
    expect(bodies[1]!.tools).toBeUndefined();
    expect(bodies[1]!.response_format).toMatchObject({
      type: "json_schema",
      json_schema: {
        name: "gaston_verification",
        strict: true,
        schema: {
          required: ["summary", "verdicts"],
          properties: {
            verdicts: {
              items: {
                required: expect.arrayContaining([
                  "candidateId",
                  "verdict",
                  "evidenceComplete",
                  "evidenceScopes",
                ]),
              },
            },
          },
        },
      },
    });
  });

  it("forces finalization after one productive exploration turn", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.tools === undefined || bodies.length > 16) {
        return jsonResponse({ choices: [{ message: { content: '{"summary":"deep review","findings":[]}' } }] });
      }
      return jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: `call-${bodies.length}`,
              type: "function",
              function: { name: "read_file", arguments: `{"path":"src/${bodies.length}.ts"}` },
            }],
          },
        }],
      });
    }));

    const invoke = vi.fn(async (_name: string, args: string) => ({ content: `evidence:${args}` }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", { invoke } as unknown as RepositoryTools, "discovery:state"))
      .resolves.toEqual({ summary: "deep review", findings: [] });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    expect(bodies.at(-1)!.tools).toBeUndefined();
    const finalMessages = bodies.at(-1)!.messages as Array<{ role: string; content?: string }>;
    expect(finalMessages.at(-1)?.content).toContain("No further tools are available");
    expect(finalMessages.at(-1)?.content).toContain("findings array is authoritative");
    expect(finalMessages.at(-1)?.content).toContain("Do not narrate future investigation");
  });

  it("memoizes duplicate tool calls within the bounded evidence batch", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.tools === undefined || bodies.length > 8) {
        return jsonResponse({ choices: [{ message: { content: '{"summary":"cycle stopped","findings":[]}' } }] });
      }
      return jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: ["a", "b"].map((id) => ({
              id: `call-${id}`,
              type: "function",
              function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
            })),
          },
        }],
      });
    }));

    const invoke = vi.fn(async () => ({ content: "evidence" }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", { invoke } as unknown as RepositoryTools, "verification"))
      .resolves.toEqual({ summary: "cycle stopped", findings: [] });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(bodies).toHaveLength(2);
    expect(bodies.at(-1)!.tools).toBeUndefined();
  });

  it("executes at most four calls from one oversized tool batch", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({
          choices: [{
            message: {
              content: null,
              tool_calls: Array.from({ length: 20 }, (_, index) => ({
                id: `call-${index}`,
                type: "function",
                function: { name: "read_file", arguments: `{"path":"src/${index}.ts"}` },
              })),
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"bounded batch","findings":[]}' } }] });
    }));

    const invoke = vi.fn(async () => ({ content: "evidence" }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", { invoke } as unknown as RepositoryTools, "verification"))
      .resolves.toEqual({ summary: "bounded batch", findings: [] });
    expect(invoke).toHaveBeenCalledTimes(4);
    const secondMessages = bodies[1]!.messages as Array<{ role: string; content?: string }>;
    expect(secondMessages.filter((message) => message.role === "tool")).toHaveLength(20);
    expect(secondMessages.filter((message) => message.content?.includes("safety budget reached"))).toHaveLength(16);
  });

  it("does not report the harness tool cap as unavailable repository evidence", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.tools === undefined) {
        return jsonResponse({ choices: [{ message: { content: '{"summary":"bounded","findings":[]}' } }] });
      }
      if (bodies.length === 1) {
        return jsonResponse({
          choices: [{
            message: {
              content: null,
              tool_calls: [
                toolCall("broad-read", "read_file", '{"path":"src/a.ts","ref":"head","start_line":1,"end_line":400}'),
                toolCall("exact-patch", "diff_for_file", '{"path":"src/a.ts"}'),
                toolCall("initial-search", "search_code", '{"query":"caller"}'),
              ],
            },
          }],
        });
      }
      return jsonResponse({
        choices: [{
          message: {
            content: null,
            tool_calls: [
              toolCall("narrow-read", "read_file", '{"path":"src/a.ts","ref":"head","start_line":100,"end_line":150}'),
              toolCall("recovery-search", "search_code", '{"query":"guard"}'),
              toolCall("over-cap-search", "search_code", '{"query":"extra"}'),
            ],
          },
        }],
      });
    }));

    const tracker = new EvidenceCoverageTracker({ totalChangedFiles: 6, initialDiffTruncated: false });
    const invoke = vi.fn(async (name: string, rawArguments: string): Promise<EvidenceResult> => {
      const args = JSON.parse(rawArguments) as Record<string, unknown>;
      const broadRead = name === "read_file" && args.start_line === 1;
      const result: EvidenceResult = broadRead
        ? {
            status: "truncated",
            content: "partial evidence",
            retryable: false,
            evidence: { scope: "read_file:head:src/a.ts", complete: false },
            suggestedAction: "Request a narrower line range once.",
          }
        : {
            status: "ok",
            content: "complete evidence",
            retryable: false,
            evidence: {
              scope: name === "read_file" ? "read_file:head:src/a.ts" : `${name}:${String(args.query ?? args.path ?? "")}`,
              complete: true,
              ...(name === "diff_for_file"
                ? {
                    changedPath: "src/a.ts",
                    patchStartLine: 1,
                    patchEndLine: 3,
                    totalPatchLines: 3,
                    patchIntervalComplete: true,
                    sourceTargeted: false,
                  }
                : {}),
            },
          };
      tracker.record(name, result, name === "diff_for_file" ? "src/a.ts" : undefined);
      return result;
    });
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", {
      invoke,
    }, "discovery")).resolves.toEqual({ summary: "bounded", findings: [] });

    expect(tracker.snapshot()).toMatchObject({
      sufficient: true,
      totalChangedFiles: 6,
      inspectedChangedFiles: 1,
      toolCalls: 5,
      truncatedResults: 1,
      permanentErrors: 0,
      limitations: [],
    });
  });

  it("compacts old tool results before the carried context exceeds 150 KB", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return jsonResponse({
          choices: [{
            message: {
              content: null,
              tool_calls: Array.from({ length: 4 }, (_, index) => ({
                id: `call-${index}`,
                type: "function",
                function: { name: "read_file", arguments: `{"path":"src/${index}.ts"}` },
              })),
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ message: { content: '{"summary":"bounded","findings":[]}' } }] });
    }));

    const invoke = vi.fn(async () => ({ content: `evidence:${"x".repeat(40_000)}` }));
    const agent = new ReviewAgent({
      apiKey: TEST_API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
    });

    await expect(agent.run("review", { invoke } as unknown as RepositoryTools, "discovery:behavior"))
      .resolves.toEqual({ summary: "bounded", findings: [] });
    const messageBytes = bodies.map((body) => new TextEncoder().encode(JSON.stringify(body.messages)).byteLength);
    expect(Math.max(...messageBytes)).toBeLessThanOrEqual(120_000);
    const finalMessages = bodies[1]!.messages as Array<{ role: string; content?: string }>;
    expect(finalMessages.some((message) => message.content?.includes("Gaston compacted"))).toBe(true);
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toolCall(id: string, name: string, args: string) {
  return { id, type: "function", function: { name, arguments: args } };
}
