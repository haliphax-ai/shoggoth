import { getLogger } from "./logging";
import { installSignalHandlers } from "./signals";
import { ShutdownCoordinator, type ShutdownOptions } from "./shutdown";
import { HealthRegistry, type HealthSnapshot } from "./health";

interface DaemonRuntimeOptions {
  component?: string;
  logLevel?: string;
  shutdown: Omit<ShutdownOptions, "logger">;
}

export interface DaemonRuntime {
  health: HealthRegistry;
  shutdown: ShutdownCoordinator;
  getHealth: () => Promise<HealthSnapshot>;
  disposeSignals: () => void;
}

/**
 * Wires health registry, shutdown coordinator, and OS signals.
 */
export function createDaemonRuntime(options: DaemonRuntimeOptions): DaemonRuntime {
  const log = getLogger("runtime");

  const shutdown = new ShutdownCoordinator({
    ...options.shutdown,
  });

  const health = new HealthRegistry();

  const disposeSignals = installSignalHandlers({
    onSignal: (signal) => shutdown.requestShutdown(signal),
  });

  return {
    health,
    shutdown,
    getHealth: () => health.snapshot(),
    disposeSignals,
  };
}
