import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HookHandler, HookName, HookRegistry } from "./hook-registry";
import { parseShoggothPluginManifest } from "./shoggoth-manifest";

export interface LoadedPluginMeta {
  readonly name: string;
  readonly version: string;
  readonly rootDir: string;
}

export async function loadPluginFromDirectory(
  rootDir: string,
  registry: HookRegistry,
): Promise<LoadedPluginMeta> {
  const manifestPath = join(rootDir, "shoggoth.json");
  const raw = readFileSync(manifestPath, "utf8");
  const manifest = parseShoggothPluginManifest(JSON.parse(raw) as unknown);
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
      registry.register(hook as HookName, fn as HookHandler);
    }
  }
  return { name: manifest.name, version: manifest.version, rootDir };
}
