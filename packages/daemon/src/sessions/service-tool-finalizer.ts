import type { SessionMcpToolContext } from "./session-mcp-tool-context";
import { openAiToolsFromCatalog } from "./session-mcp-tool-context";
import { mcpToolsForToolLoop } from "../mcp/tool-loop-mcp";
import { serviceToolRegistryRef } from "./service-tool-registry-ref";
import type { AggregateMcpCatalogResult, AggregatedTool } from "@shoggoth/mcp-integration";

/**
 * Context finalizer that injects service-registered tools (from plugin services)
 * into the session's tool catalog so agents can see and invoke them.
 */
export function createServiceToolFinalizer(): (
  ctx: SessionMcpToolContext,
  sessionId: string,
) => SessionMcpToolContext {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (ctx, _sessionId) => {
    const registry = serviceToolRegistryRef.current;
    if (!registry) return ctx;

    const serviceTools = registry.listTools();
    if (serviceTools.length === 0) return ctx;

    // Build AggregatedTool entries for each service tool
    const extraTools: AggregatedTool[] = [];
    for (const st of serviceTools) {
      // Skip if already present (avoid duplicates)
      if (ctx.aggregated.tools.some((t) => t.namespacedName === st.qualifiedName)) continue;

      const registered = registry.getToolDeclaration(st.qualifiedName);
      if (!registered) continue;

      const inputSchema = registered.tool.parameters as Record<string, unknown>;

      extraTools.push({
        namespacedName: st.qualifiedName,
        sourceId: "builtin",
        originalName: st.qualifiedName,
        name: st.qualifiedName,
        description: st.description,
        inputSchema: inputSchema ?? { type: "object", properties: {} },
      });
    }

    if (extraTools.length === 0) return ctx;

    const aggregated: AggregateMcpCatalogResult = {
      tools: [...ctx.aggregated.tools, ...extraTools],
    };

    return {
      aggregated,
      toolsOpenAi: openAiToolsFromCatalog(aggregated),
      toolsLoop: mcpToolsForToolLoop(aggregated),
      external: ctx.external,
    };
  };
}
