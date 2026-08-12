import { GitHubClient } from "./github.ts";
import { errorMessage, logInfo, logWarn } from "./log.ts";
import {
  type Env,
  type IssueCommentWebhook,
  type ManualReviewRequest,
  type PullRequestWebhook,
  REVIEW_ACTIONS,
  type ReviewJob,
  type ReviewQueueMessage,
} from "./types.ts";

const MAX_WEBHOOK_BYTES = 2_000_000;
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const MANUAL_REVIEW_COMMAND = /(?:^|\r?\n)\s*@gaston(?:-derpedyea-reviewer(?:\[bot\])?)?(?:\s+(?:full\s+)?review)?\s*(?=$|\r?\n)/i;

type WebhookExecutionContext = Pick<ExecutionContext, "waitUntil">;

export async function handleGitHubWebhook(
  request: Request,
  env: Env,
  context?: WebhookExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") return response("method not allowed", 405, { allow: "POST" });

  const deliveryId = request.headers.get("x-github-delivery")?.trim();
  const event = request.headers.get("x-github-event")?.trim();
  const signature = request.headers.get("x-hub-signature-256")?.trim();
  if (!deliveryId || !event || !signature) return response("missing GitHub headers", 400);

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    logWarn("webhook.rejected", { deliveryId, githubEvent: event, reason: "payload_too_large" });
    return response("payload too large", 413);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_WEBHOOK_BYTES) {
    logWarn("webhook.rejected", { deliveryId, githubEvent: event, reason: "payload_too_large" });
    return response("payload too large", 413);
  }
  if (!(await verifyWebhookSignature(body, signature, env.GITHUB_WEBHOOK_SECRET))) {
    logWarn("webhook.rejected", { deliveryId, githubEvent: event, reason: "invalid_signature" });
    return response("invalid signature", 401);
  }

  if (event === "ping") {
    logInfo("webhook.ping", { deliveryId });
    return json({ ok: true, event: "ping" });
  }
  if (event !== "pull_request" && event !== "issue_comment") {
    logInfo("webhook.ignored", { deliveryId, githubEvent: event, reason: "event_ignored" });
    return json({ accepted: false, reason: "event ignored" }, 202);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return response("invalid JSON", 400);
  }

  const dashboardUrl = new URL(request.url).origin;
  const message: ReviewQueueMessage | null = event === "pull_request"
    ? toReviewJob(payload as PullRequestWebhook, deliveryId, dashboardUrl)
    : toManualReviewRequest(payload as IssueCommentWebhook, deliveryId, dashboardUrl);
  if (!message) {
    logInfo("webhook.ignored", {
      deliveryId,
      githubEvent: event,
      reason: event === "pull_request" ? "action_draft_or_payload" : "comment_not_authorized_or_not_command",
    });
    return json({ accepted: false, reason: "action, command, draft, or payload ignored" }, 202);
  }

  await env.REVIEW_QUEUE.send(message, { contentType: "json" });
  if ("kind" in message) {
    const acknowledgement = acknowledgeManualReview(message, env);
    if (context) context.waitUntil(acknowledgement);
    else await acknowledgement;
  }
  logInfo("webhook.accepted", {
    deliveryId,
    installationId: message.installationId,
    githubEvent: event,
    trigger: "kind" in message ? "manual" : message.trigger,
    owner: message.owner,
    repo: message.repo,
    pullNumber: message.pullNumber,
  });
  return json({ accepted: true, deliveryId }, 202);
}

export async function verifyWebhookSignature(
  body: ArrayBuffer,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  if (!secret || !signatureHeader.startsWith("sha256=")) return false;
  const received = hexToBytes(signatureHeader.slice("sha256=".length));
  if (!received) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return constantTimeEqual(expected, received);
}

export function toReviewJob(
  payload: PullRequestWebhook,
  deliveryId: string,
  dashboardUrl?: string,
): ReviewJob | null {
  if (!payload.action || !REVIEW_ACTIONS.has(payload.action)) return null;
  if (payload.pull_request?.draft) return null;

  const installationId = payload.installation?.id;
  const owner = payload.repository?.owner?.login?.trim();
  const repo = payload.repository?.name?.trim();
  const pullNumber = payload.pull_request?.number;
  const baseRef = payload.pull_request?.base?.ref?.trim();
  const baseSha = payload.pull_request?.base?.sha?.trim();
  const headSha = payload.pull_request?.head?.sha?.trim();
  const beforeSha = payload.action === "synchronize" && isSha(payload.before?.trim())
    ? payload.before!.trim()
    : undefined;

  if (
    !Number.isInteger(installationId) ||
    !owner ||
    !repo ||
    !Number.isInteger(pullNumber) ||
    !baseRef ||
    !isSha(baseSha) ||
    !isSha(headSha) ||
    !isRepositoryPart(owner) ||
    !isRepositoryPart(repo)
  ) {
    return null;
  }

  return {
    deliveryId,
    installationId: installationId as number,
    owner,
    repo,
    pullNumber: pullNumber as number,
    title: (payload.pull_request?.title ?? "").slice(0, 1_000),
    body: (payload.pull_request?.body ?? "").slice(0, 20_000),
    baseRef,
    baseSha: baseSha as string,
    headSha: headSha as string,
    ...(beforeSha === undefined ? {} : { beforeSha }),
    queuedAt: new Date().toISOString(),
    trigger: "automatic",
    ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
  };
}

export function toManualReviewRequest(
  payload: IssueCommentWebhook,
  deliveryId: string,
  dashboardUrl?: string,
): ManualReviewRequest | null {
  if (payload.action !== "created" || payload.issue?.pull_request === undefined) return null;
  const comment = payload.comment;
  if (
    !comment?.body ||
    !MANUAL_REVIEW_COMMAND.test(comment.body) ||
    comment.user?.type === "Bot" ||
    !TRUSTED_ASSOCIATIONS.has(comment.author_association ?? "")
  ) {
    return null;
  }

  const installationId = payload.installation?.id;
  const owner = payload.repository?.owner?.login?.trim();
  const repo = payload.repository?.name?.trim();
  const pullNumber = payload.issue.number;
  const commentId = comment.id;
  const requestedBy = comment.user?.login?.trim();
  if (
    !Number.isInteger(installationId) ||
    !owner ||
    !repo ||
    !Number.isInteger(pullNumber) ||
    !Number.isInteger(commentId) ||
    (commentId as number) <= 0 ||
    !requestedBy ||
    !isRepositoryPart(owner) ||
    !isRepositoryPart(repo)
  ) {
    return null;
  }

  return {
    kind: "manual",
    deliveryId,
    installationId: installationId as number,
    owner,
    repo,
    pullNumber: pullNumber as number,
    commentId: commentId as number,
    requestedBy: requestedBy.slice(0, 100),
    ...(dashboardUrl === undefined ? {} : { dashboardUrl }),
    queuedAt: new Date().toISOString(),
  };
}

async function acknowledgeManualReview(message: ManualReviewRequest, env: Env): Promise<void> {
  try {
    const github = await GitHubClient.forInstallation(
      env.GITHUB_APP_ID,
      env.GITHUB_PRIVATE_KEY,
      message.installationId,
    );
    await github.reactToIssueComment(message.owner, message.repo, message.commentId, "eyes");
    logInfo("webhook.manual_acknowledged", {
      deliveryId: message.deliveryId,
      owner: message.owner,
      repo: message.repo,
      pullNumber: message.pullNumber,
      commentId: message.commentId,
      reaction: "eyes",
    });
  } catch (error) {
    logWarn("webhook.manual_acknowledgement_failed", {
      deliveryId: message.deliveryId,
      owner: message.owner,
      repo: message.repo,
      pullNumber: message.pullNumber,
      commentId: message.commentId,
      error: errorMessage(error),
    });
  }
}

function isSha(value: string | undefined): boolean {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
}

function isRepositoryPart(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function response(body: string, status: number, headers?: HeadersInit): Response {
  return new Response(body, headers === undefined ? { status } : { status, headers });
}
