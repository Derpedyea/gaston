import type { PullChangeSet, PullFileChange } from "./types.ts";

const MAX_SEARCHED_SYMBOLS = 6;
const MAX_REFERENCES_PER_SYMBOL = 6;
const MAX_LANES = 2;

const IGNORED_IDENTIFIERS = new Set([
  "async", "await", "boolean", "break", "case", "catch", "class", "const",
  "continue", "default", "delete", "else", "export", "extends", "false",
  "finally", "for", "from", "function", "get", "if", "implements", "import",
  "in", "instanceof", "interface", "let", "new", "null", "number", "object",
  "of", "private", "protected", "public", "readonly", "return", "set", "static",
  "string", "super", "switch", "this", "throw", "true", "try", "type", "typeof",
  "undefined", "unknown", "using", "var", "void", "while", "with", "yield",
]);

interface SearchableRepository {
  search(query: string, pathPrefix: string | undefined, limit: number, signal?: AbortSignal): Promise<string>;
}

export interface ChangeImpactReference {
  path: string;
  line?: number;
}

export interface ChangeImpactSymbol {
  symbol: string;
  changedPaths: string[];
  references: ChangeImpactReference[];
}

export interface ReviewRiskLane {
  id: string;
  focus: string;
  paths: string[];
  score: number;
  reasons: string[];
}

export interface ChangeImpactMap {
  lanes: ReviewRiskLane[];
  symbols: ChangeImpactSymbol[];
  searchComplete: boolean;
  searchedSymbols: number;
}

interface RiskDefinition {
  id: string;
  focus: string;
  terms: RegExp;
  pathTerms: RegExp;
}

const RISK_DEFINITIONS: readonly RiskDefinition[] = [
  {
    id: "auth-security",
    focus: "authorization, authentication, identity normalization, injection, secret handling, and trust-boundary bypasses",
    terms: /\b(auth(?:entication|orization)?|oauth|permission|role|owner|member|token|secret|credential|redirect|csrf|ssrf|sanitize|escape|sql|query|html|script)\b/i,
    pathTerms: /(?:^|\/)(?:auth|security|permission|oauth|session|middleware)(?:[./_-]|$)/i,
  },
  {
    id: "state-concurrency",
    focus: "state transitions, concurrency, cancellation, retries, idempotency, caches, queues, and partial failure",
    terms: /\b(async|await|promise|abort|signal|lock|mutex|race|cache|transaction|retry|queue|lease|generation|idempoten|concurren|atomic|stale)\w*/i,
    pathTerms: /(?:^|\/)(?:queue|cache|state|store|coordinator|worker|durable|session)(?:[./_-]|$)/i,
  },
  {
    id: "data-migration",
    focus: "schema compatibility, migrations, serialization, parsing, data loss, and rollback behavior",
    terms: /\b(schema|migration|migrate|serialize|deserialize|parse|decode|encode|database|sqlite|column|table|delete|truncate|backfill|version)\w*/i,
    pathTerms: /(?:^|\/)(?:migration|schema|database|db|storage|model)(?:s)?(?:[./_-]|$)/i,
  },
  {
    id: "api-compatibility",
    focus: "public APIs, wire formats, caller/callee drift, configuration contracts, and dependency compatibility",
    terms: /\b(export|interface|public|endpoint|route|request|response|header|status|config|option|parameter|payload|webhook|api|version)\w*/i,
    pathTerms: /(?:^|\/)(?:api|routes?|handlers?|types?|config|public|sdk)(?:[./_-]|$)/i,
  },
  {
    id: "operations-performance",
    focus: "deployment and CI behavior, resource ownership, unbounded work, multiplicative I/O, and availability cliffs",
    terms: /\b(workflow|deploy|release|timeout|limit|batch|paginate|loop|stream|buffer|memory|latency|performance|resource|cleanup|close|dispose)\w*/i,
    pathTerms: /(?:^|\/)(?:\.github|workflows?|scripts?|deploy|docker|wrangler|package)(?:[./_-]|$)/i,
  },
] as const;

export async function buildChangeImpactMap(
  changes: PullChangeSet,
  repository: SearchableRepository,
  signal?: AbortSignal,
): Promise<ChangeImpactMap> {
  const lanes = selectRiskLanes(changes);
  const candidates = changedSymbols(changes.files).slice(0, MAX_SEARCHED_SYMBOLS);
  let searchComplete = true;
  const symbols = await Promise.all(candidates.map(async ({ symbol, changedPaths }) => {
    try {
      const raw = await repository.search(symbol, undefined, MAX_REFERENCES_PER_SYMBOL + changedPaths.length, signal);
      const parsed = JSON.parse(raw) as { matches?: Array<{ path?: unknown; line?: unknown }> };
      const references = (parsed.matches ?? [])
        .filter((match): match is { path: string; line?: number } => (
          typeof match.path === "string"
          && !changedPaths.includes(match.path)
          && (match.line === undefined || (typeof match.line === "number" && Number.isInteger(match.line)))
        ))
        .slice(0, MAX_REFERENCES_PER_SYMBOL)
        .map((match) => ({
          path: match.path,
          ...(match.line === undefined ? {} : { line: match.line }),
        }));
      return { symbol, changedPaths, references };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      searchComplete = false;
      return { symbol, changedPaths, references: [] };
    }
  }));
  return { lanes, symbols, searchComplete, searchedSymbols: candidates.length };
}

export function selectRiskLanes(changes: PullChangeSet, maximum = MAX_LANES): ReviewRiskLane[] {
  const scored = RISK_DEFINITIONS.map((definition) => {
    const paths = new Set<string>();
    const reasons = new Set<string>();
    let score = 0;
    for (const file of changes.files) {
      const patch = file.patch ?? "";
      let fileScore = 0;
      if (definition.pathTerms.test(file.path)) {
        fileScore += 3;
        reasons.add(`path signal in ${file.path}`);
      }
      const changedText = changedTextOnly(patch);
      const termMatches = changedText.match(new RegExp(definition.terms.source, `${definition.terms.flags.includes("i") ? "i" : ""}g`));
      if (termMatches !== null) {
        fileScore += Math.min(5, termMatches.length);
        reasons.add(`changed-code signals in ${file.path}`);
      }
      if (fileScore > 0) {
        score += fileScore;
        paths.add(file.path);
      }
    }
    return {
      id: definition.id,
      focus: definition.focus,
      paths: [...paths].sort(),
      score,
      reasons: [...reasons].slice(0, 6),
    };
  });
  return scored
    .filter((lane) => lane.score >= 3 && lane.paths.length > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, Math.min(maximum, MAX_LANES)));
}

export function changeSetForLane(changes: PullChangeSet, lane: ReviewRiskLane): PullChangeSet {
  const selected = new Set(lane.paths);
  const files = changes.files.filter((file) => selected.has(file.path));
  const diff = renderDiff(files);
  const unavailablePatchPaths = files.filter((file) => file.patch === null).map((file) => file.path);
  const truncated = changes.filesTruncated === true || unavailablePatchPaths.length > 0;
  return {
    files,
    diff,
    truncated,
    filesTruncated: changes.filesTruncated ?? false,
    diffTruncated: unavailablePatchPaths.length > 0,
    unavailablePatchPaths,
  };
}

export function renderChangeImpactMap(map: ChangeImpactMap): string {
  const laneLines = map.lanes.length === 0
    ? ["- No deterministic high-risk lane crossed the dispatch threshold."]
    : map.lanes.map((lane) => (
        `- ${lane.id} (score ${lane.score}): ${lane.paths.join(", ")} — ${lane.focus}`
      ));
  const symbolLines = map.symbols.length === 0
    ? ["- No stable symbol-shaped change leads were selected."]
    : map.symbols.map((entry) => {
        const references = entry.references.length === 0
          ? "no bounded references found"
          : entry.references.map((reference) => (
              `${reference.path}${reference.line === undefined ? "" : `:${reference.line}`}`
            )).join(", ");
        return `- ${entry.symbol} (changed in ${entry.changedPaths.join(", ")}): ${references}`;
      });
  return [
    "Deterministic risk lanes:",
    ...laneLines,
    "",
    `Changed-symbol reference leads (${map.searchComplete ? "complete bounded lookup" : "lookup partially unavailable"}):`,
    ...symbolLines,
  ].join("\n");
}

function changedSymbols(files: PullFileChange[]): Array<{ symbol: string; changedPaths: string[]; score: number }> {
  const candidates = new Map<string, { paths: Set<string>; score: number }>();
  for (const file of files) {
    if (!file.patch) continue;
    for (const rawLine of file.patch.split("\n")) {
      if (!rawLine.startsWith("+") && !rawLine.startsWith("-")) continue;
      if (rawLine.startsWith("+++") || rawLine.startsWith("---")) continue;
      const line = rawLine.slice(1);
      const declaration = /\b(?:class|interface|type|enum|function|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1];
      const identifiers = declaration === undefined
        ? line.match(/[A-Za-z_$][\w$]{3,}/g) ?? []
        : [declaration];
      for (const symbol of identifiers) {
        if (IGNORED_IDENTIFIERS.has(symbol.toLowerCase())) continue;
        const entry = candidates.get(symbol) ?? { paths: new Set<string>(), score: 0 };
        entry.paths.add(file.path);
        entry.score += declaration === symbol ? 5 : /^[A-Z]/.test(symbol) ? 2 : 1;
        candidates.set(symbol, entry);
      }
    }
  }
  return [...candidates.entries()]
    .map(([symbol, entry]) => ({ symbol, changedPaths: [...entry.paths].sort(), score: entry.score }))
    .filter((entry) => entry.score >= 2)
    .sort((left, right) => right.score - left.score || left.symbol.localeCompare(right.symbol));
}

function changedTextOnly(patch: string): string {
  return patch.split("\n")
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"))
    .map((line) => line.slice(1))
    .join("\n");
}

function renderDiff(files: PullFileChange[]): string {
  return files.flatMap((file) => {
    if (!file.patch) return [];
    const oldPath = file.status === "added" ? "/dev/null" : `a/${file.previousPath ?? file.path}`;
    const newPath = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
    return [[
      `diff --git a/${file.previousPath ?? file.path} b/${file.path}`,
      `--- ${oldPath}`,
      `+++ ${newPath}`,
      file.patch,
      "",
    ].join("\n")];
  }).join("");
}
