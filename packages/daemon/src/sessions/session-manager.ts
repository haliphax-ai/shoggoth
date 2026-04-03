import {
  mintAgentCredentialRaw,
  SHOGGOTH_AGENT_TOKEN_ENV,
  type AgentTokenStore,
} from "@shoggoth/authn";
import {
  mintAgentSessionUrn,
  mintSubagentSessionUrnFromParent,
  parseAgentSessionUrn,
  resolveAgentWorkspacePath,
  type ShoggothAgentsConfig,
} from "@shoggoth/shared";
import type Database from "better-sqlite3";
import { ensureAgentWorkspaceLayout } from "../workspaces/agent-workspace-layout";
import type { SessionStore } from "./session-store";

export type SpawnSessionResult = {
  sessionId: string;
  /** Raw token for agent runtime only; persist hash is in `agent_tokens`. */
  agentToken: string;
  /** Name of the env var callers should set (e.g. `SHOGGOTH_AGENT_TOKEN`). */
  agentTokenEnvName: typeof SHOGGOTH_AGENT_TOKEN_ENV;
};

export interface SessionManagerOptions {
  readonly db: Database.Database;
  readonly sessions: SessionStore;
  readonly agentTokens: AgentTokenStore;
  readonly workspacesRoot: string;
  /** Default agent id (workspace `{workspacesRoot}/{agentId}`) for top-level spawns. */
  readonly agentId?: string;
  /** Agents config for resolving platform from agent bindings when `spawn` omits `platform`. */
  readonly agentsConfig?: ShoggothAgentsConfig;
  /** Test hook */
  readonly mintToken?: () => string;
}

export interface SpawnSessionInput {
  /**
   * Top-level only: agent owning the workspace. Defaults to the manager's `agentId`.
   * Ignored when `parentSessionId` is set (workspace follows the parent URN's agent id).
   */
  readonly agentId?: string;
  readonly platform?: string;
  /** Resource type segment for the URN (e.g. "channel", "dm"). Defaults to "channel". */
  readonly resourceType?: string;
  /** When set, mints `agent:…:<parent-leaf-uuid>:<new uuid>` under the parent's agent + platform. */
  readonly parentSessionId?: string;
  readonly modelSelection?: unknown;
  readonly lightContext?: boolean;
}

export class SessionManagerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionManagerError";
  }
}

export interface SessionManager {
  spawn(input: SpawnSessionInput): SpawnSessionResult;
  /** Mint a new raw agent token for an existing non-terminated session (revokes prior hashes). */
  rotateAgentToken(sessionId: string): SpawnSessionResult;
  kill(sessionId: string): void;
  attachPromptStack(sessionId: string, stack: readonly string[]): void;
  setLightContext(sessionId: string, value: boolean): void;
}

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const mintToken = options.mintToken ?? mintAgentCredentialRaw;
  const defaultAgentId = options.agentId ?? "main";
  const agentsConfig = options.agentsConfig;

  /** Resolve platform from agent's platform bindings in agentsConfig. */
  function resolveAgentPlatform(agentId: string): string | undefined {
    const agent = agentsConfig?.list?.[agentId];
    if (!agent?.platforms) return undefined;
    const keys = Object.keys(agent.platforms);
    return keys.length > 0 ? keys[0] : undefined;
  }

  return {
    spawn(input) {
      let id: string;
      let dirAgentId: string;
      if (input.parentSessionId) {
        const p = parseAgentSessionUrn(input.parentSessionId);
        if (!p) {
          throw new SessionManagerError(
            "ERR_INVALID_PARENT_SESSION",
            `invalid parent session URN: ${input.parentSessionId}`,
          );
        }
        id = mintSubagentSessionUrnFromParent(input.parentSessionId);
        dirAgentId = p.agentId;
      } else {
        const aid = input.agentId?.trim() || defaultAgentId;
        const platform = input.platform ?? resolveAgentPlatform(aid);
        if (!platform) {
          throw new SessionManagerError(
            "ERR_NO_PLATFORM",
            `no session platform specified and no platform bindings configured for agent "${aid}" (add platforms under agents.list.${aid}.platforms)`,
          );
        }
        id = mintAgentSessionUrn(aid, platform, input.resourceType ?? "channel");
        dirAgentId = aid;
      }
      const wsPath = resolveAgentWorkspacePath(options.workspacesRoot, dirAgentId);
      try {
        ensureAgentWorkspaceLayout(wsPath);
      } catch (e) {
        throw new SessionManagerError(
          "ERR_WORKSPACE_LAYOUT",
          `could not prepare workspace ${wsPath}: ${String(e)}`,
        );
      }
      const agentToken = mintToken();
      const run = options.db.transaction(() => {
        options.sessions.create({
          id,
          workspacePath: wsPath,
          status: "active",
          modelSelection: input.modelSelection,
          lightContext: input.lightContext,
        });
        options.agentTokens.register(id, agentToken);
      });
      run();
      return {
        sessionId: id,
        agentToken,
        agentTokenEnvName: SHOGGOTH_AGENT_TOKEN_ENV,
      };
    },

    rotateAgentToken(sessionId) {
      const row = options.sessions.getById(sessionId);
      if (!row) {
        throw new SessionManagerError("ERR_SESSION_NOT_FOUND", `no session ${sessionId}`);
      }
      if (row.status === "terminated") {
        throw new SessionManagerError("ERR_SESSION_NOT_ACTIVE", `session ${sessionId} is not active`);
      }
      const agentToken = mintToken();
      options.agentTokens.register(sessionId, agentToken);
      return {
        sessionId,
        agentToken,
        agentTokenEnvName: SHOGGOTH_AGENT_TOKEN_ENV,
      };
    },

    kill(sessionId) {
      options.agentTokens.revoke(sessionId);
      options.sessions.update(sessionId, { status: "terminated" });
    },

    attachPromptStack(sessionId, stack) {
      options.sessions.update(sessionId, { promptStack: stack });
    },

    setLightContext(sessionId, value) {
      options.sessions.update(sessionId, { lightContext: value });
    },
  };
}
