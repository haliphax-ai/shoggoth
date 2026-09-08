# Orchestration Dashboard — Implementation Plan

## Phase 1: Package Scaffolding & DashboardData Service

**Goal:** Create the `service-dashboard` package with the data access layer and unit tests. No server, no UI — just the core data logic.

**Files created:**

- `packages/service-dashboard/package.json`
- `packages/service-dashboard/tsconfig.json`
- `packages/service-dashboard/vitest.config.ts`
- `packages/service-dashboard/src/server/config.ts`
- `packages/service-dashboard/src/server/services/dashboard-data.ts`
- `packages/service-dashboard/test/server/services/dashboard-data.test.ts`

**Steps:**

1. Create `packages/service-dashboard/package.json` following the canvas plugin pattern:
   - Name: `@shoggoth/service-dashboard`
   - Dependencies: `@shoggoth/plugins`, `@shoggoth/shared`, `better-sqlite3`, `express`
   - `shoggothPlugin` metadata with `kind: "service"`, `entrypoint: "./src/plugin.ts"`

2. Create `tsconfig.json` extending `tsconfig.base.json`.

3. Create `src/server/config.ts` with `DashboardServiceConfig` interface and `DEFAULT_DASHBOARD_CONFIG` as specified in `spec.md`.

4. Create `src/server/services/dashboard-data.ts` — the `DashboardData` class:
   - Constructor takes a `better-sqlite3` Database handle and config
   - `getSessions()` — query `sessions` table, filter out subagents (where `parent_session_id IS NULL`), map to `SessionCardData[]`
   - `getSessionDetail(sessionId)` — query single session, enrich with subagent count and timer count
   - `getSessionStats(sessionId)` — query `session_stats` table, compute `contextFillTokens` via `estimateCurrentContextFill()`, return `SessionStatsData`
   - `getSubagents(sessionId)` — query sessions where `parent_session_id = sessionId`
   - `getTimers(sessionId)` — use `TimerScheduler.listForSession()` pattern (direct SQL: `SELECT ... FROM timers WHERE session_id = ? AND fired = 0`)
   - `getToolRuns(sessionId)` — query `tool_runs` table for the session's current `context_segment_id`
   - `deriveStatus()` — status derivation algorithm from `spec.md` (uses `last_turn_at` from session_stats, not `updatedAt`)
   - `extractModelInfo()` — model info extraction from `spec.md`
   - `formatTimeRemaining()` — countdown formatter

5. Write tests in `test/server/services/dashboard-data.test.ts`:
   - Create in-memory SQLite DB with schema matching the real tables
   - Insert test sessions (primary + subagent), timers, tool runs, session_stats
   - Test `getSessions` returns only primary sessions
   - Test `getSessionDetail` returns enriched data
   - Test `getSessionStats` returns stats with computed context fill
   - Test `getSubagents` returns children of a given session
   - Test `getTimers` returns unfired timers sorted by fire_at
   - Test `getToolRuns` returns running/completed/failed runs
   - Test `deriveStatus` with all status combinations (idle, generating, tool-call, terminated, starting)
   - Test `deriveStatus` uses `lastTurnAt` — a session with recent `updatedAt` but old `lastTurnAt` should be `idle`
   - Test `extractModelInfo` with various model selection formats
   - Test `formatTimeRemaining` for future, past, and boundary timestamps

6. Add workspace `npm install` to wire up the new package.

**Acceptance criteria:**

- All tests pass
- `DashboardData` has no Express dependencies
- Typecheck passes

---

## Phase 2: Lifecycle Event Emission

**Goal:** Add an in-process EventEmitter to daemon stores so that the SSE relay (Phase 4) has a real-time event source. The existing `events-queue.ts` is a durable, retry-based queue for cron jobs — it does NOT provide in-process pub/sub needed for SSE.

**Why this phase exists:** The feasibility review identified that Phase 4 (SSE Event Relay) depends on lifecycle events that no current code emits. Without this phase, the SSE endpoint would have nothing to subscribe to.

**Files created:**

- `packages/daemon/src/events/daemon-event-emitter.ts`
- `packages/daemon/src/events/daemon-event-emitter.test.ts`

**Files modified:**

- `packages/daemon/src/sessions/session-store.ts` — emit `session:created`, `session:updated`, `session:terminated`
- `packages/daemon/src/timers/timer-scheduler.ts` — emit `timer:scheduled`, `timer:fired`
- `packages/daemon/src/sessions/tool-run-store.ts` — emit `tool-run:started`, `tool-run:completed`, `tool-run:failed`
- `packages/daemon/src/sessions/tool-loop.ts` — pass `toolName` to tool-run events

**Steps:**

1. Create `packages/daemon/src/events/daemon-event-emitter.ts`:
   - Define `DaemonLifecycleEvents` interface (as specified in `spec.md`)
   - Create `DaemonEventEmitter` class wrapping Node.js `EventEmitter` with type-safe `emit`/`on`/`off` methods
   - Export as singleton or injectable dependency (prefer injectable for testability)

2. Write tests for `DaemonEventEmitter`:
   - Test that `emit` triggers registered listeners with correct payload
   - Test that `off` removes listeners
   - Test type safety (compile-time checks via TypeScript)

3. Modify `session-store.ts`:
   - Accept `IDaemonEventEmitter` in `createSessionStore()` (optional, backward-compatible)
   - Emit `session:created` after successful INSERT in `create()`
   - Emit `session:updated` after successful UPDATE in `update()`
   - Emit `session:terminated` when status changes to `terminated` in `update()`

4. Modify `tool-run-store.ts`:
   - Accept `IDaemonEventEmitter` in `createToolRunStore()` (optional)
   - Emit `tool-run:started` in `insertRunning()`
   - Emit `tool-run:completed` in `markCompleted()`
   - Emit `tool-run:failed` in `markFailed()`
   - Note: `toolName` is not in the `tool_runs` table — the emitter must accept it as a parameter or the tool loop must pass it

5. Modify `tool-loop.ts`:
   - Pass `toolName` to the `ToolRunStore` emitter calls so events include the tool name
   - This requires a thin adapter or passing the emitter through the options

6. Modify `timer-scheduler.ts`:
   - Accept `IDaemonEventEmitter` in `createTimerScheduler()` (optional)
   - Emit `timer:scheduled` when a timer is created
   - Emit `timer:fired` when a timer fires

7. Wire the emitter into the daemon bootstrap so all stores share the same instance.

**Acceptance criteria:**

- All existing tests still pass (emitter is optional, backward-compatible)
- New emitter tests pass
- Stores emit events on state changes
- No circular dependencies introduced
- Typecheck passes

---

## Phase 3: API Routes & Express Server

**Goal:** Wire up the Express server with all REST API endpoints. Serve test responses. Still no UI.

**Files created:**

- `packages/service-dashboard/src/server/index.ts`
- `packages/service-dashboard/src/server/routes/sessions.ts`
- `packages/service-dashboard/src/server/routes/subagents.ts`
- `packages/service-dashboard/src/server/routes/timers.ts`
- `packages/service-dashboard/src/server/routes/tool-runs.ts`
- `packages/service-dashboard/test/server/routes/sessions.test.ts`

**Steps:**

1. Create route modules following Express 5 patterns (same as canvas):
   - `routes/sessions.ts` — `GET /api/sessions` (list) and `GET /api/sessions/:id` (detail)
   - `routes/subagents.ts` — `GET /api/sessions/:id/subagents`
   - `routes/timers.ts` — `GET /api/sessions/:id/timers`
   - `routes/tool-runs.ts` — `GET /api/sessions/:id/tool-runs`
   - Each route module exports an Express Router factory function that accepts `DashboardData`
   - All routes return `{ ok: true, data: ... }` envelope or `{ ok: false, error: "..." }` on not-found

2. Create `src/server/index.ts` — `createDashboardServer()`:
   - Opens read-only SQLite connection
   - Instantiates `DashboardData`
   - Mounts all route modules
   - Creates HTTP server, starts listening on `127.0.0.1` (not `0.0.0.0`)
   - Returns `DashboardServer` handle with `close()` method
   - Serves SPA static files from `dist/client/` (with SPA fallback, same pattern as canvas)

3. Write route tests using supertest:
   - Test `GET /api/sessions` returns session list with stats
   - Test `GET /api/sessions?agentId=X` filters correctly
   - Test `GET /api/sessions/:id` returns detail for valid session
   - Test `GET /api/sessions/:id` returns 404 for invalid session
   - Test `GET /api/sessions/:id/subagents` returns subagent list
   - Test `GET /api/sessions/:id/timers` returns timer list
   - Test `GET /api/sessions/:id/tool-runs` returns tool run list

**Acceptance criteria:**

- All route tests pass
- Server starts and responds to HTTP requests
- 404 handling works for missing sessions
- Server binds to `127.0.0.1` by default
- Typecheck passes

---

## Phase 4: SSE Event Relay

**Goal:** Add the SSE event stream endpoint for real-time updates, wired to the lifecycle emitter from Phase 2.

**Files created:**

- `packages/service-dashboard/src/server/services/event-relay.ts`
- `packages/service-dashboard/src/server/routes/events.ts`
- `packages/service-dashboard/test/server/services/event-relay.test.ts`

**Steps:**

1. Create `EventRelay` class:
   - Maintains a `Set` of connected SSE clients (express.Response objects)
   - `addClient(res, filter?)` — sets SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`), adds to client set, handles disconnect cleanup
   - `removeClient(res)` — removes from client set
   - `broadcast(event)` — assigns monotonically increasing `seq`, filters by session if client subscribed, formats as SSE `id:` + `event:` + `data:` lines
   - `close()` — closes all client connections, clears set
   - Handles `Last-Event-ID` header for reconnection (client sends this on reconnect)

2. Create `routes/events.ts` — `GET /api/events`:
   - Extracts optional `?session=<id>` query parameter
   - Calls `eventRelay.addClient(res, { sessionId })`
   - Handles connection close (client disconnect) via `req.on('close')`

3. Wire `EventRelay` to the `DaemonEventEmitter` from Phase 2:
   - Subscribe to all lifecycle events
   - Translate daemon events to SSE `DashboardEvent` format
   - Filter by session if client subscribed

4. Wire `EventRelay` into `createDashboardServer()`:
   - Instantiate alongside `DashboardData`
   - Pass to events route
   - Call `eventRelay.close()` in server shutdown

5. Write tests for `EventRelay`:
   - Test that `broadcast` sends formatted SSE to connected clients
   - Test that session filter works (client only receives events for their session)
   - Test that `removeClient` stops delivery
   - Test sequence number increments monotonically
   - Test `close` disconnects all clients
   - Test `Last-Event-ID` handling (client reconnects with seq, gets missed events — or falls back to polling)
   - Test that daemon lifecycle events are properly translated to SSE events

**Acceptance criteria:**

- SSE endpoint returns proper event-stream headers
- Events are broadcast to all connected clients
- Session filtering works
- Client disconnect is handled gracefully
- Events from Phase 2 lifecycle emitter appear on the SSE stream
- Typecheck passes

---

## Phase 5: Plugin Entry Point & Integration

**Goal:** Wire up the plugin lifecycle so the dashboard activates with the daemon.

**Files created:**

- `packages/service-dashboard/src/plugin.ts`
- `packages/service-dashboard/test/plugin.test.ts`

**Steps:**

1. Create `src/plugin.ts` — `createDashboardPlugin()`:
   - Follows exact pattern from canvas: default export, `Plugin<ShoggothHooks>`, hooks for `daemon.configure`, `service.register`, `health.register`, `daemon.shutdown`
   - In `service.register`: merge user config from `ctx.config.services?.dashboard`, create dashboard server, register service, register health probe
   - Extended `ServiceRegisterCtx` type with dashboard config (same pattern as canvas)
   - No tools registered (read-only dashboard)

2. Add `health.register` probe that checks `server.listening`.

3. Write plugin tests:
   - Test that `createDashboardPlugin` returns a valid plugin with correct name and hooks
   - Test that `service.register` creates server and registers service entry
   - Test that `daemon.shutdown` closes server
   - Test config merging (defaults + user overrides)

4. Add the package to the workspace `package.json` workspaces array (if applicable) and ensure it's discoverable by the daemon plugin loader.

**Acceptance criteria:**

- Plugin activates when listed in daemon config
- Health probe reports pass when server is listening
- Server shuts down cleanly on daemon shutdown
- Typecheck passes

---

## Phase 6: Vue SPA Client

**Goal:** Build the web UI with the main grid view and detail view.

**Files created:**

- `packages/service-dashboard/vite.config.ts`
- `packages/service-dashboard/src/client/index.html`
- `packages/service-dashboard/src/client/src/main.ts`
- `packages/service-dashboard/src/client/src/App.vue`
- `packages/service-dashboard/src/client/src/router.ts`
- `packages/service-dashboard/src/client/src/views/DashboardView.vue`
- `packages/service-dashboard/src/client/src/views/SessionView.vue`
- `packages/service-dashboard/src/client/src/components/SessionCard.vue`
- `packages/service-dashboard/src/client/src/components/SubagentList.vue`
- `packages/service-dashboard/src/client/src/components/TimerList.vue`
- `packages/service-dashboard/src/client/src/components/ToolRunList.vue`
- `packages/service-dashboard/src/client/src/composables/useSse.ts`
- `packages/service-dashboard/src/client/src/composables/usePolling.ts`
- `packages/service-dashboard/src/client/src/api/client.ts`

**Steps:**

1. Create `vite.config.ts` following canvas pattern:
   - Vue plugin + Tailwind CSS + DaisyUI
   - `base: "/svc/dashboard/"`
   - `root: "src/client"`
   - Build output to `../../dist/client`
   - Dev proxy for API routes

2. Create SPA scaffold:
   - `index.html` entry point
   - `main.ts` — mount Vue app with router
   - `App.vue` — layout with nav bar and router view
   - `router.ts` — routes for `/` (dashboard) and `/sessions/:id` (detail)

3. Build `DashboardView.vue`:
   - Fetches `GET /api/sessions` on mount
   - Renders grid of `SessionCard` components
   - Subscribes to SSE for real-time updates (cards update in place)
   - Falls back to polling if SSE disconnects

4. Build `SessionCard.vue`:
   - Displays: agent ID, status badge (color-coded), model, last activity
   - Displays: token usage, turn count, context fill % from session stats
   - Expandable section: subagent count, timer count, context level
   - Click navigates to detail view
   - Status badges: idle=gray, generating=blue, tool-call=orange, terminated=red, starting=yellow

5. Build `SessionView.vue`:
   - Fetches session detail + subagents + timers + tool runs + stats on mount
   - Displays full session info at top including token usage and context fill
   - Tabbed sections for subagents, timers, tool runs
   - Subscribes to SSE filtered to this session
   - Auto-refreshes on relevant events

6. Build `SubagentList.vue`, `TimerList.vue`, `ToolRunList.vue`:
   - Table components with appropriate columns
   - Timer list shows countdown
   - Tool run list shows status and timestamps

7. Build composables:
   - `useSse(url)` — manages SSE connection, reconnection, event parsing
   - `usePolling(fetchFn, intervalMs)` — periodic polling fallback

8. Build API client:
   - Typed fetch wrappers for each endpoint
   - Base URL derived from current page origin + basePath

**Acceptance criteria:**

- `npm run build:client` produces working SPA
- Main view shows session grid with live updates and token stats
- Detail view shows subagents, timers, tool runs, and context utilization
- SSE updates cards in real time
- Polling fallback works when SSE disconnects
- Responsive layout with DaisyUI styling

---

## Phase 7: Polish, Documentation & PR

**Goal:** Final integration, documentation, and opening the PR.

**Files created/modified:**

- `packages/service-dashboard/README.md` (package readme)
- `packages/service-dashboard/src/client/src/style.css` (Tailwind base)

**Steps:**

1. Run full test suite (`npm test` in `packages/service-dashboard/`)
2. Run typecheck across all packages
3. Verify the dashboard plugin loads with the daemon (manual smoke test)
4. Add package-level README with usage instructions
5. Clean up any TODO comments or placeholder code
6. Commit all changes with a descriptive message
7. Push the branch
8. Open PR with `gh pr create`

**Acceptance criteria:**

- All tests pass
- Typecheck passes across workspace
- PR is open with description linking to the plan
- Dashboard is functional when enabled in daemon config
