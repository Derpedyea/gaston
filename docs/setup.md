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
only authenticated webhook processing needs them.

## 4. Create an OpenRouter key

Create a dedicated key in OpenRouter rather than reusing a broad personal key.
Set a conservative credit limit while testing. Gaston's default model has a
one-million-token context window and current provider pricing on its
[OpenRouter model page](https://openrouter.ai/deepseek/deepseek-v4-flash-0731), but
pricing can change.

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
2. The PR gets a `Gaston review` check.
3. A clean review completes successfully without a comment.
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
tool result is bounded. Discovery has one normal evidence turn, a four-call
tool cap, and a tool-disabled finalization turn. A truncated result or invalid
tool payload can unlock exactly one focused two-call recovery turn. Verification runs only when discovery
returns a changed-line candidate. Every phase and retry shares the default
fourteen-minute, nine-request, 250,000 estimated-input-token, 128,000 output-token,
and $0.20 reported-cost budget. The active resource ledger survives queue
redelivery without counting queue backoff as work. Prompts are capped at 72 KB, individual tool
results at 12 KB with visible head/tail previews, and history is compacted
toward 120 KB. Completed analysis is checkpointed so publishing retries do not restart inference. Keep
OpenRouter's independent per-key spend limit enabled as defense in depth.
Cloudflare billing here is standard Worker/Queue/Durable Object compute and
SQLite storage—there is no Container or Dynamic Worker allocation.

Tune `wrangler.jsonc` only after observing real reviews:

- Raise `REVIEW_MIN_CONFIDENCE` to reduce noise.
- Keep `REVIEW_REASONING_EFFORT=high`; Gaston rejects lower values so every
  discovery, verification, finalization, repair, and retry uses high reasoning.
- Review `REVIEW_MODEL_MAX_OUTPUT_TOKENS` whenever `REVIEW_MODEL` changes; it is
  a per-request policy ceiling, not automatic model-capability discovery.
- Keep the `:exacto` variant when tool-call reliability matters more than
  throughput-first routing; an explicit OpenRouter provider sort overrides it.
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

`bun run check` also validates the 25-PR historical corpus and runs deterministic
provider/tool replays with precision, recall, p95 request, p95 tool-call, and
p95 cost gates. A clean GitHub check is emitted only when the evidence ledger is
complete; infrastructure or truncation hazards end neutral with coverage details.
