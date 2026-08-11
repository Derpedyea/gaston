import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewAgent } from "../src/agent.ts";
import type { EvidenceTools } from "../src/evidence.ts";

const API_KEY = `sk-or-v1-${"x".repeat(64)}`;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OpenRouter provider conformance", () => {
  it("repairs only structural JSON closure when a provider reports output truncation", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const modelFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return requests.length === 1
        ? response({
            choices: [{
              finish_reason: "length",
              message: {
                content: null,
                tool_calls: [{
                  id: "partial",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"src/a.ts","ref":"head","start_line":1,"end_line":20',
                  },
                }],
              },
            }],
          })
        : response({ choices: [{ message: { content: '{"summary":"clean","findings":[]}' } }] });
    });
    const invoke = vi.fn(async (_name: string, raw: string) => {
      expect(JSON.parse(raw)).toMatchObject({ path: "src/a.ts", end_line: 20 });
      return { status: "ok" as const, content: "1: safe();", retryable: false };
    });

    await expect(agent(modelFetch).run("review", { invoke } as EvidenceTools, "discovery"))
      .resolves.toEqual({ summary: "clean", findings: [] });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("uses one targeted recovery turn for invalid arguments without inventing string content", async () => {
    let request = 0;
    const modelFetch = vi.fn(async () => {
      request++;
      if (request === 1) {
        return response({ choices: [{ message: { content: null, tool_calls: [{
          id: "bad",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"src/unterminated.ts' },
        }] } }] });
      }
      if (request === 2) {
        return response({ choices: [{ message: { content: null, tool_calls: [{
          id: "fixed",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"src/a.ts","ref":"head","start_line":1,"end_line":20}' },
        }] } }] });
      }
      return response({ choices: [{ message: { content: '{"summary":"recovered","findings":[]}' } }] });
    });
    const invoke = vi.fn(async (_name: string, raw: string) => raw.includes("unterminated")
      ? {
          status: "invalid_arguments" as const,
          content: "unterminated string",
          retryable: false,
          suggestedAction: "Correct the JSON arguments.",
          isError: true,
        }
      : { status: "ok" as const, content: "1: safe();", retryable: false });

    await expect(agent(modelFetch).run("review", { invoke } as EvidenceTools, "verification"))
      .resolves.toEqual({ summary: "recovered", findings: [] });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(modelFetch).toHaveBeenCalledTimes(3);
  });

  it("reports provider cache hits at phase completion", async () => {
    const logs: Array<Record<string, unknown>> = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(value as Record<string, unknown>));
    const modelFetch = vi.fn(async () => response({
      choices: [{ message: { content: '{"summary":"cached","findings":[]}' } }],
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 750, cache_write_tokens: 25 },
      },
    }));

    await agent(modelFetch).run("review", { invoke: vi.fn() }, "discovery");

    expect(logs).toContainEqual(expect.objectContaining({
      event: "agent.phase_completed",
      cachedTokens: 750,
      cacheWriteTokens: 25,
      cacheHitRate: 0.75,
    }));
  });

  it("excludes a provider that returns an embedded completion error", async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown>> = [];
    const modelFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? response({
            provider: "DeepInfra",
            choices: [{ error: { code: 503, message: "overloaded", metadata: { error_type: "provider_overloaded" } } }],
          })
        : response({ choices: [{ message: { content: '{"summary":"fallback","findings":[]}' } }] });
    });

    const review = agent(modelFetch).run("review", { invoke: vi.fn() }, "discovery");
    const assertion = expect(review).resolves.toEqual({ summary: "fallback", findings: [] });
    await vi.runAllTimersAsync();
    await assertion;

    expect(bodies[1]!.provider).toMatchObject({ ignore: ["deepinfra"] });
  });

  it("normalizes reasoning_content and returns it with tool results", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const modelFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? response({ choices: [{ message: {
            content: null,
            reasoning_content: "provider state",
            tool_calls: [{
              id: "read",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"src/a.ts","ref":"head","start_line":1,"end_line":2}' },
            }],
          } }] })
        : response({ choices: [{ message: { content: '{"summary":"round trip","findings":[]}' } }] });
    });

    await agent(modelFetch).run("review", {
      invoke: vi.fn(async () => ({ status: "ok" as const, content: "1: safe", retryable: false })),
    }, "discovery");

    const messages = bodies[1]!.messages as Array<Record<string, unknown>>;
    expect(messages).toContainEqual(expect.objectContaining({
      role: "assistant",
      reasoning: "provider state",
    }));
  });
});

function agent(modelFetch: typeof fetch): ReviewAgent {
  return new ReviewAgent({
    apiKey: API_KEY,
    model: "deepseek/deepseek-v4-flash-0731",
    reasoningEffort: "high",
    repository: "owner/repo",
    modelFetch,
  });
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
