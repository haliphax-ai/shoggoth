// -------------------------------------------------------------------------------
// Hook Context Types for the Shoggoth Plugin System
// -------------------------------------------------------------------------------

import type {
  ShoggothConfig,
  Logger,
  HitlPendingStack,
  HitlAutoApproveGate,
  HitlConfigRef,
  PolicyEngine,
  SubagentRuntimeExtension,
  MessageToolContext,
  PlatformAdapter,
} from "@shoggoth/shared";
import type { PlatformRegistration, PlatformRuntime, InternalMessage } from "@shoggoth/messaging";
import type { PlatformDeliveryRegistry } from "./platform-delivery-registry";

// -------------------------------------------------------------------------------
// Daemon Lifecycle
// -------------------------------------------------------------------------------

/** Waterfall: plugins can return a modified config. */
export interface DaemonConfigureCtx {
  readonly config: ShoggothConfig;
  [key: string]: unknown;
}

export interface DaemonStartupCtx {
  readonly db: unknown;
  readonly config: Readonly<ShoggothConfig>;
  readonly configRef: { readonly current: ShoggothConfig };
  readonly registerDrain: (name: string, fn: () => void | Promise<void>) => void;
}

export interface DaemonReadyCtx {
  readonly config: Readonly<ShoggothConfig>;
  readonly platforms: ReadonlyMap<string, PlatformRuntime>;
}

export interface DaemonShutdownCtx {
  readonly reason: string;
}

// -------------------------------------------------------------------------------
// Platform Lifecycle
// -------------------------------------------------------------------------------

export interface PlatformRegisterCtx {
  readonly config: Readonly<ShoggothConfig>;
  readonly registerPlatform: (reg: PlatformRegistration) => void;
  readonly setPlatformRuntime: (platformId: string, runtime: PlatformRuntime) => void;
}

/**
 * Dependencies that the daemon creates and passes to platform plugins.
 * Platform-agnostic — no Discord/Telegram/etc. specifics leak here.
 */
export interface PlatformDeps {
  readonly hitlStack?: HitlPendingStack;
  readonly policyEngine: PolicyEngine;
  readonly hitlConfigRef: HitlConfigRef;
  readonly hitlAutoApproveGate?: HitlAutoApproveGate;
  readonly logger: Logger;
  /** Default platform assistant dependencies (opaque to the plugin system). */
  readonly platformAssistantDeps: unknown;
  readonly abortSession: (sessionId: string) => Promise<void>;
  readonly invokeControlOp: (op: string, payload: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  readonly registerPlatform: (platformId: string, handle: unknown) => void;
  readonly stopAllPlatforms: () => Promise<void>;
  readonly reconcilePersistentSubagents: (input: {
    readonly db: unknown;
    readonly config: ShoggothConfig;
    readonly ext: unknown;
  }) => { restored: number; expiredKilled: number };
  readonly noticeResolver: (key: string, params?: Record<string, unknown>) => string;
}

export interface PlatformStartCtx {
  readonly db: unknown;
  readonly config: Readonly<ShoggothConfig>;
  readonly configRef: { readonly current: ShoggothConfig };
  readonly env: NodeJS.ProcessEnv;
  readonly deps: PlatformDeps;
  readonly deliveryRegistry: PlatformDeliveryRegistry;
  readonly registerDrain: (name: string, fn: () => void | Promise<void>) => void;
  readonly setSubagentRuntimeExtension: (ext: SubagentRuntimeExtension | undefined) => void;
  readonly setMessageToolContext: (ctx: MessageToolContext) => void;
  readonly setPlatformAdapter: (adapter: PlatformAdapter) => void;
}

export interface PlatformStopCtx {
  readonly platformId: string;
}

// -------------------------------------------------------------------------------
// Messaging
// -------------------------------------------------------------------------------

export interface MessageInboundCtx {
  readonly message: InternalMessage;
  readonly sessionId: string;
  readonly platformId: string;
}

export interface MessageOutboundCtx {
  body: string;
  readonly sessionId: string;
  readonly platformId: string;
  readonly replyToMessageId?: string;
  [key: string]: unknown;
}

export interface MessageReactionCtx {
  readonly sessionId: string;
  readonly platformId: string;
  readonly emoji: string;
  readonly userId: string;
  readonly messageId: string;
  readonly channelId: string;
}

// -------------------------------------------------------------------------------
// Session
// -------------------------------------------------------------------------------

export interface SessionTurnBeforeCtx {
  readonly sessionId: string;
  readonly userContent: string;
  readonly platformId?: string;
}

export interface SessionTurnAfterCtx {
  readonly sessionId: string;
  readonly assistantText?: string;
  readonly error?: Error;
  readonly platformId?: string;
  readonly tokenUsage?: { prompt: number; completion: number };
}

export interface SessionSegmentChangeCtx {
  readonly sessionId: string;
  readonly mode: "new" | "reset";
  readonly newSegmentId: string;
}

// -------------------------------------------------------------------------------
// Health
// -------------------------------------------------------------------------------

export interface HealthRegisterCtx {
  readonly registerProbe: (probe: HealthProbe) => void;
}

export interface HealthProbe {
  readonly name: string;
  check(): Promise<HealthProbeResult>;
}

export interface HealthProbeResult {
  readonly status: "pass" | "fail" | "skipped";
  readonly detail?: string;
}
