interface ModelMetadataEntry {
  /** Context window size in tokens. */
  contextWindowTokens: number;
  /** Where this value came from. */
  source: "config" | "provider" | "default";
}

/** Key format: "providerId:model" */
type ModelKey = string;

function makeKey(providerId: string, model: string): ModelKey {
  return `${providerId}:${model}`;
}

const store = new Map<ModelKey, ModelMetadataEntry>();

/**
 * Initialize the store from the failover chain config.
 * Call once at startup after config is loaded.
 */
export function initModelMetadataFromConfig(
  failoverChain: ReadonlyArray<{ providerId: string; model: string; contextWindowTokens?: number }>,
): void {
  for (const entry of failoverChain) {
    if (entry.contextWindowTokens != null) {
      store.set(makeKey(entry.providerId, entry.model), {
        contextWindowTokens: entry.contextWindowTokens,
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
): string | undefined {
  const key = makeKey(providerId, model);
  const existing = store.get(key);
  let warning: string | undefined;

  if (existing && existing.source === "config" && existing.contextWindowTokens !== contextWindowTokens) {
    warning = `Context window mismatch for ${key}: config says ${existing.contextWindowTokens}, provider reports ${contextWindowTokens}. Using provider value.`;
  }

  store.set(key, { contextWindowTokens, source: "provider" });
  return warning;
}

/**
 * Set a default value for a model (e.g. known Anthropic defaults).
 * Only sets if no value exists yet (doesn't overwrite config or provider values).
 */
function setModelMetadataDefault(
  providerId: string,
  model: string,
  contextWindowTokens: number,
): void {
  const key = makeKey(providerId, model);
  if (!store.has(key)) {
    store.set(key, { contextWindowTokens, source: "default" });
  }
}

/**
 * Get the context window tokens for a model.
 * Returns undefined if no metadata is available.
 */
export function getModelContextWindowTokens(
  providerId: string,
  model: string,
): number | undefined {
  return store.get(makeKey(providerId, model))?.contextWindowTokens;
}

/**
 * Register Anthropic defaults for all anthropic-messages provider ids present in the failover chain.
 * Call after initModelMetadataFromConfig so we know which provider ids exist.
 */
export function registerAnthropicDefaultsForProviders(
  providers: ReadonlyArray<{ id: string; kind: string }>,
): void {
  const anthropicIds = providers
    .filter((p) => p.kind === "anthropic-messages")
    .map((p) => p.id);

  const models200k = [
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-3-5-sonnet-20240620",
    "claude-3-5-sonnet-20241022",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-20241022",
    "claude-3-5-haiku-latest",
    "claude-3-opus-20240229",
    "claude-3-opus-latest",
    "claude-3-sonnet-20240229",
    "claude-3-haiku-20240307",
  ];

  for (const providerId of anthropicIds) {
    for (const model of models200k) {
      setModelMetadataDefault(providerId, model, 200_000);
    }
  }
}

/**
 * Known OpenAI model context window sizes (input tokens).
 * Used as defaults when the models API doesn't return context window info.
 */
const OPENAI_KNOWN_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  // GPT-4.1 family
  "gpt-4.1": 1_047_576,
  "gpt-4.1-mini": 1_047_576,
  "gpt-4.1-nano": 1_047_576,
  // GPT-4o family
  "gpt-4o": 128_000,
  "gpt-4o-2024-05-13": 128_000,
  "gpt-4o-2024-08-06": 128_000,
  "gpt-4o-2024-11-20": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4o-mini-2024-07-18": 128_000,
  // GPT-4 family
  "gpt-4-turbo": 128_000,
  "gpt-4-turbo-2024-04-09": 128_000,
  "gpt-4-turbo-preview": 128_000,
  "gpt-4": 8_192,
  "gpt-4-0613": 8_192,
  "gpt-4-32k": 32_768,
  // GPT-3.5 family
  "gpt-3.5-turbo": 16_385,
  "gpt-3.5-turbo-0125": 16_385,
  "gpt-3.5-turbo-1106": 16_385,
  // o-series reasoning models
  "o1": 200_000,
  "o1-2024-12-17": 200_000,
  "o1-preview": 128_000,
  "o1-preview-2024-09-12": 128_000,
  "o1-mini": 128_000,
  "o1-mini-2024-09-12": 128_000,
  "o1-pro": 200_000,
  "o1-pro-2025-03-19": 200_000,
  "o3": 200_000,
  "o3-2025-04-16": 200_000,
  "o3-pro": 200_000,
  "o3-mini": 200_000,
  "o3-mini-2025-01-31": 200_000,
  "o4-mini": 200_000,
  "o4-mini-2025-04-16": 200_000,
};

/**
 * Look up a known OpenAI model context window size.
 * Returns undefined for unrecognised models.
 */
export function getOpenAIKnownContextWindow(model: string): number | undefined {
  return OPENAI_KNOWN_CONTEXT_WINDOWS[model];
}

/**
 * Register OpenAI defaults for all openai-compatible provider ids present in the failover chain.
 * Call after initModelMetadataFromConfig so we know which provider ids exist.
 */
export function registerOpenAIDefaultsForProviders(
  providers: ReadonlyArray<{ id: string; kind: string }>,
  failoverChain: ReadonlyArray<{ providerId: string; model: string }>,
): void {
  const openaiIds = new Set(
    providers.filter((p) => p.kind === "openai-compatible").map((p) => p.id),
  );

  for (const hop of failoverChain) {
    if (!openaiIds.has(hop.providerId)) continue;
    const ctx = OPENAI_KNOWN_CONTEXT_WINDOWS[hop.model];
    if (ctx != null) {
      setModelMetadataDefault(hop.providerId, hop.model, ctx);
    }
  }
}
