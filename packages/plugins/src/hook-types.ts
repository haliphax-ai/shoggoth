// -------------------------------------------------------------------------------
// Hook Context Types for the Shoggoth Plugin System

// -------------------------------------------------------------------------------

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
/** Placeholder for Logger */
type Logger = any;
/** Placeholder for PlatformAssistantDeps */
type PlatformAssistantDeps = any;

// -------------------------------------------------------------------------------
// Daemon Lifecycle
// -------------------------------------------------------------------------------

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
 * These are platform-agnostic but needed by the Discord plugin.
 */
export interface PlatformDeps {
  /** HITL pending stack - created by daemon */
  readonly hitlStack?: HitlPendingStack;
  /** Policy engine - created by daemon */
  readonly policyEngine: PolicyEngine;
  /** HITL config ref - created by daemon */
  readonly hitlConfigRef: HitlConfigRef;
  /** HITL auto-approve gate - created by daemon */
  readonly hitlAutoApproveGate?: HitlAutoApproveGate;
  /** Logger for platform operations */
  readonly logger: Logger;
  /** Default platform assistant dependencies */
  readonly platformAssistantDeps: PlatformAssistantDeps;
  /** Function to abort a session turn */
  readonly abortSession: (sessionId: string) => Promise<void>;
  /** Function to invoke a control operation */
  readonly invokeControlOp: (op: string, payload: any) => Promise<{ ok: boolean; result?: any; error?: string }>;
  /** Function to resolve session for a channel */
  readonly resolveSessionForChannel: (channelId: string, guildId?: string) => string | undefined;
  /** Function to register a platform with the daemon's platform registry */
  readonly registerPlatform: (platformId: string, handle: any) => void;
  /** Function to stop all platforms */
  readonly stopAllPlatforms: () => Promise<void>;
  /** Function to reconcile persistent subagents */
  readonly reconcilePersistentSubagents: (input: {
    readonly db: Database;
    readonly config: ShoggothConfig;
    readonly ext: any;
  }) => { restored: number; expiredKilled: number };
  /** Notice resolver function from daemon */
  readonly noticeResolver: (key: string, params?: Record<string, any>) => string;
  /** Function to get Discord bot token */
  readonly getBotToken: () => string | undefined;
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
  /** Pre-built message tool context from the daemon - the plugin should use this instead of building its own */
  readonly messageToolContext?: MessageToolContext;
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