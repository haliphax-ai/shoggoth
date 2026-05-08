# Credential Vault

The credential vault provides encrypted secret storage for Shoggoth agents and operators. Secrets are encrypted at rest using [age](https://age-encryption.org/) (X25519) and stored in the daemon's SQLite state database.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Operator CLI / Control Plane                    │
│  vault.set / vault.get / vault.import            │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│  VaultService                                    │
│  - Scope-based access (global / agent:<id>)      │
│  - Encrypt/decrypt via age                       │
│  - Key rotation support                          │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│  vault_secrets table (SQLite)                    │
│  - scope, name, ciphertext, metadata             │
│  - Encrypted with daemon's age identity          │
└─────────────────────────────────────────────────┘
```

## Key Management

The vault uses an age X25519 identity for encryption. On first boot, the daemon:

1. Checks `/run/secrets/vault_age_key` (Docker secrets mount)
2. Falls back to `/var/lib/shoggoth/daemon/vault.key`
3. Auto-generates a new identity if neither exists

The key file is chmod 0600 and owned by the shoggoth user.

### Key Rotation

```bash
shoggoth vault rotate-key --new-identity /path/to/new.key
```

This re-encrypts all stored secrets with the new identity in a single transaction.

## Scopes

Secrets are organized by scope:

- `global` — accessible to all agents (read-only for agents)
- `agent:<agentId>` — private to a specific agent

Agents can read from their own scope and global. They can only write/delete in their own scope.

## Operator CLI Reference

### Set a secret

```bash
shoggoth vault set --scope global --name API_KEY --value "sk-..."
shoggoth vault set --scope agent:developer --name DB_PASSWORD --value "hunter2"
```

### Get a secret

```bash
shoggoth vault get --scope global --name API_KEY
```

### Delete a secret

```bash
shoggoth vault delete --scope agent:developer --name DB_PASSWORD
```

### List secrets

```bash
shoggoth vault list                          # all scopes
shoggoth vault list --scope global           # specific scope
```

### Bulk import from .env file

```bash
shoggoth vault import --scope global --file secrets.env
```

The `.env` format supports:

- `KEY=VALUE` lines
- Comments (`#`)
- Blank lines (skipped)
- Quoted values (single or double quotes stripped)
- Values containing `=` (split on first `=` only)
- No variable interpolation

### Rotate key

```bash
shoggoth vault rotate-key --new-identity /path/to/new.key
```

## Agent Tool Reference

Agents access the vault via the `builtin-vault` tool:

```json
{ "action": "get", "name": "API_KEY" }
{ "action": "set", "name": "MY_TOKEN", "value": "secret123" }
{ "action": "delete", "name": "MY_TOKEN" }
{ "action": "list" }
{ "action": "inject", "name": "API_KEY" }
```

The `inject` action creates a one-time-read FIFO at `/tmp/.vault/<random>` that delivers the secret on first read, then self-destructs. This avoids exposing secrets in command arguments or environment variables.

### Scope enforcement

- `get`: resolves agent scope first, then global fallback
- `set`: always writes to `agent:<agentId>`
- `delete`: only deletes from `agent:<agentId>`
- `list`: returns entries from both agent and global scopes
- `inject`: resolves like `get`, returns a FIFO path

### Audit redaction

The `value` field is automatically redacted from audit logs for `builtin-vault` calls.

## MCP Integration

MCP server environment variables can reference vault secrets using the `$vault:NAME` syntax:

```yaml
mcp:
  servers:
    - id: my-api
      transport: stdio
      command: node
      args: ["server.js"]
      env:
        API_KEY: "$vault:API_KEY"
        PLAIN_VAR: "not-a-secret"
```

When the MCP server is spawned, `$vault:API_KEY` is resolved using the connecting agent's scope precedence. If the credential is not found, the env var is omitted (the server still starts).

## Security Model

- Secrets are encrypted at rest with age (X25519, authenticated encryption)
- The vault key file has restrictive permissions (0600, shoggoth user)
- Agents cannot read other agents' scoped secrets
- Agents cannot write to global scope (operator-only)
- The `value` field is redacted from audit logs
- FIFO injection avoids secrets in process arguments or env
- FIFOs auto-cleanup after read or timeout (30s default)

## Database Schema

```sql
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
```
