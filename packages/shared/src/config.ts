import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { deepMerge } from "./merge";
import {
  defaultConfig,
  shoggothConfigFragmentSchema,
  shoggothConfigSchema,
  type ShoggothConfig,
} from "./schema";

function listJsonFilesSorted(dir: string): string[] {
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  names.sort((a, b) => a.localeCompare(b, "en"));
  return names.map((n) => join(dir, n));
}

/**
 * Load configuration: built-in defaults, then each `*.json` in `configDir` merged in
 * ascending filename order (e.g. `00-base.json` before `10-local.json`).
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
    for (const file of listJsonFilesSorted(configDir)) {
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

  return shoggothConfigSchema.parse(merged);
}
