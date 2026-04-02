import assert from "node:assert/strict";
import { describe, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HITL_CONFIG, loadLayeredConfig } from "@shoggoth/shared";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate.js";
import { createPersistingHitlAutoApproveGate } from "../../src/hitl/hitl-auto-approve-persisting.js";
import { createHitlAutoApproveGate } from "../../src/hitl/hitl-auto-approve.js";
import { createLogger } from "../../src/logging.js";

describe("subagent HITL auto-approve inheritance", () => {
  describe("createPersistingHitlAutoApproveGate", () => {
    it("subagent inherits session-scoped auto-approve from main session", () => {
      const root = mkdtempSync(join(tmpdir(), "sh-hitl-sub-"));
      try {
        const dbPath = join(root, "state.db");
        const cfgDir = join(root, "cfg");
        const baseCfg = loadLayeredConfig(cfgDir);
        const configRef = { current: baseCfg };
        const hitlRef = { value: { ...DEFAULT_HITL_CONFIG, ...baseCfg.hitl } };
        const log = createLogger({ component: "t", minLevel: "error" });

        const mainSessionId = "agent:main:discord:10000000-0000-4000-8000-000000000001";
        const subagentSessionId = "agent:main:discord:10000000-0000-4000-8000-000000000001:aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";

        const db = new Database(dbPath);
        db.pragma("foreign_keys = ON");
        migrate(db, defaultMigrationsDir());

        const gate = createPersistingHitlAutoApproveGate({
          db,
          configDirectory: cfgDir,
          configRef,
          hitlRef,
          logger: log,
        });

        // Main session approves a tool
        gate.enableSessionTool(mainSessionId, "builtin.write");

        // Main session should auto-approve
        assert.equal(gate.shouldAutoApprove(mainSessionId, "builtin.write"), true);

        // Subagent session should inherit the main session's approval
        assert.equal(gate.shouldAutoApprove(subagentSessionId, "builtin.write"), true);

        // Unrelated tool should not be auto-approved
        assert.equal(gate.shouldAutoApprove(subagentSessionId, "builtin.exec"), false);

        db.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("subagent does not inherit from a different agent's main session", () => {
      const root = mkdtempSync(join(tmpdir(), "sh-hitl-sub-cross-"));
      try {
        const dbPath = join(root, "state.db");
        const cfgDir = join(root, "cfg");
        const baseCfg = loadLayeredConfig(cfgDir);
        const configRef = { current: baseCfg };
        const hitlRef = { value: { ...DEFAULT_HITL_CONFIG, ...baseCfg.hitl } };
        const log = createLogger({ component: "t", minLevel: "error" });

        const mainSessionA = "agent:alpha:discord:10000000-0000-4000-8000-000000000001";
        const subagentSessionB = "agent:beta:discord:20000000-0000-4000-8000-000000000001:aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";

        const db = new Database(dbPath);
        db.pragma("foreign_keys = ON");
        migrate(db, defaultMigrationsDir());

        const gate = createPersistingHitlAutoApproveGate({
          db,
          configDirectory: cfgDir,
          configRef,
          hitlRef,
          logger: log,
        });

        // Agent alpha's main session approves a tool
        gate.enableSessionTool(mainSessionA, "builtin.write");

        // Agent beta's subagent should NOT inherit alpha's approval
        assert.equal(gate.shouldAutoApprove(subagentSessionB, "builtin.write"), false);

        db.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("subagent's own session-scoped approval also works", () => {
      const root = mkdtempSync(join(tmpdir(), "sh-hitl-sub-own-"));
      try {
        const dbPath = join(root, "state.db");
        const cfgDir = join(root, "cfg");
        const baseCfg = loadLayeredConfig(cfgDir);
        const configRef = { current: baseCfg };
        const hitlRef = { value: { ...DEFAULT_HITL_CONFIG, ...baseCfg.hitl } };
        const log = createLogger({ component: "t", minLevel: "error" });

        const subagentSessionId = "agent:main:discord:10000000-0000-4000-8000-000000000001:aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";

        const db = new Database(dbPath);
        db.pragma("foreign_keys = ON");
        migrate(db, defaultMigrationsDir());

        const gate = createPersistingHitlAutoApproveGate({
          db,
          configDirectory: cfgDir,
          configRef,
          hitlRef,
          logger: log,
        });

        // Subagent's own session approves a tool
        gate.enableSessionTool(subagentSessionId, "builtin.exec");

        assert.equal(gate.shouldAutoApprove(subagentSessionId, "builtin.exec"), true);
        assert.equal(gate.shouldAutoApprove(subagentSessionId, "builtin.write"), false);

        db.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("agent-scoped approval works for subagent sessions", () => {
      const root = mkdtempSync(join(tmpdir(), "sh-hitl-sub-agent-"));
      try {
        const dbPath = join(root, "state.db");
        const cfgDir = join(root, "cfg");
        const baseCfg = loadLayeredConfig(cfgDir);
        const configRef = { current: baseCfg };
        const hitlRef = { value: { ...DEFAULT_HITL_CONFIG, ...baseCfg.hitl } };
        const log = createLogger({ component: "t", minLevel: "error" });

        const subagentSessionId = "agent:main:discord:10000000-0000-4000-8000-000000000001:aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";

        const db = new Database(dbPath);
        db.pragma("foreign_keys = ON");
        migrate(db, defaultMigrationsDir());

        const gate = createPersistingHitlAutoApproveGate({
          db,
          configDirectory: cfgDir,
          configRef,
          hitlRef,
          logger: log,
        });

        // Agent-scoped approval
        gate.enableAgentTool("main", "builtin.write");

        // Subagent should inherit agent-scoped approval
        assert.equal(gate.shouldAutoApprove(subagentSessionId, "builtin.write"), true);

        db.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("createHitlAutoApproveGate (in-memory)", () => {
    it("subagent inherits session-scoped auto-approve from main session", () => {
      const gate = createHitlAutoApproveGate();
      const mainSessionId = "agent:main:discord:10000000-0000-4000-8000-000000000001";
      const subagentSessionId = "agent:main:discord:10000000-0000-4000-8000-000000000001:aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";

      gate.enableSessionTool(mainSessionId, "builtin.write");

      assert.equal(gate.shouldAutoApprove(mainSessionId, "builtin.write"), true);
      assert.equal(gate.shouldAutoApprove(subagentSessionId, "builtin.write"), true);
      assert.equal(gate.shouldAutoApprove(subagentSessionId, "builtin.exec"), false);
    });

    it("subagent does not inherit from a different agent's main session", () => {
      const gate = createHitlAutoApproveGate();
      const mainSessionA = "agent:alpha:discord:10000000-0000-4000-8000-000000000001";
      const subagentSessionB = "agent:beta:discord:20000000-0000-4000-8000-000000000001:aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";

      gate.enableSessionTool(mainSessionA, "builtin.write");

      assert.equal(gate.shouldAutoApprove(subagentSessionB, "builtin.write"), false);
    });

    it("top-level session does not inherit from subagent", () => {
      const gate = createHitlAutoApproveGate();
      const mainSessionId = "agent:main:discord:10000000-0000-4000-8000-000000000001";
      const subagentSessionId = "agent:main:discord:10000000-0000-4000-8000-000000000001:aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee";

      gate.enableSessionTool(subagentSessionId, "builtin.write");

      // Subagent's own approval works
      assert.equal(gate.shouldAutoApprove(subagentSessionId, "builtin.write"), true);
      // Main session should NOT inherit from subagent
      assert.equal(gate.shouldAutoApprove(mainSessionId, "builtin.write"), false);
    });
  });
});
