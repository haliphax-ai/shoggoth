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

/** Get the singleton ProcessManager. Throws if not initialized. */
export function getProcessManager(): ProcessManager {
  if (!instance) throw new Error("ProcessManager not initialized — call initProcessManager() first");
  return instance;
}
