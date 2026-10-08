/**
 * Async file sink for the root logger.
 *
 * Log records are enqueued in-process and drained to a date-stamped JSON-lines
 * file (`shoggoth-YYYY-MM-DD.log`) by a serialized async flush loop, so the
 * logging call path never blocks on disk I/O. The queue is bounded: when it is
 * full, new entries are dropped and counted, and a single drop-report record is
 * appended once the queue drains. On date rollover the current file is closed,
 * gzipped (node:zlib — no external binaries) to `.log.gz`, and rotated away;
 * old archives beyond `maxFiles` are pruned. Any I/O failure disables the sink
 * (stderr logging is unaffected) and reports once via `onFatalError`.
 */

import { createReadStream, createWriteStream, promises as fsp } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export interface FileLogSinkOptions {
  /** Directory for the log files (must already exist — see `initFileLogging`). */
  dir: string;
  /** Max pending queue entries; further entries are dropped and counted. Default 10000. */
  maxQueue?: number;
  /** Rotated `.log.gz` archives to retain. Default 7. */
  maxFiles?: number;
  /** Clock injection for tests. */
  now?: () => Date;
  /** Called once when the sink disables itself after an I/O failure. */
  onFatalError?: (err: unknown) => void;
}

/** File name for a given day: `shoggoth-YYYY-MM-DD.log` (UTC date). */
export function logFileNameForDate(date: Date): string {
  return `shoggoth-${date.toISOString().slice(0, 10)}.log`;
}

/** Rotated archive name for a given day: `shoggoth-YYYY-MM-DD.log.gz` (UTC date). */
export function logArchiveNameForDate(date: Date): string {
  return `${logFileNameForDate(date)}.gz`;
}

const ARCHIVE_RE = /^shoggoth-\d{4}-\d{2}-\d{2}\.log\.gz$/;

export class FileLogSink {
  readonly dir: string;

  private readonly maxQueue: number;
  private readonly maxFiles: number;
  private readonly now: () => Date;
  private readonly onFatalError?: (err: unknown) => void;

  private queue: string[] = [];
  private droppedCount = 0;
  private flushScheduled = false;
  private flushChain: Promise<void> = Promise.resolve();
  private handle: fsp.FileHandle | undefined;
  private currentDateStamp: string | undefined;
  private disabled = false;

  constructor(opts: FileLogSinkOptions) {
    this.dir = opts.dir;
    this.maxQueue = opts.maxQueue ?? 10_000;
    this.maxFiles = opts.maxFiles ?? 7;
    this.now = opts.now ?? (() => new Date());
    this.onFatalError = opts.onFatalError;
  }

  /** Bounded enqueue — never throws, never blocks, schedules an async drain. */
  enqueue(line: string): void {
    if (this.disabled) return;
    if (this.queue.length >= this.maxQueue) {
      this.droppedCount += 1;
      return;
    }
    this.queue.push(line);
    this.scheduleFlush();
  }

  /** Pending (not yet written) entries. */
  get pending(): number {
    return this.queue.length;
  }

  /** Entries dropped since the last drain-to-zero. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Whether the sink has been closed or disabled after an I/O failure. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      void this.flush();
    });
  }

  /**
   * Drain the queue to disk. Serialized with any in-flight drain; safe to
   * await from tests and the shutdown path.
   */
  flush(): Promise<void> {
    const run = this.flushChain.then(() => this.drain());
    this.flushChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.disabled) {
      const batch = this.queue;
      this.queue = [];
      try {
        const stamp = this.now().toISOString().slice(0, 10);
        if (this.currentDateStamp !== undefined && this.currentDateStamp !== stamp) {
          await this.rotate();
        }
        this.currentDateStamp = stamp;
        if (!this.handle) {
          this.handle = await fsp.open(this.currentPath(), "a");
        }
        await this.handle.write(batch.join(""));
      } catch (err) {
        this.fail(err);
        return;
      }
    }
    // Report drops once the queue has drained (best effort; bypasses the cap once).
    if (this.droppedCount > 0 && !this.disabled) {
      const dropped = this.droppedCount;
      this.droppedCount = 0;
      const record = `${JSON.stringify({
        ts: this.now().toISOString(),
        level: "warn",
        msg: "file log sink dropped entries while the queue was full",
        component: "file-log-sink",
        dropped,
      })}\n`;
      try {
        if (!this.handle) this.handle = await fsp.open(this.currentPath(), "a");
        await this.handle.write(record);
      } catch (err) {
        this.fail(err);
      }
    }
  }

  private currentPath(): string {
    return join(this.dir, `shoggoth-${this.currentDateStamp}.log`);
  }

  /** Close the current file, gzip it to `.log.gz`, and prune old archives. */
  private async rotate(): Promise<void> {
    const oldStamp = this.currentDateStamp;
    if (!oldStamp) return;
    try {
      await this.handle?.close();
    } catch {
      /* ignore */
    }
    this.handle = undefined;
    const plain = join(this.dir, `shoggoth-${oldStamp}.log`);
    try {
      await pipeline(createReadStream(plain), createGzip(), createWriteStream(`${plain}.gz`));
      await fsp.rm(plain);
    } catch {
      // Keep the plain file if gzip fails; pruning below still runs.
    }
    await this.prune();
  }

  /** Retain only the newest `maxFiles` rotated archives. */
  private async prune(): Promise<void> {
    try {
      const entries = await fsp.readdir(this.dir);
      const archives = entries.filter((n) => ARCHIVE_RE.test(n)).sort();
      const excess = archives.slice(0, Math.max(0, archives.length - this.maxFiles));
      for (const name of excess) {
        await fsp.rm(join(this.dir, name));
      }
    } catch {
      // Best effort — stale archives are harmless.
    }
  }

  private fail(err: unknown): void {
    this.disabled = true;
    this.queue = [];
    try {
      this.handle?.close();
    } catch {
      /* ignore */
    }
    this.handle = undefined;
    try {
      this.onFatalError?.(err);
    } catch {
      /* ignore */
    }
  }

  /** Flush pending entries and close the current file (daemon shutdown). */
  async close(): Promise<void> {
    try {
      await this.flush();
    } catch {
      /* ignore */
    }
    this.disabled = true;
    try {
      await this.handle?.close();
    } catch {
      /* ignore */
    }
    this.handle = undefined;
  }
}
