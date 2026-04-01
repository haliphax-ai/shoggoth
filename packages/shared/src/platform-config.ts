import type { ShoggothConfig } from "./schema.js";

// ---------------------------------------------------------------------------
// Platform extension validation registry
// ---------------------------------------------------------------------------

export type PlatformConfigValidator = (raw: unknown) => { valid: boolean; errors?: string[] };

const platformValidators = new Map<string, PlatformConfigValidator>();

export function registerPlatformConfigValidator(platformId: string, validator: PlatformConfigValidator): void {
  platformValidators.set(platformId, validator);
}

export function validatePlatformExtensions(platformId: string, raw: unknown): { valid: boolean; errors?: string[] } {
  const validator = platformValidators.get(platformId);
  if (!validator) return { valid: true }; // no validator registered, pass through
  return validator(raw);
}

// ---------------------------------------------------------------------------
// Platform config resolution helpers
// ---------------------------------------------------------------------------

/** Resolve platform config from `platforms` bag. */
export function resolvePlatformConfig(cfg: ShoggothConfig, platformId: string): Record<string, unknown> | undefined {
  const fromPlatforms = cfg.platforms?.[platformId];
  if (fromPlatforms) return fromPlatforms as Record<string, unknown>;
  return undefined;
}

/** Check if a platform is enabled in config. */
export function isPlatformEnabled(cfg: ShoggothConfig, platformId: string): boolean {
  const pc = resolvePlatformConfig(cfg, platformId);
  if (!pc) return false;
  return pc.enabled !== false; // default true if present
}

// ---------------------------------------------------------------------------
// Agent-level platform config resolution
// ---------------------------------------------------------------------------

/** Resolve agent-level platform config from `platforms` bag. */
export function resolveAgentPlatformConfig(
  agent: { platforms?: Record<string, Record<string, unknown>> },
  platformId: string,
): Record<string, unknown> | undefined {
  const fromPlatforms = agent.platforms?.[platformId];
  if (fromPlatforms) return fromPlatforms;
  return undefined;
}

/**
 * Derive the default platform for an agent from its `agents.list.<agentId>.platforms` bindings.
 * Returns the first configured platform key, or `undefined` when no bindings exist.
 */
export function resolveAgentDefaultPlatform(cfg: ShoggothConfig, agentId: string): string | undefined {
  const agent = cfg.agents?.list?.[agentId];
  if (!agent?.platforms) return undefined;
  const keys = Object.keys(agent.platforms);
  return keys.length > 0 ? keys[0] : undefined;
}
