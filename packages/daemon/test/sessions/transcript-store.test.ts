import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { closeTestDb } from "../helpers/close-test-db";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { createSessionStore, getSessionContextSegmentId } from "../../src/sessions/session-store";
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
    closeTestDb(db, tmp);
  });

  it("appends with monotonic seq", () => {
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");
    const a = tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "user",
      content: "hi",
    });
    const b = tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "assistant",
      content: "yo",
    });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
  });

  it("lists page after cursor", () => {
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "user",
      content: "1",
    });
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "user",
      content: "2",
    });
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "user",
      content: "3",
    });
    const p1 = tr.listPage({
      sessionId: "sess",
      contextSegmentId: seg,
      afterSeq: 0,
      limit: 2,
    });
    assert.equal(p1.messages.length, 2);
    assert.equal(p1.messages[0]!.content, "1");
    assert.equal(p1.messages[1]!.content, "2");
    assert.equal(p1.nextCursor, 2);
    const p2 = tr.listPage({
      sessionId: "sess",
      contextSegmentId: seg,
      afterSeq: p1.nextCursor!,
      limit: 10,
    });
    assert.equal(p2.messages.length, 1);
    assert.equal(p2.nextCursor, undefined);
  });

  it("normal flow: tool calls followed by results — no synthetic injection", () => {
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "assistant",
      toolCalls: [
        { id: "tc1", name: "foo", argsJson: "{}" },
        { id: "tc2", name: "bar", argsJson: "{}" },
      ],
    });
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "tool",
      toolCallId: "tc1",
      content: "r1",
    });
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "tool",
      toolCallId: "tc2",
      content: "r2",
    });
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "user",
      content: "next",
    });

    const { messages } = tr.listPage({
      sessionId: "sess",
      contextSegmentId: seg,
      afterSeq: 0,
      limit: 100,
    });
    assert.equal(messages.length, 4);
    assert.equal(messages[0]!.role, "assistant");
    assert.equal(messages[1]!.role, "tool");
    assert.equal(messages[1]!.content, "r1");
    assert.equal(messages[2]!.role, "tool");
    assert.equal(messages[2]!.content, "r2");
    assert.equal(messages[3]!.role, "user");
  });

  it("orphaned tool calls: user message triggers synthetic results", () => {
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "assistant",
      toolCalls: [
        { id: "tc1", name: "foo", argsJson: "{}" },
        { id: "tc2", name: "bar", argsJson: "{}" },
      ],
    });
    // No tool results — directly append user message
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "user",
      content: "hello",
    });

    const { messages } = tr.listPage({
      sessionId: "sess",
      contextSegmentId: seg,
      afterSeq: 0,
      limit: 100,
    });
    assert.equal(messages.length, 4); // assistant + 2 synthetic + user
    assert.equal(messages[0]!.role, "assistant");
    assert.equal(messages[1]!.role, "tool");
    assert.equal(messages[1]!.content, "[Tool call aborted — no result available]");
    assert.ok(messages[1]!.toolCallId === "tc1" || messages[1]!.toolCallId === "tc2");
    assert.equal(messages[2]!.role, "tool");
    assert.equal(messages[2]!.content, "[Tool call aborted — no result available]");
    assert.equal(messages[3]!.role, "user");
    assert.equal(messages[3]!.content, "hello");
    // Both tool call IDs are covered
    const syntheticIds = new Set([messages[1]!.toolCallId, messages[2]!.toolCallId]);
    assert.ok(syntheticIds.has("tc1"));
    assert.ok(syntheticIds.has("tc2"));
  });

  it("partial results: only missing tool calls get synthetic results", () => {
    const tr = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "assistant",
      toolCalls: [
        { id: "tc1", name: "a", argsJson: "{}" },
        { id: "tc2", name: "b", argsJson: "{}" },
        { id: "tc3", name: "c", argsJson: "{}" },
      ],
    });
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "tool",
      toolCallId: "tc1",
      content: "ok1",
    });
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "tool",
      toolCallId: "tc3",
      content: "ok3",
    });
    // tc2 is missing — next user message should inject synthetic for tc2 only
    tr.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "user",
      content: "go",
    });

    const { messages } = tr.listPage({
      sessionId: "sess",
      contextSegmentId: seg,
      afterSeq: 0,
      limit: 100,
    });
    assert.equal(messages.length, 5); // assistant + 2 real tools + 1 synthetic + user
    assert.equal(messages[3]!.role, "tool");
    assert.equal(messages[3]!.toolCallId, "tc2");
    assert.equal(messages[3]!.content, "[Tool call aborted — no result available]");
    assert.equal(messages[4]!.role, "user");
    assert.equal(messages[4]!.content, "go");
  });

  it("DB-driven repair survives store recreation (simulated restart)", () => {
    // First store instance: write assistant with tool calls, then "crash"
    const tr1 = createTranscriptStore(db);
    const seg = getSessionContextSegmentId(db, "sess");
    tr1.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "assistant",
      toolCalls: [{ id: "tc1", name: "foo", argsJson: "{}" }],
    });

    // New store instance (simulates daemon restart) — no in-memory state
    const tr2 = createTranscriptStore(db);
    tr2.append({
      sessionId: "sess",
      contextSegmentId: seg,
      role: "user",
      content: "after restart",
    });

    const { messages } = tr2.listPage({
      sessionId: "sess",
      contextSegmentId: seg,
      afterSeq: 0,
      limit: 100,
    });
    assert.equal(messages.length, 3); // assistant + synthetic + user
    assert.equal(messages[1]!.role, "tool");
    assert.equal(messages[1]!.toolCallId, "tc1");
    assert.equal(messages[1]!.content, "[Tool call aborted — no result available]");
    assert.equal(messages[2]!.role, "user");
  });
});
