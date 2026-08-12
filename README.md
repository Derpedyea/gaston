<p align="center">
  <img src="docs/assets/gaston-logo.png" width="128" alt="Gaston pixel-art frog logo">
</p>

<h1 align="center">Gaston</h1>

<p align="center">
  A frugal, high-precision AI reviewer that catches bugs before your users do.
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
[`deepseek/deepseek-v4-flash-0731:exacto`](https://openrouter.ai/deepseek/deepseek-v4-flash-0731)
through OpenRouter.

There are no containers, Docker images, shells, or dynamically executed PRs.

## What makes it useful

- **Automatic:** reviews new, reopened, updated, and ready-for-review PRs.
- **Interruptible:** a new commit stops stale in-flight work and immediately
  starts a cumulative review of the latest PR head.
- **On demand:** repository owners, members, and collaborators can comment
  `@gaston` or `@gaston review` on a pull request; Gaston immediately reacts
  with 👀 when the command has been accepted.
- **Cumulative:** every new head is reviewed from the base commit, so the review
  covers all commits currently in the pull request.
- **Deep and low-noise:** one bounded discovery pass targets the riskiest
  behavior, security, state, and operations paths; an independent verifier runs
  only when a changed-line candidate survives discovery.
- **Repository aware:** reads relevant files and searches code at the exact
  base or head commit instead of reasoning from an isolated diff.
- **Safe by construction:** exposes bounded read-only tools; PR code is never
  executed and the model never receives GitHub or OpenRouter credentials.
- **Frugal:** uses a serverless Worker, queues, per-PR Durable Objects, and an
  inexpensive model without paying for idle containers.

## How it works

```mermaid
flowchart LR
  GH[GitHub PR webhook] -->|HMAC verified| W[Worker]
  W --> Q[Review queue]
  Q --> DO[Per-PR Durable Object]
  DO <--> FS[Computer workspace]
  DO -->|bounded reads| GH
  DO -->|bounded discovery + verifier| OR[OpenRouter / DeepSeek]
  DO -->|changed-line findings| GH
```

The Worker verifies GitHub's HMAC signature before accepting a job. A queue
moves inference off the webhook request, while one Durable Object per pull
request prevents duplicate reviews and supersedes stale in-flight work when a
new head arrives. Computer caches the evidence the agent reads without cloning
or executing the repository.

The discovery agent can list changed files, inspect bounded patch slices, list repository
paths, read bounded file slices, and perform literal code searches. It receives
one evidence turn with at most four parallel reads, then a tool-disabled final
turn. Only a truncated or invalid tool result unlocks one targeted recovery
turn with at most two calls. A truncated initial cumulative diff with fewer than
the bounded target of two exact patches inspected also unlocks that recovery
turn and directs it to the riskiest changed-file patches. Once that target is
met, intentional prompt shortening no longer makes coverage incomplete; an
actually truncated GitHub changed-file listing still does. Oversized per-file
patches return patch-line continuation metadata for a narrower follow-up. An
independent verifier runs only when discovery produced candidates.
DeepSeek reasoning state—including meaningful empty reasoning—is preserved
across tool calls. Exact reads are memoized, prompts are capped at 72 KB, tool
results retain marked head/tail previews, and history is compacted to a 120 KB
carried-context target. Immutable trees and files are cached by commit SHA
across new PR heads, while per-run context is cleared independently.
A shared fourteen-minute/request/token/cost budget covers every phase, provider
attempt, and queue redelivery. Resource usage is persisted before provider work
leaves the Durable Object; queue backoff does not count as active review time.
Deterministic code then drops weak findings, invalid line anchors, stale-head
results, and anything over the configured finding cap.

Tool responses carry typed `ok`, `truncated`, `invalid_arguments`,
`permanent_error`, or `transient_error` outcomes. Gaston publishes a successful
clean check only when evidence coverage is sufficient; incomplete evidence ends
neutral and lists its limitations. The latest requested head, execution
generation, check run, and phase are persisted before work proceeds, so a
Durable Object restart cannot make an older execution current again.

Every accepted head gets a queued check immediately. If a newer commit arrives,
Gaston aborts the older head's model request, retry delay, and in-flight GitHub
evidence reads, marks that check superseded, and reviews the full cumulative PR
diff at the new head. Transient queue failures reuse the same check and remaining
budget; exhausted deliveries are retained in a dead-letter queue.

## Quick start

You need a Cloudflare Workers paid plan, a GitHub organization, an OpenRouter
API key, Bun, and Wrangler authentication.

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
| `REVIEW_MODEL` | `deepseek/deepseek-v4-flash-0731:exacto` | OpenRouter model and tool-quality-first routing variant |
| `REVIEW_REASONING_EFFORT` | `high` | Fixed review effort; Gaston rejects lower values rather than silently downgrading reasoning |
| `REVIEW_MODEL_MAX_OUTPUT_TOKENS` | `64000` | Per-attempt completion ceiling; normal requests start at 32,000 and a true length exhaustion can use this ceiling |
| `REVIEW_MIN_CONFIDENCE` | `0.82` | Minimum confidence for published findings |
| `REVIEW_MAX_FINDINGS` | `8` | Maximum inline findings per review |
| `REQUEST_CHANGES_ON` | `blocker` | `off`, `blocker`, or `high` |
| `REVIEW_MAX_WALL_TIME_MS` | `840000` | Aggregate active-review wall-clock limit; queue backoff is excluded |
| `REVIEW_MODEL_TIMEOUT_MS` | `660000` | Timeout for one provider attempt |
| `REVIEW_MAX_MODEL_REQUESTS` | `9` | Aggregate provider-attempt limit |
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

A CLI coding agent normally needs a Linux process, shell, and repository clone.
Gaston implements the useful tool loop directly in the Worker and runs Computer
in filesystem-only mode. A container would add startup time, image maintenance,
attack surface, and idle-cost concerns without adding a capability this design
needs.

## Development

```bash
bun run typecheck
bun run test
bun run eval:historical
bun run eval:harness
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

`eval:harness` replays synthetic provider/tool trajectories and gates precision,
recall, model requests, tool calls, and cost. Real-repository historical corpora
are private local artifacts: capture one with `bun run fixtures:capture --
owner/repo 25`, then run it with
`GASTON_HISTORICAL_CORPUS=.private/evals/owner-repo-historical-prs.json bun run
eval:historical`. The entire `.private/` tree is Git-ignored; never commit
repository snapshots, titles, URLs, commit IDs, or human labels from private
repositories.

`bun run check:privacy` fails CI if a private eval directory or historical PR
snapshot is tracked, providing a second guard beyond `.gitignore`.

The research behind the low-noise review strategy is documented in
[docs/research.md](docs/research.md); the exhaustive competitor review is in
[docs/deep-research.md](docs/deep-research.md), the historical OpenCode harness
investigation is in [docs/harness-research.md](docs/harness-research.md), and
the current OpenCode V2/DeepSeek reliability follow-up is in
[docs/harness-v2-research.md](docs/harness-v2-research.md).

## Current limitations

- Gaston does not run untrusted PR code, tests, linters, or extensions.
- GitHub omits patches for binaries and some oversized changes; Gaston reports
  neutral, incomplete coverage instead of inventing findings or asserting the
  change is clean.
- Cloudflare Computer is preview software. Version `0.1.1` is pinned and should
  be reviewed before upgrades or use as a required merge gate.
- AI review complements human review, tests, CodeQL, dependency scanning, and
  deterministic static analysis; it does not replace them.

## License

[MIT](LICENSE)
