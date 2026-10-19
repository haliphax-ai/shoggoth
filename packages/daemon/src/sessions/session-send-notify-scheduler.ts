// ---------------------------------------------------------------------------
// SessionSendNotifyScheduler — yielded session-send reply notifications
// ---------------------------------------------------------------------------
//
// Mirrors ExecNotifyScheduler (the background-exec notify mechanism), but is
// in-memory: a yielded `builtin-session-send` call hands off its pending
// integration promise, which only lives as long as the daemon process — there
// is nothing durable to persist or restore across restarts.
//
// A handle registers when the call's reply window expires (the yield path in
// the session-send handler) and fires when the target's turn finally settles.
// The completion then surfaces to the *calling* session through the injected
// delivery function — in-turn via the steer channel when a turn is active,
// OOB otherwise — the same boundary timers and exec notifies use.
//
// Handles are session-scoped with list/cancel operations; cancelling a session
// (e.g. terminate) silently drops its unfired handles so a dead session is
// never notified.

import { getLogger } from "../logging";

const log = getLogger("session-send-notify");

export interface SessionSendNotifyHandle {
  /** Notify handle id (what the agent sees in banners and tool results). */
  readonly id: string;
  /** Calling session to notify when the reply arrives. */
  readonly sessionId: string;
  /** Target session the message was delivered to. */
  readonly targetSessionId: string;
  /** Message preview for banners. */
  readonly message: string;
}

export interface SessionSendNotifyCompletion {
  readonly handle: SessionSendNotifyHandle;
  /** The target's assistant reply, exactly as a blocking call would return. */
  readonly reply?: string;
  readonly failover?: unknown;
  /** The integration call itself failed (e.g. the target died mid-turn). */
  readonly failed?: boolean;
  readonly error?: string;
}

/** The tool result shape produced by the integration `session_send` op. */
export interface SessionSendPendingResult {
  readonly resultJson: string;
}

type SessionSendNotifyDeliveryFn = (completion: SessionSendNotifyCompletion) => Promise<void>;

/** Module-level ref set once at startup by the daemon. */
let schedulerRef: SessionSendNotifyScheduler | undefined;

export function setSessionSendNotifyScheduler(scheduler: SessionSendNotifyScheduler): void {
  schedulerRef = scheduler;
}

export function getSessionSendNotifyScheduler(): SessionSendNotifyScheduler | undefined {
  return schedulerRef;
}

/**
 * Interpret a settled `session_send` integration result the way a blocking
 * call would have: the reply passes through, and the error shape that
 * `invokeIntegration` produces for IntegrationOpError becomes a failure.
 */
function interpretResult(resultJson: string): SessionSendNotifyOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultJson);
  } catch (e) {
    return { failed: true, error: `unparseable session_send result: ${String(e)}` };
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (obj.ok === false) {
      const message = typeof obj.message === "string" ? obj.message : undefined;
      const code = typeof obj.code === "string" ? obj.code : "session_send failed";
      return { failed: true, error: message ?? code };
    }
    const out: SessionSendNotifyOutcome = {};
    if (typeof obj.reply === "string") out.reply = obj.reply;
    if (obj.failover !== undefined) out.failover = obj.failover;
    return out;
  }
  return {};
}

/** Mutable outcome fields of a completion (the interface fields are readonly). */
type SessionSendNotifyOutcome = {
  reply?: string;
  failover?: unknown;
  failed?: boolean;
  error?: string;
};

interface PendingEntry {
  readonly handle: SessionSendNotifyHandle;
  cancelled: boolean;
}

export class SessionSendNotifyScheduler {
  private readonly deliver: SessionSendNotifyDeliveryFn;
  /** Live (unfired) handles keyed by handle id. */
  private readonly pending = new Map<string, PendingEntry>();

  constructor(deliver: SessionSendNotifyDeliveryFn) {
    this.deliver = deliver;
  }

  /**
   * Track a yielded session-send for reply delivery. The pending integration
   * promise settles exactly once; the completion is then delivered (reply,
   * failure, or nothing when the handle was cancelled first).
   */
  register(handle: SessionSendNotifyHandle, result: Promise<SessionSendPendingResult>): void {
    const entry: PendingEntry = { handle, cancelled: false };
    this.pending.set(handle.id, entry);
    void result.then(
      (r) => {
        this.settle(entry, interpretResult(r.resultJson));
      },
      (e) => {
        this.settle(entry, { failed: true, error: String(e) });
      },
    );
  }

  /** Cancel a handle: the reply is silently dropped. Returns true when a
   *  live handle was cancelled. */
  cancel(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.cancelled = true;
    this.pending.delete(id);
    return true;
  }

  /** Cancel all live handles belonging to a session (e.g. session terminate). */
  cancelBySession(sessionId: string): number {
    let count = 0;
    // Safe to delete during Map iteration: the iterator skips removed keys.
    for (const entry of this.pending.values()) {
      if (entry.handle.sessionId !== sessionId) continue;
      entry.cancelled = true;
      this.pending.delete(entry.handle.id);
      count += 1;
    }
    return count;
  }

  /** List live handles for a session (most recent first). */
  listForSession(sessionId: string): SessionSendNotifyHandle[] {
    return [...this.pending.values()]
      .map((e) => e.handle)
      .filter((h) => h.sessionId === sessionId)
      .reverse();
  }

  /** Count live (unfired) handles for a session. */
  countForSession(sessionId: string): number {
    let count = 0;
    for (const entry of this.pending.values()) {
      if (entry.handle.sessionId === sessionId) count += 1;
    }
    return count;
  }

  /** Drop all live handles without delivering (daemon shutdown). */
  shutdown(): void {
    for (const entry of this.pending.values()) entry.cancelled = true;
    this.pending.clear();
  }

  // ---- internal ----

  private settle(entry: PendingEntry, outcome: SessionSendNotifyOutcome): void {
    if (entry.cancelled) return;
    if (!this.pending.delete(entry.handle.id)) return; // already resolved/cancelled
    const completion: SessionSendNotifyCompletion = { handle: entry.handle, ...outcome };
    void this.deliver(completion).then(
      () => {
        log.debug("session-send notify delivered", {
          id: entry.handle.id,
          sessionId: entry.handle.sessionId,
          targetSessionId: entry.handle.targetSessionId,
          failed: completion.failed ?? false,
        });
      },
      (e) => {
        log.warn("session-send notify delivery failed", {
          id: entry.handle.id,
          sessionId: entry.handle.sessionId,
          err: String(e),
        });
      },
    );
  }
}
