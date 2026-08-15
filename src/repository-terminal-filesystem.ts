export const REPOSITORY_TERMINAL_CWD = "/workspace";
export const REPOSITORY_TERMINAL_ROOT_POINTER = "/gaston/run/context/terminal-root.txt";

export interface RepositoryTerminalHostFilesystem {
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<unknown>;
  statOrNull(path: string): Promise<unknown | null>;
  lstat(path: string): Promise<unknown>;
  lstatOrNull(path: string): Promise<unknown | null>;
  readlink(path: string): Promise<string>;
  readdir(path: string, options?: unknown): Promise<unknown[]>;
}

/** Pure read-only/chroot policy used behind the Workers RPC target. */
export class ReadOnlyRepositoryFilesystem {
  readonly #fs: RepositoryTerminalHostFilesystem;
  #root: Promise<string> | undefined;

  constructor(fs: RepositoryTerminalHostFilesystem) {
    this.#fs = fs;
  }

  async readFile(path: string, encoding?: "utf8"): Promise<string | ReadableStream<Uint8Array>> {
    const mapped = await this.#map(path);
    return encoding === "utf8"
      ? this.#fs.readFile(mapped, "utf8")
      : this.#fs.readFile(mapped);
  }

  async exists(path: string): Promise<boolean> {
    return this.#fs.exists(await this.#map(path));
  }

  async stat(path: string): Promise<unknown> {
    return this.#fs.stat(await this.#map(path));
  }

  async statOrNull(path: string): Promise<unknown | null> {
    return this.#fs.statOrNull(await this.#map(path));
  }

  async lstat(path: string): Promise<unknown> {
    return this.#fs.lstat(await this.#map(path));
  }

  async lstatOrNull(path: string): Promise<unknown | null> {
    return this.#fs.lstatOrNull(await this.#map(path));
  }

  async readlink(path: string): Promise<string> {
    return this.#fs.readlink(await this.#map(path));
  }

  async readdir(path: string, options?: unknown): Promise<unknown[]> {
    return this.#fs.readdir(await this.#map(path), options);
  }

  writeFile(): never {
    throw readOnlyError();
  }

  mkdir(): never {
    throw readOnlyError();
  }

  rm(): never {
    throw readOnlyError();
  }

  chmod(): never {
    throw readOnlyError();
  }

  symlink(): never {
    throw readOnlyError();
  }

  async #map(path: string): Promise<string> {
    const relative = repositoryRelativePath(path);
    const root = await (this.#root ??= this.#loadRoot());
    return relative === "" ? root : `${root}/${relative}`;
  }

  async #loadRoot(): Promise<string> {
    const root = (await this.#fs.readFile(REPOSITORY_TERMINAL_ROOT_POINTER, "utf8")).trim();
    if (
      !/^\/gaston\/cache\/refs\/[0-9a-f]{40}\/snapshot-v\d+\/files$/.test(root)
      || root.includes("..")
    ) {
      throw terminalError("ENOENT", "the exact-head repository terminal snapshot is unavailable");
    }
    return root;
  }
}

/**
 * Map only /workspace and its descendants. Normalizing before checking avoids
 * lexical escapes such as /workspace/src/../../gaston/run/context/pr.json.
 */
export function repositoryRelativePath(path: string): string {
  if (typeof path !== "string" || path.includes("\0")) {
    throw terminalError("EACCES", "invalid repository terminal path");
  }
  const segments: string[] = [];
  for (const segment of (path.startsWith("/") ? path : `${REPOSITORY_TERMINAL_CWD}/${path}`).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  const normalized = `/${segments.join("/")}`;
  if (normalized !== REPOSITORY_TERMINAL_CWD && !normalized.startsWith(`${REPOSITORY_TERMINAL_CWD}/`)) {
    throw terminalError("EACCES", "repository terminal paths must stay under /workspace");
  }
  return normalized === REPOSITORY_TERMINAL_CWD
    ? ""
    : normalized.slice(REPOSITORY_TERMINAL_CWD.length + 1);
}

function readOnlyError(): Error & { code: string } {
  return terminalError("EROFS", "Gaston repository terminal is read-only");
}

function terminalError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = "RepositoryTerminalError";
  error.code = code;
  return error;
}
