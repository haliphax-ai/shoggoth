import {
  defaultMigrationsDir,
  ingestMemoryRoots,
  migrate,
  openStateDb,
  searchMemoryFts,
} from "@shoggoth/daemon/lib";

const dbPath = "/var/lib/shoggoth/state/shoggoth.db";
const root = "/var/lib/shoggoth/workspaces/readiness-guild/memory";

const db = openStateDb(dbPath);
try {
  migrate(db, defaultMigrationsDir());
  const changed = ingestMemoryRoots(db, [root]);
  const hits = searchMemoryFts(db, "readiness-alpha", { limit: 20 });
  console.log(JSON.stringify({ changed, hitCount: hits.length, firstTitle: hits[0]?.title ?? null }));
  if (hits.length < 1) process.exit(1);
} finally {
  db.close();
}
