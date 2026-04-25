# `@shoggoth/daemon`

SQLite-backed daemon: control plane (Unix socket), Discord messaging bridge, tool loop, MCP pools, HITL, cron/heartbeat, memory index, and retention jobs.

- **Source:** `src/`
- **Tests:** `test/` (`npm run test`)
- **Typecheck:** `npm run typecheck` → `tsgo --noEmit`. Run: `npm run daemon` or `node --import tsx/esm packages/daemon/src/index.ts` (library: `src/index.ts`, `src/lib.ts`).
