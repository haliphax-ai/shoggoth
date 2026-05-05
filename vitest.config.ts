import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, relative } from "node:path";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: rootDir,
  poolOptions: {
    forks: {
      maxForks: 4,
    },
  },
  test: {
    // When run from inside a package (e.g. via --workspace), narrow to that
    // package only. When run from root, include all packages.
    include: (() => {
      const rel = relative(rootDir, process.cwd());
      if (rel.startsWith("packages/")) {
        const pkg = rel.split("/")[1];
        return [`packages/${pkg}/test/**/*.test.ts`, `packages/${pkg}/src/tools/test/**/*.test.ts`];
      }
      return ["packages/*/test/**/*.test.ts", "packages/*/src/tools/test/**/*.test.ts"];
    })(),
    onConsoleLog: () => false,
    pool: "forks",
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
  },
});
