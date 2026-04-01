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
import type { Logger } from "../logging";
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
// PlatformErrorFormatter
// ---------------------------------------------------------------------------

/**
 * Platform-specific error formatting. Each platform maps thrown values to
 * user-facing copy (no stack traces) and enforces message-body length limits.
 */
export interface PlatformErrorFormatter {
  /** Map a thrown value to a short, platform-safe user-facing error string. */
  formatErrorUserText(e: unknown): string;

  /** Truncate a message body to the platform's maximum allowed length. */
  sliceMessageBody(text: string): string;
}

// ---------------------------------------------------------------------------
// PlatformAssistantDeps
// ---------------------------------------------------------------------------

/**
 * Dependency injection seam for the assistant tool loop, model client creation,
 * and MCP server connectivity. Production platforms use real implementations;
 * tests may override individual pieces.
 */
export interface PlatformAssistantDeps {
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
// PlatformProbe
// ---------------------------------------------------------------------------

/**
 * Result of a single platform health-check probe.
 */
export interface PlatformProbeResult {
  readonly name: string;
  readonly status: "pass" | "fail" | "skipped";
  readonly detail?: string;
}

/**
 * Health-check probe for a platform's external dependencies (API reachability,
 * token validity, etc.). Registered with {@link HealthRegistry} at startup.
 */
export interface PlatformProbe {
  /** Human-readable probe name (e.g. `"discord"`, `"slack"`). */
  readonly name: string;

  /** Execute the health check and return the result. */
  check(): Promise<PlatformProbeResult>;
}

// ---------------------------------------------------------------------------
// PlatformHitlAdapter
// ---------------------------------------------------------------------------

/**
 * Platform-specific human-in-the-loop interaction adapter.
 *
 * Platforms use their own UX patterns to capture operator approval — emoji
 * reactions, buttons, slash commands, etc. This interface captures the concept
 * of "platform-specific HITL interaction" without assuming any particular mechanism.
 */
export interface PlatformHitlAdapter {
  /**
   * Register a HITL notice so the platform can map inbound approval events
   * (reactions, button clicks, etc.) back to the pending tool-call row.
   *
   * @param pendingId  Unique id of the pending HITL action.
   * @param sessionId  Session that owns the pending action.
   * @param toolName   Name of the tool awaiting approval.
   * @param ref        Platform-specific reference (e.g. message id + channel id).
   */
  registerNotice(pendingId: string, sessionId: string, toolName: string, ref: unknown): void;

  /**
   * Handle an inbound approval event from the platform (e.g. a reaction add,
   * a button click, a slash-command response). The adapter resolves the event
   * to a pending id and applies the approval/denial.
   *
   * @param event  Platform-specific event payload.
   */
  onInboundApprovalEvent(event: unknown): void;
}

// ---------------------------------------------------------------------------
// PlatformOptions
// ---------------------------------------------------------------------------

/**
 * Common configuration and dependencies passed to a platform's `start*` factory.
 * Each concrete platform extends this with transport-specific fields.
 */
export interface PlatformOptions {
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

  /** Structured logger instance. */
  readonly logger: Logger;

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
