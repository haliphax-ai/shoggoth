import type { DiscordMessagingRuntime } from "@shoggoth/messaging";
import type { SessionModelTurnDelivery } from "../messaging/session-model-turn-delivery";
import type { SessionAgentTurnResult } from "../sessions/session-agent-turn";

/** Why a bound subagent session is being torn down (for optional thread status posts). */
export type BoundSubagentSessionEndReason = "ttl_expired" | "killed";

/**
 * Filled from `index.ts` after Discord platform starts. Control-plane subagent ops consult this ref.
 */
export type SubagentRuntimeExtension = {
  readonly runSessionModelTurn: (input: {
    readonly sessionId: string;
    readonly userContent: string;
    readonly userMetadata?: Record<string, unknown>;
    readonly delivery: SessionModelTurnDelivery;
  }) => Promise<SessionAgentTurnResult>;
  readonly subscribeSubagentSession: (sessionId: string) => () => void;
  readonly registerDiscordThreadBinding: DiscordMessagingRuntime["registerDiscordThreadBinding"];
  /**
   * Best-effort: post a short status line in the bound Discord thread before bindings are cleared.
   * Implementations should read session/thread ids synchronously; network I/O may continue async.
   */
  readonly announceBoundSubagentSessionEnded?: (input: {
    readonly sessionId: string;
    readonly reason: BoundSubagentSessionEndReason;
  }) => void;
};

export const subagentRuntimeExtensionRef: { current: SubagentRuntimeExtension | undefined } = {
  current: undefined,
};

export function setSubagentRuntimeExtension(ext: SubagentRuntimeExtension | undefined): void {
  subagentRuntimeExtensionRef.current = ext;
}
