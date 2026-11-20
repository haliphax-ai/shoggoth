import type Database from "better-sqlite3";
import type { HitlRiskTier } from "@shoggoth/shared";

export type PendingActionStatus = "pending" | "approved" | "denied";

export type DenialReason = "operator" | "timeout";

export interface EnqueuePendingInput {
  readonly id: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly payload: unknown;
  readonly riskTier: HitlRiskTier;
  readonly expiresAtIso: string;
  readonly correlationId?: string;
  readonly resourceSummary?: string;
}

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
  readonly resolvedAt: string | undefined;
  readonly resolverPrincipal: string | undefined;
}

type PendingActionsStoreHooks = {
  onResolved?: (input: {
    id: string;
    status: Exclude<PendingActionStatus, "pending">;
    denialReason?: DenialReason;
  }) => void;
};

export interface PendingActionsStore {
  enqueue(input: EnqueuePendingInput): string;
  getById(id: string): PendingActionRow | undefined;
  listPendingForSession(sessionId: string): PendingActionRow[];
  /** All rows with status `pending`, newest last, capped for control-plane listing. */
  listAllPending(limit?: number): PendingActionRow[];
  approve(id: string, resolverPrincipal: string): boolean;
  deny(id: string, resolverPrincipal: string): boolean;
  /** Marks overdue pending rows as denied (timeout). Returns count updated. */
  expireDue(nowIso: string): number;
  /** Hard-deletes queued (`pending`) rows for the given sessions. */
  deletePendingForSessionIds(sessionIds: readonly string[]): number;
}

function rowToPending(r: {
  id: string;
  session_id: string;
  correlation_id: string | null;
  tool_name: string;
  resource_summary: string | null;
  payload_json: string;
  risk_tier: string;
  status: string;
  denial_reason: string | null;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolver_principal: string | null;
}): PendingActionRow {
  let payload: unknown;
  try {
    payload = JSON.parse(r.payload_json) as unknown;
  } catch {
    payload = undefined;
  }
  return {
    id: r.id,
    sessionId: r.session_id,
    correlationId: r.correlation_id ?? undefined,
    toolName: r.tool_name,
    resourceSummary: r.resource_summary ?? undefined,
    payload,
    riskTier: r.risk_tier as HitlRiskTier,
    status: r.status as PendingActionStatus,
    denialReason: (r.denial_reason as DenialReason | null) ?? undefined,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    resolvedAt: r.resolved_at ?? undefined,
    resolverPrincipal: r.resolver_principal ?? undefined,
  };
}

type PendingActionDbRow = Parameters<typeof rowToPending>[0];

type InsertPendingParams = {
  id: string;
  session_id: string;
  correlation_id: string | null;
  tool_name: string;
  resource_summary: string | null;
  payload_json: string;
  risk_tier: string;
  expires_at: string;
};

type SelectPendingByIdParams = { id: string };

type ListPendingBySessionParams = { session_id: string };

type ListAllPendingParams = { limit: number };

type ResolvePendingParams = { id: string; resolver_principal: string };

type SelectDueParams = { now_iso: string };

type ExpireDueParams = { id: string; now_iso: string };

type InsertPendingStmt = Database.Statement<InsertPendingParams>;

type SelectPendingByIdStmt = Database.Statement<SelectPendingByIdParams, PendingActionDbRow>;

type ListPendingBySessionStmt = Database.Statement<ListPendingBySessionParams, PendingActionDbRow>;

type ListAllPendingStmt = Database.Statement<ListAllPendingParams, PendingActionDbRow>;

type ResolvePendingStmt = Database.Statement<ResolvePendingParams, Database.RunResult>;

type SelectDuePendingStmt = Database.Statement<SelectDueParams, { id: string }>;

type ExpirePendingStmt = Database.Statement<ExpireDueParams, Database.RunResult>;

function enqueuePendingRow(stmt: InsertPendingStmt, input: EnqueuePendingInput): string {
  stmt.run({
    id: input.id,
    session_id: input.sessionId,
    correlation_id: input.correlationId ?? null,
    tool_name: input.toolName,
    resource_summary: input.resourceSummary ?? null,
    payload_json: JSON.stringify(input.payload ?? null),
    risk_tier: input.riskTier,
    expires_at: input.expiresAtIso,
  });
  return input.id;
}

function getPendingRow(stmt: SelectPendingByIdStmt, id: string): PendingActionRow | undefined {
  const r = stmt.get({ id });
  return r ? rowToPending(r) : undefined;
}

function listPendingRowsForSession(
  stmt: ListPendingBySessionStmt,
  sessionId: string,
): PendingActionRow[] {
  return stmt.all({ session_id: sessionId }).map(rowToPending);
}

function listAllPendingRows(
  stmt: ListAllPendingStmt,
  limit: number | undefined,
): PendingActionRow[] {
  const lim =
    limit === undefined ? DEFAULT_LIST_ALL_PENDING_LIMIT : Math.min(Math.max(1, limit), 10_000);
  return stmt.all({ limit: lim }).map(rowToPending);
}

function approvePendingRow(
  stmt: ResolvePendingStmt,
  hooks: PendingActionsStoreHooks | undefined,
  id: string,
  resolverPrincipal: string,
): boolean {
  const info = stmt.run({ id, resolver_principal: resolverPrincipal });
  if (info.changes > 0) {
    hooks?.onResolved?.({ id, status: "approved" });
  }
  return info.changes > 0;
}

function denyPendingRow(
  stmt: ResolvePendingStmt,
  hooks: PendingActionsStoreHooks | undefined,
  id: string,
  resolverPrincipal: string,
): boolean {
  const info = stmt.run({ id, resolver_principal: resolverPrincipal });
  if (info.changes > 0) {
    hooks?.onResolved?.({ id, status: "denied", denialReason: "operator" });
  }
  return info.changes > 0;
}

function expireDueRows(
  selectDue: SelectDuePendingStmt,
  expireOne: ExpirePendingStmt,
  hooks: PendingActionsStoreHooks | undefined,
  nowIso: string,
): number {
  const dueRows = selectDue.all({ now_iso: nowIso });
  if (dueRows.length === 0) return 0;

  let n = 0;
  for (const { id } of dueRows) {
    const info = expireOne.run({ id, now_iso: nowIso });
    if (info.changes > 0) {
      n++;
      hooks?.onResolved?.({ id, status: "denied", denialReason: "timeout" });
    }
  }
  return n;
}

function deletePendingRowsForSessions(
  deleteBySessionIds: (sessionIds: readonly string[]) => number,
  sessionIds: readonly string[],
): number {
  if (sessionIds.length === 0) return 0;
  return Number(deleteBySessionIds(sessionIds));
}

type CreatePendingActionsStoreOptions = {
  readonly hooks?: PendingActionsStoreHooks;
};

const DEFAULT_LIST_ALL_PENDING_LIMIT = 500;

export function createPendingActionsStore(
  db: Database.Database,
  options?: CreatePendingActionsStoreOptions,
): PendingActionsStore {
  const hooks = options?.hooks;
  const insert = db.prepare<InsertPendingParams>(`
    INSERT INTO hitl_pending_actions (
      id, session_id, correlation_id, tool_name, resource_summary,
      payload_json, risk_tier, status, expires_at
    ) VALUES (
      @id, @session_id, @correlation_id, @tool_name, @resource_summary,
      @payload_json, @risk_tier, 'pending', @expires_at
    )
  `);

  const selectOne = db.prepare<SelectPendingByIdParams, PendingActionDbRow>(`
    SELECT id, session_id, correlation_id, tool_name, resource_summary,
           payload_json, risk_tier, status, denial_reason,
           created_at, expires_at, resolved_at, resolver_principal
    FROM hitl_pending_actions WHERE id = @id
  `);

  const listPending = db.prepare<ListPendingBySessionParams, PendingActionDbRow>(`
    SELECT id, session_id, correlation_id, tool_name, resource_summary,
           payload_json, risk_tier, status, denial_reason,
           created_at, expires_at, resolved_at, resolver_principal
    FROM hitl_pending_actions
    WHERE session_id = @session_id AND status = 'pending'
    ORDER BY created_at ASC
  `);

  const listAllPendingStmt = db.prepare<ListAllPendingParams, PendingActionDbRow>(`
    SELECT id, session_id, correlation_id, tool_name, resource_summary,
           payload_json, risk_tier, status, denial_reason,
           created_at, expires_at, resolved_at, resolver_principal
    FROM hitl_pending_actions
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT @limit
  `);

  const approveStmt = db.prepare<ResolvePendingParams, Database.RunResult>(`
    UPDATE hitl_pending_actions SET
      status = 'approved',
      resolved_at = datetime('now'),
      resolver_principal = @resolver_principal
    WHERE id = @id AND status = 'pending'
  `);

  const denyStmt = db.prepare<ResolvePendingParams, Database.RunResult>(`
    UPDATE hitl_pending_actions SET
      status = 'denied',
      denial_reason = 'operator',
      resolved_at = datetime('now'),
      resolver_principal = @resolver_principal
    WHERE id = @id AND status = 'pending'
  `);

  const selectDueStmt = db.prepare<SelectDueParams, { id: string }>(`
    SELECT id FROM hitl_pending_actions
    WHERE status = 'pending'
      AND datetime(expires_at) < datetime(@now_iso)
  `);

  const expireDueStmt = db.prepare<ExpireDueParams, Database.RunResult>(`
    UPDATE hitl_pending_actions SET
      status = 'denied',
      denial_reason = 'timeout',
      resolved_at = datetime('now')
    WHERE id = @id AND status = 'pending'
      AND datetime(expires_at) < datetime(@now_iso)
  `);

  const deletePendingStmt = db.prepare(`
    DELETE FROM hitl_pending_actions
    WHERE status = 'pending' AND session_id = @session_id
  `);

  const deletePendingBySessionIds = db.transaction((sessionIds: readonly string[]) => {
    let n = 0;
    for (const sessionId of sessionIds) {
      n += deletePendingStmt.run({ session_id: sessionId.trim() }).changes;
    }
    return n;
  });

  return {
    enqueue: (input) => enqueuePendingRow(insert, input),
    getById: (id) => getPendingRow(selectOne, id),
    listPendingForSession: (sessionId) => listPendingRowsForSession(listPending, sessionId),
    listAllPending: (limit) => listAllPendingRows(listAllPendingStmt, limit),
    approve: (id, resolverPrincipal) =>
      approvePendingRow(approveStmt, hooks, id, resolverPrincipal),
    deny: (id, resolverPrincipal) => denyPendingRow(denyStmt, hooks, id, resolverPrincipal),
    expireDue: (nowIso) => expireDueRows(selectDueStmt, expireDueStmt, hooks, nowIso),
    deletePendingForSessionIds: (sessionIds) =>
      deletePendingRowsForSessions(deletePendingBySessionIds, sessionIds),
  };
}
