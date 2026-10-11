/**
 * Tests for the depth-aware `builtin-subagent` tool strip finalizer.
 *
 * The finalizer mirrors the maxSpawnDepth nesting gate in the `subagent` tool
 * handler: it strips the tool only when spawning would be denied at the
 * session's lineage depth. Depth is computed from session lineage
 * (parent_session_id), not URN shape — with maxSpawnDepth >= 2 a depth-1
 * subagent keeps the tool so it can spawn its own children. Unresolvable
 * lineage degrades to strip, matching the handler's deny-by-default.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  formatAgentSessionUrn,
  mintSubagentSessionUrnFromParent,
  SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
  type ShoggothConfig,
} from "@shoggoth/shared";
import {
  buildBuiltinOnlySessionMcpToolContext,
  createSubagentToolStripFinalizer,
  type SessionMcpToolContext,
} from "../../src/sessions/session-mcp-tool-context";
import { createSessionStore } from "../../src/sessions/session-store";
import { migrate, defaultMigrationsDir } from "../../src/db/migrate";

function hasSubagentTool(ctx: SessionMcpToolContext): boolean {
  return ctx.aggregated.tools.some((t) => t.namespacedName === "builtin-subagent");
}

describe("createSubagentToolStripFinalizer", () => {
  let db: Database.Database;
  let dir: string;
  let topId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "subagent-tool-strip-"));
    db = new Database(join(dir, "state.db"));
    migrate(db, defaultMigrationsDir());
    topId = formatAgentSessionUrn(
      "par",
      "discord",
      "channel",
      SHOGGOTH_DEFAULT_PRIMARY_SESSION_UUID,
    );
    const sessions = createSessionStore(db);
    sessions.create({ id: topId, workspacePath: dir, status: "active" });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function createSubagentRow(parentId: string): string {
    const sessions = createSessionStore(db);
    const id = mintSubagentSessionUrnFromParent(parentId);
    sessions.create({ id, workspacePath: dir, status: "active" });
    sessions.update(id, { parentSessionId: parentId });
    return id;
  }

  it("top-level session always keeps builtin-subagent", () => {
    const finalizer = createSubagentToolStripFinalizer(db, {} as ShoggothConfig);
    const ctx = finalizer(buildBuiltinOnlySessionMcpToolContext(), topId);
    assert.ok(hasSubagentTool(ctx));
  });

  it("default config (maxSpawnDepth unset = 1): depth-1 subagent is stripped", () => {
    const childId = createSubagentRow(topId);
    const finalizer = createSubagentToolStripFinalizer(db, {} as ShoggothConfig);
    const ctx = finalizer(buildBuiltinOnlySessionMcpToolContext(), childId);
    assert.ok(!hasSubagentTool(ctx));
  });

  it("maxSpawnDepth 2: depth-1 subagent keeps builtin-subagent", () => {
    const childId = createSubagentRow(topId);
    const finalizer = createSubagentToolStripFinalizer(db, { maxSpawnDepth: 2 } as ShoggothConfig);
    const ctx = finalizer(buildBuiltinOnlySessionMcpToolContext(), childId);
    assert.ok(hasSubagentTool(ctx));
  });

  it("maxSpawnDepth 2: depth-2 subagent is stripped", () => {
    const childId = createSubagentRow(topId);
    const grandchildId = createSubagentRow(childId);
    const finalizer = createSubagentToolStripFinalizer(db, { maxSpawnDepth: 2 } as ShoggothConfig);
    const ctx = finalizer(buildBuiltinOnlySessionMcpToolContext(), grandchildId);
    assert.ok(!hasSubagentTool(ctx));
  });

  it("per-agent maxSpawnDepth overrides the top-level default", () => {
    const childId = createSubagentRow(topId);
    const config = {
      agents: { list: { par: { maxSpawnDepth: 2 } } },
    } as unknown as ShoggothConfig;
    const finalizer = createSubagentToolStripFinalizer(db, config);
    const ctx = finalizer(buildBuiltinOnlySessionMcpToolContext(), childId);
    assert.ok(hasSubagentTool(ctx));
  });

  it("unresolvable lineage (missing session row) degrades to strip", () => {
    // Subagent URN whose session row was never created — depth is -1.
    const ghost = mintSubagentSessionUrnFromParent(topId);
    const finalizer = createSubagentToolStripFinalizer(db, { maxSpawnDepth: 2 } as ShoggothConfig);
    const ctx = finalizer(buildBuiltinOnlySessionMcpToolContext(), ghost);
    assert.ok(!hasSubagentTool(ctx));
  });
});
