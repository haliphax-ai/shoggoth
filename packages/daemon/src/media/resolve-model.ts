/**
 * Media model resolution utilities.
 * Matches model names against patterns to find the appropriate provider and adapter.
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
}

export interface MediaGenerationModelEntry {
  pattern: string;
  provider: string;
  adapter: string;
}

/**
 * Resolve a model name to its provider and adapter based on model entries.
 * @param model - The model name to resolve
 * @param models - Array of model entries with patterns
 * @param providers - Array of configured providers
 * @returns ResolvedModel or undefined if no match
 */
export function resolveModel(
  model: string,
  models: MediaGenerationModelEntry[],
  providers: ResolvedMediaProvider[],
): ResolvedModel | undefined {
  // Stub implementation - returns undefined always
  return undefined;
}

/**
 * Resolve the API key for a provider from config.
 * @param config - Configuration with either direct apiKey or apiKeyEnv reference
 * @returns The resolved API key string
 */
export function resolveMediaProvider(
  config: { apiKey?: string; apiKeyEnv?: string },
): string {
  // Stub implementation - returns empty string always
  return "";
}