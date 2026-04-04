import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { deepMerge } from "./merge";
import {
  defaultConfig,
  shoggothConfigFragmentSchema,
  shoggothConfigSchema,
  type ShoggothConfig,
} from "./schema";

function listJsonFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const s = statSync(full);
      if (s.isDirectory()) {
        results.push(...listJsonFilesRecursive(full));
      } else if (s.isFile() && name.endsWith(".json")) {
        results.push(full);
      }
    } catch {
      continue;
    }
  }
  results.sort((a, b) => a.localeCompare(b, "en"));
  return results;
}

/**
 * Load configuration: built-in defaults, then each `*.json` found recursively under `configDir`,
 * merged in ascending full-path order (e.g. `base/00-main.json` before `dynamic/90-agent.json`).
 *
 * Non-JSON files are ignored entirely. For JSON files:
 * - Files under the dynamic config subdirectory (`<configDir>/dynamic/`): warn and skip on
 *   read/parse errors (these are written at runtime by agents via `config-request`).
 * - All other JSON files: throw on read/parse errors (these are operator-managed and must be valid).
 */
export function loadLayeredConfig(configDir: string): ShoggothConfig {
  let merged: Record<string, unknown> = { ...defaultConfig(configDir) };

  let stat;
  try {
    stat = statSync(configDir, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }

  const dynamicPrefix = resolve(configDir, "dynamic") + "/";

  if (stat?.isDirectory()) {
    for (const file of listJsonFilesRecursive(configDir)) {
      const isDynamic = resolve(file).startsWith(dynamicPrefix);

      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (e) {
        if (isDynamic) {
          console.warn(`[config] skipping ${file}: ${(e as Error).message}`);
          continue;
        }
        throw new Error(`Cannot read config file ${file}: ${(e as Error).message}`);
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (e) {
        if (isDynamic) {
          console.warn(`[config] skipping ${file}: invalid JSON — ${(e as Error).message}`);
          continue;
        }
        throw new Error(`Invalid JSON in config file ${file}: ${(e as Error).message}`);
      }

      let fragment;
      try {
        fragment = shoggothConfigFragmentSchema.parse(parsed);
      } catch (e) {
        if (isDynamic) {
          console.warn(`[config] skipping ${file}: schema validation failed — ${(e as Error).message}`);
          continue;
        }
        throw new Error(`Invalid config fragment in ${file}: ${(e as Error).message}`);
      }

      merged = deepMerge(merged as never, fragment) as Record<string, unknown>;
    }
  }

  const config = shoggothConfigSchema.parse(merged);

  return config;
}
