#!/usr/bin/env node
/* eslint-env node */
// Launcher for the compiled CLI bundle (`dist/cli.mjs`, built by
// scripts/build-cli.mjs). Runs it directly — no child process, no loader —
// so the bin pays none of the tsx startup cost. If the bundle has not been
// built yet (fresh checkout), print the build command and fail.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = dirname(fileURLToPath(import.meta.url));
const bundle = join(pkgRoot, "dist", "cli.mjs");

if (!existsSync(bundle)) {
  console.error(`shoggoth CLI bundle missing: ${bundle}`);
  console.error("Build it once with: npm run build:cli");
  process.exit(1);
}

await import(pathToFileURL(bundle).href);
