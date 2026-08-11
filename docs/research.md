# Review-system research

For the exhaustive 2026 competitor and literature review, including the full
source family, contrarian evidence, and roadmap, see
[deep-research.md](deep-research.md).

Gaston optimizes for inexpensive bug discovery without training developers to
ignore the bot. Its design follows public production systems, open-source
reviewers, and empirical research rather than a generic “review this diff”
prompt.

## Precision and workflow integration

Google's [Tricorder paper](https://research.google/pubs/pub43322/) reports that
poor workflow integration and false positives destroyed adoption of earlier
analyzers. Tricorder targeted an effective false-positive rate below 10% and
normally showed results only on changed lines. Gaston likewise triggers in the
PR, validates exact diff anchors, applies a high confidence floor, and caps
comments.

Meta's [Infer](https://engineering.fb.com/2015/06/11/developer-tools/open-sourcing-facebook-infer-identify-bugs-before-you-ship/)
puts incremental analyzer findings into code review and reported a high fix
rate. The important product pattern is actionable analysis when the author is
already evaluating a change, rather than another dashboard.

## Repository context and disconfirmation

[Getafix](https://engineering.fb.com/2018/11/06/developer-tools/getafix-how-facebook-tools-learn-to-fix-bugs-automatically/)
ranks fixes using unchanged surrounding code and analyzer evidence. Gaston
therefore exposes bounded base/head file reads, tree listing, and symbol search
instead of supplying only a patch.

The open-source [PR-Agent](https://github.com/qodo-ai/pr-agent) demonstrates
token-aware diff handling, dynamic repository context, and self-reflection.
[CodeRabbit's review flow](https://docs.coderabbit.ai/guides/code-review-overview)
combines multiple models, repository context, static tools, and incremental
reviews. Its path instructions and learnings also show the value of applying
team-specific context instead of generic best practices. Gaston keeps its
policy smaller and auditable: `.gaston/review.md` is loaded only from the base
commit alongside existing root guidance and relevant directory-scoped
`AGENTS.md` files, so a pull request cannot rewrite the rules evaluating itself.

## Bounded discovery, conditional verification

[Qodo's current architecture](https://docs.qodo.ai/code-review/overview) uses
specialized review agents to search from different perspectives, followed by a
judge that merges duplicates and rejects low-confidence claims. A single broad
prompt can stop after finding the first plausible category of bug; independent
searches make that failure mode less correlated.

Gaston initially adopted four concurrent discovery agents, but production
incident evidence showed that this shape multiplied latency, retry
surface, and orphaned work. It now runs one high-reasoning discovery pass across
behavior, security, state, and operations, with one four-read evidence batch.
A fresh verification pass runs only when a changed-line candidate survives.
It re-reads the relevant code, merges duplicates, and must independently
establish the failure before publication.

The exhaustive comparison with OpenCode V2 and bounded agent harnesses is in
[harness-research.md](harness-research.md).

[Greptile's context model](https://www.greptile.com/docs/code-review-bot/custom-context)
and [GitHub Copilot's repository and path-specific
instructions](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review)
reinforce the same broader lesson: repository rules and surrounding code are
first-class review evidence.

## Noise is the main product risk

An [industrial study of 1,568 automatically reviewed pull
requests](https://arxiv.org/abs/2412.18531) found 73.8% of automated comments
were resolved, while also observing faulty, irrelevant, and unnecessary
feedback and longer PR closure time. A larger 2026
[study of CodeRabbit feedback](https://arxiv.org/abs/2607.03316) reported mixed
reception. Those results argue against posting every plausible concern. Gaston
drops claims that lack changed-line membership, repository evidence,
independent verification, or sufficient confidence.

## Deterministic oracles remain stronger

Meta's [predictive test selection](https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection/)
caught more than 99.9% of regressions before trunk while running roughly a
third of transitively dependent tests. Google's
[diff-focused mutation testing](https://research.google/pubs/state-of-mutation-testing-at-google/)
similarly reduces cost by selecting useful mutants and surfaces results during
review. Gaston includes existing GitHub check results as evidence and explicitly
does not pretend an LLM replaces tests, static analysis, or security scanning.

## Resulting pipeline

1. Verify GitHub HMAC before spending Queue, Durable Object, or model resources.
2. Drop drafts, irrelevant actions, duplicates, and stale SHAs.
3. Fetch changed-file patches and repository evidence through a short-lived
   installation token; do not clone or execute repository code.
4. Cache only bounded evidence in Computer's per-PR SQLite workspace.
5. Run a custom OpenRouter tool loop with no arbitrary URLs, writes, or commands.
6. Run one bounded discovery pass across behavior, security, state, and
   operations, then force a tool-disabled structured result.
7. Independently verify surviving candidates in a fresh pass, merging
   duplicates and rejecting claims that do not survive repository inspection.
8. Enforce confidence, deduplication, exact changed-line membership, and the
   configured finding cap in deterministic TypeScript.
9. Re-check the current head, then publish one marked review and complete the
   GitHub check.
10. On later pushes, immediately supersede older work and review the cumulative
    base-to-current-head change before updating one persistent PR summary.

## Why filesystem-only Computer

Cloudflare Computer officially supports a
[filesystem-only workspace](https://github.com/cloudflare/computer) with no
execution backend. That is the smallest useful layer here: it gives each PR a
durable, isolated cache using the same SQLite storage as its Durable Object.
A Linux container was required only to run an external Pi CLI and Git process;
the custom harness needs neither. Computer's Worker JavaScript backend was also
considered, but dynamically loading a fixed, trusted harness would add another
execution boundary and cost without improving isolation from the host that
already owns the GitHub and OpenRouter credentials.

## Cost posture

The chosen OpenRouter model currently has a one-million-token context window,
supports parallel tool calling, and is listed at low per-token prices on its
[model page](https://openrouter.ai/deepseek/deepseek-v4-flash-0731). Prices can
change. Gaston bounds each diff, file slice, tool result, published finding set,
and queue concurrency. It also enforces aggregate wall-clock, model-request,
estimated-input-token, reported-output-token, and reported-cost limits. Exact
tool requests are memoized, reasoning blocks are preserved across DeepSeek tool
calls, and verification is skipped when discovery is clean. GitHub's REST APIs
provide targeted evidence without downloading every reachable blob.

Cloudflare Computer remains preview-only. The package is pinned to `0.1.1`; an
upgrade should be treated as a reviewed platform migration.
