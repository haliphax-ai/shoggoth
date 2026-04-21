import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ShoggothPluginSystem } from "./plugin-system";
import { resolvePluginMeta } from "./shoggoth-manifest";
import { defineMessagingPlatformPlugin } from "./messaging-platform-plugin";
import { z } from "zod";

export interface LoadedPluginMeta {
  readonly name: string;
  readonly version: string;
  readonly rootDir: string;
  readonly kind: string;
}

/**
 * Legacy shoggoth.json manifest schema (backward compat).
 */
const legacyManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    hooks: z.record(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Load a plugin from a directory. Supports two formats:
 * 1. package.json with `shoggothPlugin` property bag + factory entrypoint
 * 2. Legacy: shoggoth.json with name/version/hooks mapping to individual handler files
 */
export async function loadPluginFromDirectory(
  rootDir: string,
  system: ShoggothPluginSystem,
): Promise<LoadedPluginMeta> {
  const pkgPath = join(rootDir, "package.json");
  const legacyPath = join(rootDir, "shoggoth.json");

  // Try package.json with shoggothPlugin bag first
  if (existsSync(pkgPath)) {
    const raw = readFileSync(pkgPath, "utf8");
    const packageJson = JSON.parse(raw) as Record<string, unknown>;
    if (packageJson.shoggothPlugin) {
      return loadPackageJsonPlugin(rootDir, packageJson, system);
    }
  }

  // Fall back to legacy shoggoth.json format
  if (existsSync(legacyPath)) {
    return loadLegacyFormat(rootDir, legacyPath, system);
  }

  throw new Error(
    `Plugin at "${rootDir}" has no package.json with shoggothPlugin bag or shoggoth.json manifest`,
  );
}

async function loadPackageJsonPlugin(
  rootDir: string,
  packageJson: Record<string, unknown>,
  system: ShoggothPluginSystem,
): Promise<LoadedPluginMeta> {
  const meta = resolvePluginMeta(packageJson);

  const entrypointUrl = pathToFileURL(join(rootDir, meta.entrypoint)).href;
  const mod = (await import(entrypointUrl)) as { default?: unknown };
  let plugin = mod.default;

  // If the default export is a factory function, call it
  if (typeof plugin === "function") {
    plugin = await plugin();
  }

  // For messaging-platform kind, validate required hooks
  if (meta.kind === "messaging-platform") {
    plugin = defineMessagingPlatformPlugin(plugin as any);
  }

  system.use(plugin as any);

  return {
    name: meta.name,
    version: meta.version,
    rootDir,
    kind: meta.kind,
  };
}

async function loadLegacyFormat(
  rootDir: string,
  manifestPath: string,
  system: ShoggothPluginSystem,
): Promise<LoadedPluginMeta> {
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = legacyManifestSchema.parse(JSON.parse(raw) as unknown);

  const hooks: Record<string, (...args: any[]) => any> = {};
  if (manifest.hooks) {
    for (const [hook, relPath] of Object.entries(manifest.hooks)) {
      const url = pathToFileURL(join(rootDir, relPath)).href;
      const mod = (await import(url)) as { default?: unknown };
      const fn = mod.default;
      if (typeof fn !== "function") {
        throw new Error(
          `Plugin "${manifest.name}" hook "${hook}" must default-export a function`,
        );
      }
      hooks[hook] = fn as (...args: any[]) => any;
    }
  }

  system.use({ name: manifest.name, hooks });

  return {
    name: manifest.name,
    version: manifest.version,
    rootDir,
    kind: "general",
  };
}
