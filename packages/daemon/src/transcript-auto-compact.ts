import type Database from "better-sqlite3";
import type { ShoggothConfig } from "@shoggoth/shared";
import { resolveEffectiveModelsConfig } from "@shoggoth/shared";
import {
  createFailoverClientFromModelsConfig,
  resolveCompactionPolicyFromModelsConfig,
  shouldAutoCompact,
  type FailoverModelClient,
} from "@shoggoth/models";
import { compactSessionTranscript, loadSessionTranscript } from "./transcript-compact";
import type { Logger } from "./logging";
import { getSessionContextSegmentId } from "./sessions/session-store";

interface TranscriptAutoCompactTickOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Cap how many sessions are considered per tick (ordered by id). */
  readonly maxSessionsPerTick?: number;
  readonly logger?: Logger;
  /** Tests / advanced wiring; defaults to config-backed failover client. */
  readonly modelClient?: FailoverModelClient;
}

/**
 * Scans sessions and compacts transcripts that exceed `models.compaction` thresholds.
 * Uses the same policy resolution as the CLI `session compact` path.
 */
export async function runTranscriptAutoCompactTick(
  db: Database.Database,
  config: ShoggothConfig,
  options: TranscriptAutoCompactTickOptions = {},
): Promise<{ sessionsScanned: number; sessionsCompacted: number }> {
  const limit = options.maxSessionsPerTick ?? 32;
  const sessionRows = db.prepare(`SELECT id FROM sessions ORDER BY id LIMIT ?`).all(limit) as {
    id: string;
  }[];

  let sessionsCompacted = 0;
  const log = options.logger;

  for (const { id: sessionId } of sessionRows) {
    let contextSegmentId: string;
    try {
      contextSegmentId = getSessionContextSegmentId(db, sessionId);
    } catch {
      continue;
    }
    const messages = loadSessionTranscript(db, sessionId, contextSegmentId);
    const modelsForSession = resolveEffectiveModelsConfig(config, sessionId) ?? config.models;
    const policy = resolveCompactionPolicyFromModelsConfig(modelsForSession);
    if (!shouldAutoCompact(messages, policy)) continue;
    try {
      const client =
        options.modelClient ??
        createFailoverClientFromModelsConfig(modelsForSession, {
          env: options.env ?? process.env,
        });
      const { compacted } = await compactSessionTranscript(db, sessionId, policy, client, {
        modelsConfig: modelsForSession,
      });
      if (compacted) {
        sessionsCompacted += 1;
        log?.info("transcript auto-compacted", { sessionId });
      }
    } catch (e) {
      log?.warn("transcript auto-compact failed", { sessionId, err: String(e) });
    }
  }

  return { sessionsScanned: sessionRows.length, sessionsCompacted };
}

/** Milliseconds between auto-compact ticks. 0 disables. */
export function transcriptAutoCompactIntervalMs(config: ShoggothConfig): number {
  const raw = process.env.SHOGGOTH_AUTO_COMPACT_MS;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  }
  const fromRuntime = config.runtime?.transcriptAutoCompactIntervalMs;
  if (fromRuntime !== undefined) return Math.max(0, fromRuntime);
  return config.models?.compaction != null ? 3_600_000 : 0;
}
