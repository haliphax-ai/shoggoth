// ---------------------------------------------------------------------------
// Tool Discovery — collapsible tool catalog with auto-trigger
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";
import type { AggregatedTool, AggregateMcpCatalogResult } from "@shoggoth/mcp-integration";
import {
  parseAgentSessionUrn,
  type ShoggothConfig,
} from "@shoggoth/shared";
import {
  openAiToolsFromCatalog,
  type SessionMcpToolContext,
} from "./session-mcp-tool-context";
import { mcpToolsForToolLoop } from "../mcp/tool-loop-mcp";
import type { SessionMcpContextFinalizer } from "./session-mcp-runtime";

// ---------------------------------------------------------------------------
// Mid-loop refresh signal
// ---------------------------------------------------------------------------

/** Set by `builtin-discover` handler; checked by the tool loop after each tool result. */
export const toolRefreshNeeded = new Map<string, boolean>();

// ---------------------------------------------------------------------------
// Tool catalog cache (session → tool descriptions from aggregated catalog)
// ---------------------------------------------------------------------------

/** Populated by the discovery finalizer; read by the discover handler for `list` results. */
export const toolCatalogCache = new Map<string, ReadonlyMap<string, string>>();

// ---------------------------------------------------------------------------
// Session tool state helpers (read/write session_tool_state table)
// ---------------------------------------------------------------------------

export function getSessionToolState(
  db: Database.Database,
  sessionId: string,
): Map<string, boolean> {
  const rows = db
    .prepare(`SELECT tool_id, enabled FROM session_tool_state WHERE session_id = ?`)
    .all(sessionId) as Array<{ tool_id: string; enabled: number }>;
  const map = new Map<string, boolean>();
  for (const r of rows) {
    map.set(r.tool_id, r.enabled === 1);
  }
  return map;
}

export function clearSessionToolState(
  db: Database.Database,
  sessionId: string,
): void {
  db.prepare(`DELETE FROM session_tool_state WHERE session_id = ?`).run(sessionId);
}

export function setSessionToolState(
  db: Database.Database,
  sessionId: string,
  toolId: string,
  enabled: boolean,
): void {
  db.prepare(
    `INSERT INTO session_tool_state (session_id, tool_id, enabled, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(session_id, tool_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
  ).run(sessionId, toolId, enabled ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

export interface ResolvedToolDiscoveryConfig {
  readonly enabled: boolean;
  readonly alwaysOn: Set<string>;
  readonly triggers: ReadonlyArray<{ match: string; tools: string[] }>;
}

export function resolveToolDiscoveryConfig(
  config: ShoggothConfig,
  sessionId: string,
): ResolvedToolDiscoveryConfig {
  const global = config.toolDiscovery;
  const parsed = parseAgentSessionUrn(sessionId);
  const agentId = parsed?.agentId ?? "";
  const agentEntry = agentId ? config.agents?.list?.[agentId] : undefined;
  const perAgent = agentEntry?.toolDiscovery;

  // enabled: per-agent wins when set, else global, else false
  const enabled = perAgent?.enabled ?? global?.enabled ?? false;

  // alwaysOn: global ∪ per-agent ∪ implicit builtin-discover
  const alwaysOn = new Set<string>(global?.alwaysOn ?? []);
  if (perAgent?.alwaysOn) {
    for (const id of perAgent.alwaysOn) alwaysOn.add(id);
  }
  alwaysOn.add("builtin-discover");

  // triggers: global ++ per-agent
  const triggers: Array<{ match: string; tools: string[] }> = [
    ...(global?.triggers ?? []),
    ...(perAgent?.triggers ?? []),
  ];

  return { enabled, alwaysOn, triggers };
}

// ---------------------------------------------------------------------------
// Discovery finalizer
// ---------------------------------------------------------------------------

const DISCOVER_TOOL_BASE_DESCRIPTION =
  "Manage which tools are active. Call with enable/disable arrays of tool IDs, reset: true to restore defaults, or list: true to see the full catalog.";

const DISCOVER_TOOL_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    enable: {
      type: "array",
      items: { type: "string" },
      description: "Tool IDs to enable for this session.",
    },
    disable: {
      type: "array",
      items: { type: "string" },
      description: "Tool IDs to disable (collapse) for this session.",
    },
    reset: {
      type: "boolean",
      description: "When true, reset all tool state to defaults (clear session state, keep alwaysOn tools).",
    },
    list: {
      type: "boolean",
      description: "When true, list all available tools with their current state.",
    },
  },
};

function buildDiscoverToolDescriptor(
  collapsedTools: readonly AggregatedTool[],
): AggregatedTool {
  let description = DISCOVER_TOOL_BASE_DESCRIPTION;
  if (collapsedTools.length > 0) {
    const catalog = collapsedTools
      .map((t) => `- ${t.namespacedName}: ${t.description ?? t.originalName}`)
      .join("\n");
    description += `\nCollapsed tools (call with enable to activate):\n${catalog}\nCall with {enable: ["<tool-id>"]} to add tools to your active set.`;
  }
  return {
    namespacedName: "builtin-discover",
    sourceId: "builtin",
    originalName: "discover",
    name: "discover",
    description,
    inputSchema: DISCOVER_TOOL_INPUT_SCHEMA,
  };
}

export function createToolDiscoveryFinalizer(
  config: ShoggothConfig,
  db: Database.Database,
): SessionMcpContextFinalizer {
  return (ctx: SessionMcpToolContext, sessionId: string): SessionMcpToolContext => {
    const resolved = resolveToolDiscoveryConfig(config, sessionId);
    if (!resolved.enabled) return ctx;

    // Cache tool descriptions from the full catalog for the discover handler's `list` action.
    const descMap = new Map<string, string>();
    for (const tool of ctx.aggregated.tools) {
      descMap.set(tool.namespacedName, tool.description ?? tool.originalName);
    }
    toolCatalogCache.set(sessionId, descMap);

    const toolState = getSessionToolState(db, sessionId);

    const enabledTools: AggregatedTool[] = [];
    const collapsedTools: AggregatedTool[] = [];

    for (const tool of ctx.aggregated.tools) {
      const id = tool.namespacedName;
      if (resolved.alwaysOn.has(id)) {
        enabledTools.push(tool);
      } else if (toolState.get(id) === true) {
        enabledTools.push(tool);
      } else {
        collapsedTools.push(tool);
      }
    }

    // Build the dynamic discover tool descriptor
    const discoverTool = buildDiscoverToolDescriptor(collapsedTools);

    // Add discover tool to the enabled set (avoid duplicate)
    const hasDiscover = enabledTools.some((t) => t.namespacedName === "builtin-discover");
    const advertisedTools = hasDiscover ? enabledTools : [...enabledTools, discoverTool];

    const advertisedAggregated: AggregateMcpCatalogResult = { tools: advertisedTools };

    return {
      // aggregated contains only the advertised (enabled) tools — what the model sees
      aggregated: advertisedAggregated,
      toolsOpenAi: openAiToolsFromCatalog(advertisedAggregated),
      toolsLoop: mcpToolsForToolLoop(advertisedAggregated),
      external: ctx.external,
      // fullAggregated retains ALL tools so the executor can route to any tool once enabled mid-loop
      fullAggregated: ctx.aggregated,
    };
  };
}

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

function matchesTrigger(pattern: string, content: string): boolean {
  // If wrapped in /…/, treat as regex
  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
    try {
      const re = new RegExp(pattern.slice(1, -1), "i");
      return re.test(content);
    } catch {
      // Invalid regex — fall through to substring match
    }
  }
  // Case-insensitive substring
  return content.toLowerCase().includes(pattern.toLowerCase());
}

export function evaluateTriggers(
  config: ShoggothConfig,
  sessionId: string,
  userContent: string,
  db: Database.Database,
): void {
  const resolved = resolveToolDiscoveryConfig(config, sessionId);
  if (!resolved.enabled || resolved.triggers.length === 0) return;

  const matched = new Set<string>();
  for (const trigger of resolved.triggers) {
    if (matchesTrigger(trigger.match, userContent)) {
      for (const toolId of trigger.tools) {
        matched.add(toolId);
      }
    }
  }

  if (matched.size === 0) return;

  for (const toolId of matched) {
    setSessionToolState(db, sessionId, toolId, true);
  }
}