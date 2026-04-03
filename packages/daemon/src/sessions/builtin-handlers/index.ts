// ---------------------------------------------------------------------------
// Builtin handler registration — barrel file
// ---------------------------------------------------------------------------

import type { BuiltinToolRegistry } from "../builtin-tool-registry";

import { register as registerConfig } from "./config-handlers";
import { register as registerMessage } from "./message-handler";
import { register as registerProcman } from "./procman-handlers";
import { register as registerSkills } from "./skills-handlers";
import { register as registerSession } from "./session-handlers";
import { register as registerFs } from "./fs-handlers";
import { register as registerExec } from "./exec-handler";
import { register as registerMemory } from "./memory-handlers";
import { register as registerWorkflow } from "./workflow-handler";
import { register as registerWebSearch } from "./web-search-handler";
import { register as registerShow } from "./show-handler";

/**
 * Register all builtin tool handlers on the given registry.
 */
export function registerAllBuiltinHandlers(registry: BuiltinToolRegistry): void {
  registerConfig(registry);
  registerMessage(registry);
  registerProcman(registry);
  registerSkills(registry);
  registerSession(registry);
  registerFs(registry);
  registerExec(registry);
  registerMemory(registry);
  registerWorkflow(registry);
  registerWebSearch(registry);
  registerShow(registry);
}
