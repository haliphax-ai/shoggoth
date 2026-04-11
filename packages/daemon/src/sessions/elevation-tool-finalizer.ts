// ---------------------------------------------------------------------------
// Elevation tool finalizer — conditionally injects builtin-elevate
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";
import type { AggregateMcpCatalogResult, AggregatedTool } from "@shoggoth/mcp-integration";
import { createElevationStore } from "../elevation/elevation-store";
import {
  openAiToolsFromCatalog,
  type SessionMcpToolContext,
} from "./session-mcp-tool-context";
import { mcpToolsForToolLoop } from "../mcp/tool-loop-mcp";
import type { SessionMcpContextFinalizer } from "./session-mcp-runtime";

const ELEVATE_TOOL_DESCRIPTOR: AggregatedTool = {
  namespacedName: "builtin-elevate",
  sourceId: "builtin",
  originalName: "elevate",
  name: "elevate",
  description:
    "Execute a command in the daemon process with elevated privileges. Requires an active elevation grant from the operator. Use this to inspect daemon state, query the state DB, read logs, or run diagnostic commands.",
  inputSchema: {
    type: "object",
    properties: {
      argv: {
        type: "array",
        items: { type: "string" },
        description: "Command and arguments to execute in the daemon process.",
      },
      workdir: {
        type: "string",
        description: "Working directory (daemon filesystem). Optional.",
      },
      timeout: {
        type: "number",
        description: "Max milliseconds before the command is killed. Default 30000, max 120000.",
      },
    },
    required: ["argv"],
  },
};

export function createElevationToolFinalizer(
  db: Database.Database,
): SessionMcpContextFinalizer {
  return (ctx: SessionMcpToolContext, sessionId: string): SessionMcpToolContext => {
    let active: boolean;
    try {
      const store = createElevationStore(db);
      active = store.isActive(sessionId);
    } catch {
      // DB may be closed (e.g. during test teardown) — treat as inactive.
      return ctx;
    }
    if (!active) {
      // Remove builtin-elevate if somehow present
      const tools = ctx.aggregated.tools.filter((t) => t.namespacedName !== "builtin-elevate");
      if (tools.length === ctx.aggregated.tools.length) return ctx;
      const aggregated: AggregateMcpCatalogResult = { tools };
      return {
        aggregated,
        toolsOpenAi: openAiToolsFromCatalog(aggregated),
        toolsLoop: mcpToolsForToolLoop(aggregated),
        external: ctx.external,
        fullAggregated: ctx.fullAggregated,
      };
    }

    // Elevation is active — inject the tool if not already present
    if (ctx.aggregated.tools.some((t) => t.namespacedName === "builtin-elevate")) return ctx;
    const aggregated: AggregateMcpCatalogResult = {
      tools: [...ctx.aggregated.tools, ELEVATE_TOOL_DESCRIPTOR],
    };
    // Also add to fullAggregated so the executor can route to it
    const fullAggregated: AggregateMcpCatalogResult | undefined = ctx.fullAggregated
      ? { tools: [...ctx.fullAggregated.tools, ELEVATE_TOOL_DESCRIPTOR] }
      : undefined;
    return {
      aggregated,
      toolsOpenAi: openAiToolsFromCatalog(aggregated),
      toolsLoop: mcpToolsForToolLoop(aggregated),
      external: ctx.external,
      fullAggregated,
    };
  };
}
