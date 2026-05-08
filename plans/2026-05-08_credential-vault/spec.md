# Specification

## Interfaces

### VaultService

```ts
/** Core vault service — instantiated once at daemon boot. */
export interface VaultService {
  /**
   * Store a credential. Encrypts the plaintext with the loaded age recipient
   * and writes the ciphertext to the vault_secrets table.
   */
  put(scope: string, name: string, plaintext: string, metadata?: VaultEntryMetadata): void;

  /**
   * Retrieve a credential by exact scope + name. Returns null if not found.
   * Decrypts on-demand — plaintext is never cached.
   */
  get(scope: string, name: string): string | null;

  /**
   * Resolve a credential by name using scope precedence for an agent.
   * Checks agent:<agentId> first, then global. Returns null if not found in either.
   */
  resolve(agentId: string, name: string): string | null;

  /** Delete a credential. Returns true if it existed. */
  delete(scope: string, name: string): boolean;

  /** List credential names (no values) in a scope. */
  list(scope: string): VaultListEntry[];

  /** List all scopes that have at least one entry. */
  listScopes(): string[];

  /**
   * Create a short-lived FIFO for a credential. The daemon writes the secret
   * to the FIFO when a reader opens it, then unlinks the file.
   * Returns the absolute path to the FIFO.
   */
  injectFifo(agentId: string, name: string, agentUid: number, agentGid: number): Promise<string>;

  /**
   * Re-encrypt all entries with a new age identity. The old identity is used
   * to decrypt, the new identity encrypts. Atomic (transaction).
   */
  rotateKey(newIdentity: AgeIdentity): void;

  /** The public key (recipient) of the currently loaded identity. */
  readonly publicKey: string;
}
```

### VaultEntryMetadata

```ts
/** Optional metadata stored alongside a vault entry (JSON in the metadata column). */
export interface VaultEntryMetadata {
  /** Human-readable description of what this credential is for. */
  description?: string;
  /** ISO 8601 timestamp — informational, not enforced in this plan. */
  expiresAt?: string;
}
```

### VaultListEntry

```ts
/** Returned by vault list operations — never includes the secret value. */
export interface VaultListEntry {
  name: string;
  scope: string;
  metadata: VaultEntryMetadata | null;
  createdAt: string;
  updatedAt: string;
}
```

### AgeIdentity

```ts
/** Represents a loaded age X25519 identity (private key) and its derived recipient (public key). */
export interface AgeIdentity {
  /** The raw identity string (AGE-SECRET-KEY-1...). */
  readonly identityString: string;
  /** The derived recipient/public key (age1...). */
  readonly recipient: string;
}
```

### VaultToolContext

```ts
/**
 * Context passed to the builtin-vault tool handler.
 * Extends BuiltinToolContext with vault-specific fields.
 */
export interface VaultToolContext {
  /** The vault service instance. */
  vault: VaultService;
  /** The resolved root agent ID for this session (subagents inherit parent). */
  agentId: string;
  /** Agent UID for FIFO creation. */
  agentUid: number;
  /** Agent GID for FIFO creation. */
  agentGid: number;
}
```

## API / Function Signatures

### Vault Service Factory

```ts
/**
 * Create the vault service. Loads or generates the age identity,
 * then returns the service bound to the given database.
 *
 * @param db - The state database (better-sqlite3 instance).
 * @param identityPath - Path to the age identity file (read or create).
 * @param secretsDir - Docker secrets directory to check first (e.g. /run/secrets).
 */
export function createVaultService(
  db: BetterSqlite3.Database,
  identityPath: string,
  secretsDir: string,
): VaultService;
```

### Age Encryption Helpers

```ts
/**
 * Encrypt a plaintext string to an age-armored ciphertext string.
 * Uses the recipient (public key) for encryption.
 */
export function ageEncrypt(plaintext: string, recipient: string): string;

/**
 * Decrypt an age-armored ciphertext string back to plaintext.
 * Uses the identity (private key) for decryption.
 */
export function ageDecrypt(ciphertext: string, identity: AgeIdentity): string;

/**
 * Generate a new age X25519 identity (keypair).
 */
export function ageGenerateIdentity(): AgeIdentity;

/**
 * Load an age identity from a file. The file contains one line:
 * AGE-SECRET-KEY-1...
 * Comments (lines starting with #) and blank lines are ignored.
 */
export function ageLoadIdentity(filePath: string): AgeIdentity;
```

### FIFO Proxy

```ts
/**
 * Create a FIFO (named pipe) and return its path. Spawns a background
 * task that writes the secret on first reader open, then unlinks.
 *
 * @param secret - The plaintext to write.
 * @param uid - Owner UID for the FIFO.
 * @param gid - Owner GID for the FIFO.
 * @param timeoutMs - Auto-cleanup timeout (default 30000).
 * @returns Absolute path to the FIFO.
 */
export function createSecretFifo(
  secret: string,
  uid: number,
  gid: number,
  timeoutMs?: number,
): Promise<string>;
```

### Bulk Import Parser

```ts
/**
 * Parse a .env-style file into key-value pairs.
 * - Lines starting with # are comments (ignored).
 * - Blank lines are ignored.
 * - Format: KEY=VALUE (first = splits key from value).
 * - Values may be optionally quoted (single or double quotes stripped).
 * - No variable interpolation.
 */
export function parseEnvFile(content: string): Array<{ key: string; value: string }>;
```

### Resolve Root Agent ID

```ts
/**
 * Resolve the root agent ID from a session URN. For subagent sessions,
 * this returns the same agent ID as the parent (since subagent URNs
 * share the agentId segment with their parent).
 *
 * This is inherent in the URN structure — `parseAgentSessionUrn` already
 * returns the agentId from the URN prefix, which is the same for parent
 * and child sessions.
 */
export function resolveVaultAgentId(sessionId: string): string | null;
// Implementation: return parseAgentSessionUrn(sessionId)?.agentId ?? null;
```

### Control Plane Operations

```ts
/** Control op: vault.set */
export interface VaultSetOp {
  kind: "vault.set";
  scope: string;
  name: string;
  value: string;
  metadata?: VaultEntryMetadata;
}

/** Control op: vault.get */
export interface VaultGetOp {
  kind: "vault.get";
  scope: string;
  name: string;
}

/** Control op: vault.delete */
export interface VaultDeleteOp {
  kind: "vault.delete";
  scope: string;
  name: string;
}

/** Control op: vault.list */
export interface VaultListOp {
  kind: "vault.list";
  scope?: string; // omit for all scopes
}

/** Control op: vault.import */
export interface VaultImportOp {
  kind: "vault.import";
  scope: string;
  /** Raw content of the .env file (read by CLI before sending). */
  envFileContent: string;
}

/** Control op: vault.rotate-key */
export interface VaultRotateKeyOp {
  kind: "vault.rotate-key";
  /** Path to the new identity file. */
  newIdentityPath: string;
}
```

## Data Structures / Schemas

### SQLite Migration

```sql
-- vault_secrets: encrypted credential store
CREATE TABLE IF NOT EXISTS vault_secrets (
  scope       TEXT NOT NULL,
  name        TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  metadata    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, name)
);

-- Index for listing by scope
CREATE INDEX IF NOT EXISTS idx_vault_secrets_scope ON vault_secrets(scope);
```

### Builtin Tool Descriptor

```jsonc
{
  "name": "builtin-vault",
  "description": "Secure credential store. Retrieve, store, or inject secrets without exposing them in files or environment variables.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "description": "Operation to perform.",
        "enum": ["get", "set", "delete", "list", "inject"],
        "type": "string",
      },
      "name": {
        "description": "Credential name. Required for get, set, delete, inject.",
        "type": "string",
      },
      "value": {
        "description": "Credential value. Required for set.",
        "type": "string",
      },
      "description": {
        "description": "Optional human-readable description (set only).",
        "type": "string",
      },
    },
    "required": ["action"],
  },
}
```

### MCP Vault Reference Syntax

```yaml
# In mcp.servers[].env values:
# $vault:<name> — resolved at connect time using the connecting agent's scope precedence.
env:
  GITHUB_TOKEN: "$vault:GITHUB_TOKEN"
  API_SECRET: "$vault:MY_SERVICE_KEY"
```

### Config Schema Addition

```ts
// No new top-level config fields required.
// The vault key path is determined by convention:
//   1. /run/secrets/vault_age_key (Docker secret)
//   2. /var/lib/shoggoth/daemon/vault.key (auto-generated)
//
// Future: optional config field to override the key path.
```

## Code Examples

### Operator CLI Usage

```bash
# Store a global credential
shoggoth vault set GITHUB_TOKEN --scope global --value "ghp_abc123"

# Store from a file (avoids shell history exposure)
shoggoth vault set DATABASE_URL --scope global --file ./db-url.txt

# Store an agent-specific override
shoggoth vault set GITHUB_TOKEN --scope agent:developer --value "ghp_dev456"

# List all credentials (names only)
shoggoth vault list
# scope          name            description       updated
# global         GITHUB_TOKEN    GitHub PAT        2026-05-08T05:00:00Z
# global         DATABASE_URL    Production DB     2026-05-08T05:00:00Z
# agent:developer GITHUB_TOKEN   Dev-specific PAT  2026-05-08T05:01:00Z

# Retrieve a credential value
shoggoth vault get GITHUB_TOKEN --scope global
# ghp_abc123

# Delete a credential
shoggoth vault delete GITHUB_TOKEN --scope agent:developer

# Bulk import from .env file
shoggoth vault import --file ./production.env --scope global

# Rotate the encryption key
shoggoth vault rotate-key --new-key /path/to/new-identity.key
```

### Agent Tool Usage

```ts
// Agent calls builtin-vault get — returns plaintext in tool result
// The vault resolves: agent:developer scope first, then global
{ action: "get", name: "GITHUB_TOKEN" }
// → { ok: true, name: "GITHUB_TOKEN", value: "ghp_dev456", scope: "agent:developer" }

// Agent stores a credential (always in their own agent scope)
{ action: "set", name: "OAUTH_TOKEN", value: "bearer_xyz", description: "OAuth refresh token" }
// → { ok: true, name: "OAUTH_TOKEN", scope: "agent:developer", written: true }

// Agent lists accessible credentials (own scope + global, names only)
{ action: "list" }
// → { ok: true, entries: [
//     { name: "GITHUB_TOKEN", scope: "agent:developer", ... },
//     { name: "GITHUB_TOKEN", scope: "global", ... },
//     { name: "DATABASE_URL", scope: "global", ... },
//     { name: "OAUTH_TOKEN", scope: "agent:developer", ... }
//   ]}

// Agent injects a credential as a FIFO for shell use
{ action: "inject", name: "GITHUB_TOKEN" }
// → { ok: true, path: "/tmp/.vault/a1b2c3d4", name: "GITHUB_TOKEN",
//     hint: "Use this path in your command. The file will be consumed on first read." }
```

### FIFO Usage in Shell Command

```bash
# Agent receives path "/tmp/.vault/a1b2c3d4" from vault inject
# Then uses it in an exec call:
git -c credential.helper='!f() { echo "password=$(cat /tmp/.vault/a1b2c3d4)"; }; f' push origin main
```

### MCP Server with Vault Credentials

```yaml
mcp:
  servers:
    - id: "github-mcp"
      transport: stdio
      command: "github-mcp-server"
      env:
        GITHUB_TOKEN: "$vault:GITHUB_TOKEN"
        # Daemon resolves this at spawn time:
        # 1. Check agent:<connecting-agent-id> scope
        # 2. Fall back to global scope
        # 3. If not found, omit the env var (or error)
```
