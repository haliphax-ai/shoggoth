import {
  hashAgentToken,
  type AgentTokenStore,
} from "@shoggoth/authn";
import type Database from "better-sqlite3";

/**
 * Persists SHA-256 hashes in `agent_tokens`; validates against active session rows.
 */
export function createSqliteAgentTokenStore(db: Database.Database): AgentTokenStore {
  const revokeForSession = db.prepare(`
    UPDATE agent_tokens SET revoked_at = datetime('now')
    WHERE session_id = @session_id AND revoked_at IS NULL
  `);
  const insert = db.prepare(`
    INSERT INTO agent_tokens (session_id, token_hash) VALUES (@session_id, @token_hash)
  `);
  const validateStmt = db.prepare(`
    SELECT s.status AS status
    FROM agent_tokens t
    JOIN sessions s ON s.id = t.session_id
    WHERE t.token_hash = @token_hash
      AND t.session_id = @session_id
      AND t.revoked_at IS NULL
  `);

  return {
    register(sessionId: string, rawToken: string): void {
      const token_hash = hashAgentToken(rawToken);
      const run = db.transaction(() => {
        revokeForSession.run({ session_id: sessionId });
        insert.run({ session_id: sessionId, token_hash });
      });
      run();
    },

    revoke(sessionId: string): void {
      revokeForSession.run({ session_id: sessionId });
    },

    validate(rawToken: string, sessionId: string): boolean {
      const token_hash = hashAgentToken(rawToken);
      const row = validateStmt.get({ token_hash, session_id: sessionId }) as
        | { status: string }
        | undefined;
      if (!row) return false;
      if (row.status === "terminated") return false;
      return true;
    },
  };
}
