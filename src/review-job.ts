import type { PullRequestState } from "./github.ts";
import type { ManualReviewRequest, ReviewJob } from "./types.ts";

export function manualReviewJob(request: ManualReviewRequest, pull: PullRequestState): ReviewJob {
  if (
    !Number.isInteger(pull.number) ||
    pull.number !== request.pullNumber ||
    !pull.base.ref?.trim() ||
    !isSha(pull.base.sha) ||
    !isSha(pull.head.sha)
  ) {
    throw new Error("GitHub returned an invalid pull request while resolving a manual review");
  }
  return {
    deliveryId: request.deliveryId,
    installationId: request.installationId,
    owner: request.owner,
    repo: request.repo,
    pullNumber: request.pullNumber,
    title: (pull.title ?? "").slice(0, 1_000),
    body: (pull.body ?? "").slice(0, 20_000),
    baseRef: pull.base.ref.trim(),
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    queuedAt: request.queuedAt,
    trigger: "manual",
    requestedBy: request.requestedBy,
  };
}

function isSha(value: string): boolean {
  return /^[a-f0-9]{40}$/i.test(value);
}
