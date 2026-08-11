export interface HistoricalPullRequestFixture {
  repository: string;
  number: number;
  title: string;
  state: string;
  baseRefName: string;
  baseRefOid: string;
  headRefOid: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  heads: string[];
  fileCount: number;
  labels: { mustFind: string[]; mustNotFind: string[] };
}

export interface HistoricalCorpus {
  capturedAt: string;
  source: string;
  pullRequests: HistoricalPullRequestFixture[];
}

export interface HistoricalCorpusReport {
  passed: boolean;
  failures: string[];
  pullRequests: number;
  headTransitions: number;
  labeledPullRequests: number;
}

export function validateHistoricalCorpus(corpus: HistoricalCorpus, minimumPullRequests = 25): HistoricalCorpusReport {
  const failures: string[] = [];
  const seen = new Set<string>();
  let headTransitions = 0;
  let labeledPullRequests = 0;
  if (corpus.pullRequests.length < minimumPullRequests) {
    failures.push(`historical corpus has ${corpus.pullRequests.length} PRs; expected at least ${minimumPullRequests}`);
  }
  for (const pull of corpus.pullRequests) {
    const key = `${pull.repository}#${pull.number}`;
    if (seen.has(key)) failures.push(`duplicate historical fixture: ${key}`);
    seen.add(key);
    if (pull.heads.length === 0) failures.push(`${key} has no commit heads`);
    if (pull.heads.at(-1) !== pull.headRefOid) failures.push(`${key} final head does not match headRefOid`);
    if (!/^[a-f0-9]{40}$/.test(pull.baseRefOid) || !/^[a-f0-9]{40}$/.test(pull.headRefOid)) {
      failures.push(`${key} contains an invalid commit SHA`);
    }
    if (pull.fileCount < 1) failures.push(`${key} contains no changed files`);
    headTransitions += Math.max(0, pull.heads.length - 1);
    if (pull.labels.mustFind.length > 0 || pull.labels.mustNotFind.length > 0) labeledPullRequests++;
  }
  if (!corpus.pullRequests.some((pull) => pull.heads.length > 1)) {
    failures.push("historical corpus must retain at least one multi-commit head sequence");
  }
  if (labeledPullRequests === 0) failures.push("historical corpus has no verified finding labels");
  return {
    passed: failures.length === 0,
    failures,
    pullRequests: corpus.pullRequests.length,
    headTransitions,
    labeledPullRequests,
  };
}
