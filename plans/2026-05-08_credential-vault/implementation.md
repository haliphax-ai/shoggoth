# Implementation

## Phase 1: Age Encryption Module

Introduce a pure-TypeScript age encryption/decryption module (or thin wrapper around the `age` CLI) that the vault service will use. This phase is independently testable with no daemon integration.

- Implement `ageGenerateIdentity()` — generate a new X25519 keypair, return `AgeIdentity`
- Implement `ageLoadIdentity(filePath)` — parse an age identity file (skip comments/blanks)
- Implement `ageEncrypt(plaintext, recipient)` — encrypt to armored ciphertext
- Implement `ageDecrypt(ciphertext, identity)` — decrypt armored ciphertext to plaintext
- Evaluate `age-encryption` npm package for pure-JS implementation; fall back to shelling out to the `age` CLI if no suitable library exists
- Unit tests: generate → encrypt → decrypt round-trip, load identity from file, error cases (bad key, corrupted ciphertext)

**Files:**

- `packages/daemon/src/vault/age-crypto.ts`
- `packages/daemon/test/vault/age-crypto.test.ts`

## Phase 2: Database Migration & Vault Service Core

Add the `vault_secrets` table and implement the core `VaultService` (put, get, resolve, delete, list) backed by SQLite.

- Add migration `0014_vault_secrets.sql` with the table and index
- Implement `createVaultService(db, identityPath, secretsDir)` factory:
  - Key loading priority: Docker secret → daemon file → auto-generate
  - Log public key at startup
- Implement `put(scope, name, plaintext, metadata?)` — encrypt + upsert
- Implement `get(scope, name)` — select + decrypt, return null if missing
- Implement `resolve(agentId, name)` — check `agent:<agentId>` then `global`
- Implement `delete(scope, name)` — delete row, return boolean
- Implement `list(scope)` — return names + metadata (no values)
- Implement `listScopes()` — distinct scopes
- Implement `rotateKey(newIdentity)` — transaction: decrypt all with old, re-encrypt with new, update rows
- Validate scope format on write (`global` or `agent:<validAgentId>`)
- Unit tests: CRUD operations, scope precedence, rotate-key, invalid scope rejection

**Files:**

- `migrations/0014_vault_secrets.sql`
- `packages/daemon/src/vault/vault-service.ts`
- `packages/daemon/src/vault/index.ts`
- `packages/daemon/test/vault/vault-service.test.ts`

## Phase 3: Builtin Vault Tool

Add the `builtin-vault` tool handler so agents can get/set/delete/list credentials through the tool loop.

- Register `builtin-vault` in the builtin tool registry
- Implement action dispatch: `get`, `set`, `delete`, `list`
- Resolve root agent ID from session URN (subagents inherit parent via `parseAgentSessionUrn`)
- Scope enforcement:
  - `get` / `list`: agent can read own scope + global
  - `set`: agent writes only to own scope (`agent:<agentId>`)
  - `delete`: agent can delete only from own scope
- Add tool descriptor to the tool discovery catalog
- Add HITL risk classification: `builtin-vault` → `caution`
- Audit log every vault access (name + action, never value)
- Unit tests: all actions, scope enforcement, subagent inherits parent, error cases
- Integration test: tool invocation through the tool loop

**Files:**

- `packages/daemon/src/sessions/builtin-handlers/vault-handler.ts`
- `packages/daemon/src/sessions/builtin-handlers/index.ts` (register)
- `packages/daemon/src/sessions/builtin-tool-registry.ts` (descriptor)
- `packages/daemon/test/sessions/builtin-handlers/vault-handler.test.ts`

## Phase 4: FIFO Credential Proxy

Implement the `inject` action for the vault tool — creates a short-lived named pipe that delivers the secret to a subprocess without env injection.

- Implement `createSecretFifo(secret, uid, gid, timeoutMs)`:
  - Create `/tmp/.vault/` directory if missing (0711 root)
  - Generate random filename
  - Create FIFO via `mkfifo` (shell out or use native bindings)
  - `chown` to agent UID/GID, `chmod` 0600
  - Spawn background task: open FIFO for writing, write secret, close, unlink
  - Set timeout to unlink if no reader connects within `timeoutMs` (default 30s)
- Add `inject` action to the vault tool handler:
  - Resolve credential via `vault.resolve(agentId, name)`
  - Call `createSecretFifo` with the plaintext and agent creds
  - Return the path + usage hint to the agent
- Unit tests: FIFO creation, permissions, read-and-unlink, timeout cleanup
- Integration test: agent calls inject, then exec reads from the FIFO path

**Files:**

- `packages/daemon/src/vault/fifo-proxy.ts`
- `packages/daemon/src/sessions/builtin-handlers/vault-handler.ts` (extend)
- `packages/daemon/test/vault/fifo-proxy.test.ts`
- `packages/daemon/test/sessions/builtin-handlers/vault-inject.test.ts`

## Phase 5: Control Plane Operations & CLI

Add operator-facing vault commands over the control socket, including bulk import.

- Add control ops: `vault.set`, `vault.get`, `vault.delete`, `vault.list`, `vault.import`, `vault.rotate-key`
- Implement handlers in the control plane that delegate to `VaultService`
- Operator can specify any scope (global or agent-specific)
- Implement `parseEnvFile(content)` for bulk import:
  - Skip comments (`#`) and blank lines
  - Split on first `=`
  - Strip optional surrounding quotes from values
- Implement `vault.import` handler: parse env content, call `put` for each entry
- Implement `vault.rotate-key` handler: load new identity from path, call `rotateKey`
- Add CLI commands in `packages/cli`:
  - `shoggoth vault set <name> [--scope <scope>] [--value <val> | --file <path>]`
  - `shoggoth vault get <name> [--scope <scope>]`
  - `shoggoth vault delete <name> [--scope <scope>]`
  - `shoggoth vault list [--scope <scope>]`
  - `shoggoth vault import --file <path> [--scope <scope>]`
  - `shoggoth vault rotate-key --new-key <path>`
- CLI reads `--file` content locally before sending to control socket (avoids path resolution issues)
- Unit tests: parseEnvFile edge cases, control op handlers
- Integration tests: CLI → control socket → vault service round-trip

**Files:**

- `packages/daemon/src/control/vault-ops.ts`
- `packages/daemon/src/vault/env-parser.ts`
- `packages/daemon/test/vault/env-parser.test.ts`
- `packages/daemon/test/control/vault-ops.test.ts`
- `packages/cli/src/commands/vault.ts`
- `packages/cli/test/vault-cli.test.ts`

## Phase 6: MCP Vault Reference Resolution

Enable MCP server env vars to reference vault credentials via the `$vault:` prefix, resolved at connection time.

- In `connectShoggothMcpServers`, before spawning/connecting a server, scan its `env` map for values matching `$vault:<name>`
- For each match, resolve the credential using the connecting agent's scope precedence
- Replace the `$vault:` reference with the plaintext value in the env passed to the subprocess
- If a referenced credential is not found, log a warning and omit the env var (do not fail the connection)
- Thread the agent ID through the MCP connect path (already available from Phase 3 of the per-agent-mcp-pool-scope plan)
- Unit tests: env substitution with vault refs, missing credential handling, mixed plain + vault env vars
- Integration test: MCP server spawned with resolved vault credential in its environment

**Files:**

- `packages/daemon/src/mcp/mcp-server-pool.ts` (extend `connectShoggothMcpServers`)
- `packages/daemon/src/mcp/vault-env-resolve.ts`
- `packages/daemon/test/mcp/vault-env-resolve.test.ts`

## Phase 7: Daemon Bootstrap & Documentation

Wire the vault service into the daemon boot sequence and add documentation.

- Instantiate `VaultService` in `src/index.ts` after DB migration, before control plane
- Pass vault instance to control plane and session runtime
- Add vault public key to health/status output
- Ensure vault key file permissions are enforced in `docker/entrypoint.sh` (0600 shoggoth for daemon dir)
- Add `docs/vault.md` covering:
  - Architecture overview
  - Key management (Docker secret vs auto-generated)
  - Operator CLI reference
  - Agent tool reference
  - MCP integration
  - Security model
  - Bulk import format
- Add `builtin-vault` to `docs/tools/builtin-vault.md`
- Update `docs/daemon.md` key tables section with `vault_secrets`
- Verify full test suite passes

**Files:**

- `packages/daemon/src/index.ts` (boot wiring)
- `packages/daemon/src/runtime.ts` (add vault to DaemonRuntime if needed)
- `docker/entrypoint.sh` (vault key permissions)
- `docs/vault.md`
- `docs/tools/builtin-vault.md`
- `docs/daemon.md` (update)
