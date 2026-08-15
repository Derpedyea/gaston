import { RpcTarget } from "cloudflare:workers";
import {
  WorkspaceServiceProxy as ComputerWorkspaceServiceProxy,
} from "@cloudflare/computer";
import {
  ReadOnlyRepositoryFilesystem,
  type RepositoryTerminalHostFilesystem,
} from "./repository-terminal-filesystem.ts";

interface RemoteWorkspace {
  readonly fs: RepositoryTerminalHostFilesystem;
  [Symbol.dispose]?(): void;
}

/**
 * Loopback entrypoint used by Computer's Dynamic Worker shell.
 *
 * Computer normally gives its shell the complete mutable workspace. Gaston
 * deliberately narrows that capability to a read-only view of the current
 * exact-head repository snapshot. The shell never receives the Durable
 * Object's run metadata, cache namespace, credentials, Git client, artifacts,
 * or a writable filesystem.
 */
export class WorkspaceServiceProxy extends ComputerWorkspaceServiceProxy {
  override async getWorkspace(): Promise<unknown> {
    const workspace = await super.getWorkspace() as RemoteWorkspace;
    return new ReadOnlyRepositoryWorkspaceStub(workspace);
  }
}

class ReadOnlyRepositoryWorkspaceStub extends RpcTarget {
  readonly #workspace: RemoteWorkspace;
  readonly #fs: ReadOnlyRepositoryFilesystemTarget;
  readonly #git = new DisabledGit();
  readonly #artifacts = new DisabledArtifacts();

  constructor(workspace: RemoteWorkspace) {
    super();
    this.#workspace = workspace;
    this.#fs = new ReadOnlyRepositoryFilesystemTarget(workspace.fs);
  }

  [Symbol.dispose](): void {
    this.#workspace[Symbol.dispose]?.();
  }

  get fs(): ReadOnlyRepositoryFilesystemTarget {
    return this.#fs;
  }

  get useThink(): boolean {
    return false;
  }

  get git(): DisabledGit {
    return this.#git;
  }

  get assets(): undefined {
    return undefined;
  }

  get artifacts(): DisabledArtifacts {
    return this.#artifacts;
  }
}

/** RPC surface for the independently testable read-only filesystem policy. */
class ReadOnlyRepositoryFilesystemTarget extends RpcTarget {
  readonly #fs: ReadOnlyRepositoryFilesystem;

  constructor(fs: RepositoryTerminalHostFilesystem) {
    super();
    this.#fs = new ReadOnlyRepositoryFilesystem(fs);
  }

  async readFile(path: string, encoding?: "utf8"): Promise<string | ReadableStream<Uint8Array>> {
    return this.#fs.readFile(path, encoding);
  }

  async exists(path: string): Promise<boolean> {
    return this.#fs.exists(path);
  }

  async stat(path: string): Promise<unknown> {
    return this.#fs.stat(path);
  }

  async statOrNull(path: string): Promise<unknown | null> {
    return this.#fs.statOrNull(path);
  }

  async lstat(path: string): Promise<unknown> {
    return this.#fs.lstat(path);
  }

  async lstatOrNull(path: string): Promise<unknown | null> {
    return this.#fs.lstatOrNull(path);
  }

  async readlink(path: string): Promise<string> {
    return this.#fs.readlink(path);
  }

  async readdir(path: string, options?: unknown): Promise<unknown[]> {
    return this.#fs.readdir(path, options);
  }

  writeFile(): never {
    return this.#fs.writeFile();
  }

  mkdir(): never {
    return this.#fs.mkdir();
  }

  rm(): never {
    return this.#fs.rm();
  }

  chmod(): never {
    return this.#fs.chmod();
  }

  symlink(): never {
    return this.#fs.symlink();
  }
}

class DisabledGit extends RpcTarget {
  cli(): { stdout: string; stderr: string; exitCode: number } {
    return disabledCommand("git");
  }
}

class DisabledArtifacts extends RpcTarget {
  cli(): { stdout: string; stderr: string; exitCode: number } {
    return disabledCommand("artifacts");
  }
}

function disabledCommand(name: string): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: "",
    stderr: `${name}: disabled in Gaston's read-only repository terminal\n`,
    exitCode: 1,
  };
}
