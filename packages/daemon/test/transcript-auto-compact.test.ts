import { describe, it } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { migrate, defaultMigrationsDir } from "../src/db/migrate";
import {
  runTranscriptAutoCompactTick,
  transcriptAutoCompactIntervalMs,
} from "../src/transcript-auto-compact";
import { DEFAULT_POLICY_CONFIG, type ShoggothConfig } from "@shoggoth/shared";
import type { FailoverModelClient } from "@shoggoth/models";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore, getSessionContextSegmentId } from "../src/sessions/session-store";

function baseConfig(): ShoggothConfig {
  return {
    logLevel: "info",
    stateDbPath: join(tmpdir(), "x.db"),
    socketPath: join(tmpdir(), "x.sock"),
    workspacesRoot: "/tmp",
    secretsDirectory: "/tmp",
    inboundMediaRoot: "/tmp",
    configDirectory: "/tmp",
    hitl: {
      defaultApprovalTimeoutMs: 300_000,
      toolRisk: { read: "safe", write: "caution", exec: "critical" },
      bypassUpTo: "safe",
    },
    memory: { paths: [], embeddings: { enabled: false } },
    skills: { scanRoots: [], disabledIds: [] },
    plugins: [],
    policy: DEFAULT_POLICY_CONFIG,
  };
}

describe("transcript-auto-compact", () => {
  it("compacts sessions over threshold on tick", async () => {
    const db = new Database(":memory:");
    migrate(db, defaultMigrationsDir());
    createSessionStore(db).create({ id: "s-auto", workspacePath: "/w", status: "active" });
    const seg = getSessionContextSegmentId(db, "s-auto");
    const big = "z".repeat(200);
    db.prepare(
      `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content) VALUES (?, ?, ?, ?, ?)`,
    ).run("s-auto", seg, 1, "user", big);
    db.prepare(
      `INSERT INTO transcript_messages (session_id, context_segment_id, seq, role, content) VALUES (?, ?, ?, ?, ?)`,
    ).run("s-auto", seg, 2, "assistant", big);

    const mockClient: FailoverModelClient = {
      async complete() {
        return {
          content: "SUMMARY",
          usedProviderId: "t",
          usedModel: "t",
          degraded: false,
        };
      },
    };
    const config: ShoggothConfig = {
      ...baseConfig(),
      models: {
        compaction: { maxContextChars: 50, preserveRecentMessages: 1 },
      },
    };
    const out = await runTranscriptAutoCompactTick(db, config, {
      maxSessionsPerTick: 10,
      modelClient: mockClient,
    });
    assert.equal(out.sessionsScanned >= 1, true);
    assert.equal(out.sessionsCompacted, 1);

    db.close();
  });

  it("transcriptAutoCompactIntervalMs respects env and compaction config", () => {
    const prev = process.env.SHOGGOTH_AUTO_COMPACT_MS;
    try {
      delete process.env.SHOGGOTH_AUTO_COMPACT_MS;
      assert.strictEqual(transcriptAutoCompactIntervalMs(baseConfig()), 0);
      assert.strictEqual(
        transcriptAutoCompactIntervalMs({
          ...baseConfig(),
          models: { compaction: { maxContextChars: 100, preserveRecentMessages: 1 } },
        }),
        3_600_000,
      );
      process.env.SHOGGOTH_AUTO_COMPACT_MS = "0";
      assert.strictEqual(
        transcriptAutoCompactIntervalMs({
          ...baseConfig(),
          models: { compaction: { maxContextChars: 100, preserveRecentMessages: 1 } },
        }),
        0,
      );
      delete process.env.SHOGGOTH_AUTO_COMPACT_MS;
      assert.strictEqual(
        transcriptAutoCompactIntervalMs({
          ...baseConfig(),
          runtime: { transcriptAutoCompactIntervalMs: 12_000 },
        }),
        12_000,
      );
    } finally {
      if (prev === undefined) delete process.env.SHOGGOTH_AUTO_COMPACT_MS;
      else process.env.SHOGGOTH_AUTO_COMPACT_MS = prev;
    }
  });
});
