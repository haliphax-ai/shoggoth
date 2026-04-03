import {
  mcpFetchToolsList,
  mcpInvokeTool,
  mcpToolsToSourceCatalog,
  openMcpStdioClient,
  openMcpStreamableHttpClient,
  openMcpTcpClient,
  type McpJsonRpcSession,
  type McpSourceCatalog,
  type McpStreamableHttpServerMessage,
  type McpStreamableHttpSession,
} from "@shoggoth/mcp-integration";
import { getProcessManager } from "../process-manager-singleton";
import type { ShoggothMcpConfig, ShoggothMcpServerEntry } from "@shoggoth/shared";
import type { ExternalMcpInvoke } from "./tool-loop-mcp";

type EffectiveMcpPoolScope = "global" | "per_session";

/** Resolve `entry.poolScope ?? "inherit"` then map `inherit` → top-level `mcp.poolScope`. */
function effectiveMcpPoolScope(
  entry: ShoggothMcpServerEntry,
  topLevelPoolScope: ShoggothMcpConfig["poolScope"],
): EffectiveMcpPoolScope {
  const p = entry.poolScope ?? "inherit";
  if (p === "inherit") return topLevelPoolScope;
  return p;
}

/** Split configured servers by effective pool scope (global vs per Shoggoth session). */
export function partitionMcpServersByEffectiveScope(
  servers: readonly ShoggothMcpServerEntry[],
  topLevelPoolScope: ShoggothMcpConfig["poolScope"],
): { globalServers: ShoggothMcpServerEntry[]; perSessionServers: ShoggothMcpServerEntry[] } {
  const globalServers: ShoggothMcpServerEntry[] = [];
  const perSessionServers: ShoggothMcpServerEntry[] = [];
  for (const s of servers) {
    if (effectiveMcpPoolScope(s, topLevelPoolScope) === "global") {
      globalServers.push(s);
    } else {
      perSessionServers.push(s);
    }
  }
  return { globalServers, perSessionServers };
}

export type McpServerPool = {
  readonly externalSources: readonly McpSourceCatalog[];
  /**
   * Streamable HTTP only: sends MCP `notifications/cancelled` for `requestId` on the session for `sourceId`.
   * Returns true if that server is an HTTP transport pool member.
   */
  readonly cancelMcpRequest?: (sourceId: string, requestId: number) => boolean;
  readonly close: () => Promise<void>;
};

export type ConnectShoggothMcpPoolOptions = {
  readonly onMcpServerMessage?: (input: {
    sourceId: string;
    msg: McpStreamableHttpServerMessage;
  }) => void;
};

/**
 * Connects configured MCP servers (stdio, TCP, or streamable HTTP), runs `initialize` + `tools/list`,
 * and returns catalogs plus a {@link ExternalMcpInvoke} that routes `tools/call` to the right session.
 */
export async function connectShoggothMcpServers(
  servers: readonly ShoggothMcpServerEntry[],
  options?: ConnectShoggothMcpPoolOptions,
): Promise<{ pool: McpServerPool; external: ExternalMcpInvoke }> {
  const externalSources: McpSourceCatalog[] = [];
  const sessions = new Map<string, McpJsonRpcSession>();
  const streamableBySourceId = new Map<string, McpStreamableHttpSession>();
  const onPoolMessage = options?.onMcpServerMessage;

  for (const s of servers) {
    const session =
      s.transport === "stdio"
        ? await openMcpStdioClient({
            command: s.command,
            args: s.args,
            cwd: s.cwd,
            env: s.env,
            processManager: getProcessManager(),
          })
        : s.transport === "tcp"
          ? await openMcpTcpClient({ host: s.host, port: s.port })
          : await openMcpStreamableHttpClient({
              url: s.url,
              headers: s.headers,
              onServerMessage: onPoolMessage
                ? (msg) => onPoolMessage({ sourceId: s.id, msg })
                : undefined,
            });
    if (s.transport === "http") {
      streamableBySourceId.set(s.id, session as McpStreamableHttpSession);
    }
    const tools = await mcpFetchToolsList(session);
    externalSources.push(mcpToolsToSourceCatalog(s.id, tools));
    sessions.set(s.id, session);
  }

  const external: ExternalMcpInvoke = async ({ sourceId, originalName, argsJson }) => {
    const session = sessions.get(sourceId);
    if (!session) {
      return {
        resultJson: JSON.stringify({
          error: "mcp_source_not_connected",
          sourceId,
          detail: "No active MCP session for this source id",
        }),
      };
    }
    try {
      const args = JSON.parse(argsJson) as Record<string, unknown>;
      const result = await mcpInvokeTool(session, originalName, args);
      return { resultJson: JSON.stringify(result) };
    } catch (e) {
      return {
        resultJson: JSON.stringify({ error: "mcp_tools_call_failed", message: String(e) }),
      };
    }
  };

  const pool: McpServerPool = {
    externalSources,
    cancelMcpRequest: (sourceId, requestId) => {
      const st = streamableBySourceId.get(sourceId);
      if (!st) return false;
      st.cancelRequest(requestId);
      return true;
    },
    close: async () => {
      await Promise.all([...sessions.values()].map((x) => x.close().catch(() => {})));
    },
  };

  return { pool, external };
}
