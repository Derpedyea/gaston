# Exhaustive research: a bounded DeepSeek harness for Gaston

Research completed 2026-08-11. This report was prompted by failed and slow
reviews observed in a private production repository. Repository-specific
identifiers and timing details have been removed from this public-safe report.
It combines private check-run evidence with 15 web/developer searches and
source inspection of OpenCode's stale `2.0` exploration, actively developed
`v2` branch, current agent core, and the
complete `v1.18.16` release harness. More than
25 primary or implementation sources were reviewed. Product claims and issue
reports are treated as design evidence, not independent benchmarks.

## Executive summary

A production incident exposed two different systems problems:

1. **Scheduling correctness:** a delayed queue retry for an older commit
   cancelled the current review before the job proved that its SHA was still
   current. The cancelled check then had no replacement.
2. **Harness efficiency:** the old harness launched four discovery agents in
   parallel, allowed each up to 12 turns and 48 tool calls, retried model calls
   three times, and then ran a fifth adjudication agent. A rejected `Promise.all`
   did not stop sibling requests. It therefore had a large theoretical request
   surface and could continue spending after the useful result was already lost.

The OpenCode comparison also found a concrete DeepSeek protocol defect in
Gaston. Gaston preserved `tool_calls` but discarded `reasoning` and
`reasoning_details` before sending tool results. DeepSeek requires its
`reasoning_content` to be returned on subsequent tool-call requests, and
OpenRouter makes the same requirement for normalized reasoning blocks.
[DeepSeek thinking-mode tools](https://api-docs.deepseek.com/guides/thinking_mode/#tool-calls),
[OpenRouter reasoning preservation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning)

The replacement harness is intentionally smaller than an interactive coding
agent:

- one broad, high-reasoning discovery request with at most four parallel reads;
- one two-call recovery turn only for truncated or invalid evidence, followed
  by tool-disabled high-reasoning finalization;
- a verifier only when discovery produced a changed-line candidate;
- at most two provider attempts per logical request;
- shared limits of four minutes, six model requests, approximately 250,000
  input tokens, 48,000 output tokens, and $0.20 reported cost;
- 120-second request timeouts, prompt/tool-output compaction, duplicate-read
  memoization, and a neutral `budget_exhausted` terminal state;
- exact reasoning-block round trips and case-insensitive repair of known tool
  names; and
- structured progress and resource-use data in both Worker logs and the check.

This changes the governing principle from “keep exploring while evidence is
novel” to “buy one evidence batch, then prove or discard.” That is the right
shape for an automatic PR gate whose dominant risk is false-positive noise and
unbounded spend, not an interactive agent expected to implement an entire task.

## What happened in production

The check-run sequence established three failure modes without requiring any
repository content in this research artifact: provider attempts exceeded their
useful time budget, a deployment interrupted an in-flight Durable Object, and a
delayed queue delivery for an older head cancelled current work without a
replacement. Exact repository, commit, check, timing, and usage identifiers are
kept only in private operational records.

The scheduling fix moved cancellation behind a fresh GitHub current-head
check. An old or retried queue message can now finish only its own stale check;
it cannot interrupt a confirmed newer head. Every accepted head also gets a
queued check immediately, making “cancelled with no rerun” visible and
diagnosable. Queue retries also recover work interrupted by a deployment.

## OpenCode V2 source comparison

OpenCode's actively developed next-generation branch is
[`v2`](https://github.com/anomalyco/opencode/tree/v2); the similarly named
[`2.0`](https://github.com/anomalyco/opencode/tree/2.0) branch is an older
exploration. The comparison used source rather than tutorial claims, including
the v2 per-key run coordinator and its wake/interrupt/idle semantics.

## Academic harness follow-up and implemented controls

The follow-up compared Gaston with Harness-Bench, the controlled Qwen Code
harness-evolution study, Budget-Aware Tool-Use, SWE-Effi, SWE-agent, Agentless,
and the tool-environment unreliability benchmark. Their shared operational
lesson is that more context and turns are not a quality strategy: harness
changes need non-functional regression gates, explicit budgets, concise tool
diagnostics, and a distinct incomplete-evidence outcome.

Gaston now implements those controls:

- a private offline structural corpus that retains cumulative multi-commit head
  transitions without publishing repository metadata, plus a deterministic
  synthetic model/tool replay suite;
- deployment gates for finding precision/recall and p95 model requests, tool
  calls, and reported cost;
- typed evidence outcomes, a coverage ledger, and neutral completion when
  unavailable evidence prevents a clean assertion;
- one conditional recovery turn for truncation or invalid arguments, including
  conservative closure-only repair of structurally truncated JSON;
- a durable latest-request-wins generation and phase record, with process-local
  cancellation used only as an optimization;
- explicit remaining-budget instructions for the model;
- provider conformance fixtures for DeepSeek reasoning, cache accounting,
  malformed tool calls, embedded errors, empty completions, and fallback; and
- bounded SHA-keyed repository caches plus provider and repository cache-hit
  telemetry.

[Harness-Bench](https://arxiv.org/abs/2605.27922),
[harness evolution study](https://arxiv.org/abs/2607.03691),
[Budget-Aware Tool-Use](https://arxiv.org/abs/2511.17006),
[tool-environment unreliability](https://arxiv.org/abs/2606.25819),
[SWE-Effi](https://arxiv.org/abs/2509.09853),
[SWE-agent](https://arxiv.org/abs/2405.15793),
[Agentless](https://arxiv.org/abs/2407.01489)

### Patterns worth adopting

**Preserve provider state across tool calls.** OpenCode transforms stored
reasoning into a provider's interleaved field and remaps provider metadata
instead of reconstructing a lossy assistant message.
[V2 provider transform](https://github.com/anomalyco/opencode/blob/2.0/packages/opencode/src/provider/transform.ts),
[current message projection](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/to-llm-message.ts)

Gaston now carries an unmodified `reasoning_details` array when present, or the
normalized reasoning string otherwise. The `v1.18.16` adapter also showed that
empty reasoning is protocol state, not absent state: Gaston preserves an empty
string/array and injects an empty reasoning field for DeepSeek tool turns when
a provider omitted both forms. This is the single most important DeepSeek
compatibility fix.
[OpenCode v1.18.16 provider transform](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/provider/transform.ts)

**Repair recoverable tool-call errors.** OpenCode lowercases a mismatched tool
name when that identifies a real tool; otherwise it turns the bad request into
an `invalid` tool result so the model can recover.
[OpenCode V2 LLM adapter](https://github.com/anomalyco/opencode/blob/2.0/packages/opencode/src/session/llm.ts)

Gaston adopts the safe subset: known tool names are repaired
case-insensitively, while unknown names and malformed arguments become bounded
tool errors rather than exceptions or arbitrary dispatch.

**One cancellation tree.** OpenCode passes one abort signal through the model
stream and tool execution. Gaston now combines superseding-head cancellation,
the aggregate wall-clock timer, and a per-request timeout. That signal reaches
OpenRouter, retry sleeps, GitHub tree/search/file HTTP calls, and result
acceptance. A newer commit therefore stops both inference and evidence fetches.

**Compact evidence, not instructions.** OpenCode protects recent turns and
important tools while pruning old tool output, then creates a summary only
when context overflow requires it.
[V2 compaction](https://github.com/anomalyco/opencode/blob/2.0/packages/opencode/src/session/compaction.ts),
[current bounded compaction](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts)

Gaston has a much shorter task, so it does not spend another model call on a
summary. Initial and verification prompts are each capped at 72 KB, each
repository result at 12 KB, and carried messages at 120 KB. Truncation retains
both the beginning and end with a visible marker and a narrower-query hint;
compaction shrinks earlier evidence previews instead of silently slicing or
erasing the whole result.
[OpenCode v1.18.16 tool truncation](https://github.com/anomalyco/opencode/blob/v1.18.16/packages/opencode/src/tool/truncate.ts)

**Make the last step explicit.** OpenCode disables tools at the configured step
limit and injects a clear “respond with text only” instruction instead of
abruptly killing the model.
[OpenCode max-step prompt](https://github.com/anomalyco/opencode/blob/2.0/packages/opencode/src/session/prompt/max-steps.txt),
[current max-step implementation](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/max-steps.ts)

Gaston similarly follows its one evidence batch with a tool-disabled,
strict-JSON finalization request. Every turn stays at high reasoning. Requests
start with 8,000 output tokens; an empty `length` response retries once with
16,000 rather than lowering effort. The shared budget warns the harness to wrap
up while two model-request slots remain.

**Keep retries above the provider adapter.** OpenCode sets inner SDK retries to
zero and owns retry classification and backoff at the session layer.
[V2 retry policy](https://github.com/anomalyco/opencode/blob/2.0/packages/opencode/src/session/retry.ts)

Gaston likewise owns two explicit attempts, honors `Retry-After`, excludes a
provider that returned an embedded completion error, and accounts each attempt
against the same review budget. Usage returned with failed HTTP or embedded
provider attempts is now charged to the ledger instead of disappearing from
diagnostics.

**Make asynchronous retries recoverable and terminally visible.** Cloudflare
Queues starts `Message.attempts` at one and retries a failed delivery three
times by default. Gaston keeps the original GitHub check in progress during
the first three transient attempts, retries after 5/15/45 seconds, fails the
check on the final attempt, and routes the message to `gaston-reviews-dlq`
instead of deleting it. Queue logs include the attempt number.
[Cloudflare queue retries](https://developers.cloudflare.com/queues/configuration/batching-retries/),
[Cloudflare dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)

**Generate runtime and binding types from deployment configuration.** Wrangler
now generates `worker-configuration.d.ts` before TypeScript and unit tests.
The hand-written binding/config interface was
removed, leaving only secret names that cannot appear in `wrangler.jsonc`.
[Cloudflare generated Worker types](https://developers.cloudflare.com/workers/languages/typescript/#generate-types)

### Patterns not copied

OpenCode is an interactive coding environment. Its session can legitimately
continue for many steps, execute tools, accept a new user message, compact, and
resume. Gaston is a non-interactive reviewer. Copying that open-ended loop would
recreate the incident.

The current OpenCode core also contains explicit TODOs to bound provider retries
and repeated identical tool calls. It is an excellent provider-normalization
reference, not proof that every control in its evolving V2 runtime is already
bounded.
[current runner source](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/llm.ts)

## Cross-harness findings

### Hard budgets need several dimensions

A turn cap alone is insufficient. One turn can contain an oversized prompt,
many parallel tools, a long reasoning completion, or multiple provider
attempts. SWE-Effi measures effectiveness against tokens and time and documents
“token snowball” failures where unsuccessful tasks consume far more resources.
[SWE-Effi](https://arxiv.org/html/2509.09853v2)

Google's budget-aware agent exposes remaining budget during planning and shows
that budget conditioning and context compression change behavior.
[Budget-Aware Tool-Use](https://github.com/google-research/budget-aware-agent)

Gaston therefore enforces wall time, request count, estimated input, reported
output, and reported cost independently. Every provider attempt consumes a
request and estimated-input reservation. Reported usage can stop the next
request even when byte-based estimation was optimistic.

### The model should see an approaching limit

OpenHands users observed that a hidden maximum-iteration cutoff wastes the last
turn and produces no usable final answer; the proposal recommends warnings, a
final chance, and a distinct exhausted state.
[OpenHands budget visibility proposal](https://github.com/OpenHands/software-agent-sdk/issues/2406)

Gaston reserves finalization capacity and tells the model why tools are gone.
If the aggregate limit is nevertheless exhausted, the GitHub check ends
neutral with resource use instead of failing, hanging, or publishing partial
claims.

### Simplicity is a control, not just an aesthetic

Anthropic recommends starting with the simplest solution and adding agentic
complexity only when it demonstrably improves outcomes; it also highlights the
latency/cost tradeoff and explicit stopping conditions.
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

Its tool-design guidance recommends clear, high-signal interfaces designed for
the model's context rather than thin exposure of every backend capability.
[Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)

Gaston exposes five narrow read-only operations. It does not clone or execute
PR code, offer a shell, or let the model browse arbitrary URLs.

### Retrieval should be selective

Aider's repository map uses graph ranking to fit relevant symbols inside a
small token budget rather than sending the whole tree.
[Aider repository map](https://aider.chat/docs/repomap.html)

Gaston does not yet have symbol ranking, but follows the same shape: changed
file metadata and a bounded diff excerpt are supplied first; exact patches,
base/head slices, tree paths, and literal searches are fetched only when the
model asks. Adding a symbol/call graph remains the best next context upgrade.

### Retry and loop failures must be terminally observable

LangGraph documents a recursion limit as a graph-step safeguard and warns that
an unexpected cycle often indicates a real logic error rather than a need to
raise the limit.
[LangGraph recursion limit](https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT)

OpenHands has also reported condensation loops and early max-iteration exits.
[condensation loop](https://github.com/OpenHands/software-agent-sdk/issues/1073),
[maximum iteration exit](https://github.com/All-Hands-AI/OpenHands/issues/10571)

Gaston records `completed`, `stale`, and `budget_exhausted` as terminal durable
outcomes. A stale outcome is never reused as a completed analysis, while a
budget-exhausted automatic job will not be replayed endlessly by the queue.

### Usage and traces belong in the product surface

The OpenAI Agents SDK aggregates requests, input/output, cached, and reasoning
tokens per run and per request.
[OpenAI Agents SDK usage](https://openai.github.io/openai-agents-python/usage/)

OpenTelemetry's GenAI conventions model the hierarchy from agent invocation to
model chat and tool execution, with model and token attributes while warning
against capturing sensitive prompts by default.
[OpenTelemetry GenAI overview](https://opentelemetry.io/blog/2026/genai-observability/),
[GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)

Cloudflare Workers Logs indexes fields from logged objects and its query
builder can filter on those structured fields.
[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
[Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/)

Gaston now logs objects rather than JSON strings. Logs contain repository/PR,
delivery, head SHA, phase, request/message/tool bytes, duration, provider,
finish reason, request and aggregate token usage, cached/reasoning tokens,
reported cost, retry decisions, and budget state. Prompts, source content,
arguments, responses, and secrets are not logged.

### PR UX should expose automatic and manual control

CodeRabbit automatically reviews new commits and distinguishes incremental
review from a manual full review.
[CodeRabbit commands](https://docs.coderabbit.ai/guides/commands),
[review command reference](https://docs.coderabbit.ai/reference/review-commands)

GitHub Copilot exposes lighter and balanced review effort, explicitly trading
more context and reasoning for more premium requests.
[Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review)

Gaston automatically supersedes old heads and always reviews the cumulative
base-to-current-head change. Trusted owners, members, and collaborators can
request a fresh uncached run with an exact-line `@gaston` or `@gaston review`
comment. Manual review requires the existing GitHub App to have Issues read
permission and the Issue comment event.

## Resulting architecture

```text
GitHub webhook
  -> verify signature and hydrate current base/head
  -> create queued check
  -> per-PR Durable Object validates current head
  -> only a confirmed newer head aborts older work
  -> fetch cumulative PR change and trusted base policy
  -> high-reasoning discovery: <= 1 tool turn, <= 4 reads
  -> tool-disabled strict-JSON finalization
  -> if candidates exist: independent bounded verification
  -> deterministic changed-line/confidence/dedup filters
  -> revalidate current head
  -> publish and complete check with aggregate resource use
```

The default aggregate limits are configuration, not promises of consumption.
A clean review normally skips verification and should use two model requests.
A review with candidates normally uses four. The two remaining slots cover a
single retry or strict-JSON repair without allowing both phases to expand
indefinitely.

## Contrarian views and remaining risks

- **One discovery batch can miss deep bugs.** This is an intentional recall
  tradeoff until an evaluation corpus proves that extra passes earn their cost
  and inspection burden.
- **A same-model verifier has correlated blind spots.** A small cross-model
  critic may improve precision, but it must be tested at equal cost.
- **Prompt caching can reduce billing but not semantic risk.** Sticky sessions
  and cached prefixes do not substitute for request, output, cost, and wall
  limits. OpenRouter usage remains the billing source of truth.
  [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- **Provider fallback changes behavior.** Gaston keeps the exact model fixed
  but may change providers for availability. Provider name, returned model,
  finish reason, and generation ID are logged for comparison.
- **A four-minute abort may interrupt a useful near-complete answer.** The
  per-request limit and early wrap-up reduce that risk; a neutral budget result
  is preferable to an 11–15 minute invisible review.
- **Structured logs are sensitive metadata.** Repository content remains
  excluded, and prompts/tool results should stay opt-in if distributed tracing
  is added later.
- **Manual commands expand webhook scope.** Exact-line parsing and trusted
  associations prevent arbitrary comment text and untrusted contributors from
  spending model budget.

## Open questions

1. On a labeled PR corpus, what recall is lost by one discovery batch versus
   two, and what is the token/time cost per additional accepted finding?
2. Should large or high-risk diffs receive a second discovery lens under a
   separately visible budget?
3. Does DeepSeek V4 Flash perform better with native strict tool mode through a
   direct provider than through OpenRouter's normalized schema?
4. Which four repository reads are selected most often, and would a small
   symbol-ranked repository map replace one or more of them?
5. What cost threshold should be repository-specific rather than global?
6. Can cancelled HTTP generations always be confirmed as unbilled across every
   OpenRouter provider, or should cancellation remain conservatively accounted
   as a full reservation?
7. Does a cross-provider fallback materially change finding precision?

## Source inventory

Primary implementation and API sources:

1. [OpenCode `2.0` branch](https://github.com/anomalyco/opencode/tree/2.0)
2. [OpenCode V2 LLM adapter](https://github.com/anomalyco/opencode/blob/2.0/packages/opencode/src/session/llm.ts)
3. [OpenCode V2 provider transform](https://github.com/anomalyco/opencode/blob/2.0/packages/opencode/src/provider/transform.ts)
4. [OpenCode V2 processor](https://github.com/anomalyco/opencode/blob/2.0/packages/opencode/src/session/processor.ts)
5. [OpenCode V2 retry policy](https://github.com/anomalyco/opencode/blob/2.0/packages/opencode/src/session/retry.ts)
6. [OpenCode V2 compaction](https://github.com/anomalyco/opencode/blob/2.0/packages/opencode/src/session/compaction.ts)
7. [OpenCode current runner](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/llm.ts)
8. [OpenCode current compaction](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/compaction.ts)
9. [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
10. [DeepSeek tool calls](https://api-docs.deepseek.com/guides/tool_calls/)
11. [DeepSeek chat completions](https://api-docs.deepseek.com/api/create-chat-completion/)
12. [DeepSeek OpenCode integration](https://api-docs.deepseek.com/quick_start/agent_integrations/opencode/)
13. [OpenRouter reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
14. [OpenRouter usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
15. [OpenAI Agents SDK usage](https://openai.github.io/openai-agents-python/usage/)
16. [LangGraph recursion limit](https://docs.langchain.com/oss/python/langgraph/errors/GRAPH_RECURSION_LIMIT)
17. [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)
18. [Anthropic: Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)
19. [Google Budget-Aware Tool-Use](https://github.com/google-research/budget-aware-agent)
20. [Aider repository map](https://aider.chat/docs/repomap.html)
21. [OpenTelemetry GenAI observability](https://opentelemetry.io/blog/2026/genai-observability/)
22. [OpenTelemetry GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
23. [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
24. [Cloudflare Query Builder](https://developers.cloudflare.com/workers/observability/query-builder/)
25. [CodeRabbit commands](https://docs.coderabbit.ai/guides/commands)
26. [CodeRabbit review commands](https://docs.coderabbit.ai/reference/review-commands)
27. [GitHub Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review)

Research and incident evidence:

28. [SWE-Effi](https://arxiv.org/html/2509.09853v2)
29. [OpenHands budget visibility](https://github.com/OpenHands/software-agent-sdk/issues/2406)
30. [OpenHands condensation loop](https://github.com/OpenHands/software-agent-sdk/issues/1073)
31. [OpenHands maximum-iteration exit](https://github.com/All-Hands-AI/OpenHands/issues/10571)
32. [OpenCode DeepSeek loop issue](https://github.com/anomalyco/opencode/issues/22329)
33. [OpenCode interleaved-reasoning issue](https://github.com/anomalyco/opencode/issues/35689)
34. Private production incident record (not published)

## Rerun inputs

```yaml
workflow: firecrawl-deep-research
depth: exhaustive
queries: 15
focus:
  - PR-review agent budget and cancellation controls
  - OpenCode V2 DeepSeek message normalization and tool loop
  - retries, compaction, observability, and manual review UX
output: markdown
```
