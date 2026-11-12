import { loadLayeredConfigAsync, type ShoggothConfig } from "@shoggoth/shared";

/**
 * Per-config-directory cache of layered config within a single process.
 * Repeated lookups in one CLI invocation (socket path, session resolution,
 * model resolution) reuse a single parsed config instead of re-reading and
 * re-parsing the config files from disk.
 */
const cache = new Map<string, ShoggothConfig>();

/**
 * Load the layered configuration for a config directory, memoizing the result
 * per directory.
 */
export async function loadLayeredConfigCachedAsync(configDir: string): Promise<ShoggothConfig> {
  const cached = cache.get(configDir);
  if (cached) return cached;
  const config = await loadLayeredConfigAsync(configDir);
  cache.set(configDir, config);
  return config;
}
