import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
 */
export function loadLayeredConfig(configDir: string): ShoggothConfig {
  let merged: Record<string, unknown> = { ...defaultConfig(configDir) };

  let stat;
  try {
    stat = statSync(configDir, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }

  if (stat?.isDirectory()) {
    for (const file of listJsonFilesRecursive(configDir)) {
      const raw = readFileSync(file, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (e) {
        throw new Error(`Invalid JSON in config file ${file}: ${(e as Error).message}`);
      }
      const fragment = shoggothConfigFragmentSchema.parse(parsed);
      merged = deepMerge(merged as never, fragment) as Record<string, unknown>;
    }
  }

  const config = shoggothConfigSchema.parse(merged);

  return config;
}
