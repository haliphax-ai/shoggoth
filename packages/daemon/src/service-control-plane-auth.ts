import type Database from "better-sqlite3";
import type { ServiceManifest } from "./service-registry";

/**
 * Rate limit check result.
 */
export interface RateLimitResult {
  allowed: boolean;
  error?: string;
}

/**
 * Options for ServiceControlPlaneAuth.
 */
export interface ServiceControlPlaneAuthOptions {
  /** Maximum requests per window. Default: 60. */
  maxRequestsPerMinute?: number;
  /** Rate limit window in milliseconds. Default: 60_000 (1 minute). */
  windowMs?: number;
}

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

/**
 * Manages scoped control plane access for services.
 *
 * - Stores approved ops from service manifests in the `service_approved_ops` table.
 * - Checks authorization: only ops declared in the manifest are allowed.
 * - Revoked services are denied all ops.
 * - Per-service rate limiting (sliding window counter).
 */
export class ServiceControlPlaneAuth {
  private readonly db: Database.Database;
  private readonly maxRequestsPerMinute: number;
  private readonly windowMs: number;
  private readonly rateLimitBuckets: Map<string, RateLimitBucket> = new Map();

  constructor(db: Database.Database, opts?: ServiceControlPlaneAuthOptions) {
    this.db = db;
    this.maxRequestsPerMinute = opts?.maxRequestsPerMinute ?? 60;
    this.windowMs = opts?.windowMs ?? 60_000;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_approved_ops (
        service_id TEXT NOT NULL,
        op TEXT NOT NULL,
        ord INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (service_id, op)
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS service_control_status (
        service_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'approved'
      )
    `);
  }

  /**
   * Store the list of approved ops for a service.
   * Replaces any previously stored ops.
   */
  storeApprovedOps(serviceId: string, ops: string[]): void {
    const deleteStmt = this.db.prepare("DELETE FROM service_approved_ops WHERE service_id = ?");
    const insertStmt = this.db.prepare(
      "INSERT OR REPLACE INTO service_approved_ops (service_id, op, ord) VALUES (?, ?, ?)",
    );
    const statusStmt = this.db.prepare(
      "INSERT OR REPLACE INTO service_control_status (service_id, status) VALUES (?, 'approved')",
    );

    const txn = this.db.transaction(() => {
      deleteStmt.run(serviceId);
      for (let i = 0; i < ops.length; i++) {
        insertStmt.run(serviceId, ops[i], i);
      }
      statusStmt.run(serviceId);
    });
    txn();
  }

  /**
   * Approve a service using its manifest, extracting ops[] from the manifest.
   */
  approveWithManifest(serviceId: string, manifest: ServiceManifest): void {
    const ops = manifest.ops ?? [];
    this.storeApprovedOps(serviceId, ops);
  }

  /**
   * Check if a service is authorized to invoke a specific op.
   * Returns false if the service is revoked or the op is not in the approved list.
   */
  isAuthorized(serviceId: string, op: string): boolean {
    // Check if service is revoked
    const statusRow = this.db
      .prepare("SELECT status FROM service_control_status WHERE service_id = ?")
      .get(serviceId) as { status: string } | undefined;

    if (!statusRow || statusRow.status === "revoked") {
      return false;
    }

    // Check if op is in approved list
    const opRow = this.db
      .prepare("SELECT 1 FROM service_approved_ops WHERE service_id = ? AND op = ?")
      .get(serviceId, op);

    return opRow !== undefined;
  }

  /**
   * Get the list of approved ops for a service, in declaration order.
   */
  getApprovedOps(serviceId: string): string[] {
    const rows = this.db
      .prepare("SELECT op FROM service_approved_ops WHERE service_id = ? ORDER BY ord ASC")
      .all(serviceId) as Array<{ op: string }>;

    return rows.map((r) => r.op);
  }

  /**
   * Revoke a service, preventing all future op authorization.
   */
  revokeService(serviceId: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO service_control_status (service_id, status) VALUES (?, 'revoked')",
      )
      .run(serviceId);
  }

  /**
   * Check rate limit for a service. Uses a sliding window counter.
   * Returns { allowed: true } if within limit, { allowed: false, error } if exceeded.
   */
  checkRateLimit(serviceId: string): RateLimitResult {
    const now = Date.now();
    let bucket = this.rateLimitBuckets.get(serviceId);

    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      // Start a new window
      bucket = { count: 0, windowStart: now };
      this.rateLimitBuckets.set(serviceId, bucket);
    }

    if (bucket.count >= this.maxRequestsPerMinute) {
      return {
        allowed: false,
        error: `Rate limit exceeded: ${this.maxRequestsPerMinute} requests per ${this.windowMs}ms window`,
      };
    }

    bucket.count++;
    return { allowed: true };
  }

  /**
   * Reset rate limit state for a service (e.g. on revocation cleanup).
   */
  resetRateLimit(serviceId: string): void {
    this.rateLimitBuckets.delete(serviceId);
  }
}
