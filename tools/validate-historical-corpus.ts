import { validateHistoricalCorpus, type HistoricalCorpus } from "../src/historical-corpus.ts";

const corpusPath = process.env.GASTON_HISTORICAL_CORPUS;
if (!corpusPath) {
  console.log(JSON.stringify({
    skipped: true,
    reason: "Set GASTON_HISTORICAL_CORPUS to an ignored .private/evals JSON capture.",
  }, null, 2));
  process.exit(0);
}
const corpus = await Bun.file(corpusPath).json() as HistoricalCorpus;
const report = validateHistoricalCorpus(corpus);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
