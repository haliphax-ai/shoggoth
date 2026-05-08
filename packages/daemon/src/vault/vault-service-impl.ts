/**
 * Vault Service Implementation - Secure credential storage using age encryption.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { AgeIdentity } from "./age-crypto";
import { ageGenerateIdentity, ageLoadIdentity, ageEncrypt, ageDecrypt } from "./age-crypto";
import type { VaultService, VaultListEntry, VaultEntryMetadata } from "./vault-service";

const SCOPE_VALIDATOR = /^(global|agent:[a-zA-Z0-9_-]+)$/;

function validateScope(scope: string): void {
  if (!SCOPE_VALIDATOR.test(scope)) {
    throw new Error(`Invalid scope: ${scope}`);
  }
}

/**
 * Create the vault service. Loads or generates the age identity,
 * then returns the service bound to the given database.
 */
export async function createVaultService(
  db: Database.Database,
  identityPath: string,
  secretsDir: string,
): Promise<VaultService> {
  // Determine the identity source: secretsDir/vault_age_key, identityPath, or generate new
  let identity: AgeIdentity;

  // Check secrets directory first
  const secretsKeyPath = join(secretsDir, "vault_age_key");
  if (existsSync(secretsKeyPath)) {
    identity = await ageLoadIdentity(secretsKeyPath);
  } else if (existsSync(identityPath)) {
    identity = await ageLoadIdentity(identityPath);
  } else {
    // Auto-generate new identity
    identity = await ageGenerateIdentity();
    writeFileSync(identityPath, identity.identityString, "utf8");
  }

  // Run the vault_secrets migration
  const migrationPath = join(process.cwd(), "migrations", "0014_vault_secrets.sql");
  if (existsSync(migrationPath)) {
    const migrationSql = readFileSync(migrationPath, "utf8");
    db.exec(migrationSql);
  }

  // Create the vault service instance
  const vault: VaultService = {
    async put(
      scope: string,
      name: string,
      plaintext: string,
      metadata?: VaultEntryMetadata,
    ): Promise<void> {
      validateScope(scope);

      const ciphertext = await ageEncrypt(plaintext, identity.recipient);
      const metadataJson = metadata ? JSON.stringify(metadata) : null;

      db.prepare(`
        INSERT OR REPLACE INTO vault_secrets (scope, name, ciphertext, metadata, created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      `).run(scope, name, ciphertext, metadataJson);
    },

    async get(scope: string, name: string): Promise<string | null> {
      validateScope(scope);

      const row = db
        .prepare(`
        SELECT ciphertext FROM vault_secrets WHERE scope = ? AND name = ?
      `)
        .get(scope, name) as { ciphertext: string } | undefined;

      if (!row) {
        return null;
      }

      return await ageDecrypt(row.ciphertext, identity);
    },

    async resolve(agentId: string, name: string): Promise<string | null> {
      // Try agent-scoped first
      const agentScope = `agent:${agentId}`;
      const agentResult = await vault.get(agentScope, name);
      if (agentResult !== null) {
        return agentResult;
      }

      // Fall back to global
      return await vault.get("global", name);
    },

    async delete(scope: string, name: string): Promise<boolean> {
      validateScope(scope);

      const result = db
        .prepare(`
        DELETE FROM vault_secrets WHERE scope = ? AND name = ?
      `)
        .run(scope, name);

      return result.changes > 0;
    },

    list(scope: string): VaultListEntry[] {
      validateScope(scope);

      const rows = db
        .prepare(`
        SELECT name, scope, metadata, created_at, updated_at
        FROM vault_secrets
        WHERE scope = ?
        ORDER BY name ASC
      `)
        .all(scope) as Array<{
        name: string;
        scope: string;
        metadata: string | null;
        created_at: string;
        updated_at: string;
      }>;

      return rows.map((row) => ({
        name: row.name,
        scope: row.scope,
        metadata: row.metadata ? JSON.parse(row.metadata) : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    listScopes(): string[] {
      const rows = db
        .prepare(`
        SELECT DISTINCT scope FROM vault_secrets ORDER BY scope ASC
      `)
        .all() as Array<{ scope: string }>;

      return rows.map((row) => row.scope);
    },

    async rotateKey(newIdentity: AgeIdentity): Promise<void> {
      // Get all current entries
      const rows = db
        .prepare(`
        SELECT scope, name, ciphertext, metadata FROM vault_secrets
      `)
        .all() as Array<{
        scope: string;
        name: string;
        ciphertext: string;
        metadata: string | null;
      }>;

      // Decrypt all entries with old identity and re-encrypt with new identity
      // Do this outside the transaction since it's async
      const reEncrypted: Array<{ scope: string; name: string; ciphertext: string }> = [];

      for (const row of rows) {
        const plaintext = await ageDecrypt(row.ciphertext, identity);
        const newCiphertext = await ageEncrypt(plaintext, newIdentity.recipient);
        reEncrypted.push({ scope: row.scope, name: row.name, ciphertext: newCiphertext });
      }

      // Now do the DB updates in a synchronous transaction
      const updateTransaction = db.transaction(() => {
        for (const entry of reEncrypted) {
          db.prepare(`
            UPDATE vault_secrets SET ciphertext = ?, updated_at = datetime('now')
            WHERE scope = ? AND name = ?
          `).run(entry.ciphertext, entry.scope, entry.name);
        }
      });

      updateTransaction();

      // Update the identity for future operations
      identity = newIdentity;
    },

    get publicKey(): string {
      return identity.recipient;
    },
  };

  return vault;
}
