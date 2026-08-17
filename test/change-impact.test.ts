import { describe, expect, it, vi } from "vitest";
import {
  buildChangeImpactMap,
  changeSetForLane,
  selectRiskLanes,
} from "../src/change-impact.ts";
import type { PullChangeSet } from "../src/types.ts";

describe("change-impact routing", () => {
  it("selects a bounded deterministic set of risk lanes", () => {
    const lanes = selectRiskLanes(changes());

    expect(lanes).toHaveLength(2);
    expect(lanes.map((lane) => lane.id)).toContain("auth-security");
    expect(lanes.every((lane) => lane.paths.length > 0)).toBe(true);
  });

  it("maps changed symbols to bounded references without treating them as evidence", async () => {
    const search = vi.fn(async (query: string) => JSON.stringify({
      matches: [
        { path: "src/caller.ts", line: 9 },
        { path: "src/auth.ts", line: 1 },
      ],
      query,
    }));

    const impact = await buildChangeImpactMap(changes(), { search });

    expect(search).toHaveBeenCalled();
    expect(impact.searchComplete).toBe(true);
    expect(impact.symbols).toContainEqual(expect.objectContaining({
      symbol: "authorizeRequest",
      changedPaths: ["src/auth.ts"],
      references: [{ path: "src/caller.ts", line: 9 }],
    }));
  });

  it("narrows a lane prompt while retaining cumulative truncation hazards", () => {
    const source = changes();
    source.filesTruncated = true;
    const lane = selectRiskLanes(source).find((candidate) => candidate.id === "auth-security")!;

    const narrowed = changeSetForLane(source, lane);

    expect(narrowed.files.map((file) => file.path)).toEqual(["src/auth.ts"]);
    expect(narrowed.filesTruncated).toBe(true);
    expect(narrowed.truncated).toBe(true);
  });
});

function changes(): PullChangeSet {
  const files = [
    {
      path: "src/auth.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      patch: "@@ -1 +1,2 @@\n-export const authorizeRequest = deny\n+export const authorizeRequest = allow\n+const token = request.headers.get('authorization')",
    },
    {
      path: "src/state.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-await transaction.commit()\n+queue.retry(transaction)",
    },
  ];
  return {
    files,
    diff: files.map((file) => file.patch).join("\n"),
    truncated: false,
    filesTruncated: false,
    diffTruncated: false,
    unavailablePatchPaths: [],
  };
}
