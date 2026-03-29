import type { OpenAIToolFunctionDefinition } from "@shoggoth/models";
import type { AggregateMcpCatalogResult, McpSourceCatalog } from "@shoggoth/mcp-integration";
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

function openAiToolsFromCatalog(aggregated: AggregateMcpCatalogResult): OpenAIToolFunctionDefinition[] {
  return aggregated.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.namespacedName,
      description: t.description ?? `${t.sourceId}.${t.originalName}`,
      parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    },
  }));
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
