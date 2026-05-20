import type { SessionMcpToolContext } from "./session-mcp-tool-context";
import { openAiToolsFromCatalog } from "./session-mcp-tool-context";
import { mcpToolsForToolLoop } from "../mcp/tool-loop-mcp";
import { serviceToolRegistryRef, serviceRegistryRef } from "./service-tool-registry-ref";
import type { ServiceToolRegistry } from "../service-tool-registry";
import type { ServiceRegistry } from "../service-registry";
import type { AggregateMcpCatalogResult, AggregatedTool } from "@shoggoth/mcp-integration";

/**
 * Get approved service tools - filters tools from the registry to only include
 * those from services where approvalStatus === 'approved'.
 *
 * @param serviceRegistry - The service registry to check approval status
 * @param toolRegistry - The tool registry to get tools from
 * @returns Array of tool descriptors from approved services
 */
export function getApprovedServiceTools(
  serviceRegistry: ServiceRegistry,
  toolRegistry: ServiceToolRegistry,
): Array<{ name: string; description: string; parameters: Record<string, unknown> }> {
  const allTools = toolRegistry.listTools();

  const approvedTools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }> = [];

  for (const tool of allTools) {
    const entry = serviceRegistry.get(tool.serviceId);
    if (entry?.approvalStatus !== "approved") {
      continue;
    }

    // Get the parameters schema from the registered tool
    const registered = toolRegistry.get(tool.qualifiedName);
    if (!registered) continue;

    let parameters: Record<string, unknown> = {};
    if (registered.kind === "direct") {
      parameters = (registered.tool.parameters as Record<string, unknown>) ?? {};
    } else {
      parameters = (registered.decl.parameters as Record<string, unknown>) ?? {};
    }

    approvedTools.push({
      name: tool.qualifiedName,
      description: tool.description,
      parameters,
    });
  }

  return approvedTools;
}

/**
 * Context finalizer that injects service-registered tools (from plugin services)
 * into the session's tool catalog so agents can see and invoke them.
 *
 * Only includes tools from services with approvalStatus === 'approved'.
 */
export function createServiceToolFinalizer(): (
  ctx: SessionMcpToolContext,
  sessionId: string,
) => SessionMcpToolContext {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (ctx, _sessionId) => {
    const toolRegistry = serviceToolRegistryRef.current;
    const serviceRegistry = serviceRegistryRef.current;
    if (!toolRegistry || !serviceRegistry) return ctx;

    const approvedTools = getApprovedServiceTools(serviceRegistry, toolRegistry);
    if (approvedTools.length === 0) return ctx;

    // Build AggregatedTool entries for each approved service tool
    const extraTools: AggregatedTool[] = [];
    for (const st of approvedTools) {
      // Skip if already present (avoid duplicates)
      if (ctx.aggregated.tools.some((t) => t.namespacedName === st.name)) continue;

      extraTools.push({
        namespacedName: st.name,
        sourceId: "builtin",
        originalName: st.name,
        name: st.name,
        description: st.description,
        inputSchema: st.parameters ?? { type: "object", properties: {} },
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
