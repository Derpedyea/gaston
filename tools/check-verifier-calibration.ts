interface ExpectedFate {
  candidateId: string;
  verification: string;
  publication: string;
}

const seedPath = process.argv[2] ?? "benchmarks/luna-verifier-calibration.json";
const runPath = process.argv[3];
if (runPath === undefined) {
  throw new Error("usage: bun tools/check-verifier-calibration.ts <seed.json> <run.json>");
}

const seed = await Bun.file(seedPath).json() as {
  results?: Array<{ case?: string; calibrationExpected?: ExpectedFate[] }>;
};
const run = await Bun.file(runPath).json() as {
  results?: Array<{
    case?: string;
    verification?: {
      resolution?: {
        candidateFates?: Array<{
          candidateId?: string;
          verification?: { state?: string };
          publication?: { state?: string };
        }>;
      };
    };
  }>;
};

const failures: string[] = [];
for (const expectedCase of seed.results ?? []) {
  const actualCase = (run.results ?? []).find((entry) => entry.case === expectedCase.case);
  for (const expected of expectedCase.calibrationExpected ?? []) {
    const actual = actualCase?.verification?.resolution?.candidateFates?.find((fate) => (
      fate.candidateId === expected.candidateId
    ));
    if (actual?.verification?.state !== expected.verification) {
      failures.push(`${expectedCase.case}/${expected.candidateId}: expected verification ${expected.verification}, got ${actual?.verification?.state ?? "missing"}`);
    }
    if (actual?.publication?.state !== expected.publication) {
      failures.push(`${expectedCase.case}/${expected.candidateId}: expected publication ${expected.publication}, got ${actual?.publication?.state ?? "missing"}`);
    }
  }
}

const result = { passed: failures.length === 0, failures };
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
