// ---------------------------------------------------------------------------
// builtin-discover — dynamic tool enable/disable/list
// ---------------------------------------------------------------------------

import type { BuiltinToolRegistry, BuiltinToolContext } from "../builtin-tool-registry";
import {
  getSessionToolState,
  setSessionToolState,
  resolveToolDiscoveryConfig,
  toolRefreshNeeded,
  toolCatalogCache,
} from "../session-tool-discovery";

export function register(registry: BuiltinToolRegistry): void {
  registry.register("discover", discoverHandler);
}

async function discoverHandler(
  args: Record<string, unknown>,
  ctx: BuiltinToolContext,
): Promise<{ resultJson: string }> {
  const resolved = resolveToolDiscoveryConfig(ctx.config, ctx.sessionId);
  if (!resolved.enabled) {
    return { resultJson: JSON.stringify({ error: "tool discovery is not enabled" }) };
  }

  const enable = Array.isArray(args.enable) ? (args.enable as string[]) : [];
  const disable = Array.isArray(args.disable) ? (args.disable as string[]) : [];
  const list = args.list === true;

  const currentState = getSessionToolState(ctx.db, ctx.sessionId);

  const applied: { enabled: string[]; disabled: string[]; rejected: Array<{ id: string; reason: string }> } = {
    enabled: [],
    disabled: [],
    rejected: [],
  };

  // Process enables
  for (const id of enable) {
    if (typeof id !== "string" || !id) {
      applied.rejected.push({ id: String(id), reason: "invalid_id" });
      continue;
    }
    setSessionToolState(ctx.db, ctx.sessionId, id, true);
    applied.enabled.push(id);
  }

  // Process disables
  for (const id of disable) {
    if (typeof id !== "string" || !id) {
      applied.rejected.push({ id: String(id), reason: "invalid_id" });
      continue;
    }
    if (resolved.alwaysOn.has(id)) {
      applied.rejected.push({ id, reason: "always_on" });
      continue;
    }
    setSessionToolState(ctx.db, ctx.sessionId, id, false);
    applied.disabled.push(id);
  }

  // Signal refresh needed if any state changed
  if (applied.enabled.length > 0 || applied.disabled.length > 0) {
    toolRefreshNeeded.set(ctx.sessionId, true);
  }

  const result: Record<string, unknown> = { applied };

  // Build catalog if requested
  if (list) {
    const updatedState = getSessionToolState(ctx.db, ctx.sessionId);
    const descriptions = toolCatalogCache.get(ctx.sessionId);

    const catalog: Array<{ id: string; description: string; enabled: boolean; alwaysOn: boolean }> = [];
    // Tools known from the aggregated catalog (via cached descriptions)
    if (descriptions) {
      for (const [toolId, description] of descriptions) {
        const isAlwaysOn = resolved.alwaysOn.has(toolId);
        const dbEnabled = updatedState.get(toolId);
        catalog.push({
          id: toolId,
          description,
          enabled: isAlwaysOn || dbEnabled === true,
          alwaysOn: isAlwaysOn,
        });
      }
    } else {
      // Fallback: DB state only (no descriptions available)
      for (const [toolId, enabled] of updatedState) {
        catalog.push({
          id: toolId,
          description: toolId,
          enabled: resolved.alwaysOn.has(toolId) || enabled,
          alwaysOn: resolved.alwaysOn.has(toolId),
        });
      }
      // Add always-on tools not in DB
      for (const id of resolved.alwaysOn) {
        if (!updatedState.has(id)) {
          catalog.push({ id, description: id, enabled: true, alwaysOn: true });
        }
      }
    }
    result.catalog = catalog;
  }

  return { resultJson: JSON.stringify(result) };
}
