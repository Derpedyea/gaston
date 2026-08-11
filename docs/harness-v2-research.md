# Deep research: current AI harnesses, DeepSeek, and Gaston's review loop

Research completed 2026-08-11. This is the current-generation follow-up to
[`harness-research.md`](harness-research.md). It prioritizes OpenCode's active
V2 beta and sources updated or merged in July–August 2026. Stale branches and
older releases are used only where they explain a regression.

The two-pass collection used more than 30 Firecrawl web/developer queries,
direct scrapes of the current OpenCode V2, OpenRouter, and DeepSeek
documentation, and more than 30
primary implementation, issue, and merged-PR sources. The second pass added
current Cloudflare Queue/Durable Object contracts and focused on durable retry
budgets, quality routing, and long-generation timing. Product issue reports
are evidence of failure modes, not independent benchmarks.

## Executive summary

Gaston's 8,000-token completion ceiling was entirely self-imposed. The current
OpenRouter catalog advertises a one-million-token context for
`deepseek/deepseek-v4-flash-0731`; its live endpoints currently report completion
capacities from 131,072 to at least 384,000 tokens, with some endpoints exposing
the full context window. An 8,000-token high-reasoning request can spend the
whole allowance on reasoning and return no JSON or tool call. The old retry to
16,000 helped only after paying for a failed request.
[OpenRouter model page](https://openrouter.ai/deepseek/deepseek-v4-flash-0731),
[live endpoint metadata](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash-0731/endpoints)

OpenCode V2 encountered the same class of harness bug at 32,000 tokens. Its
current fix separates a model's catalog capability from a request policy and
leaves `maxOutputTokens` unset unless generation policy explicitly sets it.
Its July V2 retry work also centralizes typed provider failure classification,
retries only before observable output, and refuses to replay partial output.
[OpenCode V2 output-limit fix](https://github.com/anomalyco/opencode/pull/40488),
[OpenCode V2 retry-classification fix](https://github.com/anomalyco/opencode/pull/36887)

Gaston adopts those separations with one deliberate difference. It is an
unattended, budgeted PR gate rather than an interactive session, so it retains
an explicit request policy: a configurable 64,000-token ceiling, a 32,000-token
first attempt, and a 128,000-token aggregate output budget. A production PR 39
trace also showed that the former four-minute wall—not cost or aggregate
tokens—stopped the review after four requests and 13,701 output tokens. At the
current model's observed provider throughput, that output alone can occupy most
or all of four minutes. The first pass raised the walls to ten and four
minutes; the second pass found that a healthy 32,000-token request could still
outlive four minutes. Cloudflare caps Queue consumers at fifteen minutes, so
the current active-work wall is fourteen minutes and one provider attempt can
use eleven minutes, retaining one minute for platform overhead. Provider
attempts increase from two to three; transient retries use bounded jitter, honor
`Retry-After`, exclude a failed endpoint when its identity is known, and remain
abortable. The queue now retries only errors explicitly classified as transient
instead of calling every unknown invariant failure a dependency outage.

The second pass also fixed retry amplification. A queue redelivery previously
created a fresh `ReviewBudget`, so each delivery received a new request, token,
cost, and time allowance. The Durable Object now persists usage after each
reservation and reported response, resumes cumulative spend on redelivery, and
excludes queue backoff from active work. The default model also uses
OpenRouter's `:exacto` tool-quality route; the explicit throughput sort that
overrode Exacto was removed.
[OpenCode durable usage](https://github.com/anomalyco/opencode/pull/37441),
[SWE-agent retry budget](https://swe-agent.com/latest/reference/agent/),
[OpenRouter Exacto](https://openrouter.ai/docs/guides/routing/model-variants/exacto),
[Cloudflare Queue limits](https://developers.cloudflare.com/queues/platform/limits/)

## Key findings

1. **Model capability, request allowance, and aggregate budget are different
   values.** OpenCode V2's merged fix explicitly stopped projecting catalog
   capability into every request. Goose exposes a model-specific default plus
   `GOOSE_MAX_TOKENS`; Continue exposes `contextLength` separately from
   `maxTokens`; Aider treats metadata as reporting and lets the provider enforce
   the actual limit. Gaston now names and tests all three layers independently.
   [OpenCode PR](https://github.com/anomalyco/opencode/pull/40488),
   [Goose configuration](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/environment-variables.md),
   [Continue configuration](https://github.com/continuedev/continue/blob/main/docs/reference.mdx),
   [Aider model metadata](https://aider.chat/docs/config/adv-model-settings.html)

2. **DeepSeek reasoning is part of the completion allowance and part of the
   tool protocol.** DeepSeek requires `reasoning_content` to be returned after a
   tool call, including across subsequent interactions; omitting it causes a
   400. Gaston already preserves reasoning state and meaningful empty state.
   The larger request allowance prevents high reasoning from consuming all
   space before the model emits a tool call or final JSON.
   [DeepSeek thinking-mode tool calls](https://api-docs.deepseek.com/guides/thinking_mode/#tool-calls)

3. **Retries belong at one intentional boundary.** OpenCode V2 keeps its native
   LLM package single-attempt and owns retry policy in the session integration.
   A Cline retry-middleware proposal was closed because the underlying AI SDK
   already retried, which would multiply attempts. Gaston calls `fetch`
   directly, so its request loop is the one owner; the queue is a coarser
   execution-recovery layer, not a second invisible SDK retry loop.
   [OpenCode V2 retry tracking](https://github.com/anomalyco/opencode/issues/35002),
   [Cline layering discussion](https://github.com/cline/cline/pull/10963)

4. **Retry eligibility must be typed and replay-safe.** OpenCode V2 merged
   centralized classification and preserves pre-output retries while blocking
   replay after observable output. Goose's current fix similarly retries a
   transient first stream item, but not failures after useful content, and its
   review caught the risk of treating permanent first-frame 4xx responses as
   transient. Gaston's non-streaming calls are safe to replay before a complete
   response because repository tools have not executed yet.
   [OpenCode V2 classification](https://github.com/anomalyco/opencode/pull/36887),
   [Goose first-item retry](https://github.com/aaif-goose/goose/pull/10968)

5. **Provider fallback is necessary but not sufficient.** OpenRouter can route
   around a failing endpoint before output, and the current DeepSeek model has
   many providers, but routing filters can reduce that pool. Setting
   `require_parameters: true` excludes endpoints that do not support every
   requested feature. Gaston retains it because tool calling and strict review
   JSON are correctness requirements, then explicitly excludes a provider that
   returns a typed embedded or top-level availability error.
   [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection),
   [DeepSeek V4 Flash providers](https://openrouter.ai/deepseek/deepseek-v4-flash-0731)

6. **Retry timing should combine provider advice, backoff, jitter, cancellation,
   and a total budget.** OpenRouter documents `Retry-After` on 429/503 responses.
   OpenHands exposes exponential retry controls and currently documents far more
   attempts than Gaston can afford. Cline's proposal used jitter and abort-aware
   waits. SWE-agent's high retry defaults have produced reports of repeated
   billing and runaway reasoning usage, illustrating why attempt count alone is
   not a sufficient safety control.
   [OpenRouter errors](https://openrouter.ai/docs/api_reference/errors-and-debugging),
   [OpenHands LLM settings](https://docs.openhands.dev/openhands/usage/environment-variables),
   [SWE-agent retry-cost report](https://github.com/SWE-agent/SWE-agent/issues/1492)

7. **Unknown errors should not be presented as transient dependencies.** The
   former queue classifier returned `true` when no recognized status existed.
   Invalid model JSON, parser invariants, and programming errors could therefore
   be requeued and reported to operators as dependency failures. Current
   OpenRouter responses expose stable `error_type` categories; Gaston now honors
   explicit `retryable` metadata, known statuses, and transport `TypeError`, and
   treats an unclassified invariant as permanent.
   [OpenRouter typed errors](https://openrouter.ai/docs/api_reference/errors-and-debugging#typed-error-codes)

8. **Capability overrides need regression tests at the serialized request
   boundary.** Continue and Goose both have current reports where correct model
   metadata is later overwritten or ignored. OpenCode V2 fixed its equivalent
   bug with a test on the actual AI SDK request. Gaston's regression asserts the
   serialized `max_tokens`, not merely the configuration object.
   [OpenCode request-boundary test](https://github.com/anomalyco/opencode/pull/40488),
   [Goose precedence issue](https://github.com/aaif-goose/goose/issues/10032),
   [Continue config propagation fix](https://github.com/continuedev/continue/pull/4602)

9. **A retry budget must survive the retry mechanism itself.** OpenCode V2
   persists usage as a durable event because replay must not lose or duplicate
   cost. Pi's durable harness design likewise states that attempt counts never
   reset after restore. Gaston now persists the reservation before dispatch and
   reported usage after response, then restores both on queue redelivery.
   [OpenCode durable usage](https://github.com/anomalyco/opencode/pull/37441),
   [Pi durable harness](https://github.com/earendil-works/pi/blob/main/packages/agent/docs/harness-v2.md)

10. **Retries should consume one remaining total allowance.** SWE-agent's retry
    agent gives the next attempt only the unspent portion of the total cost
    budget. OpenHands has a current bug report where cost tracking stops after
    session resume—the exact failure class a durable ledger must test. Gaston's
    request, token, cost, and active-elapsed counters are now cumulative across
    provider and queue attempts.
    [SWE-agent retry agent](https://swe-agent.com/latest/reference/agent/),
    [OpenHands resume-cost bug](https://github.com/openhands/openhands/issues/13843)

11. **Tool quality and throughput are different routing objectives.** Exacto
    ranks endpoints using tool-call reliability, benchmark evidence, and
    performance signals. An explicit provider sort takes precedence over it.
    Gaston's prior throughput sort therefore selected the wrong objective for
    code review; the default is now
    `deepseek/deepseek-v4-flash-0731:exacto` with parameter compatibility still
    required.
    [Exacto](https://openrouter.ai/docs/guides/routing/model-variants/exacto),
    [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)

12. **The completion allowance and timeout must describe compatible work.** A
    32,000-token allowance paired with a four-minute absolute timeout can make
    valid slow generations impossible. Gaston's safe near-term correction is
    an eleven-minute provider bound inside Cloudflare's fifteen-minute Queue
    limit; streaming with durable partial-output semantics remains separate
    work.
    [OpenRouter streaming](https://openrouter.ai/docs/api-reference/streaming),
    [Cloudflare Queue limits](https://developers.cloudflare.com/queues/platform/limits/),
    [OpenCode interrupted responses](https://github.com/anomalyco/opencode/pull/40576)

## Detailed analysis

### Output-budget geometry

OpenRouter defines both `max_tokens` and `max_completion_tokens` as optional
upper bounds. When an optional parameter is absent, OpenRouter omits it upstream
instead of inserting a hard-coded default. The actual upper bound is also
limited by context minus prompt length.
[OpenRouter parameters](https://openrouter.ai/docs/api_reference/parameters#max-tokens)

OpenCode V2 now follows that provider-native behavior unless a generation
policy supplies a value. That is the best default for an interactive agent,
where a user can interrupt a long response and model selection changes often.
Gaston needs a different safety envelope: it is automatic, non-interactive,
and publishes to GitHub. It therefore sends an explicit cap but no longer
confuses that cap with either model metadata or aggregate spend.

The new defaults are:

| Control | Old | New | Meaning |
| --- | ---: | ---: | --- |
| First request | 8,000 | 32,000 | Normal per-attempt allowance |
| Exhaustion retry | 16,000 | up to 64,000 | Headroom after a true `length` finish |
| Per-request configured ceiling | implicit 16,000 | 64,000 | `REVIEW_MODEL_MAX_OUTPUT_TOKENS` |
| Aggregate reported output | 48,000 | 128,000 | All phases and attempts combined |
| Aggregate provider attempts | 6 | 9 | Discovery, finalization, verification, and retries |
| Active review wall clock | 4 minutes | 14 minutes | Cumulative work across queue redeliveries; backoff excluded |
| Provider attempt timeout | 2 minutes | 11 minutes | One buffered request inside the 15-minute Queue wall |

The configured ceiling is deployment-local and therefore model-local because
Gaston uses one `REVIEW_MODEL` per deployment. It can be lowered for smaller
models. Runtime catalog discovery was intentionally not added: it would add a
new dependency before every review, while endpoint capabilities can differ and
change. A future cached capability resolver should use the OpenRouter endpoints
API and an explicit precedence order: operator override, live catalog,
conservative fallback.

### DeepSeek protocol details

DeepSeek thinking mode ignores sampling controls such as temperature, but
supports effort controls. Its tool-call protocol requires the assistant's
reasoning content to be replayed with tool results. Gaston therefore continues
to omit temperature for DeepSeek, requests high effort, preserves
`reasoning_details` when available, normalizes `reasoning_content`, and injects
meaningful empty reasoning state for tool turns where an adapter omitted it.
[DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)

This is more important than simply raising a token number. A large allowance
does not repair a malformed multi-turn protocol, and a protocol-correct harness
still fails if the reasoning allowance leaves no room for a tool call. Both
properties are covered by provider-conformance tests.

### Transient dependency handling

OpenRouter recommends a simple retry or another active provider for no-content
responses, which can occur during warm-up or scale-up. It also exposes stable
types for rate limit, overload, unavailability, timeout, and server errors.
Gaston recognizes those types in addition to HTTP 408, 429, and 5xx statuses.
[OpenRouter no-content guidance](https://openrouter.ai/docs/api_reference/errors-and-debugging#when-no-content-is-generated)

Each logical request now receives three attempts. Without `Retry-After`, waits
use bounded equal jitter around exponential ceilings: approximately 0.5–1.0s,
then 1.0–2.0s. Provider-supplied delay is honored up to the existing 30-second
cap. Every wait and request shares the review abort tree, so a superseding PR
head or aggregate timeout cancels immediately.

Malformed JSON delivered with HTTP 200 is retried inside the request loop. A
typed availability failure excludes the named provider on the next attempt.
The corrected `X-OpenRouter-Experimental-Metadata: enabled` header also makes
routing strategy, region, endpoint counts, and router attempt visible in
structured logs without logging prompts or repository content.

### Harness comparison

- **OpenCode V2** is the closest normalization and session-policy reference.
  Its active beta is installed with the `next` tag, and its current V2 branch
  separates request generation policy from model metadata while centralizing
  typed retry classification.
  [V2 docs](https://opencode.ai/v2/docs),
  [V2 providers](https://opencode.ai/v2/docs/providers)
- **Goose** uses model-specific output defaults plus an operator override and
  is actively tightening first-output retry semantics. Its open context-limit
  precedence issues are a warning against global defaults silently overriding
  canonical model data.
  [Goose environment variables](https://goose-docs.ai/docs/guides/environment-variables),
  [Goose context-limit issue](https://github.com/aaif-goose/goose/issues/10966)
- **OpenHands** makes the output cap optional (`0` means no limit) and exposes
  many retry/backoff knobs. That is flexible but its default retry surface is
  too large for Gaston's bounded automatic gate.
  [OpenHands variables](https://docs.openhands.dev/openhands/usage/environment-variables),
  [OpenHands LLM guide](https://docs.openhands.dev/openhands/usage/llms/llms)
- **Aider** relies on LiteLLM/model metadata for reporting and lets the provider
  enforce token limits. Its error guidance distinguishes context, output, and
  total-token exhaustion, a useful operator-facing distinction Gaston should
  preserve in logs.
  [Aider model settings](https://aider.chat/docs/config/adv-model-settings.html),
  [Aider token-limit guide](https://aider.chat/docs/troubleshooting/token-limits.html)
- **Continue** explicitly models context and completion limits, but its history
  shows that configuration conversion can silently discard those values. This
  validates request-body assertions over configuration-only unit tests.
  [Continue YAML reference](https://github.com/continuedev/continue/blob/main/docs/reference.mdx)
- **SWE-agent** emphasizes per-instance cost and call limits and documents that
  multi-attempt/chooser setups are expensive. Reports of retries re-billing
  successful prefixes reinforce Gaston's single-result, checkpointed phases.
  [SWE-agent competitive runs](https://swe-agent.com/latest/usage/competitive_runs/),
  [SWE-agent model implementation](https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/agent/models.py)
- **Codex CLI** has bounded request/stream reconnect policies, but current issue
  reports show that fixed reconnect counts can still terminate recoverable
  long-running turns when server retry timing is ignored. Gaston's buffered
  calls favor three local attempts plus durable queue recovery, with one
  cumulative ledger rather than a fresh allowance per delivery.
  [Codex retry-policy request](https://github.com/openai/codex/issues/34053)

## Contrarian views and risks

**Why not omit `max_tokens` like OpenCode V2?** That avoids stale client caps
and is the cleanest compatibility behavior. It also permits a cheap reasoning
model to consume its full provider allowance before Gaston's aggregate ledger
can stop it; usage is known only after the response. The explicit 64k ceiling
is a conscious automatic-gate policy, not model capability metadata.

**Why not use OpenHands-style eight retries?** More attempts can hide a weak
provider, but multiply prompt cost and latency. OpenRouter already performs
provider-level failover before output. Three application attempts plus durable
queue recovery is a stronger total envelope than a large nested retry count.

**Why retry malformed HTTP-200 JSON?** It can indicate a proxy or truncated
dependency response and is safe to replay before tool execution. Repeated
schema-valid but semantically invalid review JSON is different: it is a model
or harness failure and is no longer labeled as a transient dependency.

**Provider exclusion can shrink quality.** Excluding a failed provider may
route to a slower or less accurate endpoint. It applies only within the logical
request after a typed availability failure; future reviews start with the full
pool.

**Static configuration can drift.** Switching `REVIEW_MODEL` without reviewing
`REVIEW_MODEL_MAX_OUTPUT_TOKENS` may send an unsupported request to a smaller
model. The setup documentation now calls out this pairing. A cached model
capability layer remains a useful future enhancement.

**Exacto may be slower or costlier than throughput sorting.** That is a chosen
trade for an unattended reviewer whose primary objective is correct tool use.
Operators can configure another model or variant, but an explicit provider
sort overrides Exacto's quality ordering.

**Eleven minutes is still an absolute timeout.** It is bounded by the Queue
consumer's fifteen-minute platform wall and is not an idle-stream watchdog.
Streaming could distinguish healthy slow output from a stall, but it also
requires durable partial-output and usage semantics before safe replay.

## Open questions

1. Should Gaston cache the OpenRouter endpoint catalog daily and clamp only
   when an operator has not supplied a model-specific ceiling?
2. Do production logs show failures concentrated in one provider, one typed
   error, or strict-JSON finalization? The corrected routing metadata can now
   answer this without prompt logging.
3. Would phase-specific ceilings improve efficiency—for example, 32k for tool
   selection and 64k only for finalization—after enough production usage is
   collected?
4. Should queue-level retry delay honor a dependency's last `Retry-After`
   value, persisted in the checkpoint, rather than the fixed 5/15/45-second
   sequence?
5. If Gaston later streams model output, should partial text become a durable
   continuation boundary like OpenCode V2, or remain buffered and explicitly
   non-retryable after nonzero output or usage?

## Sources

1. [OpenCode V2 documentation](https://opencode.ai/v2/docs) — current beta and workflow entry point.
2. [OpenCode V2 provider documentation](https://opencode.ai/v2/docs/providers) — current provider configuration surface.
3. [OpenCode V2 configuration documentation](https://opencode.ai/v2/docs/config) — current generation/config policy surface.
4. [OpenCode V2 output-limit fix](https://github.com/anomalyco/opencode/pull/40488) — merged removal of implicit output limits.
5. [OpenCode V2 retry classification](https://github.com/anomalyco/opencode/pull/36887) — merged typed pre-output retry policy.
6. [OpenCode V2 retry tracking](https://github.com/anomalyco/opencode/issues/35002) — retry-layer ownership and acceptance criteria.
7. [OpenCode output-cap issue](https://github.com/anomalyco/opencode/issues/29363) — current failure analysis of the former 32k clamp.
8. [OpenRouter DeepSeek V4 Flash page](https://openrouter.ai/deepseek/deepseek-v4-flash-0731) — model context and provider availability.
9. [OpenRouter endpoint metadata](https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash-0731/endpoints) — live per-endpoint context, completion, and parameter support.
10. [OpenRouter parameters](https://openrouter.ai/docs/api_reference/parameters) — optional generation parameter contract.
11. [OpenRouter errors](https://openrouter.ai/docs/api_reference/errors-and-debugging) — typed errors, `Retry-After`, no-content, and stream semantics.
12. [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) — fallback and `require_parameters` behavior.
13. [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/) — reasoning effort and tool-call state contract.
14. [DeepSeek error codes](https://api-docs.deepseek.com/quick_start/error_codes/) — permanent and transient status guidance.
15. [Goose first-item retry](https://github.com/aaif-goose/goose/pull/10968) — merged pre-output transient retry handling.
16. [Goose environment variables](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/environment-variables.md) — model-specific defaults and overrides.
17. [Goose global-limit precedence issue](https://github.com/aaif-goose/goose/issues/10032) — default overriding canonical metadata.
18. [Goose context resolution issue](https://github.com/aaif-goose/goose/issues/10966) — provenance and precedence design gap.
19. [Goose DeepSeek V4 reasoning issue](https://github.com/aaif-goose/goose/issues/10012) — current multi-turn reasoning compatibility evidence.
20. [Cline retry middleware discussion](https://github.com/cline/cline/pull/10963) — abort/jitter design and duplicate-layer rejection.
21. [OpenHands environment variables](https://docs.openhands.dev/openhands/usage/environment-variables) — output and retry controls.
22. [OpenHands LLM guide](https://docs.openhands.dev/openhands/usage/llms/llms) — retry/rate-limit operating guidance.
23. [Aider advanced model settings](https://aider.chat/docs/config/adv-model-settings.html) — metadata precedence and provider enforcement.
24. [Aider token limits](https://aider.chat/docs/troubleshooting/token-limits.html) — context/output diagnostics.
25. [Continue YAML reference](https://github.com/continuedev/continue/blob/main/docs/reference.mdx) — separate context and completion configuration.
26. [Continue config propagation fix](https://github.com/continuedev/continue/pull/4602) — request-path configuration loss.
27. [SWE-agent competitive runs](https://swe-agent.com/latest/usage/competitive_runs/) — attempts, cost, and turn controls.
28. [SWE-agent model implementation](https://github.com/SWE-agent/SWE-agent/blob/main/sweagent/agent/models.py) — provider and retry implementation.
29. [SWE-agent repeated-billing issue](https://github.com/SWE-agent/SWE-agent/issues/1492) — retry amplification risk.
30. [Codex configurable retry request](https://github.com/openai/codex/issues/34053) — fixed reconnect budget limitations.
31. [OpenAI Agents model retries](https://openai.github.io/openai-agents-js/guides/models/) — normalized retry context and opt-in runtime policy.
32. [Pi non-compaction retry policy](https://github.com/can1357/oh-my-pi/blob/dev/docs/non-compaction-retry-policy.md) — classified turn recovery and model fallback.
33. [OpenCode V2 compaction](https://opencode.ai/v2/docs/compaction) — completed checkpoints, output reserve, and one-shot overflow recovery.
34. [OpenCode durable auxiliary usage](https://github.com/anomalyco/opencode/pull/37441) — replay-safe token and cost accounting.
35. [OpenCode interrupted-response continuation](https://github.com/anomalyco/opencode/pull/40576) — partial-output preservation and a shared attempt budget.
36. [OpenCode V2 session specification](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md) — durable boundaries and retry safety.
37. [Pi durable AgentHarness design](https://github.com/earendil-works/pi/blob/main/packages/agent/docs/harness-v2.md) — persisted response, usage, and attempt identities.
38. [OpenRouter Exacto](https://openrouter.ai/docs/guides/routing/model-variants/exacto) — tool-quality-first provider ordering.
39. [OpenRouter streaming](https://openrouter.ai/docs/api-reference/streaming) — pre-token versus midstream errors and final usage.
40. [Cloudflare Queue retries](https://developers.cloudflare.com/queues/configuration/batching-retries/) — explicit retry, attempts, and DLQ behavior.
41. [Cloudflare Queue limits](https://developers.cloudflare.com/queues/platform/limits/) — fifteen-minute consumer wall.
42. [Cloudflare Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/) — state across eviction and restart.
43. [Cloudflare Durable Object gates](https://developers.cloudflare.com/durable-objects/reference/glossary/) — durable storage input/output ordering.
44. [SWE-agent RetryAgent](https://swe-agent.com/latest/reference/agent/) — remaining total cost allocation across attempts.
45. [OpenHands persistence](https://docs.openhands.dev/sdk/guides/convo-persistence) — restored long-running conversation state.
46. [OpenHands resume-cost bug](https://github.com/openhands/openhands/issues/13843) — failure evidence when usage is not restored.
47. [Goose provider retries](https://goose-docs.ai/docs/guides/environment-variables) — provider-specific retry and backoff controls.
48. [Kilo safe empty-response retry](https://github.com/Kilo-Org/kilocode/pull/12267) — conservative replay eligibility and bounded attempts.

## Rerun inputs

```yaml
workflow: firecrawl-deep-research
topic: current open-source AI harness model limits, DeepSeek tool reasoning, and transient provider recovery for Gaston
depth: exhaustive
output: markdown plus implementation
priority_branch: anomalyco/opencode v2
priority_docs: https://opencode.ai/v2/docs
date: 2026-08-11
second_pass_focus: durable retry budgets, Exacto routing, and platform-compatible long generations
```
