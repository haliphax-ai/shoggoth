/**
 * Builds the operator CLI entry (`packages/cli/src/cli.ts`) to a single
 * self-contained `.mjs` bundle at `packages/cli/dist/cli.mjs`.
 *
 * Workspace packages export raw TypeScript sources (their `exports` point at
 * `./src/*.ts`), so a bare-node build cannot resolve cross-package imports
 * without a TypeScript loader. Bundling inlines those workspace sources into
 * the output, which lets the published bin run under plain `node` with no
 * `tsx` loader and no spawn wrapper.
 *
 * Dependencies installed from the registry are `external` and resolved from
 * `node_modules` at runtime, exactly as today.
 *
 * `--banner:js` shims CommonJS interop: esbuild's ESM output throws on
 * `require()` calls reached through CJS dependency graphs (e.g.
 * better-sqlite3). Providing a real `require` avoids that.
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
