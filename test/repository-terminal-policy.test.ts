import { describe, expect, it } from "vitest";

import { validateRepositoryTerminalCommand } from "../src/repository-terminal-policy.ts";

describe("repository terminal command policy", () => {
  it.each([
    "rg -n 'validator|schema' src test | head -n 80",
    "find src -type f -name '*.ts' | sort",
    "sed -n '20,80p' src/reviewer.ts",
    "awk '/validate/ { print NR, $0 }' src/check.ts",
    "grep -R 'price$' src",
    "jq '.scripts' package.json",
  ])("allows a bounded read pipeline: %s", (command) => {
    expect(validateRepositoryTerminalCommand(command)).toBe(command);
  });

  it.each([
    "source scripts/review.sh",
    "bash scripts/review.sh",
    "npm test",
    "rg needle > result.txt",
    "rg needle; rm -rf src",
    "rg needle && cat src/a.ts",
    "cat $(find src -type f)",
    "cat `find src -type f`",
    "find src -type f -delete",
    "find src -type f -exec cat {} \\;",
    "find src -type f '-exec' cat {} \\;",
    "find src -type f -ex\\ec cat {} \\;",
    "awk 'BEGIN { system(\"cat package.json\") }' package.json",
    "awk -f scripts/report.awk package.json",
    "awk '{ command | getline result }' package.json",
    "sed -f scripts/report.sed package.json",
    "jq --from-file scripts/report.jq package.json",
    "rg --pre 'bash scripts/prepare.sh' needle src",
    "rg needle || cat src/a.ts",
    "rg needle | | head",
    "while true; do rg needle; done",
  ])("rejects execution or mutation syntax: %s", (command) => {
    expect(() => validateRepositoryTerminalCommand(command)).toThrow();
  });

  it("allows shell metacharacters when they are inert quoted search text", () => {
    expect(validateRepositoryTerminalCommand("rg 'left;right|center' src"))
      .toBe("rg 'left;right|center' src");
  });
});
