import type { OperatorMap } from "@shoggoth/authn";
import type Database from "better-sqlite3";

/**
 * `operator_uid_map` rows override layered config / file for the same UID (caller chains maps DB-first).
 */
export function createSqliteOperatorMap(db: Database.Database): OperatorMap {
  const stmt = db.prepare(
    `SELECT operator_id, roles_json FROM operator_uid_map WHERE uid = @uid`,
  );
  return {
    resolve(uid: number) {
      const row = stmt.get({ uid }) as
        | { operator_id: string; roles_json: string | null }
        | undefined;
      if (!row) return null;
      let roles: string[] = [];
      if (row.roles_json) {
        try {
          const p = JSON.parse(row.roles_json) as unknown;
          if (Array.isArray(p)) roles = p.map(String);
        } catch {
          roles = [];
        }
      }
      return { operatorId: row.operator_id, roles };
    },
  };
}
