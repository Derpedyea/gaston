<p align="center">
  <img src="docs/assets/gaston-logo.png" width="128" alt="Gaston pixel-art frog logo">
</p>

<h1 align="center">Gaston</h1>

<p align="center">
  A frugal, precision-oriented AI reviewer that catches bugs before your users do.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2ea44f.svg"></a>
  <img alt="Runtime: Cloudflare Workers" src="https://img.shields.io/badge/runtime-Cloudflare%20Workers-f38020.svg">
  <img alt="Language: TypeScript" src="https://img.shields.io/badge/language-TypeScript-3178c6.svg">
</p>

Gaston automatically reviews pull requests with a custom TypeScript agent
harness running entirely on Cloudflare Workers. It uses
[Cloudflare Computer](https://github.com/cloudflare/computer) as a durable
SQLite-backed workspace and calls
[`openai/gpt-5.6-luna`](https://openrouter.ai/openai/gpt-5.6-luna)
through OpenRouter. The measured default pins Luna's OpenAI route and uses its
`max_tokens` wire contract. Provider data collection remains denied; strict
[zero-data retention](https://openrouter.ai/docs/guides/features/zdr) is an
explicit opt-in for repositories that need it.

There are no containers, Docker images, native shells, or dynamically executed
PRs. When an exact head snapshot is available, agents may use a read-only
simulated shell in an isolated Cloudflare Dynamic Worker for fast repository
navigation; CI remains responsible for builds, tests, and deterministic
validation.

## What makes it useful

- **Automatic:** reviews new, reopened, updated, and ready-for-review PRs.
- **Interruptible:** a new commit stops stale in-flight work and supersedes it
  with a cumulative review of the latest PR head.
- **On demand:** repository owners, members, and collaborators can comment
  `@gaston` or `@gaston review` on a pull request; Gaston immediately reacts
  with 👀 when the command has been accepted.
- **Cumulative:** every new head is reviewed from the base commit, so the review
  covers all commits currently in the pull request.
- **Paginated inventory:** Gaston paginates GitHub's cumulative pull-request file
  endpoint through its documented 3,000-file ceiling. Large inventories remain
  page-accessible to the agent, and omitted patches or an API-capped listing are
  reported as incomplete evidence rather than a clean review.
- **Deep and low-noise:** one full cumulative discovery pass plus at most two
  deterministic high-risk lanes inspect security, state, data, API, or
  operational hotspots; every candidate still passes through a separate cold
  verifier with an explicit `confirmed`, `refuted`, or `insufficient` verdict.
- **Evolution aware:** a durable per-PR ledger carries unresolved Gaston
  findings across commits, imports authenticated GitHub thread resolution, and
  avoids reposting the same open finding. A previous-head diff is used only as
  a routing overlay; the cumulative base-to-head diff remains authoritative.
- **Merge-ready signaling:** `Gaston review` reports whether the review process
  ran successfully, while the exact-head `Gaston verdict` separately reports
  success, failure for outstanding verified findings, or neutral when evidence
  or prior-thread state is incomplete.
- **Repository aware:** reads relevant files and searches code at the exact
  base or head commit instead of reasoning from an isolated diff.
- **Safe by construction:** exposes bounded exact-source tools plus a
  discovery-only read-only terminal; PR code is never executed and the model
  never receives GitHub or OpenRouter credentials.
- **Frugal:** uses a serverless Worker, queues, per-PR Durable Objects, and an
  inexpensive model without paying for idle containers.

## How it works

```mermaid
flowchart LR
  GH[GitHub PR webhook] -->|HMAC verified| W[Worker]
  W --> Q[Review queue]
  Q --> DO[Per-PR Durable Object]
  DO <--> FS[Computer workspace]
  DO -->|read-only repository navigation| DW[Dynamic Worker shell]
  DO -->|bounded reads| GH
  DO -->|full discovery + risk lanes + cold verifier| OR[OpenRouter / GPT-5.6 Luna]
  DO -->|changed-line findings| GH
```

The Worker verifies GitHub's HMAC signature before accepting a job. A queue
moves inference off the webhook request, while one Durable Object per pull
request prevents duplicate reviews and supersedes stale in-flight work when a
new head arrives. For repositories inside strict file and byte limits, Gaston
streams GitHub's history-free source archive for the exact head SHA into an
immutable Computer snapshot. Extraction validates gzip/tar structure, rejects
unsafe paths, and reconciles every archived path against GitHub's exact Git
tree. Repositories using `export-ignore`/`export-subst`, truncated trees, or
unsupported size limits retain the existing exact GitHub read fallback. A ready
marker is committed only after the snapshot is complete. Nothing clones,
checks out, or executes pull-request code.

The discovery agent can list changed files, inspect bounded patch slices, list
repository paths, read bounded file slices, perform literal code searches, and
run short `rg`/`grep`/`find`/`sed`-style navigation commands against the
read-only exact-head snapshot. Terminal output is always a non-citable
observation; a finding or verifier verdict must retrieve its load-bearing lines
again through an exact file or patch tool. Before inference, deterministic
changed-symbol searches build a bounded, advisory change-impact map. Gaston
then runs the full cumulative discovery and up to two independently prompted
risk lanes selected from changed-code and path signals. Lane candidates are
merged before verification; lane output never bypasses exact changed-line
validation or the cold verifier. Each discovery agent receives one broad
evidence turn with at most four parallel calls and one optional targeted
follow-up with at most two calls, then a tool-disabled final turn. A truncated
or invalid result, an exact-patch coverage shortfall, or an
inventory-only first batch can unlock a targeted recovery batch with at most
two calls. Only a new uncovered exact-patch continuation can unlock one final
patch-only batch; the phase-wide ceiling is eight evidence calls. Inventory
recovery is patch-only and restricted to paths just
returned by GitHub. Once the bounded target of exact patches is met,
intentional prompt shortening no longer makes coverage incomplete; an actually
truncated GitHub changed-file listing still does. Oversized per-file patches
return patch-line continuation metadata, and exact intervals are unioned before
a file counts as fully inspected. A separate cold same-model verifier runs only
when discovery produced candidates. Candidate IDs, exact anchors, and opaque
`GASTON-EVIDENCE-N` handles are harness-owned, so the model never has to retype
a path-shaped evidence identity. A conclusive verdict is accepted only when
every cited handle is complete in the verifier's phase-local ledger. Partial or
failed retrievals receive non-citable `GASTON-OBSERVATION-N` IDs; a successful
recovery receives a new proof handle and can never promote unseen content.
Routeable non-low candidates left insufficient share one batched cold
evidence-completion pass. The blind first pass sees only candidate identities,
anchors, and falsification targets. The batch receives bounded per-candidate
dossiers, harness-prefetched repository/dependency evidence, and each original
causal hypothesis as untrusted routing. Missing repository facts are searched
by up to three named symbols both locally and repository-wide, including
same-file callers away from the changed anchor. Compatibility claims must also
prove that the alleged versions or processes can coexist in production.
Dependency contracts can be read from exact `uv.lock`-pinned Python sdists or
`pnpm-lock.yaml`/npm-pinned tarballs: Gaston restricts registry hosts, verifies
the locked SHA-256 or SHA-512, verifies pnpm patch hashes, bounds decompression,
parses source without execution, and exposes immutable package/version/hash
provenance. Every candidate then has an auditable fate
reason for verification and publication, and production plus evaluation share
the same verification pipeline and deterministic transcript replay boundary.
Saved benchmark artifacts can be re-evaluated without inference with
`bun run eval:replay-verification <artifact.json>`.
Discovery reads cannot masquerade as independent verification. Omitted,
malformed, invented, or still-incomplete evidence fails closed as
`insufficient`, never as a silent veto. The durable finding ledger also fails
closed when authenticated prior-thread state cannot be loaded: the review run
can complete, but the separate merge verdict remains neutral.
Provider reasoning state—including meaningful empty DeepSeek reasoning—is preserved
across tool calls. Exact reads are memoized, prompts are capped at 72 KB, tool
results are capped at 12 KB, and history is compacted to a 120 KB carried-context
target. Structured inventory and patch results remain valid JSON with exact
continuation metadata; bounded prose/file results use marked head/tail previews.
When the initial cumulative diff exceeds its 40 KB prompt allowance, Gaston
stratifies that allowance across changed hunks instead of deleting the global
middle, so a middle file or middle hunk cannot disappear from initial review.
Immutable head snapshots, trees, and lazily fetched base files are cached by
commit SHA across new PR heads, while per-run context is cleared independently.
The Dynamic Worker sees only a chroot-like `/workspace` projection of the
immutable head snapshot. Its filesystem RPC rejects writes with `EROFS`, paths
cannot escape `/workspace`, outbound networking is disabled by Computer, and
Git/artifact commands are disabled. Gaston accepts only single-line pipelines
of allowlisted read commands and rejects shell evaluation, control operators,
redirections, and mutating `find` actions before dispatch. The terminal never
sees run metadata, credentials, or the rest of Computer storage.
A shared fourteen-minute/request/token/cost budget covers every phase, provider
attempt, and queue redelivery. Resource usage is persisted before provider work
leaves the Durable Object; queue backoff does not count as active review time.
Deterministic code then drops weak findings, invalid line anchors, stale-head
results, and anything over the configured finding cap.

Tool responses carry typed `ok`, `truncated`, `invalid_arguments`,
`permanent_error`, or `transient_error` outcomes. Gaston publishes a successful
run-health check when the process finishes. Its separate exact-head verdict is
green only when evidence coverage and prior-thread reconciliation are complete
and no verified finding remains open; it is red for outstanding findings and
neutral for incomplete evidence. The latest requested head, execution
generation, check run, and phase are persisted before work proceeds, so a
Durable Object restart cannot make an older execution current again.

Every accepted head gets a queued check immediately. If a newer commit arrives,
Gaston aborts the older head's model request, retry delay, and in-flight GitHub
evidence reads, marks that check superseded, and reviews the full cumulative PR
diff at the new head. Transient queue failures reuse the same check and remaining
budget; exhausted deliveries are retained in a dead-letter queue.

## Quick start

You need a Cloudflare Workers paid plan, a GitHub personal account or
organization that can install an App, an OpenRouter API key, Bun, and Wrangler
authentication.

```bash
bun install
bunx wrangler whoami
bunx wrangler queues create gaston-reviews
bunx wrangler queues create gaston-reviews-dlq
bun run check
bun run deploy
```

Then register the GitHub App and install its secrets:

```bash
node tools/setup-github-app.mjs \
  --worker-url https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev \
  --organization YOUR_ORGANIZATION

bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler secret put DASHBOARD_TOKEN
```

The setup helper stores the GitHub App ID, private key, and webhook secret
directly in Cloudflare. See the [step-by-step setup guide](docs/setup.md) for
permissions, installation, verification, and troubleshooting.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DASHBOARD_TOKEN` | — | Required bearer token for the live per-PR review workspace; when unset, the API stays hidden behind `404` |
| `DASHBOARD_URL` | Worker URL | Public dashboard origin used by GitHub check-run **Details** links; incoming webhooks override it with their own origin |
| `REVIEW_MODEL` | `openai/gpt-5.6-luna` | Reasoning/tool-capable OpenRouter model; the live fresh-PR screen favored Luna over DeepSeek V4 Flash and V4 Pro. Alternate model and provider pairs must pass the provider-conformance tests before deployment |
| `REVIEW_PROVIDER` | `openai` | OpenRouter provider slug pinned for production requests. The wire contract follows the provider: Azure uses `max_completion_tokens`; every other route uses `max_tokens` |
| `REVIEW_REQUIRE_ZDR` | `false` | Set to `true` with `REVIEW_PROVIDER=azure` for Luna zero-data retention. The incompatible OpenAI+ZDR pair fails before inference. `data_collection: deny` is sent regardless |
| `REVIEW_REASONING_EFFORT` | `max` | `high`, `xhigh`, or `max`; the fresh Luna effort comparison favored `max`, and lower tiers are rejected rather than silently downgrading reasoning |
| `REVIEW_MODEL_MAX_OUTPUT_TOKENS` | `64000` | Per-attempt completion ceiling; normal requests start at 32,000 and a true length exhaustion can use this ceiling |
| `REVIEW_DIRECT_DISCOVERY` | `false` | Keep repository navigation available on every PR. Set to `true` only for a controlled shallow-path comparison that uses one tool-free issue-list pass when the complete changed code fits the prompt |
| `REVIEW_REQUIRE_INITIAL_TOOL_CALL` | `false` | Require at least one repository evidence call before accepting a model verdict |
| `REVIEW_MAX_EXPLORATION_TURNS` | `2` | One broad navigation/evidence turn plus one candidate-targeted exact-evidence follow-up |
| `REVIEW_RISK_LANES` | `true` | Enable independent deterministic specialist discovery lanes before cold verification |
| `REVIEW_MAX_RISK_LANES` | `2` | Maximum dispatched risk lanes; bounded to `0`–`2` |
| `REVIEW_RISK_LANE_MAX_OUTPUT_TOKENS` | `16000` | Per-attempt completion ceiling for each specialist lane |
| `REVIEW_VERDICT_CHECK` | `true` | Publish the separate exact-head `Gaston verdict` check for merge policy |
| `REVIEW_MIN_CONFIDENCE` | `0.80` | Minimum confidence for each independently verified, candidate-bound finding; unrelated incomplete candidates do not raise it |
| `REVIEW_INCOMPLETE_EVIDENCE_MIN_CONFIDENCE` | `0.88` | Aggregate incomplete-evidence fallback retained for non-candidate policy checks; an unresolved verifier candidate is withheld instead of raising other candidates' thresholds |
| `REVIEW_MAX_FINDINGS` | `8` | Maximum inline findings per review |
| `REQUEST_CHANGES_ON` | `blocker` | `off`, `blocker`, or `high` |
| `REVIEW_MAX_WALL_TIME_MS` | `840000` | Aggregate active-review wall-clock limit; queue backoff is excluded |
| `REVIEW_MODEL_TIMEOUT_MS` | `660000` | Timeout for one provider attempt |
| `REVIEW_MAX_MODEL_REQUESTS` | `15` | Aggregate provider-attempt limit |
| `REVIEW_MAX_INPUT_TOKENS` | `250000` | Approximate aggregate input-token limit |
| `REVIEW_MAX_OUTPUT_TOKENS` | `128000` | Reported aggregate output-token limit |
| `REVIEW_MAX_COST_USD` | `0.20` | Reported aggregate OpenRouter cost limit |

Add repository-specific guidance in `.gaston/review.md`. Gaston also reuses
root `AGENTS.md`, `.github/copilot-instructions.md`, and `CLAUDE.md` when they
already exist, plus `AGENTS.md` files in directories containing changed code.
All policy is read from the base commit, so a pull request cannot weaken the
rules reviewing it.

## Security and cost controls

The public Worker URL is not an inference API. Only a correctly signed GitHub
webhook can enqueue a review. The live review API is read-only and requires the
`DASHBOARD_TOKEN` bearer secret; it returns `404` when the secret is not
configured and `401` for an invalid token. Invalid webhook requests are rejected
before OpenRouter is called. Secrets are stored by Cloudflare and never bundled
into the browser application.

The default OpenAI route is not marked ZDR and is used for both public and
private repositories. For deployments that independently require strict zero
retention, set `REVIEW_PROVIDER=azure` and `REVIEW_REQUIRE_ZDR=true`; Gaston
then switches to Azure's `max_completion_tokens` request field and keeps that
provider/privacy profile across retries. Invalid provider slugs and boolean
settings fail before inference.

Structured Worker logs report each review phase and model attempt, including the
requested and returned model, provider, elapsed time, request size, tool names,
executed/cached calls, context compaction, checkpoint reuse, token/cache/reasoning
usage, reported OpenRouter cost, and remaining budget. GitHub check progress and
the terminal summary also show aggregate resource use. Logs never contain
credentials, prompts, model output, tool arguments, or repository contents.

For public repositories, outside contributors can still trigger legitimate
reviews by opening or updating pull requests. Set a weekly OpenRouter key limit,
restrict the GitHub App to selected repositories, or add an author allowlist if
you need a stricter spending boundary.

## Why no container?

A CLI coding agent normally needs a Linux process, native shell, and repository
clone. Gaston needs the navigation ergonomics, not native execution: Computer's
Worker-shell backend runs a simulated shell on demand in a Dynamic Worker over
the existing exact snapshot. A container would add startup time, image
maintenance, attack surface, and idle-cost concerns; builds, tests, and other
deterministic validation stay in CI.

## Development

```bash
bun run typecheck
bun run test
bun run eval:historical
bun run eval:harness
bun run eval:models
bunx wrangler dev
bunx wrangler deploy --dry-run
bun run diagnose:pr -- OWNER/REPOSITORY#123
```

For local full-stack development, run `bun run dev` and `bun run dev:ui` in
separate terminals. Vite proxies `/api` to the local Worker. Open the UI, enter
an `owner/repository`, pull request number, and the dashboard token. The token is
kept in `sessionStorage`; it is not written to the URL or persisted in the
Worker. A session appears after that pull request has started a review on this
version of Gaston. Gaston's GitHub check run uses its native **Details** link to
open this workspace with the repository and pull request already selected; the
dashboard token is never included in that link.

`eval:harness` is a deterministic protocol regression: it replays scripted
provider/tool trajectories and gates parsing, request counts, tool counts, and
cost accounting. Its scripted precision/recall numbers do **not** measure model
quality. `eval:historical` validates the shape of a private PR manifest when
`GASTON_HISTORICAL_CORPUS` is set and otherwise reports a skip; it does not fetch
diffs, execute the model, or adjudicate findings. Real quality
experiments need immutable base/head snapshots, hidden semantic labels, paired
clean controls, and executable or human-adjudicated oracles. Private manifests
can be captured with `bun run fixtures:capture -- owner/repo 25`, then checked
with
`GASTON_HISTORICAL_CORPUS=.private/evals/owner-repo-historical-prs.json bun run
eval:historical`. The entire `.private/` tree is Git-ignored; never commit
repository snapshots, titles, URLs, commit IDs, human labels, or model outputs
from private repositories.

`eval:models` validates the public exact-SHA recent-bot corpus without spending
model tokens. Pass `--run` and explicit model, provider, effort, output mode,
cost cap, and ignored output path to execute a paid arm. The DeepSeek Cloud
route requires the explicit data-collection opt-in; provider pinning prevents
fallback to GMICloud or another endpoint.

Use `--corpus .private/path/to/blind-corpus.json` to evaluate an ignored fresh
corpus before reading its public bot comments or fixes. Cases default to one
commit; set `expectedCommitCount` when the exact reviewed base-to-head snapshot
contains more than one commit.

```bash
bun run eval:models --run \
  --model openai/gpt-5.6-luna --provider openai --effort max \
  --structured-output json_object --max-cost-usd 0.25 \
  --output .private/evals/recent-bot-prs/luna.json

bun run eval:models --run \
  --model deepseek/deepseek-v4-pro-0813 --provider deepseek --effort xhigh \
  --structured-output json_object --allow-data-collection \
  --max-cost-usd 0.25 \
  --output .private/evals/recent-bot-prs/deepseek.json
```

To isolate verifier behavior, `--discovery-artifact <prior-run.json>` reuses
the exact validated discovery candidates in that artifact and runs inference
only for verification. Run same-model and cross-model arms from the same seed
artifact to avoid confounding verifier results with stochastic rediscovery.

`--verification-cluster-size N` enables the opt-in path-local clustering A/B;
it is not the production default because the measured latency gain increased
cost and tool calls. The tracked positive/negative Luna calibration can be run
and checked with:

```bash
bun run eval:models --run --case t3code-bare-padding-regression \
  --model openai/gpt-5.6-luna --provider openai --effort max \
  --structured-output json_object --discovery-artifact benchmarks/luna-verifier-calibration.json \
  --output .private/evals/recent-bot-prs/luna-calibration.json
bun run eval:verifier-calibration benchmarks/luna-verifier-calibration.json \
  .private/evals/recent-bot-prs/luna-calibration.json
```

`bun run check:privacy` fails CI if a private eval directory or historical PR
snapshot is tracked, providing a second guard beyond `.gitignore`.

The research behind the low-noise review strategy is documented in
[docs/research.md](docs/research.md); the exhaustive competitor review is in
[docs/deep-research.md](docs/deep-research.md), the historical OpenCode harness
investigation is in [docs/harness-research.md](docs/harness-research.md), and
the current OpenCode V2/DeepSeek reliability follow-up is in
[docs/harness-v2-research.md](docs/harness-v2-research.md). The latest
leakage-resistant evaluation, fresh-PR corpus and diagnostic runs, and
directional configuration A/B are in
[docs/harness-v3-research.md](docs/harness-v3-research.md).

## Current limitations

- Gaston does not run untrusted PR code, tests, linters, or extensions.
- GitHub omits patches for binaries and some oversized changes; Gaston reports
  neutral, incomplete coverage instead of inventing findings or asserting the
  change is clean.
- Cloudflare Computer and its Worker-shell integration are preview software.
  Version `0.1.1` is pinned and should be reviewed before upgrades or use as a
  required merge gate.
- AI review complements human review, tests, CodeQL, dependency scanning, and
  deterministic static analysis; it does not replace them.

## License

[MIT](LICENSE)
