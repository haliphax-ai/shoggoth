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
  getById(
    id: string,
  ): { id: string; sessionId: string; toolName: string; status: string } | undefined;
  listPendingForSession(sessionId: string): readonly {
    id: string;
    sessionId: string;
    toolName: string;
    status: string;
  }[];
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
  enableAgentTool(agentId: string, toolName: string): Promise<void>;
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
 * Per-session cruise control policy — operator guidance for the HITL judge
 * agent that auto-approves/denies requests that do not pass auto-approvals.
 */
export interface CruiseControlPolicy {
  /** Guidance for when to approve HITL requests. */
  readonly yes: string;
  /** Guidance for when to deny HITL requests. */
  readonly no: string;
  /** Guidance for when to escalate HITL requests to the operator. */
  readonly escalate?: string;
  /** `provider/model` decision model; falls back to `agents.cruiseControl.model`. */
  readonly model?: string;
}

/** Verdict of the cruise control judge for one HITL request. */
export type CruiseControlDecision = "approve" | "deny" | "escalate";

/**
 * Minimal interface for the per-session cruise control store (platform side).
 */
export interface CruiseControlStore {
  get(sessionId: string): CruiseControlPolicy | undefined;
  isActive(sessionId: string): boolean;
}

/**
 * Cruise control handle the daemon passes to platform plugins: the session
 * store plus the judge used by the tool loop HITL gate.
 */
export interface CruiseControlHandle {
  readonly store: CruiseControlStore;
  readonly judge: (input: {
    readonly sessionId: string;
    readonly toolName: string;
    readonly argsJson: string;
  }) => Promise<CruiseControlDecision>;
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
  /** Post a status/banner message to the session's bound platform surface. */
  sendStatusMessage?(sessionId: string, body: string): Promise<void>;
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
