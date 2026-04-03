import { loadLayeredConfig } from "@shoggoth/shared";
import {
  assertMigrationsDirReadable,
  defaultMigrationsDir,
  migrate,
  openStateDb,
  runRetentionJobs,
} from "@shoggoth/daemon/lib";

interface RunRetentionOptions {
  readonly configDir: string;
}

export async function runRetentionCli(options: RunRetentionOptions): Promise<void> {
  const config = loadLayeredConfig(options.configDir);
  const dir = defaultMigrationsDir();
  assertMigrationsDirReadable(dir);
  const db = openStateDb(config.stateDbPath);
  try {
    migrate(db, dir);
    const summary = await runRetentionJobs(db, config);
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    db.close();
  }
}
