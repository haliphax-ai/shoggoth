import { getLogger } from "./logging";

type SignalName = NodeJS.Signals;

interface SignalHandlerOptions {
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
  const log = getLogger("signals");

  const listeners = new Map<SignalName, () => void>();
  for (const s of signals) {
    const listener = () => {
      void Promise.resolve(options.onSignal(s)).catch((e) => {
        log.error("onSignal handler failed", { signal: s, err: String(e) });
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
