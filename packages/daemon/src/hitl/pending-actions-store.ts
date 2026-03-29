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

export type PendingActionsStoreHooks = {
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

export type CreatePendingActionsStoreOptions = {
  readonly hooks?: PendingActionsStoreHooks;
};

const DEFAULT_LIST_ALL_PENDING_LIMIT = 500;

export function createPendingActionsStore(
  db: Database.Database,
  options?: CreatePendingActionsStoreOptions,
): PendingActionsStore {
  const hooks = options?.hooks;
  const insert = db.prepare(`
    INSERT INTO hitl_pending_actions (
      id, session_id, correlation_id, tool_name, resource_summary,
      payload_json, risk_tier, status, expires_at
    ) VALUES (
      @id, @session_id, @correlation_id, @tool_name, @resource_summary,
      @payload_json, @risk_tier, 'pending', @expires_at
    )
  `);

  const selectOne = db.prepare(`
    SELECT id, session_id, correlation_id, tool_name, resource_summary,
           payload_json, risk_tier, status, denial_reason,
           created_at, expires_at, resolved_at, resolver_principal
    FROM hitl_pending_actions WHERE id = @id
  `);

  const listPending = db.prepare(`
    SELECT id, session_id, correlation_id, tool_name, resource_summary,
           payload_json, risk_tier, status, denial_reason,
           created_at, expires_at, resolved_at, resolver_principal
    FROM hitl_pending_actions
    WHERE session_id = @session_id AND status = 'pending'
    ORDER BY created_at ASC
  `);

  const listAllPendingStmt = db.prepare(`
    SELECT id, session_id, correlation_id, tool_name, resource_summary,
           payload_json, risk_tier, status, denial_reason,
           created_at, expires_at, resolved_at, resolver_principal
    FROM hitl_pending_actions
    WHERE status = 'pending'
    ORDER BY created_at ASC
    LIMIT @limit
  `);

  return {
    enqueue(input) {
      insert.run({
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
    },

    getById(id) {
      const r = selectOne.get({ id }) as Parameters<typeof rowToPending>[0] | undefined;
      return r ? rowToPending(r) : undefined;
    },

    listPendingForSession(sessionId) {
      const rows = listPending.all({ session_id: sessionId }) as Parameters<typeof rowToPending>[0][];
      return rows.map(rowToPending);
    },

    listAllPending(limit) {
      const lim =
        limit === undefined
          ? DEFAULT_LIST_ALL_PENDING_LIMIT
          : Math.min(Math.max(1, limit), 10_000);
      const rows = listAllPendingStmt.all({ limit: lim }) as Parameters<typeof rowToPending>[0][];
      return rows.map(rowToPending);
    },

    approve(id, resolverPrincipal) {
      const q = db.prepare(`
        UPDATE hitl_pending_actions SET
          status = 'approved',
          resolved_at = datetime('now'),
          resolver_principal = @resolver_principal
        WHERE id = @id AND status = 'pending'
      `);
      const info = q.run({ id, resolver_principal: resolverPrincipal });
      if (info.changes > 0) {
        hooks?.onResolved?.({ id, status: "approved" });
      }
      return info.changes > 0;
    },

    deny(id, resolverPrincipal) {
      const q = db.prepare(`
        UPDATE hitl_pending_actions SET
          status = 'denied',
          denial_reason = 'operator',
          resolved_at = datetime('now'),
          resolver_principal = @resolver_principal
        WHERE id = @id AND status = 'pending'
      `);
      const info = q.run({ id, resolver_principal: resolverPrincipal });
      if (info.changes > 0) {
        hooks?.onResolved?.({ id, status: "denied", denialReason: "operator" });
      }
      return info.changes > 0;
    },

    expireDue(nowIso) {
      const selectDue = db.prepare(`
        SELECT id FROM hitl_pending_actions
        WHERE status = 'pending'
          AND datetime(expires_at) < datetime(@now_iso)
      `);
      const dueRows = selectDue.all({ now_iso: nowIso }) as { id: string }[];
      if (dueRows.length === 0) return 0;

      const upd = db.prepare(`
        UPDATE hitl_pending_actions SET
          status = 'denied',
          denial_reason = 'timeout',
          resolved_at = datetime('now')
        WHERE id = @id AND status = 'pending'
          AND datetime(expires_at) < datetime(@now_iso)
      `);

      let n = 0;
      for (const { id } of dueRows) {
        const info = upd.run({ id, now_iso: nowIso });
        if (info.changes > 0) {
          n++;
          hooks?.onResolved?.({ id, status: "denied", denialReason: "timeout" });
        }
      }
      return n;
    },
  };
}
