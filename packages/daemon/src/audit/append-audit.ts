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

export function appendAuditRow(db: Database.Database, row: AppendAuditRowInput): void {
  db.prepare(
    `INSERT INTO audit_log (
      source, principal_kind, principal_id, session_id, agent_id,
      peer_uid, peer_gid, peer_pid,
      correlation_id, action, resource, outcome, args_redacted_json
    ) VALUES (
      @source, @principalKind, @principalId, @sessionId, @agentId,
      @peerUid, @peerGid, @peerPid,
      @correlationId, @action, @resource, @outcome, @argsRedactedJson
    )`,
  ).run({
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
