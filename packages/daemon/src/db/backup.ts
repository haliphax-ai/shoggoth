import type Database from "better-sqlite3";

/**
 * Hot backup of the open database to another file using SQLite's online backup API.
 */
export async function backupDatabaseToFile(
  db: Database.Database,
  destinationPath: string,
): Promise<void> {
  await db.backup(destinationPath);
}
