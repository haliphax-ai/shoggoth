import { getLogger } from "./logging";

type DrainFn = () => void | Promise<void>;

export interface ShutdownOptions {
  drainTimeoutMs: number;
  onStopAccepting?: () => void | Promise<void>;
  /** Mark in-flight tool loops / cron slices failed when interrupted by shutdown. */
  markInterruptedRunsFailed?: (reason: string) => void | Promise<void>;
}

export interface DrainGroup {
  /**
   * Group number — drains with the same number run in parallel.
   * Groups execute in ascending numeric order.
   *
   * Drains registered **without** this option each get a unique implicit group
   * and execute sequentially in registration order (backward compatible).
   */
  group: number;
}

type RegisteredDrain = { name: string; fn: DrainFn; group: number };

/** Result type for parallel drain execution. */
type DrainResult = { name: string; ok: true } | { name: string; ok: false; err: unknown };

/**
 * Coordinates graceful shutdown: stop accepting work, run drains (grouped
 * by dependency level for parallel execution), then optional failure marking.
 *
 * Drains with the same `group` number run in parallel via
 * `Promise.allSettled`. Groups execute in ascending numeric order.
 * Drains registered without a group are sequential (backward compatible).
 *
 * @example
 * ```ts
 * // Independent drains — same group, runs in parallel
 * coordinator.registerDrain("gateway", () => gw.stop(), { group: 1 });
 * coordinator.registerDrain("health-poller", () => hp.stop(), { group: 1 });
 *
 * // Dependent drain — runs after group 1 completes
 * coordinator.registerDrain("cleanup", () => cleanup(), { group: 2 });
 * ```
 */
export class ShutdownCoordinator {
  private readonly opts: ShutdownOptions;
  private readonly drains: RegisteredDrain[] = [];
  private phase: "running" | "stopping" | "done" = "running";
  private shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;
  private nextImplicitGroup = 0;

  constructor(opts: ShutdownOptions) {
    this.opts = opts;
    this.shutdownPromise = new Promise<void>((r) => {
      this.resolveShutdown = r;
    });
  }

  /**
   * Register a drain function to be called during shutdown.
   *
   * @param name - Human-readable name for logging.
   * @param fn - Async or sync function to execute during shutdown.
   * @param options - Optional `DrainGroup` controlling parallel execution.
   *   Drains with the same `group` run in parallel; groups execute in ascending order.
   *   Omit to run sequentially in registration order (backward compatible).
   * @returns Unsubscribe function to remove this drain.
   */
  registerDrain(name: string, fn: DrainFn, options?: DrainGroup): () => void {
    const group = options?.group ?? this.nextImplicitGroup++;
    const entry: RegisteredDrain = { name, fn, group };
    this.drains.push(entry);
    return () => {
      const i = this.drains.indexOf(entry);
      if (i >= 0) this.drains.splice(i, 1);
    };
  }

  get finished(): Promise<void> {
    return this.shutdownPromise;
  }

  isShuttingDown(): boolean {
    return this.phase !== "running";
  }

  /** Run a single drain with a deadline. */
  private async runDrain(
    drain: RegisteredDrain,
    deadline: number,
    log: ReturnType<typeof getLogger>,
    groupKey: number,
  ): Promise<DrainResult> {
    const left = deadline - Date.now();
    if (left <= 0) {
      return { name: drain.name, ok: false, err: new Error("drain deadline") };
    }
    try {
      await Promise.race([
        Promise.resolve(drain.fn()),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("drain deadline")), Math.max(1, left)),
        ),
      ]);
      log.debug("drain complete", { drain: drain.name, group: groupKey });
      return { name: drain.name, ok: true };
    } catch (e) {
      log.error("drain failed", { drain: drain.name, group: groupKey, err: String(e) });
      return { name: drain.name, ok: false, err: e };
    }
  }

  async requestShutdown(signal: string): Promise<void> {
    if (this.phase !== "running") return;
    this.phase = "stopping";
    const log = getLogger("shutdown");
    log.info("shutdown requested", { signal });

    try {
      await this.opts.onStopAccepting?.();
    } catch (e) {
      log.error("onStopAccepting failed", { err: String(e) });
    }

    const timeout = this.opts.drainTimeoutMs;
    const deadline = Date.now() + timeout;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      log.warn("shutdown drain timeout", { drainTimeoutMs: timeout });
    }, timeout);

    try {
      // Build ordered list of groups (preserving first-seen registration order)
      const groupOrder: number[] = [];
      const groupDrains = new Map<number, RegisteredDrain[]>();

      for (const drain of this.drains) {
        if (!groupDrains.has(drain.group)) {
          groupOrder.push(drain.group);
          groupDrains.set(drain.group, []);
        }
        groupDrains.get(drain.group)!.push(drain);
      }

      // Execute each group: drains within a group run in parallel
      for (const groupKey of groupOrder) {
        if (timedOut) break;
        const drainsInGroup = groupDrains.get(groupKey)!;

        if (drainsInGroup.length === 1) {
          const result = await this.runDrain(drainsInGroup[0], deadline, log, groupKey);
          if (
            !result.ok &&
            result.err instanceof Error &&
            result.err.message === "drain deadline"
          ) {
            timedOut = true;
          }
        } else {
          const left = deadline - Date.now();
          if (left <= 0) {
            timedOut = true;
            break;
          }
          log.debug("draining group in parallel", {
            group: groupKey,
            drains: drainsInGroup.map((d) => d.name),
          });
          const results = await Promise.allSettled(
            drainsInGroup.map((d) => this.runDrain(d, deadline, log, groupKey)),
          );
          for (const r of results) {
            if (r.status === "fulfilled" && !r.value.ok) {
              const err = r.value.err;
              if (err instanceof Error && err.message === "drain deadline") {
                timedOut = true;
              }
            } else if (r.status === "rejected") {
              if (r.reason instanceof Error && r.reason.message === "drain deadline") {
                timedOut = true;
              }
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }

    const reason = timedOut ? `shutdown_timeout:${signal}` : `shutdown:${signal}`;
    try {
      await this.opts.markInterruptedRunsFailed?.(reason);
    } catch (e) {
      log.error("markInterruptedRunsFailed failed", { err: String(e) });
    }

    this.phase = "done";
    this.resolveShutdown();
  }
}
