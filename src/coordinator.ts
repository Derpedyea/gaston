import type { ReviewJob } from "./types.ts";

export type ReviewPhase =
  | "queued"
  | "starting"
  | "discovery"
  | "verification"
  | "publishing"
  | "completed"
  | "interrupted"
  | "superseded";

export interface DurableReviewState {
  generation: number;
  desiredRunKey: string;
  desiredHeadSha: string;
  desiredDeliveryId: string;
  desiredQueuedAt: string;
  phase: ReviewPhase;
  checkRunId: number;
  updatedAt: number;
}

export interface ReviewClaim {
  accepted: boolean;
  generation: number;
  state: DurableReviewState;
  supersededRunKey?: string;
}

interface CoordinatorTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface CoordinatorStorage extends CoordinatorTransaction {
  transaction<T>(closure: (transaction: CoordinatorTransaction) => Promise<T>): Promise<T>;
}

const STATE_KEY = "coordinator:v1";

/** Durable latest-request-wins state for one pull request Durable Object. */
export class LatestHeadCoordinator {
  readonly #storage: CoordinatorStorage;
  readonly #now: () => number;

  constructor(storage: CoordinatorStorage, now: () => number = Date.now) {
    this.#storage = storage;
    this.#now = now;
  }

  claim(job: ReviewJob, runKey: string, checkRunId: number): Promise<ReviewClaim> {
    return this.#storage.transaction(async (transaction) => {
      const current = await transaction.get<DurableReviewState>(STATE_KEY);
      if (current?.desiredRunKey === runKey) {
        return { accepted: true, generation: current.generation, state: current };
      }

      // A delayed duplicate for the same GitHub head must not displace a newer
      // manual or automatic request that has already been persisted.
      if (
        current?.desiredHeadSha === job.headSha
        && compareRequestOrder(current.desiredQueuedAt, current.desiredDeliveryId, job.queuedAt, job.deliveryId) > 0
      ) {
        return { accepted: false, generation: current.generation, state: current };
      }

      const generation = (current?.generation ?? 0) + 1;
      const state: DurableReviewState = {
        generation,
        desiredRunKey: runKey,
        desiredHeadSha: job.headSha,
        desiredDeliveryId: job.deliveryId,
        desiredQueuedAt: job.queuedAt,
        phase: "queued",
        checkRunId,
        updatedAt: this.#now(),
      };
      await transaction.put(STATE_KEY, state);
      return {
        accepted: true,
        generation,
        state,
        ...(current === undefined ? {} : { supersededRunKey: current.desiredRunKey }),
      };
    });
  }

  async isCurrent(runKey: string, generation: number): Promise<boolean> {
    const state = await this.#storage.get<DurableReviewState>(STATE_KEY);
    return state?.desiredRunKey === runKey && state.generation === generation;
  }

  markPhase(
    runKey: string,
    generation: number,
    phase: ReviewPhase,
    checkRunId?: number,
  ): Promise<boolean> {
    return this.#storage.transaction(async (transaction) => {
      const current = await transaction.get<DurableReviewState>(STATE_KEY);
      if (current?.desiredRunKey !== runKey || current.generation !== generation) return false;
      await transaction.put(STATE_KEY, {
        ...current,
        phase,
        checkRunId: checkRunId ?? current.checkRunId,
        updatedAt: this.#now(),
      });
      return true;
    });
  }

  state(): Promise<DurableReviewState | undefined> {
    return this.#storage.get(STATE_KEY);
  }
}

function compareRequestOrder(
  currentQueuedAt: string,
  currentDeliveryId: string,
  nextQueuedAt: string,
  nextDeliveryId: string,
): number {
  const time = currentQueuedAt.localeCompare(nextQueuedAt);
  return time === 0 ? currentDeliveryId.localeCompare(nextDeliveryId) : time;
}
