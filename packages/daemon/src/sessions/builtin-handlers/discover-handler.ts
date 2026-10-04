// ---------------------------------------------------------------------------
// builtin-discover — dynamic tool enable/disable/list/reset
// ---------------------------------------------------------------------------

import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import {
  getSessionToolState,
  setSessionToolState,
  clearSessionToolState,
  resolveToolDiscoveryConfig,
  isAlwaysOnTool,
  isToolEnabledByState,
  toolRefreshNeeded,
  toolCatalogCache,
} from "../session-tool-discovery";
import { isGlobPattern } from "../tool-id-glob";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("discover", discoverHandler);
}

async function discoverHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const resolved = resolveToolDiscoveryConfig(ctx.config, ctx.sessionId);
  if (!resolved.enabled) {
    return {
      resultJson: JSON.stringify({ error: "tool discovery is not enabled" }),
    };
  }

  const enable = Array.isArray(args.enable) ? (args.enable as string[]) : [];
  const disable = Array.isArray(args.disable) ? (args.disable as string[]) : [];
  const reset = args.reset === true;
  const list = args.list === true;

  const applied: {
    enabled: string[];
    disabled: string[];
    reset?: boolean;
    rejected: Array<{ id: string; reason: string }>;
  } = {
    enabled: [],
    disabled: [],
    rejected: [],
  };

  // Process reset first (clears all session tool state)
  if (reset) {
    clearSessionToolState(ctx.db, ctx.sessionId);
    applied.reset = true;
  }

  // Process enables (after reset, so these apply to clean state)
  for (const id of enable) {
    if (typeof id !== "string" || !id) {
      applied.rejected.push({ id: String(id), reason: "invalid_id" });
      continue;
    }
    setSessionToolState(ctx.db, ctx.sessionId, id, true);
    applied.enabled.push(id);
  }

  // Process disables (after reset and enables)
  for (const id of disable) {
    if (typeof id !== "string" || !id) {
      applied.rejected.push({ id: String(id), reason: "invalid_id" });
      continue;
    }
    if (isAlwaysOnTool(id, resolved.alwaysOn)) {
      applied.rejected.push({ id, reason: "always_on" });
      continue;
    }
    setSessionToolState(ctx.db, ctx.sessionId, id, false);
    applied.disabled.push(id);
  }

  // Signal refresh needed if any state changed
  if (applied.enabled.length > 0 || applied.disabled.length > 0 || applied.reset) {
    toolRefreshNeeded.set(ctx.sessionId, true);
  }

  const result: Record<string, unknown> = { applied };

  // Build catalog if requested
  if (list) {
    const updatedState = getSessionToolState(ctx.db, ctx.sessionId);
    const descriptions = toolCatalogCache.get(ctx.sessionId);

    const catalog: Array<{
      id: string;
      description: string;
      enabled: boolean;
      alwaysOn: boolean;
    }> = [];
    // Tools known from the aggregated catalog (via cached descriptions)
    if (descriptions) {
      const stateGlobs = [...updatedState.entries()]
        .filter(([id, enabled]) => enabled && isGlobPattern(id))
        .map(([id]) => id);
      for (const [toolId, description] of descriptions) {
        const isAlwaysOn = isAlwaysOnTool(toolId, resolved.alwaysOn);
        catalog.push({
          id: toolId,
          description,
          enabled: isAlwaysOn || isToolEnabledByState(toolId, updatedState, stateGlobs),
          alwaysOn: isAlwaysOn,
        });
      }
    } else {
      // Fallback: DB state only (no descriptions available)
      for (const [toolId, enabled] of updatedState) {
        if (isGlobPattern(toolId)) continue;
        catalog.push({
          id: toolId,
          description: toolId,
          enabled: resolved.alwaysOn.has(toolId) || enabled,
          alwaysOn: resolved.alwaysOn.has(toolId),
        });
      }
      // Add always-on tools not in DB (globs match concrete tools only, not catalog rows)
      for (const id of resolved.alwaysOn) {
        if (isGlobPattern(id)) continue;
        if (!updatedState.has(id)) {
          catalog.push({ id, description: id, enabled: true, alwaysOn: true });
        }
      }
    }
    result.catalog = catalog;
  }

  return { resultJson: JSON.stringify(result) };
}
