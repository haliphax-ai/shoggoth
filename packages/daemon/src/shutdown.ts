import { getLogger } from "./logging";

export type DrainFn = () => void | Promise<void>;

export interface ShutdownOptions {
  drainTimeoutMs: number;
  onStopAccepting?: () => void | Promise<void>;
  /** Mark in-flight tool loops / cron slices failed when interrupted by shutdown. */
  markInterruptedRunsFailed?: (reason: string) => void | Promise<void>;
}

type RegisteredDrain = { name: string; fn: DrainFn };

/**
 * Coordinates graceful shutdown: stop accepting work, run drains in registration order, then optional failure marking.
 */
export class ShutdownCoordinator {
  private readonly opts: ShutdownOptions;
  private readonly drains: RegisteredDrain[] = [];
  private phase: "running" | "stopping" | "done" = "running";
  private shutdownPromise: Promise<void>;
  private resolveShutdown!: () => void;

  constructor(opts: ShutdownOptions) {
    this.opts = opts;
    this.shutdownPromise = new Promise<void>((r) => {
      this.resolveShutdown = r;
    });
  }

  registerDrain(name: string, fn: DrainFn): () => void {
    const entry: RegisteredDrain = { name, fn };
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
      for (const { name, fn } of [...this.drains]) {
        if (timedOut) break;
        const left = deadline - Date.now();
        if (left <= 0) {
          timedOut = true;
          break;
        }
        try {
          await Promise.race([
            Promise.resolve(fn()),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("drain deadline")), Math.max(1, left)),
            ),
          ]);
          log.debug("drain complete", { drain: name });
        } catch (e) {
          log.error("drain failed", { drain: name, err: String(e) });
          if (e instanceof Error && e.message === "drain deadline") {
            timedOut = true;
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
