import { modelEntriesFromRecord, type ShoggothModelEntryBody } from "@shoggoth/shared";

export interface ModelMetadataEntry {
  /** Context window size in tokens. */
  contextWindowTokens: number;
  /** Where this value came from. */
  source: "config" | "provider";
}

/** Key format: "providerId:model" */
type ModelKey = string;

function makeKey(providerId: string, model: string): ModelKey {
  return `${providerId}:${model}`;
}

/** A store instance mapping model keys to their metadata entries. */
export type ModelMetadataStore = Map<ModelKey, ModelMetadataEntry>;

/**
 * Create a fresh, empty model metadata store.
 * Use this in tests for isolated instances.
 */
export function createModelMetadataStore(): ModelMetadataStore {
  return new Map<ModelKey, ModelMetadataEntry>();
}

/** Default module-level store used when no explicit store is passed. */
const defaultStore: ModelMetadataStore = createModelMetadataStore();

/**
 * Initialize the store from the models config: every provider model with a
 * configured context window, plus failover-chain entries.
 * Call once at startup after config is loaded.
 */
export function initModelMetadataFromConfig(
  failoverChain: ReadonlyArray<string>,
  providers?: ReadonlyArray<{
    id: string;
    models?: Record<string, ShoggothModelEntryBody>;
  }>,
  store: ModelMetadataStore = defaultStore,
): void {
  // Register every configured model definition, not only failover-chain
  // entries: a session may select any configured model, and window lookups
  // (status bar, session stats) are keyed by providerId + model name.
  for (const provider of providers ?? []) {
    for (const { name, contextWindowTokens } of modelEntriesFromRecord(provider.models)) {
      if (contextWindowTokens != null) {
        store.set(makeKey(provider.id, name), {
          contextWindowTokens,
          source: "config",
        });
      }
    }
  }
  for (const entry of failoverChain) {
    const slash = entry.indexOf("/");
    if (slash < 1) continue;
    const providerId = entry.slice(0, slash);
    const model = entry.slice(slash + 1);
    const providerConfig = providers?.find((p) => p.id === providerId);
    const modelConfig = providerConfig?.models?.[model];
    const contextWindowTokens = modelConfig?.contextWindowTokens;
    if (contextWindowTokens != null) {
      store.set(makeKey(providerId, model), {
        contextWindowTokens,
        source: "config",
      });
    }
  }
}

/**
 * Set metadata from a provider response (e.g. models API).
 * Provider values overwrite config values.
 * Returns a warning message if the config value existed and didn't match, or undefined.
 */
export function setModelMetadataFromProvider(
  providerId: string,
  model: string,
  contextWindowTokens: number,
  store: ModelMetadataStore = defaultStore,
): string | undefined {
  const key = makeKey(providerId, model);
  const existing = store.get(key);
  let warning: string | undefined;

  if (
    existing &&
    existing.source === "config" &&
    existing.contextWindowTokens !== contextWindowTokens
  ) {
    warning = `Context window mismatch for ${key}: config says ${existing.contextWindowTokens}, provider reports ${contextWindowTokens}. Using provider value.`;
  }

  store.set(key, { contextWindowTokens, source: "provider" });
  return warning;
}

/**
 * Get the context window tokens for a model.
 *
 * There are no hard-coded model defaults anywhere: providers are the single
 * source of truth for model metadata. The store only contains values from the
 * models config (`contextWindowTokens`) or reported by the provider itself
 * (models-API fetches and provider-reported usage). Models with neither a
 * configured nor a provider-reported window have no entry, and callers are
 * expected to handle an undefined window (e.g. the mid-turn compaction arming
 * check logs an error instead of silently guessing a window size).
 *
 * Returns undefined if no metadata is available.
 */
export function getModelContextWindowTokens(
  providerId: string,
  model: string,
  store: ModelMetadataStore = defaultStore,
): number | undefined {
  return store.get(makeKey(providerId, model))?.contextWindowTokens;
}
