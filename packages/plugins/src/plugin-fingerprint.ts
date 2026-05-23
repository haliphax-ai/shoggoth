// ---------------------------------------------------------------------------
// Plugin Fingerprinting — computes a deterministic hash of plugin capabilities
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/**
 * Minimal manifest shape needed to compute a fingerprint.
 */
export interface PluginManifestForFingerprint {
  readonly name: string;
  readonly version: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  }>;
  readonly ops: readonly string[];
}

/**
 * Computes a deterministic fingerprint for a plugin manifest.
 * The fingerprint captures the plugin's tools and ops declarations
 * so that changes to capabilities can be detected.
 *
 * The hash is order-independent: tools and ops are sorted before hashing.
 */
export function computePluginFingerprint(manifest: PluginManifestForFingerprint): string {
  // Sort tools by name for deterministic ordering
  const sortedTools = [...manifest.tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: canonicalizeJson(t.parameters),
    }));

  // Sort ops alphabetically
  const sortedOps = [...manifest.ops].sort();

  // Build a canonical representation
  const canonical = JSON.stringify({ tools: sortedTools, ops: sortedOps });

  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Produces a canonical JSON-safe representation of an object by sorting keys recursively.
 */
function canonicalizeJson(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(canonicalizeJson);
  if (typeof obj === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeJson((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}
