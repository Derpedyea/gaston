# Deep research: leakage-resistant code-review evaluation

Research and local testing completed 2026-08-13. This is the current follow-up
to [`harness-v2-research.md`](harness-v2-research.md). It used 24+ Firecrawl
searches and the 54 cited papers and primary implementation sources below,
fresh GitHub pull requests, private executable mutation/control pairs, and live
OpenRouter A/B tests. Public benchmarks are references only because their diffs,
labels, and prior model outputs may be present in training or retrieval data.

## Executive summary

The previous `eval:harness` score was not a model-quality result. It replayed
scripted provider outputs that already contained the expected answers, so its
reported precision and recall were self-fulfilling protocol checks. The old
historical command validated only manifest shape; it did not fetch an exact
diff, run DeepSeek, or adjudicate a finding. The documentation now says this
explicitly.

The replacement evaluation has three deliberately separate strata:

1. a rotating corpus of post-model-release GitHub PR snapshots with exact base
   and reviewed-head SHAs, validated bot findings, and withdrawn bot claims;
2. hidden executable bug/control twins for fast harness development; and
3. public Review Droid/Martian-style data only as contaminated references.

On the retired six-pair development suite, the strongest observed arm used:

- DeepSeek V4 Flash `high` reasoning;
- optional, not forced, repository tools;
- one bounded evidence turn;
- compact diff plus risk-selected repository evidence;
- a causal proof template followed by a cold falsification verifier;
- verifier verdicts bound to harness-owned candidate identities; and
- `0.82` publication confidence with deterministic changed-line validation.

Across three stochastic observations of each reused bug/control twin, that arm
found 9/18 canonical defects (50% recall) and two additional legitimate defects.
It commented on 0/18 observed controls; the three `snapshot-cache` control runs
are excluded from the validated-clean denominator because the nominal control
was not behavior-preserving under cache-store failure, leaving 0/15 comments.
Successful scored runs cost $0.025874 total.

The `max` arm observed 7/18 canonical detections (38.9%), one raw extra finding
manually classified as the same legitimate cache-availability defect, and 0/18
control comments. Forced first tools observed 1/6 detections, and a universal
second evidence turn observed 2/6 while roughly doubling cost and latency.
These historical comparisons are directional: the artifacts do not fingerprint
the harness source, reuse only six mechanisms, and do not establish statistical
superiority. More reasoning, tools, and turns therefore remain evaluation knobs,
not assumed quality upgrades.

With complete evidence, the current repository confidence default is `0.80`,
not the retired arm's `0.82`; incomplete evidence uses a `0.88` floor. A later
exact-SHA development replay cold-verified a known Wave accounting defect at
exactly `0.80`, showing that `0.82` could discard a real finding, but that trace
had incomplete coverage and would still require `0.88` under the final policy.
The subsequent uniform regression retained the exact LFX gold at `0.82` with
complete coverage. This is narrow evidence for the threshold policy, not a new
holdout score.

This does not justify calling the harness “best in the world.” It establishes a
leakage-resistant measurement loop, closes several false-clean escape hatches,
and identifies the strongest directional configuration observed here. The
first uniform fresh-PR diagnostic matched only 1/17 planned validated claims
after three provider/budget failures are counted as operational misses. After
the resulting retrieval and verifier fixes, a source-frozen uniform regression
on the now-consumed temporal set matched 3/17. Gaston must therefore remain an
advisory reviewer rather than a sole merge gate.

The final six-head holdout exposed a harness failure before it could support a
model-quality claim: Luna emitted both patch offsets and source coordinates in
all 23 patch-inspection calls, the old schema allowed that combination, and the
executor silently preferred the source coordinate. Fifteen of 33 evidence
calls therefore failed as invalid arguments. After splitting patch and source
lookup into separate contracts, the same now-consumed snapshots were used only
for a source-fingerprinted diagnostic. Luna `high` discovered one of four
canonical defects but published none; Luna `max` published one canonical defect
plus two separately legitimate adjacent defects, with all three selected claims
blind-adjudicated legitimate. This supports keeping Luna `max` as the
quality-oriented default, not declaring the harness release-ready: only one of
six Max heads reached sufficient repository coverage.

A final, disjoint four-head acceptance set was then frozen after all of those
changes. Luna `max` published three independently legitimate novel defects and
no invalid findings, and repeated neither of two withdrawn bot claims. It still
missed both hidden bot-confirmed defects and reached sufficient coverage on
only one head. The result therefore reinforces Luna Max's precision and
cost-efficiency, but fails the recall and evidence-completeness acceptance
criteria. Production remains advisory and non-ZDR by default for both public
and private repositories; `data_collection: deny` is retained.

### Public Martian benchmark baseline

The current Luna Max harness was also run once over all 50 pull requests in
Martian's public offline code-review benchmark. This is the first direct
same-corpus comparison with the historical outputs from commercial review
tools in that repository. It is a contaminated regression baseline, not a
fresh-holdout result: the benchmark, gold comments, and competing outputs are
public and may be represented in model training data.

The evaluator rebuilt each immutable comparison from the merge base and
reviewed head, fetched all 50 successfully, and froze a 173-label manifest with
SHA-256
`d974e7e5ff6fb8b91f59f930e5c81d67ea060f2e7743f6882d4803ff723be255`.
All 50 runs used `openai/gpt-5.6-luna`, OpenAI routing, Max reasoning, optional
tools, one exploration turn, the `0.80`/`0.88` coverage-aware publication
policy, and one stable harness fingerprint. The run emitted 79 published
findings. Martian's official offline pipeline then deduplicated those findings
and judged them with its configured `openai/gpt-5.2` semantic judge; all 50
reviews completed without an evaluator or provider error.

On Martian's default Core profile, Gaston recorded 38 TP, 40 FP, and 120 FN:
48.7% precision, 24.1% recall, and 32.2 F1. That ranks 20th of the 23 currently
visible configurations in the checked-out benchmark results. Precision ranks
10th, while recall ranks 21st, making missed defects the dominant competitive
gap. Under the dashboard's recall-weighted Core F2 default, Gaston scores 26.8
and ranks 21st of 23. The stricter defect profile recorded 35 TP, 40 FP, and 104 FN (46.7%
precision, 25.2% recall, 32.7 F1; rank 20/23). The all-category score was 42 TP,
40 FP, and 131 FN (51.2% precision, 24.3% recall, 32.9 F1; rank 19/23).

For context, the same Core evaluation file scores Qodo Extended v2 at 58.9 F1,
Cubic v2 at 58.7, Augment at 54.5, Qodo v2 at 53.4, Cursor Bugbot at 48.5,
Devin at 48.3, Claude Code at 40.6, CodeRabbit at 38.6, and Gaston at 32.2.
These are versions captured by the offline benchmark repository and should not
be conflated with each vendor's current online product score.

The 50 review runs cost $0.976108 before the separate benchmark-judge expense,
used 221 successful model requests, and had 216.1-second median per-review
latency. Only 23/50 runs reached the harness's sufficient-evidence state. Core
F1 was 36.5 on those 23 reviews versus 28.8 on the 27 incomplete reviews, but
even the complete-evidence stratum remained recall-limited. This confirms that
coverage recovery is useful but cannot by itself close the model and review-
policy gap. The public baseline therefore places the current harness below the
strong commercial middle tier overall: reasonably selective, but not yet a
top-tier bug finder.

#### Recall-oriented Martian regression (2026-08-13)

The baseline's 24.1% Core recall motivated a source-frozen follow-up on the
same contaminated public corpus. The change followed issue-list review
research that finds explicit defect enumeration and compact, relevant context
more effective than a single unstructured whole-diff judgment. Discovery was
made recall-oriented, exact candidate-anchor capsules were prefetched for the
verifier, and Luna Max received its full configured 64K first-response output
headroom instead of repeating a 32K response after a `length` stop. The latter
kept the existing 128K phase output budget and 14-minute Worker soft limit; it
removed the observed wasteful full-reasoning restart.

All 50 follow-up artifacts completed as `model-evaluation` results. They share
corpus digest
`d974e7e5ff6fb8b91f59f930e5c81d67ea060f2e7743f6882d4803ff723be255`,
base commit `b2c9af825542d0a9e4218e2c913c609902cea710`, tracked-diff digest
`b519766604e6d27fab210dd1a19ba397f9a77ff16f1fd424b11a5bc190ba63f6`,
runtime-source digest
`8c120485183e5bb1d4dc5722e96847bde2ee1065e151e20613c2dffd36fa74e9`,
and runner digest
`0f87ca1df1d9848844b6a350184ddf8e4be40c904ffe27b749a90c75ec023db8`.
Every start/end fingerprint matched, and all 245 provider attempts returned
HTTP 200.

The arm discovered 216 candidates and published 153. Martian's configured
GPT-5.2 judge completed all selected-candidate comparisons without error. On
Core, the follow-up recorded 56 TP, 93 FP, and 102 FN: 37.6% precision, 35.4%
recall, and 36.5 F1. Relative to the baseline, that is +18 true bugs, -18 false
negatives, +11.3 recall points, -11.1 precision points, and +4.3 F1 points. In
the checked-out comparison table it sits behind 18 full benchmark systems and
ahead of CodeAnt v2 and the old Gaston arm—approximately 19th of 24 after adding
this arm to the prior 23 configurations. The all-category score was 39.6%
precision, 35.3% recall, and 37.3 F1.

The 50 reviews cost $1.644669 before judge expense, used a 471,964 ms median
per head, and reached sufficient repository evidence on only 12/50 heads.
That is $0.0329 per PR and $0.0294 per Core true positive, versus $0.0195 per
PR and $0.0257 per Core true positive for the baseline: quality improved, but
benchmark true-bug yield per dollar fell by about 12.5%.
Complete evidence did not solve precision: sufficient heads were about 40.0%
precise and incomplete heads 39.5% precise on the all-category judge counts.
Confidence was also a weak discriminator. A post-hoc, therefore biased, 0.98
cutoff would retain about 50 Core TP and 52 FP (49.0% precision, 31.6% recall,
38.5 F1), only two F1 points above the measured policy while discarding six
true bugs. It is not adopted as a holdout-backed default.

Verifier accounting exposes the main remaining defect. Of 216 candidates, the
verifier confirmed 155, refuted only three, left 58 insufficient, and withheld
two confirmed candidates during final publication. It therefore behaves more
like an evidence-completion gate than an adversarial false-positive filter.
Core category recall was strongest on concurrency (10/14) and data (4/7), and
weakest on security (1/11), executable test gaps (0/4), API contracts (4/13),
and ordinary bugs (32/94). Sentry was the weakest repository family at 19.4%
all-category recall; Keycloak was strongest at 43.3% recall and 54.2%
precision.

A separate attempt to judge all 216 raw discovery candidates is excluded: the
OpenRouter key reached its total limit during pairwise judging, leaving 575
failed comparisons across 38 heads. Its partial aggregate is not evidence.
The selected-arm score above had zero judge errors and remains valid.

After this measured run, discovery was tightened to exhaust direct local-delta
defects—wrong identifiers, fields, operators, branch polarity, arguments,
return values, methods/statuses, null handling, security sinks, and vacuous
test assertions—before multi-hop hypotheses. Oversized initial diffs now
allocate the fixed 40 KB evidence budget across every changed hunk; the prior
global head/tail cut could erase complete middle files or middle hunks. The
verifier now receives only the candidate identity, exact anchor, and short
claim title. Discovery's rationale, evidence assertion, proposed fix,
severity, confidence, and summary are deliberately removed so a cold
same-model pass must reconstruct the causal case rather than grade its own
chain of thought. Verification still requires a reachable caller/input and
repository proof for every cross-file causal link; absence of a guard is not
proof. These post-benchmark changes are covered by red/green prompt regressions
and use reviewer generation 18, but no score above is attributed to them. A
complete, prompt-resident diff now takes one structured tool-free discovery
pass; incomplete or omitted evidence retains the bounded retrieval loop. This
removes agent turns where retrieval cannot add information without weakening
the exact-SHA evidence path for large changes. These changes
require a new paid A/B.

This direction is intentionally different from simply adding another broad
review turn. Controlled review studies report that compact issue lists plus
neighboring context outperform whole-window review, while richer repository
context can reduce issue detection through attention dilution. Independent
multi-round review raises recall but can add roughly nine false positives per
new true positive; cross-context review is more reliable than same-session
self-review. The next measured architecture experiment should therefore split
large changes into bounded hunk lanes and merge candidates before one cold,
claim-blind verifier—not ask one transcript to “look harder” at the same PR.

The August 13 DeepSWE v1.1 update strengthens the cost case for DeepSeek V4
Pro, but not for copying its trajectory shape: its public Max configuration is
reported at 63% for about $0.06 per task while using 155 average agent steps,
versus Luna Max at 67% for $0.61 and 102 steps. That is compelling model
economics and poor evidence that Gaston needs more turns. Gaston's post-run
diagnostics instead showed changed anchors already visible in the prompt and
systematic harness/tool and verifier losses. Generation 18 therefore tests the
opposite architecture: a complete prompt-resident diff gets one structured
issue-list discovery request, while only incomplete evidence activates bounded
retrieval. Model choice remains an orthogonal frozen A/B.

[Issue-list code review study](https://arxiv.org/html/2606.01859),
[SWE-PRBench](https://arxiv.org/abs/2603.26130),
[DeepSWE v1.1 leaderboard](https://deepswe.datacurve.ai/),
[Qwen Code review architecture](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/code-review.md),
[cross-context code review](https://arxiv.org/abs/2603.16244),
[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

### Model comparison on a second fresh corpus

A second ignored temporal corpus was frozen from post-release PR comments made
by Copilot, CodeRabbit, Cursor Bugbot, Augment, and Greptile. It contains 20
claim labels over 16 immutable reviewed heads: 16 bot-validated positives and
four explicitly withdrawn or disproved claims. The combined manifest digest is
`310428dea541f4c6347be5b1f03888dbf2b6b86be0818cfac1053fd58a4c21ae`.
All model-visible comparisons used exact base and reviewed-head SHAs; bot text,
labels, fixes, later commits, and adjudication were withheld. The corpus is now
consumed and may be used only for development regression.

The initial DeepSeek V4 Flash `high` run completed all 16 heads for $0.068288
over 56 requests. Discovery emitted eight adjudicated candidates: five
legitimate, two invalid, and one boundary. Its cold verifier retained only one
legitimate candidate, giving 1/16 canonical selected recall and 1/1 selected
precision. Four legitimate discovery candidates were silently lost when lack
of evidence and actual refutation were both represented by omission. Corpus
audit also found three labels whose defect expression was unchanged from base
and one unreachable input-contract label; these remain useful review-surface
comparisons but cannot support strict “introduced by this PR” recall.
After stratifying those four out, Flash's introduced-defect recall is 1/12
(8.3%). The fixed 16-label denominator is retained below for direct bot-corpus
comparison.

DeepSeek V4 Pro 0813 was screened on seven heads carrying eight positives and
two negative controls. It produced one legitimate adjacent finding but matched
none of the eight canonical root causes. Strict canonical recall was 0/8;
observed negative recurrence was 0/2, with one control incompletely covered.
The screen cost $0.202590 over 21 successful requests and had 310.3-second
median latency. More importantly, its sole live OpenRouter endpoint was absent
from the ZDR endpoint set and required an explicit public-corpus-only privacy
exception; it also rejected strict JSON Schema and required JSON-object mode.
It is therefore neither the quality nor privacy default.

GPT-5.6 Luna `high`, pinned to a ZDR-capable Azure route, used the same frozen
harness and passed the predeclared seven-head promotion gate: 3/8 strict
canonical matches, 3/3 discovery and selected precision, and 0/2 negative
recurrence. It exactly found the HyperFleet repeated-no-op latency samples,
Helio's resumed-writer false success after a socket error, and Netatalk's
metadata-prefix extended-attribute loss. The screen cost $0.088167 over 25
requests with 50.8-second median latency.

The unchanged Luna arm then completed all 16 heads: 60/60 provider responses
were HTTP 200, total cost was $0.208855, median per-head latency was 50.8 seconds,
and discovery produced seven scorer-eligible findings, all adjudicated
legitimate. Six selected findings survived. Blind review classified all six selected
findings as legitimate: the three canonical screen matches plus three distinct
open-world findings involving a package-version downgrade, nested text-config
handling, and concurrent signup cleanup. The other nine heads contributed no
additional canonical matches, so strict canonical recall remained 3/16
(18.75%); selected actionable precision was 6/6, while strict canonical-only
label matching was 3/6 because three useful findings were outside the frozen
labels and are not false positives.
Four withdrawn claims did not recur. One additional legitimate LinkedList
string-conversion defect was found in discovery but vetoed by the old verifier.
All three Luna canonical matches are in the introduced stratum, giving 3/12
(25%) introduced-defect recall alongside the fixed-corpus 3/16 figure.

On this one draw, Luna cost about 3.1 times as much as Flash but produced six
actionable selected findings instead of one. That is about $0.0348 per
actionable finding for Luna versus $0.0683 for Flash. Canonical cost per hit was
nearly equal ($0.0696 versus $0.0683), while Luna found three distinct canonical
roots rather than one. These ratios are descriptive, not confidence intervals.

This is one stochastic observation, not a confidence interval, and the corpus
was selected from bot-detectable bugs. Still, it is enough to change the
repository's deployment default from Flash to Luna: higher observed canonical
recall, higher open-world yield, materially lower latency than Pro, and a
compatible provider route. The repository now pins Luna's OpenAI route
directly—no temperature and `max_tokens`—while retaining optional tools and one
broad turn. The non-ZDR route was measured only on public, consumed snapshots;
repositories that require zero retention can explicitly select Azure and its
`max_completion_tokens` contract. OpenAI documents Luna as its
cost-sensitive high-volume GPT-5.6 tier with a 1.05M context window, 128K output,
structured outputs, function calling, and reasoning levels through `max`.

DeepSWE provides an important counterweight to that review-specific result. In
its shared mini-swe-agent harness, Flash `max` is the value/throughput point at
53.3% ±3.6% pass@1 and about $0.10 per task. Luna does not overtake it at `high`
(44.2% ±2.9%); Luna `xhigh` reaches 56.9% ±2.2% at about $0.31, and Luna `max`
reaches 67.2% ±4.0% at about $0.61. Claude Fable 5 `high` is statistically close
to Luna `max` at 68.6% ±1.1%, but costs about $9.18 per task—roughly 15 times as
much. Fable `max` costs about $21.63, so Fable is not a sensible tuning
dependency for this project. The operational picture is therefore tiered:
Flash remains the cheaper broad-screening reference; Luna `xhigh` is the middle
quality/cost crossing; and Luna `max` is the quality-oriented Gaston default.
Gaston does not automatically route between them, and neither DeepSWE's coding
score nor a consumed PR corpus proves which arm wins on a new review holdout.

The paid comparison predates the final tri-state verifier described below, so
its scores characterize the source-fingerprinted comparison harness, not the
then-unmeasured verifier. The corpus is consumed and was not replayed after
the change. A new frozen corpus is required before claiming an end-to-end gain
from the current verifier.

### Luna effort test on a third fresh corpus

A third corpus was frozen after the tri-state verifier and tool-contract fixes.
It contains six validated positives and three explicitly withdrawn claims over
seven new exact reviewed heads; none overlaps the earlier temporal corpora. Its
digest is
`acf3149a6ce0d65238bba5905d736d8d22b554567caeac630c234eb448de70c6`.
Opaque case IDs, exact ancestry, original review anchors, fix tests, and
withdrawal evidence were validated before inference. Labels, bot text, fixes,
and later history remained hidden.

Flash `max` was operationally poor on this set. Its first pass saved six clean
outputs and timed out one head at the 840-second limit; an isolated retry of
that head also returned clean. Across the eventual seven outputs it found none
of six canonical positives and repeated none of three withdrawn claims. The
recorded spend was $0.026124, but elapsed time was far worse than either healthy
Luna route. This was a diagnostic with a retry, not a uniform score.

Azure could not support a clean Luna comparison on the available account tier.
The Luna `xhigh` ZDR pass encountered 25 embedded provider errors in 41 attempts
and completed only four heads; immediate sequential retries also failed. The
Azure `max` pass similarly completed four of seven. These failures were kept as
operational evidence and never treated as clean negatives or quality results.

Pinning Luna to OpenAI and explicitly allowing provider retention for these
already-public snapshots removed that routing bottleneck. Both `xhigh` and
`max` completed all seven heads with only HTTP-200 attempts under the same
source, runner, prompt, tool, and verifier contract:

| Luna effort | Canonical discovery | Canonical selected | Selected strict adjudication | Withdrawn recurrence | Cost | Median/head |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `xhigh` | 1/6 | 0/6 | 0 legitimate / 4 emitted | 0/3 | $0.075719 | 112.4 s |
| `max` | 1/6 | 1/6 | 2 legitimate / 6 emitted | 0/3 | $0.089144 | 99.2 s |

The `max` canonical match was the false-success path after a swallowed
`localStorage` mutation failure. Its other legitimate selection was a distinct
lost-update race in per-thread unread state. Three selections were invalid and
one was a conditional integration boundary, so `max` selected precision was
only 2/6 (33.3%); its recall advantage is real but small. `xhigh` found the same
canonical storage failure in discovery but its verifier withheld it. Its four
selected claims were three invalid and one conditional boundary under a single
conservative cross-arm adjudication. Two blind reviewers initially disagreed on
the shared external-stack and destroyed-window claims; exact caller search and
the pinned Tauri event ordering were used to harmonize both arms rather than
letting different adjudication standards decide the model comparison.

This draw favors `max` over `xhigh` for a publication-oriented reviewer, but it
also shows that reasoning effort alone does not repair weak recall or guarantee
precision. It aligns directionally with two independent coding-agent curves:
DeepSWE places Luna `max` near Claude Fable 5 `high` at a small fraction of the
cost, while Cognition's FrontierCode 1.1 Main reports Luna rising from 35.89%
at `high` to 38.91% at `xhigh` and 39.81% at `max`, at approximately $0.22,
$0.30, and $0.36 per task. FrontierCode lists Flash `high` at 18.80% and about
$1.53 on its own harness. Those numbers validate the cost/performance
hypothesis, not transferability to PR review: agent scaffold, task mix, and
provider pricing materially change the frontier.

Claude Fable was not paid-tested here. DeepSWE reports comparable Luna-Max and
Fable-High scores but roughly a fifteen-fold task-cost difference, making Fable
an unsuitable tuning dependency for this budget. The production recommendation
is Luna `max` on the measured OpenAI route, with provider data collection denied
and ZDR configurable rather than mandatory. Repository visibility does not
change that default. Deployments with an explicit zero-retention policy can
select the Azure/ZDR profile and accept its observed capacity risk until another
ZDR route passes the same conformance test.

[FrontierCode leaderboard](https://cognition.com/frontiercode),
[FrontierCode data](https://cognition.com/data/frontiercode-leaderboard/data.json),
[OpenRouter Luna endpoints](https://openrouter.ai/api/v1/models/openai/gpt-5.6-luna/endpoints)

[GPT-5.6 Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model),
[OpenRouter Luna routes](https://openrouter.ai/openai/gpt-5.6-luna),
[DeepSeek V4 Pro pricing](https://api-docs.deepseek.com/quick_start/pricing/),
[OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr),
[DeepSWE leaderboard](https://deepswe.datacurve.ai/)

### Final untouched holdout and repaired Luna diagnostic

A final code-only holdout was then frozen with four validated positive claims
and two explicitly disproved claims over six new exact reviewed heads. Its
manifest digest is
`7541cfdb923cba9e902740a54a9947f8f60a74d33b174dc1a21f1c186798b82c`.
The first and only untouched run used Luna `max`, OpenAI, optional tools, and one
exploration turn. It completed all six heads for $0.066479 over 20 requests, but
selected one invalid claim, matched none of four positives, and reached
sufficient evidence on 0/6 heads. Neither disproved claim recurred.

That is an end-to-end acceptance failure, but not a clean model comparison. All
23 `diff_for_file` calls contained both patch-text offsets and source-line
coordinates. The old schema permitted the contradictory modes and the executor
silently preferred the source line. Fifteen of 33 executed tool calls therefore
returned `invalid_arguments`; eight mixed calls succeeded only because the
incidental source coordinate happened to be changed. One positive anchor was
absent from the 40 KB initial excerpt and never became visible. The other three
positive anchors were visible, so retrieval failure was important but not the
only cause of the misses.

The model-facing contract now has separate flat tools for patch ranges and
source anchors. A compatibility shim canonicalizes the exact legacy filler
shape before capability checks, cache signatures, execution, and evidence
accounting. Patch rendering no longer reinterprets an out-of-range patch offset
as a source coordinate. Search results stay valid structured JSON within the
12 KB result budget, and exploratory search truncation is advisory rather than
a permanent global clean-review limitation. The initial annotated-diff
truncation flag now measures the actual prompt payload rather than the raw diff.

Because the holdout was consumed by its first API exposure, the post-fix run is
a diagnostic A/B only. Both arms used one frozen harness identity—base
`b2c9af825542d0a9e4218e2c913c609902cea710`, tracked-diff digest
`78b04304afe6a7b57fe0f92f9c077e2711ee88a3d48c2eeaa36ceef4abc64f66`,
runtime digest
`40040b7ec41558cc122b3dadc7d0569ae87743db92d7012324728c803ff8500e`,
and runner digest
`45b71766d62af4bf4eb76860252ddcb3f4ffd49ba4c9b70c0058a4a462cc04aa`.
Every artifact recorded the same start/end fingerprint and
`harnessStable:true`.

| Repaired diagnostic | Canonical discovery | Canonical selected | Blind legitimate discovery | Blind legitimate selected | Disproved-claim recurrence | Cost | Requests | Median/head |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Luna `high` | 1/4 | 0/4 | 1/2 | N/A (0 emitted) | 0/2 | $0.045762 | 20 | 69.9 s |
| Luna `max` | 1/4 | 1/4 | 4/5 | 3/3 | 0/2 | $0.128248 | 25 | 237.6 s |

The High canonical discovery was the order-dependent scalar/empty-array HTTP/2
validation defect, but verification remained insufficient and published
nothing. Max published the exact deferred-capability prompt defect and two
separate legitimate availability defects in the same changed accept-loop seam;
it also discovered a legitimate shell-resolution regression that verification
withheld. Its one invalid discovery confused a bookkeeping header structure
with the separate wire representation. A legitimate finding on a negative
claim's head is an open-world result, not recurrence of that disproved claim.

The coordinate repair reduced invalid tool executions from 15 to zero. It did
not make evidence coverage healthy: High reached sufficient coverage on 2/6
heads and Max on 1/6, with 11 and 13 bounded/truncated results respectively.
Accordingly the scorer now refuses to mark a suite final when any completed head
has insufficient evidence; `--require-complete` exits nonzero and names those
heads. These runs remain diagnostically useful but cannot promote a release.
The search-advisory and exact-patch verifier fallback refinements made after the
A/B are covered by local tests and are not attributed to these paid results.

The direct diagnostic and the independent FrontierCode/DeepSWE curves point in
the same direction: Max spends more than High but creates substantially more
publication-ready signal. That is enough to retain Luna `max` as the default
effort. It is not evidence for buying a Fable arm, whose external task cost is
roughly an order of magnitude higher, nor for claiming world-leading review
quality before a new all-sufficient holdout passes.

### Independent post-repair acceptance set

After the tool-contract repair and local gates were frozen, a final disjoint
corpus was assembled from four PRs first reviewed on 2026-08-12: two descendant-
fixed positive claims and two explicitly withdrawn claims. Its exact manifest
digest is
`8b57408aade1cc8a47ce43723dbd4a56b59ea30533d28f4c9522724669f2448a`.
The run used Luna `max`, the pinned OpenAI route, no ZDR requirement, optional
tools, one exploration turn, and the `0.80`/`0.88` coverage-aware thresholds.
All four artifacts share one start/end source fingerprint.

| Acceptance metric | Result |
| --- | ---: |
| Hidden positive recall, discovery | 0/2 |
| Hidden positive recall, selected | 0/2 |
| Blind factual precision, discovery | 4/6 (66.7%) |
| Blind factual precision, selected | 3/3 (100%) |
| Exact withdrawn-claim recurrence | 0/2 |
| Legitimate novel findings | 4 discovered; 3 selected |
| Cost / requests | $0.07678129 / 17 |
| Evidence calls | 34: 24 OK, 10 truncated, 0 invalid |
| Sufficient repository coverage | 1/4 heads |

The three selected findings were real but did not match either hidden root:
malformed JSON was converted from a client error to 502, duplicate YAML keys
silently discarded entries, and a source-URL validator accepted arbitrary
GitHub paths. The hidden misses were missing date value/order validation and
three vacuous cross-block defeat tests. One miss occurred in a test patch that
remained unresolved after truncation; the date-validation code was fully
inspected and represents a reasoning miss. All 17 provider responses were HTTP
200, so this run isolates coverage and reasoning rather than a routing outage.

The strict scorer must mark the suite provisional because three completed
heads retained insufficient evidence. Open-world factual precision is reported
separately from exact seeded-root precision: treating a real novel defect as a
false positive merely because another bot found a different defect would make
the benchmark actively misleading. Conversely, novel bugs do not rescue the
0/2 canonical recall result. This is the strongest honest reading of the final
acceptance run.

## What was evaluated

### Sealed executable development pairs

The local ignored suite stores model-visible base/head snapshots separately
from hidden validators and semantic labels. Each control and mutant has the
same neutral PR description and differs on exactly one production line. The
base and both twins compile; hidden validators make all ten controls pass and
all ten mutants fail their intended semantic oracle. Pair order is seed-shuffled
for inference, while stable IDs make results auditable.

The paid configuration arms below used the original six-pair development corpus,
suite validation digest
`e29f0454589f876d3a898b536042ae352b5650174595c2ad8261fe4dfde8cade`.
Those historical results cannot be combined with or rerun as results for the
subsequently hardened corpus. The original six mechanisms were:

- immutable-SHA cache namespaces;
- restored cost budgets;
- embedded provider-choice errors;
- mixed present/omitted GitHub patches;
- renamed-file path anchoring; and
- evidence-scope identity.

After hardening, the suite was expanded with base-only policy trust, delayed
delivery ordering, empty DeepSeek reasoning state, and the exact 3,000-file
ceiling. The current ten-pair corpus has 30 compiling snapshots; 10 controls
pass and 10 mutants fail their oracle as expected. Its suite validation digest,
covering the manifest, snapshots, validators, and support source, is
`9f51ed5e0f70a1ac4fb8d01c920fde62461a68a3512e7bbb60c06edd3fb00c08`.

Two unexpected model findings uncovered corpus defects. The cache-availability
finding was emitted on the mutant but also invalidated the nominal control:
cache-store failure could reject a source read that the base completed.
Separately, `every([])` introduced a second real empty-list bug in the
mixed-patch mutant. Both were manually classified as legitimate and the pairs
were subsequently hardened. This is why open-world adjudication is mandatory
even for mutation tests.

Executable validation is not model quality. The current suite passed 30 build
checks, 10 control oracles, and 10 expected mutant failures. Its offline 10/10
smoke replays scripted model answers only to test the runner, tools, verifier,
and scorer; it is not a DeepSeek result.

The suite is a consumed development set after any API request. It may tune the
harness, but it is not an untouched final holdout. A new private mirror and new
twins must be generated before a final release claim.

### Fresh temporal PR corpus

The ignored temporal manifest contains 24 post-`0731` claim labels over 15
unique exact-SHA heads: 17 validated positive bot findings, two boundary claims,
and five explicitly withdrawn or disproved claims. Every label records the exact
original-review base and head,
not the later fixed head. Fix commits, bot text, labels, timelines, and expected
root causes are withheld from the model. The snapshot manifest hash is
`dd91fbdc174564aba467389e7f938a54f9c3eb812967f009ebaa777392b550c7`.

Positive labels require evidence beyond bot agreement: a later fix, executable
regression, maintainer reproduction, or explicit acknowledgement. Examples
include a symlink path-identity failure in
[Cap-go/capgo.app#3003](https://github.com/Cap-go/capgo.app/pull/3003), a
shutdown deadline ignored by a drain in
[open-telemetry/otel-arrow#3709](https://github.com/open-telemetry/otel-arrow/pull/3709),
a concurrent non-atomic seed in
[alienplatform/alien#271](https://github.com/alienplatform/alien/pull/271),
malformed probe JSON in
[ahrav/systems-snackpack#29](https://github.com/ahrav/systems-snackpack/pull/29),
pagination and response-writer interface losses in
[zitadel/nextgen#808](https://github.com/zitadel/nextgen/pull/808), and accounting
defects in
[wave-av/wave-realtime-edge#357](https://github.com/wave-av/wave-realtime-edge/pull/357).

Negative labels are claim-specific, not “this entire PR is clean.” Examples
include the withdrawn assertion that `new Set(null)` throws, an upgrade path
that could not exist because the module had never shipped, and a Python 3.14
claim invalidated by the production runtime pin. A different legitimate issue
on the same PR is retained for manual adjudication rather than counted as a
false positive.

The pre-fingerprint isolated seven-head run used `max` reasoning. Discovery
matched one of six validated positive claims (the iTop French dictionary key),
repeated none of the four negative claims actually present at those heads, and
cost $0.028749 over 27 model requests. The fifth negative lived at a different
remote-dev head and was not run. Final matched recall was 0/6 because the
then-current exact verifier filter rejected iTop's line 53→55 drift. The current
tri-state contract instead requires the verifier to copy the harness-owned
identity and exact discovery anchor and to classify the candidate explicitly;
anchor drift becomes `insufficient`, not a refutation. A confirmed finding
retains the already validated discovery anchor and copies only verifier
confidence. Discovery findings are never snapped from unchanged context onto
nearby changed code. A separate diagnostic trace whose
mutable PR body made it invalid for
quality scoring exposed source-line versus patch-offset confusion; that prompted
separate `diff_for_file` and `diff_for_source_line` tool contracts.

A subsequent `high` sweep is excluded from quality aggregates because the
harness changed after its first three jobs launched and one of seven jobs timed
out at 840 seconds. Its six saved outputs contained five positive heads plus the
iPig negative head: it matched 1/5 saved positive claims and repeated 1/4
co-resident negative claims. The timed-out remote-dev positive head did not
contain the fifth negative; that claim uses a different head. Saved outputs cost
$0.030366 over 20 model requests; timed-out spend is unknown. A fresh,
source-fingerprinted rerun is required for a uniform external-validity result.

That rerun covered all 15 exact heads under one frozen configuration and
corpus. Twelve heads completed and three wrote explicit budget-exhaustion
artifacts; no absent or failed head was credited as a clean control. Among
completed heads, discovery and final selection matched the iTop French-key
defect and missed 11 validated claims, for 1/12 recall (8.3%). Five positive
claims on the failed Wave and Zitadel heads remain statistically pending;
treating those operational failures as product misses gives 1/17 planned recall
(5.9%). Four completed withdrawn claims were not repeated; the fifth negative
head failed and remains unscored. Neither of the two boundary claims recurred.

Final selection emitted three claims. Blind exact-snapshot adjudication found
two useful defects: the known French-key break and a separate low-severity
`Typel` typo across three dictionaries that later bot comments and accepted
fixes independently confirmed. The third claim, rejection of a symlinked
configuration, is a support-boundary concern because the repository explicitly
forbids that arrangement. The scorer's any-actionable-subclaim rubric therefore
reports 2/3 selected precision (66.7%). That is permissive: the typo finding's
main explanation about untranslated strings and literal `~~` rendering was
wrong, so strict whole-causal-claim precision is only 1/3 (33.3%). The typo is a
real extra bug, but the overclaim is still model error. At discovery time,
the verifier correctly vetoed a Skills Manager copy complaint contradicted by
the PR's specification and test, and a concurrency claim whose alleged
duplicate-row outcome was prevented by an upstream unique constraint.
Discovery precision was 2/5 (40.0%) under actionable-subclaim scoring and 1/5
(20.0%) under strict whole-claim scoring.

This uniform run cost $0.072790 over 60 model requests. Only 4/15 heads reached
sufficient evidence; eight provider 429 responses contributed to three
14-minute budget failures. The run therefore diagnosed retrieval and routing
failure modes more strongly than model capability. Its exact frozen identity is
base `b2c9af825542d0a9e4218e2c913c609902cea710`, tracked-diff digest
`8c0850ec0295f8d4493d249e4c15b4f5b177886d6c76c0359ebbc75b483ac023`,
runner digest
`c9f5373d8f1773e8138d7745b7da9bde349b1fb695008ae2cf72bc9cd6b32f6d`,
and corpus digest
`dd91fbdc174564aba467389e7f938a54f9c3eb812967f009ebaa777392b550c7`.
Later harness fixes are intentionally not attributed to this frozen score.

| Fresh exact-SHA PR | Bot comparison labels | Uniform diagnostic outcome |
| --- | --- | --- |
| [Cap-go/capgo.app#3003](https://github.com/Cap-go/capgo.app/pull/3003) | CodeRabbit: 1 positive | missed |
| [open-telemetry/otel-arrow#3709](https://github.com/open-telemetry/otel-arrow/pull/3709) | Copilot: 1 positive | missed |
| [alienplatform/alien#271](https://github.com/alienplatform/alien/pull/271) | Greptile: 1 positive | missed |
| [ahrav/systems-snackpack#29](https://github.com/ahrav/systems-snackpack/pull/29) | CodeRabbit: 2 positives | missed both |
| [zitadel/nextgen#808](https://github.com/zitadel/nextgen/pull/808) | Copilot: 2 positives | operational failure; pending |
| [wave-av/wave-realtime-edge#357](https://github.com/wave-av/wave-realtime-edge/pull/357) | Qodo: 3 positives | operational failure; pending |
| [Combodo/iTop#994](https://github.com/Combodo/iTop/pull/994) | Greptile: 1 positive, 1 withdrawn | positive matched; withdrawn claim stayed clean |
| [shepherdjerred/monorepo#2079](https://github.com/shepherdjerred/monorepo/pull/2079) | Qodo: 1 positive, 1 disproved | positive missed; disproved claim stayed clean |
| [eXPerience83/remote-dev-containers#116](https://github.com/eXPerience83/remote-dev-containers/pull/116) | CodeRabbit: 1 positive and 1 negative on different heads | positive missed; negative head failed and stayed pending |
| [linuxfoundation/lfx-self-serve#1409](https://github.com/linuxfoundation/lfx-self-serve/pull/1409) | Cursor Bugbot/Copilot: 3 positives | missed all; one near-miss vetoed |
| [BillChirico/skills-manager#22](https://github.com/BillChirico/skills-manager/pull/22) | Augment/Qodo: 1 positive, 1 invalid | positive missed; invalid claim stayed clean |
| [delightening/ipigsystem#115](https://github.com/delightening/ipigsystem/pull/115) | CodeRabbit: 1 withdrawn | stayed clean |
| [LAF-US/IDAHO-VAULT#905](https://github.com/LAF-US/IDAHO-VAULT/pull/905) | Qodo: 1 boundary | did not recur |
| [NVIDIA/NemoClaw#8645](https://github.com/NVIDIA/NemoClaw/pull/8645) | CodeRabbit: 1 boundary | did not recur |

This table scores claims, not whole pull requests: a clean negative means only
that the particular withdrawn claim did not recur. It does not assert that the
rest of the PR is bug-free.

The iTop adjudication was checked against its
[dictionary marker convention](https://github.com/Combodo/iTop/blob/b88d56407515cc9d82551fc7df14f4d2b058f339/core/dict.class.inc.php#L358-L365),
[compiler stripping behavior](https://github.com/Combodo/iTop/blob/b88d56407515cc9d82551fc7df14f4d2b058f339/setup/compiler.class.inc.php#L3039-L3044),
and [later accepted typo fixes](https://github.com/Combodo/iTop/commit/32de12dae9d37d32af834566e6bfcfc71ea79e84).
The rejected duplicate-row outcome was checked against the campaign service's
[unique index](https://github.com/linuxfoundation/lfx-v2-campaign-service/blob/17ab6466244163cf2c15a9766705db74a0dc76fc/internal/infrastructure/postgres/migrations/000003_brief_partial_unique_slug.up.sql#L24-L34)
and [conflict mapping](https://github.com/linuxfoundation/lfx-v2-campaign-service/blob/17ab6466244163cf2c15a9766705db74a0dc76fc/internal/infrastructure/postgres/brief_repo.go#L152-L204).
The Skills Manager claim was checked against its frozen
[specification and test](https://github.com/BillChirico/skills-manager/blob/b6a1d167bac050ac8bb4928c2ad6824a55d663b9/docs/superpowers/specs/2026-08-02-update-availability-design.md#L124-L133),
then against the [later real cancellation fix](https://github.com/BillChirico/skills-manager/commit/7ad2dd32ba962068a9eab96114ce682d7cec4501),
which retained the announcement.

### Post-fix targeted development replays

Four selected exact-head replays were run after the uniform diagnostic to test
specific retrieval and verification failures. All 17 requests completed through
one Exacto-selected DeepInfra endpoint with no 429 response; total recorded cost
was $0.024233. These runs are development diagnostics, not a benchmark: the
cases were selected after examining earlier failures, their tracked-diff digest
was `d8f2985c58a9a877d3a37774bda417979d7601927418e7020498af884c29b9ec`,
and the harness changed again afterward.

- Capgo's symlink bug was still missed; an unrelated performance concern was
  correctly vetoed.
- Alien produced a boundary near-miss at the right database-seeding seam, but
  its claimed same-process promise race was impossible; the validated defect
  required independent processes and non-atomic database writes.
- Zitadel produced two unsupported candidates. The verifier rejected both: one
  ignored the production caller's successful-start precondition, and the other
  treated a documented zero-value default as destructive behavior.
- Wave discovery and cold verification retained two legitimate findings. The
  flushed-tail finding exactly matches the temporal corpus label at changed
  line 398 and the later [Qodo review](https://github.com/wave-av/wave-realtime-edge/pull/357#discussion_r3763437232).
  A separate STT-ledger leak was independently reported in the same PR's
  [bot review](https://github.com/wave-av/wave-realtime-edge/pull/357#discussion_r3763437244),
  but was not one of the three frozen Wave labels.

The frozen targeted runner used `0.82`, so it selected only the STT finding at
`0.88` and dropped the exact flushed-tail gold at `0.80`. Applying an
intermediate global `0.80` filter to that same already-verified output retains
both findings, which motivated testing a lower base. The final coverage-aware
policy would still require `0.88` for this incomplete trace. It does not claim
that a fresh stochastic rerun would reproduce either candidate.

### Current uniform regression on the consumed temporal set

After the retrieval, coordinate, continuation, and evaluator-parity fixes, all
15 exact heads were replayed under one frozen source and runner. This is a
regression measurement, not a new holdout: the cases had already been exposed
to the model and used during harness development. The run's identity is base
`b2c9af825542d0a9e4218e2c913c609902cea710`, tracked-diff digest
`5c85a69cdb4baa7c910891f46e6ab4b7d099eb31927592605dc8122f725b3a71`,
runner digest
`9b8528c931f7830dc07c8114c8a36992f30a7e90120ade1fab5ae7ad24737914`,
and corpus digest
`dd91fbdc174564aba467389e7f938a54f9c3eb812967f009ebaa777392b550c7`.

All 15 heads completed. Final selection matched three validated claims:
Alien's partial/non-atomic seed failure, LFX's stale save response, and iTop's
French dictionary key. Canonical recall was therefore 3/17 (17.6%). Raw
selection also repeated iTop's disproved upgrade-path claim and emitted one
self-contradictory remote-dev claim; blind adjudicated precision was 3/5
(60.0%), negative-claim recurrence was 1/5, and neither boundary claim
recurred. Discovery emitted 11 candidates: the three matches, one legitimate
novel Zitadel failed-batch loss that did not survive candidate-contained
verification, and seven invalid claims, for 4/11 adjudicated precision. The
Zitadel candidate was directionally useful but overclaimed unrelated shipper
behavior and anchored line 197 rather than the actual batch-loss line 179. The
exact code removes a batch before `InsertEvents` and neither requeues nor counts
it on failure, contradicting the co-committed ADR's explicit retry-or-metric
contract. It is retained as an open-world discovery, not credited to a frozen
corpus label.

The run cost $0.092399 over 57 model requests and 818,520 reported input tokens.
All provider responses were HTTP 200, but latency still ranged from 24.9 to
704.3 seconds (median 137.5 seconds), and only 6/15 heads reached sufficient
evidence coverage. These results improve on the first frozen run without
supporting a world-best claim; retrieval and model recall remain the dominant
limitations.

An offline threshold sweep over the same already-adjudicated verifier outputs
showed why a single global cutoff is weak. A global `0.85` retained two true and
two invalid claims; `0.88` or `0.90` retained two true claims and no invalid
claims but dropped the valid LFX finding at `0.82`. The implemented policy uses
the `0.80` base only when evidence coverage is sufficient and raises the floor
to `0.88` when it is incomplete. Applied post hoc to this consumed run, that
rule retains all three validated selections and rejects both invalid selections
(3/3 adjudicated precision, 3/17 recall, 0/5 negative recurrence). This is a
tuned development result and must be remeasured once on a newly sealed set.

## Live configuration results

All paired arms used the same DeepSeek model and a pinned DigitalOcean endpoint
for reproducibility, with per-request zero-data-retention and data-collection
denial. The historical Flash deployment used Exacto fallback because endpoint
pinning exposed provider-specific stalls and transient empty responses. The
current Luna repository default instead pins the measured OpenAI non-ZDR route,
with data collection denied and strict parameter compatibility; no Luna
`:exacto` variant was used in this evaluation.

| Configuration | Repeats | Canonical recall | Adjudicated FP | Clean comments | Cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| `high`, optional tools, one turn | 3 × 6 pairs | 9/18 (50.0%) | 0 | 0/18 observed | $0.025874 |
| `max`, optional tools, one turn | 3 × 6 pairs | 7/18 (38.9%) | 0 | 0/18 | $0.022913 |
| `max`, required first tool | 1 × 6 pairs | 1/6 (16.7%) | 0 | 0/6 | $0.006205 |
| `max`, optional tools, two turns | 1 × 6 pairs | 2/6 (33.3%) | 0 | 0/6 | $0.013293 |

The directional `high` arm's median review latency was 39.7 seconds and p95 was 157.6
seconds. The `max` arm's median was 35.9 seconds and p95 was 154.3 seconds.
One high-arm process exhausted bounded retries on a provider 429; the
identical-seed retry succeeded. Failed-process cost was unavailable and is not
included above.

These are per-run, not best-of-three, scores. Taking the union of several cold
runs would raise recall but also changes the false-positive burden and cost.
Research on reflection and multi-round review shows that this trade can be
severe, so Gaston does not publish a union ensemble without a separately
calibrated agreement rule.

The temporal diagnostic is intentionally not another row in this mutation
table: its cases, denominators, operational-failure treatment, and open-world
adjudication differ. On its 15 fresh heads, final selection contained one fully
correct claim, one partly correct claim containing a real typo, and one boundary
claim; planned canonical recall was 1/17, and four completed negative controls
stayed clean while one remained pending.

## Luna versus DeepSeek V4 Pro 0813 recent-bot pilot

On 2026-08-13, Gaston ran a new public regression pilot over four exact,
single-commit PR heads opened or updated on 2026-08-10 through 2026-08-12. The
corpus contains five later-fixed findings originally reported by Macroscope,
Cursor Bugbot, or CodeRabbit across `pingdotgg/t3code`,
`pydantic/pydantic-ai-harness`, and `quic-go/quic-go`. Labels and fix commits
were used only after inference. This is a consumed public regression set, not a
private holdout.

The matched arm used JSON-object output, one direct complete-diff discovery
turn, a cold repository-evidence verifier with one targeted recovery turn, and
the same per-case budgets. Luna used `openai/gpt-5.6-luna`, OpenAI, and `max`.
DeepSeek used the newly released `deepseek/deepseek-v4-pro-0813`, `xhigh`
(documented as its maximum tier), and a singleton `deepseek` provider route.
Every DeepSeek response named `DeepSeek`; GMICloud and all other fallbacks were
excluded. The DeepSeek arm explicitly allowed that endpoint's paid-model data
policy; Luna kept data collection denied.

| Matched JSON-object arm | Luna Max | DeepSeek V4 Pro 0813 xhigh |
| --- | ---: | ---: |
| Completed cases | 4/4 | 4/4 |
| Discovery canonical recall | 5/5 (100%) | 5/5 (100%) |
| Published canonical recall | 2/5 (40%) | 2/5 (40%) |
| Published findings | 4 | 2 |
| Source-adjudicated legitimate findings | 4/4 | 2/2 |
| Model requests | 14 | 14 |
| Reported reasoning tokens | 155,606 | 156,218 |
| Total cost | $0.112083 | $0.183224 |
| Cost per legitimate published finding | $0.0280 | $0.0916 |
| Median case latency | 411.9 s | 505.0 s |
| Total case wall time | 1,348.8 s | 2,201.8 s |

The two extra Luna findings are legitimate adjacent defects in the frozen
quic-go head: an informational response can set `prioritySet` before the final
response supplies its Priority header, and the 431 path hard-codes
`incremental=true` instead of honoring connection-level priority awareness.
They were not among the five labels, so the deterministic scorer correctly
left them pending rather than calling them false positives.

The matched pilot therefore does not show a canonical-recall winner at final
publication. It does show Luna producing twice as many source-valid published
findings, at 38.8% lower total cost, 18.4% lower median latency, and 69.4% lower
cost per actionable finding. The sample is much too small for a general model
ranking, but it favors Luna for the current Gaston workload.

A secondary Luna run used strict JSON Schema, which DeepSeek's launch endpoints
rejected. That Luna run published all 5/5 canonical findings plus three adjacent
findings for $0.127966 at a 358.1-second median. Because it is one unpaired
sample under a different output contract, it is evidence of capability and
variance rather than a fair score row. It also demonstrates that a single run
of this four-case corpus is unstable enough to move Luna from 40% to 100%
published canonical recall.

The pilot exposed the verifier as the dominant bottleneck. Both discovery arms
found 5/5 canonical bugs, but both final arms published 2/5. Specific failures:

1. Evidence scope IDs are model-authored strings. Luna correctly confirmed both
   Pydantic labels, but one cited `pydantic_ai_harness/_shared.py` instead of the
   completed `pydantic_ai_harness/compaction/_shared.py`; the resolver therefore
   demoted a correct, complete verdict to insufficient. Scope handles should be
   opaque harness-issued IDs selected from returned evidence, not retyped paths.
2. A broad truncated read remains an unresolved scope even after a narrower
   recovery establishes the needed fact. On the T3 carry case, Luna returned
   three high-confidence complete confirmations, yet all three were demoted
   because their scope lists included broad truncated reads. Recovery should
   supersede a broader failed scope when the cited claim is covered by exact
   anchors and successful narrow reads.
3. Publication confidence is raised globally when any candidate is incomplete.
   DeepSeek conclusively confirmed the fixed-overhead Pydantic bug at 0.86 with
   a valid changed-line scope, but unrelated insufficient candidates raised the
   entire review floor to 0.88 and withheld it. Completeness and thresholds
   should be calculated per candidate after evidence binding.
4. One recovery turn with at most two calls is too small when the verifier first
   issues several broad reads. The model can spend the recovery allowance on a
   still-too-wide range and make correct findings unpublishable.
5. The exact-SHA evaluator intentionally omitted base-commit repository policy
   instead of reading mutable default-branch instructions. This is now explicit
   in reports, but it remains a production-parity gap.
6. GitHub code search is default-branch advisory. The evaluator re-reads every
   returned path at the frozen head before exposing content, which prevents
   false evidence, but head-only paths can still be missed.
7. This four-case pilot has no clean negative controls, so it cannot estimate
   the false-comment rate. Public bot-derived labels also select for bugs those
   bots already recognize and can be contaminated by public review text.

#### Controlled cross-model verifier rerun (2026-08-13)

After the verifier/publication fixes, a paired verifier-only rerun reused the
exact same 11 Luna discovery candidates across the four immutable heads and
five labels. This removes stochastic rediscovery from the model comparison.
Both arms used the same evidence tools, candidate-local rescue, publication
policy, request/token ceilings, and `$0.25` per-case safety cap. The harness
fingerprint was
`031d0c312cff4977bac3781a12e00d0474b98970954b05e6d7fd53ba2e54baeb`;
the seed-discovery digest was
`0f20d3575da0e8464ba33429a77b0e8c2de0b3cafd91c4c78d1d316eb504ced5`.

| Verifier | Labeled recall | Published / candidates | Strict precision lower bound | Insufficient | Requests | Tool calls | Total cost | Median case latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Luna Max / OpenAI | 5/5 (100%) | 8/11 | 62.5% | 3 | 11 | 33 | $0.038129 | 60.0 s |
| DeepSeek V4 Pro XHigh / DeepSeek | 4/5 (80%) | 6/11 | 66.7% | 5 | 12 | 33 | $0.091043 | 131.2 s |

The cross-model critic removed one unmatched finding pending adjudication, but
also withheld the known Pydantic post-anchor-instruction defect. It additionally
withheld the unmatched T3 draft/attachment candidate. The cache-accounting
candidate remained insufficient after focused rescue in both arms. Treating
pending unmatched findings as false positives only for a conservative lower
bound, Luna's F1/F2 were 76.9%/89.3% versus DeepSeek's 72.7%/76.9%.

DeepSeek cost 2.39 times as much overall, had 2.19 times the median latency, and
cost 2.98 times as much per labeled true positive. This small public corpus is
not a general model ranking and still lacks clean controls, but it rejects the
proposed DeepSeek cross-model veto for this harness: it traded away known recall
without a sufficient precision, cost, or latency gain. The same-model Luna
verifier remains the default. Private artifact digests are
`3b9eb3360707b066368526bbc8363bbdd43cd6138abc1d5500eb56778deed323`
(Luna) and
`956e57d9929495410ac0caa5623345f08b19c3bf1eece06eb47191364335c204`
(DeepSeek).

#### Luna verifier harness micro-A/Bs (2026-08-13)

The remaining Luna changes were evaluated one at a time against saved discovery
candidates or a one-case discovery arm. These are consumed public regression
cases, not fresh holdout evidence. The Pydantic arms all preserved both known
labels; candidate terminality counts confirmed, evidence-backed refuted, and
insufficient outcomes across the same four candidates.

| Pydantic verifier arm | Known labels | Terminal candidates | Requests | Tool calls | Cost | Wall time | Decision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Previous rescue harness | 2/2 | 2/4 | 5 | 14 | $0.018308 | 155.0 s | Baseline |
| Typed gaps + routeable rescue | 2/2 | 2/4 | 3 | 9 | $0.013737 | 119.0 s | Enabled |
| Verified pinned-dependency source | 2/2 | 3/4 | 5 | 13 | $0.019870 | 182.2 s | Enabled for dependency gaps |
| Path-local clusters of at most 3 | 2/2 | 3/4 | 7 | 18 | $0.022040 | 108.7 s | Opt-in only |

Typed gaps removed a failed dependency rescue: cost fell 25%, wall time 23%,
requests 40%, and tool calls 36% without changing known-label recall. Each
insufficient verdict must now name one falsifiable missing fact and classify it
as repository reachability, repository symbol, dependency contract, runtime
semantics, tool failure, or unknown. Rescue is restricted to a gap with a
matching harness capability and receives the completed evidence handles and
contents cited on the first pass.

The dependency arm resolved the cached-token claim correctly rather than merely
making it publishable. Luna used the SHA-256-verified `pydantic-ai-slim==2.27.0`
source contract, which states that normalized `input_tokens` already includes
cache reads/writes, and refuted the claim at 0.99 confidence. The resolver reads
the exact PR-head `uv.lock`, permits only `files.pythonhosted.org`, checks locked
size and SHA-256, bounds compressed/unpacked data, parses the sdist without
executing it, and returns immutable provenance. This follows uv's definition of
`uv.lock` as the exact resolved project versions and PyPI's artifact-hash model.
[uv project layout and lockfile](https://docs.astral.sh/uv/concepts/projects/layout/),
[PyPI JSON API](https://docs.pypi.org/api/json/).

Path-local clustering ran two verifier contexts concurrently and cut this long
case's wall time 40%, but increased cost 11% and tool calls 38% while producing
the same terminal outcomes. The capability and `--verification-cluster-size`
benchmark switch remain available, but the full batch remains the default.

Discovery now emits structured trigger, changed behavior, execution path,
observable failure, falsifier, and single unresolved-fact fields. A direct A/B
found the known bare-padding regression during discovery (1/1), but passing
those untrusted subclaims into verification reduced publication to 0/1 because
Luna treated a future regression-test trigger as a required current bad state.
The accepted design stores the structure for harness auditing/routing while the
verifier remains blind to it. Reusing that exact saved discovery with the blind
boundary restored 1/1 publication in 26.2 seconds for $0.002687.

Finally, `benchmarks/luna-verifier-calibration.json` adds one known positive and
one minimally related negative control on the same frozen head. Luna confirmed
and published the positive, refuted the false `py-`-inside-a-word claim, and
published no unmatched finding in 52.4 seconds for $0.005030. The
`eval:verifier-calibration` checker fails on either a dropped positive or a
confirmed/published control. This is a regression/calibration gate, not an
estimate of production false-positive prevalence.

After the final proof/observation-handle hardening, a second live run under
harness fingerprint
`42fad8f81d6f2e1e7aade53bd93ade42bf1c287f2c33756fb0db4b3612337aa7`
again published the positive and refuted the control. It used two model
requests, cost $0.005917, and completed in 57.1 seconds. A deterministic replay
of the earlier four-PR Luna verifier artifact also preserved all 8/8 prior
publications. The repeat confirms decision compatibility across the trust-
boundary hardening; the small cost and latency difference is one stochastic
sample, not a performance regression claim.

Two launch compatibility failures were fixed during the run. DeepSeek's two
available endpoints rejected JSON Schema but accepted `json_object`, so
structured-output mode is now explicit and still defaults to strict schema.
The agent also hard-coded `data_collection: deny` even when ZDR was disabled;
an explicit opt-in now represents authorized non-ZDR/data-collection routes,
while production remains deny-by-default and rejects contradictory ZDR plus
collection settings. The evaluator additionally now preserves real spend and
elapsed time on failed cases, reports discovery quality separately, records
the repository-policy omission, and verifies its harness fingerprint again at
the end of a long run.

Macroscope's own 118-case reconstruction benchmark reports 57/118 detected bugs
(48.31%), ahead of CodeRabbit's 54/118 and Cursor Bugbot's 50/118. It is useful
directional evidence that Macroscope is strong, and its reviews covered four
of this pilot's five labels (one PR also had CodeRabbit). It is not an
independent head-to-head oracle: the
vendor authored the set and judging process, only a subset of negatives
received manual QA, and the published results were used to improve Macroscope.
Martian's open benchmark is a better reproducible external regression reference
but has its own post-review-fix attribution and public-contamination limits.

## Blind 14-PR T3 Code head-to-head (2026-08-13)

To measure the deployed workflow rather than another synthetic benchmark, 14
new T3 Code PR heads were frozen after the earlier corpus cutoff. The private
manifest pinned every head SHA and, where history could change, its expected
commit count. Luna Max reviewed all heads once before any review comment body,
label, later commit, or fix was read. The reveal then matched findings by root
cause against top-level Macroscope and Cursor Bugbot comments whose
`original_commit_id` was the frozen snapshot. Replies, withdrawn findings,
documentation requests, and convention-only comments were excluded; the one
bug reported by both bots was deduplicated.

| Frozen PR | Macroscope bugs | Cursor bugs | Luna discovery overlap | Luna published overlap |
| --- | ---: | ---: | ---: | ---: |
| [#4786](https://github.com/pingdotgg/t3code/pull/4786) | 0 | 1 | 0 | 0 |
| [#6540](https://github.com/pingdotgg/t3code/pull/6540) | 1 | 0 | 1 | 0 |
| [#6541](https://github.com/pingdotgg/t3code/pull/6541) | 0 | 1 | 1 | 0 |
| [#6542](https://github.com/pingdotgg/t3code/pull/6542) | 2 | 0 | 0 | 0 |
| [#6547](https://github.com/pingdotgg/t3code/pull/6547) | 0 | 2 | 0 | 0 |
| [#6550](https://github.com/pingdotgg/t3code/pull/6550) | 1 | 2 | 1 | 1 |
| [#6551](https://github.com/pingdotgg/t3code/pull/6551) | 0 | 1 | 0 | 0 |
| [#6553](https://github.com/pingdotgg/t3code/pull/6553) | 4 | 0 | 1 | 0 |
| [#6554](https://github.com/pingdotgg/t3code/pull/6554) | 2 | 2 | 1 | 1 |
| [#6555](https://github.com/pingdotgg/t3code/pull/6555) | 1 | 2 | 1 | 1 |
| [#6558](https://github.com/pingdotgg/t3code/pull/6558) | 4 | 1 | 1 | 1 |
| [#6562](https://github.com/pingdotgg/t3code/pull/6562) | 0 | 1 | 0 | 0 |
| [#6563](https://github.com/pingdotgg/t3code/pull/6563) | 3 | 2 | 2 | 1 |
| [#6564](https://github.com/pingdotgg/t3code/pull/6564) | 0 | 1 | 1 | 0 |
| **Total** | **18** | **16** | **10 unique** | **5 unique** |

Across all 14 heads, the Macroscope/Cursor union contained 33 unique concrete
bugs. Macroscope supplied 18/33 and Cursor 16/33; their one shared remote-update
bug accounts for the difference from 34. Luna discovered 10/33 (30.3%) and
published 5/33 (15.2%). This union is a useful competitor-relative target, not
independent ground truth: by construction it favors the bots whose comments
define it and cannot credit Luna-only findings.

The fairest direct slice is the five heads reviewed by all three systems:
[#6550](https://github.com/pingdotgg/t3code/pull/6550),
[#6554](https://github.com/pingdotgg/t3code/pull/6554),
[#6555](https://github.com/pingdotgg/t3code/pull/6555),
[#6558](https://github.com/pingdotgg/t3code/pull/6558), and
[#6563](https://github.com/pingdotgg/t3code/pull/6563). Their 19-bug union was
covered 11/19 (57.9%) by Macroscope, 9/19 (47.4%) by Cursor, 6/19 (31.6%) by
Luna discovery, and 5/19 (26.3%) by Gaston's published output. Against
Macroscope's own 18 findings across every Macroscope-reviewed frozen head, Luna
discovered 6/18 (33.3%) and published 4/18 (22.2%). Gaston therefore trails
Macroscope materially on recall in this real-PR sample.

The run produced 32 discovery candidates and 10 published findings for
$0.409584 total ($0.02926 per PR) with 309.6-second median latency. All 14 cases
completed on the pinned OpenAI Luna route with strict JSON Schema and no
provider fallback. Five competitor bugs were found in discovery and then lost
at verification: non-web link handling, numeric preview zoom, the skill-viewer
symlink race, Windows multiline prompt spawning, and collapsed-anchor release.
This makes verifier recall, not just discovery, the clearest bottleneck.

Post-reveal adjudication found five published exact competitor matches. Two
more Luna-only publications were independently corroborated by the subsequent
PR fix sequence: preview-open fallback on #6540 and cross-turn model attribution
on #6551. Two low-frequency security/liveness claims remain plausible but
unconfirmed. One publication was disproved: #6558 already enriched stored image
attachments with `previewUrl` in `ChatView`, a falsifier the verifier named but
did not inspect. Thus 7/10 publications are confirmed, two remain unresolved,
and one is a known false positive. The follow-up below makes concrete candidate
falsifiers mandatory retrieval targets and tests smaller verifier clusters;
simply lowering the publication threshold would recover known bugs but worsen
the observed false-positive escape.

## Seeded verifier rebench after evidence routing (2026-08-14)

The 32 blind Luna discovery candidates above were frozen and replayed through
the production verification path, so this experiment changes verification and
publication only. The accepted arm keeps a full-batch blind first pass, exposes
only candidate identity/anchor/falsification target initially, then gives at
most two non-low routeable candidates an independent focused rescue. The
harness prefetches the exact missing repository symbol or dependency contract;
only in rescue does it disclose discovery's causal trace, explicitly as an
untrusted routing hypothesis. Python `uv.lock` and pnpm/npm lock entries now
share a generic dependency resolver with registry allowlisting, exact integrity
verification, bounded extraction, and pnpm patch-hash verification.

| Result | Original end-to-end run | Seeded verifier rebench |
| --- | ---: | ---: |
| Frozen PRs / failures | 14 / 0 | 14 / 0 |
| Fixed discovery candidates | 32 | 32 |
| Published findings | 10 | 5 |
| Macroscope/Cursor-union matches | 5/33 (15.2%) | 4/33 (12.1%) |
| Macroscope-only matches | 4/18 (22.2%) | 4/18 (22.2%) |
| All-three direct-slice matches | 5/19 (26.3%) | 4/19 (21.1%) |
| Known #6558 hydration false positive | published | refuted |
| Cost | $0.409584 end to end | $0.240794 verifier only |
| Median latency | 309.6 s end to end | 104.8 s verifier only |

The accepted artifact is
`.private/evals/recent-bot-prs/t3code-fresh-luna-verifier-proof-standard-final-2026-08-14.json`.
All 14 cases completed on OpenAI Luna with strict JSON Schema, no provider
fallback, and identical start/end harness fingerprints. Cost and latency are
not directly comparable with the original because discovery was replayed
rather than rerun.

The precision result improved more clearly than recall. Four publications are
exact competitor matches (#6554 pre-install outcome, #6555 duplicate paste,
#6558 arbitrary local image read, and #6563 signal termination). The fifth,
unnegotiated update telemetry on #6554, remains a Luna-only finding pending
independent adjudication. The previously known false publication is now
explicitly refuted from the unchanged `ChatView` attachment-enrichment path.
On the user's primary Macroscope comparison, published recall therefore remains
4/18 rather than improving; the union loses the Cursor-side #6550 overlap.

Targeted controls showed the new routes can recover #6564's collapsed-anchor
failure and can both confirm #6558's real file-read bug and refute its hydration
false positive. Full-corpus variance still suppressed #6553 and #6564, so those
targeted confirmations are not counted in the table. Two tempting arms were
rejected: default two-candidate clustering exhausted the request budget and
published only two findings, while retrying an inconclusive rescue reopened the
known #6558 false positive and exhausted the resource budget on #6564. The
shipped path does neither. The honest conclusion is higher publication safety
with unchanged Macroscope-relative recall, not a recall win.

### Batched evidence routing follow-up (2026-08-14)

A seven-case seeded gate then replaced per-candidate cold rescues with one
batched evidence-completion pass and added an explicit production-topology
obligation for version-skew claims. The first arm published the same three
known-good findings in this slice, recovered none of the suppressed targets,
and withheld the independently refuted #6554 mixed-version claim. It cost
`$0.154792` across seven cases, so batching alone was not accepted as a recall
claim.

Verdict diagnostics exposed a deterministic routing defect: the prefetcher
searched only the first identifier in the missing-evidence statement and
discarded matches in the candidate's own file. The corrected router searches
up to three named symbols locally and repository-wide and reads same-file
callers away from the anchor. On #6540, the pre-fix route left the competitor
non-web-link bug insufficient; the corrected route confirmed and published it
while withholding the alternate unresolved candidate. The targeted artifact is
`.private/evals/recent-bot-prs/t3code-6540-candidate-context-route-2026-08-14.json`
(`$0.024856`). This is one recovered competitor bug, not yet a full-corpus
ranking claim.

## Research findings that changed the harness

### Compact, targeted context beats repository dumping

SWE-PRBench reports monotonically worse review performance as context expands
from diff-only to whole files and full repository context. PRWeaver likewise
shows large model-quality changes from harness design and degraded detection
when benign carrier changes dilute the review window. Gaston now provides a
bounded diff/file inventory first and retrieves exact patches, source slices,
and literal search evidence on demand. Patch-text ranges and GitHub/source-line
lookups use separate flat tool schemas so one coordinate mode cannot be silently
interpreted as the other.

[SWE-PRBench](https://arxiv.org/abs/2603.26130),
[PRWeaver](https://arxiv.org/abs/2608.02693),
[RepoAudit](https://arxiv.org/abs/2501.18160)

### Reasoning protocol details are harness correctness

DeepSeek's current thinking documentation maps `max` to V4 Flash's maximum
reasoning tier; sampling parameters are ignored in thinking mode. It also
requires reasoning state to survive tool-call continuations. Gaston previously
accepted only `high` and then hard-coded `high`, making the configuration knob
dead. It now sends the selected `high|xhigh|max` value and preserves normalized,
structured, and intentionally empty reasoning fields across tool calls.

[DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/),
[OpenRouter reasoning guidance](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

### Causal proofs improve search; cold verification should only veto

The discovery prompt now requires a concrete trigger/state → changed line →
execution path → observable failure trace and the strongest attempted
disproof. The verifier begins with the strongest refutation and cannot invent
new candidates. It must emit exactly one explicit `confirmed`, `refuted`, or
`insufficient` verdict for every harness-owned identity. Missing, duplicate,
malformed, unknown, or anchor-mismatched entries become `insufficient`, never
refutations. A terminal verdict also has to cite nonempty evidence scopes that
exist in the verifier's harness-owned phase-local completed-evidence ledger,
so a model cannot reuse a discovery-only scope or self-certify an invented or
truncated read. At least one cited patch scope must cover either the entire
candidate file patch or that candidate's exact path, side, and source line; an
unrelated path or nearby source window cannot certify it. Any unresolved candidate
forces a neutral terminal check even
when aggregate file coverage is otherwise complete. The verifier's prose cannot
silently replace a discovery with an unrelated bug at the same line.

[Agentic Code Reasoning](https://arxiv.org/abs/2603.01896),
[Refute-or-Promote](https://arxiv.org/abs/2604.19049),
[AACR-Bench](https://arxiv.org/abs/2601.19494)

### Independent angles help recall, but clean context is the cheaper boundary

Current practitioner systems converge on independent read-only review angles
followed by one synthesis boundary. Anthropic's public Code Review Plugin runs
four parallel reviewers (two policy, one bug finder, and one history-aware
reviewer) and filters the merged candidates at an 80-confidence threshold. A
current Claude review prompt expands that pattern to eight finder angles and a
separate tri-state verification phase. Cloudflare reports a still wider system
with up to seven specialists and a top-tier coordinator that deduplicates and
rechecks uncertain findings. The design is credible at production scale, but
Cloudflare's published median cost is $0.98 per review, well beyond Gaston's
$0.20 ceiling.

The lower-cost lesson is context isolation rather than unconditional fan-out.
Cognition reports that a review agent works best without the coding agent's
prior trajectory: the clean context avoids inheriting its assumptions and
reduces context rot. This is also the useful part of the Tech Twitter discussion
for Gaston. Discovery and verification therefore remain separate cold model
contexts; the verifier receives harness-owned candidate identities and exact
anchors, not discovery rationale, confidence, proposed fixes, or proof
obligations. Extra finder clusters remain an evaluation knob until they improve
recall without recreating the false-positive and cost regressions measured for
universal extra turns.

[Anthropic Code Review Plugin](https://github.com/anthropics/claude-plugins-official/blob/4a3e6565eae08b14c5efcb842d87dee8ae99527f/plugins/code-review/README.md),
[Claude medium-effort review prompt](https://github.com/piebald-ai/claude-code-system-prompts/blob/3fdaff67366bdb2713c00e4a3020970abf3441d6/system-prompts/agent-prompt-code-review-part-6-medium-effort-mode.md),
[Cloudflare AI code review](https://blog.cloudflare.com/ai-code-review/),
[Cognition clean-context review loop](https://x.com/walden_yan/status/2047054401341370639)

### More turns are not a free recall improvement

CR-Bench finds that reflection can raise recall while sharply reducing
signal-to-noise. In the local A/B, a universal second targeted turn cost
roughly 1.85× as much as one-turn `max` and detected fewer canonical faults in
that paired draw. Gaston retains the second turn as an experiment knob, not a
default. A future adaptive policy should spend it only on high-risk unresolved
candidates and must beat the one-turn arm on a sealed set.

[CR-Bench](https://arxiv.org/abs/2603.11078),
[Agentless](https://arxiv.org/abs/2407.01489)

### Evaluation must preserve path identity and incomplete evidence

The audit reproduced several ways the old evidence ledger could assert false
coverage: a later changed-files page could clear a different truncated page;
the same patch could count twice across phases or path aliases; two retained
patches could hide a third omitted patch; and a ranged middle slice could be
treated as a complete patch. Coverage now uses canonical changed-path identity,
pagination intervals, explicit unavailable-patch paths, and unresolved
source-level limitations. GitHub's 3,000-file ceiling is paged completely and
reported as incomplete when the final page is full.

[GitHub pull files API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files),
[GitHub compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits)

### Holdouts need explicit data policy and rotation

Every OpenRouter request sends `data_collection: "deny"`; ZDR is now an
explicit route policy rather than an unconditional constraint. The measured
OpenAI Luna route uses `REVIEW_REQUIRE_ZDR=false` for both public and private
repositories. Operators who independently require zero retention can pin Azure
with `REVIEW_REQUIRE_ZDR=true`, while accepting the provider-capacity failures
observed here. Retries retain `require_parameters`, the provider pin,
data-collection denial, and the selected ZDR policy; an empty or malformed
upstream error is not treated as permission to broaden routing. Any case
exposed to an API is considered consumed and must be rotated out of the final
holdout. Provider identity is logged because routing changes can alter behavior
even when the model slug stays fixed.

[OpenRouter ZDR](https://openrouter.ai/docs/guides/features/zdr),
[OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection),
[OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection),
[OpenRouter Exacto](https://openrouter.ai/docs/guides/routing/model-variants/exacto)

## Implemented controls

- `high|xhigh|max` reasoning is real and testable; lower effort is rejected.
- Required first tools and a second targeted turn are bounded experimental
  options, defaulting to false and one.
- Tool argument identity is recursively canonicalized so reordered JSON cannot
  consume the exploration budget twice.
- A failed provider is excluded when alternatives are allowed, but a
  single-provider reproducibility run retries its only endpoint.
- Provider pinning, data-collection denial, and the configured ZDR policy
  survive every retry path.
- Changed-file inventory is fetched through 3,000 paths and carries separate
  listing, patch, and aggregate truncation state.
- Retained patch data is capped at 2 MB and omitted path identities remain a
  permanent coverage limitation.
- Exact inspected paths and page intervals prevent false coverage through
  duplicate reads or unrelated subpages.
- Large patch retrieval exposes separate GitHub/source-line and patch-text
  continuation tools; contradictory coordinate modes never reach execution.
- Initial diff hunks label changed lines with explicit LEFT/RIGHT source
  coordinates, while structured inventory and patch results remain valid JSON
  within the byte cap instead of being cut through the middle.
- Tool calls are accepted only from the definitions offered on that exact turn,
  so a provider cannot evade a patch-only recovery turn with a stale broad tool.
- Patch-only continuation also enforces the exact changed-path capability
  returned by its triggering inventory page.
- Explicit patch ranges use one-based inclusive endpoints, clamp continuation to
  the patch length, and retire a slice limitation only after its exact advertised
  recovery interval has been covered.
- A large patch may request two sequential advertised ranges in one bounded
  recovery batch; a 633-line regression reaches complete coverage in three
  evidence calls without enabling a universal second model turn.
- If adaptive byte fitting exposes a new uncovered exact-patch continuation,
  one final patch-only recovery batch may close it. It cannot broaden paths,
  repeat a range, exceed two recovery rounds, or exceed eight evidence calls in
  the phase.
- Verification is one explicit tri-state verdict per candidate identity.
  Missing, duplicate, malformed, unknown, anchor-mismatched, or unsupported
  verdicts remain insufficient; they cannot silently veto a discovery.
  Repository results expose opaque harness-issued evidence handles instead of
  path-shaped identities the model must retype. Confirmations and refutations
  require nonempty handles that the verifier's phase-local harness ledger—not
  the model—records as complete. Partial or failed retrievals receive separate,
  non-citable observation identities; a successful recovery receives a new
  proof handle and never promotes content that was not returned.
  Discovery-only reads cannot satisfy the independent-verification boundary,
  and unresolved candidates force a neutral terminal check. Publication keeps discovery's
  already validated exact changed-line anchor. Findings are never moved from
  nearby context onto a changed line merely to make them publishable.
- Publication applies the configured `0.80` base threshold to each complete,
  candidate-bound confirmation. An unrelated unresolved candidate remains
  withheld and keeps aggregate coverage incomplete, but no longer raises the
  floor for confirmed candidates.
- An insufficient verdict names one typed, falsifiable evidence gap. Routeable
  non-low candidates share one batched cold evidence-completion pass; terminal
  verdicts are never polled. Each candidate receives a bounded dossier of
  completed first-pass evidence, harness-prefetched routes to up to three named
  symbols (scoped and repository-wide, including its own file), and discovery's
  causal trace only as an untrusted hypothesis. Version-skew and multi-process
  claims must prove that the alleged peers can coexist in production.
  Dependency-contract gaps can search hash-verified `uv.lock` Python sdists or
  pnpm/npm-pinned JavaScript tarballs without executing them, including
  verification of pnpm patch hashes.
  Candidate verification and publication
  outcomes retain explicit reason codes, while production and temporal
  evaluation use the same deep verification pipeline. A pure deterministic
  replay entry point permits saved verifier transcripts to be re-evaluated
  after trust-policy changes without another model request.
- Temporal evaluation currently imports the same pure changed-file and patch
  renderers as production. A tracked renderer/workspace parity regression and
  a fingerprinted runner make drift visible, but the ignored runner itself is
  not a CI artifact and must still be inspected before a paid sweep.
- File-overview counts reflect bytes actually shown rather than claiming all
  paths were visible.
- Public documentation no longer describes scripted protocol replay as a
  model-quality gate.

## Contrarian views and limitations

- Six original mutation pairs are too small for a global quality claim, and
  their cases are now consumed. Mutation testing correlates with real faults
  but does not cover all real-fault classes; fresh PRs remain necessary.
- The fresh PR positives are selected from bugs another bot already noticed.
  This is useful comparative evidence but over-represents bot-detectable faults.
- Fix commits are stronger evidence than raw bot agreement, but fixes can be
  behavior-neutral appeasement. Reproduction and regression tests receive more
  weight than a changed line alone.
- Exact public SHAs protect temporal correctness, not secrecy. A model with
  network access or later training could retrieve the PR. The review model is
  given no network tool, and final holdouts should use an unpublished mirror.
- Same-model discovery and verification have correlated blind spots. A cold
  cross-model veto may improve precision, but verifier research shows that LLM
  judges are often far better at agreeing with positives than rejecting
  negatives.
- Strict candidate identities improve verifier containment but may reject a
  valid verdict if a provider fails to copy the tag. A paid final-harness smoke
  copied the tag correctly, found its mutant, and stayed silent on its control;
  broader measurement is still needed.
- Candidate containment can still withhold a correct verdict if the provider
  omits the identity, changes the exact anchor, or cannot finish candidate-local
  evidence. Treating that as `insufficient` protects precision but can lower
  recall; richer harness-owned candidate evidence capsules remain an open
  experiment.
- Advisory code review cannot replace tests, type checking, static analysis,
  dependency scanning, or human review.

[Mutants and real faults](https://homes.cs.washington.edu/~rjust/publ/mutants_real_faults_fse_2014.pdf),
[LLM validator agreeableness](https://arxiv.org/abs/2510.11822),
[LLM vulnerability reasoning limits](https://arxiv.org/abs/2312.12575)

## Next experiments

1. Freeze a private post-change repository mirror, generate at least 50 new
   bug/control twins from invariant-driven operators, and expose the final
   holdout exactly once.
2. Continuously add post-release real PR snapshots, stratified by language,
   diff size, defect class, bot, and validated negative claim.
3. Test adaptive second turns only on auth, concurrency, migrations, data loss,
   public API compatibility, and unresolved high-severity causal paths.
4. Revisit cross-model verification only with clean controls and
   minority-veto calibration; the controlled public-corpus DeepSeek arm lost
   one of five known bugs while costing materially more than same-model Luna.
5. Add safe executable reproducers for selected high-severity candidates in an
   isolated environment; never execute arbitrary PR code in the Worker.
6. Measure author acceptance, later fix survival, duplicates, inspection time,
   cost per legitimate bug, and provider-specific failure rates in production.
7. Keep public fixed benchmarks as regression controls, never the release
   selection target.

## Sources

Evaluation and code-review research:

1. [PRWeaver](https://arxiv.org/abs/2608.02693)
2. [SWE-PRBench](https://arxiv.org/abs/2603.26130)
3. [CR-Bench](https://arxiv.org/abs/2603.11078)
4. [AACR-Bench](https://arxiv.org/abs/2601.19494)
5. [RepoAudit](https://arxiv.org/abs/2501.18160)
6. [Agentic Code Reasoning](https://arxiv.org/abs/2603.01896)
7. [Refute-or-Promote](https://arxiv.org/abs/2604.19049)
8. [LLM validator agreeableness](https://arxiv.org/abs/2510.11822)
9. [Defect-Focused ACR](https://arxiv.org/abs/2505.17928)
10. [RevMate](https://arxiv.org/abs/2411.07091)
11. [ACR in Practice](https://arxiv.org/abs/2412.18531)
12. [RovoDev](https://arxiv.org/abs/2601.01129)
13. [Agentless](https://arxiv.org/abs/2407.01489)
14. [SWE-agent](https://arxiv.org/abs/2405.15793)
15. [When More Retrieval Hurts](https://arxiv.org/abs/2511.05302)
16. [Mutation testing and real faults](https://homes.cs.washington.edu/~rjust/publ/mutants_real_faults_fse_2014.pdf)
17. [Review Droid benchmark](https://github.com/droid-code-review-evals/review-droid-benchmark)
18. [Martian code-review benchmark](https://github.com/withmartian/code-review-benchmark)
19. [LiveCodeBench](https://livecodebench.github.io/)

Provider and implementation references:

20. [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/)
21. [OpenRouter Exacto](https://openrouter.ai/docs/guides/routing/model-variants/exacto)
22. [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
23. [OpenRouter zero-data retention](https://openrouter.ai/docs/guides/features/zdr)
24. [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection)
25. [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling)
26. [GitHub pull files API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files)
27. [GitHub compare API](https://docs.github.com/en/rest/commits/commits#compare-two-commits)
28. [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
29. [CodeRabbit review commands](https://docs.coderabbit.ai/guides/commands)
30. [Cursor Bugbot](https://cursor.com/docs/bugbot)
31. [OpenCode provider transform](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/runner/to-llm-message.ts)
32. [Aider repository map](https://aider.chat/docs/repomap.html)
33. [iTop dictionary translation-marker convention](https://github.com/Combodo/iTop/blob/b88d56407515cc9d82551fc7df14f4d2b058f339/core/dict.class.inc.php#L358-L365)
34. [iTop compiler marker stripping](https://github.com/Combodo/iTop/blob/b88d56407515cc9d82551fc7df14f4d2b058f339/setup/compiler.class.inc.php#L3039-L3044)
35. [iTop accepted dictionary typo fix](https://github.com/Combodo/iTop/commit/32de12dae9d37d32af834566e6bfcfc71ea79e84)
36. [LFX campaign-service unique brief index](https://github.com/linuxfoundation/lfx-v2-campaign-service/blob/17ab6466244163cf2c15a9766705db74a0dc76fc/internal/infrastructure/postgres/migrations/000003_brief_partial_unique_slug.up.sql#L24-L34)
37. [LFX campaign-service conflict mapping](https://github.com/linuxfoundation/lfx-v2-campaign-service/blob/17ab6466244163cf2c15a9766705db74a0dc76fc/internal/infrastructure/postgres/brief_repo.go#L152-L204)
38. [Skills Manager partial-coverage announcement specification](https://github.com/BillChirico/skills-manager/blob/b6a1d167bac050ac8bb4928c2ad6824a55d663b9/docs/superpowers/specs/2026-08-02-update-availability-design.md#L124-L133)
39. [GitHub dismiss-a-review API](https://docs.github.com/en/rest/pulls/reviews#dismiss-a-review-for-a-pull-request)
40. [Skills Manager accepted cancellation fix](https://github.com/BillChirico/skills-manager/commit/7ad2dd32ba962068a9eab96114ce682d7cec4501)
41. [Wave flushed-tail accounting review](https://github.com/wave-av/wave-realtime-edge/pull/357#discussion_r3763437232)
42. [Wave abandoned-turn STT ledger review](https://github.com/wave-av/wave-realtime-edge/pull/357#discussion_r3763437244)
43. [Zitadel request-buffer failure path](https://github.com/zitadel/nextgen/blob/bbb1d6a5c585a58550c1822364d116871093d4aa/internal/audit/request_buffer.go#L128-L184)
44. [Zitadel audit-buffer retry contract](https://github.com/zitadel/nextgen/blob/bbb1d6a5c585a58550c1822364d116871093d4aa/docs/adrs/048-wide-events-internal-audit-primitive.md#L273-L284)
45. [GPT-5.6 Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
46. [GPT-5.6 model-selection guidance](https://developers.openai.com/api/docs/guides/latest-model)
47. [OpenRouter GPT-5.6 Luna routes](https://openrouter.ai/openai/gpt-5.6-luna)
48. [DeepSeek V4 Pro pricing](https://api-docs.deepseek.com/quick_start/pricing/)
49. [DeepSWE leaderboard](https://deepswe.datacurve.ai/) — common mini-swe-agent
    pass@1, cost, output-token, and step curves across effort levels.
50. [FrontierCode leaderboard](https://cognition.com/frontiercode)
51. [FrontierCode 1.1 data](https://cognition.com/data/frontiercode-leaderboard/data.json)
52. [OpenRouter GPT-5.6 Luna endpoint metadata](https://openrouter.ai/api/v1/models/openai/gpt-5.6-luna/endpoints)
53. [Issue-list code review study](https://arxiv.org/html/2606.01859)
54. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
55. [Macroscope code-review benchmark](https://macroscope.com/blog/code-review-benchmark)
56. [OpenRouter DeepSeek V4 Pro 0813](https://openrouter.ai/deepseek/deepseek-v4-pro-0813)
57. [Anthropic Code Review Plugin](https://github.com/anthropics/claude-plugins-official/blob/4a3e6565eae08b14c5efcb842d87dee8ae99527f/plugins/code-review/README.md)
58. [Claude medium-effort review prompt](https://github.com/piebald-ai/claude-code-system-prompts/blob/3fdaff67366bdb2713c00e4a3020970abf3441d6/system-prompts/agent-prompt-code-review-part-6-medium-effort-mode.md)
59. [Cloudflare AI code-review architecture and production results](https://blog.cloudflare.com/ai-code-review/)
60. [Cognition clean-context multi-agent review loop](https://x.com/walden_yan/status/2047054401341370639)

## Rerun inputs

```yaml
workflow: firecrawl-deep-research
date: 2026-08-13
depth: exhaustive
web_queries: 24+
tracked_cited_sources: 54
evaluation:
  model: deepseek/deepseek-v4-flash-0731:exacto
  endpoint_for_ab: digitalocean
  privacy:
    data_collection: deny
    zdr: true
  arms:
    - high, optional tools, one turn, three paired trials
    - max, optional tools, one turn, three paired trials
    - max, required first tool, one paired trial
    - max, optional tools, two turns, one paired trial
  corpora:
    - ignored sealed executable bug/control twins
    - ignored exact-SHA post-release bot PR cases
    - public fixed benchmarks as contaminated references only
  current_repository_default:
    model: openai/gpt-5.6-luna
    provider: openai
    require_zdr: false
    reasoning: max
    require_initial_tool: false
    exploration_turns: 1
    verifier: explicit tri-state, exact candidate anchor, completed-scope-bound
    verifier_min_confidence: 0.80
    incomplete_evidence_min_confidence: 0.88
metrics:
  - semantic root-cause and changed-hunk recall
  - manually adjudicated precision
  - clean-control false-comment rate
  - invalid bot-claim repetition
  - cost per legitimate bug
  - request and wall latency
```
