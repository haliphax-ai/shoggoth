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
    const rootPkg = join(here, "..", "..", "..", "package.json");
    const j = JSON.parse(readFileSync(rootPkg, "utf8")) as { version?: string };
    if (!j.version || typeof j.version !== "string") {
      throw new Error(`Missing version in ${rootPkg}`);
    }
    _version = j.version;
  } catch {
    _version = "unknown";
  }
  return _version;
}

export const VERSION: string = /* @__PURE__ */ readRootVersion();
