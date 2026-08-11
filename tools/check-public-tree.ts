const result = Bun.spawnSync(["git", "ls-files", "-z"]);
if (result.exitCode !== 0) {
  throw new Error(new TextDecoder().decode(result.stderr).trim() || "git ls-files failed");
}

const tracked = new TextDecoder().decode(result.stdout).split("\0").filter(Boolean);
const forbidden = tracked.filter((path) => (
  path === ".private"
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

console.log(JSON.stringify({ passed: true, trackedFiles: tracked.length }));
