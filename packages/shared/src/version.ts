import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Version from monorepo root `package.json` (single source for daemon + CLI).
 *
 * Lazily initialised on first access so that a missing or malformed
 * `package.json` no longer causes a synchronous throw at import time.
 * If the file cannot be read or the `version` field is missing/invalid,
 * `"unknown"` is returned instead.
 */
let _version: string | undefined;

function readRootVersion(): string {
  if (_version !== undefined) return _version;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Walk up from the current file until we find a package.json with a
    // `version` field, rather than assuming a fixed directory depth.
    let dir = here;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const candidate = join(dir, "package.json");
      try {
        const j = JSON.parse(readFileSync(candidate, "utf8")) as {
          version?: string;
        };
        if (j.version && typeof j.version === "string") {
          _version = j.version;
          return _version;
        }
      } catch {
        // not readable or not found — keep walking
      }
      const parent = dirname(dir);
      if (parent === dir) break; // filesystem root
      dir = parent;
    }
    throw new Error("Could not find a root package.json with a version field");
  } catch {
    _version = "unknown";
  }
  return _version;
}

export const VERSION: string = /* @__PURE__ */ readRootVersion();
