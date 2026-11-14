import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ShoggothPluginSystem } from "./plugin-system";
import { resolvePluginMeta } from "./shoggoth-manifest";
import { defineMessagingPlatformPlugin } from "./messaging-platform-plugin";

export interface LoadedPluginMeta {
  readonly name: string;
  readonly version: string;
  readonly rootDir: string;
  readonly kind: string;
}

/**
 * Load a plugin from a directory.
 * Expects a package.json with a `shoggothPlugin` property bag + factory entrypoint.
 */
export async function loadPluginFromDirectory(
  rootDir: string,
  system: ShoggothPluginSystem,
): Promise<LoadedPluginMeta> {
  const pkgPath = join(rootDir, "package.json");

  if (!existsSync(pkgPath)) {
    throw new Error(`Plugin at "${rootDir}" has no package.json`);
  }

  const raw = readFileSync(pkgPath, "utf8");
  const packageJson = JSON.parse(raw) as Record<string, unknown>;

  if (!packageJson.shoggothPlugin) {
    throw new Error(`Plugin at "${rootDir}" package.json is missing the "shoggothPlugin" property`);
  }

  const meta = resolvePluginMeta(packageJson);
  const entrypointUrl = pathToFileURL(join(rootDir, meta.entrypoint)).href;
  const mod = (await import(entrypointUrl)) as { default?: unknown };
  let plugin = mod.default;

  if (plugin === undefined || plugin === null) {
    throw new Error(`Plugin entrypoint "${meta.entrypoint}" does not export a default value`);
  }

  // If the default export is a factory function, call it
  if (typeof plugin === "function") {
    plugin = await plugin();
  }

  // For messaging-platform kind, validate required hooks
  if (meta.kind === "messaging-platform") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugin = defineMessagingPlatformPlugin(plugin as any);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  system.use(plugin as any);

  return {
    name: meta.name,
    version: meta.version,
    rootDir,
    kind: meta.kind,
  };
}
