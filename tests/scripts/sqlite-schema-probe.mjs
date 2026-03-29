import Database from "better-sqlite3";

const required = [
  "sessions",
  "transcript_messages",
  "events",
  "cron_jobs",
  "audit_log",
  "memory_documents",
  "agent_tokens",
];

const db = new Database("/var/lib/shoggoth/state/shoggoth.db", { readonly: true });
try {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  const missing = required.filter((t) => !rows.includes(t));
  if (missing.length) {
    console.error(JSON.stringify({ missing, rows }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, tables: required.length }));
} finally {
  db.close();
}
