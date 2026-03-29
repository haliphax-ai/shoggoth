#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgRoot = dirname(fileURLToPath(import.meta.url));
const entry = join(pkgRoot, "src", "cli.ts");
const result = spawnSync(
  execPath,
  ["--import", "tsx/esm", entry, ...process.argv.slice(2)],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status === null ? 1 : result.status);
