-- ACP / acpx: persist workspace root → Shoggoth session + agent principal.

CREATE TABLE acpx_workspace_bindings (
  acp_workspace_root TEXT PRIMARY KEY NOT NULL,
  shoggoth_session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  agent_principal_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_acpx_bindings_session ON acpx_workspace_bindings (shoggoth_session_id);
