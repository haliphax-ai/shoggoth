# Operator runbook — Shoggoth

Commands assume Docker-style layout from the image (`/var/lib/shoggoth/state`, `/etc/shoggoth/config.d`, etc.); adjust paths for local dev.

## CI test matrix (DAC / agent UID)

GitHub Actions runs two jobs (see `.github/workflows/ci.yml`):

| Job | Purpose |
|-----|---------|
| **unit** | `ubuntu-latest` VM: full `npm test` (workspace `*.test.ts` / `*.test.mjs`). **DAC** cases in `@shoggoth/os-exec` **skip** without root / agent UID spawn (normal on unprivileged hosts). |
| **agent-uid-isolation** | `node:22-bookworm` **container as root**, with passwd entries for `shoggoth` and `agent` users (UIDs configurable via `SHOGGOTH_UID`/`AGENT_UID` build args). Sets `SHOGGOTH_CI_STRICT_AGENT_TESTS=1` so skipped DAC tests **fail the job** if isolation cannot run. |

Locally, match the strict job with:

`npm run test:ci-agent-isolation` (from repo root).

## Config hot-reload vs restart

After the control plane starts, the daemon may watch `configDirectory` (layered `*.json`). Unless `SHOGGOTH_CONFIG_HOT_RELOAD=0`, file changes trigger a debounced reload.

- **Applied without restart** when *only* **policy** and/or **HITL** change and every key in `CONFIG_RESTART_REQUIRED_KEYS` (`packages/daemon/src/config-policy.ts`) stays the same as the last applied snapshot: control socket authz and Discord platform tool policy/HITL use the new values on the next request/turn.
- **Logged, not applied** if any restart-required key would change — **restart the daemon** to pick those up.
- **Not live-applied yet** (restart required): `models`, `mcp`, `skills`, `plugins`, `memory`, `retention`, `logLevel`, and other keys outside policy/HITL.

Invalid JSON or schema errors: previous config is kept; check logs for `config hot-reload load failed`.

## Markdown memory (FTS + optional embeddings)

- Default search uses SQLite FTS5 (BM25). Set **`memory.embeddings.enabled`: true** to also rank via OpenAI-compatible **`POST …/v1/embeddings`** when a query embedding can be obtained and stored vectors exist for the same **`memory.embeddings.modelId`** (default `text-embedding-3-small`). On API errors or missing vectors, search falls back to FTS only.
- **`memory.ingest`** still updates markdown rows first; when embeddings are enabled it then requests embeddings only for documents whose **`content_sha256`** changed since the last stored row (avoids redundant calls).
- Credentials / base URL: **`OPENAI_API_KEY`** (or **`memory.embeddings.apiKeyEnv`**) and, in order, **`SHOGGOTH_MEMORY_OPENAI_BASE_URL`** (merged from **`memory.embeddings.openaiBaseUrl`** when unset in env), **`OPENAI_BASE_URL`**, **`OLLAMA_HOST`**, **`runtime.openaiBaseUrl`**, then the public OpenAI origin. The schema defines **`memory_embeddings.content_sha256`** for skipping redundant embedding calls.

## Human-in-the-loop (HITL)

When a tool call exceeds the effective role bypass tier, the daemon inserts a row in `hitl_pending_actions` and blocks that tool until an operator **approves** or **denies** (or the row **expires**).

- **Visibility:** JSON log line `hitl.pending_queued` on stderr (searchable in container logs). On Discord, operator-facing HITL text includes a **truncated tool payload** (JSON, 600 chars max) plus pending id and CLI hints. By default a **reply** is also posted in the routed session channel; disable with **`SHOGGOTH_DISCORD_HITL_REPLY_IN_SESSION=0`** or **`discord.hitlReplyInSession: false`**. Optional **additional** paths: guild channel `SHOGGOTH_HITL_NOTIFY_CHANNEL_ID`, DM `SHOGGOTH_HITL_NOTIFY_DM_USER_ID`, or webhook `SHOGGOTH_HITL_NOTIFY_WEBHOOK_URL` (JSON includes `payloadPreview`, same truncation; see `discord-hitl-notifier.ts`).
- **Actions:** `shoggoth hitl list|get|approve|deny` (CLI → control Unix socket) or control ops `hitl_pending_list`, `hitl_pending_get`, `hitl_pending_approve`, `hitl_pending_deny`. The control socket is request/response only — there is no server-push event; automate with polling `hitl_pending_list` or log scraping. In the runtime Docker image, **`/usr/local/bin/shoggoth`** is on `PATH` for **`shoggoth` and `agent`** (and root); use e.g. `docker compose exec -u shoggoth <service> shoggoth hitl list` from any cwd inside the container.
- **Resume:** The Discord platform and control plane share one in-process pending store and resolution hub (`createHitlPendingResolutionStack` in `index.ts`); approving via the socket unblocks the waiting tool loop in the same daemon process.

## Load smoke (SQLite contention)

Automated burst coverage lives in `@shoggoth/daemon` tests (`load smoke — SQLite burst`): concurrent event inserts and multi-handle writes against one DB.

For manual/staging checks before release:

- Run several Discord (or scripted) sessions in parallel against one daemon + one state DB.
- Tune env knobs only when diagnosing: `SHOGGOTH_HEARTBEAT_MS`, `SHOGGOTH_HEARTBEAT_BATCH`, `SHOGGOTH_HEARTBEAT_CONCURRENCY`, `SHOGGOTH_CRON_TICK_MS`. Document any changes; extreme values can mask real contention issues.

If you see `SQLITE_BUSY` or heartbeat backlog growth, reduce concurrency or batch size, or scale out only after validating SQLite single-writer limits for your workload.

## Schema changes (prototype)

There is **no** incremental upgrade path for the SQLite schema. **`migrations/0001_initial.sql`** defines the full database; when it changes, **delete the state DB** (or the whole state volume) and let the daemon recreate it.

Before tagging an image: check layered config for breaking JSON changes, rotate secrets as needed, run smoke (control `health`, one session turn).

## Backup and restore

1. **Stop the daemon** (graceful shutdown so WAL checkpoints if configured).
2. Copy the **state directory**, at minimum `shoggoth.db` and any `-wal` / `-shm` siblings:
   - `cp -a /var/lib/shoggoth/state /backup/shoggoth-state-$(date -u +%Y%m%d)`
3. **Restore:** stop daemon, replace the state directory from backup, ensure ownership matches the `shoggoth` service user, start daemon.
4. Run **`PRAGMA integrity_check`** on the restored DB if you suspect corruption (e.g. `sqlite3 /var/lib/shoggoth/state/shoggoth.db 'PRAGMA integrity_check;'`).

## Rotate Discord token

1. Generate a new bot token in the Discord developer portal.
2. Update the secret file or env var your compose stack uses (often under `/run/secrets` or env in `docker-compose.yml`).
3. **Restart** the daemon or messaging worker so it picks up the new credential.
4. Revoke the old token after confirming connectivity.

## Clear DLQ / failed events

- Failed or poisoned work lives in SQLite (`events` and related tables).
- **Operator visibility:** use read-only SQL against the state DB, or the CLI if exposed for your version.
- **Clearing:** prefer marking rows for retry or deletion via supported tooling; ad-hoc `DELETE` only after understanding schema (`events`, status columns, and DLQ semantics).
- Take a **backup** before bulk deletes.

## Inspect audit log

- Audit entries are append-only rows in **`audit_log`**.
- Query **`audit_log`** filtering by `source` (`cli_socket`, `agent`, `system`), time range, and correlation id.
- Redacted fields follow the configured redaction policy for tool arguments.

## Control socket permissions

- Unix socket at `LAYOUT.controlSocket` (default `/run/shoggoth/control.sock`) must **not** be usable by agent UIDs; image entrypoint sets owning user/group to `shoggoth`. If permissions drift, fix ownership and mode before restarting.
