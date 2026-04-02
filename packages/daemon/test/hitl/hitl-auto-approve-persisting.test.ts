import assert from "node:assert/strict";
import { describe, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HITL_CONFIG, loadLayeredConfig } from "@shoggoth/shared";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate.js";
import { createPersistingHitlAutoApproveGate } from "../../src/hitl/hitl-auto-approve-persisting.js";
import { createLogger } from "../../src/logging.js";
import { HITL_AGENT_TOOL_AUTO_APPROVE_FILENAME } from "../../src/hitl/hitl-agent-tool-auto-persist.js";

describe("createPersistingHitlAutoApproveGate", () => {
  it("persists session tools in SQLite and agent tools in layered JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "sh-hitl-persist-"));
    try {
      const dbPath = join(root, "state.db");
      const cfgDir = join(root, "cfg");
      const baseCfg = loadLayeredConfig(cfgDir);
      const configRef = { current: baseCfg };
      const hitlRef = { value: { ...DEFAULT_HITL_CONFIG, ...baseCfg.hitl } };
      const log = createLogger({ component: "t", minLevel: "error" });

      const sessionId = "agent:main:discord:10000000-0000-4000-8000-000000000001";

      {
        const db = new Database(dbPath);
        db.pragma("foreign_keys = ON");
        migrate(db, defaultMigrationsDir());
        const gate = createPersistingHitlAutoApproveGate({
          db,
          configDirectory: cfgDir,
          dynamicConfigDirectory: cfgDir,
          configRef,
          hitlRef,
          logger: log,
        });
        gate.enableSessionTool(sessionId, "builtin.write");
        assert.equal(gate.shouldAutoApprove(sessionId, "builtin.write"), true);
        db.close();
      }

      {
        const db = new Database(dbPath);
        db.pragma("foreign_keys = ON");
        const gate = createPersistingHitlAutoApproveGate({
          db,
          configDirectory: cfgDir,
          dynamicConfigDirectory: cfgDir,
          configRef,
          hitlRef,
          logger: log,
        });
        assert.equal(gate.shouldAutoApprove(sessionId, "builtin.write"), true);
        assert.equal(gate.shouldAutoApprove(sessionId, "other.tool"), false);

        gate.enableAgentTool("main", "memory.search");
        const zPath = join(cfgDir, HITL_AGENT_TOOL_AUTO_APPROVE_FILENAME);
        const raw = readFileSync(zPath, "utf8");
        assert.ok(raw.includes("memory.search"));
        assert.equal(gate.shouldAutoApprove(sessionId, "memory.search"), true);
        db.close();
      }

      {
        const db = new Database(dbPath);
        db.pragma("foreign_keys = ON");
        const gate = createPersistingHitlAutoApproveGate({
          db,
          configDirectory: cfgDir,
          dynamicConfigDirectory: cfgDir,
          configRef,
          hitlRef,
          logger: log,
        });
        gate.enableAgentTool("main", "builtin.write");
        assert.equal(gate.shouldAutoApprove(sessionId, "builtin.write"), true);
        assert.equal(gate.shouldAutoApprove(sessionId, "write"), false);
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
