import { createHash } from "node:crypto";
import type { ServiceManifest } from "./service-registry";

/**
 * Compute a deterministic fingerprint of a service manifest.
 * Used to detect changes that require re-approval.
 *
 * The fingerprint covers:
 * - tool names, descriptions, parameters, methods, paths
 * - capabilities (from config, not manifest)
 * - requested ops
 *
 * It does NOT cover:
 * - manifest name/version (informational)
 * - wsEndpoints (informational)
 */
export interface ServiceIdentity {
  /** How this service was loaded (managed, external, plugin). */
  tier: string;
  /** Base URL for the service. */
  url: string | null;
}

export function computeManifestFingerprint(
  manifest: ServiceManifest,
  capabilities: string[],
  identity?: ServiceIdentity,
): string {
  // Build a canonical representation of approval-relevant fields
  const canonical = {
    // Service identity — ensures approvals don't transfer across tiers or URLs
    tier: identity?.tier ?? "managed",
    url: identity?.url ?? null,
    tools: (manifest.tools ?? [])
      .map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        method: t.method,
        path: t.path,
        dispatch: t.dispatch ?? "body",
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    ops: [...(manifest.ops ?? [])].sort(),
    capabilities: [...capabilities].sort(),
  };

  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}
