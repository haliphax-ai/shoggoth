import type Database from "better-sqlite3";
import type { ShoggothConfig, ShoggothModelsConfig, FailoverChainEntry, ModelsRetry } from "@shoggoth/shared";
import { resolveEffectiveModelsConfig } from "@shoggoth/shared";
import { isProviderFailed } from "./provider-failure-store";
import { getLogger } from "../logging";

const log = getLogger("model-resolution");

/** Default mark-failed duration when not configured (5 minutes). */
const DEFAULT_MARK_FAILED_DURATION_MS = 300_000;

type ProviderConfig = NonNullable<ShoggothModelsConfig["providers"]>[number];
type ProviderModelDefinition = NonNullable<ProviderConfig["models"]>[number];

export interface ResolvedModel {
  provider: ProviderConfig;
  model: ProviderModelDefinition;
  /** 'providerId/model' */
  ref: string;
}

export interface ResolveModelOpts {
  /** Explicit model ref like 'providerId/modelName'. */
  ref?: string;
  /** Session id — used to resolve per-agent model overrides. */
  sessionId?: string;
}

interface RetryConfig {
  maxRetries: number;
  retryDelayMs: number;
  retryBackoffMultiplier: number;
}

const RETRY_DEFAULTS: RetryConfig = {
  maxRetries: 2,
  retryDelayMs: 1000,
  retryBackoffMultiplier: 2,
};

/**
 * Extract the ref string from a failover chain entry.
 * Handles two shapes:
 * - string: "providerId/model" (FailoverChainEntry)
 * - { providerId: "x", model: "y" } (ShoggothModelFailoverHop from agent overrides)
 */
function entryToRef(entry: FailoverChainEntry | { providerId: string; model: string }): string {
  if (typeof entry === "string") return entry;
  if ("providerId" in entry && "model" in entry) return `${entry.providerId}/${entry.model}`;
  return "";
}

/** Parse 'providerId/model' into its parts. */
function parseRef(ref: string): { providerId: string; modelName: string } | null {
  const slash = ref.indexOf("/");
  if (slash < 1 || slash === ref.length - 1) return null;
  return { providerId: ref.slice(0, slash), modelName: ref.slice(slash + 1) };
}

/** Find a provider by id in the providers list. */
function findProvider(providers: readonly ProviderConfig[], providerId: string): ProviderConfig | undefined {
  return providers.find((p) => p.id === providerId);
}

/** Find a model definition in a provider's models list. */
function findModelDef(provider: ProviderConfig, modelName: string): ProviderModelDefinition | undefined {
  return provider.models?.find((m) => m.name === modelName);
}

/** Get the markFailedDurationMs for a provider, falling back to global retry config then default. */
function getMarkFailedDuration(provider: ProviderConfig, globalRetry: ModelsRetry | undefined): number {
  return provider.markFailedDurationMs ?? globalRetry?.markFailedDurationMs ?? DEFAULT_MARK_FAILED_DURATION_MS;
}

/**
 * Try to resolve a single ref to a ResolvedModel, checking provider failure state.
 * Returns the resolved model if the provider is available, or null if failed/missing.
 */
function tryResolveRef(
  db: Database.Database,
  providers: readonly ProviderConfig[],
  ref: string,
  globalRetry: ModelsRetry | undefined,
): ResolvedModel | null {
  const parsed = parseRef(ref);
  if (!parsed) {
    log.warn("invalid model ref", { ref });
    return null;
  }

  const provider = findProvider(providers, parsed.providerId);
  if (!provider) {
    log.warn("provider not found for ref", { ref, providerId: parsed.providerId });
    return null;
  }

  const duration = getMarkFailedDuration(provider, globalRetry);
  if (isProviderFailed(db, provider.id, duration)) {
    return null;
  }

  const modelDef = findModelDef(provider, parsed.modelName);
  if (!modelDef) {
    log.warn("model not found in provider", { ref, providerId: parsed.providerId, model: parsed.modelName });
    return null;
  }

  return { provider, model: modelDef, ref };
}

/**
 * Resolve a model ref to its full definition, walking the failover chain when the
 * target provider is marked as failed.
 *
 * Resolution algorithm:
 * 1. Determine target ref: explicit ref > first in effective failover chain
 * 2. Look up provider by providerId from the ref
 * 3. Check provider_failures: if failed and not stale → skip to failover; if stale → clear and try
 * 4. If provider down, find position in failover chain, walk from next entry until non-failed provider found
 * 5. If chain exhausted, return null + log warning
 * 6. Resolve model definition from provider's models list by name
 */
export function resolveModel(
  db: Database.Database,
  config: ShoggothConfig,
  opts?: ResolveModelOpts,
): ResolvedModel | null {
  const effectiveModels = opts?.sessionId
    ? resolveEffectiveModelsConfig(config, opts.sessionId) ?? config.models
    : config.models;

  if (!effectiveModels) {
    log.warn("no models config available");
    return null;
  }

  const providers = effectiveModels.providers;
  if (!providers?.length) {
    log.warn("no providers configured");
    return null;
  }

  // The failover chain may contain FailoverChainEntry (string | { ref }) or
  // ShoggothModelFailoverHop ({ providerId, model }) from agent overrides.
  const chain = effectiveModels.failoverChain as ReadonlyArray<FailoverChainEntry | { providerId: string; model: string }> | undefined;
  if (!chain?.length) {
    log.warn("no failover chain configured");
    return null;
  }

  const globalRetry = effectiveModels.retry;

  // Determine the target ref
  const targetRef = opts?.ref ?? entryToRef(chain[0]);

  // Try the target ref directly
  const direct = tryResolveRef(db, providers, targetRef, globalRetry);
  if (direct) return direct;

  // Target failed or missing — walk the chain from the position after the target
  const targetParsed = parseRef(targetRef);
  let startIdx = 0;
  if (targetParsed) {
    const idx = chain.findIndex((e) => {
      const r = entryToRef(e);
      const p = parseRef(r);
      return p?.providerId === targetParsed.providerId;
    });
    if (idx >= 0) startIdx = idx + 1;
  }

  for (let i = startIdx; i < chain.length; i++) {
    const ref = entryToRef(chain[i]);
    const resolved = tryResolveRef(db, providers, ref, globalRetry);
    if (resolved) return resolved;
  }

  log.warn("failover chain exhausted, no available provider", {
    targetRef,
    chainLength: chain.length,
  });
  return null;
}

/**
 * Merge retry config: provider-level overrides global-level, both override defaults.
 */
/**
 * Resolve the primary model ref from config at bootstrap time.
 * Returns a "providerId/model" string, or undefined if anything is missing/invalid.
 */
export function resolveBootstrapModelRef(config: ShoggothConfig, sessionId?: string): string | undefined {
  const effectiveModels = sessionId
    ? resolveEffectiveModelsConfig(config, sessionId) ?? config.models
    : config.models;

  if (!effectiveModels) return undefined;

  const chain = effectiveModels.failoverChain as ReadonlyArray<FailoverChainEntry | { providerId: string; model: string }> | undefined;
  if (!chain?.length) return undefined;

  const ref = entryToRef(chain[0]);
  if (!parseRef(ref)) return undefined;

  return ref;
}

/**
 * Extract the primary model ref from a session's modelSelection blob.
 * Returns the "providerId/model" string, or undefined if missing/invalid.
 */
export function getSessionPrimaryModelRef(modelSelection: unknown): string | undefined {
  if (modelSelection == null || typeof modelSelection !== "object" || Array.isArray(modelSelection)) return undefined;
  const model = (modelSelection as Record<string, unknown>).model;
  if (typeof model !== "string") return undefined;
  if (!parseRef(model)) return undefined;
  return model;
}

export function resolveRetryConfig(
  globalRetry: Partial<RetryConfig> | undefined,
  providerRetry: Partial<RetryConfig> | undefined,
): RetryConfig {
  return {
    maxRetries: providerRetry?.maxRetries ?? globalRetry?.maxRetries ?? RETRY_DEFAULTS.maxRetries,
    retryDelayMs: providerRetry?.retryDelayMs ?? globalRetry?.retryDelayMs ?? RETRY_DEFAULTS.retryDelayMs,
    retryBackoffMultiplier:
      providerRetry?.retryBackoffMultiplier ?? globalRetry?.retryBackoffMultiplier ?? RETRY_DEFAULTS.retryBackoffMultiplier,
  };
}
