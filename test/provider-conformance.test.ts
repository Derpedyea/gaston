import { afterEach, describe, expect, it, vi } from "vitest";

import { ReviewAgent, reviewProviderRouteFromEnv } from "../src/agent.ts";
import type { EvidenceTools } from "../src/evidence.ts";

const API_KEY = `sk-or-v1-${"x".repeat(64)}`;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("OpenRouter provider conformance", () => {
  it("resolves and validates the production provider settings", () => {
    expect(reviewProviderRouteFromEnv("openai/gpt-5.6-luna", undefined, undefined)).toEqual({
      provider: "openai",
      requireZdr: false,
    });
    expect(reviewProviderRouteFromEnv("openai/gpt-5.6-luna", " Azure ", "TRUE")).toEqual({
      provider: "azure",
      requireZdr: true,
    });
    expect(() => reviewProviderRouteFromEnv(
      "openai/gpt-5.6-luna",
      "openai",
      "true",
    )).toThrow("requires REVIEW_PROVIDER=azure");
    expect(() => reviewProviderRouteFromEnv(
      "openai/gpt-5.6-luna",
      "not a slug",
      "false",
    )).toThrow("REVIEW_PROVIDER contains an invalid OpenRouter provider slug");
    expect(() => reviewProviderRouteFromEnv(
      "openai/gpt-5.6-luna",
      "openai",
      "sometimes",
    )).toThrow("REVIEW_REQUIRE_ZDR must be true or false");
  });

  it("rejects a direct Luna ZDR agent route unless Azure is the sole provider", () => {
    expect(() => new ReviewAgent({
      apiKey: API_KEY,
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "max",
      repository: "owner/repo",
      provider: "openai",
      requireZdr: true,
    })).toThrow("requires REVIEW_PROVIDER=azure");
  });

  it("uses a temperature-free max-token contract for generic alternate models", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const modelFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response({ choices: [{ message: { content: '{"summary":"clean","findings":[]}' } }] });
    });
    const terra = new ReviewAgent({
      apiKey: API_KEY,
      model: "openai/gpt-5.6-terra",
      reasoningEffort: "high",
      repository: "owner/repo",
      modelFetch,
    });

    await terra.run("review", { invoke: vi.fn() }, "discovery");

    expect(bodies[0]).toMatchObject({
      model: "openai/gpt-5.6-terra",
      max_tokens: 32_000,
      reasoning: { effort: "high" },
      provider: {
        allow_fallbacks: true,
        require_parameters: true,
        data_collection: "deny",
      },
    });
    expect(bodies[0]!.max_completion_tokens).toBeUndefined();
    expect(bodies[0]!.provider).not.toHaveProperty("zdr");
    expect(bodies[0]!.temperature).toBeUndefined();
  });

  it("can request JSON object mode for providers without JSON Schema support", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const modelFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response({ choices: [{ message: { content: '{"summary":"clean","findings":[]}' } }] });
    });
    const agent = new ReviewAgent({
      apiKey: API_KEY,
      model: "deepseek/deepseek-v4-pro-0813",
      reasoningEffort: "xhigh",
      repository: "owner/repo",
      provider: "deepseek",
      structuredOutputMode: "json_object",
      allowDataCollection: true,
      modelFetch,
    });

    await agent.runDirectReview("review");

    expect(bodies[0]).toMatchObject({
      model: "deepseek/deepseek-v4-pro-0813",
      reasoning: { effort: "xhigh" },
      response_format: { type: "json_object" },
      provider: { only: ["deepseek"], require_parameters: true, data_collection: "allow" },
    });
  });

  it("rejects contradictory ZDR and data-collection options", () => {
    expect(() => new ReviewAgent({
      apiKey: API_KEY,
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "max",
      repository: "owner/repo",
      provider: "azure",
      requireZdr: true,
      allowDataCollection: true,
    })).toThrow("allowDataCollection cannot be enabled when requireZdr is true");
  });

  it("defaults GPT-5.6 Luna to OpenAI's non-ZDR max-token route", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const modelFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response({ choices: [{ message: { content: '{"summary":"clean","findings":[]}' } }] });
    });
    const luna = new ReviewAgent({
      apiKey: API_KEY,
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "high",
      repository: "owner/repo",
      modelFetch,
    });

    await luna.run("review", { invoke: vi.fn() }, "discovery");

    expect(bodies[0]).toMatchObject({
      model: "openai/gpt-5.6-luna",
      max_tokens: 32_000,
      reasoning: { effort: "high" },
      provider: {
        only: ["openai"],
        require_parameters: true,
        data_collection: "deny",
      },
    });
    expect(bodies[0]!.max_completion_tokens).toBeUndefined();
    expect(bodies[0]!.provider).not.toHaveProperty("zdr");
    expect(bodies[0]!.temperature).toBeUndefined();
  });

  it("preserves Luna's OpenAI max-token and non-ZDR profile across a retry", async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown>> = [];
    const modelFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? response({ provider: "OpenAI", choices: [{ message: { content: null } }] })
        : response({ choices: [{ message: { content: '{"summary":"recovered","findings":[]}' } }] });
    });
    const review = new ReviewAgent({
      apiKey: API_KEY,
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "high",
      repository: "owner/repo",
      modelFetch,
    }).run("review", { invoke: vi.fn() }, "discovery");
    const assertion = expect(review).resolves.toEqual({ summary: "recovered", findings: [] });
    await vi.runAllTimersAsync();
    await assertion;

    expect(bodies.map((body) => body.max_tokens)).toEqual([32_000, 32_000]);
    expect(bodies.every((body) => body.max_completion_tokens === undefined)).toBe(true);
    expect(bodies.map((body) => body.provider)).toEqual(Array(2).fill({
      allow_fallbacks: true,
      require_parameters: true,
      data_collection: "deny",
      only: ["openai"],
    }));
  });

  it("keeps Azure's completion-token and ZDR policy when retrying a true length exhaustion", async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown>> = [];
    const modelFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? response({
            provider: "Microsoft Azure",
            choices: [{ finish_reason: "length", message: { content: null } }],
          })
        : response({ choices: [{ message: { content: '{"summary":"recovered","findings":[]}' } }] });
    });
    const review = new ReviewAgent({
      apiKey: API_KEY,
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "high",
      repository: "owner/repo",
      provider: "azure",
      requireZdr: true,
      maxOutputTokensPerRequest: 64_000,
      modelFetch,
    }).run("review", { invoke: vi.fn() }, "discovery");
    const assertion = expect(review).resolves.toEqual({ summary: "recovered", findings: [] });
    await vi.runAllTimersAsync();
    await assertion;

    expect(bodies.map((body) => body.max_completion_tokens)).toEqual([32_000, 64_000]);
    expect(bodies.every((body) => body.max_tokens === undefined)).toBe(true);
    expect(bodies.every((body) => body.temperature === undefined)).toBe(true);
    expect(bodies.map((body) => body.provider)).toEqual(Array(2).fill({
      allow_fallbacks: true,
      require_parameters: true,
      data_collection: "deny",
      zdr: true,
      only: ["azure"],
    }));
    expect(bodies.every((body) => !Object.hasOwn(body.provider as object, "ignore"))).toBe(true);
  });

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

  it.each([400, 401, 403])(
    "does not retry or relax routing after an empty non-retryable HTTP %i",
    async (status) => {
      const bodies: Array<Record<string, unknown>> = [];
      const modelFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(null, { status });
      });

      await expect(agent(modelFetch).run("review", { invoke: vi.fn() }, "discovery"))
        .rejects.toThrow(`invalid JSON (${status})`);

      expect(bodies).toHaveLength(1);
      expect(bodies.every((body) => (
        body.provider as Record<string, unknown>
      ).require_parameters === true)).toBe(true);
    },
  );

  it.each([429, 500, 503])(
    "retains strict parameter routing while retrying an empty HTTP %i",
    async (status) => {
      vi.useFakeTimers();
      const bodies: Array<Record<string, unknown>> = [];
      const modelFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return bodies.length === 1
          ? new Response(null, { status })
          : response({ choices: [{ message: { content: '{"summary":"retried","findings":[]}' } }] });
      });
      const review = agent(modelFetch).run("review", { invoke: vi.fn() }, "discovery");
      const assertion = expect(review).resolves.toEqual({ summary: "retried", findings: [] });
      await vi.runAllTimersAsync();
      await assertion;

      expect(bodies).toHaveLength(2);
      expect(bodies.every((body) => (
        body.provider as Record<string, unknown>
      ).require_parameters === true)).toBe(true);
    },
  );

  it("retries the same endpoint when a pinned provider returns an empty completion", async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown>> = [];
    const modelFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? response({ provider: "DigitalOcean", choices: [{ message: { content: null } }] })
        : response({ provider: "DigitalOcean", choices: [{ message: { content: '{"summary":"retried","findings":[]}' } }] });
    });
    const review = new ReviewAgent({
      apiKey: API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
      providerOnly: ["digitalocean"],
      modelFetch,
    }).run("review", { invoke: vi.fn() }, "discovery");
    const assertion = expect(review).resolves.toEqual({ summary: "retried", findings: [] });
    await vi.runAllTimersAsync();
    await assertion;

    expect(bodies[1]!.provider).toMatchObject({ only: ["digitalocean"] });
    expect((bodies[1]!.provider as Record<string, unknown>).ignore).toBeUndefined();
  });

  it("excludes one failed provider when an experiment permits another", async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown>> = [];
    const modelFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? response({ provider: "DigitalOcean", choices: [{ message: { content: null } }] })
        : response({ provider: "DeepInfra", choices: [{ message: { content: '{"summary":"fallback","findings":[]}' } }] });
    });
    const review = new ReviewAgent({
      apiKey: API_KEY,
      model: "deepseek/deepseek-v4-flash-0731",
      reasoningEffort: "high",
      repository: "owner/repo",
      providerOnly: ["digitalocean", "deepinfra"],
      modelFetch,
    }).run("review", { invoke: vi.fn() }, "discovery");
    const assertion = expect(review).resolves.toEqual({ summary: "fallback", findings: [] });
    await vi.runAllTimersAsync();
    await assertion;

    expect(bodies[1]!.provider).toMatchObject({
      only: ["digitalocean", "deepinfra"],
      ignore: ["digitalocean"],
    });
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
