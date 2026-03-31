// ---------------------------------------------------------------------------
// Singleton ProcessManager for the daemon
// ---------------------------------------------------------------------------

import { ProcessManager } from "@shoggoth/procman";

let instance: ProcessManager | undefined;

/** Initialize the singleton ProcessManager. Call once at daemon startup. */
export function initProcessManager(): ProcessManager {
  if (instance) return instance;
  instance = new ProcessManager();
  return instance;
}

/** Get the singleton ProcessManager, or undefined if not yet initialized. */
export function getProcessManager(): ProcessManager | undefined {
  return instance;
}
