// ---------------------------------------------------------------------------
// Plugin Approval — status resolution and ops enforcement
// ---------------------------------------------------------------------------

import { computePluginFingerprint, type PluginManifestForFingerprint } from "./plugin-fingerprint";

/**
 * Persisted record of a previously approved plugin.
 */
export interface PluginApprovalRecord {
  readonly pluginName: string;
  readonly fingerprint: string;
  readonly approvedAt: string;
  readonly approvedOps: readonly string[];
}

/**
 * Result of resolving a plugin's approval status.
 */
export interface PluginApprovalStatus {
  readonly state: "pending" | "approved" | "pending-reapproval";
  readonly fingerprint: string;
}

/**
 * Declaration of which ops a plugin is allowed to perform.
 */
export interface PluginOpsDeclaration {
  readonly pluginName: string;
  readonly allowedOps: readonly string[];
}

/**
 * Result of an ops enforcement check.
 */
export interface OpsEnforcementResult {
  readonly allowed: boolean;
  readonly op: string;
  readonly reason?: string;
}

/**
 * Resolves the approval status of a plugin given its manifest and
 * an optional existing approval record.
 *
 * - No record → 'pending'
 * - Record exists + fingerprint matches → 'approved'
 * - Record exists + fingerprint changed → 'pending-reapproval'
 */
export function resolvePluginApprovalStatus(
  manifest: PluginManifestForFingerprint,
  record: PluginApprovalRecord | undefined,
): PluginApprovalStatus {
  const fingerprint = computePluginFingerprint(manifest);

  if (!record) {
    return { state: "pending", fingerprint };
  }

  if (record.fingerprint === fingerprint) {
    return { state: "approved", fingerprint };
  }

  return { state: "pending-reapproval", fingerprint };
}

/**
 * Enforces that a requested op is within the plugin's declared allowed ops.
 */
export function enforcePluginOps(
  declaration: PluginOpsDeclaration,
  op: string,
): OpsEnforcementResult {
  if (declaration.allowedOps.includes(op)) {
    return { allowed: true, op };
  }

  return {
    allowed: false,
    op,
    reason: `Op "${op}" is not declared in allowed ops for plugin "${declaration.pluginName}"`,
  };
}

/**
 * Creates a scope-checking proxy for plugin dependencies that rejects undeclared ops.
 * The proxy wraps a deps object and intercepts property access, checking each
 * access against the declared ops.
 */
export function createOpsEnforcementProxy<T extends object>(
  deps: T,
  declaration: PluginOpsDeclaration,
): T {
  return new Proxy(deps, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        const result = enforcePluginOps(declaration, prop);
        if (!result.allowed) {
          throw new Error(result.reason);
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}
