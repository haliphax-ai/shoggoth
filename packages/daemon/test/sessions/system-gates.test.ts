// ---------------------------------------------------------------------------
// createSystemGates — configurable system gates for external (MCP) tools.
//
// RED today: `packages/daemon/src/sessions/system-gates.ts` does not exist, so
// the value import below fails to resolve — the module-level RED state. GREEN
// adds `createSystemGates(deps)` implementing the pre/post hook contract
// described in tmp/system-gates-research.md (AGENTS.md discovery gate and
// re-read-required gate applied to config.gates.*.tools globs).
//
// Follows the fixture pattern of `agents-md-gate.test.ts` (openStateDb +
// migrate + tmp workspace + createSessionStore).
// ---------------------------------------------------------------------------
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore, getSessionContextSegmentId } from "../../src/sessions/session-store";
import {
  checkReReadRequired,
  clearReReadRequired,
  markReReadRequired,
} from "../../src/sessions/re-read-required";
import { createSystemGates } from "../../src/sessions/system-gates";
import { defaultConfig, type ShoggothConfig, type ShoggothGatesConfig } from "@shoggoth/shared";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-system-gates-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

function configWithGates(ws: string, gates: ShoggothGatesConfig): ShoggothConfig {
  return { ...defaultConfig(ws), gates } as ShoggothConfig;
}

describe("createSystemGates", () => {
  let db: Database.Database;
  let tmp: string;
  let wsPath: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    wsPath = join(tmp, "workspace");
    mkdirSync(wsPath, { recursive: true });
    createSessionStore(db).create({ id: "s1", workspacePath: wsPath });
  });

  afterEach(async () => {
    await closeTestDb(db, tmp);
  });

  // ---------------------------------------------------------------------
  // AGENTS.md discovery gate
  // ---------------------------------------------------------------------

  it("gates a matching external tool call when AGENTS.md is unread, then passes after seen", async () => {
    const subDir = join(wsPath, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "AGENTS.md"), "# Sub instructions");
    const seg = getSessionContextSegmentId(db, "s1");

    const hooks = createSystemGates({
      db,
      sessionId: "s1",
      contextSegmentId: seg,
      workspacePath: wsPath,
      config: configWithGates(wsPath, {
        agentsMd: { tools: ["demo_ext-*"] },
        reRead: { tools: [] },
      }),
      getWorkingDirectory: () => subDir,
    });

    const first = await hooks.pre({
      toolName: "demo_ext-write",
      args: {},
      toolCallId: "t1",
    });
    assert.ok(first, "first call on a matching tool must be gated");
    const body = JSON.parse(first!.resultJson) as {
      gated: boolean;
      files: readonly { path: string; content: string }[];
    };
    assert.equal(body.gated, true);
    assert.equal(body.files.length, 1);
    assert.equal(body.files[0].content, "# Sub instructions");

    // Marked seen on return — retry passes through.
    const second = await hooks.pre({
      toolName: "demo_ext-write",
      args: {},
      toolCallId: "t2",
    });
    assert.strictEqual(second, null, "second call after seen must not gate");
  });

  it("does not gate non-matching tool names and leaves AGENTS.md unseen", async () => {
    const subDir = join(wsPath, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "AGENTS.md"), "# Sub instructions");
    const seg = getSessionContextSegmentId(db, "s1");

    const hooks = createSystemGates({
      db,
      sessionId: "s1",
      contextSegmentId: seg,
      workspacePath: wsPath,
      config: configWithGates(wsPath, {
        agentsMd: { tools: ["demo_ext-*"] },
        reRead: { tools: [] },
      }),
      getWorkingDirectory: () => subDir,
    });

    const nonMatch = await hooks.pre({
      toolName: "other-tool",
      args: {},
      toolCallId: "t1",
    });
    assert.strictEqual(nonMatch, null, "non-matching tool must not be gated");

    // AGENTS.md must remain unseen — the first matching call still gates.
    const match = await hooks.pre({
      toolName: "demo_ext-write",
      args: {},
      toolCallId: "t2",
    });
    assert.ok(match, "AGENTS.md must still gate on the first matching call");
  });

  // ---------------------------------------------------------------------
  // re-read-required gate — consumer
  // ---------------------------------------------------------------------

  it("gates a matching tool when args name a file flagged re_read_required", async () => {
    writeFileSync(join(wsPath, "f.txt"), "a\nb\n");
    const seg = getSessionContextSegmentId(db, "s1");
    markReReadRequired(db, "s1", seg, join(wsPath, "f.txt"));

    const hooks = createSystemGates({
      db,
      sessionId: "s1",
      contextSegmentId: seg,
      workspacePath: wsPath,
      config: configWithGates(wsPath, {
        agentsMd: { tools: [] },
        reRead: { tools: ["demo_ext-*"] },
      }),
      getWorkingDirectory: () => wsPath,
    });

    const r = await hooks.pre({
      toolName: "demo_ext-edit",
      args: { path: "f.txt" },
      toolCallId: "t1",
    });
    assert.ok(r, "flagged file referenced by a matching tool must be gated");
    const body = JSON.parse(r!.resultJson) as { gated: boolean; filePath: string };
    assert.equal(body.gated, true);
    assert.equal(body.filePath, join(wsPath, "f.txt"));
  });

  // ---------------------------------------------------------------------
  // re-read-required gate — producer (post) line-shift detection
  // ---------------------------------------------------------------------

  it("marks a file as re-read-required when an external tool changes its line count", async () => {
    const seg = getSessionContextSegmentId(db, "s1");
    const gPath = join(wsPath, "g.txt");
    writeFileSync(gPath, "a\nb\nc\n");

    const hooks = createSystemGates({
      db,
      sessionId: "s1",
      contextSegmentId: seg,
      workspacePath: wsPath,
      config: configWithGates(wsPath, {
        agentsMd: { tools: [] },
        reRead: { tools: ["demo_ext-*"] },
      }),
      getWorkingDirectory: () => wsPath,
    });

    // pre on an unflagged file → no gate, but a line-count snapshot is taken.
    const pre1 = await hooks.pre({
      toolName: "demo_ext-edit",
      args: { path: "g.txt" },
      toolCallId: "g1",
    });
    assert.strictEqual(pre1, null);

    // Simulate the external tool rewriting the file (3 → 5 lines).
    writeFileSync(gPath, "a\nb\nc\nd\ne\n");
    await hooks.post({
      toolName: "demo_ext-edit",
      args: { path: "g.txt" },
      toolCallId: "g1",
      resultJson: "{}",
    });

    assert.ok(
      checkReReadRequired(db, "s1", seg, gPath),
      "line count change must mark the file re-read-required",
    );

    // Re-read clears the flag; a subsequent call with an UNCHANGED file must
    // not re-mark it.
    clearReReadRequired(db, "s1", seg, gPath);
    assert.strictEqual(checkReReadRequired(db, "s1", seg, gPath), null);

    const pre2 = await hooks.pre({
      toolName: "demo_ext-edit",
      args: { path: "g.txt" },
      toolCallId: "g2",
    });
    assert.strictEqual(pre2, null);
    await hooks.post({
      toolName: "demo_ext-edit",
      args: { path: "g.txt" },
      toolCallId: "g2",
      resultJson: "{}",
    });
    assert.strictEqual(
      checkReReadRequired(db, "s1", seg, gPath),
      null,
      "unchanged file must not be marked",
    );
  });
});
