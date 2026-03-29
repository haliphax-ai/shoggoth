import { createLogger, type Logger } from "./logging";
import { installSignalHandlers } from "./signals";
import { ShutdownCoordinator, type ShutdownOptions } from "./shutdown";
import { HealthRegistry, type HealthSnapshot } from "./health";

export interface DaemonRuntimeOptions {
  component?: string;
  logLevel?: Parameters<typeof createLogger>[0]["minLevel"];
  shutdown: Omit<ShutdownOptions, "logger">;
}

export interface DaemonRuntime {
  logger: Logger;
  health: HealthRegistry;
  shutdown: ShutdownCoordinator;
  getHealth: () => Promise<HealthSnapshot>;
  disposeSignals: () => void;
}

/**
 * Wires logging, health registry, shutdown coordinator, and OS signals.
 */
export function createDaemonRuntime(options: DaemonRuntimeOptions): DaemonRuntime {
  const logger = createLogger({
    component: options.component ?? "daemon",
    minLevel: options.logLevel,
  });

  const shutdown = new ShutdownCoordinator({
    ...options.shutdown,
    logger: logger.child({ subsystem: "shutdown" }),
  });

  const health = new HealthRegistry();

  const disposeSignals = installSignalHandlers({
    logger: logger.child({ subsystem: "signals" }),
    onSignal: (signal) => shutdown.requestShutdown(signal),
  });

  return {
    logger,
    health,
    shutdown,
    getHealth: () => health.snapshot(),
    disposeSignals,
  };
}
