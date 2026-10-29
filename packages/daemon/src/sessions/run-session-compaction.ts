import {
  createFailoverClientFromModelsConfig,
  resolveCompactionPolicyFromModelsConfig,
} from "@shoggoth/models";
import type { ShoggothConfig } from "@shoggoth/shared";
import { resolveEffectiveModelsConfig } from "@shoggoth/shared";
import type Database from "better-sqlite3";
import { compactSessionTranscript } from "../transcript-compact";

/** Result of a session compaction run. */
export type SessionCompactionResult = Awaited<ReturnType<typeof compactSessionTranscript>>;

/**
 * Shared body of a session compaction: resolve the session's effective models
 * config, build the policy and failover client from it, and run
 * {@link compactSessionTranscript}. Callers own concurrency — the compaction
 * must run either behind the turn queue (a queued system turn) or inside an
 * active loop's compaction gate so the in-memory model history and the DB
 * transcript cannot diverge.
 */
export async function runSessionCompaction(input: {
  db: Database.Database;
  sessionId: string;
  config: ShoggothConfig;
}): Promise<SessionCompactionResult> {
  const modelsConfig =
    resolveEffectiveModelsConfig(input.config, input.sessionId) ?? input.config.models;
  const policy = resolveCompactionPolicyFromModelsConfig(modelsConfig);
  const client = createFailoverClientFromModelsConfig(modelsConfig, {
    env: process.env,
  });
  return compactSessionTranscript(input.db, input.sessionId, policy, client, {
    modelsConfig,
  });
}
