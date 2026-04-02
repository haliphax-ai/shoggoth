import { randomUUID } from "node:crypto";

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

interface QueueEntry {
  readonly id: string;
  readonly priority: TurnPriority;
  readonly label: string;
  readonly enqueuedAt: number;
  readonly execute: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

interface SessionQueue {
  high: QueueEntry[];
  normal: QueueEntry[];
  running: boolean;
  consecutiveHighTurns: number;
}

export class TieredTurnQueue {
  private readonly sessions = new Map<string, SessionQueue>();
  readonly starvationThreshold: number;
  readonly maxDepth: number;

  constructor(starvationThreshold = 2, maxDepth = 6) {
    this.starvationThreshold = starvationThreshold;
    this.maxDepth = maxDepth;
  }

  enqueue(
    sessionId: string,
    priority: TurnPriority,
    label: string,
    fn: () => Promise<void>,
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
      };
      if (priority === "system") {
        sq.high.push(entry);
      } else {
        sq.normal.push(entry);
      }
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

  removeByCount(
    sessionId: string,
    priority: TurnPriority | "all",
    count: number,
  ): number {
    return this.removeByRange(sessionId, priority, 0, count - 1);
  }

  clear(sessionId: string, priority?: TurnPriority): number {
    const sq = this.sessions.get(sessionId);
    if (!sq) return 0;
    let removed = 0;
    if (!priority || priority === "system") {
      for (const e of sq.high) e.reject(new TurnDroppedError(e.id));
      removed += sq.high.length;
      sq.high = [];
    }
    if (!priority || priority === "user") {
      for (const e of sq.normal) e.reject(new TurnDroppedError(e.id));
      removed += sq.normal.length;
      sq.normal = [];
    }
    this.cleanup(sessionId, sq);
    return removed;
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
    const sq = this.sessions.get(sessionId);
    if (!sq || sq.running) return;
    const next = this.pickNext(sq);
    if (!next) {
      this.cleanup(sessionId, sq);
      return;
    }
    sq.running = true;
    next
      .execute()
      .then(() => next.resolve())
      .catch((err) => next.reject(err))
      .finally(() => {
        sq.running = false;
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
        arr[i].reject(new TurnDroppedError(arr[i].id));
        arr.splice(i, 1);
        removed++;
      }
    }
    return removed;
  }

  private cleanup(sessionId: string, sq: SessionQueue): void {
    if (!sq.running && sq.high.length === 0 && sq.normal.length === 0) {
      this.sessions.delete(sessionId);
    }
  }
}
