// ---------------------------------------------------------------------------
// ExecNotifyScheduler — background exec completion notifications (issue #478)
// ---------------------------------------------------------------------------
//
// Tracks in-flight background `builtin-exec` handles whose calls asked to be
// notified on completion (the `notify` flag, default true). Mirrors the timer
// mechanism: handles are persisted in the `exec_notifies` table (so counts
// survive within the daemon and are visible to the turn status bar), are
// session-scoped with list/cancel operations, and their completions surface as
// OOB turns through the injected delivery function — the same boundary timers
// use.
//
// Unlike timers (wall-clock scheduled), a handle activates on its subprocess
// reaching a terminal state. On daemon restore the process manager is
// in-memory, so unfired handles whose process is no longer tracked resolve as
// "lost" (exit code unknown) rather than hanging forever.

import type Database from "better-sqlite3";
import type { ManagedProcess } from "@shoggoth/procman";
import { isTerminal, type TruncationMode } from "@shoggoth/os-exec";
import { getLogger } from "../logging";

const log = getLogger("exec-notify-scheduler");

/**
 * Output-routing options captured at registration time so the completion
 * notification can respect the exec call's options exactly as a blocking
 * (non-yielded) call would have.
 */
export interface ExecNotifyOptions {
  readonly splitStreams?: boolean;
  readonly maxOutput?: number;
  readonly truncation?: TruncationMode;
  readonly stdoutFile?: string;
  readonly stderrFile?: string;
  readonly outputFile?: string;
}

export interface ExecNotifyHandle {
  /** Notify handle id (what the agent polls/cancels and sees in banners). */
  readonly id: string;
  /** Agent session to notify on completion. */
  readonly sessionId: string;
  /** Procman process id of the backgrounded exec. */
  readonly execSessionId: string;
  readonly pid: number;
  /** Command preview for the OOB banner. */
  readonly command: string;
  readonly options: ExecNotifyOptions;
}

export interface ExecNotifyCompletion {
  readonly handle: ExecNotifyHandle;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
  /**
   * True when the daemon restarted before the process was observed finishing —
   * the exit code and output are unknown.
   */
  readonly lost?: boolean;
}

export interface ExecNotifyRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly execSessionId: string;
  readonly pid: number;
  readonly command: string;
  readonly options: ExecNotifyOptions;
  readonly fired: boolean;
}

type ExecNotifyDeliveryFn = (completion: ExecNotifyCompletion) => Promise<void>;
/** Resolves the procman-managed process for an exec session, if still tracked. */
export type ExecProcessLookup = (execSessionId: string) => ManagedProcess | undefined;

/** Module-level ref set once at startup by the daemon. */
let schedulerRef: ExecNotifyScheduler | undefined;

export function setExecNotifyScheduler(scheduler: ExecNotifyScheduler): void {
  schedulerRef = scheduler;
}

export function getExecNotifyScheduler(): ExecNotifyScheduler | undefined {
  return schedulerRef;
}

/** Capture a completion snapshot from a terminal managed process. */
function captureCompletion(handle: ExecNotifyHandle, mp: ManagedProcess): ExecNotifyCompletion {
  const stdout = mp.readOutput("stdout");
  const stderr = mp.readOutput("stderr");
  return {
    handle,
    exitCode: mp.lastExitCode,
    signal: mp.lastSignal,
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  };
}

export class ExecNotifyScheduler {
  private readonly deliver: ExecNotifyDeliveryFn;
  /** Listener disposers keyed by handle id — cleared on completion/cancel. */
  private readonly disposers = new Map<string, () => void>();
  private db: Database.Database | undefined;

  constructor(deliver: ExecNotifyDeliveryFn) {
    this.deliver = deliver;
  }

  /**
   * Track a backgrounded exec for completion notification. Persists the handle
   * and subscribes to the managed process's state changes; a process already
   * in a terminal state (or one that cannot be resolved at all) completes
   * immediately rather than hanging.
   */
  register(
    db: Database.Database,
    handle: ExecNotifyHandle,
    lookup: ExecProcessLookup = () => undefined,
  ): void {
    this.db = db;
    db.prepare(
      `INSERT INTO exec_notifies (id, session_id, exec_session_id, pid, command, options)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      handle.id,
      handle.sessionId,
      handle.execSessionId,
      handle.pid,
      handle.command,
      JSON.stringify(handle.options),
    );

    const mp = lookup(handle.execSessionId);
    if (!mp) {
      // Not tracked by the process manager — resolve as lost so the agent
      // still hears back instead of waiting on a handle that will never fire.
      void this.complete(handle.id, { handle, exitCode: null, signal: null, lost: true });
      return;
    }
    if (isTerminal(mp.state)) {
      void this.complete(handle.id, captureCompletion(handle, mp));
      return;
    }
    const onState = (state: string): void => {
      if (!isTerminal(state)) return;
      this.disposers.get(handle.id)?.();
      this.disposers.delete(handle.id);
      void this.complete(handle.id, captureCompletion(handle, mp));
    };
    mp.on("state-change", onState);
    this.disposers.set(handle.id, () => {
      mp.removeListener("state-change", onState);
    });
  }

  /** Cancel a handle: marks it fired without delivering. Returns true when a
   *  live handle was cancelled. */
  cancel(db: Database.Database, id: string): boolean {
    this.db = db;
    this.disposers.get(id)?.();
    this.disposers.delete(id);
    const info = db
      .prepare("UPDATE exec_notifies SET fired = 1 WHERE id = ? AND fired = 0")
      .run(id);
    return info.changes > 0;
  }

  /** Cancel all live handles belonging to a session (e.g. session terminate). */
  cancelBySession(sessionId: string): number {
    const db = this.db;
    if (!db) return 0;
    const rows = db
      .prepare("SELECT id FROM exec_notifies WHERE session_id = ? AND fired = 0")
      .all(sessionId) as Array<{ id: string }>;
    let count = 0;
    for (const r of rows) {
      if (this.cancel(db, r.id)) count += 1;
    }
    return count;
  }

  /** List handles for a session (most recent first). */
  listForSession(db: Database.Database, sessionId: string): ExecNotifyRecord[] {
    const rows = db
      .prepare(
        `SELECT id, session_id, exec_session_id, pid, command, options, fired
         FROM exec_notifies WHERE session_id = ? ORDER BY created_at DESC, rowid DESC`,
      )
      .all(sessionId) as Array<{
      id: string;
      session_id: string;
      exec_session_id: string;
      pid: number;
      command: string;
      options: string;
      fired: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      execSessionId: r.exec_session_id,
      pid: r.pid,
      command: r.command,
      options: parseOptions(r.options),
      fired: r.fired === 1,
    }));
  }

  /** Count live (unfired) handles for a session — the status bar section gauge. */
  countForSession(db: Database.Database, sessionId: string): number {
    const row = db
      .prepare("SELECT COUNT(*) AS cnt FROM exec_notifies WHERE session_id = ? AND fired = 0")
      .get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /**
   * Restore state on startup. The process manager is in-memory, so any handle
   * whose process is gone resolves as lost (delivering a notification with an
   * unknown exit code) instead of dangling; a still-tracked process
   * re-subscribes.
   */
  async restore(db: Database.Database, lookup: ExecProcessLookup = () => undefined): Promise<void> {
    this.db = db;
    const rows = db
      .prepare(
        `SELECT id, session_id, exec_session_id, pid, command, options
         FROM exec_notifies WHERE fired = 0`,
      )
      .all() as Array<{
      id: string;
      session_id: string;
      exec_session_id: string;
      pid: number;
      command: string;
      options: string;
    }>;
    for (const r of rows) {
      const handle: ExecNotifyHandle = {
        id: r.id,
        sessionId: r.session_id,
        execSessionId: r.exec_session_id,
        pid: r.pid,
        command: r.command,
        options: parseOptions(r.options),
      };
      const mp = lookup(handle.execSessionId);
      if (mp && !isTerminal(mp.state)) {
        const onState = (state: string): void => {
          if (!isTerminal(state)) return;
          this.disposers.get(handle.id)?.();
          this.disposers.delete(handle.id);
          void this.complete(handle.id, captureCompletion(handle, mp));
        };
        mp.on("state-change", onState);
        this.disposers.set(handle.id, () => {
          mp.removeListener("state-change", onState);
        });
      } else {
        void this.complete(handle.id, {
          handle,
          exitCode: null,
          signal: null,
          ...(mp ? captureCompletion(handle, mp) : {}),
          ...(mp ? {} : { lost: true }),
        });
      }
    }
    if (rows.length > 0) {
      log.info("exec notify handles restored", { total: rows.length });
    }
  }

  /** Tear down all live subscriptions. */
  shutdown(): void {
    for (const dispose of this.disposers.values()) dispose();
    this.disposers.clear();
  }

  // ---- internal ----

  private async complete(id: string, completion: ExecNotifyCompletion): Promise<void> {
    const db = this.db;
    if (db) {
      const info = db
        .prepare("UPDATE exec_notifies SET fired = 1 WHERE id = ? AND fired = 0")
        .run(id);
      if (info.changes === 0) return; // already resolved (double state-change, cancel, …)
    }
    try {
      await this.deliver(completion);
      log.debug("exec notify delivered", {
        id,
        sessionId: completion.handle.sessionId,
        execSessionId: completion.handle.execSessionId,
        exitCode: completion.exitCode,
      });
    } catch (e) {
      log.warn("exec notify delivery failed", {
        id,
        sessionId: completion.handle.sessionId,
        err: String(e),
      });
    }
  }
}

function parseOptions(raw: string): ExecNotifyOptions {
  try {
    return JSON.parse(raw) as ExecNotifyOptions;
  } catch {
    return {};
  }
}
