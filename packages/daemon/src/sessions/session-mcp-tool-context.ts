import type { OpenAIToolFunctionDefinition } from "@shoggoth/models";
import type {
  AggregateMcpCatalogResult,
  AggregatedTool,
  McpSourceCatalog,
  MessageToolPlatformSlice,
} from "@shoggoth/mcp-integration";
import { buildMessageToolDescriptor } from "@shoggoth/mcp-integration";
import {
  isSubagentSessionUrn,
  parseAgentSessionUrn,
  resolveContextLevel,
  type ContextLevel,
  type ContextLevelToolOverride,
  type ShoggothConfig,
} from "@shoggoth/shared";
import { messageToolContextRef } from "../messaging/message-tool-context-ref";
import {
  buildAggregatedMcpCatalog,
  mcpToolsForToolLoop,
  type ExternalMcpInvoke,
} from "../mcp/tool-loop-mcp";

export type SessionMcpToolContext = {
  readonly aggregated: AggregateMcpCatalogResult;
  readonly toolsOpenAi: OpenAIToolFunctionDefinition[];
  readonly toolsLoop: ReturnType<typeof mcpToolsForToolLoop>;
  readonly external?: ExternalMcpInvoke;
};

export function openAiToolsFromCatalog(aggregated: AggregateMcpCatalogResult): OpenAIToolFunctionDefinition[] {
  return aggregated.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.namespacedName,
      description: t.description ?? `${t.sourceId}-${t.originalName}`,
      parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    },
  }));
}

/**
 * Appends `builtin-message` when a messaging runtime registers a capability slice.
 */
function augmentSessionMcpToolContextWithMessageTool(
  base: SessionMcpToolContext,
  slice: MessageToolPlatformSlice | undefined,
): SessionMcpToolContext {
  const desc = buildMessageToolDescriptor(slice);
  if (!desc) return base;
  const extra: AggregatedTool = {
    ...desc,
    namespacedName: "builtin-message",
    sourceId: "builtin",
    originalName: "message",
  };
  const aggregated: AggregateMcpCatalogResult = {
    tools: [...base.aggregated.tools, extra],
  };
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external: base.external,
  };
}

/** External MCP slices only (built-ins come from {@link buildAggregatedMcpCatalog}). */
export function buildSessionMcpToolContext(
  externalSources: readonly McpSourceCatalog[],
  external: ExternalMcpInvoke | undefined,
): SessionMcpToolContext {
  const aggregated = buildAggregatedMcpCatalog(externalSources);
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external,
  };
}

/**
 * Merges global + per-session MCP tool catalogs (global sources first). Duplicate `source-tool`
 * names across pools make aggregate throw — use distinct server `id`s.
 */
export function buildMixedSessionMcpToolContext(
  globalSources: readonly McpSourceCatalog[],
  globalExternal: ExternalMcpInvoke | undefined,
  sessionSources: readonly McpSourceCatalog[],
  sessionExternal: ExternalMcpInvoke | undefined,
  globalSourceIds: ReadonlySet<string>,
  perSessionSourceIds: ReadonlySet<string>,
): SessionMcpToolContext {
  const aggregated = buildAggregatedMcpCatalog([...globalSources, ...sessionSources]);
  let external: ExternalMcpInvoke | undefined;
  if (globalExternal && sessionExternal) {
    external = async (input) => {
      if (globalSourceIds.has(input.sourceId)) return globalExternal(input);
      if (perSessionSourceIds.has(input.sourceId)) return sessionExternal(input);
      return {
        resultJson: JSON.stringify({
          error: "mcp_source_unknown",
          sourceId: input.sourceId,
          detail: "Tool source id is not mapped to a connected MCP pool",
        }),
      };
    };
  } else {
    external = globalExternal ?? sessionExternal;
  }
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external,
  };
}

export function buildBuiltinOnlySessionMcpToolContext(): SessionMcpToolContext {
  const aggregated = buildAggregatedMcpCatalog();
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external: undefined,
  };
}

/**
 * `builtin-subagent` is only for top-level sessions; subagent runs must not recurse via tool list.
 */
export function omitBuiltinSubagentToolForSubagentSession(
  ctx: SessionMcpToolContext,
  sessionId: string,
): SessionMcpToolContext {
  if (!isSubagentSessionUrn(sessionId)) return ctx;
  const tools = ctx.aggregated.tools.filter(
    (t) => !(t.sourceId === "builtin" && t.originalName === "subagent"),
  );
  if (tools.length === ctx.aggregated.tools.length) return ctx;
  const aggregated: AggregateMcpCatalogResult = { tools };
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external: ctx.external,
  };
}

/**
 * Standalone finalizer: appends `builtin-message` when a messaging runtime is active.
 */
export function messageToolFinalizer(
  ctx: SessionMcpToolContext,
  _sessionId: string,
): SessionMcpToolContext {
  return augmentSessionMcpToolContextWithMessageTool(ctx, messageToolContextRef.current?.slice);
}

/**
 * Standalone finalizer: strips `builtin-subagent` for subagent session URNs.
 */
export function subagentToolStripFinalizer(
  ctx: SessionMcpToolContext,
  sessionId: string,
): SessionMcpToolContext {
  return omitBuiltinSubagentToolForSubagentSession(ctx, sessionId);
}

// ---------------------------------------------------------------------------
// Context-level tool filtering
// ---------------------------------------------------------------------------

/**
 * Default tool exclusions per context level. Uses namespaced names (e.g. `builtin-subagent`).
 * `none` is handled specially (excludes everything).
 */
const DEFAULT_EXCLUSIONS_BY_LEVEL: Record<ContextLevel, ReadonlySet<string>> = {
  none: new Set(), // handled specially — all tools excluded
  minimal: new Set([
    "builtin-workflow",
    "builtin-subagent",
    "builtin-session-list",
    "builtin-session-history",
    "builtin-session-spawn",
  ]),
  light: new Set(),
  full: new Set(),
};

/**
 * Filter tools based on the resolved context level and optional config overrides.
 *
 * Flow:
 * 1. `none` → exclude everything (config `allow` can re-add specific tools)
 * 2. Start with default exclusions for the level
 * 3. Add `contextLevelTools[level].exclude` from config
 * 4. Remove `contextLevelTools[level].allow` from config
 * 5. Filter the tool list
 */
export function filterToolsByContextLevel(
  tools: readonly AggregatedTool[],
  level: ContextLevel,
  config?: ShoggothConfig,
): readonly AggregatedTool[] {
  const override: ContextLevelToolOverride | undefined = config?.contextLevelTools?.[level];

  if (level === "none") {
    // Exclude everything by default; config `allow` can re-add specific tools
    const allowed = new Set(override?.allow ?? []);
    if (allowed.size === 0) return [];
    return tools.filter((t) => allowed.has(t.namespacedName));
  }

  const excluded = new Set(DEFAULT_EXCLUSIONS_BY_LEVEL[level]);

  // Apply config exclusions (additive)
  if (override?.exclude) {
    for (const name of override.exclude) excluded.add(name);
  }

  // Apply config allows (subtractive from exclusions)
  if (override?.allow) {
    for (const name of override.allow) excluded.delete(name);
  }

  if (excluded.size === 0) return tools;
  return tools.filter((t) => !excluded.has(t.namespacedName));
}

/**
 * Apply context-level tool filtering to a {@link SessionMcpToolContext}.
 * Returns the context unchanged when no tools are removed.
 */
function applyContextLevelToolFilter(
  ctx: SessionMcpToolContext,
  level: ContextLevel,
  config?: ShoggothConfig,
): SessionMcpToolContext {
  const filtered = filterToolsByContextLevel(ctx.aggregated.tools, level, config);
  if (filtered.length === ctx.aggregated.tools.length) return ctx;
  const aggregated: AggregateMcpCatalogResult = { tools: filtered };
  return {
    aggregated,
    toolsOpenAi: openAiToolsFromCatalog(aggregated),
    toolsLoop: mcpToolsForToolLoop(aggregated),
    external: ctx.external,
  };
}

/**
 * Creates a context finalizer that filters tools based on the resolved context level.
 * The returned finalizer resolves the context level from the session URN and config.
 */
export function createContextLevelToolFinalizer(
  config: ShoggothConfig,
): (ctx: SessionMcpToolContext, sessionId: string) => SessionMcpToolContext {
  return (ctx, sessionId) => {
    const parsed = parseAgentSessionUrn(sessionId);
    const agentId = parsed?.agentId ?? "";
    const isSubagent = isSubagentSessionUrn(sessionId);
    const level = resolveContextLevel(config, agentId, undefined, isSubagent);
    return applyContextLevelToolFilter(ctx, level, config);
  };
}
