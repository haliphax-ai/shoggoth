import type { ShoggothConfig } from "./schema.js";

/**
 * Whether automatic thread-based subagent session creation is enabled. When true, a new
 * thread created in a top-level agent session's channel gets a bound subagent session.
 * Omitted defaults to **true** (backward compatible); `agents.threadSubagents: false`
 * disables the feature globally.
 */
export function effectiveThreadSubagentsEnabled(cfg: ShoggothConfig): boolean {
  return cfg.agents?.threadSubagents !== false;
}
