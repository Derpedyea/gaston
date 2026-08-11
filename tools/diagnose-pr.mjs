const target = process.argv[2] ?? "";
const parsed = parseTarget(target);
if (!parsed) {
  throw new Error("usage: bun tools/diagnose-pr.mjs OWNER/REPO#NUMBER (or a GitHub pull request URL)");
}

const headers = {
  accept: "application/vnd.github+json",
  "user-agent": "gaston-pr-diagnostics",
  "x-github-api-version": "2026-03-10",
};
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (token) headers.authorization = `Bearer ${token}`;

const pull = await github(`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.pullNumber}`);
const [commits, issueComments, reviews] = await Promise.all([
  github(`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.pullNumber}/commits?per_page=100`),
  github(`/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.pullNumber}/comments?per_page=100`),
  github(`/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.pullNumber}/reviews?per_page=100`),
]);
const rows = [];
for (const commit of commits) {
  const checks = await github(`/repos/${parsed.owner}/${parsed.repo}/commits/${commit.sha}/check-runs?per_page=100`);
  const gaston = checks.check_runs.filter((check) => (
    check.name === "Gaston review" || check.app?.slug?.toLowerCase().includes("gaston")
  ));
  rows.push({ sha: commit.sha, date: commit.commit?.committer?.date, gaston });
}

const current = rows.find((row) => row.sha === pull.head.sha);
const currentChecks = current?.gaston ?? [];
const currentActive = currentChecks.filter((check) => check.status !== "completed");
const latestCurrent = [...currentChecks].sort((left, right) => (
  Date.parse(right.started_at ?? right.created_at ?? 0) - Date.parse(left.started_at ?? left.created_at ?? 0)
))[0];
const olderActive = rows.flatMap((row) => row.sha === pull.head.sha
  ? []
  : row.gaston.filter((check) => check.status !== "completed").map((check) => ({ row, check })));
const manualCommands = issueComments
  .filter((comment) => isManualCommand(comment.body ?? ""))
  .map((comment) => ({
    id: comment.id,
    createdAt: comment.created_at,
    user: comment.user?.login ?? "unknown",
    association: comment.author_association ?? "NONE",
    trusted: ["OWNER", "MEMBER", "COLLABORATOR"].includes(comment.author_association ?? "")
      && comment.user?.type !== "Bot",
    eyes: comment.reactions?.eyes ?? 0,
  }))
  .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
const latestManual = manualCommands[0];
const latestGastonActivityAt = latestTimestamp([
  ...rows.flatMap((row) => row.gaston.flatMap((check) => [check.created_at, check.started_at, check.completed_at])),
  ...reviews
    .filter((review) => review.user?.login?.toLowerCase().includes("gaston"))
    .map((review) => review.submitted_at),
]);

console.log(`PR: https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.pullNumber}`);
console.log(`State: ${pull.state}${pull.draft ? " (draft — automatic review is intentionally skipped)" : ""}`);
console.log(`Base: ${pull.base.ref} @ ${pull.base.sha.slice(0, 12)}`);
console.log(`Head: ${pull.head.ref} @ ${pull.head.sha.slice(0, 12)}`);
if (latestManual) {
  console.log(
    `Latest manual command: comment ${latestManual.id} by ${latestManual.user} at ${latestManual.createdAt}`
    + ` — association ${latestManual.association}, trusted ${latestManual.trusted ? "yes" : "no"}, eyes ${latestManual.eyes}`,
  );
} else {
  console.log("Latest manual command: none found among top-level PR conversation comments");
}
console.log("Gaston checks by commit:");
for (const row of rows) {
  const marker = row.sha === pull.head.sha ? "current" : "older";
  if (row.gaston.length === 0) {
    console.log(`  ${row.sha.slice(0, 12)} (${marker}): none`);
    continue;
  }
  for (const check of row.gaston) {
    console.log(
      `  ${row.sha.slice(0, 12)} (${marker}): ${check.status}/${check.conclusion ?? "pending"}`
      + ` — ${check.output?.title ?? check.name} [check ${check.id}]`
      + (check.html_url ? ` ${check.html_url}` : ""),
    );
    const timing = [check.started_at && `started ${check.started_at}`, check.completed_at && `finished ${check.completed_at}`]
      .filter(Boolean)
      .join(", ");
    if (timing) console.log(`    ${timing}`);
    if (check.status !== "completed") {
      const activeSince = check.started_at ?? check.created_at;
      if (activeSince) console.log(`    ${check.started_at ? "active" : "queued"} for ${formatDuration(Date.now() - Date.parse(activeSince))}`);
    }
    const summary = check.output?.summary?.replace(/\s+/g, " ").trim();
    if (summary) console.log(`    ${summary.slice(0, 300)}`);
  }
}

if (currentActive.length > 0) {
  if (currentActive.length > 1) {
    console.log(`Warning: ${currentActive.length} Gaston checks are active on the same current head; inspect duplicate queue deliveries.`);
  }
  const longestMs = Math.max(...currentActive.map((check) => Date.now() - Date.parse(check.started_at ?? Date.now())));
  if (longestMs > 4 * 60_000) {
    console.log(
      "Diagnosis: Gaston is active beyond the default four-minute review budget. "
      + "Verify the deployed version and inspect agent.budget_reserved/model_response logs for the head SHA.",
    );
    process.exitCode = 2;
  } else {
    console.log("Diagnosis: Gaston is actively processing the current head within its configured wall-clock budget.");
  }
} else if (latestManual?.trusted && latestManual.eyes === 0 && (
  !latestGastonActivityAt || Date.parse(latestManual.createdAt) > Date.parse(latestGastonActivityAt)
)) {
  console.log(
    "Diagnosis: GitHub contains a valid trusted manual command newer than Gaston's latest activity, but Gaston neither acknowledged it nor started later review activity. "
    + "The issue_comment webhook was probably not delivered. Verify /health/github, then enable the GitHub App's Issue comment event "
    + "and approve Issues: Read and write on the installation.",
  );
  process.exitCode = 2;
} else if (latestManual && !latestManual.trusted) {
  console.log(
    `Diagnosis: the latest manual command was intentionally ignored because author association ${latestManual.association} is not trusted.`,
  );
  process.exitCode = 2;
} else if (latestCurrent?.conclusion === "cancelled") {
  console.log(
    "Diagnosis: the newest current-head check was cancelled and no replacement is active. "
    + "A delayed older queue delivery may have superseded it; inspect review.cancellation_requested logs and requeue the current head.",
  );
  process.exitCode = 2;
} else if (latestCurrent?.conclusion === "failure") {
  console.log("Diagnosis: the newest current-head review failed; its check summary above contains the terminal error.");
  process.exitCode = 2;
} else if (latestCurrent?.conclusion === "success") {
  console.log("Diagnosis: Gaston completed the current head successfully.");
} else if (latestCurrent?.status === "completed" && latestCurrent?.conclusion === "neutral") {
  console.log(
    latestCurrent.output?.title === "Review stopped at resource budget"
      ? "Diagnosis: Gaston stopped the current-head review safely at its configured resource budget."
      : latestCurrent.output?.title === "Review evidence incomplete"
        ? "Diagnosis: Gaston finished neutral because evidence was truncated or unavailable; this is intentionally not a clean-review assertion."
        : "Diagnosis: Gaston completed the current head with one or more review findings.",
  );
} else if (olderActive.length > 0) {
  console.log(
    "Diagnosis: an older head is still active while the current head has no check. "
    + "This is the legacy head-of-line visibility bug; deploy the superseding-review scheduler.",
  );
  process.exitCode = 2;
} else if (pull.draft) {
  console.log("Diagnosis: the PR is a draft, so Gaston intentionally ignored it.");
} else {
  console.log(
    "Diagnosis: no Gaston check exists on the current head. Check GitHub App webhook deliveries for "
    + "pull_request and query Worker logs by deliveryId.",
  );
  process.exitCode = 2;
}

if (olderActive.length > 0 && currentChecks.length > 0) {
  console.log(`Warning: ${olderActive.length} older-head Gaston check(s) remain active; generation 11 should cancel them on the next delivery.`);
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
}

function isManualCommand(body) {
  return /(?:^|\r?\n)\s*@gaston(?:-derpedyea-reviewer(?:\[bot\])?)?(?:\s+(?:full\s+)?review)?\s*(?=$|\r?\n)/i.test(body);
}

function latestTimestamp(values) {
  return values.filter(Boolean).sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function parseTarget(value) {
  const url = value.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i);
  const shorthand = value.match(/^([^/#]+)\/([^#]+)#(\d+)$/);
  const match = url ?? shorthand;
  return match ? { owner: match[1], repo: match[2], pullNumber: Number(match[3]) } : null;
}

async function github(path) {
  if (!token) {
    const child = Bun.spawn(["gh", "api", path], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`gh api ${path} failed: ${stderr.trim().slice(0, 500)}`);
    return JSON.parse(stdout);
  }
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${path} failed (${response.status}): ${body.slice(0, 500)}`);
  }
  return response.json();
}
