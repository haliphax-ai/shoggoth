import type { McpToolDescriptor } from "./mcp-tool";

export interface McpSourceCatalog {
  readonly sourceId: string;
  readonly tools: readonly McpToolDescriptor[];
}

export interface AggregatedTool extends McpToolDescriptor {
  /** Namespaced name exposed to the model / router, e.g. `builtin-read`. */
  readonly namespacedName: string;
  readonly sourceId: string;
  readonly originalName: string;
}

export interface AggregateMcpCatalogResult {
  readonly tools: readonly AggregatedTool[];
  /**
   * `namespacedName` → tool index for O(1) routing lookups. Always populated —
   * build results with {@link createAggregateMcpCatalogResult} (or
   * {@link aggregateMcpCatalogs}) so the index stays in sync with `tools`.
   */
  readonly toolIndex: ReadonlyMap<string, AggregatedTool>;
}

function assertValidSourceId(sourceId: string): void {
  if (!sourceId || sourceId.includes(".")) {
    throw new Error(`invalid MCP source id (no dots): ${JSON.stringify(sourceId)}`);
  }
}

function namespaced(sourceId: string, toolName: string): string {
  return `${sourceId}-${toolName}`;
}

/** Build the `namespacedName` → tool lookup index for a tool list. */
function buildToolIndex(tools: readonly AggregatedTool[]): ReadonlyMap<string, AggregatedTool> {
  const index = new Map<string, AggregatedTool>();
  for (const tool of tools) {
    index.set(tool.namespacedName, tool);
  }
  return index;
}

/**
 * Build an {@link AggregateMcpCatalogResult} from a tool list, populating the
 * `toolIndex` used for O(1) routing lookups. Prefer this over hand-assembling
 * `{ tools }` so every result carries a consistent index.
 */
export function createAggregateMcpCatalogResult(
  tools: readonly AggregatedTool[],
): AggregateMcpCatalogResult {
  return { tools, toolIndex: buildToolIndex(tools) };
}

/**
 * Merge multiple MCP-style catalogs into one list with stable `source-tool` names.
 * Collisions throw so routing stays unambiguous.
 */
export function aggregateMcpCatalogs(
  sources: readonly McpSourceCatalog[],
): AggregateMcpCatalogResult {
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

  return createAggregateMcpCatalogResult(out);
}

/**
 * Resolve an aggregated name back to a backend invocation target.
 * O(1) through the prebuilt `toolIndex` that every result carries.
 */
export function routeMcpToolInvocation(
  aggregated: AggregateMcpCatalogResult,
  namespacedName: string,
): { tool: AggregatedTool } | { error: string } {
  const hit = aggregated.toolIndex.get(namespacedName);
  if (!hit) {
    return { error: `unknown MCP tool: ${namespacedName}` };
  }
  return { tool: hit };
}
