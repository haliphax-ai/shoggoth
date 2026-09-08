---
date: 2026-09-08
completed: never
---

# Orchestration Dashboard

## Summary

A read-only web dashboard for monitoring the Shoggoth orchestration system, implemented as a first-class service plugin (`service-dashboard`). Provides real-time visibility into agent sessions, subagents, timers, tool calls, and system health through a Vue/Express/DaisyUI web application.

## Motivation

Shoggoth operates autonomously with agents running sessions, spawning subagents, scheduling timers, and executing tool calls — but there is currently no way to observe this activity in real time. Operators must rely on log files, Discord messages, and CLI commands to understand what is happening.

An orchestration dashboard provides:

- **Immediate visibility** into which agents are active, what they're doing, and how busy they are
- **Subagent lifecycle tracking** — see active subagents, their parent sessions, TTLs, and status
- **Timer monitoring** — view pending timers across all sessions
- **Tool call observation** — see which tools are being invoked in real time
- **Context utilization** — monitor context levels across sessions

This is especially valuable during multi-agent orchestration, debugging agent behavior, and verifying that subagents and timers are behaving as expected.

## Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Dashboard SPA (Vue + DaisyUI)                                   │
│   ├─ Main View: session grid cards                              │
│   ├─ Detail View: per-session subagents, timers, tool runs      │
│   └─ SSE connection for real-time updates                       │
└────────────────────┬────────────────────────────────────────────┘
                     │ HTTP + SSE
┌────────────────────▼────────────────────────────────────────────┐
│ Dashboard API Layer (Express)                                   │
│   ├─ GET /api/sessions         — session list                   │
│   ├─ GET /api/sessions/:id     — session detail                 │
│   ├─ GET /api/sessions/:id/subagents — subagent list            │
│   ├─ GET /api/sessions/:id/timers     — timer list              │
│   ├─ GET /api/sessions/:id/tool-runs  — active tool runs        │
│   └─ GET /api/events           — SSE event stream               │
└────────────────────┬────────────────────────────────────────────┘
                     │ Direct DB access (same process)
┌────────────────────▼────────────────────────────────────────────┐
│ Daemon State (SQLite)                                           │
│   ├─ sessions table (SessionStore)                              │
│   ├─ timers table (TimerScheduler)                              │
│   ├─ tool_runs table (ToolRunStore)                             │
│   └─ Event emitter (session/timer/tool-run events)              │
└─────────────────────────────────────────────────────────────────┘
```

### Data Access Strategy

The dashboard service plugin receives daemon dependencies via the `service.register` hook context. Since `service.register` provides `config` (which contains the state DB path) and `spawnSession` (for internal queries), the plugin will:

1. **Open its own read-only SQLite connection** to the state DB using the path from `config.stateDbPath` (or equivalent). This avoids coupling to the daemon's internal `db` handle while still accessing the same data.

2. **Use existing stores** (`SessionStore`, `TimerScheduler`, `ToolRunStore`) for structured queries. The dashboard creates its own store instances from its read-only DB connection.

3. **Subscribe to daemon events** for real-time updates. The plugin hooks into the daemon's event emitter (passed via the hook context or a shared event bus) to receive session create/update, timer fire, and tool run start/complete events.

### Status Derivation

Session status displayed on cards is derived from multiple signals:

| Derived Status | Condition                                                                    |
| -------------- | ---------------------------------------------------------------------------- |
| `idle`         | Session is `active` + no tool runs in `running` status                       |
| `generating`   | Session is `active` + last turn is in progress (no tool calls yet this turn) |
| `tool-call`    | Session is `active` + has tool runs with status `running`                    |
| `terminated`   | Session status is `terminated`                                               |
| `starting`     | Session status is `starting`                                                 |

The "active turn" detection uses a combination of `updatedAt` freshness (updated within last 30s) and tool run status.

### Real-Time Updates

**Server-Sent Events (SSE)** for real-time push:

- `GET /api/events` — SSE endpoint, optional `?session=<id>` filter
- Events: `session.created`, `session.updated`, `session.terminated`, `timer.scheduled`, `timer.fired`, `tool-run.started`, `tool-run.completed`, `tool-run.failed`
- The client falls back to polling (`GET /api/sessions` every 5s) if SSE disconnects

SSE was chosen over WebSocket because:

- Simpler server implementation (no upgrade handling needed)
- Built-in reconnection with `Last-Event-ID`
- One-directional (server → client) is sufficient for a read-only dashboard
- No CORS complexity for the initial connection

### Package Structure

```
packages/service-dashboard/
├── src/
│   ├── plugin.ts                    # Plugin entry point (createDashboardPlugin)
│   ├── server/
│   │   ├── index.ts                 # Express server creation
│   │   ├── config.ts                # Dashboard config types & defaults
│   │   ├── routes/
│   │   │   ├── sessions.ts          # Session list/detail endpoints
│   │   │   ├── subagents.ts         # Subagent list endpoint
│   │   │   ├── timers.ts            # Timer list endpoint
│   │   │   ├── tool-runs.ts         # Tool run list endpoint
│   │   │   └── events.ts            # SSE event stream
│   │   └── services/
│   │       ├── dashboard-data.ts    # Data access layer (reads DB)
│   │       └── event-relay.ts       # Daemon event → SSE bridge
│   └── client/                      # Vue SPA (built by Vite)
│       ├── index.html
│       ├── src/
│       │   ├── main.ts
│       │   ├── App.vue
│       │   ├── router.ts
│       │   ├── views/
│       │   │   ├── DashboardView.vue    # Main grid view
│       │   │   └── SessionView.vue      # Per-session detail view
│       │   ├── components/
│       │   │   ├── SessionCard.vue      # Grid card component
│       │   │   ├── SubagentList.vue     # Subagent table
│       │   │   ├── TimerList.vue        # Timer table
│       │   │   └── ToolRunList.vue      # Tool run table
│       │   ├── composables/
│       │   │   ├── useSse.ts            # SSE connection composable
│       │   │   └── usePolling.ts        # Polling fallback
│       │   └── api/
│       │       └── client.ts            # API client functions
│       └── ...
├── vite.config.ts
├── tsconfig.json
├── package.json
└── dist/
    └── client/   # Built SPA output
```

### API Layer Separation

The API layer (`src/server/`) is designed to be reusable by different consumers:

- **Web UI** (Vue SPA) — served as static files by the Express server
- **CLI** — a future `shoggoth dashboard status` command could call the same API
- **Programmatic** — other plugins or tools could import `DashboardData` directly

The `DashboardData` service class encapsulates all data access. It accepts a SQLite database handle and exposes methods that return plain TypeScript types (no Express dependencies). This makes it testable in isolation and usable outside the HTTP context.

### Read-Only Design (with Mutation Extension Points)

All endpoints in iteration 1 are GET-only. The API layer is structured so that POST/PUT/DELETE endpoints can be added later without restructuring:

- Routes are organized by resource (sessions, timers, tool-runs)
- `DashboardData` methods are named as queries (`getSessions`, `getSessionDetail`)
- The Express app is composed from route modules — new route modules for mutations can be mounted alongside existing ones

## Testing Strategy

- **Unit tests** for `DashboardData` service — mock SQLite DB, verify query correctness
- **Unit tests** for status derivation logic — verify status calculation from various session/tool-run states
- **Unit tests** for `EventRelay` — verify event filtering and SSE formatting
- **Integration tests** for API routes — use supertest to verify endpoint responses
- **E2E tests** for Vue components — verify card rendering, expansion, navigation
- **Test files**: `packages/service-dashboard/test/` mirroring `src/` structure

## Considerations

- **DB connection safety** — The dashboard opens a read-only SQLite connection. This prevents the dashboard from interfering with the daemon's writes. SQLite's WAL mode supports concurrent readers.
- **Performance** — Dashboard queries are simple (SELECT with WHERE). At typical Shoggoth scale (<100 sessions), these will be sub-millisecond. No pagination needed initially, but `limit` and `offset` params should be available on list endpoints for future-proofing.
- **Context level display** — Context level is stored as a string enum. The dashboard can display it as a badge (e.g., "full", "minimal", "lean") without transformation.
- **Model display** — `modelSelection` is a JSON blob. The dashboard extracts and displays the human-readable model name. Format varies by provider; a utility function handles common patterns.
- **Subagent TTL** — `subagentExpiresAtMs` is an absolute timestamp. The dashboard shows both the expiry time and a countdown.
- **Event ordering** — SSE events use a monotonically increasing sequence number so the client can detect gaps and fall back to polling if needed.
- **Plugin approval** — Like canvas, the dashboard plugin requires operator approval before activation (pending the service-auth plan). For now, it registers with the standard plugin lifecycle.
- **Configuration** — Port, host, and basePath are configurable via `ShoggothConfig.services.dashboard`, following the same pattern as `services.canvas`.
- **Security** — The dashboard is read-only and exposes only aggregated state data. No sensitive information (API keys, tokens, raw messages) is exposed. Future iterations should add authentication if the dashboard is exposed beyond localhost.

## Migration

- No database schema changes required — all data already exists in existing tables
- New config key: `services.dashboard` (optional, all fields have defaults)
- Plugin is opt-in: only activates when listed in plugin config
- No breaking changes to existing functionality

## References

- [`spec.md`](spec.md) — type signatures, API schemas, code examples
- [`implementation.md`](implementation.md) — phased implementation steps
- [Service Canvas Plugin](../../packages/service-canvas/src/plugin.ts) — reference plugin pattern
- [Session Store](../../packages/daemon/src/sessions/session-store.ts) — session data model
- [Timer Scheduler](../../packages/daemon/src/timers/timer-scheduler.ts) — timer data access
- [Tool Run Store](../../packages/daemon/src/sessions/tool-run-store.ts) — tool run tracking
- [Plugin Hook Types](../../packages/plugins/src/hook-types.ts) — ServiceRegisterCtx, PluginServiceEntry
