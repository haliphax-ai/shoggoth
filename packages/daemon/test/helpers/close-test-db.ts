import type Database from "better-sqlite3";
import { rmSync } from "node:fs";

/**
 * Safely close a test database and remove its temp directory.
 *
 * SQLite WAL mode creates `-wal` and `-shm` sidecar files that may not be
 * fully flushed when `db.close()` returns. A concurrent `rmSync` can then
 * hit `ENOTEMPTY` if a sidecar file appears mid-traversal.
 *
 * Checkpointing with TRUNCATE before close eliminates most races, but some
 * tests still hit ENOTEMPTY on rare occasions. This function retries when
 * that happens (bounded immediate retries, no timer waits).
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
