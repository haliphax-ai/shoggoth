/**
 * Builds the operator CLI entry (`packages/cli/src/cli.ts`) to a single
 * self-contained `.mjs` bundle at `packages/cli/dist/cli.mjs`.
 * Bundling rationale and the CJS-interop banner: docs/cli.md — "Building the CLI".
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const cjsInteropBanner =
  'import { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);';

await build({
  absWorkingDir: repoRoot,
  entryPoints: [join(repoRoot, "packages/cli/src/cli.ts")],
  outfile: join(repoRoot, "packages/cli/dist/cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: { js: cjsInteropBanner },
  external: ["better-sqlite3", "zod", "undici", "age-encryption"],
});
