import type { Logger } from "./logging";

export type SignalName = NodeJS.Signals;

export interface SignalHandlerOptions {
  logger: Logger;
  signals?: SignalName[];
  onSignal: (signal: SignalName) => void | Promise<void>;
  proc?: Pick<NodeJS.Process, "on" | "off" | "pid">;
}

/**
 * Installs handlers for SIGINT/SIGTERM (configurable).
 * Returns a disposer that removes listeners.
 */
export function installSignalHandlers(options: SignalHandlerOptions): () => void {
  const proc = options.proc ?? process;
  const signals = options.signals ?? (["SIGINT", "SIGTERM"] as SignalName[]);
  const logger = options.logger;

  const listeners = new Map<SignalName, () => void>();
  for (const s of signals) {
    const listener = () => {
      void Promise.resolve(options.onSignal(s)).catch((e) => {
        logger.error("onSignal handler failed", { signal: s, err: String(e) });
      });
    };
    listeners.set(s, listener);
    proc.on(s, listener);
  }

  return () => {
    for (const [s, listener] of listeners) {
      proc.off(s, listener);
    }
  };
}
