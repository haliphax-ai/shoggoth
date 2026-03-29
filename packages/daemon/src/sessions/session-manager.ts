import { randomUUID } from "node:crypto";
import {
  mintAgentCredentialRaw,
  SHOGGOTH_AGENT_TOKEN_ENV,
  type AgentTokenStore,
} from "@shoggoth/authn";
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
  /** Test hook */
  readonly mintToken?: () => string;
}

export interface SpawnSessionInput {
  readonly workspacePath: string;
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

  return {
    spawn(input) {
      try {
        ensureAgentWorkspaceLayout(input.workspacePath);
      } catch (e) {
        throw new SessionManagerError(
          "ERR_WORKSPACE_LAYOUT",
          `could not prepare workspace ${input.workspacePath}: ${String(e)}`,
        );
      }
      const id = randomUUID();
      const agentToken = mintToken();
      const run = options.db.transaction(() => {
        options.sessions.create({
          id,
          workspacePath: input.workspacePath,
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
