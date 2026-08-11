import { describe, expect, it } from "vitest";

import { LatestHeadCoordinator, type CoordinatorStorage } from "../src/coordinator.ts";
import type { ReviewJob } from "../src/types.ts";

describe("LatestHeadCoordinator", () => {
  it("persists a latest-head doorbell across coordinator instances", async () => {
    const storage = new MemoryCoordinatorStorage();
    const first = new LatestHeadCoordinator(storage, () => 10);
    const old = await first.claim(job("a", "2026-08-10T01:00:00.000Z", "old"), "run:old", 1);
    await first.markPhase("run:old", old.generation, "discovery", 1);

    const afterRestart = new LatestHeadCoordinator(storage, () => 20);
    const latest = await afterRestart.claim(job("b", "2026-08-10T01:01:00.000Z", "new"), "run:new", 2);

    expect(latest).toMatchObject({ accepted: true, generation: 2, supersededRunKey: "run:old" });
    await expect(afterRestart.isCurrent("run:old", old.generation)).resolves.toBe(false);
    await expect(afterRestart.isCurrent("run:new", latest.generation)).resolves.toBe(true);
    await expect(afterRestart.markPhase("run:old", old.generation, "publishing", 1)).resolves.toBe(false);
    expect(await afterRestart.state()).toMatchObject({
      desiredHeadSha: "b".repeat(40),
      desiredRunKey: "run:new",
      phase: "queued",
      checkRunId: 2,
    });
  });

  it("rejects a delayed older delivery for the same confirmed head", async () => {
    const storage = new MemoryCoordinatorStorage();
    const coordinator = new LatestHeadCoordinator(storage);
    const latest = await coordinator.claim(
      job("b", "2026-08-10T02:00:00.000Z", "delivery-2"),
      "manual:delivery-2",
      2,
    );
    const delayed = await coordinator.claim(
      job("b", "2026-08-10T01:00:00.000Z", "delivery-1"),
      "automatic:delivery-1",
      1,
    );

    expect(latest.accepted).toBe(true);
    expect(delayed).toMatchObject({ accepted: false, generation: latest.generation });
    expect((await coordinator.state())?.desiredRunKey).toBe("manual:delivery-2");
  });

  it("makes a queue redelivery for the same run idempotent", async () => {
    const storage = new MemoryCoordinatorStorage();
    const coordinator = new LatestHeadCoordinator(storage);
    const review = job("b", "2026-08-10T01:00:00.000Z", "delivery");
    const first = await coordinator.claim(review, "run", 4);
    const duplicate = await coordinator.claim(review, "run", 4);

    expect(duplicate).toEqual(first);
    expect(duplicate.generation).toBe(1);
  });
});

class MemoryCoordinatorStorage implements CoordinatorStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async transaction<T>(closure: (transaction: CoordinatorStorage) => Promise<T>): Promise<T> {
    return closure(this);
  }
}

function job(head: string, queuedAt: string, deliveryId: string): ReviewJob {
  return {
    deliveryId,
    installationId: 1,
    owner: "example",
    repo: "repository",
    pullNumber: 42,
    title: "Example change",
    body: "",
    baseRef: "main",
    baseSha: "0".repeat(40),
    headSha: head.repeat(40),
    queuedAt,
    trigger: "automatic",
  };
}
