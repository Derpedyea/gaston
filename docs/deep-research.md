# Exhaustive research: AI code-review systems and Gaston

Research completed 2026-08-10. This report combines primary product
documentation, open-source implementation patterns, production case studies,
and recent automated-code-review research. Vendor claims are architecture
evidence, not independent proof of quality.

## Executive summary

The evidence supports a staged system rather than one enormous prompt or an
unbounded self-reflection loop:

1. retrieve compact, change-relevant repository evidence;
2. search independently for different defect classes;
3. require candidates to prove a concrete failure path;
4. use a fresh-context verifier only when discovery finds candidates;
5. publish only changed-line, high-confidence findings; and
6. supersede older work and review the cumulative change on every new head.

DeepSeek V4 Flash 0731 makes investigative turns inexpensive. At collection
time, OpenRouter listed it at $0.08/M input tokens and $0.18/M output tokens,
with a one-million-token context window and tool calling.
Prices and provider quality can change. Cheap tokens justify useful evidence
gathering, but do not make runaway loops, repeated context, or restarted work
reliable. Gaston therefore uses one bounded evidence turn plus aggregate
request, token, cost, and wall-clock limits rather than an unbounded loop.
[OpenRouter model page](https://openrouter.ai/deepseek/deepseek-v4-flash-0731)

The first implementation used four concurrent discovery lenses. Production
incident evidence showed that the extra request and retry surface was not
operationally safe. Gaston now uses one broad bounded discovery pass,
conditional verification, parallel and memoized reads, bounded context,
durable checkpoints, base-commit policy, directory-scoped guidance, cumulative
re-review, and one persistent PR summary. See the later
[OpenCode V2 harness investigation](harness-research.md).

## Key findings

### Context quality beats context quantity

Defect-focused slicing and on-demand data-flow evidence improve results over
diff-only review, but adding whole files can make them worse. SWE-PRBench saw
only 15–31% detection of human-raised issues and monotonic degradation as raw
file context increased. A separate study found top-1 retrieval best and more
examples harmful through redundant or conflicting cues.
[SWE-PRBench](https://arxiv.org/abs/2603.26130),
[When More Retrieval Hurts](https://arxiv.org/abs/2511.05302)

Gaston therefore allows more targeted evidence calls while bounding each
result, retrieving policy only for changed paths, memoizing duplicate reads,
and never preloading the repository.

### Independent search plus independent rejection is the strongest shape

Production and research systems repeatedly separate discovery roles from a
filter or judge. Qodo documents specialists followed by a judge; defect-focused
review research uses multiple roles plus validation; BitsAI-CR combines a rule
checker and review filter. [Qodo](https://docs.qodo.ai/code-review/overview),
[Defect-Focused ACR](https://arxiv.org/abs/2505.17928),
[BitsAI-CR](https://arxiv.org/abs/2501.15134)

Filtering has a real precision/recall cost: validators also discard some true
bugs. Gaston's first implementation used specialist agreement as a search
signal. The bounded redesign preserves independent rejection but runs the
verifier only for candidates, then applies deterministic confidence and line
checks.

### More reflection can reduce usefulness

CR-Bench found reflection could raise recall while collapsing signal-to-noise;
one configuration fell from 2.89 to 0.91 SNR. Simpler workflows also remain
competitive. [CR-Bench](https://arxiv.org/abs/2603.11078),
[Agentless](https://arxiv.org/abs/2407.01489)

Gaston permits one targeted evidence batch of at most four reads, then forces a
tool-disabled judgment. A verifier runs only for surviving candidates.

### Agent loops need convergence, compaction, and checkpoints

Production agent frameworks use several independent safeguards. Vercel's AI
SDK defaults tool-loop agents to 20 steps, supports multiple stop predicates,
and exposes per-step context pruning. Inngest recommends that every LLM/tool
step be checkpointed and that coding-agent loops always cap iterations. Real
agent-loop incidents show that consecutive-only duplicate detection misses
alternating cycles, and that duplicate-call ledgers must survive context
trimming.
[Vercel AI SDK loop control](https://github.com/vercel/ai/blob/74abcdfb6a41666b9910974510d6c9afd960ea1b/content/docs/03-agents/04-loop-control.mdx),
[Inngest agent tool loops](https://www.inngest.com/docs/ai-patterns/agent-tool-loops),
[Crush alternating-loop incident](https://github.com/charmbracelet/crush/issues/2130),
[OpenSRE duplicate-call ledger](https://github.com/tracer-cloud/opensre/issues/2872)

Gaston reuses exact tool results, compacts old tool output to a 120 KB
carried-context target, limits discovery to one four-call evidence batch, and
shares a four-minute/six-request/token/cost budget across discovery,
verification, repairs, and retries. Every request uses high reasoning. Each
starts with an 8,000-token output allowance and a reasoning-only `length`
response retries once with 16,000 tokens instead of lowering effort. Completed analysis is
checkpointed in Durable Object storage so publishing retries resume completed
work.

### Incremental review is a quality feature

CodeRabbit reviews commits since its prior review; Cursor reviews every update;
Qodo and PR-Agent keep an updated overview. Meta Infer similarly analyzes
changes incrementally during review and reported an approximately 80% fix rate.
[CodeRabbit](https://docs.coderabbit.ai/configuration/auto-review),
[Cursor](https://cursor.com/docs/bugbot),
[Qodo](https://docs.qodo.ai/code-review/persistent-review-comments),
[PR-Agent](https://docs.pr-agent.ai/tools/review/),
[Infer](https://engineering.fb.com/2015/06/11/developer-tools/open-sourcing-facebook-infer-identify-bugs-before-you-ship/)

On `synchronize`, Gaston immediately supersedes older work and reviews the full
base-to-current-head change. This preserves interactions among every commit in
the PR while preventing a delayed older delivery from cancelling the latest
review.

### Guidance needs scope, provenance, and lifecycle

Major bots expose repository rules or learned preferences. Mature versions
scope rules to paths and make learned guidance inspectable; unscoped, stale, or
overlong rules conflict and dilute attention.
[CodeRabbit path rules](https://docs.coderabbit.ai/configuration/path-instructions),
[CodeRabbit learnings](https://docs.coderabbit.ai/knowledge-base/learnings),
[Greptile config](https://www.greptile.com/docs/code-review/greptile-config-reference),
[GitHub customization](https://docs.github.com/en/copilot/tutorials/customize-code-review),
[Graphite setup](https://graphite.com/docs/ai-reviews-setup)

Gaston reads policy only from the trusted base commit and now selects
`AGENTS.md` files in ancestor directories of changed files, deepest first,
within a fixed aggregate budget.

### Measure developer outcomes, not comment count

RovoDev reports 38.7% of comments followed by code changes and shorter review
cycles. RevMate's accepted-comment rate was only 7–8%, with another 15–21%
marked useful and a 43-second median inspection cost. A study of 1,568 reviewed
PRs found 73.8% of comments resolved, but longer closure time plus faulty and
unnecessary feedback. [RovoDev](https://arxiv.org/abs/2601.01129),
[RevMate](https://arxiv.org/abs/2411.07091),
[ACR in Practice](https://arxiv.org/abs/2412.18531)

Future evaluation should track survival after re-review, subsequent code
changes, explicit feedback, duplicates, time-to-resolution, and reference-free
relevance—not raw output volume. [CRScore](https://arxiv.org/abs/2409.19801)

## Competitor comparison

| System | Context | Review/update pattern | Gaston lesson |
| --- | --- | --- | --- |
| CodeRabbit | graph, tools, knowledge, path rules | multi-stage, incremental, learnings | incremental state plus auditable scoped rules |
| Qodo | graph, vectors, history, organization | specialists, judge, risk effort, persistent overview | separate recall search from precision judgment |
| Greptile | symbols, imports, dependency graph | feedback learning, cascading config | structural context as an index |
| GitHub Copilot | files, path rules, skills/MCP | ephemeral agent; re-review can repeat findings | explicit finding memory matters |
| Cursor Bugbot | repo plus PR discussion | every update; hierarchical and learned rules | use prior discussion and delta triggers |
| Graphite | full-codebase context and rules | PR/stack workflow and feedback loop | fit the existing developer surface |
| Rovo Dev | Jira criteria and Teamwork Graph | requirement-aware review and custom rules | linked intent exposes spec mismatches |
| PR-Agent | compressed diff and dynamic context | modular tools, reflection, persistent comment | degrade large inputs explicitly |

## Resulting Gaston design

One fresh agent searches behavior, security, state, and operations together. It
makes at most four targeted reads, seeks disconfirming evidence, and returns
only changed-line candidates. The agent can inspect patches, trees, base/head
slices, searches, and CI results; it cannot execute PR code, write files, reach
arbitrary URLs, or receive credentials. This follows RepoAudit's on-demand
evidence and SWE-agent's interface lesson.
[RepoAudit](https://arxiv.org/abs/2501.18160),
[SWE-agent](https://arxiv.org/abs/2405.15793)

A fresh conditional verifier re-reads the repository, proves an execution path, rejects
pre-existing/speculative/duplicate claims, and emits strict structured JSON.
TypeScript then enforces anchors, confidence, deduplication, and finding limits.

The per-PR Durable Object serializes publication and stores completed analysis.
A confirmed newer head aborts the older model request, but a delayed older
queue delivery cannot cancel current work. Every head is analyzed as the full
base-to-current-head change, then revalidated against GitHub before publishing.

OpenRouter recommends sending tools through each loop and supports parallel
calls while surfacing provider tool-call error rates. Gaston executes calls
concurrently and returns actionable tool errors.
[OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)

## Prioritized roadmap

Implemented in this pass:

1. One evidence turn with aggregate request, token, cost, and wall limits.
2. Four parallel tools, identical-request memoization, and context compaction.
3. Broad bounded discovery plus conditional fresh verification.
4. Strict JSON schema with repair attempts.
5. Base-only root and directory-scoped policy.
6. Immediate superseding and cumulative base-to-head re-review.
7. One updated PR summary and changed-line inline comments.
8. Durable discovery/final-analysis checkpoints for retry-safe publishing.

Next highest-value work:

1. Build an offline corpus of accepted, dismissed, fixed, and missed findings;
   optimize precision, recall, SNR, and inspection time per language.
2. Add on-demand Tree-sitter/compiler symbol, call, import, and flow anchors.
3. Turn feedback into proposed human-editable scoped rules with expiry and
   contradiction checks; never silently mutate policy.
4. Optionally retrieve linked issue/acceptance criteria with minimum GitHub
   permissions and treat it as untrusted evidence.
5. Allocate extra passes to auth, migrations, concurrency, public APIs, and
   high-churn areas rather than every PR equally.
6. Test a cross-model cold critic against same-model adjudication.

## Contrarian views and risks

- Judges suppress some true defects; retain rejected candidates for offline
  evaluation.
- More agents can amplify correlated errors when model and evidence are shared.
- Full-codebase context can dilute attention; use graphs as indexes, not prompts.
- Persistent summaries can become noise; Gaston creates one only after a finding
  and then updates it, including when all findings clear.
- Delta review can miss interactions with older PR code; full context remains
  available, state mismatch falls back, and periodic full review needs testing.
- Vendor metrics are selected by vendors and require independent validation.
- LLM security reasoning is insufficient without SAST, tests, dependency scans,
  and humans. [Security study](https://arxiv.org/abs/2312.12575)

## Open questions

1. What incremental/full cadence maximizes recall without repetitive comments?
2. Does a cross-model judge outperform a fresh same-model instance at equal cost?
3. Which context wins per language: search, graph, slice, neighbors, or co-change?
4. How should confidence be calibrated against author actions?
5. Can stale learned rules expire without erasing rare critical invariants?
6. Which human comments are actual bugs rather than style or missing context?

## Sources

Research family:

- [Defect-Focused ACR](https://arxiv.org/abs/2505.17928) — slicing, roles, validation.
- [RovoDev](https://arxiv.org/abs/2601.01129) — enterprise outcomes.
- [Issue-list/context review](https://arxiv.org/abs/2606.01859) — candidate pruning and co-change context.
- [RevMate](https://arxiv.org/abs/2411.07091) — live Mozilla/Ubisoft deployment.
- [ACR in Practice](https://arxiv.org/abs/2412.18531) — resolution, noise, cycle time.
- [SWE-PRBench](https://arxiv.org/abs/2603.26130) — human issues and context dilution.
- [CR-Bench](https://arxiv.org/abs/2603.11078) — reflection versus SNR.
- [RepoAudit](https://arxiv.org/abs/2501.18160) — data-flow evidence and validation.
- [Hybrid static/LLM review](https://arxiv.org/abs/2502.06633) — analyzer assistance.
- [CodeAgent](https://arxiv.org/abs/2402.02172) — agents and quality checker.
- [When More Retrieval Hurts](https://arxiv.org/abs/2511.05302) — context redundancy.
- [CRScore](https://arxiv.org/abs/2409.19801) — reference-free evaluation.
- [BitsAI-CR](https://arxiv.org/abs/2501.15134) — rules, filter, feedback.
- [Comment types](https://arxiv.org/abs/2510.05450) — category resolution differences.
- [AACR-Bench](https://arxiv.org/abs/2601.19494) — expert verification and context variation.
- [Refute-or-Promote](https://arxiv.org/abs/2604.19049) — adversarial cold critics.
- [Fresh-context review](https://arxiv.org/abs/2603.12123) — independent review context.
- [Multi-agent SAST filtering](https://arxiv.org/abs/2605.01885) — false-positive reduction.
- [Static structural anchors](https://arxiv.org/abs/2606.26979) — deterministic agent facts.
- [Tree-sitter graph memory](https://arxiv.org/abs/2603.27277) — structural context.
- [Rules from accepted feedback](https://arxiv.org/abs/2607.13091) — outcome learning.
- [Review as conversation](https://arxiv.org/abs/2607.22095) — review lifecycle.
- [CodeRabbit feedback study](https://arxiv.org/abs/2607.03316) — mixed reception.
- [Response to agent comments](https://arxiv.org/abs/2607.21997) — developer behavior.
- [Issue-oriented review](https://arxiv.org/abs/2511.00517) — issue/spec framing.
- [IRIS](https://arxiv.org/abs/2405.17238) — neuro-symbolic security analysis.
- [SWE-agent](https://arxiv.org/abs/2405.15793) — agent-computer interfaces.
- [Agentless](https://arxiv.org/abs/2407.01489) — simpler competitive workflow.
- [LLM vulnerability reasoning](https://arxiv.org/abs/2312.12575) — security limits.
- [Meta Infer](https://engineering.fb.com/2015/06/11/developer-tools/open-sourcing-facebook-infer-identify-bugs-before-you-ship/) — incremental analysis in review.

Product and implementation sources:

- [CodeRabbit auto-review](https://docs.coderabbit.ai/configuration/auto-review), [overview](https://docs.coderabbit.ai/guides/code-review-overview), [learnings](https://docs.coderabbit.ai/knowledge-base/learnings), [path rules](https://docs.coderabbit.ai/configuration/path-instructions), [knowledge base](https://docs.coderabbit.ai/knowledge-base).
- [Qodo overview](https://docs.qodo.ai/code-review/overview), [capabilities](https://docs.qodo.ai/core-concepts/qodo-platform-core-capabilities), [architecture](https://docs.qodo.ai/core-concepts/qodo-platform-architecture), [effort](https://docs.qodo.ai/code-review/use-qodo-in-prs/control-review-effort), [persistent comments](https://docs.qodo.ai/code-review/persistent-review-comments).
- [Greptile context](https://www.greptile.com/docs/code-review-bot/custom-context), [features](https://www.greptile.com/docs/code-review/key-features), [configuration](https://www.greptile.com/docs/code-review/greptile-config-reference).
- [GitHub Copilot review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review), [customization](https://docs.github.com/en/copilot/tutorials/customize-code-review).
- [Cursor Bugbot](https://cursor.com/docs/bugbot).
- [Graphite reviews](https://graphite.com/docs/ai-reviews), [setup](https://graphite.com/docs/ai-reviews-setup).
- [PR-Agent review](https://docs.pr-agent.ai/tools/review/), [core](https://docs.pr-agent.ai/core-abilities/), [compression](https://docs.pr-agent.ai/core-abilities/compression_strategy/), [dynamic context](https://docs.pr-agent.ai/core-abilities/dynamic_context/).
- [Rovo Dev review](https://www.atlassian.com/software/rovo-dev/code-review), [enablement](https://support.atlassian.com/rovo/docs/enable-code-reviews/).
- [GitHub compare](https://docs.github.com/en/rest/commits/commits#compare-two-commits), [update comment](https://docs.github.com/en/rest/issues/comments#update-an-issue-comment), [review comments](https://docs.github.com/en/rest/pulls/comments#list-review-comments-on-a-pull-request), [PR webhook](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request).
- [OpenRouter model](https://openrouter.ai/deepseek/deepseek-v4-flash-0731), [tool calling](https://openrouter.ai/docs/guides/features/tool-calling).

## Rerun inputs

```yaml
workflow: firecrawl-deep-research
topic: AI code-review bot architectures and evidence-backed improvements for Gaston
depth: exhaustive
output: markdown
```
