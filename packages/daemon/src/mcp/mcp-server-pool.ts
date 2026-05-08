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
import { resolveVaultEnv } from "./vault-env-resolve.js";
import type { VaultService } from "../vault/vault-service.js";

type EffectiveMcpPoolScope = "global" | "per_agent" | "per_session";

/** Resolve `entry.poolScope ?? "inherit"` then map `inherit` → top-level `mcp.poolScope`. */
function effectiveMcpPoolScope(
  entry: ShoggothMcpServerEntry,
  topLevelPoolScope: ShoggothMcpConfig["poolScope"],
): EffectiveMcpPoolScope {
  const p = entry.poolScope ?? "inherit";
  if (p === "inherit") return topLevelPoolScope;
  return p;
}

/** Split configured servers by effective pool scope (global, per-agent, or per-session). */
export function partitionMcpServersByEffectiveScope(
  servers: readonly ShoggothMcpServerEntry[],
  topLevelPoolScope: ShoggothMcpConfig["poolScope"],
): {
  globalServers: ShoggothMcpServerEntry[];
  perAgentServers: ShoggothMcpServerEntry[];
  perSessionServers: ShoggothMcpServerEntry[];
} {
  const globalServers: ShoggothMcpServerEntry[] = [];
  const perAgentServers: ShoggothMcpServerEntry[] = [];
  const perSessionServers: ShoggothMcpServerEntry[] = [];
  for (const s of servers) {
    const scope = effectiveMcpPoolScope(s, topLevelPoolScope);
    if (scope === "global") {
      globalServers.push(s);
    } else if (scope === "per_agent") {
      perAgentServers.push(s);
    } else {
      perSessionServers.push(s);
    }
  }
  return { globalServers, perAgentServers, perSessionServers };
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

/** Agent identity and workspace context for scoped MCP server processes. */
export interface AgentMcpContext {
  /** POSIX UID for the agent (from session row or bootstrap). */
  readonly uid: number;
  /** POSIX GID for the agent (from session row or bootstrap). */
  readonly gid: number;
  /** Absolute path to the agent's workspace directory. */
  readonly workspacePath: string;
}

export type ConnectShoggothMcpPoolOptions = {
  readonly onMcpServerMessage?: (input: {
    sourceId: string;
    msg: McpStreamableHttpServerMessage;
  }) => void;
  /** When provided, stdio MCP servers are spawned under this agent's identity. */
  readonly agentContext?: AgentMcpContext;
  /** Vault service for resolving $vault: references in env vars. */
  readonly vault?: VaultService;
  /** Agent ID for vault scope resolution. Required if vault is provided. */
  readonly agentId?: string;
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

  const agentCtx = options?.agentContext;

  for (const s of servers) {
    let session: McpJsonRpcSession;

    if (s.transport === "stdio") {
      // Build env: agent workspace as HOME, then server config env on top
      let baseEnv = agentCtx ? { HOME: agentCtx.workspacePath, ...s.env } : s.env;
      // Resolve $vault: references in env vars if vault is available
      if (baseEnv && options?.vault && options?.agentId) {
        baseEnv = await resolveVaultEnv(baseEnv, options.vault, options.agentId);
      }
      const cwd = s.cwd ?? agentCtx?.workspacePath;
      session = await openMcpStdioClient({
        command: s.command,
        args: s.args,
        cwd,
        env: baseEnv,
        uid: agentCtx?.uid,
        gid: agentCtx?.gid,
        processManager: getProcessManager(),
      });
    } else if (s.transport === "tcp") {
      session = await openMcpTcpClient({ host: s.host, port: s.port });
    } else {
      const httpSession = await openMcpStreamableHttpClient({
        url: s.url,
        headers: s.headers,
        onServerMessage: onPoolMessage
          ? (msg) => onPoolMessage({ sourceId: s.id, msg })
          : undefined,
      });
      streamableBySourceId.set(s.id, httpSession);
      session = httpSession;
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
        resultJson: JSON.stringify({
          error: "mcp_tools_call_failed",
          message: String(e),
        }),
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
