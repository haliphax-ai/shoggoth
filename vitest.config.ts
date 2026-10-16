import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, relative } from "node:path";

const rootDir = dirname(fileURLToPath(import.meta.url));

// When run from inside a package (e.g. via --workspace), narrow to that
// package only. When run from root, include all packages.
const cwdRel = relative(rootDir, process.cwd());
const currentPkg = cwdRel.startsWith("packages/") ? cwdRel.split("/")[1] : undefined;

const baseIncludes = currentPkg
  ? [`packages/${currentPkg}/test/**/*.test.ts`]
  : [
      "packages/*/test/**/*.test.ts",
      "packages/*/packages/*/test/**/*.test.ts",
      "docker/test/**/*.test.ts",
    ];

// Test files that rely on `vi.mock` interception of app modules or node builtins.
// Under a shared module registry (isolate:false) the mock is defeated by whichever
// file imports the real module first, so these files are order-dependent and fail
// intermittently when the suite runs shared. They are quarantined into the
// `quarantine` project below (isolate:true) until they are refactored to inject
// their seams (github.com/haliphax-ai/shoggoth/issues/479). Remove an entry once
// its file has a DI seam and passes in the shared pool.
const quarantineGlobs = [
  "packages/daemon/test/builtin-handlers/exec-handler.test.ts",
  "packages/daemon/test/builtin-handlers/web-search-handler.test.ts",
  "packages/daemon/test/decision/decision-control-op.test.ts",
  "packages/daemon/test/media/*.test.ts",
  "packages/daemon/test/messaging/inbound-session-turn.test.ts",
  "packages/daemon/test/messaging/inbound-session-turn-status-bar.test.ts",
  "packages/daemon/test/mcp/mcp-server-pool.test.ts",
  "packages/daemon/test/presentation/attachment-download.test.ts",
  "packages/daemon/test/presentation/image-ingest.test.ts",
  "packages/daemon/test/presentation/turn-orchestrator.test.ts",
  "packages/daemon/test/rerank/rerank-control-op.test.ts",
  "packages/daemon/test/sessions/session-manager.test.ts",
  "packages/daemon/test/sessions/builtin-handlers/vault-inject.test.ts",
  "packages/mcp-integration/test/mcp-jsonrpc-transport.test.ts",
  "packages/mcp-integration/test/mcp-streamable-http-transport.test.ts",
  "packages/mcp-integration/test/mcp-stdio-agent-identity.test.ts",
];

const activeQuarantine = currentPkg
  ? quarantineGlobs.filter((p) => p.startsWith(`packages/${currentPkg}/`))
  : quarantineGlobs;

export default defineConfig({
  cacheDir: ".vite",
  root: rootDir,
  poolOptions: {
    forks: {
      maxForks: process.env.CI ? 4 : 8,
    },
  },
  test: {
    onConsoleLog: () => false,
    pool: "forks",
    maxWorkers: process.env.CI ? 4 : 8,
    setupFiles: ["./test/setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Most tests run in a shared module registry (isolate:false) for speed. Only
    // the vi.mock-heavy files above need isolation; they run in the `quarantine`
    // project. Run WITHOUT `--no-isolate` so this split is honored (the CLI flag
    // would force isolate:false everywhere and defeat the quarantine).
    // NOTE: vitest does NOT inherit root-level `test.*` scalar options into
    // `projects`, so pool/timeouts/setup are repeated per project below.
    projects: [
      {
        test: {
          name: "shared",
          include: baseIncludes,
          exclude: activeQuarantine,
          isolate: false,
          onConsoleLog: () => false,
          pool: "forks",
          maxWorkers: process.env.CI ? 4 : 8,
          setupFiles: ["./test/setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "quarantine",
          include: activeQuarantine,
          isolate: true,
          onConsoleLog: () => false,
          pool: "forks",
          maxWorkers: process.env.CI ? 4 : 8,
          setupFiles: ["./test/setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
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
