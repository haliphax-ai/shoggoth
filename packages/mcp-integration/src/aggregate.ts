import type { McpToolDescriptor } from "./mcp-tool";

export interface McpSourceCatalog {
  readonly sourceId: string;
  readonly tools: readonly McpToolDescriptor[];
}

export interface AggregatedTool extends McpToolDescriptor {
  /** Namespaced name exposed to the model / router, e.g. `builtin.read`. */
  readonly namespacedName: string;
  readonly sourceId: string;
  readonly originalName: string;
}

export interface AggregateMcpCatalogResult {
  readonly tools: readonly AggregatedTool[];
}

function assertValidSourceId(sourceId: string): void {
  if (!sourceId || sourceId.includes(".")) {
    throw new Error(`invalid MCP source id (no dots): ${JSON.stringify(sourceId)}`);
  }
}

function namespaced(sourceId: string, toolName: string): string {
  return `${sourceId}.${toolName}`;
}

/**
 * Merge multiple MCP-style catalogs into one list with stable `source.tool` names.
 * Collisions throw so routing stays unambiguous.
 */
export function aggregateMcpCatalogs(sources: readonly McpSourceCatalog[]): AggregateMcpCatalogResult {
  const out: AggregatedTool[] = [];
  const seen = new Map<string, string>();

  for (const src of sources) {
    assertValidSourceId(src.sourceId);
    for (const t of src.tools) {
      const ns = namespaced(src.sourceId, t.name);
      const prev = seen.get(ns);
      if (prev !== undefined) {
        throw new Error(`duplicate aggregated MCP tool name "${ns}" (also from ${prev})`);
      }
      seen.set(ns, src.sourceId);
      out.push({
        ...t,
        namespacedName: ns,
        sourceId: src.sourceId,
        originalName: t.name,
      });
    }
  }

  return { tools: out };
}

export interface ParsedNamespacedTool {
  readonly sourceId: string;
  readonly toolName: string;
}

/** Split `source.tool` on the first dot; tool name may contain further dots. */
export function parseNamespacedMcpTool(namespacedName: string): ParsedNamespacedTool | null {
  const i = namespacedName.indexOf(".");
  if (i <= 0 || i === namespacedName.length - 1) {
    return null;
  }
  return {
    sourceId: namespacedName.slice(0, i),
    toolName: namespacedName.slice(i + 1),
  };
}

/** Resolve an aggregated name back to a backend invocation target. */
export function routeMcpToolInvocation(
  aggregated: AggregateMcpCatalogResult,
  namespacedName: string,
): { tool: AggregatedTool } | { error: string } {
  const hit = aggregated.tools.find((t) => t.namespacedName === namespacedName);
  if (!hit) {
    return { error: `unknown MCP tool: ${namespacedName}` };
  }
  return { tool: hit };
}
