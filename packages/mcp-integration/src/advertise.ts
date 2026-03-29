import type { AggregateMcpCatalogResult } from "./aggregate";
import type { JsonSchemaLike } from "./json-schema";

/**
 * Payload shape compatible with MCP `tools/list` notifications (explicit schemas).
 */
export interface McpToolsListPayload {
  readonly tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema: JsonSchemaLike;
  }>;
}

export function toMcpToolsListPayload(aggregated: AggregateMcpCatalogResult): McpToolsListPayload {
  return {
    tools: aggregated.tools.map((t) => ({
      name: t.namespacedName,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  };
}
