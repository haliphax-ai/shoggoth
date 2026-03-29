import Database from "better-sqlite3";

export interface OpenStateDbOptions {
  readonly busyTimeoutMs?: number;
}

export function openStateDb(
  databasePath: string,
  options: OpenStateDbOptions = {},
): Database.Database {
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  const busy = options.busyTimeoutMs ?? 5000;
  db.pragma(`busy_timeout = ${Math.floor(busy)}`);
  return db;
}

export function getJournalMode(db: Database.Database): string {
  const mode = db.pragma("journal_mode", { simple: true });
  return String(mode).toLowerCase();
}
