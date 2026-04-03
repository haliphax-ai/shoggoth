import type { MessagingPlatformUrnPolicy } from "./platform-urn-registry";

// ---------------------------------------------------------------------------
// PlatformRegistration
// ---------------------------------------------------------------------------

export interface PlatformRegistration {
  readonly platformId: string;
  readonly validateConfig?: (config: unknown) => string[] | null;
  readonly validateUrn?: (parsed: { resourceType: string; uuidChain: readonly string[] }) => string | null;
  readonly resourceTypes: readonly string[];
  readonly urnPolicy: MessagingPlatformUrnPolicy;
}

// ---------------------------------------------------------------------------
// Registry internals
// ---------------------------------------------------------------------------

const registry = new Map<string, PlatformRegistration>();

function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function registerPlatform(reg: PlatformRegistration): void {
  const id = normalizeId(reg.platformId);
  if (!id) throw new Error("PlatformRegistration.platformId must be non-empty");
  if (!reg.resourceTypes || reg.resourceTypes.length === 0) {
    throw new Error("PlatformRegistration.resourceTypes must contain at least one entry");
  }
  if (!reg.urnPolicy) throw new Error("PlatformRegistration.urnPolicy is required");
  if (registry.has(id)) {
    throw new Error(`Platform "${id}" is already registered`);
  }
  registry.set(id, reg);
}

export function getPlatformRegistration(platformId: string): PlatformRegistration | undefined {
  return registry.get(normalizeId(platformId));
}

/** Reset the registry. Intended for tests only. */
export function clearPlatformRegistry(): void {
  registry.clear();
}
