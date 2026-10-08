// ---------------------------------------------------------------------------
// TimerScheduler — in-process setTimeout-based scheduler with min-heap
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";
import { TimerHeap, type TimerEntry } from "./timer-heap";
import { getLogger } from "../logging";

const log = getLogger("timer-scheduler");

interface TimerRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly label: string;
  readonly fireAt: string; // ISO 8601 UTC
  readonly message: string;
  readonly sessionAnchor?: string | null;
}

type TimerDeliveryFn = (sessionId: string, message: string) => Promise<void>;

export class TimerScheduler {
  private readonly heap = new TimerHeap();
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private db: Database.Database | undefined;
  private readonly deliver: TimerDeliveryFn;
  /** Pending timers per session — buffered until flushSession() is called after a turn ends. */
  private readonly pendingTimers = new Map<string, TimerRecord[]>();

  constructor(deliver: TimerDeliveryFn) {
    this.deliver = deliver;
  }

  /**
   * Schedule a new timer. Inserts into DB immediately (for persistence and listing),
   * but does NOT activate it in the heap. Call {@link flushSession} after the turn
   * completes to move pending timers into the heap.
   */
  schedule(db: Database.Database, timer: TimerRecord): void {
    this.db = db;
    db.prepare(
      `INSERT INTO timers (id, session_id, label, fire_at, message, session_anchor)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      timer.id,
      timer.sessionId,
      timer.label,
      timer.fireAt,
      timer.message,
      timer.sessionAnchor ?? null,
    );

    let buf = this.pendingTimers.get(timer.sessionId);
    if (!buf) {
      buf = [];
      this.pendingTimers.set(timer.sessionId, buf);
    }
    buf.push(timer);
  }

  /**
   * Activate all pending timers for a session — moves them from the buffer
   * into the heap and reschedules. Called by the turn queue after a turn ends.
   */
  flushSession(sessionId: string): void {
    const pending = this.pendingTimers.get(sessionId);
    if (!pending || pending.length === 0) return;

    log.debug("flushing pending timers", { sessionId, count: pending.length });

    for (const timer of pending) {
      this.heap.insert({
        id: timer.id,
        sessionId: timer.sessionId,
        label: timer.label,
        fireAt: timer.fireAt,
        message: timer.message,
        sessionAnchor: timer.sessionAnchor,
      });
    }

    this.pendingTimers.delete(sessionId);
    this.reschedule();
  }

  /** Cancel a timer by ID. Marks fired=1 in DB and removes from heap or pending buffer. */
  cancel(db: Database.Database, id: string): boolean {
    this.db = db;
    const removed = this.heap.removeById(id);
    if (!removed) {
      // Check pending buffer
      let foundPending = false;
      for (const [, timers] of this.pendingTimers) {
        const idx = timers.findIndex((t) => t.id === id);
        if (idx !== -1) {
          timers.splice(idx, 1);
          foundPending = true;
          break;
        }
      }
      if (!foundPending) {
        const row = db.prepare("SELECT id FROM timers WHERE id = ? AND fired = 0").get(id) as
          | { id: string }
          | undefined;
        if (!row) return false;
      }
    }
    db.prepare("UPDATE timers SET fired = 1 WHERE id = ?").run(id);
    if (removed) {
      this.reschedule();
    }
    return true;
  }

  /** Cancel all unfired timers anchored to a session. Idempotent — safe when no timers are anchored. Returns count canceled. */
  cancelByAnchorSession(sessionId: string): number {
    const db = this.db;
    if (!db) return 0;
    const rows = db
      .prepare("SELECT id FROM timers WHERE session_anchor = ? AND fired = 0")
      .all(sessionId) as Array<{ id: string }>;
    let count = 0;
    for (const r of rows) {
      if (this.cancel(db, r.id)) count += 1;
    }
    return count;
  }

  /** List active (unfired) timers for a session. */
  listForSession(db: Database.Database, sessionId: string): TimerRecord[] {
    const rows = db
      .prepare(
        "SELECT id, session_id, label, fire_at, message, session_anchor FROM timers WHERE session_id = ? AND fired = 0 ORDER BY fire_at ASC",
      )
      .all(sessionId) as Array<{
      id: string;
      session_id: string;
      label: string;
      fire_at: string;
      message: string;
      session_anchor: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      label: r.label,
      fireAt: r.fire_at,
      message: r.message,
      sessionAnchor: r.session_anchor,
    }));
  }

  /** Count active (unfired) timers for a session. */
  countForSession(db: Database.Database, sessionId: string): number {
    const row = db
      .prepare("SELECT COUNT(*) as cnt FROM timers WHERE session_id = ? AND fired = 0")
      .get(sessionId) as { cnt: number };
    return row.cnt;
  }

  /** Restore state on startup: fire any past-due timers, schedule the rest directly into the heap. */
  async restore(db: Database.Database): Promise<void> {
    this.db = db;
    const rows = db
      .prepare(
        "SELECT id, session_id, label, fire_at, message, session_anchor FROM timers WHERE fired = 0 ORDER BY fire_at ASC",
      )
      .all() as Array<{
      id: string;
      session_id: string;
      label: string;
      fire_at: string;
      message: string;
      session_anchor: string | null;
    }>;

    const now = new Date().toISOString();
    for (const r of rows) {
      const entry: TimerEntry = {
        id: r.id,
        sessionId: r.session_id,
        label: r.label,
        fireAt: r.fire_at,
        message: r.message,
        sessionAnchor: r.session_anchor,
      };
      if (r.fire_at <= now) {
        await this.fireTimer(db, entry);
      } else {
        // On restore there's no active turn — go straight into the heap
        this.heap.insert(entry);
      }
    }
    this.reschedule();
    if (rows.length > 0) {
      log.info("timers restored", {
        total: rows.length,
        pending: this.heap.size,
      });
    }
  }

  /** Tear down — clear pending timeout. */
  shutdown(): void {
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }

  // ---- internal ----

  private async fireTimer(db: Database.Database, entry: TimerEntry): Promise<void> {
    try {
      db.prepare("UPDATE timers SET fired = 1 WHERE id = ?").run(entry.id);
      await this.deliver(entry.sessionId, entry.message);
      log.debug("timer fired", {
        id: entry.id,
        sessionId: entry.sessionId,
        label: entry.label,
      });
    } catch (e) {
      log.warn("timer delivery failed", {
        id: entry.id,
        sessionId: entry.sessionId,
        err: String(e),
      });
    }
  }

  private reschedule(): void {
    if (this.timeout !== undefined) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    const head = this.heap.peek();
    if (!head) return;

    const delayMs = Math.max(0, new Date(head.fireAt).getTime() - Date.now());
    this.timeout = setTimeout(() => {
      void this.tick();
    }, delayMs);
    if (this.timeout && typeof this.timeout === "object" && "unref" in this.timeout) {
      (this.timeout as NodeJS.Timeout).unref();
    }
  }

  private async tick(): Promise<void> {
    this.timeout = undefined;
    const db = this.db;
    if (!db) return;

    const now = new Date().toISOString();
    while (this.heap.size > 0) {
      const head = this.heap.peek()!;
      if (head.fireAt > now) break;
      this.heap.extractMin();
      await this.fireTimer(db, head);
    }
    this.reschedule();
  }
}
