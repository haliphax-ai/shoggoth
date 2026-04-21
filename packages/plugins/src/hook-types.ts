// ---------------------------------------------------------------------------
// Hook Context Types for the Shoggoth Plugin System
// See: plans/2026-04-20_hooks-plugin-overhaul/spec.md §1
// ---------------------------------------------------------------------------

// TODO: Replace placeholder types with real imports once packages are wired up
// import type Database from "better-sqlite3";
// import type { ShoggothConfig } from "@shoggoth/shared";
// import type { PlatformRegistration, InternalMessage, PlatformRuntime } from "@shoggoth/messaging";

/** Placeholder for better-sqlite3 Database */
type Database = any;
/** Placeholder for ShoggothConfig from @shoggoth/shared */
type ShoggothConfig = any;
/** Placeholder for PlatformRegistration from @shoggoth/messaging */
type PlatformRegistration = any;
/** Placeholder for InternalMessage from @shoggoth/messaging */
type InternalMessage = any;
/** Placeholder for PlatformRuntime from @shoggoth/messaging */
type PlatformRuntime = any;
/** Placeholder for HitlPendingStack */
type HitlPendingStack = any;
/** Placeholder for PolicyEngine */
type PolicyEngine = any;
/** Placeholder for HitlConfigRef */
type HitlConfigRef = any;
/** Placeholder for HitlAutoApproveGate */
type HitlAutoApproveGate = any;
/** Placeholder for SubagentRuntimeExtension */
type SubagentRuntimeExtension = any;
/** Placeholder for MessageToolContext */
type MessageToolContext = any;
/** Placeholder for PlatformAdapter */
type PlatformAdapter = any;

// ---------------------------------------------------------------------------
// Daemon Lifecycle
// ---------------------------------------------------------------------------

/** Waterfall: plugins can return a modified config. */
export interface DaemonConfigureCtx {
  readonly config: ShoggothConfig;
}

export interface DaemonStartupCtx {
  readonly db: Database;
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

// ---------------------------------------------------------------------------
// Platform Lifecycle
// ---------------------------------------------------------------------------

export interface PlatformRegisterCtx {
  readonly config: Readonly<ShoggothConfig>;
  readonly registerPlatform: (reg: PlatformRegistration) => void;
  readonly setPlatformRuntime: (platformId: string, runtime: PlatformRuntime) => void;
}

export interface PlatformDeps {
  readonly hitlStack: HitlPendingStack;
  readonly policyEngine: PolicyEngine;
  readonly hitlConfigRef: HitlConfigRef;
  readonly hitlAutoApproveGate?: HitlAutoApproveGate;
}

export interface PlatformStartCtx {
  readonly db: Database;
  readonly config: Readonly<ShoggothConfig>;
  readonly configRef: { readonly current: ShoggothConfig };
  readonly env: NodeJS.ProcessEnv;
  readonly deps: PlatformDeps;
  readonly registerDrain: (name: string, fn: () => void | Promise<void>) => void;
  readonly setSubagentRuntimeExtension: (ext: SubagentRuntimeExtension) => void;
  readonly setMessageToolContext: (ctx: MessageToolContext) => void;
  readonly setPlatformAdapter: (adapter: PlatformAdapter) => void;
}

export interface PlatformStopCtx {
  readonly platformId: string;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

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
}

export interface MessageReactionCtx {
  readonly sessionId: string;
  readonly platformId: string;
  readonly emoji: string;
  readonly userId: string;
  readonly messageId: string;
  readonly channelId: string;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

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
