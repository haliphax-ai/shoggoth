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
  readonly abortSession: (sessionId: string) => Promise<boolean>;
  readonly invokeControlOp: (
    op: string,
    payload: unknown,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
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

// -------------------------------------------------------------------------------
// Service
// -------------------------------------------------------------------------------

/** Handler function for a direct service tool (plugin services). */
export type DirectToolHandler = (
  args: Record<string, unknown>,
  ctx: DirectToolContext,
) => Promise<{ resultJson: string }>;

/** Context passed to a direct tool handler at invocation time. */
export interface DirectToolContext {
  /** Agent ID that invoked the tool. */
  readonly agentId: string;
  /** Session URN of the invoking session. */
  readonly sessionUrn: string;
}

/** A tool provided by a plugin service with a direct handler function. */
export interface DirectServiceTool {
  /** Tool name as exposed to agents (e.g. "canvas.push"). */
  readonly name: string;
  /** Human-readable description for the tool descriptor. */
  readonly description: string;
  /** JSON Schema for the tool's parameters. */
  readonly parameters: Record<string, unknown>;
  /** Direct handler function invoked when an agent calls this tool. */
  readonly handler: DirectToolHandler;
}

/** Entry describing a plugin service for the registry. */
export interface PluginServiceEntry {
  /** Unique service ID. */
  readonly id: string;
  /** Human-readable label. */
  readonly label?: string;
  /** Named capabilities this service provides. */
  readonly capabilities?: string[];
  /** Exposure mode. Plugin services without a port default to "direct". */
  readonly expose?: "gateway" | "direct" | "both";
  /** Optional port if the plugin also binds an HTTP listener. */
  readonly port?: number;
  /** Optional protocol (default "http"). */
  readonly protocol?: "http" | "ws" | "http+ws";
  /** Optional base path for gateway routing. */
  readonly basePath?: string;
}

export interface ServiceRegisterCtx {
  /** Register this plugin as a service in the ServiceRegistry. */
  readonly registerService: (entry: PluginServiceEntry) => void;
  /** Register tools with direct handler functions (no HTTP dispatch). */
  readonly registerTools: (tools: DirectServiceTool[]) => void;
  /** Declare ops (capabilities/permissions) this plugin requires. */
  readonly ops?: readonly string[];
  /** Resolved config (after daemon.configure waterfall). */
  readonly config: Readonly<ShoggothConfig>;
  /** Spawn a one-shot session (in-process, trusted identity). Returns the session result. */
  readonly spawnSession?: (opts: {
    message: string;
    agentId?: string;
    model?: string;
    sessionKey?: string;
    mode?: string;
  }) => Promise<unknown>;
}
