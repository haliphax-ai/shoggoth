import fs from "node:fs";
import path from "node:path";
import { getLogger } from "@shoggoth/shared";
import type { Gateway } from "./gateway";
import type { A2UIManager } from "./a2ui-manager";
import { processA2UICommand } from "./a2ui-pipeline";
import type { SchemaResolver } from "./a2ui-component-schemas";

const log = getLogger("service-canvas:jsonl-watcher");

export interface JSONLWatcherOptions {
  debounceMs?: number;
}

/**
 * Watches each agent's canvas/jsonl/ directory for .jsonl file changes
 * and auto-pushes A2UI surface data to the canvas.
 */
export class JSONLWatcher {
  private watchers = new Map<string, fs.FSWatcher>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;
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

    for (const [session, canvasDir] of sessionPathMap) {
      const jsonlDir = path.join(canvasDir, "jsonl");
      if (fs.existsSync(canvasDir)) {
        fs.mkdirSync(jsonlDir, { recursive: true });
      }
      try {
        const watcher = fs.watch(jsonlDir, (eventType, filename) => {
          if (!filename || !filename.endsWith(".jsonl")) return;
          if (eventType !== "change" && eventType !== "rename") return;
          const filePath = path.join(jsonlDir, filename);
          this.scheduleProcess(session, filePath);
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

  processFile(session: string, filePath: string) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      return; // file may have been deleted
    }

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

      processA2UICommand(session, parsed, this.a2uiManager, this.gateway, this.resolveSchema);
    }
  }

  close() {
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}
