import type { OpenAIToolFunctionDefinition } from "@shoggoth/models";
import type {
  AggregateMcpCatalogResult,
  AggregatedTool,
  McpSourceCatalog,
  MessageToolPlatformSlice,
} from "@shoggoth/mcp-integration";
import { buildMessageToolDescriptor } from "@shoggoth/mcp-integration";
import { isSubagentSessionUrn } from "@shoggoth/shared";
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
      description: t.description ?? `${t.sourceId}.${t.originalName}`,
      parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    },
  }));
}

/**
 * Appends `builtin.message` when a messaging runtime registers a capability slice (e.g. Discord).
 */
export function augmentSessionMcpToolContextWithMessageTool(
  base: SessionMcpToolContext,
  slice: MessageToolPlatformSlice | undefined,
): SessionMcpToolContext {
  const desc = buildMessageToolDescriptor(slice);
  if (!desc) return base;
  const extra: AggregatedTool = {
    ...desc,
    namespacedName: "builtin.message",
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
 * Merges global + per-session MCP tool catalogs (global sources first). Duplicate `source.tool`
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
 * `builtin.subagent` is only for top-level sessions; subagent runs must not recurse via tool list.
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
