# Orchestration Dashboard — Specification

## TypeScript Interfaces

### Dashboard Configuration

```typescript
/** Dashboard-specific config from ShoggothConfig.services.dashboard */
export interface DashboardServiceConfig {
  /** Port to listen on (default: 3457) */
  port?: number;
  /** Host address to bind to (default: "127.0.0.1") */
  host?: string;
  /** Base path for the dashboard (default: "/svc/dashboard") */
  basePath?: string;
  /** Path to the state SQLite DB (derived from daemon config if omitted) */
  stateDbPath?: string;
  /** Polling interval in ms for SSE fallback (default: 5000) */
  pollingIntervalMs?: number;
  /** How fresh updatedAt must be to consider a session "active" (default: 30000) */
  activeThresholdMs?: number;
}

export const DEFAULT_DASHBOARD_CONFIG: Required<DashboardServiceConfig> = {
  port: 3457,
  host: "127.0.0.1",
  basePath: "/svc/dashboard",
  stateDbPath: "", // derived from config at runtime
  pollingIntervalMs: 5000,
  activeThresholdMs: 30000,
};
```

### Derived Session Status

```typescript
/**
 * Dashboard-specific session status, derived from DB state.
 * This is NOT the same as SessionRow.status — it's a richer
 * derived status for display purposes.
 */
export type DashboardSessionStatus =
  | "idle"
  | "generating"
  | "tool-call"
  | "terminated"
  | "starting";

/**
 * Minimal model info extracted from modelSelection JSON.
 */
export interface ModelInfo {
  /** Provider ID (e.g. "anthropic", "openai", "google") */
  provider?: string;
  /** Model name (e.g. "claude-sonnet-4-20250514", "gpt-4o") */
  model?: string;
  /** Full display string (e.g. "anthropic/claude-sonnet-4-20250514") */
  display: string;
}

/**
 * Session card data for the main grid view.
 */
export interface SessionCardData {
  /** Session URN (e.g. "agent:main:discord:channel:123") */
  id: string;
  /** Agent ID parsed from URN */
  agentId: string;
  /** Derived dashboard status */
  status: DashboardSessionStatus;
  /** Human-readable model name */
  model: ModelInfo;
  /** ISO 8601 timestamp of last activity */
  lastActivity: string;
  /** Number of active subagents (children of this session) */
  activeSubagentCount: number;
  /** Number of pending timers */
  timerCount: number;
  /** Current context level */
  contextLevel?: string;
  /** Whether this is a subagent session */
  isSubagent: boolean;
  /** Subagent mode if applicable */
  subagentMode?: string;
  /** Subagent TTL expiry if applicable */
  subagentExpiresAt?: string;
  /** Session stats summary (token usage, turns, context fill) — null if no stats row exists */
  stats?: SessionStatsData | null;
}

/**
 * Detailed session data for the detail view.
 */
export interface SessionDetailData extends SessionCardData {
  /** Full session status from DB */
  rawStatus: string;
  /** Workspace path */
  workspacePath: string;
  /** Creation timestamp */
  /** Whether the session has an active turn (based on last_turn_at freshness) */
  hasActiveTurn: boolean;
```

### Subagent Data

```typescript
/**
 * Active subagent information for the detail view.
 */
export interface SubagentData {
  /** Subagent session URN */
  id: string;
  /** Agent ID */
  agentId: string;
  /** Derived status */
  status: DashboardSessionStatus;
  /** Subagent mode (one_shot | persistent) */
  mode?: string;
  /** ISO 8601 TTL expiry */
  expiresAt?: string;
  /** Human-readable TTL countdown */
  ttlRemaining?: string;
  /** Last activity timestamp */
  lastActivity: string;
  /** Delivery mode */
  deliveryMode?: string;
}
```

### Timer Data

```typescript
/**
 * Pending timer for a session.
 */
export interface TimerData {
  /** Timer ID */
  id: string;
  /** Timer label */
  label: string;
  /** ISO 8601 fire time */
  fireAt: string;
  /** Human-readable countdown */
  timeRemaining?: string;
  /** Timer message content */
  message: string;
}
```

### Tool Run Data

```typescript
/**
 * Tool run in the current context segment.
 */
export interface ToolRunData {
  /** Tool run ID */
  id: string;
  /** Run status: "running" | "completed" | "failed" */
  status: string;
  /** ISO 8601 start time */
  startedAt: string;
  /** Failure reason if failed */
  failureReason?: string;
  failureReason?: string;
}
```

### Session Stats Data

```typescript
/**
 * Session statistics from the session_stats table.
 * Provides token usage, turn counts, and context utilization.
 */
export interface SessionStatsData {
  /** Session URN */
  sessionId: string;
  /** Number of completed turns in the current context segment */
  turnCount: number;
  /** Number of context compactions */
  compactionCount: number;
  /** Total input tokens consumed */
  inputTokens: number;
  /** Total output tokens produced */
  outputTokens: number;
  /** Context window size in tokens (from model), null if unknown */
  contextWindowTokens: number | null;
  /** Estimated current context fill in tokens (computed from transcript) */
  contextFillTokens: number;
  /** ISO 8601 timestamp of first turn */
  firstTurnAt: string | null;
  /** ISO 8601 timestamp of last turn (used for "generating" detection) */
  lastTurnAt: string | null;
  /** ISO 8601 timestamp of last compaction */
  lastCompactedAt: string | null;
  /** Number of transcript messages in current context segment */
  transcriptMessageCount: number;
}
```

### API Response Types
### API Response Types

```typescript
/** Standard API response envelope */
export interface ApiResponse<T> {
  ok: true;
  data: T;
}

export interface ApiErrorResponse {
  ok: false;
  error: string;
}

/** GET /api/sessions response */
export type SessionsResponse = ApiResponse<SessionCardData[]>;

/** GET /api/sessions/:id response */
export type SessionDetailResponse = ApiResponse<SessionDetailData>;

/** GET /api/sessions/:id/subagents response */
export type SubagentsResponse = ApiResponse<SubagentData[]>;

/** GET /api/sessions/:id/timers response */
export type TimersResponse = ApiResponse<TimerData[]>;

/** GET /api/sessions/:id/tool-runs response */
export type ToolRunsResponse = ApiResponse<ToolRunData[]>;
```

### SSE Event Types

```typescript
/** Base SSE event */
export interface DashboardEvent {
  /** Monotonically increasing sequence number */
  seq: number;
  /** Event type */
  type: DashboardEventType;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Session URN this event relates to */
  sessionId: string;
  /** Event-specific payload */
  payload: unknown;
}

export type DashboardEventType =
  | "session.created"
  | "session.updated"
  | "session.terminated"
  | "timer.scheduled"
  | "timer.fired"
  | "tool-run.started"
  | "tool-run.completed"
  | "tool-run.failed";

/** Session updated event payload */
export interface SessionUpdatedPayload {
  status: string;
  modelSelection?: unknown;
  contextLevel?: string;
  updatedAt: string;
}

/** Tool run event payload — note: tool_runs table does not store tool_name;
 *  the event emitter must attach it from the tool loop context at emit time. */
export interface ToolRunEventPayload {
  toolRunId: string;
  /** Attached by the lifecycle emitter from tool loop context, not from DB */
  toolName?: string;
  status: string;
}

### Lifecycle Event Emitter Types

The SSE Event Relay requires a real-time event source. The existing `events-queue.ts` is a durable, retry-based queue for cron jobs — it does NOT provide in-process pub/sub. A new `DaemonEventEmitter` (Node.js `EventEmitter`) will be added to daemon stores to emit lifecycle events that the SSE relay subscribes to.

```typescript
/**
 * Events emitted by daemon stores for real-time dashboard consumption.
 * These are in-process EventEmitter events (NOT the durable events queue).
 */
export interface DaemonLifecycleEvents {
  "session:created": { sessionId: string; agentId: string; status: string };
  "session:updated": { sessionId: string; status: string; updatedAt: string };
  "session:terminated": { sessionId: string };
  "timer:scheduled": { sessionId: string; timerId: string; label: string; fireAt: string };
  "timer:fired": { sessionId: string; timerId: string; label: string };
  "tool-run:started": { sessionId: string; toolRunId: string; toolName?: string };
  "tool-run:completed": { sessionId: string; toolRunId: string; toolName?: string };
  "tool-run:failed": { sessionId: string; toolRunId: string; toolName?: string; reason: string };
}

/**
 * Type-safe wrapper around Node.js EventEmitter for daemon lifecycle events.
 */
export interface IDaemonEventEmitter {
  emit<K extends keyof DaemonLifecycleEvents>(event: K, payload: DaemonLifecycleEvents[K]): void;
  on<K extends keyof DaemonLifecycleEvents>(event: K, listener: (payload: DaemonLifecycleEvents[K]) => void): void;
  off<K extends keyof DaemonLifecycleEvents>(event: K, listener: (payload: DaemonLifecycleEvents[K]) => void): void;
}
```

### DashboardData Service Interface

```typescript
/**
 * Core data access service. Accepts a DB handle and provides
 * all query methods needed by the dashboard API.
 *
 * This class has NO Express dependencies — it returns plain types
 * and can be used programmatically or tested with a mock DB.
 */
export interface IDashboardData {
export interface IDashboardData {
  /** List all primary (non-subagent) sessions as card data */
  getSessions(filter?: {
    status?: string;
    agentId?: string;
    limit?: number;
    offset?: number;
  }): SessionCardData[];

  /** Get detailed data for a single session */
  getSessionDetail(sessionId: string): SessionDetailData | undefined;

  /** Get session stats (token usage, turn count, context fill) */
  getSessionStats(sessionId: string): SessionStatsData | null;

  /** List active subagents for a session */
  getSubagents(sessionId: string): SubagentData[];

  /** List pending timers for a session */
  getTimers(sessionId: string): TimerData[];

  /** List recent tool runs for a session's current context segment */
  getToolRuns(sessionId: string): ToolRunData[];

  /**
   * Derive the dashboard status from session row, tool run state,
   * and session_stats.last_turn_at.
   * Uses last_turn_at instead of updatedAt to avoid false positives
   * from non-turn mutations (config updates, working directory changes).
   * Exported for testability.
   */
  deriveStatus(
    session: SessionRow,
    activeToolRuns: number,
    lastTurnAt: string | null,
    activeThresholdMs: number,
  ): DashboardSessionStatus;
}
```

### EventRelay Service Interface

```typescript
/**
 * Bridges daemon events to SSE client connections.
 * Manages connected clients and event sequencing.
 */
export interface IEventRelay {
  /** Add a client SSE connection */
  addClient(res: express.Response, filter?: { sessionId?: string }): void;

  /** Remove a client SSE connection */
  removeClient(res: express.Response): void;

  /** Broadcast an event to all matching clients */
  broadcast(event: Omit<DashboardEvent, "seq">): void;

  /** Get current sequence number */
  currentSeq(): number;
}
```

## API Endpoints

### `GET /api/sessions`

List all primary (non-subagent) sessions.

**Query Parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `status` | string | — | Filter by session status |
| `agentId` | string | — | Filter by agent ID |
| `limit` | number | 100 | Max results |
| `offset` | number | 0 | Pagination offset |

**Response:** `SessionsResponse`

### `GET /api/sessions/:id`

Get detailed data for a single session.

**Path Parameters:**
| Param | Type | Description |
|---|---|---|
| `id` | string | Session URN |

**Response:** `SessionDetailResponse`

### `GET /api/sessions/:id/subagents`

List active subagents for a session.

**Response:** `SubagentsResponse`

### `GET /api/sessions/:id/timers`

List pending timers for a session.

**Response:** `TimersResponse`

### `GET /api/sessions/:id/tool-runs`

List tool runs for the session's current context segment.

**Response:** `ToolRunsResponse`

### `GET /api/events`

Server-Sent Events stream.

**Query Parameters:**
| Param | Type | Default | Description |
|---|---|---|---|
| `session` | string | — | Filter events to a specific session |

**Headers:**

- `Last-Event-ID` — sequence number to resume from (client reconnection)

**Response:** `text/event-stream` with `DashboardEvent` payloads

**Event Format:**

```
id: <seq>
event: <type>
data: {"sessionId": "...", "timestamp": "...", "payload": {...}}

```

## Status Derivation Algorithm

```typescript
function deriveStatus(
  session: SessionRow,
  activeToolRuns: number,
  lastTurnAt: string | null,
  activeThresholdMs: number,
): DashboardSessionStatus {
  // Terminal states first
  if (session.status === "terminated") return "terminated";
  if (session.status === "starting") return "starting";

  // For active sessions, check tool run state
  if (activeToolRuns > 0) return "tool-call";

  // Use last_turn_at from session_stats instead of updatedAt.
  // updatedAt is set on ANY mutation (config updates, working directory
  // changes, etc.) which causes false "generating" states.
  // last_turn_at is only set when a model turn actually completes.
  if (lastTurnAt) {
    const lastTurnMs = new Date(lastTurnAt).getTime();
    const now = Date.now();
    if (now - lastTurnMs < activeThresholdMs) return "generating";
  }

  return "idle";
}
```
```

## Model Info Extraction

```typescript
function extractModelInfo(modelSelection: unknown): ModelInfo {
  if (!modelSelection || typeof modelSelection !== "object") {
    return { display: "unknown" };
  }

  const sel = modelSelection as Record<string, unknown>;

  // Common patterns:
  // { model: "claude-sonnet-4-20250514", provider: "anthropic" }
  // { ref: "anthropic/claude-sonnet-4-20250514" }
  // { model: "gpt-4o" }

  if (typeof sel.ref === "string") {
    const [provider, ...rest] = sel.ref.split("/");
    return {
      provider,
      model: rest.join("/"),
      display: sel.ref,
    };
  }

  const provider = typeof sel.provider === "string" ? sel.provider : undefined;
  const model = typeof sel.model === "string" ? sel.model : undefined;

  if (provider && model) {
    return { provider, model, display: `${provider}/${model}` };
  }

  if (model) {
    return { model, display: model };
  }

  return { display: JSON.stringify(modelSelection) };
}
```

## Time Utilities

```typescript
/**
 * Format a countdown from now to a future ISO timestamp.
 * Returns human-readable string like "5m 32s" or "expired".
 */
function formatTimeRemaining(isoTimestamp: string): string {
  const target = new Date(isoTimestamp).getTime();
  const now = Date.now();
  const diff = target - now;

  if (diff <= 0) return "expired";

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
```

## Plugin Entry Point

```typescript
/**
 * Create the Dashboard service plugin.
 * Follows the same pattern as service-canvas.
 */
export default function createDashboardPlugin(): Plugin<ShoggothHooks> {
  let dashboardServer: DashboardServer | undefined;

  return {
    name: "service-dashboard",
    hooks: {
      "daemon.configure"(ctx) {
        return ctx;
      },

      async "service.register"(ctx) {
        const typedCtx = ctx as ExtendedServiceRegisterCtx;
        const userConfig = typedCtx.config.services?.dashboard ?? {};

        const config: DashboardConfig = {
          ...DEFAULT_DASHBOARD_CONFIG,
          ...userConfig,
          stateDbPath:
            userConfig.stateDbPath ??
            typedCtx.config.stateDbPath ??
            "/var/lib/shoggoth/state/shoggoth.db",
          basePath: userConfig.basePath ?? "/svc/dashboard",
        };

        dashboardServer = createDashboardServer(config);

        await new Promise<void>((resolve) => {
          dashboardServer!.server.once("listening", resolve);
          if (dashboardServer!.server.listening) resolve();
        });

        ctx.registerService({
          id: "dashboard",
          expose: "both",
          protocol: "http",
          port: config.port,
        });

        // No tools registered — dashboard is read-only
      },

      "health.register"(ctx) {
        ctx.registerProbe({
          name: "dashboard",
          check: async () => ({
            status: dashboardServer?.server?.listening ? "pass" : "fail",
          }),
        });
      },

      async "daemon.shutdown"() {
        if (dashboardServer) {
          await dashboardServer.close();
          dashboardServer = undefined;
        }
      },
    },
  };
}
```

## Express Server Structure

```typescript
export interface DashboardServer {
  app: Express;
  server: HttpServer;
  data: DashboardData;
  eventRelay: EventRelay;
  close: () => Promise<void>;
}

export function createDashboardServer(config: DashboardConfig): DashboardServer {
  const app = express();

  // Open read-only DB connection
  const db = new Database(config.stateDbPath, { readonly: true });
  db.pragma("journal_mode = WAL"); // allows concurrent reads

  const data = new DashboardData(db, config);
  const eventRelay = new EventRelay();

  // API routes
  app.use(sessionsRoute(data));
  app.use(subagentsRoute(data));
  app.use(timersRoute(data));
  app.use(toolRunsRoute(data));
  app.use(eventsRoute(eventRelay));

  // Static SPA client
  const clientDistDir = path.resolve(__dirname, "../../dist/client");
  if (fs.existsSync(clientDistDir)) {
    app.use(express.static(clientDistDir));
    app.get("/{*splat}", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(clientDistDir, "index.html"));
    });
  }

  const server = createHttpServer(app);
  server.listen(config.port, config.host);

  return {
    app,
    server,
    data,
    eventRelay,
    close: async () => {
      eventRelay.close();
      db.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```
