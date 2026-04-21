import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ShoggothConfig } from "@shoggoth/shared";
import type { ShoggothPluginSystem } from "./plugin-system";
import { loadPluginFromDirectory } from "./plugin-loader";

export type PluginAuditOutcome = "success" | "failure";

export interface PluginAuditEvent {
  readonly action: "plugin.load" | "plugin.unload";
  readonly resource: string;
  readonly outcome: PluginAuditOutcome;
  readonly detail?: string;
}

/** Successful load: `resource` matches the config entry label used in load/unload audit rows. */
export interface LoadedPluginRef {
  readonly resource: string;
  readonly manifestName: string;
}

export function resolveLocalPluginPath(pathStr: string, configDirectory: string): string {
  return isAbsolute(pathStr) ? pathStr : resolve(configDirectory, pathStr);
}

export function resolveNpmPluginRoot(packageName: string, resolveFromFile: string): string {
  const require = createRequire(resolveFromFile);
  const pkgJsonPath = require.resolve(`${packageName}/package.json`);
  return dirname(pkgJsonPath);
}

/** Loads plugins from config; returns successfully loaded entries (for shutdown unload audit). */
export async function loadAllPluginsFromConfig(options: {
  readonly config: Pick<ShoggothConfig, "plugins" | "configDirectory">;
  readonly system: ShoggothPluginSystem;
  /** Existing file path passed to `createRequire` for npm resolution. */
  readonly resolveFromFile: string;
  readonly audit?: (e: PluginAuditEvent) => void;
}): Promise<readonly LoadedPluginRef[]> {
  const loaded: LoadedPluginRef[] = [];
  for (const entry of options.config.plugins) {
    const label = entry.id ?? entry.path ?? entry.package ?? "unknown";
    try {
      const root =
        entry.path !== undefined
          ? resolveLocalPluginPath(entry.path, options.config.configDirectory)
          : resolveNpmPluginRoot(entry.package!, options.resolveFromFile);
      const meta = await loadPluginFromDirectory(root, options.system);
      loaded.push({ resource: label, manifestName: meta.name });
      options.audit?.({ action: "plugin.load", resource: label, outcome: "success" });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      options.audit?.({
        action: "plugin.load",
        resource: label,
        outcome: "failure",
        detail,
      });
    }
  }
  return loaded;
}
