/**
 * Integration tests for the re-read gate as cleared by builtin-read.
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import {
  BuiltinToolRegistry,
  type BuiltinToolContext,
} from "../../src/sessions/builtin-tool-registry";
import { register as registerFs } from "../../src/sessions/builtin-handlers/fs-handlers";
import { checkReReadRequired } from "../../src/sessions/re-read-required";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-read-reread-"));
  const dbPath = join(dir, "test.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

function makeCtx(
  db: Database.Database,
  workspacePath: string,
  sessionId = "s1",
): BuiltinToolContext {
  return {
    sessionId,
    db,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config: {} as any,
    env: process.env,
    workspacePath,
    creds: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 },
    orchestratorEnv: process.env,
    getAgentIntegrationInvoker: () => undefined,
    getProcessManager: () => undefined,
    messageToolCtx: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    memoryConfig: { paths: [], embeddings: { enabled: false } } as any,
    runtimeOpenaiBaseUrl: undefined,
    isSubagentSession: false,
  };
}

function flag(db: Database.Database, sessionId: string, segmentId: string, filePath: string): void {
  db.prepare(
    "INSERT INTO re_read_required (session_id, context_segment_id, file_path) VALUES (?, ?, ?)",
  ).run(sessionId, segmentId, filePath);
}

describe("read handler re-read clear", () => {
  let db: Database.Database;
  let tmp: string;
  let wsPath: string;
  let registry: BuiltinToolRegistry;
  let ctx: BuiltinToolContext;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    wsPath = join(tmp, "workspace");
    mkdirSync(wsPath, { recursive: true });
    createSessionStore(db).create({ id: "s1", workspacePath: wsPath });

    registry = new BuiltinToolRegistry();
    registerFs(registry);
    ctx = makeCtx(db, wsPath);
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("clears the flag after a successful read", async () => {
    writeFileSync(join(wsPath, "f.txt"), "hello");
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    flag(db, "s1", segment, join(wsPath, "f.txt"));

    await registry.execute("read", { path: "f.txt" }, ctx);

    const gate = checkReReadRequired(db, "s1", segment, join(wsPath, "f.txt"));
    assert.equal(gate, null);
  });

  it("does not clear flags from a previous segment", async () => {
    writeFileSync(join(wsPath, "f.txt"), "hello");
    flag(db, "s1", "old-segment", join(wsPath, "f.txt"));

    await registry.execute("read", { path: "f.txt" }, ctx);

    const row = db
      .prepare(
        "SELECT 1 AS hit FROM re_read_required WHERE session_id = ? AND context_segment_id = ? AND file_path = ?",
      )
      .get("s1", "old-segment", join(wsPath, "f.txt")) as { hit: number } | undefined;
    assert.ok(row, "old segment row must survive");
  });

  it("clears flags for each file when reading multiple files at once", async () => {
    writeFileSync(join(wsPath, "a.txt"), "A");
    writeFileSync(join(wsPath, "b.txt"), "B");
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    flag(db, "s1", segment, join(wsPath, "a.txt"));
    flag(db, "s1", segment, join(wsPath, "b.txt"));

    await registry.execute("read", { paths: ["a.txt", "b.txt"] }, ctx);

    assert.equal(checkReReadRequired(db, "s1", segment, join(wsPath, "a.txt")), null);
    assert.equal(checkReReadRequired(db, "s1", segment, join(wsPath, "b.txt")), null);
  });

  it("does not clear when reading a different file", async () => {
    writeFileSync(join(wsPath, "a.txt"), "A");
    writeFileSync(join(wsPath, "b.txt"), "B");
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    flag(db, "s1", segment, join(wsPath, "a.txt"));

    await registry.execute("read", { path: "b.txt" }, ctx);

    const gate = checkReReadRequired(db, "s1", segment, join(wsPath, "a.txt"));
    assert.ok(gate, "flag for a.txt must survive reading b.txt");
  });
});
