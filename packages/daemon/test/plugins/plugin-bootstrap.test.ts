import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import { defaultConfig, type ShoggothConfig } from "@shoggoth/shared";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createDaemonRuntime } from "../../src/runtime";
import { bootstrapPlugins } from "../../src/plugins/bootstrap";

describe("bootstrapPlugins", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
    delete (globalThis as { __shoggothPlugTest?: number }).__shoggothPlugTest;
  });

  it("audits effective config, runs startup hooks, audits unload matching load on shutdown", async () => {
    const base = mkdtempSync(join(tmpdir(), "sh-plugboot-"));
    dirs.push(base);
    const cfgDir = join(base, "cfg");
    mkdirSync(cfgDir);
    const pluginDir = join(base, "plug");
    mkdirSync(pluginDir);

    writeFileSync(
      join(pluginDir, "shoggoth.json"),
      JSON.stringify({
        name: "tplug",
        version: "0.1.0",
        hooks: {
          "daemon.startup": "./s.mjs",
          "daemon.shutdown": "./d.mjs",
        },
      }),
    );
    writeFileSync(
      join(pluginDir, "s.mjs"),
      `export default () => { globalThis.__shoggothPlugTest = (globalThis.__shoggothPlugTest ?? 0) + 1; };`,
    );
    writeFileSync(join(pluginDir, "d.mjs"), `export default () => {};`);

    const config: ShoggothConfig = {
      ...defaultConfig(cfgDir),
      configDirectory: cfgDir,
      plugins: [{ id: "my-plugin", path: pluginDir }],
    };

    const dbPath = join(base, "state.db");
    const db = openStateDb(dbPath);
    migrate(db, defaultMigrationsDir());

    const rt = createDaemonRuntime({
      logLevel: "error",
      shutdown: {
        drainTimeoutMs: 10_000,
      },
    });

    try {
      await bootstrapPlugins({
        config,
        db,
        rt,
        resolveFromFile: fileURLToPath(import.meta.url),
      });

      assert.strictEqual((globalThis as { __shoggothPlugTest?: number }).__shoggothPlugTest, 1);

      const rows = db
        .prepare(`SELECT action, resource, outcome FROM audit_log ORDER BY id ASC`)
        .all() as { action: string; resource: string | null; outcome: string }[];

      assert.ok(
        rows.some(
          (r) => r.action === "config.effective_loaded" && r.outcome === "success",
        ),
      );
      assert.ok(
        rows.some(
          (r) =>
            r.action === "plugin.load" &&
            r.resource === "my-plugin" &&
            r.outcome === "success",
        ),
      );

      await rt.shutdown.requestShutdown("SIGTEST");

      const rowsAfter = db
        .prepare(`SELECT action, resource, outcome FROM audit_log ORDER BY id ASC`)
        .all() as { action: string; resource: string | null; outcome: string }[];

      assert.ok(
        rowsAfter.some(
          (r) =>
            r.action === "plugin.unload" &&
            r.resource === "my-plugin" &&
            r.outcome === "success",
        ),
      );
    } finally {
      rt.disposeSignals();
      db.close();
    }
  });
});
