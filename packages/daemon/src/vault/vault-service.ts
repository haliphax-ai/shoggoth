/**
 * Vault Service - Secure credential storage using age encryption.
 */

import type { AgeIdentity } from "./age-crypto";

export interface VaultEntryMetadata {
  /** ISO 8601 timestamp — informational, not enforced in this plan. */
  expiresAt?: string;
}

export interface VaultListEntry {
  name: string;
  scope: string;
  metadata: VaultEntryMetadata | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Core vault service — instantiated once at daemon boot.
 */
export interface VaultService {
  /**
   * Store a credential. Encrypts the plaintext with the loaded age recipient
   * and writes the ciphertext to the vault_secrets table.
   */
  put(scope: string, name: string, plaintext: string, metadata?: VaultEntryMetadata): Promise<void>;

  /**
   * Retrieve a credential by exact scope + name. Returns null if not found.
   * Decrypts on-demand — plaintext is never cached.
   */
  get(scope: string, name: string): Promise<string | null>;

  /**
   * Resolve a credential by name using scope precedence for an agent.
   * Checks agent:<agentId> first, then global. Returns null if not found in either.
   */
  resolve(agentId: string, name: string): Promise<string | null>;

  /** Delete a credential. Returns true if it existed. */
  delete(scope: string, name: string): Promise<boolean>;

  /** List credential names (no values) in a scope. */
  list(scope: string): VaultListEntry[];

  /** List all scopes that have at least one entry. */
  listScopes(): string[];

  /**
   * Re-encrypt all entries with a new age identity. The old identity is used
   * to decrypt, the new identity encrypts. Atomic (transaction).
   */
  rotateKey(newIdentity: AgeIdentity): Promise<void>;

  /** The public key (recipient) of the currently loaded identity. */
  readonly publicKey: string;
}

/**
 * Create the vault service. Loads or generates the age identity,
 * then returns the service bound to the given database.
 *
 * @param db - The state database (better-sqlite3 instance).
 * @param identityPath - Path to the age identity file (read or create).
 * @param secretsDir - Docker secrets directory to check first (e.g. /run/secrets).
 */
export { createVaultService } from "./vault-service-impl";
