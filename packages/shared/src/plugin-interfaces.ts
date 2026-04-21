// -------------------------------------------------------------------------------
// Plugin Interface Types — minimal interfaces for cross-package plugin contracts
//
// These define the shapes that platform plugins receive from the daemon via hook
// contexts. They live in @shoggoth/shared so plugins can import real types without
// depending on daemon internals.
// -------------------------------------------------------------------------------

import type { ShoggothHitlConfig } from "./schema";

/**
 * Minimal interface for the HITL pending actions store.
 * Plugins use this to queue/resolve HITL approvals.
 */
export interface HitlPendingStore {
  approve(id: string, resolverPrincipal: string): boolean;
  deny(id: string, resolverPrincipal: string): boolean;
  getById(id: string): { id: string; sessionId: string; toolName: string; status: string } | undefined;
  listPendingForSession(sessionId: string): readonly { id: string; sessionId: string; toolName: string; status: string }[];
}

/**
 * HITL pending resolution stack — pending store + resolution hub.
 */
export interface HitlPendingStack {
  readonly pending: HitlPendingStore;
  readonly waitForHitlResolution: (pendingId: string) => Promise<"approved" | "denied">;
}

/**
 * HITL auto-approve gate — tracks per-session/agent tool approvals.
 */
export interface HitlAutoApproveGate {
  enableSessionTool(sessionId: string, toolName: string): void;
  enableAgentTool(agentId: string, toolName: string): void;
  shouldAutoApprove(sessionId: string, toolName: string): boolean;
  clearAutoApproveMemory?(input: { readonly agents: "all" | readonly string[] }): void;
}

/**
 * Mutable ref to the current HITL config.
 */
export interface HitlConfigRef {
  value: ShoggothHitlConfig;
}

/**
 * Policy engine — evaluates whether a principal can perform an action.
 */
export interface PolicyEngine {
  check(input: {
    readonly principal: { readonly kind: string; readonly sessionId?: string };
    readonly action: string;
    readonly resource: string;
  }): { allow: true } | { allow: false; reason: string };
  readonly config: unknown;
}

/**
 * Subagent runtime extension — platform provides session turn execution.
 */
export interface SubagentRuntimeExtension {
  runSessionModelTurn(input: {
    sessionId: string;
    userContent: string;
    userMetadata?: Record<string, unknown>;
    systemContext?: unknown;
    delivery?: { kind: string; userId?: string };
  }): Promise<unknown>;
  subscribeSubagentSession?(input: unknown): unknown;
  registerPlatformThreadBinding?(input: unknown): unknown;
  announcePersistentSubagentSessionEnded?(input: unknown): unknown;
}

/**
 * Message tool context — execute message tool actions on a platform.
 */
export interface MessageToolContext {
  readonly slice: Record<string, boolean>;
  execute(sessionId: string, args: unknown): Promise<unknown>;
}

/**
 * Platform adapter — abstract send/stream interface for outbound messages.
 */
export interface PlatformAdapter {
  sendBody(target: string, body: string): Promise<void>;
  startStream?(target: string): unknown;
}
