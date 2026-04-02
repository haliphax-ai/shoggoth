// ---------------------------------------------------------------------------
// memory-search & memory-ingest handlers
// ---------------------------------------------------------------------------

import { runMemoryBuiltin } from "../../memory/builtin-memory-tools";
import type { BuiltinToolRegistry } from "../builtin-tool-registry";

export function register(registry: BuiltinToolRegistry): void {
  for (const name of ["memory-search", "memory-ingest"] as const) {
    registry.register(name, async (_args, ctx) => {
      // runMemoryBuiltin expects the raw argsJson string and the originalName
      const argsJson = JSON.stringify(_args);
      return runMemoryBuiltin({
        originalName: name,
        argsJson,
        db: ctx.db,
        workspacePath: ctx.workspacePath,
        memory: ctx.memoryConfig,
        env: ctx.orchestratorEnv,
        runtimeOpenaiBaseUrl: ctx.runtimeOpenaiBaseUrl,
      });
    });
  }
}
