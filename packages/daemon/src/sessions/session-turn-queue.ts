import { randomUUID } from "node:crypto";
import { getLogger } from "../logging";

export type TurnPriority = "system" | "user";

export interface QueueDepth {
  readonly system: number;
  readonly user: number;
}

export interface QueueEntryInfo {
  readonly id: string;
  readonly priority: TurnPriority;
  readonly label: string;
  readonly enqueuedAt: number;
}

export interface RunningEntryInfo extends QueueEntryInfo {
  /** `Date.now()` when the entry was dequeued to execute. */
  readonly startedAt: number;
}

export class TurnDroppedError extends Error {
  constructor(id: string) {
    super(`Turn dropped: ${id}`);
    this.name = "TurnDroppedError";
  }
}

export class TurnQueueFullError extends Error {
  constructor(priority: TurnPriority, depth: number) {
    super(`Queue full: ${priority} tier at ${depth}`);
    this.name = "TurnQueueFullError";
  }
}

/**
 * Optional lifecycle hooks for a queued entry. `onQueued` fires when the entry
 * is enqueued while the session is busy (it waits in the queue); `onDequeued`
 * fires exactly once when the entry leaves the queue — either because its turn
 * started or because it was dropped (clear/remove*). Hook errors are logged and
 * never break queue processing.
 */
export interface TurnQueueEntryHooks {
  readonly onQueued?: () => void;
  readonly onDequeued?: () => void;
}

interface QueueEntry {
  readonly id: string;
  readonly priority: TurnPriority;
  readonly label: string;
  readonly enqueuedAt: number;
  readonly execute: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
  readonly hooks?: TurnQueueEntryHooks;
  dequeued: boolean;
}

interface SessionQueue {
  high: QueueEntry[];
  normal: QueueEntry[];
  running: boolean;
  /** The entry whose `execute()` is currently in flight (cleared when the turn settles). */
  runningEntry?: QueueEntry;
  /** `Date.now()` when the running entry was dequeued to execute. */
  runningSince?: number;
  consecutiveHighTurns: number;
}

const log = getLogger("turn-queue");

export class TieredTurnQueue {
  private readonly sessions = new Map<string, SessionQueue>();
  readonly starvationThreshold: number;
  readonly maxDepth: number;
  // New field for the callback
  private onTurnEnd?: (sessionId: string) => void;
  /** Sessions whose pump is frozen behind an in-turn long operation. */
  private readonly blocked = new Set<string>();

  constructor(starvationThreshold = 2, maxDepth = 6) {
    this.starvationThreshold = starvationThreshold;
    this.maxDepth = maxDepth;
  }

  /**
   * Sets a callback to be executed whenever a turn finishes processing.
   * @param cb The callback function (receives sessionId).
   */
  setOnTurnEnd(cb: (sessionId: string) => void): void {
    this.onTurnEnd = cb;
  }

  /**
   * Freezes the session's pump behind the in-flight turn: queued entries wait
   * (and keep accumulating) while a long-running in-turn operation — e.g. a
   * mid-loop context compaction — holds the session, and the next entry is
   * pumped only after `endTurnQueueBlock`. Returns false when the queue is not
   * initialized for the session or a block is already active (nested blocks
   * are not supported; each block is ended exactly once by its owner).
   */
  beginTurnQueueBlock(sessionId: string): boolean {
    const sq = this.sessions.get(sessionId);
    if (!sq?.running || this.blocked.has(sessionId)) return false;
    this.blocked.add(sessionId);
    log.debug("turn_queue.blocked", { sessionId });
    return true;
  }

  /**
   * Releases a {@link beginTurnQueueBlock} freeze and pumps the next queued
   * entry immediately. Safe to call when no block is active.
   */
  endTurnQueueBlock(sessionId: string): void {
    if (!this.blocked.delete(sessionId)) return;
    log.debug("turn_queue.unblocked", { sessionId });
    this.pump(sessionId);
  }

  enqueue(
    sessionId: string,
    priority: TurnPriority,
    label: string,
    fn: () => Promise<void>,
    hooks?: TurnQueueEntryHooks,
  ): Promise<void> {
    const sq = this.getOrCreate(sessionId);
    const arr = priority === "system" ? sq.high : sq.normal;
    if (arr.length >= this.maxDepth) {
      return Promise.reject(new TurnQueueFullError(priority, arr.length));
    }
    return new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
        id: randomUUID(),
        priority,
        label,
        enqueuedAt: Date.now(),
        execute: fn,
        resolve,
        reject,
        hooks,
        dequeued: false,
      };
      if (priority === "system") {
        sq.high.push(entry);
      } else {
        sq.normal.push(entry);
      }
      // The session was already running a turn when this entry arrived, so it
      // waits in the queue — announce the queued state to the caller.
      if (hooks?.onQueued && sq.running) {
        this.safeHook(hooks.onQueued, "onQueued", entry.id);
      }
      log.debug("turn_queue.enqueued", {
        sessionId,
        priority,
        label,
        id: entry.id,
        running: sq.running,
        high: sq.high.length,
        normal: sq.normal.length,
      });
      this.pump(sessionId);
    });
  }

  getDepth(sessionId: string): QueueDepth {
    const sq = this.sessions.get(sessionId);
    if (!sq) return { system: 0, user: 0 };
    return { system: sq.high.length, user: sq.normal.length };
  }

  listQueued(sessionId: string, priority?: TurnPriority): ReadonlyArray<QueueEntryInfo> {
    const sq = this.sessions.get(sessionId);
    if (!sq) return [];
    const toInfo = (e: QueueEntry): QueueEntryInfo => ({
      id: e.id,
      priority: e.priority,
      label: e.label,
      enqueuedAt: e.enqueuedAt,
    });
    if (priority === "system") return sq.high.map(toInfo);
    if (priority === "user") return sq.normal.map(toInfo);
    return [...sq.high.map(toInfo), ...sq.normal.map(toInfo)];
  }

  removeById(sessionId: string, ids: string[]): number {
    const sq = this.sessions.get(sessionId);
    if (!sq) return 0;
    const idSet = new Set(ids);
    let removed = 0;
    removed += this.removeMatching(sq.high, (e) => idSet.has(e.id));
    removed += this.removeMatching(sq.normal, (e) => idSet.has(e.id));
    this.cleanup(sessionId, sq);
    return removed;
  }

  removeByRange(
    sessionId: string,
    priority: TurnPriority | "all",
    start: number,
    end: number,
  ): number {
    const sq = this.sessions.get(sessionId);
    if (!sq) return 0;
    let removed = 0;
    if (priority === "all") {
      const combined = [...sq.high, ...sq.normal];
      const toRemove = new Set(combined.slice(start, end + 1).map((e) => e.id));
      removed += this.removeMatching(sq.high, (e) => toRemove.has(e.id));
      removed += this.removeMatching(sq.normal, (e) => toRemove.has(e.id));
    } else {
      const arr = priority === "system" ? sq.high : sq.normal;
      const slice = arr.slice(start, end + 1);
      for (const e of slice) {
        this.markDequeued(e);
        e.reject(new TurnDroppedError(e.id));
      }
      if (priority === "system") {
        sq.high = arr.filter((_, i) => i < start || i > end);
      } else {
        sq.normal = arr.filter((_, i) => i < start || i > end);
      }
      removed = slice.length;
    }
    this.cleanup(sessionId, sq);
    return removed;
  }

  removeByCount(sessionId: string, priority: TurnPriority | "all", count: number): number {
    return this.removeByRange(sessionId, priority, 0, count - 1);
  }

  clear(sessionId: string, priority?: TurnPriority): number {
    const sq = this.sessions.get(sessionId);
    if (!sq) return 0;
    let removed = 0;
    if (!priority || priority === "system") {
      for (const e of sq.high) {
        this.markDequeued(e);
        e.reject(new TurnDroppedError(e.id));
      }
      removed += sq.high.length;
      sq.high = [];
    }
    if (!priority || priority === "user") {
      for (const e of sq.normal) {
        this.markDequeued(e);
        e.reject(new TurnDroppedError(e.id));
      }
      removed += sq.normal.length;
      sq.normal = [];
    }
    this.cleanup(sessionId, sq);
    return removed;
  }

  /** Whether a turn is currently executing for the session (the running slot is held). */
  isRunning(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.running === true;
  }

  /** Snapshot of the entry currently holding the session's running slot, if any. */
  getRunning(sessionId: string): RunningEntryInfo | undefined {
    const sq = this.sessions.get(sessionId);
    if (!sq?.running || !sq.runningEntry) return undefined;
    return {
      id: sq.runningEntry.id,
      priority: sq.runningEntry.priority,
      label: sq.runningEntry.label,
      enqueuedAt: sq.runningEntry.enqueuedAt,
      startedAt: sq.runningSince ?? sq.runningEntry.enqueuedAt,
    };
  }

  /**
   * Operator recovery: force-release the session's running slot when a turn's
   * post-loop work has wedged and the entry's promise will never settle. The
   * wedged entry is rejected with {@link TurnDroppedError} (unblocking its
   * caller) and the queue pumps the next entry immediately. The abandoned
   * `execute()` may still settle later; its late finalization is ignored by
   * the identity guard in `pump()`.
   *
   * Returns true when a running entry was force-released.
   */
  forceReleaseRunning(sessionId: string, reason = "operator request"): boolean {
    const sq = this.sessions.get(sessionId);
    if (!sq?.running) return false;
    const entry = sq.runningEntry;
    log.warn("turn_queue.running_force_released", {
      sessionId,
      entryId: entry?.id,
      priority: entry?.priority,
      label: entry?.label,
      runningForMs: sq.runningSince ? Date.now() - sq.runningSince : undefined,
      reason,
    });
    sq.running = false;
    sq.runningEntry = undefined;
    sq.runningSince = undefined;
    // An in-turn block (e.g. a mid-loop compaction) is intentionally KEPT: the
    // force-released turn's work continues in the background, and the next
    // pumped entry must not start until the block owner releases (or the turn
    // ends, which also clears the freeze). Operator recovery un-wedges the
    // entry's promise, not an in-flight transcript rewrite.
    // Settle the wedged entry's promise so its caller is unblocked. A no-op
    // if the entry somehow already settled.
    entry?.reject(new TurnDroppedError(entry.id));
    this.pump(sessionId);
    return true;
  }

  private getOrCreate(sessionId: string): SessionQueue {
    let sq = this.sessions.get(sessionId);
    if (!sq) {
      sq = { high: [], normal: [], running: false, consecutiveHighTurns: 0 };
      this.sessions.set(sessionId, sq);
    }
    return sq;
  }

  private pump(sessionId: string): void {
    if (this.blocked.has(sessionId)) {
      log.debug("turn_queue.pump_blocked_in_turn_operation", { sessionId });
      return;
    }
    const sq = this.sessions.get(sessionId);
    if (!sq || sq.running) {
      if (sq?.running) {
        log.debug("turn_queue.pump_blocked", {
          sessionId,
          high: sq.high.length,
          normal: sq.normal.length,
        });
      }
      return;
    }
    const next = this.pickNext(sq);
    if (!next) {
      this.cleanup(sessionId, sq);
      return;
    }
    sq.running = true;
    sq.runningEntry = next;
    sq.runningSince = Date.now();
    log.debug("turn_queue.turn_start", {
      sessionId,
      priority: next.priority,
      label: next.label,
      id: next.id,
    });
    // The entry is leaving the queue to run now (fires onDequeued exactly once).
    this.markDequeued(next);
    next
      .execute()
      .then(() => next.resolve())
      .catch((err) => next.reject(err))
      .finally(() => {
        // Only the entry that owns the running slot may release it. A
        // force-released entry (operator recovery) settles late — or never —
        // and must not clear a newer turn's `running` flag.
        const current = this.sessions.get(sessionId);
        if (!current || current.runningEntry !== next) {
          log.warn("turn_queue.turn_end_stale", {
            sessionId,
            priority: next.priority,
            label: next.label,
            id: next.id,
          });
          return;
        }
        log.debug("turn_queue.turn_end", {
          sessionId,
          priority: next.priority,
          label: next.label,
          id: next.id,
        });
        // A session left blocked by a crashed turn would wedge forever, so a
        // turn-end always clears the freeze alongside the running slot.
        this.blocked.delete(sessionId);
        // *** IMPLEMENTATION 2: Call the hook upon turn completion ***
        this.onTurnEnd?.(sessionId);
        // ***********************************************************
        current.running = false;
        current.runningEntry = undefined;
        current.runningSince = undefined;
        this.pump(sessionId);
      });
  }

  private pickNext(sq: SessionQueue): QueueEntry | undefined {
    if (sq.high.length === 0 && sq.normal.length === 0) return undefined;

    // Anti-starvation: if we've done N consecutive high-priority turns and normal has entries, pick normal
    if (
      sq.normal.length > 0 &&
      sq.consecutiveHighTurns >= this.starvationThreshold &&
      sq.high.length > 0
    ) {
      sq.consecutiveHighTurns = 0;
      return sq.normal.shift()!;
    }

    if (sq.high.length > 0) {
      sq.consecutiveHighTurns++;
      return sq.high.shift()!;
    }

    sq.consecutiveHighTurns = 0;
    return sq.normal.shift()!;
  }

  private removeMatching(arr: QueueEntry[], pred: (e: QueueEntry) => boolean): number {
    let removed = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (pred(arr[i])) {
        this.markDequeued(arr[i]);
        arr[i].reject(new TurnDroppedError(arr[i].id));
        arr.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  /** Fire an entry's onDequeued hook exactly once (start or drop), shielding the queue from hook errors. */
  private markDequeued(entry: QueueEntry): void {
    if (entry.dequeued) return;
    entry.dequeued = true;
    const cb = entry.hooks?.onDequeued;
    if (cb) this.safeHook(cb, "onDequeued", entry.id);
  }

  private safeHook(cb: () => void, hook: string, id: string): void {
    try {
      cb();
    } catch (err) {
      log.warn("turn_queue.hook_failed", { id, hook, err: String(err) });
    }
  }

  private cleanup(sessionId: string, sq: SessionQueue): void {
    if (!sq.running && sq.high.length === 0 && sq.normal.length === 0) {
      this.sessions.delete(sessionId);
    }
  }
}
