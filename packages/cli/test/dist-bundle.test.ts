import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(pkgRoot, "..", "..");
const bundlePath = join(pkgRoot, "dist", "cli.mjs");
const buildScript = join(repoRoot, "scripts", "build-cli.mjs");

let configDir: string;

beforeAll(() => {
  if (!existsSync(bundlePath)) {
    // Self-heal so the suite works from a fresh checkout without a build step.
    const build = spawnSync(process.execPath, [buildScript], { encoding: "utf8", cwd: repoRoot });
    if (build.status !== 0) {
      throw new Error(`Failed to build CLI bundle:\n${build.stderr || build.stdout}`);
    }
  }
  configDir = join(tmpdir(), `shoggoth-cli-bundle-test-${process.pid}-${Date.now()}`, "config.d");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "test.json"), "{}\n");
});

afterAll(() => {
  if (configDir) rmSync(dirname(configDir), { recursive: true, force: true });
});

/** Run the compiled bundle with an isolated config dir; cwd=repoRoot for node_modules resolution. */
function runBundle(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(process.execPath, [bundlePath, ...args], {
    encoding: "utf8",
    cwd: repoRoot,
    env: { ...process.env, SHOGGOTH_CONFIG_DIR: configDir },
  });
}

/** Run the TypeScript source under tsx, same environment — the dev-path oracle. */
function runSource(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    process.execPath,
    ["--import", "tsx/esm", join(pkgRoot, "src", "cli.ts"), ...args],
    {
      encoding: "utf8",
      cwd: repoRoot,
      env: { ...process.env, SHOGGOTH_CONFIG_DIR: configDir },
    },
  );
}

/**
 * The compiled bundle (the bin target) must stay in sync with the TypeScript
 * source (the dev path). These tests run both entries against the same
 * arguments and require identical results, so a bundling regression (missing
 * module, unresolved import, CJS interop failure) fails loudly instead of
 * surfacing as a broken CLI in production.
 */
describe("compiled CLI bundle parity", () => {
  it("prints the same version as the source entry", () => {
    const bundle = runBundle(["--version"]);
    const source = runSource(["--version"]);
    expect(bundle.status).toBe(0);
    expect(bundle.stdout).toBe(source.stdout);
  });

  it("prints the same top-level help as the source entry", () => {
    const bundle = runBundle(["--help"]);
    const source = runSource(["--help"]);
    expect(bundle.status).toBe(source.status);
    expect(bundle.stdout).toBe(source.stdout);
  });

  it("wires subcommand dispatch identically for skills --help", () => {
    const bundle = runBundle(["skills", "--help"]);
    const source = runSource(["skills", "--help"]);
    expect(bundle.status).toBe(source.status);
    expect(bundle.stdout).toBe(source.stdout);
  });

  it("loads config and the daemon library for skills list", () => {
    // Exercises the full import graph (shared config loader + daemon barrel),
    // which is where bundling regressions (externalized CJS deps, broken
    // module resolution) actually surface at runtime.
    const bundle = runBundle(["skills", "list"]);
    const source = runSource(["skills", "list"]);
    expect(bundle.status).toBe(source.status);
    expect(bundle.stdout).toBe(source.stdout);
    expect(bundle.status).toBe(0);
    const parsed = JSON.parse(bundle.stdout) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
  });
});
