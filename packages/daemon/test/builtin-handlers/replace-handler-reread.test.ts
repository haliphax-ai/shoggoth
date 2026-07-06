/**
 * Integration tests for the re-read gate as enforced by builtin-replace.
 *
 * Covers the producer side (replace flags the file when line numbers may
 * have shifted) and the consumer side (replace is blocked when the file
 * is already flagged).
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
import { register as registerReplace } from "../../src/sessions/builtin-handlers/replace-handler";
import { checkReReadRequired } from "../../src/sessions/re-read-required";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-replace-reread-"));
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

describe("replace-handler re-read producer", () => {
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
    registerReplace(registry);
    ctx = makeCtx(db, wsPath);
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("flags the file when the line count increases", async () => {
    writeFileSync(join(wsPath, "f.txt"), "a\nb\nc\n");
    await registry.execute("replace", { path: "f.txt", pattern: "b", replacement: "b1\nb2" }, ctx);
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    const gate = checkReReadRequired(db, "s1", segment, join(wsPath, "f.txt"));
    assert.ok(gate, "file should be flagged after line count change");
  });

  it("does not flag when the line count is unchanged", async () => {
    writeFileSync(join(wsPath, "f.txt"), "hello world\n");
    await registry.execute(
      "replace",
      { path: "f.txt", pattern: "world", replacement: "planet" },
      ctx,
    );
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    const gate = checkReReadRequired(db, "s1", segment, join(wsPath, "f.txt"));
    assert.equal(gate, null);
  });

  it("does not flag when the pattern does not match (zero replacements)", async () => {
    writeFileSync(join(wsPath, "f.txt"), "hello\n");
    await registry.execute(
      "replace",
      { path: "f.txt", pattern: "nope", replacement: "anything" },
      ctx,
    );
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    const gate = checkReReadRequired(db, "s1", segment, join(wsPath, "f.txt"));
    assert.equal(gate, null);
  });

  it("does not flag on dryRun", async () => {
    writeFileSync(join(wsPath, "f.txt"), "a\nb\nc\n");
    await registry.execute(
      "replace",
      { path: "f.txt", pattern: "b", replacement: "b1\nb2", dryRun: true },
      ctx,
    );
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    const gate = checkReReadRequired(db, "s1", segment, join(wsPath, "f.txt"));
    assert.equal(gate, null);
    assert.equal(readFileSync(join(wsPath, "f.txt"), "utf8"), "a\nb\nc\n");
  });

  it("deleteLines flags when the line count changes", async () => {
    writeFileSync(join(wsPath, "f.txt"), "a\nb\nc\nd\n");
    await registry.execute("replace", { path: "f.txt", deleteLines: 2 }, ctx);
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    const gate = checkReReadRequired(db, "s1", segment, join(wsPath, "f.txt"));
    assert.ok(gate);
  });

  it("replaceRange flags when the replacement line count differs", async () => {
    writeFileSync(join(wsPath, "f.txt"), "a\nb\nc\nd\n");
    await registry.execute(
      "replace",
      {
        path: "f.txt",
        replaceRange: { start: 2, end: 2 },
        replacement: "b1\nb2\nb3",
      },
      ctx,
    );
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    const gate = checkReReadRequired(db, "s1", segment, join(wsPath, "f.txt"));
    assert.ok(gate);
  });

  it("replaceRange does not flag when the replacement has the same line count", async () => {
    writeFileSync(join(wsPath, "f.txt"), "a\nb\nc\nd\n");
    await registry.execute(
      "replace",
      {
        path: "f.txt",
        replaceRange: { start: 2, end: 2 },
        replacement: "B",
      },
      ctx,
    );
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    const gate = checkReReadRequired(db, "s1", segment, join(wsPath, "f.txt"));
    assert.equal(gate, null);
  });
});

describe("replace-handler re-read consumer", () => {
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
    registerReplace(registry);
    ctx = makeCtx(db, wsPath);
  });

  afterEach(() => {
    closeTestDb(db, tmp);
  });

  it("blocks replace when the file is already flagged", async () => {
    writeFileSync(join(wsPath, "f.txt"), "a\nb\nc\n");
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    db.prepare(
      "INSERT INTO re_read_required (session_id, context_segment_id, file_path) VALUES (?, ?, ?)",
    ).run("s1", segment, join(wsPath, "f.txt"));

    const result = await registry.execute(
      "replace",
      { path: "f.txt", pattern: "b", replacement: "B" },
      ctx,
    );
    const json = JSON.parse(result.resultJson);
    assert.equal(json.gated, true, "should be gated by re-read");
    assert.equal(json.filePath, join(wsPath, "f.txt"));
    assert.equal(readFileSync(join(wsPath, "f.txt"), "utf8"), "a\nb\nc\n");
  });

  it("dryRun is exempt from the consumer gate", async () => {
    writeFileSync(join(wsPath, "f.txt"), "a\nb\nc\n");
    const segment = createSessionStore(db).getById("s1")!.contextSegmentId;
    db.prepare(
      "INSERT INTO re_read_required (session_id, context_segment_id, file_path) VALUES (?, ?, ?)",
    ).run("s1", segment, join(wsPath, "f.txt"));

    const result = await registry.execute(
      "replace",
      { path: "f.txt", pattern: "b", replacement: "B", dryRun: true },
      ctx,
    );
    const json = JSON.parse(result.resultJson);
    assert.equal(json.gated, undefined);
    assert.ok("preview" in json || "replacements" in json);
  });

  it("flags from a previous segment do not block", async () => {
    writeFileSync(join(wsPath, "f.txt"), "a\nb\nc\n");
    db.prepare(
      "INSERT INTO re_read_required (session_id, context_segment_id, file_path) VALUES (?, ?, ?)",
    ).run("s1", "old-segment", join(wsPath, "f.txt"));

    const result = await registry.execute(
      "replace",
      { path: "f.txt", pattern: "b", replacement: "B" },
      ctx,
    );
    const json = JSON.parse(result.resultJson);
    assert.equal(json.gated, undefined);
    assert.equal(json.replacements, 1);
  });
});
