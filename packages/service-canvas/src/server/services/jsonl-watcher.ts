import { watch, type FSWatcher } from "chokidar";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getLogger } from "@shoggoth/shared";
import type { Gateway } from "./gateway";
import type { A2UIManager } from "./a2ui-manager";
import { processA2UICommand } from "./a2ui-pipeline";
import type { SchemaResolver } from "./a2ui-component-schemas";

const log = getLogger("service-canvas:jsonl-watcher");

export interface JSONLWatcherOptions {
  debounceMs?: number;
  /** Disable directory watchers (used by tests). */
  watch?: boolean;
}

/**
 * Watches each agent's canvas/jsonl/ directory for .jsonl file changes
 * and auto-pushes A2UI surface data to the canvas.
 */
export class JSONLWatcher {
  private watchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, Promise<void>>();
  private closed = false;
  private debounceMs: number;
  private watch: boolean;
  private resolveSchema?: SchemaResolver;

  constructor(
    private sessionPathMap: Map<string, string>,
    private gateway: Gateway,
    private a2uiManager: A2UIManager,
    options: JSONLWatcherOptions = {},
    resolveSchema?: SchemaResolver,
  ) {
    this.resolveSchema = resolveSchema;
    this.debounceMs = options.debounceMs ?? 300;
    this.watch = options.watch ?? true;

    if (!this.watch) return;

    for (const [session, canvasDir] of sessionPathMap) {
      const jsonlDir = path.join(canvasDir, "jsonl");
      if (fs.existsSync(canvasDir)) {
        fs.mkdirSync(jsonlDir, { recursive: true });
      }
      try {
        const watcher = watch(jsonlDir, {
          ignoreInitial: true,
          awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        });
        const handleEvent = (filePath: string) => {
          if (!filePath.endsWith(".jsonl")) return;
          this.scheduleProcess(session, filePath);
        };
        watcher.on("add", handleEvent);
        watcher.on("change", handleEvent);
        watcher.on("unlink", handleEvent);
        watcher.on("error", (err: unknown) => {
          log.warn("jsonl watcher error", {
            dir: jsonlDir,
            err: err instanceof Error ? err.message : String(err),
          });
        });
        this.watchers.set(session, watcher);
        log.debug("watching jsonl directory", { dir: jsonlDir, session });
      } catch (err: any) {
        log.warn("failed to watch jsonl directory", { dir: jsonlDir, err: err.message });
      }
    }
  }

  private scheduleProcess(session: string, filePath: string) {
    const key = `${session}\0${filePath}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.processFile(session, filePath);
      }, this.debounceMs),
    );
  }

  private async processLines(session: string, filePath: string, content: string) {
    const lines = content.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        log.warn("skipping invalid JSON line", {
          file: path.basename(filePath),
          preview: line.slice(0, 80),
        });
        continue;
      }

      try {
        processA2UICommand(session, parsed, this.a2uiManager, this.gateway, this.resolveSchema);
      } catch (err: any) {
        log.warn("failed to process jsonl command", {
          file: path.basename(filePath),
          command: typeof parsed === "object" && parsed ? Object.keys(parsed)[0] : undefined,
          err: err?.message ?? String(err),
        });
      }
    }
  }

  processFile(session: string, filePath: string): Promise<void> {
    const key = `${session}\0${filePath}`;
    const previous = this.pending.get(key);
    const run = (previous ?? Promise.resolve()).then(() => this.processOne(session, filePath));
    const settled = run.catch(() => {});
    this.pending.set(key, settled);
    void settled.then(() => {
      if (this.pending.get(key) === settled) this.pending.delete(key);
    });
    return run;
  }

  private async processOne(session: string, filePath: string): Promise<void> {
    let content: string;
    try {
      content = await fsp.readFile(filePath, "utf8");
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        log.warn("failed to read jsonl file", {
          file: path.basename(filePath),
          err: err?.message ?? String(err),
        });
      }
      return;
    }

    if (this.closed) return;
    await this.processLines(session, filePath, content);
  }

  close(): void {
    this.closed = true;
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    this.closeWatchers();
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close().catch((err: unknown) => {
        log.warn("failed to close jsonl watcher", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
    this.watchers.clear();
  }

  /**
   * Close watchers and timers, then wait for all in-flight processing to
   * finish before arming the closed gate.
   */
  async closeAndWait(): Promise<void> {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    for (const watcher of this.watchers.values()) {
      try {
        await watcher.close();
      } catch (err: unknown) {
        log.warn("failed to close jsonl watcher", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.watchers.clear();
    const pending = [...this.pending.values()];
    if (pending.length) await Promise.all(pending);
    this.closed = true;
  }
}
