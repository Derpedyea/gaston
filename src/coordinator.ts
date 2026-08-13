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
  /** Optional while coordinator:v1 records written before this field age out. */
  desiredBaseSha?: string;
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
  supersededState?: DurableReviewState;
}

export interface CoordinatorTransaction {
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

      // Queue time decides freshness when it provides a strict order. GitHub
      // delivery IDs are opaque GUIDs, not causal clocks, so equal timestamps
      // deliberately fall through and let the later claimant win the tie.
      if (
        current !== undefined
        && current.desiredQueuedAt.localeCompare(job.queuedAt) > 0
      ) {
        return { accepted: false, generation: current.generation, state: current };
      }

      const generation = (current?.generation ?? 0) + 1;
      const state: DurableReviewState = {
        generation,
        desiredRunKey: runKey,
        desiredBaseSha: job.baseSha,
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
        ...(current === undefined
          ? {}
          : { supersededRunKey: current.desiredRunKey, supersededState: current }),
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
    return this.transitionIfCurrent(runKey, generation, phase, checkRunId);
  }

  /** Atomically mutate related state only while this run owns the durable lease. */
  mutateIfCurrent(
    runKey: string,
    generation: number,
    mutation: (transaction: CoordinatorTransaction) => Promise<void>,
  ): Promise<boolean> {
    return this.#storage.transaction(async (transaction) => {
      const current = await transaction.get<DurableReviewState>(STATE_KEY);
      if (current?.desiredRunKey !== runKey || current.generation !== generation) return false;
      await mutation(transaction);
      return true;
    });
  }

  /** Atomically transition the lease and any caller-owned durable records. */
  transitionIfCurrent(
    runKey: string,
    generation: number,
    phase: ReviewPhase,
    checkRunId?: number,
    mutation?: (transaction: CoordinatorTransaction) => Promise<void>,
  ): Promise<boolean> {
    return this.#storage.transaction(async (transaction) => {
      const current = await transaction.get<DurableReviewState>(STATE_KEY);
      if (current?.desiredRunKey !== runKey || current.generation !== generation) return false;
      await mutation?.(transaction);
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

export interface OwnedOperation<Name extends string> {
  name: Name;
  run(): Promise<void>;
}

/**
 * Decide which in-memory work an accepted claim may interrupt. Durable
 * generations order claimed runs. An unclaimed preparation can be cancelled
 * only when its queue time is strictly older or tied (the later claimant wins
 * ties); a demonstrably newer preparation is left alone to claim afterward.
 */
export function shouldInterruptForAcceptedClaim(
  candidateGeneration: number | undefined,
  candidateQueuedAt: string,
  claimantGeneration: number,
  claimantQueuedAt: string,
): boolean {
  return candidateGeneration === undefined
    ? candidateQueuedAt.localeCompare(claimantQueuedAt) <= 0
    : candidateGeneration < claimantGeneration;
}

export type OwnedOperationsResult<Name extends string> =
  | { status: "completed" }
  | {
    status: "stale";
    operation: Name;
    operationCommitted: boolean;
    /** A rejected request may have committed remotely before ownership was lost. */
    operationMayHaveCommitted?: true;
    operationError?: unknown;
  };

/**
 * Run external side effects one at a time, checking the durable lease both
 * before and after every operation. A resolved operation may already be
 * irretractable when ownership changes, so callers get that distinction for
 * honest logging and must not continue to later operations.
 */
export async function runOwnedOperations<Name extends string>(
  isCurrent: () => Promise<boolean>,
  operations: readonly OwnedOperation<Name>[],
): Promise<OwnedOperationsResult<Name>> {
  for (const operation of operations) {
    if (!(await isCurrent())) {
      return { status: "stale", operation: operation.name, operationCommitted: false };
    }
    try {
      await operation.run();
    } catch (error) {
      // A transport abort/rejection does not prove that a remote write failed
      // to commit. Once the lease is gone, return an explicit ambiguous state
      // so the caller can reconcile using an idempotency marker. If ownership
      // is still live, preserve ordinary error handling and retry semantics.
      if (await isCurrent()) throw error;
      return {
        status: "stale",
        operation: operation.name,
        operationCommitted: false,
        operationMayHaveCommitted: true,
        operationError: error,
      };
    }
    if (!(await isCurrent())) {
      return { status: "stale", operation: operation.name, operationCommitted: true };
    }
  }
  return { status: "completed" };
}
