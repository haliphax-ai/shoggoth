// ---------------------------------------------------------------------------
// definePluginWithRequiredHooks — shared required-hook validation
// ---------------------------------------------------------------------------

import type { Plugin } from "hooks-plugin";
import type { ShoggothHooks } from "./plugin-system";

/**
 * Validates that a plugin implements every hook in `requiredHooks`.
 *
 * Throws the first time a required hook is missing or is not a function,
 * with an error naming the plugin kind, the plugin name, and the missing
 * hook. Returns the plugin unchanged.
 *
 * @param name - Plugin kind used in error messages (e.g. "MessagingPlatformPlugin").
 * @param plugin - The plugin object to validate.
 * @param requiredHooks - Hook names that must each be a function on `plugin.hooks`.
 */
export function definePluginWithRequiredHooks<P extends Plugin<ShoggothHooks>>(
  name: string,
  plugin: P,
  requiredHooks: readonly (keyof ShoggothHooks)[],
): P {
  for (const hook of requiredHooks) {
    if (typeof plugin.hooks[hook] !== "function") {
      throw new Error(`${name} "${plugin.name}" is missing required hook "${hook}"`);
    }
  }
  return plugin;
}
