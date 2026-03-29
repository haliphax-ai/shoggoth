import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore } from "../../src/sessions/session-store";
import { createTranscriptStore } from "../../src/sessions/transcript-store";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-tr-"));
  const dbPath = join(dir, "t.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("TranscriptStore", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
    createSessionStore(db).create({ id: "sess", workspacePath: "/w" });
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("appends with monotonic seq", () => {
    const tr = createTranscriptStore(db);
    const a = tr.append({ sessionId: "sess", role: "user", content: "hi" });
    const b = tr.append({ sessionId: "sess", role: "assistant", content: "yo" });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
  });

  it("lists page after cursor", () => {
    const tr = createTranscriptStore(db);
    tr.append({ sessionId: "sess", role: "user", content: "1" });
    tr.append({ sessionId: "sess", role: "user", content: "2" });
    tr.append({ sessionId: "sess", role: "user", content: "3" });
    const p1 = tr.listPage({ sessionId: "sess", afterSeq: 0, limit: 2 });
    assert.equal(p1.messages.length, 2);
    assert.equal(p1.messages[0]!.content, "1");
    assert.equal(p1.messages[1]!.content, "2");
    assert.equal(p1.nextCursor, 2);
    const p2 = tr.listPage({ sessionId: "sess", afterSeq: p1.nextCursor!, limit: 10 });
    assert.equal(p2.messages.length, 1);
    assert.equal(p2.nextCursor, undefined);
  });
});
