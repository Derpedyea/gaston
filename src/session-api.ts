import type { ReviewSessionSnapshot } from "./session.ts";

interface ReviewSessionStub {
  sessionRevision(): Promise<number | undefined>;
  session(): Promise<ReviewSessionSnapshot | undefined>;
}

interface ReviewSessionApiEnv {
  DASHBOARD_TOKEN?: string;
  REVIEWER_GENERATION?: string;
  REVIEWER: {
    getByName(name: string): ReviewSessionStub;
  };
}

export async function handleReviewSessionApi(
  request: Request,
  env: ReviewSessionApiEnv,
): Promise<Response> {
  if (request.method !== "GET") {
    return apiJson({ error: "Method not allowed" }, 405, { allow: "GET" });
  }
  if (!env.DASHBOARD_TOKEN) return new Response("not found", { status: 404 });

  const authorization = request.headers.get("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!(await secureEqual(provided, env.DASHBOARD_TOKEN))) {
    return apiJson({ error: "Invalid dashboard token" }, 401, {
      "www-authenticate": 'Bearer realm="Gaston review dashboard"',
    });
  }

  const target = parseReviewSessionTarget(new URL(request.url).pathname);
  if (target === undefined) return apiJson({ error: "Invalid review path" }, 400);

  const generation = env.REVIEWER_GENERATION ?? "1";
  const stub = env.REVIEWER.getByName(
    `${generation}:${target.owner}/${target.repo}#${target.pullNumber}`,
  );
  const revision = await stub.sessionRevision();
  if (revision === undefined) return apiJson({ error: "Review session not found" }, 404);

  const etag = `"${revision}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: apiHeaders({ etag }) });
  }

  const session = await stub.session();
  if (session === undefined) return apiJson({ error: "Review session not found" }, 404);
  return apiJson(session, 200, { etag });
}

function parseReviewSessionTarget(pathname: string): {
  owner: string;
  repo: string;
  pullNumber: number;
} | undefined {
  const match = pathname.match(/^\/api\/reviews\/([^/]+)\/([^/]+)\/(\d+)$/);
  if (!match) return undefined;
  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(match[1]!);
    repo = decodeURIComponent(match[2]!);
  } catch {
    return undefined;
  }
  const pullNumber = Number(match[3]);
  const validSegment = /^[A-Za-z0-9_.-]+$/;
  if (!validSegment.test(owner) || !validSegment.test(repo) || !Number.isSafeInteger(pullNumber) || pullNumber < 1) {
    return undefined;
  }
  return { owner, repo, pullNumber };
}

async function secureEqual(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function apiJson(value: unknown, status: number, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: apiHeaders({ "content-type": "application/json; charset=utf-8", ...headers }),
  });
}

function apiHeaders(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  result.set("cache-control", "private, no-store");
  result.set("x-content-type-options", "nosniff");
  return result;
}
