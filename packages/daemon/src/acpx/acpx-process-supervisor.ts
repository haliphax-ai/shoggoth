import { spawn as defaultSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { getLogger } from "../logging";

const log = getLogger("acpx");

export type AcpxSpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export type TrackedAcpxProcess = {
  readonly pid: number;
  readonly shoggothSessionId: string;
  readonly startedAtMs: number;
};

export class AcpxSupervisorError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AcpxSupervisorError";
  }
}

export type AcpxProcessSupervisorOptions = {
  readonly spawn?: AcpxSpawnFn;
};

/**
 * Tracks acpx child processes keyed by ACP workspace root (one managed process per binding root).
 */
export class AcpxProcessSupervisor {
  private readonly spawnFn: AcpxSpawnFn;
  private readonly byRoot = new Map<
    string,
    { pid: number; shoggothSessionId: string; startedAtMs: number; child: ChildProcess }
  >();

  constructor(opts: AcpxProcessSupervisorOptions) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
  }

  start(input: {
    acpWorkspaceRoot: string;
    shoggothSessionId: string;
    command: string;
    args: readonly string[];
    cwd: string;
    env: Record<string, string>;
  }): { pid: number } {
    if (this.byRoot.has(input.acpWorkspaceRoot)) {
      throw new AcpxSupervisorError(
        "ERR_ACPX_ALREADY_RUNNING",
        `acpx already running for workspace root ${input.acpWorkspaceRoot}`,
      );
    }

    const child = this.spawnFn(input.command, [...input.args], {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      detached: true,
      stdio: "ignore",
    });

    const pid = child.pid;
    if (pid === undefined) {
      throw new AcpxSupervisorError("ERR_ACPX_SPAWN", "spawn did not assign a pid");
    }

    const startedAtMs = Date.now();
    this.byRoot.set(input.acpWorkspaceRoot, {
      pid,
      shoggothSessionId: input.shoggothSessionId,
      startedAtMs,
      child,
    });

    const root = input.acpWorkspaceRoot;
    child.on("exit", (code, signal) => {
      const t = this.byRoot.get(root);
      if (t?.pid === pid) {
        this.byRoot.delete(root);
        log.info("acpx child exited", { root, pid, code, signal });
      }
    });
    child.on("error", (err) => {
      log.warn("acpx child process error", { root, pid, err: String(err) });
      const t = this.byRoot.get(root);
      if (t?.pid === pid) {
        this.byRoot.delete(root);
      }
    });
    child.unref();

    return { pid };
  }

  stop(acpWorkspaceRoot: string): { stopped: boolean; pid?: number } {
    const t = this.byRoot.get(acpWorkspaceRoot);
    if (!t) {
      return { stopped: false };
    }
    this.byRoot.delete(acpWorkspaceRoot);
    try {
      process.kill(t.pid, "SIGTERM");
    } catch (e) {
      log.debug("acpx stop kill", { pid: t.pid, err: String(e) });
    }
    return { stopped: true, pid: t.pid };
  }

  list(): TrackedAcpxProcess[] {
    return [...this.byRoot.values()].map((v) => ({
      pid: v.pid,
      shoggothSessionId: v.shoggothSessionId,
      startedAtMs: v.startedAtMs,
    }));
  }

  killAll(): void {
    for (const root of [...this.byRoot.keys()]) {
      this.stop(root);
    }
  }
}

export function createAcpxProcessSupervisor(opts?: AcpxProcessSupervisorOptions): AcpxProcessSupervisor {
  return new AcpxProcessSupervisor(opts ?? {});
}
