---
date: 2026-05-08
completed: never
---

# Credential Vault

## Summary

Add an encrypted credential store to Shoggoth so operators and agents can safely store, retrieve, and use secrets (API keys, tokens, passwords) without exposing them at rest in config files, the state DB, markdown, or subprocess environment variables.

## Motivation

Today, credentials in Shoggoth are either:

1. **Operator-managed** — injected via Docker secrets (`/run/secrets`), environment variables, or config JSON fields (`apiKey`, `apiKeyEnv`). These are plaintext on disk or in memory, protected only by filesystem permissions.
2. **Agent-managed** — stored in workspace files or the KV store. These are plaintext in SQLite or on the agent's filesystem.

Neither approach provides encryption at rest. If the state DB file, a volume backup, or a workspace file is exfiltrated, all credentials are exposed in cleartext.

Additionally, there is no mechanism for an agent to use a credential in a shell command without it appearing in the process environment (visible via `/proc/<pid>/environ`) or being passed as a CLI argument (visible via `ps`).

This plan introduces a vault service that:

- Encrypts all stored credentials with `age` (X25519 + ChaCha20-Poly1305)
- Decrypts on-demand in daemon memory — never writes plaintext to disk
- Provides scoped access (global, per-agent) with precedence resolution
- Offers a FIFO-based credential proxy so shell commands can consume secrets without env injection
- Treats subagents as their parent agent for vault access (same scope, same credentials)
- Supports operator bulk-loading of credentials from `.env`-style files

## Design

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Daemon (shoggoth UID 1000)                                   │
│                                                              │
│  Boot: load age identity from /run/secrets/vault_age_key     │
│         or /var/lib/shoggoth/daemon/vault.key (auto-gen)     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ VaultService                                           │  │
│  │  - put(scope, name, plaintext) → encrypt + store       │  │
│  │  - get(scope, name) → decrypt from DB                  │  │
│  │  - delete(scope, name)                                 │  │
│  │  - list(scope) → names + metadata (no values)          │  │
│  │  - resolve(agentId, name) → precedence lookup          │  │
│  │  - injectFifo(agentId, name) → short-lived file path   │  │
│  └────────────────────────────────────────────────────────┘  │
│         ▲                         ▲                          │
│         │                         │                          │
│  Control Plane (CLI)        Agent Tool Handler               │
│  - vault set/get/delete     - builtin-vault                  │
│  - vault list               - builtin-vault-inject           │
│  - vault import                                              │
└──────────────────────────────────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│ SQLite: vault_secrets table                                  │
│  scope TEXT, name TEXT, ciphertext TEXT, metadata TEXT        │
│  PRIMARY KEY (scope, name)                                   │
│  — ciphertext is age-armored (ASCII-safe base64)             │
│  — metadata is JSON: { description?, createdAt, updatedAt }  │
└──────────────────────────────────────────────────────────────┘
```

### Scope Model

| Scope     | Format            | Who can write               | Who can read           |
| --------- | ----------------- | --------------------------- | ---------------------- |
| `global`  | `global`          | Operator (CLI)              | All agents (read-only) |
| Per-agent | `agent:<agentId>` | Operator (CLI) + that agent | That agent only        |

### Precedence Resolution

When an agent requests a credential by name, the vault resolves with this precedence:

1. `agent:<agentId>` — most specific, wins if present
2. `global` — fallback

This allows operators to set a shared default and override per-agent where needed.

### Subagent Identity

Subagents are treated as their parent agent for all vault operations. The vault resolves the **root agent ID** from the session URN:

- Top-level session `agent:developer:discord:channel:123` → agent ID `developer`
- Subagent session `agent:developer:discord:channel:123:uuid` → agent ID `developer`

Both resolve to the same vault scope (`agent:developer`). A subagent cannot access a different agent's credentials, and credentials stored by a subagent are stored under the parent agent's scope.

### Credential Proxy (FIFO)

For shell commands that need a credential without env injection:

1. Agent calls `builtin-vault inject <name>` → daemon creates a FIFO at a random path under `/tmp/.vault/`
2. Daemon returns the FIFO path to the agent
3. Agent uses the path in a command (e.g., `curl -H @/tmp/.vault/abc123`)
4. Daemon writes the secret to the FIFO when the reading process opens it, then unlinks the file
5. A 30-second timeout auto-cleans abandoned FIFOs

The FIFO is created with mode `0600` owned by the agent UID/GID, so only the agent's subprocess can read it. The daemon writes to it from its privileged context.

### Key Management

The age identity (private key) is loaded at daemon boot:

1. If `/run/secrets/vault_age_key` exists → use it (operator-provided Docker secret)
2. Else if `/var/lib/shoggoth/daemon/vault.key` exists → use it (previously auto-generated)
3. Else → generate a new age X25519 identity, write to `/var/lib/shoggoth/daemon/vault.key` (0600 shoggoth)

The public key (recipient) is derived from the identity and logged at startup so operators can verify which key is active.

### Bulk Import

The CLI supports importing credentials from a `.env`-style file:

```
shoggoth vault import --file /path/to/secrets.env --scope global
```

File format:

```
# Comments and blank lines are ignored
GITHUB_TOKEN=ghp_abc123
OPENAI_API_KEY=sk-xyz789
DATABASE_URL=postgres://user:pass@host/db
```

Each line becomes a vault entry. Existing entries with the same scope+name are overwritten.

### Integration with MCP

MCP server configurations can reference vault credentials by name. The daemon resolves them at connection time:

```yaml
mcp:
  servers:
    - id: "github-mcp"
      transport: stdio
      command: "github-mcp-server"
      env:
        GITHUB_TOKEN: "$vault:GITHUB_TOKEN" # resolved by daemon before spawn
```

The `$vault:` prefix signals the daemon to resolve the value from the vault (using the connecting agent's scope precedence) before injecting it into the MCP server's environment. This keeps the credential out of config files while still making it available to MCP servers that expect env-based configuration.

## Testing Strategy

- Unit tests for the vault service: encrypt/decrypt round-trip, scope precedence, subagent resolution, list filtering, metadata handling
- Unit tests for the FIFO proxy: creation, read-and-unlink lifecycle, timeout cleanup, permission enforcement
- Unit tests for the bulk import parser: comment handling, empty lines, quoted values, edge cases
- Integration tests for the `builtin-vault` tool handler: get/set/delete/list/inject operations, scope enforcement, error cases
- Integration tests for MCP `$vault:` resolution: env substitution at connect time
- Control plane tests for CLI vault operations: set, get, delete, list, import
- Security tests: agent cannot access another agent's scope, subagent inherits parent scope, FIFO permissions are correct

## Considerations

- **Single point of trust**: The daemon process holds the decryption key in memory. If the daemon is compromised, all secrets are accessible. This is acceptable for a self-hosted single-node system — the same trust boundary exists for any secret manager running on the same host.
- **No HSM/KMS integration**: The age identity is a file on disk (or in a Docker secret). For production deployments needing hardware-backed keys, a future enhancement could add KMS envelope encryption. Deferred.
- **Model context exposure**: When an agent calls `vault get`, the plaintext appears in the tool result and enters the model's context window. The FIFO proxy (`vault inject`) avoids this for shell commands, but there's no way to completely hide a secret from the model if the model needs to use it programmatically. This is an inherent limitation of LLM-based agents.
- **Key rotation**: Re-encrypting all entries with a new key requires reading and re-writing every row. The `vault rotate-key` CLI command handles this, but it's an O(n) operation that briefly holds all plaintext in memory. Acceptable for typical credential counts (< 1000).
- **Audit logging**: Every vault access (read, write, delete) should be logged to the existing `audit_log` table with the accessor's identity and the secret name (never the value).
- **TTL/expiry**: Deferred to a future enhancement. The `metadata` JSON field reserves space for `expiresAt` but the vault service does not enforce it in this plan.

## Migration

New `vault_secrets` table added via a numbered migration. No existing data is affected.

Operators using env-based secrets (`apiKeyEnv` in model provider config) can continue doing so — the vault is additive, not a replacement for existing mechanisms. Over time, operators may choose to migrate env-based secrets into the vault for at-rest encryption.

## References

- [`spec.md`](spec.md) — type signatures, interfaces, and code examples
- [`implementation.md`](implementation.md) — phased implementation steps
