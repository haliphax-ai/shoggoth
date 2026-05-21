import Database from "better-sqlite3";
import { type ServiceApprovalRecord, type ApprovalStatus } from "@shoggoth/shared";

/**
 * SQLite-backed store for service approval records.
 */
export class ServiceApprovalStore {
  constructor(private _db: Database.Database) {
    // Ensure the table exists (migrations should create it, but be safe)
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS service_approvals (
        service_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        approved_fingerprint TEXT,
        key_fingerprint TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Add key_fingerprint column if missing (for existing databases)
    try {
      this._db.exec(`ALTER TABLE service_approvals ADD COLUMN key_fingerprint TEXT`);
    } catch {
      // Column already exists
    }
  }

  /**
   * Get the approval record for a service. Returns null if never seen.
   */
  get(serviceId: string): ServiceApprovalRecord | null {
    const row = this._db
      .prepare(
        "SELECT service_id, status, approved_fingerprint, key_fingerprint, created_at, updated_at FROM service_approvals WHERE service_id = ?",
      )
      .get(serviceId) as
      | {
          service_id: string;
          status: string;
          approved_fingerprint: string | null;
          key_fingerprint: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      serviceId: row.service_id,
      status: row.status as ApprovalStatus,
      approvedFingerprint: row.approved_fingerprint,
      keyFingerprint: row.key_fingerprint,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Create or update an approval record.
   */
  upsert(
    serviceId: string,
    status: ApprovalStatus,
    fingerprint?: string,
    keyFingerprint?: string,
  ): void {
    const now = new Date().toISOString();
    const existing = this.get(serviceId);

    if (existing) {
      // Update existing record
      this._db
        .prepare(
          "UPDATE service_approvals SET status = ?, approved_fingerprint = ?, key_fingerprint = ?, updated_at = ? WHERE service_id = ?",
        )
        .run(
          status,
          fingerprint ?? null,
          keyFingerprint ?? existing.keyFingerprint ?? null,
          now,
          serviceId,
        );
    } else {
      // Insert new record
      this._db
        .prepare(
          "INSERT INTO service_approvals (service_id, status, approved_fingerprint, key_fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(serviceId, status, fingerprint ?? null, keyFingerprint ?? null, now, now);
    }
  }

  /**
   * Approve a service, storing the current manifest fingerprint.
   */
  approve(serviceId: string, fingerprint: string): void {
    const now = new Date().toISOString();
    const existing = this.get(serviceId);

    if (existing) {
      this._db
        .prepare(
          "UPDATE service_approvals SET status = 'approved', approved_fingerprint = ?, updated_at = ? WHERE service_id = ?",
        )
        .run(fingerprint, now, serviceId);
    } else {
      this._db
        .prepare(
          "INSERT INTO service_approvals (service_id, status, approved_fingerprint, created_at, updated_at) VALUES (?, 'approved', ?, ?, ?)",
        )
        .run(serviceId, fingerprint, now, now);
    }
  }

  /**
   * Revoke a service.
   */
  revoke(serviceId: string): void {
    const now = new Date().toISOString();
    const existing = this.get(serviceId);

    if (existing) {
      this._db
        .prepare(
          "UPDATE service_approvals SET status = 'revoked', updated_at = ? WHERE service_id = ?",
        )
        .run(now, serviceId);
    } else {
      // Create a revoked record for non-existent service
      this._db
        .prepare(
          "INSERT INTO service_approvals (service_id, status, approved_fingerprint, created_at, updated_at) VALUES (?, 'revoked', NULL, ?, ?)",
        )
        .run(serviceId, now, now);
    }
  }

  /**
   * List all records, optionally filtered by status.
   * Note: filtering by "pending" matches both "pending" and "pending-reapproval".
   */
  list(status?: ApprovalStatus): ServiceApprovalRecord[] {
    let rows: Array<{
      service_id: string;
      status: string;
      approved_fingerprint: string | null;
      key_fingerprint: string | null;
      created_at: string;
      updated_at: string;
    }>;

    if (status) {
      // Match status exactly, or for "pending" also match "pending-reapproval"
      if (status === "pending") {
        rows = this._db
          .prepare(
            "SELECT service_id, status, approved_fingerprint, key_fingerprint, created_at, updated_at FROM service_approvals WHERE status = 'pending' OR status = 'pending-reapproval'",
          )
          .all() as typeof rows;
      } else {
        rows = this._db
          .prepare(
            "SELECT service_id, status, approved_fingerprint, key_fingerprint, created_at, updated_at FROM service_approvals WHERE status = ?",
          )
          .all(status) as typeof rows;
      }
    } else {
      rows = this._db
        .prepare(
          "SELECT service_id, status, approved_fingerprint, key_fingerprint, created_at, updated_at FROM service_approvals",
        )
        .all() as typeof rows;
    }

    return rows.map((row) => ({
      serviceId: row.service_id,
      status: row.status as ApprovalStatus,
      approvedFingerprint: row.approved_fingerprint,
      keyFingerprint: row.key_fingerprint,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }
}
