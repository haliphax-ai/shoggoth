import type Database from "better-sqlite3";
import type { AcpxWorkspaceBinding } from "@shoggoth/mcp-integration";

export type AcpxBindingStore = {
  get(acpWorkspaceRoot: string): AcpxWorkspaceBinding | undefined;
  upsert(binding: AcpxWorkspaceBinding): void;
  delete(acpWorkspaceRoot: string): boolean;
  list(): AcpxWorkspaceBinding[];
};

export function createSqliteAcpxBindingStore(db: Database.Database): AcpxBindingStore {
  const selectOne = db.prepare(`
    SELECT acp_workspace_root, shoggoth_session_id, agent_principal_id
    FROM acpx_workspace_bindings
    WHERE acp_workspace_root = ?
  `);

  const selectAll = db.prepare(`
    SELECT acp_workspace_root, shoggoth_session_id, agent_principal_id
    FROM acpx_workspace_bindings
    ORDER BY acp_workspace_root ASC
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO acpx_workspace_bindings (acp_workspace_root, shoggoth_session_id, agent_principal_id, updated_at)
    VALUES (@acp_workspace_root, @shoggoth_session_id, @agent_principal_id, datetime('now'))
    ON CONFLICT (acp_workspace_root) DO UPDATE SET
      shoggoth_session_id = excluded.shoggoth_session_id,
      agent_principal_id = excluded.agent_principal_id,
      updated_at = datetime('now')
  `);

  const del = db.prepare(`DELETE FROM acpx_workspace_bindings WHERE acp_workspace_root = ?`);

  function rowToBinding(r: {
    acp_workspace_root: string;
    shoggoth_session_id: string;
    agent_principal_id: string;
  }): AcpxWorkspaceBinding {
    return {
      acpWorkspaceRoot: r.acp_workspace_root,
      shoggothSessionId: r.shoggoth_session_id,
      agentPrincipalId: r.agent_principal_id,
    };
  }

  return {
    get(acpWorkspaceRoot: string) {
      const r = selectOne.get(acpWorkspaceRoot) as
        | {
            acp_workspace_root: string;
            shoggoth_session_id: string;
            agent_principal_id: string;
          }
        | undefined;
      return r ? rowToBinding(r) : undefined;
    },

    upsert(binding: AcpxWorkspaceBinding) {
      upsertStmt.run({
        acp_workspace_root: binding.acpWorkspaceRoot,
        shoggoth_session_id: binding.shoggothSessionId,
        agent_principal_id: binding.agentPrincipalId,
      });
    },

    delete(acpWorkspaceRoot: string) {
      const info = del.run(acpWorkspaceRoot);
      return Number(info.changes) > 0;
    },

    list() {
      const rows = selectAll.all() as {
        acp_workspace_root: string;
        shoggoth_session_id: string;
        agent_principal_id: string;
      }[];
      return rows.map(rowToBinding);
    },
  };
}
