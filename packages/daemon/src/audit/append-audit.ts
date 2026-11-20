import type Database from "better-sqlite3";

export interface AppendAuditRowInput {
  readonly source: string;
  readonly principalKind?: string;
  readonly principalId?: string;
  readonly sessionId?: string | null;
  readonly agentId?: string | null;
  readonly peerUid?: number | null;
  readonly peerGid?: number | null;
  readonly peerPid?: number | null;
  readonly correlationId?: string | null;
  readonly action: string;
  readonly resource?: string;
  readonly outcome: string;
  readonly argsRedactedJson?: string;
}

/*
 * The audit INSERT is prepared once per database handle and reused across
 * calls: the tool loop records several audit rows per tool call, so preparing
 * the statement on every append would repeat the same parse per row. A WeakMap
 * keys the cache on the handle so entries do not outlive a closed db.
 */
const insertAuditStmts = new WeakMap<Database.Database, Database.Statement>();

export function appendAuditRow(db: Database.Database, row: AppendAuditRowInput): void {
  let stmt = insertAuditStmts.get(db);
  if (!stmt) {
    stmt = db.prepare(
      `INSERT INTO audit_log (
        source, principal_kind, principal_id, session_id, agent_id,
        peer_uid, peer_gid, peer_pid,
        correlation_id, action, resource, outcome, args_redacted_json
      ) VALUES (
        @source, @principalKind, @principalId, @sessionId, @agentId,
        @peerUid, @peerGid, @peerPid,
        @correlationId, @action, @resource, @outcome, @argsRedactedJson
      )`,
    );
    insertAuditStmts.set(db, stmt);
  }

  stmt.run({
    source: row.source,
    principalKind: row.principalKind ?? null,
    principalId: row.principalId ?? null,
    sessionId: row.sessionId ?? null,
    agentId: row.agentId ?? null,
    peerUid: row.peerUid ?? null,
    peerGid: row.peerGid ?? null,
    peerPid: row.peerPid ?? null,
    correlationId: row.correlationId ?? null,
    action: row.action,
    resource: row.resource ?? null,
    outcome: row.outcome,
    argsRedactedJson: row.argsRedactedJson ?? null,
  });
}
