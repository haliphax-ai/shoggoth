import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deepMerge } from "./merge";
import {
  defaultConfig,
  shoggothConfigFragmentSchema,
  shoggothConfigSchema,
  type ShoggothConfig,
} from "./schema";

async function listJsonFilesRecursiveAsync(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir);
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const s = await stat(full);
      if (s.isDirectory()) {
        results.push(...(await listJsonFilesRecursiveAsync(full)));
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
 *
 * Identical merging semantics — built-in defaults followed by every `*.json`
 * discovered recursively under `configDir`, in ascending full-path order.
 *
 * Suitable for async contexts where blocking the event loop is undesirable.
 */
export async function loadLayeredConfigAsync(configDir: string): Promise<ShoggothConfig> {
  let merged: Record<string, unknown> = { ...defaultConfig(configDir) };

  let s: import("node:fs").Stats | undefined;
  try {
    s = await stat(configDir);
  } catch {
    s = undefined;
  }

  const dynamicPrefix = resolve(configDir, "dynamic") + "/";

  if (s?.isDirectory()) {
    for (const file of await listJsonFilesRecursiveAsync(configDir)) {
      const isDynamic = resolve(file).startsWith(dynamicPrefix);

      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (e) {
        if (isDynamic) {
          console.warn(`[config] skipping ${file}: ${(e as Error).message}`);
          continue;
        }
        throw new Error(`Cannot read config file ${file}: ${(e as Error).message}`, { cause: e });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (e) {
        if (isDynamic) {
          console.warn(`[config] skipping ${file}: invalid JSON — ${(e as Error).message}`);
          continue;
        }
        throw new Error(`Invalid JSON in config file ${file}: ${(e as Error).message}`, {
          cause: e,
        });
      }

      let fragment;
      try {
        fragment = shoggothConfigFragmentSchema.parse(parsed);
      } catch (e) {
        if (isDynamic) {
          console.warn(
            `[config] skipping ${file}: schema validation failed — ${(e as Error).message}`,
          );
          continue;
        }
        throw new Error(`Invalid config fragment in ${file}: ${(e as Error).message}`, {
          cause: e,
        });
      }

      merged = deepMerge(merged as never, fragment) as Record<string, unknown>;
    }
  }

  const config = shoggothConfigSchema.parse(merged);

  return config;
}
