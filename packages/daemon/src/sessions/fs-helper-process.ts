// FsHelperClient: one lazy procman-managed helper per session (agent UID/GID,
// NDJSON framing over stdio) replaces the former per-op `node -e` spawn.

import { randomUUID } from "node:crypto";
import type { ManagedProcess, ProcessSpec } from "@shoggoth/procman";
import { getLogger } from "../logging";

const log = getLogger("fs-helper");

/** Per-request timeout for helper round-trips (matches the MCP stdio default). */
const REQUEST_TIMEOUT_MS = 60_000;

/** Spawn options for one helper instance. */
export interface FsHelperSpawnOptions {
  readonly sessionId: string;
  readonly uid?: number;
  readonly gid?: number;
  readonly workspacePath: string;
  /** DI seam for tests; defaults to the daemon's procman singleton. */
  readonly processManager: FsHelperProcessManager;
  /** DI seam for tests; defaults to the bundled fs-helper-entry.mjs path. */
  readonly entryPath?: string;
}

/**
 * Minimal procman surface the client needs — structural so tests can pass a
 * lightweight stand-in instead of a full ProcessManager.
 */
export interface FsHelperProcessManager {
  start(spec: ProcessSpec): Promise<ManagedProcess>;
  stop(id: string): Promise<void>;
}

type PendingEntry = {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

/**
 * One helper process per session. Lazily spawns on the first fs op,
 * coalesces concurrent spawns, and fails pending requests when the process
 * exits so the next call can respawn cleanly.
 */
export class FsHelperClient {
  private readonly sessionId: string;
  private readonly uid: number | undefined;
  private readonly gid: number | undefined;
  private readonly workspacePath: string;
  private readonly processManager: FsHelperProcessManager;
  private readonly entryPath: string;

  private managed: ManagedProcess | undefined;
  private starting: Promise<void> | undefined;
  /** A helper started successfully before; its registration may need clearing. */
  private spawnedOnce = false;
  private readonly pending = new Map<string, PendingEntry>();
  private stdoutHandler: ((chunk: Buffer) => void) | undefined;
  private exitHandler: (() => void) | undefined;
  private buffer = "";
  private disposed = false;

  constructor(opts: FsHelperSpawnOptions) {
    this.sessionId = opts.sessionId;
    this.uid = opts.uid;
    this.gid = opts.gid;
    this.workspacePath = opts.workspacePath;
    this.processManager = opts.processManager;
    this.entryPath = opts.entryPath ?? defaultEntryPath();
  }

  /**
   * Send one command and resolve with the helper's response payload
   * (`{ok, ...}`). Rejects on spawn failure, exit, timeout, or a malformed
   * response. Safe to call concurrently — calls coalesce on one spawn.
   */
  async request(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.disposed) {
      throw new Error("fs helper client disposed");
    }
    await this.ensure();
    const managed = this.managed;
    if (!managed || managed.state !== "running") {
      throw new Error(`fs helper not running (state=${managed?.state ?? "none"})`);
    }

    const id = randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`fs helper request timed out after ${REQUEST_TIMEOUT_MS}ms (${action})`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const frame = `${JSON.stringify({ id, action, params })}\n`;
      try {
        managed.writeStdin(frame);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Tear down the helper process and fail any in-flight requests. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const managed = this.managed;
    this.managed = undefined;
    this.detachListeners();
    this.failAllPending(new Error("fs helper disposed"));
    if (managed) {
      await this.processManager.stop(this.specId()).catch((err) => {
        log.warn("fs_helper.stop_failed", { sessionId: this.sessionId, err: String(err) });
      });
    }
  }

  // -- Internals ------------------------------------------------------------

  /** Lazily spawn (or reuse) the helper process; concurrent callers coalesce. */
  private async ensure(): Promise<void> {
    if (this.managed?.state === "running") return;
    if (this.starting) return this.starting;

    // Detach listeners from a previous incarnation (exited/crashed) before
    // starting a replacement, and clear its buffered partial frame.
    this.detachListeners();
    this.buffer = "";

    this.starting = (async () => {
      const spec: ProcessSpec = {
        id: this.specId(),
        owner: { kind: "session", scopeId: this.sessionId },
        command: process.execPath,
        args: [this.entryPath],
        cwd: this.workspacePath,
        env: { SHOGGOTH_FS_HELPER: "1" },
        uid: this.uid,
        gid: this.gid,
        // A crashed helper must not be auto-respawned against live requests;
        // the next fs op after a clean failure respawns it explicitly.
        restart: { mode: "never" },
        stdio: { capture: "pipe", stdin: true },
        shutdown: { signal: "SIGTERM", graceMs: 5000 },
      };
      // A previous incarnation stays registered in procman after it exits;
      // start() rejects duplicate spec ids, so deregister first or every
      // respawn after a crash would wedge.
      if (this.spawnedOnce) {
        await this.processManager.stop(this.specId()).catch((err) => {
          log.warn("fs_helper.pre_start_stop_failed", {
            sessionId: this.sessionId,
            err: String(err),
          });
        });
      }

      const managed = await this.processManager.start(spec);
      // start() records spawn/health failures in the state instead of
      // rejecting (same contract the MCP stdio transport relies on); once
      // it resolves, a no-health-check spec is already "running".
      if (managed.state !== "running") {
        throw new Error(`fs helper process failed to start via procman (state=${managed.state})`);
      }
      this.spawnedOnce = true;
      this.managed = managed;
      this.attachListeners(managed);
    })();

    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  /**
   * Handlers close over the managed process they attach to, so a late
   * duplicate event from a dead incarnation can never detach or clobber a
   * replacement helper's state (a stale exit must not clear `this.managed`
   * after a respawn has already installed a new process).
   */
  private attachListeners(managed: ManagedProcess): void {
    const onStdout = (chunk: Buffer) => {
      this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.drainBuffer();
    };
    const onExit = () => {
      if (this.managed === managed) {
        this.managed = undefined;
        this.failAllPending(new Error("fs helper exited; retry the operation"));
      }
      managed.removeListener("stdout", onStdout);
      managed.removeListener("exit", onExit);
      if (this.stdoutHandler === onStdout) this.stdoutHandler = undefined;
      if (this.exitHandler === onExit) this.exitHandler = undefined;
    };
    this.stdoutHandler = onStdout;
    this.exitHandler = onExit;
    managed.on("stdout", onStdout);
    managed.on("exit", onExit);
  }

  /** Drop handlers from the current incarnation, if it is still listening. */
  private detachListeners(): void {
    const managed = this.managed;
    const stdoutHandler = this.stdoutHandler;
    const exitHandler = this.exitHandler;
    if (managed && stdoutHandler) {
      managed.removeListener("stdout", stdoutHandler);
    }
    if (managed && exitHandler) {
      managed.removeListener("exit", exitHandler);
    }
    this.stdoutHandler = undefined;
    this.exitHandler = undefined;
  }

  private drainBuffer(): void {
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl).replace(/\r$/, "").trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        log.warn("fs_helper.malformed_frame", { sessionId: this.sessionId });
        continue;
      }
      if (typeof msg !== "object" || msg === null) continue;
      const rec = msg as Record<string, unknown>;
      const id = rec.id;
      if (typeof id !== "string") continue;
      const entry = this.pending.get(id);
      if (!entry) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.resolve(rec);
    }
  }

  private failAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private specId(): string {
    return `fs-helper-${this.sessionId}`;
  }
}

/** Workspace-relative path of the bundled helper entry script. */
function defaultEntryPath(): string {
  return new URL("./fs-helper-entry.mjs", import.meta.url).pathname;
}

// ---------------------------------------------------------------------------
// Per-session singleton (same pattern as steer-channel / compaction-gate)
// ---------------------------------------------------------------------------

const clients = new Map<string, FsHelperClient>();

/**
 * Get (or lazily create) the fs helper client for a session. Spawning itself
 * is deferred until the first `request`, so sessions that never use fs tools
 * never pay for a helper.
 */
export function getFsHelperClient(
  sessionId: string,
  opts: Omit<FsHelperSpawnOptions, "sessionId">,
): FsHelperClient {
  const sid = sessionId.trim();
  let client = clients.get(sid);
  if (!client) {
    client = new FsHelperClient({ ...opts, sessionId: sid });
    clients.set(sid, client);
  }
  return client;
}

/** Tear down the session's fs helper (session terminate cascade). Idempotent. */
export async function disposeFsHelper(sessionId: string): Promise<void> {
  const client = clients.get(sessionId.trim());
  if (!client) return;
  clients.delete(sessionId.trim());
  await client.dispose();
}

/** Visible for testing — clears all clients without stopping processes. */
export function _resetFsHelpersForTests(): void {
  clients.clear();
}
