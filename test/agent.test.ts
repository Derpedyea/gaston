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
    })).toThrow("REVIEW_REASONING_EFFORT must be high; Gaston does not downgrade review reasoning");
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
    expect(requests[0]!.reasoning).toEqual({ effort: "high" });
    expect(requests[1]!.reasoning).toEqual({ effort: "high" });
    expect(requests[0]!.max_tokens).toBe(32_000);
    expect(requests[1]!.max_tokens).toBe(32_000);
    expect(requests[0]!.temperature).toBeUndefined();
    expect(requests[0]!.session_id).toMatch(/^gaston:owner\/repo:discovery:/);
    expect(requests[1]!.session_id).toBe(requests[0]!.session_id);
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
        evidence: { scope: `diff_for_file:${path}`, complete: true },
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
        evidence: { scope: `${name}:${args.path ?? "result"}`, complete: true },
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
        evidence: { scope: `${name}:${args.path ?? "result"}`, complete: true },
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

  it("retries an empty upstream rejection that has no actionable client error", async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown>> = [];
    let attempts = 0;
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      attempts++;
      return attempts === 1
        ? new Response("", { status: 400 })
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
    expect(bodies[0]!.provider).toBeDefined();
    expect(bodies[1]!.provider).toBeUndefined();
    expect(bodies[1]!.reasoning).toBeDefined();
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
