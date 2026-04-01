import type { SessionModelTurnDelivery } from "../messaging/session-model-turn-delivery";
import type { SessionAgentTurnResult } from "../sessions/session-agent-turn";
import type { SystemContext } from "@shoggoth/shared";

/** Why a persistent subagent session is being torn down (for optional thread status posts). */
export type PersistentSubagentSessionEndReason = "ttl_expired" | "killed";

/**
 * Filled from `index.ts` after a platform starts. Control-plane subagent ops consult this ref.
 */
export type SubagentRuntimeExtension = {
  readonly runSessionModelTurn: (input: {
    readonly sessionId: string;
    readonly userContent: string;
    readonly userMetadata?: Record<string, unknown>;
    readonly systemContext?: SystemContext;
    readonly delivery: SessionModelTurnDelivery;
  }) => Promise<SessionAgentTurnResult>;
  readonly subscribeSubagentSession: (sessionId: string) => () => void;
  /** Register a platform thread ↔ session binding. Returns an idempotent unregister function. */
  readonly registerPlatformThreadBinding: (
    threadChannelId: string,
    sessionId: string,
  ) => () => void;
  /**
   * Best-effort: post a short status line in the platform thread (if bound) before bindings are cleared.
   * Implementations should read session/thread ids synchronously; network I/O may continue async.
   */
  readonly announcePersistentSubagentSessionEnded?: (input: {
    readonly sessionId: string;
    readonly reason: PersistentSubagentSessionEndReason;
  }) => void;
};

export const subagentRuntimeExtensionRef: { current: SubagentRuntimeExtension | undefined } = {
  current: undefined,
};

export function setSubagentRuntimeExtension(ext: SubagentRuntimeExtension | undefined): void {
  subagentRuntimeExtensionRef.current = ext;
}
