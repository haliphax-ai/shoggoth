import { describe, it } from "vitest";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runSessionCompact } from "../src/run-session-compact";
import Database from "better-sqlite3";
import {
  createSessionStore,
  defaultMigrationsDir,
  getSessionContextSegmentId,
  migrate,
} from "@shoggoth/daemon/lib";

describe("runSessionCompact", () => {
  it("compacts transcript in state DB on demand", async () => {
    const dir = join(tmpdir(), `shoggoth-cli-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "state.db");
    const db = new Database(dbPath);
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "sess-1", workspacePath: "/w", status: "active" });
    const seg = getSessionContextSegmentId(db, "sess-1");
    const big = "z".repeat(80);
    for (const [seq, role, content] of [
      [1, "user", big],
      [2, "assistant", big],
      [3, "user", "t1"],
      [4, "assistant", "t2"],
    ] as const) {
      db.prepare(
        `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content) VALUES (?, ?, ?, ?, ?)`,
      ).run("sess-1", seg, seq, role, content);
    }
    db.close();

    const fetchImpl = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "CLI_SUM" } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const out = await runSessionCompact({
      stateDbPath: dbPath,
      models: {
        providers: [
          { id: "p", kind: "openai-compatible", baseUrl: "https://example.invalid/v1" },
        ],
        failoverChain: [{ providerId: "p", model: "m" }],
        compaction: { maxContextChars: 100, preserveRecentMessages: 2 },
      },
      sessionId: "sess-1",
      force: false,
      env: {},
      fetchImpl,
    });

    assert.equal(out.compacted, true);

    const verify = new Database(dbPath);
    const n = verify.prepare(`SELECT COUNT(*) as c FROM transcript_messages WHERE session_id = ?`).get(
      "sess-1",
    ) as { c: number };
    assert.equal(n.c, 3);
    verify.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
