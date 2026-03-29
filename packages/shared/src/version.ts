import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Version from monorepo root `package.json` (single source for daemon + CLI).
 */
function readRootVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const rootPkg = join(here, "..", "..", "..", "package.json");
  const j = JSON.parse(readFileSync(rootPkg, "utf8")) as { version?: string };
  if (!j.version || typeof j.version !== "string") {
    throw new Error(`Missing version in ${rootPkg}`);
  }
  return j.version;
}

export const VERSION: string = readRootVersion();
