// ---------------------------------------------------------------------------
// Plugin Registration Gate — integrates fingerprinting + approval into the
// service.register hook flow so that unapproved plugins have their tools
// suspended and approved plugins get ops enforcement on their deps.
// ---------------------------------------------------------------------------

import { type PluginManifestForFingerprint } from "./plugin-fingerprint";
import {
  resolvePluginApprovalStatus,
  createOpsEnforcementProxy,
  type PluginApprovalRecord,
  type PluginApprovalStatus,
  type PluginOpsDeclaration,
} from "./plugin-approval";
import type { DirectServiceTool, PluginServiceEntry, ServiceRegisterCtx } from "./hook-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Store interface for retrieving/persisting plugin approval records.
 * Consumers provide an implementation backed by their persistence layer.
 */
export interface PluginApprovalStore {
  get(pluginName: string): PluginApprovalRecord | undefined;
  set(pluginName: string, record: PluginApprovalRecord): void;
}

/**
 * Result of a gated registration attempt for a single plugin.
 */
export interface GatedRegistrationResult {
  readonly pluginName: string;
  readonly approvalStatus: PluginApprovalStatus;
  readonly toolsSuspended: boolean;
  readonly registeredToolCount: number;
}

/**
 * Logger interface for the registration gate.
 */
export interface RegistrationGateLogger {
  debug(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

/**
 * Options for creating a gated service register context.
 */
export interface CreateGatedContextOptions {
  /** The original (inner) context that performs actual registration. */
  readonly innerCtx: ServiceRegisterCtx;
  /** Store for plugin approval records. */
  readonly approvalStore: PluginApprovalStore;
  /** The plugin manifest used for fingerprinting. */
  readonly manifest: PluginManifestForFingerprint;
  /** Optional logger. */
  readonly logger?: RegistrationGateLogger;
  /** Optional deps object to wrap with ops enforcement proxy. */
  readonly deps?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Core gate logic
// ---------------------------------------------------------------------------

/**
 * Creates a gated ServiceRegisterCtx that intercepts registerService/registerTools
 * and applies fingerprint-based approval gating:
 *
 * - Computes the plugin fingerprint from its manifest
 * - Resolves approval status against the store
 * - If 'pending' or 'pending-reapproval': registers the service but suspends tools
 *   (does not call inner registerTools)
 * - If 'approved' and fingerprint matches: registers service and tools normally
 * - When deps are provided and plugin has declared ops, wraps deps with
 *   createOpsEnforcementProxy() so undeclared ops throw at access time
 *
 * Returns both the gated context (to pass to the hook) and a result accessor.
 */
export function createGatedServiceRegisterCtx(options: CreateGatedContextOptions): {
  ctx: ServiceRegisterCtx;
  getResult: () => GatedRegistrationResult | undefined;
} {
  const { innerCtx, approvalStore, manifest, logger } = options;

  let result: GatedRegistrationResult | undefined;

  // Resolve approval status
  const record = approvalStore.get(manifest.name);
  const approvalStatus = resolvePluginApprovalStatus(manifest, record);

  const isSuspended =
    approvalStatus.state === "pending" || approvalStatus.state === "pending-reapproval";

  // Build ops enforcement proxy for deps if plugin declares ops
  let enforcedDeps = options.deps;
  if (enforcedDeps && manifest.ops.length > 0 && approvalStatus.state === "approved") {
    const declaration: PluginOpsDeclaration = {
      pluginName: manifest.name,
      allowedOps: manifest.ops as unknown as string[],
    };
    enforcedDeps = createOpsEnforcementProxy(enforcedDeps, declaration);
  }

  let registeredToolCount = 0;

  const gatedCtx: ServiceRegisterCtx = {
    ...innerCtx,
    ops: manifest.ops,
    registerService: (entry: PluginServiceEntry): void => {
      // Always register the service entry (so it's visible in the registry)
      // but set approval status accordingly
      innerCtx.registerService(entry);

      if (isSuspended) {
        logger?.warn(
          `Plugin "${manifest.name}" registered service "${entry.id}" but tools are suspended (status: ${approvalStatus.state})`,
        );
      } else {
        logger?.debug(`Plugin "${manifest.name}" registered service "${entry.id}" (approved)`);
      }
    },
    registerTools: (tools: DirectServiceTool[]): void => {
      if (isSuspended) {
        // Do NOT forward tools to the inner context — they are suspended
        logger?.warn(
          `Plugin "${manifest.name}" attempted to register ${tools.length} tool(s) but they are suspended pending approval`,
        );
        registeredToolCount = 0;
      } else {
        // Approved — forward tools
        innerCtx.registerTools(tools);
        registeredToolCount = tools.length;
        logger?.debug(`Plugin "${manifest.name}" registered ${tools.length} tool(s)`);
      }

      result = {
        pluginName: manifest.name,
        approvalStatus,
        toolsSuspended: isSuspended,
        registeredToolCount,
      };
    },
  };

  // If registerTools is never called, still produce a result after registerService
  const getResult = (): GatedRegistrationResult | undefined => {
    if (!result) {
      // If service was registered but no tools were attempted
      return undefined;
    }
    return result;
  };

  return { ctx: gatedCtx, getResult };
}

/**
 * Convenience: builds a PluginManifestForFingerprint from the tools and ops
 * a plugin is about to register. Useful when the plugin doesn't ship a
 * standalone manifest file but declares tools inline via the hook.
 */
export function buildManifestFromRegistration(
  pluginName: string,
  pluginVersion: string,
  tools: DirectServiceTool[],
  ops: readonly string[],
): PluginManifestForFingerprint {
  return {
    name: pluginName,
    version: pluginVersion,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    ops: ops as unknown as readonly string[],
  };
}
