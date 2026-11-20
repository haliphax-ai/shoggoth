import type Database from "better-sqlite3";
import { rmSync } from "node:fs";

/**
 * Close a test database and remove its temp directory. WAL sidecar files
 * may still be flushing when db.close() returns, so rmSync can hit
 * ENOTEMPTY mid-traversal; wal_checkpoint(TRUNCATE) narrows the race and a
 * bounded event-loop retry covers the rest.
 */
export async function closeTestDb(db: Database.Database, tmpDir: string): Promise<void> {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // DB may already be in DELETE journal mode or closed — ignore.
  }
  db.close();

  // Retry with exponential backoff if ENOTEMPTY occurs (SQLite WAL/SHM race)
  let attempt = 0;
  while (attempt < 5) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
      break;
    } catch (err) {
      if (attempt === 4 || !String(err).includes("ENOTEMPTY")) {
        // Not ENOTEMPTY or max attempts — rethrow
        throw err;
      }
      attempt++;
      // Yield to the event loop between retries — no wall-clock wait.
      await Promise.resolve();
    }
  }
}
