/**
 * Integration tests for the re-read gate as enforced by builtin-write.
 *
 * Covers the consumer side (write is blocked when the file is flagged)
 * and the producer side is intentionally not tested here, since `write`
 * never adds to the re-read list (per spec).
 */
import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-write-reread-"));
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

describe("write handler re-read consumer", () => {
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

  it("blocks write when the file is already flagged", async () => {
    writeFileSync(join(wsPath, "f.txt"), "old content");
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    db.prepare(
      "INSERT INTO re_read_required (session_id, context_segment_id, file_path) VALUES (?, ?, ?)",
    ).run("s1", segment, join(wsPath, "f.txt"));

    const result = await registry.execute("write", { path: "f.txt", content: "new content" }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.equal(json.gated, true, "should be gated by re-read");
    assert.equal(json.filePath, join(wsPath, "f.txt"));
    assert.equal(readFileSync(join(wsPath, "f.txt"), "utf8"), "old content");
  });

  it("blocks append when the file is already flagged", async () => {
    writeFileSync(join(wsPath, "log.txt"), "line1\n");
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    db.prepare(
      "INSERT INTO re_read_required (session_id, context_segment_id, file_path) VALUES (?, ?, ?)",
    ).run("s1", segment, join(wsPath, "log.txt"));

    const result = await registry.execute(
      "write",
      { path: "log.txt", content: "line2\n", append: true },
      ctx,
    );
    const json = JSON.parse(result.resultJson);
    assert.equal(json.gated, true);
    assert.equal(readFileSync(join(wsPath, "log.txt"), "utf8"), "line1\n");
  });

  it("allows write when only a previous segment flagged the path", async () => {
    // A previous segment's flag is invisible to the current segment.
    db.prepare(
      "INSERT INTO re_read_required (session_id, context_segment_id, file_path) VALUES (?, ?, ?)",
    ).run("s1", "old-segment", join(wsPath, "f.txt"));

    const result = await registry.execute("write", { path: "f.txt", content: "fresh" }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.equal(json.gated, undefined);
    assert.equal(json.ok, true);
  });

  it("allows write to a different file when only an unrelated file is flagged", async () => {
    writeFileSync(join(wsPath, "other.txt"), "x");
    writeFileSync(join(wsPath, "f.txt"), "old");
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    db.prepare(
      "INSERT INTO re_read_required (session_id, context_segment_id, file_path) VALUES (?, ?, ?)",
    ).run("s1", segment, join(wsPath, "other.txt"));

    const result = await registry.execute("write", { path: "f.txt", content: "new" }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.equal(json.gated, undefined);
    assert.equal(json.ok, true);
  });

  it("does not add to the re-read list (write is not a producer)", async () => {
    const result = await registry.execute("write", { path: "f.txt", content: "x" }, ctx);
    const json = JSON.parse(result.resultJson);
    assert.equal(json.ok, true);
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    const gate = checkReReadRequired(db, "s1", segment, join(wsPath, "f.txt"));
    assert.equal(gate, null);
  });
});
