/**
 * Minimal type definitions for daemon interfaces that platform-discord needs.
 * These decouple platform-discord from @shoggoth/daemon internals.
 * The daemon passes concrete implementations at wiring time.
 */

import type { HitlRiskTier, ShoggothPolicyConfig, SystemContext } from "@shoggoth/shared";
import type { ModelInvocationParams } from "@shoggoth/models";
import type { OobTurnBannerHandle } from "@shoggoth/daemon/lib";

// ── Logging ──────────────────────────────────────────────────────────────────

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(extra: LogFields): Logger;
}

// ── HITL ─────────────────────────────────────────────────────────────────────

export type PendingActionStatus = "pending" | "approved" | "denied";
export type DenialReason = "operator" | "timeout";

export interface PendingActionRow {
  readonly id: string;
  readonly sessionId: string;
  readonly correlationId: string | undefined;
  readonly toolName: string;
  readonly resourceSummary: string | undefined;
  readonly payload: unknown;
  readonly riskTier: HitlRiskTier;
  readonly status: PendingActionStatus;
  readonly denialReason: DenialReason | undefined;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PendingActionsStore {
  enqueue(input: unknown): string;
  getById(id: string): PendingActionRow | undefined;
  listPendingForSession(sessionId: string): PendingActionRow[];
  listAllPending(limit?: number): PendingActionRow[];
  approve(id: string, resolverPrincipal: string): boolean;
  deny(id: string, resolverPrincipal: string): boolean;
}

/**
 * Pending store as consumed by the daemon tool loop: the platform's minimal
 * view above plus the resolution surface the loop relies on. A daemon-side
 * removal/rename of these members fails the platform typecheck here instead
 * of being masked by an `as any` at the wiring site.
 */
export type DaemonPendingActionsStore = PendingActionsStore & {
  /** Marks overdue pending rows as denied (timeout). Returns count updated. */
  expireDue(nowIso: string): number;
  /** Hard-deletes queued (`pending`) rows for the given sessions. */
  deletePendingForSessionIds(sessionIds: readonly string[]): number;
};

/** HITL pending resolution stack: pending store + resolution wait. */
export type DaemonPendingActionsStack = {
  readonly pending: DaemonPendingActionsStore;
  readonly waitForHitlResolution: (pendingId: string) => Promise<"approved" | "denied">;
};

/**
 * Policy engine as consumed by platform-discord: mirrors the daemon tool-loop's
 * engine contract (check + config) without importing daemon internals beyond
 * the config type. A daemon-side rename of `check` or its input fails here.
 */
export type DaemonPolicyEngine = {
  check(input: {
    readonly principal: { readonly kind: string; readonly sessionId?: string };
    readonly action: string;
    readonly resource: string;
  }): { allow: true } | { allow: false; reason: string };
  readonly config: ShoggothPolicyConfig;
};

/**
 * Subagent runtime extension as consumed by the daemon core (control-plane
 * subagent ops). Platform-discord supplies every member the daemon marks
 * required; declaring them here keeps the hand-off checked at one boundary.
 */
export type DaemonSubagentRuntimeExtension = {
  readonly runSessionModelTurn: (input: {
    readonly sessionId: string;
    readonly userContent: string;
    readonly userMetadata?: Record<string, unknown>;
    readonly systemContext?: SystemContext;
    readonly delivery:
      | { readonly kind: "internal" }
      | {
          readonly kind: "messaging_surface";
          readonly userId: string;
          readonly replyToMessageId?: string;
        };
    readonly modelInvocationOverride?: Partial<ModelInvocationParams>;
    readonly turnBanner?: string;
    readonly statusBarSink?: { setStatusBar: (line: string | null) => Promise<void> };
  }) => Promise<unknown>;
  readonly subscribeSubagentSession: (sessionId: string) => () => void;
  readonly registerPlatformThreadBinding: (
    threadChannelId: string,
    sessionId: string,
  ) => () => void;
  readonly announcePersistentSubagentSessionEnded?: (input: {
    readonly sessionId: string;
    readonly reason: "ttl_expired" | "killed";
  }) => void;
  readonly sendStatusMessage?: (sessionId: string, body: string) => Promise<void>;
  readonly createThread?: (
    channelId: string,
    body: { readonly name: string; readonly type?: 11 | 12 },
  ) => Promise<{ readonly id: string }>;
  readonly resolveOutboundChannelIdForSession?: (sessionId: string) => string | undefined;
  readonly postToOperator?: (input: {
    readonly sessionId: string;
    readonly userContent: string;
  }) => Promise<void>;
  readonly oobTurnBanner?: {
    begin: (input: {
      readonly sessionId: string;
      readonly processing: string;
    }) => Promise<OobTurnBannerHandle | undefined>;
    finish: (input: {
      readonly handle: OobTurnBannerHandle;
      readonly terminal: string;
      readonly content?: string;
      readonly statusBar?: string;
    }) => Promise<void>;
  };
  readonly pinMessage?: (input: {
    readonly channelId: string;
    readonly messageId: string;
  }) => Promise<void>;
};

export interface HitlNotifier {
  onQueued(row: PendingActionRow): void;
}

export type HealthStatus = "pass" | "fail" | "skipped";

export interface DependencyCheck {
  name: string;
  status: HealthStatus;
  detail?: string;
  latencyMs?: number;
}

export interface DependencyProbe {
  readonly name: string;
  check(): Promise<DependencyCheck>;
}

// ── Notices ──────────────────────────────────────────────────────────────────

/** Function signature matching daemon's `daemonNotice(key, vars)`. */
export type NoticeResolver = (key: string, vars?: Record<string, string>) => string;
