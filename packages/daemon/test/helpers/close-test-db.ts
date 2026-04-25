import type Database from "better-sqlite3";
import { rmSync } from "node:fs";

/**
 * Safely close a test database and remove its temp directory.
 *
 * SQLite WAL mode creates `-wal` and `-shm` sidecar files that may not be
 * fully flushed when `db.close()` returns. A concurrent `rmSync` can then
 * hit `ENOTEMPTY` if a sidecar file appears mid-traversal. Checkpointing
 * with TRUNCATE before close eliminates the race.
 */
export function closeTestDb(db: Database.Database, tmpDir: string): void {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // DB may already be in DELETE journal mode or closed — ignore.
  }
  db.close();
  rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
