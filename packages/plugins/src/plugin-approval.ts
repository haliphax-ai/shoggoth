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
 * Built-in property names inherent to JavaScript that the ops enforcement
 * proxy never treats as ops. These are Object.prototype members (methods and
 * the legacy accessors) that innocuous language/runtime operations rely on,
 * e.g. `deps.toString()`, `JSON.stringify(deps)`, or string coercion.
 *
 * Symbol keys (including well-known symbols like Symbol.toPrimitive) bypass
 * the ops check separately via the `typeof prop` guard in the proxy's get trap.
 */
export const OPS_PROXY_BUILTIN_PROPS: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    // JSON.stringify protocol hook: JSON.stringify(deps) probes "toJSON"
    // before serializing, so it must bypass the ops check like the symbol
    // well-knowns do.
    "toJSON",
  ]),
);

/**
 * Creates a scope-checking proxy for plugin dependencies that rejects undeclared ops.
 * The proxy wraps a deps object and intercepts property access, checking each
 * access against the declared ops. JavaScript built-in properties (any symbol
 * key and the Object.prototype built-in names) bypass the check and pass
 * through to the target, so innocuous operations like `deps.toString()` or
 * `JSON.stringify(deps)` do not throw.
 */
export function createOpsEnforcementProxy<T extends object>(
  deps: T,
  declaration: PluginOpsDeclaration,
): T {
  return new Proxy(deps, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !OPS_PROXY_BUILTIN_PROPS.has(prop)) {
        const result = enforcePluginOps(declaration, prop);
        if (!result.allowed) {
          throw new Error(result.reason);
        }
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}
