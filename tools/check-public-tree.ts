const result = Bun.spawnSync(["git", "ls-files", "-z"]);
if (result.exitCode !== 0) {
  throw new Error(new TextDecoder().decode(result.stderr).trim() || "git ls-files failed");
}

const tracked = new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
const forbidden = tracked.filter((path) => (
  path === ".env"
  || path.startsWith(".env.")
  || path === ".dev.vars"
  || path.startsWith(".dev.vars.")
  || path === ".firecrawl"
  || path.startsWith(".firecrawl/")
  || path === ".private"
  || path.startsWith(".private/")
  || /(?:^|\/)historical-prs\.json$/i.test(path)
));

if (forbidden.length > 0) {
  throw new Error(
    "Private historical eval artifacts are tracked by Git:\n"
    + forbidden.map((path) => `- ${path}`).join("\n")
    + "\nMove them under the ignored .private/evals/ directory.",
  );
}

const credentialPatterns = [
  { name: "OpenRouter API key", pattern: /sk-or-v1-[A-Za-z0-9_-]{32,}/ },
  { name: "GitHub token", pattern: /(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,})/ },
  { name: "assigned OpenRouter secret", pattern: /OPENROUTER_API_KEY\s*=\s*[^\s"'`$<{][^\s]*/ },
] as const;
const leaked: string[] = [];
for (const path of tracked) {
  const content = await Bun.file(path).text().catch(() => "");
  for (const credential of credentialPatterns) {
    if (credential.pattern.test(content)) leaked.push(`${path}: ${credential.name}`);
  }
}
if (leaked.length > 0) {
  throw new Error(
    "Potential credentials are present in tracked files:\n"
    + leaked.map((entry) => `- ${entry}`).join("\n"),
  );
}

console.log(JSON.stringify({ passed: true, trackedFiles: tracked.length }));
