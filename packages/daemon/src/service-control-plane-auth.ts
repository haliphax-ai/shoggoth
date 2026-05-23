import type { ServiceManifest } from "./service-registry";
import type { ServiceApprovalStore } from "./service-approval-store";

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
 * - Stores approved ops in the `service_approvals.approved_ops` column (JSON array).
 * - Checks authorization: only ops declared in the manifest are allowed.
 * - Revoked services are denied all ops.
 * - Per-service rate limiting (in-memory sliding window counter).
 */
export class ServiceControlPlaneAuth {
  private readonly store: ServiceApprovalStore;
  private readonly maxRequestsPerMinute: number;
  private readonly windowMs: number;
  private readonly rateLimitBuckets: Map<string, RateLimitBucket> = new Map();

  constructor(store: ServiceApprovalStore, opts?: ServiceControlPlaneAuthOptions) {
    this.store = store;
    this.maxRequestsPerMinute = opts?.maxRequestsPerMinute ?? 60;
    this.windowMs = opts?.windowMs ?? 60_000;
  }

  /**
   * Store the list of approved ops for a service.
   * Replaces any previously stored ops.
   */
  storeApprovedOps(serviceId: string, ops: string[]): void {
    this.store.setApprovedOps(serviceId, ops);
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
    // Check if service exists and is not revoked
    const record = this.store.get(serviceId);
    if (!record || record.status === "revoked") {
      return false;
    }

    // Check if op is in approved list
    const ops = this.store.getApprovedOps(serviceId);
    return ops.includes(op);
  }

  /**
   * Get the list of approved ops for a service, in declaration order.
   */
  getApprovedOps(serviceId: string): string[] {
    return this.store.getApprovedOps(serviceId);
  }

  /**
   * Revoke a service, preventing all future op authorization.
   */
  revokeService(serviceId: string): void {
    this.store.revoke(serviceId);
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
