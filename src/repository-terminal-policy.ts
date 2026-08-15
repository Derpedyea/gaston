const MAX_TERMINAL_COMMAND_BYTES = 2_000;

const READ_COMMANDS = new Set([
  "awk",
  "base64",
  "cat",
  "column",
  "comm",
  "cut",
  "diff",
  "expand",
  "file",
  "find",
  "fold",
  "grep",
  "head",
  "join",
  "jq",
  "ls",
  "md5sum",
  "nl",
  "od",
  "paste",
  "printf",
  "pwd",
  "readlink",
  "rev",
  "rg",
  "sed",
  "sha1sum",
  "sha256sum",
  "sha512sum",
  "sort",
  "stat",
  "strings",
  "tail",
  "tr",
  "tree",
  "uniq",
  "wc",
  "yq",
]);

const MUTATING_FIND_OPTIONS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
]);

/**
 * Accept only single-line pipelines of data-reading commands. The filesystem
 * capability is independently read-only; this policy also prevents sourcing
 * repository scripts, shell evaluation, command substitution, and loops.
 */
export function validateRepositoryTerminalCommand(value: string): string {
  const command = value.trim();
  if (!command) throw new Error("command must be a non-empty string");
  if (new TextEncoder().encode(command).byteLength > MAX_TERMINAL_COMMAND_BYTES || command.includes("\0")) {
    throw new Error(`command must be at most ${MAX_TERMINAL_COMMAND_BYTES} UTF-8 bytes and contain no NUL bytes`);
  }
  if (command.includes("\n") || command.includes("\r")) {
    throw new Error("command must be a single-line read-only pipeline");
  }

  const stages = splitPipeline(command);
  for (const stage of stages) {
    const words = shellWords(stage);
    const name = words[0] ?? "";
    if (!READ_COMMANDS.has(name)) {
      throw new Error(`command ${JSON.stringify(name || stage.trim())} is not in the read-only terminal allowlist`);
    }
    if (name === "find" && words.some((word) => MUTATING_FIND_OPTIONS.has(word))) {
      throw new Error("mutating find actions are unavailable in the read-only terminal");
    }
    if (name === "awk" && (
      words.some(programFileOption)
      || /\b(?:system|getline)\b|@(?:include|load)\b/i.test(words.slice(1).join(" "))
    )) {
      throw new Error("awk program files, subprocesses, and indirect input are unavailable in the read-only terminal");
    }
    if (name === "sed" && words.some(programFileOption)) {
      throw new Error("sed program files are unavailable in the read-only terminal");
    }
    if (name === "jq" && words.some(programFileOption)) {
      throw new Error("jq program files are unavailable in the read-only terminal");
    }
    if (name === "rg" && words.some((word) => word === "--pre" || word.startsWith("--pre=") || word === "--pre-glob" || word.startsWith("--pre-glob="))) {
      throw new Error("rg preprocessors are unavailable in the read-only terminal");
    }
  }
  return command;
}

function splitPipeline(command: string): string[] {
  const stages: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else if (quote === '"' && (character === "`" || character === "$" && command[index + 1] === "(")) {
        throw new Error("command substitution is unavailable in the read-only terminal");
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "|") {
      if (command[index + 1] === "|") throw new Error("only read-only pipelines are available");
      pushStage(stages, command.slice(start, index));
      start = index + 1;
      continue;
    }
    if (character === ";" || character === "&" || character === ">" || character === "<"
      || character === "`" || character === "(" || character === ")") {
      throw new Error("shell control operators and redirections are unavailable in the read-only terminal");
    }
    if (character === "$" && command[index + 1] === "(") {
      throw new Error("command substitution is unavailable in the read-only terminal");
    }
  }
  if (escaped || quote !== undefined) throw new Error("command contains an unterminated quote or escape");
  pushStage(stages, command.slice(start));
  return stages;
}

function pushStage(stages: string[], value: string): void {
  const stage = value.trim();
  if (!stage) throw new Error("pipeline stages must be non-empty");
  stages.push(stage);
}

function shellWords(stage: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of stage) {
    if (escaped) {
      word += character;
      started = true;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += character;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

function programFileOption(word: string): boolean {
  return word === "-f"
    || word.startsWith("-f")
    || word === "--file"
    || word.startsWith("--file=")
    || word === "--from-file"
    || word.startsWith("--from-file=");
}
