import {
  aggregateMcpCatalogs,
  builtinShoggothToolsCatalog,
  routeMcpToolInvocation,
  type AggregateMcpCatalogResult,
  type McpSourceCatalog,
} from "@shoggoth/mcp-integration";
import type { ChatContentPart } from "@shoggoth/models";
import type { ToolExecutor } from "../sessions/tool-loop";
import { validateToolArgs } from "../sessions/validate-tool-args";
import { getLogger } from "../logging";

const log = getLogger("tool-loop-mcp");

/**
 * Closed-session signature produced when a pooled MCP session was closed out from
 * under an in-flight turn (e.g. the 30-minute per-instance idle eviction closing the
 * pool while a turn captured `external` at turn start).
 *
 * Origin: `mcp-jsonrpc-transport.ts` `request()` / `mcp-streamable-http-transport.ts`
 * `postOnce()` throw `Error: MCP session is closed`; the pool's `external` invoke
 * (`mcp-server-pool.ts`) catches it and wraps it as
 * `{ error: "mcp_tools_call_failed", message: String(e) }`, so the message reads
 * `Error: MCP session is closed`. The pattern also matches `MCP session closed`
 * (the wording used when `close()` fails still-pending requests).
 */
const LAPSED_MCP_SESSION_RE = /MCP session (?:is )?closed/i;

/**
 * Returns true when a tool call result is the closed-session signature described on
 * {@link LAPSED_MCP_SESSION_RE} — i.e. the MCP pool lapsed mid-turn and the call is
 * safe to retry once against a freshly reconnected pool.
 */
export function isLapsedMcpSessionResult(resultJson: string): boolean {
  try {
    const body = JSON.parse(resultJson) as { error?: unknown; message?: unknown };
    return (
      body.error === "mcp_tools_call_failed" &&
      typeof body.message === "string" &&
      LAPSED_MCP_SESSION_RE.test(body.message)
    );
  } catch {
    return false;
  }
}

export type BuiltinToolDelegate = (input: {
  readonly originalName: string;
  readonly argsJson: string;
  readonly toolCallId: string;
}) => Promise<{ resultJson: string; contentParts?: ChatContentPart[] }>;

export type ExternalMcpInvoke = (input: {
  readonly sourceId: string;
  readonly originalName: string;
  readonly argsJson: string;
  readonly toolCallId: string;
}) => Promise<{ resultJson: string }>;

/**
 * Validates `argsJson` against a routed tool's `inputSchema` (issue #435:
 * every dispatch path — session tool loop, workflow tool tasks, subagent
 * runtime — must fail loudly on unknown or missing arguments instead of
 * silently dropping them).
 *
 * Returns a structured `invalid_arguments` error body when validation fails,
 * or `undefined` when the args are acceptable. Tools without a schema cannot
 * be validated and pass through.
 */
export function validateRoutedToolArgs(
  toolName: string,
  inputSchema: unknown,
  argsJson: string,
): string | undefined {
  if (!inputSchema || typeof inputSchema !== "object") return undefined;
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return JSON.stringify({
      error: "invalid_arguments",
      tool: toolName,
      message: "Tool call arguments were not valid JSON.",
    });
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return JSON.stringify({
      error: "invalid_arguments",
      tool: toolName,
      message: "arguments must be a JSON object",
    });
  }
  const errors = validateToolArgs(
    args as Record<string, unknown>,
    inputSchema as Parameters<typeof validateToolArgs>[1],
  );
  if (errors.length === 0) return undefined;
  const detail = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
  return JSON.stringify({
    error: "invalid_arguments",
    tool: toolName,
    message: `Argument validation failed: ${detail}`,
  });
}

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
export function mcpToolsForToolLoop(
  aggregated: AggregateMcpCatalogResult,
): ReadonlyArray<{ name: string; inputSchema?: Record<string, unknown> }> {
  return aggregated.tools.map((t) => ({
    name: t.namespacedName,
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));
}

/**
 * Routes model tool calls to built-in execution or optional external MCP transport.
 * External tools without `external` return a structured error (transport not configured); see docs/mcp-transport.md.
 *
 * When `reconnectExternal` is provided and an external call fails with the
 * closed-session signature ({@link isLapsedMcpSessionResult}), the MCP context is
 * re-resolved (lazily reconnecting an idle-evicted pool) and the call is retried
 * exactly once against the refreshed transport. A second closed-session failure is
 * returned as-is — no retry loop.
 */
export function createMcpRoutingToolExecutor(options: {
  readonly aggregated: AggregateMcpCatalogResult;
  readonly builtin: BuiltinToolDelegate;
  readonly external?: ExternalMcpInvoke;
  /**
   * Mid-turn lapse recovery: re-resolves the session MCP context (which lazily
   * reconnects an idle-evicted pool) and returns the refreshed `external` invoke.
   * Only consulted when an external call fails with the closed-session signature.
   */
  readonly reconnectExternal?: () => Promise<ExternalMcpInvoke | undefined>;
}): ToolExecutor {
  const { aggregated, builtin, external, reconnectExternal } = options;
  return {
    async execute({ name, argsJson, toolCallId }) {
      const routed = routeMcpToolInvocation(aggregated, name);
      if ("error" in routed) {
        throw new Error(routed.error);
      }
      const { tool } = routed;
      // Universal argument validation (issue #435). The session tool loop
      // validates at Stage 2, but workflow tool tasks and the subagent
      // runtime dispatch through here directly — so every path checks.
      const validationError = validateRoutedToolArgs(name, tool.inputSchema, argsJson);
      if (validationError) {
        log.warn("tool call args validation failed (routing executor)", {
          tool: name,
          toolCallId,
        });
        return { resultJson: validationError };
      }
      if (tool.sourceId === "builtin") {
        return builtin({
          originalName: tool.originalName,
          argsJson,
          toolCallId,
        });
      }
      if (external) {
        const invokeInput = {
          sourceId: tool.sourceId,
          originalName: tool.originalName,
          argsJson,
          toolCallId,
        };
        const result = await external(invokeInput);
        if (!reconnectExternal || !isLapsedMcpSessionResult(result.resultJson)) {
          return result;
        }
        // The pool lapsed mid-turn (e.g. idle eviction closed the session the
        // turn captured at start). Re-resolve so `external` points at a freshly
        // reconnected pool, then retry once. A second closed-session failure
        // surfaces as-is.
        log.warn("mcp session lapsed mid-turn; reconnecting and retrying once", {
          sourceId: tool.sourceId,
          tool: tool.originalName,
          toolCallId,
        });
        let refreshed: ExternalMcpInvoke | undefined;
        try {
          refreshed = await reconnectExternal();
        } catch (e) {
          log.error("mcp session lapse reconnect failed", {
            sourceId: tool.sourceId,
            tool: tool.originalName,
            error: String(e),
          });
        }
        if (!refreshed) return result;
        return refreshed(invokeInput);
      }
      return {
        resultJson: JSON.stringify({
          error: "mcp_external_transport_unavailable",
          sourceId: tool.sourceId,
          tool: tool.originalName,
          detail: "No MCP client configured for this source; invocation is stubbed.",
        }),
      };
    },
  };
}
