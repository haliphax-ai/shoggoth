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
        return [`packages/${pkg}/test/**/*.test.ts`];
      }
      return ["packages/*/test/**/*.test.ts", "packages/*/packages/*/test/**/*.test.ts"];
    })(),
    onConsoleLog: () => false,
    pool: "forks",
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "packages/*/test/**",
        "packages/*/src/**/*.test.ts",
        "packages/*/src/**/*.d.ts",
        "packages/*/src/**/index.ts",
        "packages/*/packages/**",
      ],
      thresholds: {
        // Global minimums — prevent regressions across the codebase
        statements: 65,
        branches: 55,
        functions: 60,
        lines: 65,
        // Per-package thresholds for critical infrastructure
        "packages/messaging": {
          statements: 80,
          branches: 70,
          functions: 80,
          lines: 80,
        },
        "packages/mcp-integration": {
          statements: 75,
          branches: 65,
          functions: 75,
          lines: 75,
        },
        "packages/os-exec": {
          statements: 75,
          branches: 65,
          functions: 75,
          lines: 75,
        },
        "packages/shared": {
          statements: 75,
          branches: 65,
          functions: 75,
          lines: 75,
        },
      },
    },
  },
});
