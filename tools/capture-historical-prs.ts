import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const [repository = "", rawLimit = "25"] = process.argv.slice(2);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error("usage: bun tools/capture-historical-prs.ts OWNER/REPO [LIMIT]");
}
const limit = Math.max(1, Math.min(50, Number.parseInt(rawLimit, 10) || 25));
const [owner, name] = repository.split("/") as [string, string];
const query = `query($owner:String!,$name:String!,$limit:Int!) {
  repository(owner:$owner,name:$name) {
    pullRequests(last:$limit,orderBy:{field:CREATED_AT,direction:ASC}) {
      nodes {
        number title state baseRefName baseRefOid headRefOid url createdAt updatedAt
        commits(first:100) { nodes { commit { oid } } }
        files(first:1) { totalCount }
      }
    }
  }
}`;
const processResult = Bun.spawnSync([
  "gh", "api", "graphql",
  "-f", `query=${query}`,
  "-F", `owner=${owner}`,
  "-F", `name=${name}`,
  "-F", `limit=${limit}`,
]);
if (processResult.exitCode !== 0) {
  throw new Error(new TextDecoder().decode(processResult.stderr));
}
const response = JSON.parse(new TextDecoder().decode(processResult.stdout)) as {
  data: { repository: { pullRequests: { nodes: Array<Record<string, unknown>> } } };
};
const pullRequests = response.data.repository.pullRequests.nodes.map((pull) => {
  const commits = pull.commits as { nodes: Array<{ commit: { oid: string } }> };
  const files = pull.files as { totalCount: number };
  const { commits: _commits, files: _files, ...metadata } = pull;
  return {
    repository,
    ...metadata,
    heads: commits.nodes.map((node) => node.commit.oid),
    fileCount: files.totalCount,
    labels: { mustFind: [], mustNotFind: [] },
  };
});
const corpus = JSON.stringify({
  capturedAt: new Date().toISOString(),
  source: "GitHub GraphQL snapshot; labels require human verification",
  pullRequests,
}, null, 2);
const outputDirectory = resolve(".private/evals");
const outputPath = resolve(outputDirectory, `${owner}-${name}-historical-prs.json`);
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await Bun.write(outputPath, `${corpus}\n`);
console.log(`Wrote ${pullRequests.length} private PR records to ${outputPath}`);
console.log("The .private/ directory is ignored by Git and must stay private.");
