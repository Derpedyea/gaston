import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const workerUrl = (argument("--worker-url") ?? "").replace(/\/$/, "");
const appName = argument("--name") ?? "gaston-pr-reviewer";
const organization = argument("--organization");
const port = Number(argument("--port") ?? "8765");
const state = randomBytes(32).toString("hex");

if (!/^https:\/\/[a-z0-9.-]+$/i.test(workerUrl)) {
  throw new Error("usage: bun tools/setup-github-app.mjs --worker-url https://NAME.SUBDOMAIN.workers.dev [--name UNIQUE-NAME]");
}
if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("invalid --port");

const redirectUrl = `http://127.0.0.1:${port}/callback`;
const registrationUrl = organization
  ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
  : "https://github.com/settings/apps/new";
const manifest = JSON.stringify({
  name: appName,
  url: workerUrl,
  redirect_url: redirectUrl,
  public: false,
  hook_attributes: { url: `${workerUrl}/webhooks/github`, active: true },
  default_permissions: { contents: "read", pull_requests: "write", checks: "write", issues: "write" },
  default_events: ["pull_request", "issue_comment"],
});

let completing = false;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (url.pathname === "/") {
    return html(response, 200, `
      <h1>Register Gaston</h1>
      <p>GitHub will create a private App with Contents read, Issues write, Pull requests write, and Checks write.</p>
      <form method="post" action="${registrationUrl}?state=${state}">
        <input type="hidden" name="manifest" value="${escapeAttribute(manifest)}">
        <button type="submit">Continue to GitHub</button>
      </form>
    `);
  }
  if (url.pathname !== "/callback") return html(response, 404, "<h1>Not found</h1>");
  if (completing) return html(response, 409, "<h1>Setup is already completing</h1>");

  const receivedState = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (!sameString(receivedState, state) || !/^[a-f0-9]{40}$/i.test(code)) {
    return html(response, 400, "<h1>Invalid or expired GitHub callback</h1>");
  }

  completing = true;
  try {
    const conversion = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "gaston-setup",
        "x-github-api-version": "2026-03-10",
      },
    });
    const body = await conversion.json();
    if (!conversion.ok) throw new Error(`GitHub conversion failed (${conversion.status})`);
    if (!body.id || !body.pem || !body.webhook_secret || !body.slug) {
      throw new Error("GitHub conversion omitted required App credentials");
    }

    await putSecret("GITHUB_APP_ID", String(body.id));
    await putSecret("GITHUB_PRIVATE_KEY", body.pem);
    await putSecret("GITHUB_WEBHOOK_SECRET", body.webhook_secret);

    html(response, 200, `
      <h1>GitHub App configured</h1>
      <p>The generated credentials are now stored as encrypted Cloudflare Worker secrets.</p>
      <p><a href="https://github.com/apps/${encodeURIComponent(body.slug)}/installations/new">Install Gaston on repositories</a></p>
      <p>You can close this page after installation.</p>
    `);
    setTimeout(() => server.close(), 1_000);
  } catch (error) {
    completing = false;
    html(response, 500, `<h1>Setup failed</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`);
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Open http://127.0.0.1:${port}/\n`);
});

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const child = spawn("bunx", ["wrangler", "secret", "put", name], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let error = "";
    child.stderr.on("data", (chunk) => { error += String(chunk); });
    child.stdin.end(value);
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve()
      : reject(new Error(`Wrangler could not store ${name}: ${error.slice(-500)}`)));
  });
}

function sameString(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function html(response, status, content) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Gaston setup</title><style>body{max-width:42rem;margin:4rem auto;padding:0 1.25rem;font:16px/1.5 system-ui}button{padding:.7rem 1rem}</style>${content}`);
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
