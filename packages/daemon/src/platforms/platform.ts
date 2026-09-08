/**
 * Platform-agnostic interfaces for daemon platform implementations.
 *
 * These abstractions allow platforms (Discord, Slack, Matrix, CLI, etc.) to plug
 * in without coupling the daemon core to any single transport.
 */

import type { SessionModelTurnDelivery } from "../messaging/session-model-turn-delivery";
import type { SessionAgentTurnResult } from "../sessions/session-agent-turn";
import type { ModelInvocationParams } from "@shoggoth/models";

// ---------------------------------------------------------------------------
// PlatformHandle
// ---------------------------------------------------------------------------

/**
 * Lifecycle handle returned by a started platform. Provides the daemon core with
 * transport-agnostic operations: running model turns, managing subagent bus
 * subscriptions, and announcing subagent lifecycle events.
 */
export interface PlatformHandle {
  /** Unsubscribe from platform routes and release resources (MCP subprocesses, sockets, etc.). */
  readonly stop: () => Promise<void>;

  /**
   * Run one model turn for an existing session.
   *
   * `internal` delivery returns assistant text only; `messaging_surface` delivery
   * posts the formatted reply via the platform's outbound transport.
   */
  readonly runSessionModelTurn: (input: {
    readonly sessionId: string;
    readonly userContent: string;
    readonly userMetadata?: Record<string, unknown>;
    readonly delivery: SessionModelTurnDelivery;
    /** Optional override merged into the session's model invocation params (e.g. responseSchema for structured output). */
    readonly modelInvocationOverride?: Partial<ModelInvocationParams>;
  }) => Promise<SessionAgentTurnResult>;

  /**
   * Subscribe a session id to the platform's agent-to-agent bus (persistent subagents).
   * Returns an unsubscribe function.
   */
  readonly subscribeSubagentSession: (sessionId: string) => () => void;

  /**
   * Post a short in-thread status when a persistent subagent session ends.
   * Platforms decide how to surface this (e.g. a message in a thread,
   * a notification, or another platform-specific mechanism).
   */
  readonly announcePersistentSubagentSessionEnded: (input: {
    readonly sessionId: string;
    readonly reason: "ttl_expired" | "killed";
  }) => void;
}
