import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { defaultConfig } from "@shoggoth/shared";
import { openStateDb } from "../../src/db/open";
import { defaultMigrationsDir, migrate } from "../../src/db/migrate";
import { runRetentionJobs, retentionScheduleIntervalMs } from "../../src/retention/retention-jobs";

function openMigratedDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shoggoth-ret-"));
  const dbPath = join(dir, "state.db");
  const db = openStateDb(dbPath);
  migrate(db, defaultMigrationsDir());
  return { db, dir };
}

describe("retention jobs", () => {
  let db: Database.Database;
  let tmp: string;

  beforeEach(() => {
    const o = openMigratedDb();
    db = o.db;
    tmp = o.dir;
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("no-op when retention is unset", async () => {
    const media = join(tmp, "media");
    mkdirSync(media);
    const cfg = { ...defaultConfig(tmp), inboundMediaRoot: media, stateDbPath: join(tmp, "state.db") };
    const summary = await runRetentionJobs(db, cfg);
    assert.deepStrictEqual(summary, {
      inboundMediaDeletedFiles: 0,
      inboundMediaFreedBytes: 0,
      transcriptMessagesDeleted: 0,
    });
    const audits = db.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number };
    assert.equal(audits.c, 0);
  });

  it("deletes inbound media older than max age and writes audit", async () => {
    const media = join(tmp, "media");
    mkdirSync(media);
    const stale = join(media, "old.bin");
    writeFileSync(stale, "x");
    const old = new Date(Date.now() - 20 * 86_400_000);
    await utimes(stale, old, old);

    const fresh = join(media, "new.bin");
    writeFileSync(fresh, "yy");

    const cfg = {
      ...defaultConfig(tmp),
      inboundMediaRoot: media,
      stateDbPath: join(tmp, "state.db"),
      retention: { inboundMediaMaxAgeDays: 7 },
    };

    const summary = await runRetentionJobs(db, cfg);
    assert.equal(summary.inboundMediaDeletedFiles, 1);
    assert.equal(summary.inboundMediaFreedBytes, 1);

    const audits = db
      .prepare(`SELECT action, args_redacted_json FROM audit_log ORDER BY id`)
      .all() as { action: string; args_redacted_json: string }[];
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.action, "retention.purge_inbound_media");
    const args = JSON.parse(audits[0]!.args_redacted_json) as { deletedFiles: number };
    assert.equal(args.deletedFiles, 1);
  });

  it("trims inbound media by total size after age rules", async () => {
    const media = join(tmp, "media");
    mkdirSync(media);
    const a = join(media, "a.bin");
    const b = join(media, "b.bin");
    writeFileSync(a, "aaaa");
    writeFileSync(b, "bb");
    const tOld = new Date(Date.now() - 86_400_000);
    const tNew = new Date();
    await utimes(a, tOld, tOld);
    await utimes(b, tNew, tNew);

    const cfg = {
      ...defaultConfig(tmp),
      inboundMediaRoot: media,
      stateDbPath: join(tmp, "state.db"),
      retention: { inboundMediaMaxTotalBytes: 3 },
    };

    const summary = await runRetentionJobs(db, cfg);
    assert.equal(summary.inboundMediaDeletedFiles, 1);
    assert.ok(!existsSync(a));
    assert.ok(existsSync(b));
  });

  it("deletes transcript rows by age and by per-session cap", async () => {
    db.prepare(
      `INSERT INTO sessions (id, workspace_path, status) VALUES ('s1', '/w', 'active')`,
    ).run();

    db.prepare(
      `
      INSERT INTO transcript_messages (session_id, seq, role, content, created_at)
      VALUES
        ('s1', 1, 'user', 'a', datetime('now', '-30 days')),
        ('s1', 2, 'user', 'b', datetime('now')),
        ('s1', 3, 'user', 'c', datetime('now')),
        ('s1', 4, 'user', 'd', datetime('now'))
    `,
    ).run();

    const media = join(tmp, "media");
    mkdirSync(media);

    const cfgAge = {
      ...defaultConfig(tmp),
      inboundMediaRoot: media,
      stateDbPath: join(tmp, "state.db"),
      retention: { transcriptMessageMaxAgeDays: 7 },
    };
    const s1 = await runRetentionJobs(db, cfgAge);
    assert.equal(s1.transcriptMessagesDeleted, 1);

    const cfgCap = {
      ...cfgAge,
      retention: { transcriptMaxMessagesPerSession: 2 },
    };
    const s2 = await runRetentionJobs(db, cfgCap);
    assert.equal(s2.transcriptMessagesDeleted, 1);

    const n = db.prepare(`SELECT COUNT(*) AS c FROM transcript_messages WHERE session_id = 's1'`).get() as {
      c: number;
    };
    assert.equal(n.c, 2);
  });

  it("retentionScheduleIntervalMs is 0 without rules unless env set", () => {
    const prev = process.env.SHOGGOTH_RETENTION_MS;
    try {
      delete process.env.SHOGGOTH_RETENTION_MS;
      assert.strictEqual(retentionScheduleIntervalMs({}), 0);
      assert.strictEqual(
        retentionScheduleIntervalMs({ retention: { inboundMediaMaxAgeDays: 1 } }),
        3_600_000,
      );
      process.env.SHOGGOTH_RETENTION_MS = "0";
      assert.strictEqual(
        retentionScheduleIntervalMs({ retention: { inboundMediaMaxAgeDays: 1 } }),
        0,
      );
      delete process.env.SHOGGOTH_RETENTION_MS;
      assert.strictEqual(
        retentionScheduleIntervalMs({
          retention: { inboundMediaMaxAgeDays: 1 },
          runtime: { retentionScheduleIntervalMs: 9_000 },
        }),
        9_000,
      );
    } finally {
      if (prev === undefined) delete process.env.SHOGGOTH_RETENTION_MS;
      else process.env.SHOGGOTH_RETENTION_MS = prev;
    }
  });
});
