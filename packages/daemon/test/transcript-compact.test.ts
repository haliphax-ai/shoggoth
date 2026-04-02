import { describe, it } from "vitest";
import assert from "node:assert";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../src/db/migrate";
import {
  loadSessionTranscript,
  replaceSessionTranscript,
  compactSessionTranscript,
} from "../src/transcript-compact";
import { createSessionStore, getSessionContextSegmentId } from "../src/sessions/session-store";
import type { FailoverModelClient } from "@shoggoth/models";

describe("transcript-compact", () => {
  it("loads and replaces transcript rows", () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "s1", workspacePath: "/tmp/w", status: "active" });
    const seg = getSessionContextSegmentId(db, "s1");
    db.prepare(
      `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content) VALUES (?, ?, ?, ?, ?)`,
    ).run("s1", seg, 1, "user", "hello");

    const loaded = loadSessionTranscript(db, "s1", seg);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]!.content, "hello");

    replaceSessionTranscript(db, "s1", seg, [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]);
    const again = loadSessionTranscript(db, "s1", seg);
    assert.equal(again.length, 2);
    assert.equal(again[1]!.content, "b");
    db.close();
  });

  it("compactSessionTranscript rewrites DB when over threshold", async () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "s1", workspacePath: "/tmp/w", status: "active" });
    const seg = getSessionContextSegmentId(db, "s1");
    const big = "y".repeat(120);
    db.prepare(
      `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content) VALUES (?, ?, ?, ?, ?)`,
    ).run("s1", seg, 1, "user", big);
    db.prepare(
      `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content) VALUES (?, ?, ?, ?, ?)`,
    ).run("s1", seg, 2, "assistant", big);
    db.prepare(
      `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content) VALUES (?, ?, ?, ?, ?)`,
    ).run("s1", seg, 3, "user", "tail");
    db.prepare(
      `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content) VALUES (?, ?, ?, ?, ?)`,
    ).run("s1", seg, 4, "assistant", "end");

    const client: FailoverModelClient = {
      async complete() {
        return {
          content: "SUM",
          usedProviderId: "p",
          usedModel: "m",
          degraded: false,
        };
      },
    };

    const out = await compactSessionTranscript(
      db,
      "s1",
      { maxContextChars: 100, preserveRecentMessages: 2 },
      client,
    );

    assert.equal(out.compacted, true);
    const rows = loadSessionTranscript(db, "s1", seg);
    assert.equal(rows.length, 3);
    assert.ok(rows[0]!.content.includes("SUM"));
    assert.equal(rows[1]!.content, "tail");
    db.close();
  });
});
