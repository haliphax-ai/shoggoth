import type { MessagingPlatformUrnPolicy } from "./platform-urn-registry";

// ---------------------------------------------------------------------------
// PlatformRegistration
// ---------------------------------------------------------------------------

export interface PlatformRegistration {
  readonly platformId: string;
  readonly validateConfig?: (config: unknown) => string[] | null;
  readonly validateUrn?: (parsed: {
    resourceType: string;
    uuidChain: readonly string[];
  }) => string | null;
  readonly resourceTypes: readonly string[];
  readonly urnPolicy: MessagingPlatformUrnPolicy;
}

// ---------------------------------------------------------------------------
// PlatformRegistry
// ---------------------------------------------------------------------------

function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Mutable store for messaging platform registrations.
 *
 * The process-wide singleton below is kept intentionally (kanban card
 * `1873675178089645849`), but all of its state lives inside an instance of
 * this class so the backing `Map` is never reachable from module scope.
 * Registration and de-registration go through validated methods, and tests
 * that need isolation can construct their own instances instead of sharing
 * the singleton's state.
 */
export class PlatformRegistry {
  private readonly registrations = new Map<string, PlatformRegistration>();

  register(reg: PlatformRegistration): void {
    const id = normalizeId(reg.platformId);
    if (!id) throw new Error("PlatformRegistration.platformId must be non-empty");
    if (!reg.resourceTypes || reg.resourceTypes.length === 0) {
      throw new Error("PlatformRegistration.resourceTypes must contain at least one entry");
    }
    if (!reg.urnPolicy) throw new Error("PlatformRegistration.urnPolicy is required");
    if (this.registrations.has(id)) {
      throw new Error(`Platform "${id}" is already registered`);
    }
    this.registrations.set(id, reg);
  }

  /** De-register a platform (case-insensitive id). Returns `true` when one was removed. */
  unregister(platformId: string): boolean {
    return this.registrations.delete(normalizeId(platformId));
  }

  get(platformId: string): PlatformRegistration | undefined {
    return this.registrations.get(normalizeId(platformId));
  }

  clear(): void {
    this.registrations.clear();
  }
}

// ---------------------------------------------------------------------------
// Public API — module-level functions over the process-wide singleton
// ---------------------------------------------------------------------------

const registry = new PlatformRegistry();

export function registerPlatform(reg: PlatformRegistration): void {
  registry.register(reg);
}

export function getPlatformRegistration(platformId: string): PlatformRegistration | undefined {
  return registry.get(platformId);
}

/** De-register a messaging platform from the process-wide registry. */
export function unregisterPlatform(platformId: string): boolean {
  return registry.unregister(platformId);
}

/** Reset the registry. Intended for tests only. */
export function clearPlatformRegistry(): void {
  registry.clear();
}
