-- Vault encrypted credential store
CREATE TABLE IF NOT EXISTS vault_secrets (
  scope       TEXT NOT NULL,
  name        TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  metadata    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, name)
);
CREATE INDEX IF NOT EXISTS idx_vault_secrets_scope ON vault_secrets(scope);