import { Reviewer, WorkspaceProxy } from "./reviewer.ts";
import { getGitHubAppReadiness, GitHubClient } from "./github.ts";
import { errorMessage, logError, logInfo } from "./log.ts";
import { manualReviewJob } from "./review-job.ts";
import { reviewRetryDelaySeconds, shouldRetryReviewError } from "./retry.ts";
import { handleReviewSessionApi } from "./session-api.ts";
import type { Env, ManualReviewRequest, ReviewJob, ReviewOutcome, ReviewQueueMessage } from "./types.ts";
import { handleGitHubWebhook } from "./webhook.ts";

export { Reviewer, WorkspaceProxy };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }
    if (url.pathname === "/health/github") {
      try {
        const readiness = await getGitHubAppReadiness(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);
        return Response.json(readiness, {
          status: readiness.ok ? 200 : 503,
          headers: { "cache-control": "no-store" },
        });
      } catch (error) {
        logError("health.github_failed", { error: errorMessage(error) });
        return Response.json({ ok: false, error: "GitHub App readiness check failed" }, {
          status: 503,
          headers: { "cache-control": "no-store" },
        });
      }
    }
    if (url.pathname.startsWith("/api/reviews/")) return handleReviewSessionApi(request, env);
    if (url.pathname === "/webhooks/github") return handleGitHubWebhook(request, env, ctx);
    return new Response("not found", { status: 404 });
  },

  async queue(batch: MessageBatch<ReviewQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const request = message.body;
      try {
        logInfo("queue.received", {
          messageId: message.id,
          attempt: message.attempts,
          deliveryId: request.deliveryId,
          installationId: request.installationId,
          owner: request.owner,
          repo: request.repo,
          pullNumber: request.pullNumber,
          trigger: isManualReviewRequest(request) ? "manual" : request.trigger,
        });
        const job = {
          ...(await resolveReviewJob(request, env)),
          dashboardUrl: request.dashboardUrl ?? env.DASHBOARD_URL,
          queueAttempt: message.attempts,
        };
        const generation = env.REVIEWER_GENERATION ?? "1";
        const name = `${generation}:${job.owner}/${job.repo}#${job.pullNumber}`;
        const stub = env.REVIEWER.get(env.REVIEWER.idFromName(name)) as unknown as {
          review(input: ReviewJob): Promise<ReviewOutcome>;
        };
        const outcome = await stub.review(job);
        message.ack();
        logInfo("queue.completed", {
          messageId: message.id,
          attempt: message.attempts,
          deliveryId: job.deliveryId,
          owner: job.owner,
          repo: job.repo,
          pullNumber: job.pullNumber,
          headSha: job.headSha,
          trigger: job.trigger,
          outcome: outcome.status,
          findings: outcome.findings,
        });
      } catch (error) {
        const retrying = shouldRetryReviewError(error);
        logError("queue.failed", {
          messageId: message.id,
          attempt: message.attempts,
          deliveryId: request.deliveryId,
          owner: request.owner,
          repo: request.repo,
          pullNumber: request.pullNumber,
          trigger: isManualReviewRequest(request) ? "manual" : request.trigger,
          error: errorMessage(error),
          retrying,
        });
        if (retrying) {
          message.retry({ delaySeconds: reviewRetryDelaySeconds(message.attempts) });
        } else {
          message.ack();
        }
      }
    }
  },
} satisfies ExportedHandler<Env, ReviewQueueMessage>;

async function resolveReviewJob(request: ReviewQueueMessage, env: Env): Promise<ReviewJob> {
  if (!isManualReviewRequest(request)) return request;
  const github = await GitHubClient.forInstallation(
    env.GITHUB_APP_ID,
    env.GITHUB_PRIVATE_KEY,
    request.installationId,
  );
  const pull = await github.getPullByNumber(request.owner, request.repo, request.pullNumber);
  return manualReviewJob(request, pull);
}

function isManualReviewRequest(request: ReviewQueueMessage): request is ManualReviewRequest {
  return "kind" in request && request.kind === "manual";
}
