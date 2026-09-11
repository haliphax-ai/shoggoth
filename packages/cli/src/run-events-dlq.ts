import { loadLayeredConfigAsync } from "@shoggoth/shared";
import {
  assertMigrationsDirReadable,
  defaultMigrationsDir,
  listDeadLetterEvents,
  migrate,
  openStateDb,
} from "@shoggoth/daemon/lib";

interface RunEventsDlqOptions {
  readonly configDir: string;
  readonly limit: number;
}

export async function runEventsDlqCli(options: RunEventsDlqOptions): Promise<void> {
  const config = await loadLayeredConfigAsync(options.configDir);
  const dir = defaultMigrationsDir();
  assertMigrationsDirReadable(dir);
  const db = openStateDb(config.stateDbPath);
  try {
    migrate(db, dir);
    const rows = listDeadLetterEvents(db, { limit: options.limit });
    console.log(JSON.stringify({ dead: rows }, null, 2));
  } finally {
    db.close();
  }
}
