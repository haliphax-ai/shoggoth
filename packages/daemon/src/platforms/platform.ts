/**
 * Platform-agnostic interfaces for daemon platform implementations.
 *
 * These abstractions allow platforms (Discord, Slack, Matrix, CLI, etc.) to plug
 * in without coupling the daemon core to any single transport.
 */

import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import type { SessionModelTurnDelivery } from "../messaging/session-model-turn-delivery";
import type { SessionAgentTurnResult } from "../sessions/session-agent-turn";
import type { PolicyEngine } from "../policy/engine";
import type { HitlConfigRef } from "../config-hot-reload";
import type { HitlPendingStack } from "../hitl/hitl-pending-stack";
import type {
  CreateFailoverFromConfigOptions,
  FailoverToolCallingClient,
} from "@shoggoth/models";
import type { RunToolLoopOptions } from "../sessions/tool-loop";
import type { connectShoggothMcpServers } from "../mcp/mcp-server-pool";

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

// ---------------------------------------------------------------------------
// PlatformAssistantDeps
// ---------------------------------------------------------------------------

/**
 * Dependency injection seam for the assistant tool loop, model client creation,
 * and MCP server connectivity. Production platforms use real implementations;
 * tests may override individual pieces.
 */
interface PlatformAssistantDeps {
  /** Factory for the failover-capable tool-calling model client. */
  readonly createToolCallingClient: (
    models: ShoggothConfig["models"],
    options?: CreateFailoverFromConfigOptions,
  ) => FailoverToolCallingClient;

  /** The tool-loop runner (chat → tool calls → tool results → chat, repeat). */
  readonly runToolLoopImpl: (opts: RunToolLoopOptions) => Promise<void>;

  /** Connect configured MCP servers for a session's tool context. */
  readonly connectShoggothMcpServers: typeof connectShoggothMcpServers;
}

// ---------------------------------------------------------------------------
// PlatformOptions
// ---------------------------------------------------------------------------

/**
 * Common configuration and dependencies passed to a platform's `start*` factory.
 * Each concrete platform extends this with transport-specific fields.
 */
interface PlatformOptions {
  /** SQLite database handle for sessions, transcripts, tool runs, and HITL state. */
  readonly db: Database.Database;

  /** Resolved daemon configuration. */
  readonly config: ShoggothConfig;

  /** Tool/control authorization engine. When omitted, a default engine is created from config. */
  readonly policyEngine?: PolicyEngine;

  /** Live-reloadable HITL configuration reference. */
  readonly hitlConfigRef?: HitlConfigRef;

  /**
   * Shared pending-action store and resolution waiters.
   * When omitted, an isolated stack is created (control-socket approve/deny
   * will not unblock this platform's waiters).
   */
  readonly hitlPending?: HitlPendingStack;

  /**
   * Merged environment variables. Layered with `process.env` and config-derived
   * `SHOGGOTH_*` keys via `mergeOrchestratorEnv`. Omit to use only process env + config.
   */
  readonly env?: NodeJS.ProcessEnv;

  /**
   * Assistant loop + MCP pool wiring. Production passes platform-specific defaults;
   * tests may override individual pieces.
   */
  readonly deps?: Partial<PlatformAssistantDeps>;
}
