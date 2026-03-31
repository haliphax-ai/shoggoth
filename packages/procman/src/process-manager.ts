// ---------------------------------------------------------------------------
// Process Manager — orchestrates multiple ManagedProcess instances
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import type { ProcessSpec, ProcessOwner } from "./types.js";
import { ManagedProcess } from "./managed-process.js";

function log(level: string, msg: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(
    JSON.stringify({ level, msg, ...fields, ts: new Date().toISOString() }) + "\n",
  );
}

export class ProcessManager extends EventEmitter {
  private readonly processes = new Map<string, ManagedProcess>();

  /** Register and start a managed process. Returns the ManagedProcess handle. */
  async start(spec: ProcessSpec): Promise<ManagedProcess> {
    if (this.processes.has(spec.id)) {
      throw new Error(`Process with id "${spec.id}" is already registered`);
    }

    const mp = new ManagedProcess(spec);
    this.processes.set(spec.id, mp);

    // Forward lifecycle events
    mp.on("state-change", (newState: string, _oldState: string) => {
      if (newState === "running") {
        this.emit("process-started", mp);
      } else if (newState === "dead") {
        this.emit("process-stopped", mp);
      } else if (newState === "failed") {
        this.emit("process-failed", mp, new Error(`Process ${spec.id} failed`));
      }
    });

    try {
      await mp.start();
    } catch (err) {
      // Process failed to start — keep it registered so it can be inspected
      log("error", "process failed to start", { processId: spec.id, error: String(err) });
      this.emit("process-failed", mp, err);
    }

    return mp;
  }

  /** Stop a managed process by spec ID. */
  async stop(id: string): Promise<void> {
    const mp = this.processes.get(id);
    if (!mp) {
      throw new Error(`No process with id "${id}"`);
    }
    await mp.stop();
    this.processes.delete(id);
  }

  /**
   * Stop all managed processes in reverse dependency order.
   * Processes with no dependents are stopped first, working back to roots.
   */
  async stopAll(): Promise<void> {
    const order = this._reverseDepOrder();

    for (const batch of order) {
      await Promise.all(
        batch.map(async (id) => {
          const mp = this.processes.get(id);
          if (mp && mp.state !== "dead") {
            try {
              await mp.stop();
            } catch (err) {
              log("error", "error stopping process during stopAll", {
                processId: id,
                error: String(err),
              });
            }
          }
        }),
      );
    }

    this.processes.clear();
  }

  /** Get a handle by spec ID. */
  get(id: string): ManagedProcess | undefined {
    return this.processes.get(id);
  }

  /** List all managed processes. */
  list(): ManagedProcess[] {
    return [...this.processes.values()];
  }

  /** List processes filtered by owner. */
  listByOwner(owner: Partial<ProcessOwner>): ManagedProcess[] {
    return this.list().filter((mp) => {
      if (owner.kind != null && mp.spec.owner.kind !== owner.kind) return false;
      if (owner.scopeId != null && mp.spec.owner.scopeId !== owner.scopeId) return false;
      return true;
    });
  }

  /** Stop all processes scoped to a specific owner. */
  async stopByOwner(owner: Partial<ProcessOwner>): Promise<void> {
    const matches = this.listByOwner(owner);
    await Promise.all(
      matches.map(async (mp) => {
        try {
          await mp.stop();
          this.processes.delete(mp.spec.id);
        } catch (err) {
          log("error", "error stopping process by owner", {
            processId: mp.spec.id,
            error: String(err),
          });
        }
      }),
    );
  }

  // -- Internal: dependency ordering ----------------------------------------

  /**
   * Compute batches in reverse dependency order for shutdown.
   * Leaf nodes (no one depends on them) are stopped first.
   * Returns an array of batches — each batch can be stopped in parallel.
   */
  private _reverseDepOrder(): string[][] {
    const ids = new Set(this.processes.keys());
    // Build adjacency: dependsOn[A] = [B, C] means A depends on B and C
    // For shutdown, we want to stop A before B (reverse)
    // So we build "depended-on-by" (reverse edges) and do topological sort
    const dependedOnBy = new Map<string, Set<string>>();
    const dependsOn = new Map<string, Set<string>>();

    for (const id of ids) {
      dependedOnBy.set(id, new Set());
      dependsOn.set(id, new Set());
    }

    for (const [id, mp] of this.processes) {
      for (const dep of mp.spec.dependsOn ?? []) {
        if (ids.has(dep)) {
          dependedOnBy.get(dep)!.add(id);
          dependsOn.get(id)!.add(dep);
        }
      }
    }

    // Kahn's algorithm — but we want reverse order for shutdown
    // Nodes with no dependents (leaves) go first in shutdown
    const batches: string[][] = [];
    const remaining = new Set(ids);

    while (remaining.size > 0) {
      // Find nodes that have no remaining dependents (no one in `remaining` depends on them)
      const batch: string[] = [];
      for (const id of remaining) {
        const deps = dependedOnBy.get(id)!;
        const hasRemainingDependent = [...deps].some((d) => remaining.has(d));
        if (!hasRemainingDependent) {
          batch.push(id);
        }
      }

      if (batch.length === 0) {
        // Cycle detected — just stop everything remaining
        batches.push([...remaining]);
        break;
      }

      for (const id of batch) {
        remaining.delete(id);
      }
      batches.push(batch);
    }

    return batches;
  }
}
