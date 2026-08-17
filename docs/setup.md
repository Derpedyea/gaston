# Setup guide

This guide deploys Gaston without Containers. Cloudflare and GitHub command-line
authentication can do almost everything. GitHub does not expose a supported
API that silently creates an App under your account: its
[App manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
requires you to confirm ownership in a GitHub page once.

## 1. Install dependencies and verify accounts

From the repository root:

```bash
bun install --frozen-lockfile
bunx wrangler whoami
gh auth status
bun run check
```

`wrangler whoami` must show the Cloudflare account that has Workers Paid. The
GitHub user must be allowed to create and install a GitHub App on the target
personal account or organization.

## 2. Create the Queue

```bash
bunx wrangler queues create gaston-reviews
bunx wrangler queues create gaston-reviews-dlq
```

If Wrangler says either queue already exists, continue. Both names are already
configured in `wrangler.jsonc`; the second queue retains terminally failed
deliveries for diagnosis instead of deleting them.

## 3. Deploy the Worker once

```bash
bun run deploy
```

Copy the resulting URL, for example:

```text
https://gaston-pr-reviewer.<your-subdomain>.workers.dev
```

Check it:

```bash
curl -fsS https://gaston-pr-reviewer.<your-subdomain>.workers.dev/health
```

It should print `ok`. The Worker can be deployed before secrets are present;
authenticated webhook processing needs the GitHub and OpenRouter secrets, and
the live dashboard API additionally needs `DASHBOARD_TOKEN`.

## 4. Create an OpenRouter key

Create a dedicated key in OpenRouter rather than reusing a broad personal key.
Set a conservative credit limit while testing. Gaston's default GPT-5.6 Luna
model has a 1.05-million-token context window and 128,000-token maximum output;
current pricing and provider availability are listed on its
[OpenRouter model page](https://openrouter.ai/openai/gpt-5.6-luna), but can change.
Gaston defaults to the measured OpenAI route, sends `data_collection: deny`, and
uses that endpoint's `max_tokens` contract. Strict zero-data retention is not
enabled by default. For repositories that require it, set
`REVIEW_PROVIDER=azure` and `REVIEW_REQUIRE_ZDR=true` in `wrangler.jsonc`; Gaston
then uses Azure's `max_completion_tokens` contract. Retries preserve the pinned
provider and privacy settings.

Store it interactively so it does not enter shell history:

```bash
bunx wrangler secret put OPENROUTER_API_KEY
```

## 5. Register the GitHub App

Open GitHub's **Settings → Developer settings → GitHub Apps → New GitHub App**.
For an organization, create it under that organization's settings.

Alternatively, the local setup helper implements GitHub's official manifest
flow, lets GitHub generate the webhook secret/private key, and stores all three
generated credentials directly through Wrangler. Start it and open the URL it
prints:

```bash
bun tools/setup-github-app.mjs \
  --worker-url https://YOUR-WORKER.workers.dev \
  --name YOUR-UNIQUE-APP-NAME \
  --organization OPTIONAL-ORGANIZATION
```

GitHub redirects to the localhost helper, which exchanges the one-hour code and
runs `wrangler secret put` without printing the credentials. Use its final link
to install the App on selected repositories.

Use these values:

- GitHub App name: any globally unique name, such as `gaston-<account>`
- Homepage URL: the Worker URL
- Webhook URL: `<Worker URL>/webhooks/github`
- Webhook secret: generate a new random value locally:

  ```bash
  openssl rand -hex 32
  ```

- Webhook active: yes
- Callback URL / user authorization: not required
- App visibility: private unless other accounts need to install it
- App logo: upload `docs/assets/gaston-bot-pfp.png`
- Repository permissions:
  - Contents: read-only
  - Issues: read and write (required to acknowledge PR commands with a reaction)
  - Pull requests: read and write
  - Checks: read and write
  - Metadata: read-only (automatic)
- Subscribe to events: Pull request and Issue comment

Create the App, note its numeric App ID, and generate/download one private key.
Install the App on only the repositories you want Gaston to review.

## 6. Put GitHub credentials into Worker secrets

Run the following. Wrangler prompts without echoing values:

```bash
bunx wrangler secret put GITHUB_APP_ID
bunx wrangler secret put GITHUB_WEBHOOK_SECRET
bunx wrangler secret put GITHUB_PRIVATE_KEY < /absolute/path/to/app.private-key.pem
```

For `GITHUB_WEBHOOK_SECRET`, enter the exact random value used in GitHub. The PEM
file may use either `BEGIN RSA PRIVATE KEY` or `BEGIN PRIVATE KEY`.

Confirm that all four secret names exist (values are never shown):

```bash
bunx wrangler secret list
```

Expected names:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `OPENROUTER_API_KEY`

Delete the downloaded private-key file after confirming the secret is stored,
or move it into an encrypted password manager. GitHub lets you generate a
replacement key if needed.

## 7. Test an automatic review

Open a non-draft PR, or push a new commit to an existing non-draft PR in an
installed repository. Watch logs:

```bash
bunx wrangler tail gaston-pr-reviewer --format pretty
```

In GitHub, verify:

1. The App's **Advanced** page shows a successful `pull_request` webhook.
2. The PR gets a `Gaston review` run-health check and a `Gaston verdict` check.
3. A clean, complete review makes both checks successful without a comment.
4. High-confidence findings appear on changed lines and in one persistent
   summary comment.
5. Pushing another commit cancels stale in-flight work and reviews the full
   cumulative diff at the new head.
6. Commenting `@gaston` or `@gaston review` as an owner, member, or collaborator gets an
   immediate 👀 reaction and creates an on-demand review check for the current head.

For an App created before manual commands were added, open the App's
**Permissions & events** settings, grant **Issues: Read and write**, subscribe to
**Issue comment**, save, and approve the permission update on the installation.

If the webhook fails with 401, the webhook secret differs between GitHub and
Cloudflare. If the check says authentication failed, verify the App ID/private
key and reinstall the App after permission changes. If OpenRouter returns 401,
replace only `OPENROUTER_API_KEY`.

For a quick PR-side diagnosis, run:

```bash
bun run diagnose:pr -- OWNER/REPOSITORY#NUMBER
```

The command inspects every PR commit and top-level manual command, not just the
current head. It reports the command's trust classification and 👀 acknowledgement,
so a missing `issue_comment` delivery is distinct from a queue or review failure.
The deployed App configuration is independently self-auditing:

```bash
curl -fsS https://gaston-pr-reviewer.<your-subdomain>.workers.dev/health/github
```

Every requirement must be `true`; in particular, `issueCommentEvent`,
`issuesWrite`, and `installationsReady` are required for the comment trigger and
its reaction. The installation check prevents an unapproved permission update
from making the App registration look ready when installed copies still have
their old grants. Worker lifecycle
logs are structured by `deliveryId`, repository, PR number, head SHA, trigger,
and outcome for direct filtering in Workers Logs or `wrangler tail`.

## 8. Cost and rollout controls

Start with one or two repositories. Queue concurrency is set to three and each
tool result is bounded. The default `REVIEW_DIRECT_DISCOVERY=false` keeps the
read-only Dynamic Worker terminal and exact repository tools available on every
PR. Discovery gets one broad four-call turn and one targeted two-call follow-up
before tool-disabled finalization; candidate verification still receives
harness-fetched exact anchors. A truncated or invalid result,
an exact-patch coverage shortfall, or an inventory-only first batch can unlock
one focused two-call recovery batch. A new uncovered exact-patch continuation
may unlock one final patch-only batch, under the eight-call phase ceiling.
Verification runs only when discovery returns a changed-line candidate. It
must return one explicit `confirmed`, `refuted`, or `insufficient` verdict per
candidate. Repository evidence is exposed through opaque harness-issued handles,
and terminal verdicts are accepted only for handles that the verifier's own
phase-local coverage ledger marks complete. A successful narrow read can
supersede an earlier broad truncated read of the same file. Discovery reads
cannot satisfy that boundary. Missing or malformed verdicts remain unresolved
rather than becoming silent refutations, and an unresolved candidate forces a
neutral—not successful—terminal check. Every phase and retry shares the default
fourteen-minute, nine-request, 250,000 estimated-input-token, 128,000 output-token,
and $0.20 reported-cost budget. The active resource ledger survives queue
redelivery without counting queue backoff as work. Prompts are capped at 72 KB, individual tool
results at 12 KB, and history is compacted toward 120 KB. Structured inventory
and patch results remain valid JSON with continuation metadata; bounded prose
and file reads use visible head/tail previews. Completed analysis is checkpointed
so publishing retries do not restart inference. Keep
OpenRouter's independent per-key spend limit enabled as defense in depth.
Cloudflare billing here is standard Worker/Queue/Durable Object compute and
SQLite storage—there is no Container or Dynamic Worker allocation.

Tune `wrangler.jsonc` only after observing real reviews:

- Raise `REVIEW_MIN_CONFIDENCE` above its `0.80` default to reduce noise for
  independently verified findings. Completeness is candidate-bound: an
  unrelated unresolved candidate remains unpublished and keeps the overall
  check neutral, but does not raise the threshold for a complete confirmation.
- Set `REVIEW_REASONING_EFFORT=high`, `xhigh`, or `max`; the measured default is
  `max`, and Gaston rejects lower values.
  The final source-frozen effort comparison tested both `xhigh` and `max` on
  the same fresh snapshots; `max` retained the only canonical published bug.
  Rerun a fresh sealed corpus before changing this default.
- Keep `REVIEW_PROVIDER=openai` for the measured default route. If repository
  policy requires zero retention, change it to `azure` and set
  `REVIEW_REQUIRE_ZDR=true` together. The provider controls the output-token
  field, and invalid provider, boolean, or Luna OpenAI+ZDR combinations fail
  before inference. When changing `REVIEW_MODEL`, select and conformance-test
  its provider at the same time rather than retaining the Luna-specific pin.
- Review `REVIEW_MODEL_MAX_OUTPUT_TOKENS` whenever `REVIEW_MODEL` changes; it is
  a per-request policy ceiling, not automatic model-capability discovery.
- Keep `REVIEW_DIRECT_DISCOVERY=false` when repository-wide terminal navigation
  is part of the review strategy. Set it to `true` only for a controlled
  comparison of the shallow complete-diff path, which intentionally skips all
  discovery-time repository tools when the diff fits in the prompt.
- For model slugs that offer an `:exacto` variant, prefer it when tool-call
  reliability matters more than throughput-first routing; the default Luna
  slug has no such suffix, and an explicit OpenRouter provider sort overrides
  a model variant.
- Lower `REVIEW_MAX_COST_USD` or `REVIEW_MAX_MODEL_REQUESTS` to tighten the
  aggregate review budget.
- Do not raise `REVIEW_MAX_WALL_TIME_MS` above fourteen minutes in this Queue
  deployment; Cloudflare caps a consumer invocation at fifteen minutes, and
  Gaston reserves the final minute for setup, publication, and acknowledgement.
- Keep `REQUEST_CHANGES_ON` at `blocker` until the team trusts the bot.
- Add `.gaston/review.md` on the default branch for repository invariants.

After configuration changes:

```bash
bun run check
bun run deploy
```

`bun run check` also runs the historical-manifest validator—which explicitly
skips unless `GASTON_HISTORICAL_CORPUS` is set—and deterministic provider/tool
protocol replays. Those scripted precision/recall
numbers are regression-fixture checks, not evidence of live model quality; use
hidden exact-SHA snapshots with semantic or executable adjudication for quality
comparisons. Require `Gaston verdict`, rather than the run-health check, in a
branch protection rule when Gaston should gate merges. The verdict is green only
when cumulative evidence and prior-thread reconciliation are complete and no
verified finding remains open; infrastructure or truncation hazards end neutral
with coverage details.
