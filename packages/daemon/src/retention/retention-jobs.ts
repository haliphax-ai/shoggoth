import { readdir, stat, unlink, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { ShoggothConfig, ShoggothRetentionConfig } from "@shoggoth/shared";
import { appendAuditRow } from "../audit/append-audit";

export interface RetentionRunSummary {
  readonly inboundMediaDeletedFiles: number;
  readonly inboundMediaFreedBytes: number;
  readonly transcriptMessagesDeleted: number;
}

export function retentionConfigHasRules(
  r: ShoggothRetentionConfig | undefined,
): r is ShoggothRetentionConfig {
  if (!r) return false;
  return (
    r.inboundMediaMaxAgeDays != null ||
    r.inboundMediaMaxTotalBytes != null ||
    r.transcriptMessageMaxAgeDays != null ||
    r.transcriptMaxMessagesPerSession != null
  );
}

function retentionHasRules(r: ShoggothRetentionConfig | undefined): r is ShoggothRetentionConfig {
  return retentionConfigHasRules(r);
}

/**
 * Daemon tick interval for `runRetentionJobs`.
 * `SHOGGOTH_RETENTION_MS` overrides; `0` disables. Else `runtime.retentionScheduleIntervalMs`.
 * When unset, defaults to 1h if config has retention rules.
 */
export function retentionScheduleIntervalMs(config: {
  retention?: ShoggothRetentionConfig;
  runtime?: { retentionScheduleIntervalMs?: number };
}): number {
  const raw = process.env.SHOGGOTH_RETENTION_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  const fromRuntime = config.runtime?.retentionScheduleIntervalMs;
  if (fromRuntime !== undefined) return Math.max(0, fromRuntime);
  return retentionConfigHasRules(config.retention) ? 3_600_000 : 0;
}

function isPathInsideRoot(rootAbs: string, pathAbs: string): boolean {
  const rel = relative(rootAbs, pathAbs);
  if (rel === "") return true;
  return !rel.startsWith("..");
}

async function listInboundFileEntries(root: string): Promise<
  { absPath: string; relPath: string; mtimeMs: number; size: number }[]
> {
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return [];
  }

  const out: { absPath: string; relPath: string; mtimeMs: number; size: number }[] = [];

  async function walk(currentAbs: string): Promise<void> {
    let currentReal: string;
    try {
      currentReal = await realpath(currentAbs);
    } catch {
      return;
    }
    if (!isPathInsideRoot(rootReal, currentReal)) return;

    let names: string[];
    try {
      names = await readdir(currentAbs);
    } catch {
      return;
    }
    for (const name of names) {
      const absPath = join(currentAbs, name);
      let st;
      try {
        st = await stat(absPath);
      } catch {
        continue;
      }
      let pathAbs: string;
      try {
        pathAbs = await realpath(absPath);
      } catch {
        continue;
      }
      if (!isPathInsideRoot(rootReal, pathAbs)) continue;

      if (st.isDirectory()) {
        await walk(absPath);
      } else if (st.isFile()) {
        out.push({
          absPath,
          relPath: relative(rootReal, pathAbs) || name,
          mtimeMs: st.mtimeMs,
          size: st.size,
        });
      }
    }
  }

  await walk(rootReal);
  return out;
}

async function purgeInboundMedia(
  root: string,
  r: ShoggothRetentionConfig,
): Promise<{ deletedFiles: number; freedBytes: number }> {
  let deletedFiles = 0;
  let freedBytes = 0;

  const maxAgeDays = r.inboundMediaMaxAgeDays;
  const maxTotal = r.inboundMediaMaxTotalBytes;

  if (maxAgeDays == null && maxTotal == null) {
    return { deletedFiles, freedBytes };
  }

  const cutoffMs =
    maxAgeDays != null ? Date.now() - maxAgeDays * 86_400_000 : Number.NEGATIVE_INFINITY;

  let files = await listInboundFileEntries(root);

  if (maxAgeDays != null) {
    for (const f of files) {
      if (f.mtimeMs >= cutoffMs) continue;
      try {
        await unlink(f.absPath);
        deletedFiles += 1;
        freedBytes += f.size;
      } catch {
        /* ignore */
      }
    }
    files = await listInboundFileEntries(root);
  }

  if (maxTotal != null && files.length > 0) {
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total > maxTotal) {
      const sorted = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const f of sorted) {
        if (total <= maxTotal) break;
        try {
          await unlink(f.absPath);
          deletedFiles += 1;
          freedBytes += f.size;
          total -= f.size;
        } catch {
          /* ignore */
        }
      }
    }
  }

  return { deletedFiles, freedBytes };
}

function purgeTranscriptByAge(db: Database.Database, days: number): number {
  const info = db
    .prepare(
      `
    DELETE FROM transcript_messages
    WHERE datetime(created_at) < datetime('now', printf('-%d days', @days))
  `,
    )
    .run({ days });
  return Number(info.changes);
}

function purgeTranscriptBySessionCap(db: Database.Database, keepPerSession: number): number {
  const info = db.prepare(
    `
    DELETE FROM transcript_messages
    WHERE id IN (
      SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq DESC) AS rn
        FROM transcript_messages
      ) WHERE rn > @keep
    )
  `,
  ).run({ keep: keepPerSession });
  return Number(info.changes);
}

export interface RunRetentionJobsOptions {
  readonly correlationId?: string;
}

/**
 * Applies configured retention rules. Writes summary rows to `audit_log`.
 * No-op when `retention` is absent or has no limits set.
 */
export async function runRetentionJobs(
  db: Database.Database,
  config: ShoggothConfig,
  options: RunRetentionJobsOptions = {},
): Promise<RetentionRunSummary> {
  const r = config.retention;
  if (!r || !retentionHasRules(r)) {
    return {
      inboundMediaDeletedFiles: 0,
      inboundMediaFreedBytes: 0,
      transcriptMessagesDeleted: 0,
    };
  }

  const rules = r;
  const correlationId = options.correlationId ?? undefined;
  let inboundMediaDeletedFiles = 0;
  let inboundMediaFreedBytes = 0;
  let transcriptMessagesDeleted = 0;

  const mediaRoot = resolve(config.inboundMediaRoot);

  if (rules.inboundMediaMaxAgeDays != null || rules.inboundMediaMaxTotalBytes != null) {
    const { deletedFiles, freedBytes } = await purgeInboundMedia(mediaRoot, rules);
    inboundMediaDeletedFiles = deletedFiles;
    inboundMediaFreedBytes = freedBytes;
    appendAuditRow(db, {
      source: "system",
      principalKind: "system",
      principalId: "retention",
      correlationId,
      action: "retention.purge_inbound_media",
      resource: mediaRoot,
      outcome: "ok",
      argsRedactedJson: JSON.stringify({
        deletedFiles,
        freedBytes,
        inboundMediaMaxAgeDays: rules.inboundMediaMaxAgeDays ?? null,
        inboundMediaMaxTotalBytes: rules.inboundMediaMaxTotalBytes ?? null,
      }),
    });
  }

  if (rules.transcriptMessageMaxAgeDays != null) {
    const days = rules.transcriptMessageMaxAgeDays;
    const n = db.transaction(() => purgeTranscriptByAge(db, days))();
    transcriptMessagesDeleted += n;
    appendAuditRow(db, {
      source: "system",
      principalKind: "system",
      principalId: "retention",
      correlationId,
      action: "retention.purge_transcript_age",
      resource: config.stateDbPath,
      outcome: "ok",
      argsRedactedJson: JSON.stringify({
        deletedRows: n,
        transcriptMessageMaxAgeDays: days,
      }),
    });
  }

  if (rules.transcriptMaxMessagesPerSession != null) {
    const keep = rules.transcriptMaxMessagesPerSession;
    const n = db.transaction(() => purgeTranscriptBySessionCap(db, keep))();
    transcriptMessagesDeleted += n;
    appendAuditRow(db, {
      source: "system",
      principalKind: "system",
      principalId: "retention",
      correlationId,
      action: "retention.purge_transcript_session_cap",
      resource: config.stateDbPath,
      outcome: "ok",
      argsRedactedJson: JSON.stringify({
        deletedRows: n,
        transcriptMaxMessagesPerSession: keep,
      }),
    });
  }

  return {
    inboundMediaDeletedFiles,
    inboundMediaFreedBytes,
    transcriptMessagesDeleted,
  };
}
