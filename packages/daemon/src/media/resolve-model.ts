/**
 * Media model resolution utilities.
 * Matches model names against provider model lists and derives the adapter
 * from provider.kind + model.mediaType (with optional per-model override).
 */

export interface ResolvedMediaProvider {
  id: string;
  kind: "openai-compatible" | "gemini";
  baseUrl: string;
  apiKey: string;
  apiVersion?: string;
}

export interface ResolvedModel {
  provider: ResolvedMediaProvider;
  adapter: string;
  modalities?: string[];
}

export interface MediaProviderModelEntry {
  name: string;
  mediaType: "image" | "video" | "audio";
  adapter?: string;
  modalities?: string[];
}

export interface MediaProviderConfig {
  id: string;
  kind: "openai-compatible" | "gemini";
  baseUrl: string;
  apiKey: string;
  apiVersion?: string;
  models: MediaProviderModelEntry[];
}

/** Default adapter mapping: provider.kind + model.mediaType → adapter name */
const ADAPTER_DEFAULTS: Record<string, Record<string, string>> = {
  "openai-compatible": {
    image: "openai-chat-image",
    video: "openai-video-async",
  },
  gemini: {
    image: "gemini-generate-content",
    video: "gemini-long-running",
    audio: "gemini-generate-content",
  },
};

/**
 * Derive the adapter for a model based on provider kind and media type.
 */
function deriveAdapter(
  providerKind: string,
  mediaType: string,
  adapterOverride?: string,
): string | undefined {
  if (adapterOverride) return adapterOverride;
  return ADAPTER_DEFAULTS[providerKind]?.[mediaType];
}

/**
 * Resolve a model name to its provider and adapter.
 * Searches through all providers' model lists for an exact name match.
 */
export function resolveModel(
  model: string,
  providers: MediaProviderConfig[],
): ResolvedModel | undefined {
  for (const provider of providers) {
    const entry = provider.models.find((m) => m.name === model);
    if (entry) {
      const adapter = deriveAdapter(provider.kind, entry.mediaType, entry.adapter);
      if (!adapter) {
        return undefined;
      }
      return {
        provider: {
          id: provider.id,
          kind: provider.kind,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          apiVersion: provider.apiVersion,
        },
        adapter,
        ...(entry.modalities ? { modalities: entry.modalities } : {}),
      };
    }
  }

  return undefined;
}

/**
 * Resolve the API key for a provider from config.
 * @param config - Configuration with either direct apiKey or apiKeyEnv reference
 * @returns The resolved API key string
 */
export function resolveMediaProvider(config: { apiKey?: string; apiKeyEnv?: string }): string {
  if (config.apiKey) {
    return config.apiKey;
  }
  if (config.apiKeyEnv) {
    return process.env[config.apiKeyEnv] || "";
  }
  return "";
}
