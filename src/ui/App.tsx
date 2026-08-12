import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  Bars3Icon,
  CheckCircleIcon,
  DocumentMagnifyingGlassIcon,
  KeyIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "@heroicons/react/16/solid";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Badge } from "@/ui/components/ui/badge";
import { Button } from "@/ui/components/ui/button";
import { Progress } from "@/ui/components/ui/progress";
import type { ReviewSessionPhase, ReviewSessionSnapshot } from "../session";
import gastonLogo from "../../docs/assets/gaston-logo.png";

type ArtifactTab = "changes" | "findings" | "checks";

interface ReviewTarget {
  owner: string;
  repo: string;
  pullNumber: number;
}

interface Connection extends ReviewTarget {
  token: string;
}

const phaseOrder: ReviewSessionPhase[] = [
  "queued",
  "starting",
  "discovery",
  "verification",
  "publishing",
  "completed",
];

const phaseCopy: Record<ReviewSessionPhase, { label: string; detail: string }> = {
  queued: { label: "Queued", detail: "Accepted by the review queue" },
  starting: { label: "Starting", detail: "Validating the pull request head" },
  discovery: { label: "Discovery", detail: "Inspecting cumulative changes and repository evidence" },
  verification: { label: "Verification", detail: "Checking candidate findings independently" },
  publishing: { label: "Publishing", detail: "Writing the check and verified findings to GitHub" },
  completed: { label: "Completed", detail: "The GitHub review is complete" },
  interrupted: { label: "Interrupted", detail: "The review stopped before completion" },
  superseded: { label: "Superseded", detail: "A newer pull request head replaced this run" },
};

const ReviewDiffStream = lazy(() => import("./ReviewDiffStream"));

function targetFromUrl(): ReviewTarget | undefined {
  const params = new URLSearchParams(window.location.search);
  const repository = params.get("repo")?.trim();
  const pullNumber = Number(params.get("pr"));
  const [owner, repo, extra] = repository?.split("/") ?? [];
  if (!owner || !repo || extra || !Number.isSafeInteger(pullNumber) || pullNumber < 1) return undefined;
  return { owner, repo, pullNumber };
}

function initialConnection(): Connection | undefined {
  const target = targetFromUrl();
  const token = window.sessionStorage.getItem("gaston-dashboard-token") ?? "";
  return target && token ? { ...target, token } : undefined;
}

function useLiveSession(connection: Connection | undefined) {
  const [session, setSession] = useState<ReviewSessionSnapshot>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(connection !== undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<number>();
  const etag = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!connection || inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const response = await fetch(
        `/api/reviews/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.repo)}/${connection.pullNumber}`,
        {
          headers: {
            authorization: `Bearer ${connection.token}`,
            ...(etag.current === undefined ? {} : { "if-none-match": etag.current }),
          },
        },
      );
      setLastCheckedAt(Date.now());
      if (response.status === 304) {
        setError(undefined);
        return;
      }
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
        throw new Error(body?.error ?? `Live review request failed (${response.status})`);
      }
      const next = await response.json() as ReviewSessionSnapshot;
      etag.current = response.headers.get("etag") ?? undefined;
      setSession(next);
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the live review");
    } finally {
      inFlight.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [connection]);

  useEffect(() => {
    setSession(undefined);
    setError(undefined);
    setLoading(connection !== undefined);
    etag.current = undefined;
    void refresh();
    if (!connection) return;
    const timer = window.setInterval(() => void refresh(), 2_500);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [connection, refresh]);

  return { session, error, loading, refreshing, lastCheckedAt, refresh };
}

function formatElapsed(startedAt: string, endedAt?: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(((endedAt ?? Date.now()) - Date.parse(startedAt)) / 1_000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function phaseProgress(phase: ReviewSessionPhase): number {
  return {
    queued: 8,
    starting: 20,
    discovery: 55,
    verification: 76,
    publishing: 92,
    completed: 100,
    interrupted: 100,
    superseded: 100,
  }[phase];
}

function isTerminal(phase: ReviewSessionPhase): boolean {
  return phase === "completed" || phase === "interrupted" || phase === "superseded";
}

function LiveStatus({ phase }: { phase: ReviewSessionPhase }) {
  const terminal = isTerminal(phase);
  const failed = phase === "interrupted" || phase === "superseded";
  return (
    <Badge className={`gap-2 rounded-md py-1.5 pr-2.5 pl-1.5 text-sm font-medium hover:bg-current/0 ${
      failed
        ? "bg-rose-500/10 text-rose-300 inset-ring inset-ring-rose-400/15"
        : terminal
          ? "bg-emerald-500/10 text-emerald-300 inset-ring inset-ring-emerald-400/15"
          : "bg-gaston-400/10 text-gaston-300 inset-ring inset-ring-gaston-300/15"
    }`}>
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${
        failed ? "bg-rose-400" : terminal ? "bg-emerald-400" : "bg-gaston-400 live-pulse"
      }`} />
      {terminal ? phaseCopy[phase].label : "Working"}
    </Badge>
  );
}

function ConnectScreen({ onConnect }: { onConnect: (connection: Connection) => void }) {
  const target = targetFromUrl();
  const [repository, setRepository] = useState(target ? `${target.owner}/${target.repo}` : "");
  const [pullNumber, setPullNumber] = useState(target ? String(target.pullNumber) : "");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const [owner, repo, extra] = repository.trim().split("/");
    const parsedPull = Number(pullNumber);
    if (!owner || !repo || extra || !Number.isSafeInteger(parsedPull) || parsedPull < 1 || !token) {
      setError("Enter an owner/repository, a valid pull request number, and the dashboard token.");
      return;
    }
    window.sessionStorage.setItem("gaston-dashboard-token", token);
    const params = new URLSearchParams({ repo: `${owner}/${repo}`, pr: String(parsedPull) });
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
    onConnect({ owner, repo, pullNumber: parsedPull, token });
  }

  return (
    <div className="scheme-only-dark isolate min-h-dvh bg-[#0d0e0c] text-zinc-100 antialiased">
      <header className="flex h-14 items-center border-b border-white/8 px-4 sm:px-6">
        <a href="/" aria-label="Homepage" className="flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gaston-400">
          <img src={gastonLogo} alt="" className="size-8 shrink-0 [image-rendering:pixelated]" />
          <span className="font-medium">Gaston</span>
        </a>
      </header>
      <main className="mx-auto grid min-h-[calc(100dvh-3.5rem)] max-w-6xl items-center px-4 py-12 sm:px-6 lg:grid-cols-[3fr_2fr] lg:gap-20 lg:px-8">
        <div className="max-w-[60ch]">
          <div className="font-mono text-sm uppercase tracking-wide text-gaston-400">Live review workspace</div>
          <h1 className="max-w-[18ch] pt-3 text-balance text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            Follow Gaston’s real review session.
          </h1>
          <p className="max-w-[60ch] pt-5 text-pretty text-base/7 text-zinc-400">
            Connect to the Durable Object for a pull request to see its current task, persisted phase, cumulative patch, verified findings, and evidence budget.
          </p>
          <dl className="grid grid-cols-3 gap-4 pt-8">
            <div className="border-t border-white/10 pt-3">
              <dt className="truncate text-sm text-zinc-600">Transport</dt>
              <dd className="pt-1 text-base font-medium text-zinc-200">Conditional polling</dd>
            </div>
            <div className="border-t border-white/10 pt-3">
              <dt className="truncate text-sm text-zinc-600">Source</dt>
              <dd className="pt-1 text-base font-medium text-zinc-200">Durable state</dd>
            </div>
            <div className="border-t border-white/10 pt-3">
              <dt className="truncate text-sm text-zinc-600">Access</dt>
              <dd className="pt-1 text-base font-medium text-zinc-200">Bearer token</dd>
            </div>
          </dl>
        </div>

        <form onSubmit={submit} className="mt-12 rounded-xl bg-[#151613] p-5 inset-ring inset-ring-white/8 lg:mt-0">
          <div className="flex items-start gap-3">
            <KeyIcon className="size-4 h-lh shrink-0 fill-gaston-400" />
            <div className="min-w-0">
              <h2 className="text-balance text-lg font-semibold text-white">Open a live session</h2>
              <p className="text-pretty text-base/7 text-zinc-500 sm:text-sm/6">The token stays in this browser tab and is never added to the URL.</p>
            </div>
          </div>
          <div className="grid gap-4 pt-6">
            <label className="grid gap-2 text-base sm:text-sm" htmlFor="repository">
              <span className="text-zinc-300">Repository</span>
              <input
                id="repository"
                name="repository"
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                placeholder="owner/repository"
                autoComplete="off"
                className="h-11 rounded-lg bg-black/20 px-3 text-base text-white inset-ring inset-ring-white/10 outline-none placeholder:text-zinc-700 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-gaston-400 sm:h-9 sm:text-sm"
              />
            </label>
            <label className="grid gap-2 text-base sm:text-sm" htmlFor="pull-number">
              <span className="text-zinc-300">Pull request</span>
              <input
                id="pull-number"
                name="pullNumber"
                type="number"
                min="1"
                value={pullNumber}
                onChange={(event) => setPullNumber(event.target.value)}
                placeholder="128"
                className="h-11 rounded-lg bg-black/20 px-3 text-base text-white inset-ring inset-ring-white/10 outline-none placeholder:text-zinc-700 focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-gaston-400 sm:h-9 sm:text-sm"
              />
            </label>
            <label className="grid gap-2 text-base sm:text-sm" htmlFor="dashboard-token">
              <span className="text-zinc-300">Dashboard token</span>
              <input
                id="dashboard-token"
                name="dashboardToken"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="current-password"
                className="h-11 rounded-lg bg-black/20 px-3 text-base text-white inset-ring inset-ring-white/10 outline-none focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-gaston-400 sm:h-9 sm:text-sm"
              />
            </label>
          </div>
          {error ? <p className="pt-4 text-pretty text-base/7 text-rose-300 sm:text-sm/6">{error}</p> : null}
          <Button type="submit" className="mt-6 h-11 w-full bg-gaston-400 text-sm text-gaston-950 ring-1 ring-gaston-400 hover:bg-gaston-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gaston-400 sm:h-9">
            Connect to review
          </Button>
        </form>
      </main>
    </div>
  );
}

function SessionHeader({
  session,
  refreshing,
  elapsed,
  onRefresh,
  onDisconnect,
}: {
  session: ReviewSessionSnapshot;
  refreshing: boolean;
  elapsed: string;
  onRefresh: () => void;
  onDisconnect: () => void;
}) {
  const pullUrl = `https://github.com/${session.job.owner}/${session.job.repo}/pull/${session.job.pullNumber}`;
  return (
    <header className="flex min-h-14 items-center gap-3 border-b border-white/8 bg-[#10110f] px-3 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <a href="/" aria-label="Homepage" className="rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gaston-400">
          <img src={gastonLogo} alt="" className="size-8 shrink-0 [image-rendering:pixelated]" />
        </a>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 text-sm">
            <span className="shrink-0 text-zinc-500">{session.job.owner}/{session.job.repo}</span>
            <span className="text-zinc-700">/</span>
            <h1 className="truncate font-medium text-zinc-100">{session.job.title}</h1>
          </div>
          <div className="truncate text-sm text-zinc-600 sm:text-[0.8125rem]">PR #{session.job.pullNumber} · {session.job.headSha.slice(0, 8)} → {session.job.baseRef}</div>
        </div>
      </div>

      <div className="hidden items-center gap-4 font-mono text-sm text-zinc-500 tabular-nums md:flex">
        <span>{session.files.length} files</span>
        <span>{session.budget ? `$${session.budget.costUsd.toFixed(3)}` : "$0.000"}</span>
        <span>{elapsed}</span>
      </div>
      <div className="hidden sm:block"><LiveStatus phase={session.phase} /></div>
      <Button type="button" variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing} className="relative h-8 px-2 text-zinc-400 hover:bg-white/5 hover:text-zinc-100" aria-label="Refresh live review">
        <ArrowPathIcon className={`size-4 shrink-0 fill-zinc-400 ${refreshing ? "animate-spin" : ""}`} />
        <span className="hidden sm:inline">Refresh</span>
        <span className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2" aria-hidden="true" />
      </Button>
      <a href={pullUrl} target="_blank" rel="noreferrer" className="hidden h-8 items-center gap-2 rounded-md px-2 text-sm text-zinc-400 inset-ring inset-ring-white/10 hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gaston-400 sm:flex">
        GitHub
        <ArrowTopRightOnSquareIcon className="size-4 h-lh shrink-0 fill-zinc-500" />
      </a>
      <details className="relative lg:hidden">
        <summary aria-label="Open session menu" className="relative flex cursor-pointer items-center justify-center rounded-md p-2 text-zinc-400 inset-ring inset-ring-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gaston-400">
          <Bars3Icon className="size-4 shrink-0 fill-zinc-400" />
          <span className="pointer-fine:hidden absolute top-1/2 left-1/2 size-[max(100%,3rem)] -translate-1/2" aria-hidden="true" />
        </summary>
        <div className="absolute top-full end-0 z-50 mt-2 w-52 rounded-lg bg-[#191a17] p-1.5 shadow-none ring-1 ring-white/10">
          <a href={pullUrl} target="_blank" rel="noreferrer" className="flex rounded-md px-3 py-2.5 text-base text-zinc-300 hover:bg-white/5 sm:text-sm">Open on GitHub</a>
          <button type="button" onClick={onDisconnect} className="flex w-full rounded-md px-3 py-2.5 text-start text-base text-zinc-500 hover:bg-white/5 hover:text-zinc-200 sm:text-sm">Change review</button>
        </div>
      </details>
      <button type="button" onClick={onDisconnect} className="hidden text-sm text-zinc-600 hover:text-zinc-300 lg:block">Change</button>
    </header>
  );
}

function TaskRail({ session }: { session: ReviewSessionSnapshot }) {
  const currentIndex = phaseOrder.indexOf(session.phase);
  const phases = phaseOrder.slice(0, -1);
  return (
    <aside className="min-w-0 border-b border-white/8 bg-[#0f100e] lg:border-e lg:border-b-0 lg:overflow-y-auto">
      <section className="border-b border-white/8 p-4">
        <div className="font-mono text-sm uppercase tracking-wide text-zinc-600">Task</div>
        <h2 className="pt-3 text-balance text-base font-semibold text-zinc-100">{session.job.title}</h2>
        {session.job.body ? <p className="line-clamp-4 pt-2 text-pretty text-base/7 text-zinc-500 sm:text-sm/6">{session.job.body}</p> : null}
        <dl className="grid gap-2 pt-4 text-sm">
          <div className="flex justify-between gap-3"><dt className="text-zinc-600">Trigger</dt><dd className="text-zinc-400">{session.job.trigger}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-zinc-600">Head</dt><dd className="font-mono text-zinc-400">{session.job.headSha.slice(0, 8)}</dd></div>
          <div className="flex justify-between gap-3"><dt className="text-zinc-600">Check</dt><dd className="font-mono text-zinc-400 tabular-nums">#{session.checkRunId}</dd></div>
        </dl>
      </section>

      <section className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="font-mono text-sm uppercase tracking-wide text-zinc-600">Plan</div>
          <div className="font-mono text-sm text-zinc-600 tabular-nums">{phaseProgress(session.phase)}%</div>
        </div>
        <Progress value={phaseProgress(session.phase)} aria-label="Review progress" className="mt-3 h-1 bg-white/8 [&_[data-slot=progress-indicator]]:bg-gaston-400" />
        <ol role="list" className="grid gap-1 pt-5">
          {phases.map((phase, index) => {
            const active = session.phase === phase;
            const complete = currentIndex > index || session.phase === "completed";
            return (
              <li key={phase} className={`flex items-start gap-3 rounded-md px-2 py-2 ${active ? "bg-white/6" : ""}`}>
                {complete ? (
                  <CheckCircleIcon className="size-4 h-lh shrink-0 fill-emerald-500" />
                ) : (
                  <span aria-hidden="true" className={`mt-1 size-2 shrink-0 rounded-full ${active ? "bg-gaston-400 live-pulse" : "bg-zinc-800"}`} />
                )}
                <div className="min-w-0">
                  <div className={`text-base sm:text-sm ${active ? "text-zinc-100" : complete ? "text-zinc-400" : "text-zinc-700"}`}>{phaseCopy[phase].label}</div>
                  <p className="text-pretty text-base/7 text-zinc-600 sm:text-sm/6">{phaseCopy[phase].detail}.</p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </aside>
  );
}

function ProgressPane({ session }: { session: ReviewSessionSnapshot }) {
  const currentIndex = phaseOrder.indexOf(session.phase);
  const visiblePhases = currentIndex < 0 ? [session.phase] : phaseOrder.slice(0, currentIndex + 1);
  return (
    <section className="flex min-w-0 flex-col bg-[#121310] lg:border-e lg:border-white/8 xl:min-h-0">
      <div className="flex h-12 items-center justify-between border-b border-white/8 px-4">
        <div className="text-sm font-medium text-zinc-200">Progress</div>
        <div className="font-mono text-sm text-zinc-600 tabular-nums">revision {session.revision}</div>
      </div>
      <div className="review-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-6">
        <div className="rounded-lg bg-white/[0.025] p-4 inset-ring inset-ring-white/8">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm text-gaston-300">Current state</div>
              <h2 className="pt-1 text-balance text-xl font-semibold text-zinc-100">{session.progressTitle ?? phaseCopy[session.phase].detail}</h2>
            </div>
            <LiveStatus phase={session.phase} />
          </div>
          <p className="pt-3 text-pretty text-base/7 text-zinc-500 sm:text-sm/6">
            This status is read from the persisted review coordinator, not inferred by the browser.
          </p>
        </div>

        <div className="pt-7">
          <div className="font-mono text-sm uppercase tracking-wide text-zinc-600">Session timeline</div>
          <ol role="list" className="pt-3">
            {visiblePhases.map((phase, index) => {
              const latest = index === visiblePhases.length - 1;
              return (
                <li key={phase} className="relative flex gap-3 pb-6 last:pb-0">
                  {index < visiblePhases.length - 1 ? <span aria-hidden="true" className="absolute top-4 bottom-0 left-[0.21875rem] w-px bg-white/10" /> : null}
                  <span aria-hidden="true" className={`relative mt-1 size-2 shrink-0 rounded-full ${latest && !isTerminal(session.phase) ? "bg-gaston-400 live-pulse" : "bg-emerald-500"}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="text-base font-medium text-zinc-300 sm:text-sm">{phaseCopy[phase].label}</div>
                      {latest ? <div className="font-mono text-sm text-zinc-700">latest</div> : null}
                    </div>
                    <p className="text-pretty text-base/7 text-zinc-600 sm:text-sm/6">{phaseCopy[phase].detail}.</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        {session.files.length > 0 ? (
          <div className="mt-7 border-t border-white/8 pt-6">
            <div className="flex items-start gap-3">
              <DocumentMagnifyingGlassIcon className="size-4 h-lh shrink-0 fill-zinc-600" />
              <div className="min-w-0">
                <div className="text-base font-medium text-zinc-300 sm:text-sm">Cumulative changes loaded</div>
                <p className="text-pretty text-base/7 text-zinc-600 sm:text-sm/6">{session.files.length} changed files are available in the review artifact.</p>
              </div>
            </div>
          </div>
        ) : null}

        {session.review ? (
          <section className="mt-7 border-t border-white/8 pt-6">
            <div className="font-mono text-sm uppercase tracking-wide text-zinc-600">Summary</div>
            <p className="pt-3 text-pretty text-base/7 text-zinc-300 sm:text-sm/6">{session.review.summary}</p>
          </section>
        ) : null}
      </div>
    </section>
  );
}

function FindingsView({ session }: { session: ReviewSessionSnapshot }) {
  const findings = session.review?.findings ?? [];
  if (findings.length === 0) {
    return (
      <div className="grid min-h-80 place-items-center p-8 text-center">
        <div className="max-w-sm">
          <ShieldCheckIcon className="mx-auto size-4 fill-zinc-700" />
          <h3 className="pt-3 text-balance text-base font-medium text-zinc-300">No verified findings</h3>
          <p className="pt-2 text-pretty text-base/7 text-zinc-600 sm:text-sm/6">Candidates only appear after deterministic changed-line validation and independent verification.</p>
        </div>
      </div>
    );
  }
  return (
    <ol role="list" className="divide-y divide-white/8 px-5">
      {findings.map((finding) => (
        <li key={`${finding.path}:${finding.line}:${finding.title}`} className="py-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="rounded py-1 px-1.5 text-sm uppercase tracking-wide text-rose-300 bg-rose-500/10 hover:bg-rose-500/10">{finding.severity}</Badge>
            <div className="font-mono text-sm text-zinc-600">{finding.path}:{finding.line}</div>
            <div className="font-mono text-sm text-zinc-700 tabular-nums">{Math.round(finding.confidence * 100)}%</div>
          </div>
          <h3 className="pt-3 text-balance text-base font-semibold text-zinc-200">{finding.title}</h3>
          <p className="pt-2 text-pretty text-base/7 text-zinc-500 sm:text-sm/6">{finding.why}</p>
          <div className="mt-4 rounded-md bg-black/20 p-3 text-base/7 text-zinc-500 inset-ring inset-ring-white/6 sm:text-sm/6">{finding.evidence}</div>
        </li>
      ))}
    </ol>
  );
}

function ChecksView({ session }: { session: ReviewSessionSnapshot }) {
  const coverage = session.coverage;
  const budget = session.budget;
  const checks = [
    ["Evidence coverage", coverage ? (coverage.sufficient ? "Complete" : "Incomplete") : "Pending"],
    ["Exact patches", coverage ? `${coverage.inspectedChangedFiles} / ${coverage.totalChangedFiles}` : "Pending"],
    ["Repository calls", coverage ? String(coverage.toolCalls) : "Pending"],
    ["Model requests", budget ? String(budget.modelRequests) : "Pending"],
    ["Reported cost", budget ? `$${budget.costUsd.toFixed(4)}` : "Pending"],
    ["Changed-file list", session.changesTruncated ? "Truncated" : session.files.length > 0 ? "Complete" : "Pending"],
  ];
  return (
    <div className="p-5">
      <dl className="grid grid-cols-2 border-y border-white/8 @container sm:grid-cols-3">
        {checks.map(([label, value], index) => (
          <div key={label} className={`min-w-0 py-4 ${index % 2 === 0 ? "pr-4" : "pl-4"} sm:px-4 sm:first:pl-0 sm:[&:nth-child(3n+1)]:pl-0 sm:[&:nth-child(3n)]:pr-0 ${index > 1 ? "border-t border-white/8" : ""} sm:[&:nth-child(n+4)]:border-t`}>
            <dt className="truncate text-sm text-zinc-600">{label}</dt>
            <dd className="truncate pt-1 text-base font-medium text-zinc-200 tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {coverage?.limitations.length ? (
        <section className="pt-7">
          <h3 className="text-balance text-base font-semibold text-zinc-200">Coverage limitations</h3>
          <ul role="list" className="grid gap-3 pt-3">
            {coverage.limitations.map((limitation) => (
              <li key={limitation} className="flex items-start gap-3 text-base/7 text-zinc-500 sm:text-sm/6">
                <XCircleIcon className="size-4 h-lh shrink-0 fill-amber-500" />
                <span>{limitation}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ArtifactPane({ session }: { session: ReviewSessionSnapshot }) {
  const [tab, setTab] = useState<ArtifactTab>("changes");
  const additions = session.files.reduce((total, file) => total + file.additions, 0);
  const deletions = session.files.reduce((total, file) => total + file.deletions, 0);
  const tabs: Array<{ id: ArtifactTab; label: string }> = [
    { id: "changes", label: `Changes ${session.files.length}` },
    { id: "findings", label: `Findings ${session.review?.findings.length ?? 0}` },
    { id: "checks", label: "Checks" },
  ];
  return (
    <section className="flex h-full min-w-0 flex-col bg-[#10110f] xl:min-h-0 xl:overflow-hidden">
      <div className="review-scrollbar flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b border-white/8 px-3" role="tablist" aria-label="Review artifacts">
        {tabs.map((item) => (
          <Button key={item.id} type="button" role="tab" aria-selected={tab === item.id} variant="ghost" size="sm" onClick={() => setTab(item.id)} className={`h-8 shrink-0 rounded px-2.5 text-sm font-normal ${tab === item.id ? "bg-white/7 text-zinc-100 hover:bg-white/9" : "text-zinc-600 hover:bg-white/4 hover:text-zinc-300"}`}>
            {item.label}
          </Button>
        ))}
      </div>
      <div className="shrink-0 border-b border-white/8 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 font-mono text-sm text-zinc-600">
          <span>{session.job.baseRef}</span>
          <span>←</span>
          <span>{session.job.headSha.slice(0, 8)}</span>
          <span>·</span>
          <span className="text-emerald-500">+{additions}</span>
          <span className="text-rose-500">−{deletions}</span>
          {session.changesTruncated ? <span className="text-amber-500">partial listing</span> : null}
        </div>
      </div>
      <div className="pierre-review-stream review-scrollbar min-h-[36rem] flex-1 overflow-auto xl:min-h-0" role="tabpanel">
        {tab === "changes" ? (
          <Suspense fallback={<div className="grid min-h-80 place-items-center"><ArrowPathIcon className="size-4 animate-spin fill-gaston-400" /></div>}>
            <ReviewDiffStream session={session} />
          </Suspense>
        ) : null}
        {tab === "findings" ? <FindingsView session={session} /> : null}
        {tab === "checks" ? <ChecksView session={session} /> : null}
      </div>
    </section>
  );
}

function SessionWorkspace({
  session,
  refreshing,
  lastCheckedAt,
  onRefresh,
  onDisconnect,
}: {
  session: ReviewSessionSnapshot;
  refreshing: boolean;
  lastCheckedAt?: number;
  onRefresh: () => void;
  onDisconnect: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (isTerminal(session.phase)) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [session.phase]);
  const elapsed = formatElapsed(session.job.queuedAt, isTerminal(session.phase) ? session.updatedAt : undefined);
  return (
    <div className="gaston-scrollbars scheme-only-dark isolate min-h-dvh bg-[#0d0e0c] text-zinc-100 antialiased">
      <SessionHeader session={session} refreshing={refreshing} elapsed={elapsed} onRefresh={onRefresh} onDisconnect={onDisconnect} />
      <main className="grid min-h-[calc(100dvh-3.5rem)] lg:grid-cols-[15rem_minmax(0,1fr)] xl:h-[calc(100dvh-3.5rem)] xl:min-h-0 xl:grid-cols-[15rem_minmax(22rem,7fr)_minmax(30rem,10fr)]">
        <TaskRail session={session} />
        <ProgressPane session={session} />
        <div className="min-w-0 border-t border-white/8 lg:col-span-2 xl:col-span-1 xl:h-full xl:min-h-0 xl:border-t-0">
          <ArtifactPane session={session} />
        </div>
      </main>
      <div className="sr-only" aria-live="polite">{lastCheckedAt ? `Live review checked at ${new Date(lastCheckedAt).toLocaleTimeString()}` : "Connecting to live review"}</div>
    </div>
  );
}

function LoadingScreen({ error, onDisconnect }: { error?: string; onDisconnect: () => void }) {
  return (
    <div className="scheme-only-dark isolate grid min-h-dvh place-items-center bg-[#0d0e0c] p-6 text-zinc-100 antialiased">
      <div className="max-w-sm text-center">
        {error ? <XCircleIcon className="mx-auto size-4 fill-rose-400" /> : <ArrowPathIcon className="mx-auto size-4 animate-spin fill-gaston-400" />}
        <h1 className="pt-4 text-balance text-xl font-semibold">{error ? "Could not open this review" : "Connecting to Gaston"}</h1>
        <p className="pt-2 text-pretty text-base/7 text-zinc-500 sm:text-sm/6">{error ?? "Loading the current Durable Object state and review artifacts."}</p>
        {error ? <Button type="button" variant="outline" onClick={onDisconnect} className="mt-6 h-9 border-white/10 bg-transparent text-zinc-300 hover:bg-white/5 hover:text-white">Change connection</Button> : null}
      </div>
    </div>
  );
}

export function App() {
  const [connection, setConnection] = useState<Connection | undefined>(initialConnection);
  const { session, error, loading, refreshing, lastCheckedAt, refresh } = useLiveSession(connection);

  function disconnect() {
    window.sessionStorage.removeItem("gaston-dashboard-token");
    setConnection(undefined);
  }

  if (!connection) return <ConnectScreen onConnect={setConnection} />;
  if (!session || loading) return <LoadingScreen error={error} onDisconnect={disconnect} />;
  return (
    <SessionWorkspace
      session={session}
      refreshing={refreshing}
      lastCheckedAt={lastCheckedAt}
      onRefresh={() => void refresh()}
      onDisconnect={disconnect}
    />
  );
}
