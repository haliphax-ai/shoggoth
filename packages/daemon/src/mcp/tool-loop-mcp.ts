import {
  aggregateMcpCatalogs,
  builtinShoggothToolsCatalog,
  routeMcpToolInvocation,
  type AggregateMcpCatalogResult,
  type McpSourceCatalog,
} from "@shoggoth/mcp-integration";
import type { ToolExecutor } from "../sessions/tool-loop";

export type BuiltinToolDelegate = (input: {
  readonly originalName: string;
  readonly argsJson: string;
  readonly toolCallId: string;
}) => Promise<{ resultJson: string }>;

export type ExternalMcpInvoke = (input: {
  readonly sourceId: string;
  readonly originalName: string;
  readonly argsJson: string;
  readonly toolCallId: string;
}) => Promise<{ resultJson: string }>;

/**
 * Single catalog for the session tool loop: built-in Shoggoth tools plus optional static
 * external descriptors (e.g. from config until live MCP `tools/list` is wired).
 */
export function buildAggregatedMcpCatalog(
  externalSources: readonly McpSourceCatalog[] = [],
): AggregateMcpCatalogResult {
  return aggregateMcpCatalogs([builtinShoggothToolsCatalog(), ...externalSources]);
}

/** `RunToolLoopOptions.tools` entries using MCP-style `source.tool` names. */
export function mcpToolsForToolLoop(aggregated: AggregateMcpCatalogResult): ReadonlyArray<{ name: string }> {
  return aggregated.tools.map((t) => ({ name: t.namespacedName }));
}

/**
 * Routes model tool calls to built-in execution or optional external MCP transport.
 * External tools without `external` return a structured error (transport not configured); see docs/mcp-transport.md.
 */
export function createMcpRoutingToolExecutor(options: {
  readonly aggregated: AggregateMcpCatalogResult;
  readonly builtin: BuiltinToolDelegate;
  readonly external?: ExternalMcpInvoke;
}): ToolExecutor {
  const { aggregated, builtin, external } = options;
  return {
    async execute({ name, argsJson, toolCallId }) {
      const routed = routeMcpToolInvocation(aggregated, name);
      if ("error" in routed) {
        throw new Error(routed.error);
      }
      const { tool } = routed;
      if (tool.sourceId === "builtin") {
        return builtin({ originalName: tool.originalName, argsJson, toolCallId });
      }
      if (external) {
        return external({
          sourceId: tool.sourceId,
          originalName: tool.originalName,
          argsJson,
          toolCallId,
        });
      }
      return {
        resultJson: JSON.stringify({
          error: "mcp_external_transport_unavailable",
          sourceId: tool.sourceId,
          tool: tool.originalName,
          detail:
            "No MCP client subprocess/SDK is configured for this source; invocation is stubbed. See docs/mcp-transport.md",
        }),
      };
    },
  };
}
