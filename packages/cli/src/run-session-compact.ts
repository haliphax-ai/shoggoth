import type { ShoggothModelsConfig } from "@shoggoth/shared";
import {
  createFailoverClientFromModelsConfig,
  resolveCompactionPolicyFromModelsConfig,
  type FetchLike,
} from "@shoggoth/models";
import {
  assertMigrationsDirReadable,
  compactSessionTranscript,
  defaultMigrationsDir,
  migrate,
  openStateDb,
} from "@shoggoth/daemon/lib";

interface RunSessionCompactOptions {
  readonly stateDbPath: string;
  readonly models: ShoggothModelsConfig | undefined;
  readonly sessionId: string;
  readonly force: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: FetchLike;
}

export async function runSessionCompact(
  options: RunSessionCompactOptions,
): Promise<{ compacted: boolean; messageCount: number }> {
  const dir = defaultMigrationsDir();
  assertMigrationsDirReadable(dir);
  const db = openStateDb(options.stateDbPath);
  try {
    migrate(db, dir);
    const client = createFailoverClientFromModelsConfig(options.models, {
      env: options.env,
      fetchImpl: options.fetchImpl,
    });
    const policy = resolveCompactionPolicyFromModelsConfig(options.models);
    return await compactSessionTranscript(db, options.sessionId, policy, client, {
      force: options.force,
      modelsConfig: options.models,
    });
  } finally {
    db.close();
  }
}
