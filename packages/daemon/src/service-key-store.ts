import type Database from "better-sqlite3";
import * as age from "age-encryption";

export interface KeyPairResult {
  identity: string;
  recipient: string;
}

/**
 * Manages age X25519 key pairs for services, persisting the public
 * recipient and fingerprint in the state database.
 */
export class ServiceKeyStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_keys (
        service_id TEXT PRIMARY KEY,
        recipient TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        rotated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /**
   * Generate a new age X25519 keypair for the given service.
   * Stores the recipient and fingerprint in the database.
   * Throws if a key already exists for this serviceId.
   */
  async generateIdentity(serviceId: string): Promise<KeyPairResult> {
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const fingerprint = recipient.slice(0, 16);

    this.db
      .prepare(
        "INSERT INTO service_keys (service_id, recipient, fingerprint) VALUES (@serviceId, @recipient, @fingerprint)",
      )
      .run({ serviceId, recipient, fingerprint });

    return { identity, recipient };
  }

  /**
   * Get the stored recipient (public key) for a service.
   * Returns null if no key exists.
   */
  getRecipient(serviceId: string): string | null {
    const row = this.db
      .prepare("SELECT recipient FROM service_keys WHERE service_id = ?")
      .get(serviceId) as { recipient: string } | undefined;
    return row?.recipient ?? null;
  }

  /**
   * Get the fingerprint (first 16 chars of recipient) for a service.
   * Returns null if no key exists.
   */
  getFingerprint(serviceId: string): string | null {
    const row = this.db
      .prepare("SELECT fingerprint FROM service_keys WHERE service_id = ?")
      .get(serviceId) as { fingerprint: string } | undefined;
    return row?.fingerprint ?? null;
  }

  /**
   * Rotate the key for a service: generate a new keypair and update the row.
   */
  async rotateIdentity(serviceId: string): Promise<KeyPairResult> {
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);
    const fingerprint = recipient.slice(0, 16);

    this.db
      .prepare(
        "UPDATE service_keys SET recipient = @recipient, fingerprint = @fingerprint, rotated_at = datetime('now') WHERE service_id = @serviceId",
      )
      .run({ serviceId, recipient, fingerprint });

    return { identity, recipient };
  }

  /**
   * Delete the key for a service.
   */
  deleteIdentity(serviceId: string): void {
    this.db.prepare("DELETE FROM service_keys WHERE service_id = ?").run(serviceId);
  }

  /**
   * Check whether a key exists for the given service.
   */
  hasIdentity(serviceId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM service_keys WHERE service_id = ?").get(serviceId);
    return row !== undefined;
  }
}
