#!/usr/bin/env node
/* eslint-env node */
// Launcher for the compiled CLI bundle (dist/cli.mjs): runs it directly — no
// child process, no tsx startup cost. Prints the build command if unbuilt.
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
