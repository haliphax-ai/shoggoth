# Load smoke — Shoggoth

Rough guidance for concurrent sessions, heartbeat backlog, and SQLite behavior. This is not a performance SLA.

## SQLite

- State DB opens with **WAL** journal mode, `synchronous = NORMAL`, and **busy_timeout** default **5000 ms** (see `openStateDb` in `@shoggoth/daemon`).
- **Single writer** semantics still apply: many readers can overlap; writers serialize. Heavy concurrent writes from multiple processes may see `SQLITE_BUSY` until the busy timeout elapses.
- **Recommendation:** one daemon process owns the DB file; scale sessions inside that process before adding second writers.

## Automated smoke

- Package `@shoggoth/daemon` includes `test/load-smoke.test.ts`: burst event emits and multi-handle access to one DB file. Run with `npm run test -w @shoggoth/daemon`.

## Manual smoke (operator)

1. Start the stack (e.g. `docker compose up` with the Shoggoth image).
2. Open **N** concurrent sessions (or CLI-driven tool loops) that emit events or append transcripts.
3. Watch daemon logs for `SQLITE_BUSY` or heartbeat consumer lag.
4. If backlog grows without bound, reduce concurrency, increase `busy_timeout` (with care), or split workloads.

## Heartbeat backlog

- Heartbeat drains batches; a sustained **emit rate > drain rate** increases queue depth.
- Mitigations: lower emit frequency, widen heartbeat interval only if latency acceptable, or add workers if the implementation supports a pool.
