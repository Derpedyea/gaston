import { describe, expect, it, vi } from "vitest";

import { withCheckpoint } from "../src/checkpoint.ts";

describe("review checkpoints", () => {
  it("reuses completed work after a later retry", async () => {
    const values = new Map<string, unknown>();
    const compute = vi.fn(async () => ({ source: "specialist:behavior", review: { summary: "done", findings: [] } }));
    const get = async () => values.get("lens") as Awaited<ReturnType<typeof compute>> | undefined;
    const put = async (value: Awaited<ReturnType<typeof compute>>) => {
      values.set("lens", value);
    };

    await expect(withCheckpoint(get, put, compute)).resolves.toEqual({
      value: { source: "specialist:behavior", review: { summary: "done", findings: [] } },
      cached: false,
    });
    await expect(withCheckpoint(get, put, compute)).resolves.toEqual({
      value: { source: "specialist:behavior", review: { summary: "done", findings: [] } },
      cached: true,
    });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("does not save failed work", async () => {
    const put = vi.fn(async () => undefined);

    await expect(withCheckpoint(
      async () => undefined,
      put,
      async () => {
        throw new Error("provider failed");
      },
    )).rejects.toThrow("provider failed");
    expect(put).not.toHaveBeenCalled();
  });
});
