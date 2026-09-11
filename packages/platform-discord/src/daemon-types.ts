/**
 * Minimal type definitions for daemon interfaces that platform-discord needs.
 * These decouple platform-discord from @shoggoth/daemon internals.
 * The daemon passes concrete implementations at wiring time.
 */

import type { HitlRiskTier } from "@shoggoth/shared";

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

export interface HitlNotifier {
  onQueued(row: PendingActionRow): void;
}

export type HitlAutoApproveGate = {
  enableSessionTool(sessionId: string, toolName: string): void;
  enableAgentTool(agentId: string, toolName: string): Promise<void>;
  shouldAutoApprove(sessionId: string, toolName: string): boolean;
  clearAutoApproveMemory?(input: { readonly agents: "all" | readonly string[] }): void;
};

// ── Health ────────────────────────────────────────────────────────────────────

export type HealthStatus = "pass" | "fail" | "warn" | "skipped";

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
