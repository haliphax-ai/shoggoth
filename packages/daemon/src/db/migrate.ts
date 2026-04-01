import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const MIGRATION_FILE = /^(\d{4})_(.+)\.sql$/;

export interface MigrationInfo {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
}

export interface MigrateResult {
  readonly appliedVersions: readonly number[];
}

function ensureMetaTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function loadMigrationsFromDir(migrationsDir: string): MigrationInfo[] {
  const names = readdirSync(migrationsDir).filter((n) => MIGRATION_FILE.test(n));
  const out: MigrationInfo[] = [];
  for (const filename of names) {
    const m = MIGRATION_FILE.exec(filename);
    if (!m) continue;
    const version = Number.parseInt(m[1], 10);
    const name = m[2];
    const sql = readFileSync(join(migrationsDir, filename), "utf8");
    out.push({ version, name, filename, sql });
  }
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) {
    if (out[i].version === out[i - 1].version) {
      throw new Error(
        `Duplicate migration version ${out[i].version}: ${out[i - 1].filename} and ${out[i].filename}`,
      );
    }
  }
  return out;
}

function appliedVersions(db: Database.Database): Set<number> {
  const rows = db.prepare("SELECT version FROM _schema_migrations").all() as {
    version: number;
  }[];
  return new Set(rows.map((r) => r.version));
}

export function migrate(db: Database.Database, migrationsDir: string): MigrateResult {
  ensureMetaTable(db);
  const migrations = loadMigrationsFromDir(migrationsDir);
  const done = appliedVersions(db);
  const appliedVersionsNow: number[] = [];

  for (const m of migrations) {
    if (done.has(m.version)) continue;
    const txn = db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO _schema_migrations (version, name) VALUES (@version, @name)",
      ).run({ version: m.version, name: m.name });
    });
    txn.immediate();
    appliedVersionsNow.push(m.version);
    done.add(m.version);
  }

  return { appliedVersions: appliedVersionsNow };
}

/** Repo `shoggoth/migrations/` (single numbered `.sql` files; prototype — replace state DB on schema change). */
export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../../../migrations");
}

export function assertMigrationsDirReadable(dir: string): void {
  if (!existsSync(dir)) {
    throw new Error(`Migrations directory not found: ${dir}`);
  }
}
