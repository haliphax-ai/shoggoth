# @shoggoth/service-canvas

A Shoggoth service plugin that provides a cross-platform canvas server. Serves HTML content, renders A2UI v0.9 surfaces, and provides a WebSocket gateway for agent-driven UI control.

## Installation

Add the plugin to your Shoggoth config:

```json
{
  "plugins": [{ "package": "@shoggoth/service-canvas" }]
}
```

## Configuration

All configuration is provided via `services.canvas` in the Shoggoth config. No environment variables are used.

```json
{
  "services": {
    "canvas": {
      "host": "0.0.0.0",
      "port": 3456,
      "basePath": "/",
      "skipConfirm": false,
      "a2uiDbPath": "/var/lib/shoggoth/state/a2ui.db",
      "ignoreDirs": ["tmp", "jsonl"],
      "agentWorkspaces": {
        "developer": "/var/lib/shoggoth/workspaces/developer",
        "assistant": "/var/lib/shoggoth/workspaces/assistant"
      }
    }
  }
}
```

| Field             | Default                             | Description                                                   |
| ----------------- | ----------------------------------- | ------------------------------------------------------------- |
| `host`            | `"0.0.0.0"`                         | Bind address                                                  |
| `port`            | `3456`                              | Listen port                                                   |
| `basePath`        | `"/"`                               | Public base path when behind a reverse proxy (e.g. `/canvas`) |
| `skipConfirm`     | `false`                             | Skip deep link confirmation dialog when `true`                |
| `a2uiDbPath`      | `"/var/lib/shoggoth/state/a2ui.db"` | Path to SQLite database for A2UI surface persistence          |
| `ignoreDirs`      | `["tmp", "jsonl"]`                  | Directories excluded from file watching                       |
| `agentWorkspaces` | `{}`                                | Map of agent IDs to workspace root paths                      |

## Architecture

```
packages/
├── a2ui-sdk/                     # @shoggoth/a2ui-sdk
│   └── src/
│       ├── index.ts              # Barrel exports
│       ├── types.ts              # Shared types (A2UISurfaceState, DataSource, PackageDefinition, etc.)
│       ├── filters.ts            # applyFilters, computeAggregate, formatCompact
│       ├── ws.ts                 # sendEvent / registerWsSend
│       ├── composables/          # useDataSource, useFilterBind, useOptionsFrom, useSortable
│       └── utils/                # format-string, deep-link
├── a2ui-catalog-basic/           # @shoggoth/a2ui-catalog-basic
│   ├── catalog.json              # JSON Schema catalog definition
│   └── src/
│       ├── index.ts              # PackageDefinition
│       └── *.vue                 # Component implementations
├── a2ui-catalog-extended/        # @shoggoth/a2ui-catalog-extended
│   ├── catalog.json
│   └── src/
│       ├── index.ts              # PackageDefinition
│       └── *.vue
├── a2ui-catalog-all/             # @shoggoth/a2ui-catalog-all
│   ├── catalog.json
│   └── src/
│       └── index.ts              # Meta-catalog — re-exports basic + extended
├── service-canvas/               # @shoggoth/service-canvas (this package)
│   ├── src/
│   │   ├── plugin.ts            # Plugin entrypoint (service.register, health, shutdown)
│   │   └── server/
│   │       ├── index.ts         # Express server, startup, shutdown
│   │       ├── config.ts        # CanvasConfig interface and defaults
│   │       ├── services/
│   │       │   ├── gateway.ts           # WebSocket server (/gateway for agents, /ws for SPA)
│   │       │   ├── session-manager.ts
│   │       │   ├── file-resolver.ts     # Path resolution with traversal guard
│   │       │   ├── file-watcher.ts      # chokidar live reload
│   │       │   ├── jsonl-watcher.ts     # JSONL file watcher for A2UI auto-push
│   │       │   ├── a2ui-manager.ts      # A2UI surface state (in-memory cache, backed by a2ui-store)
│   │       │   ├── a2ui-store.ts        # SQLite persistence for A2UI surfaces (better-sqlite3)
│   │       │   ├── a2ui-pipeline.ts     # A2UI command processing pipeline
│   │       │   └── catalog-registry.ts  # Discovers catalog packages in node_modules/
│   │       ├── shared/
│   │       │   ├── deep-link-script.ts  # Injected script for shoggoth:// deep links
│   │       │   ├── snapshot-script.ts   # Injected script for canvas snapshots
│   │       │   └── url-schemes.ts       # URL scheme constants and parser
│   │       ├── commands/
│   │       │   ├── canvas.ts            # show, hide, navigate, navigateExternal, eval, snapshot
│   │       │   └── a2ui.ts              # push (JSONL), reset
│   │       └── routes/
│   │           ├── agent-proxy.ts       # POST /api/agent → sessionsSpawn (in-process)
│   │           └── file-spawn.ts        # POST /api/file-spawn → read prompt → sessionsSpawn
│   ├── test/
│   └── docs/
```

## Monorepo Packages

| Package                           | Description                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `@shoggoth/a2ui-sdk`              | Component SDK — types, composables, filters, event helpers                                      |
| `@shoggoth/a2ui-catalog-basic`    | Basic catalog — Column, Row, Text, Button, Image, Tabs, Divider, Slider, Checkbox, ChoicePicker |
| `@shoggoth/a2ui-catalog-extended` | Extended catalog — Badge, Table, Stack, Spacer, ProgressBar, Repeat, Accordion                  |
| `@shoggoth/a2ui-catalog-all`      | All catalog — re-exports basic + extended                                                       |

## Tools

The plugin registers 8 direct service tools:

| Command                 | Description                                       |
| ----------------------- | ------------------------------------------------- |
| `canvas.present`        | Show/present canvas content                       |
| `canvas.hide`           | Hide the canvas panel                             |
| `canvas.navigate`       | Navigate to a canvas session/path or external URL |
| `canvas.eval`           | Execute JavaScript in the canvas context          |
| `canvas.snapshot`       | Capture the current canvas as a base64 PNG        |
| `canvas.a2ui.push`      | Push A2UI surface commands (structured)           |
| `canvas.a2ui.pushJSONL` | Push A2UI JSONL payload (string)                  |
| `canvas.a2ui.reset`     | Clear A2UI surface state                          |

See [Tool Reference](../../docs/canvas/tools.md) for full parameter documentation.

## Custom URL Schemes

### `shoggoth://` — Agent Deep Links

Trigger agent runs from links inside canvas HTML. When a user clicks a `shoggoth://` link in the canvas iframe, a confirmation dialog appears, and on approval the request spawns an agent session via `sessionsSpawn`.

```html
<a href="shoggoth://agent?message=run+my+task">Run Task</a>
```

See [Deep Linking](../../docs/canvas/deep-linking.md) for the full URL format, parameters, confirmation dialog, script injection details, and security considerations.

### `shoggoth-fileprompt://` — File-Based Subagent Spawn

Spawn a subagent whose task is the contents of a file. The **path after the scheme** identifies the file (not `?file=`). The server resolves it under **`<agent workspace>/canvas`** when `agentId` matches a configured agent in `agentWorkspaces`, otherwise under `basePath`. See [Deep Linking](../../docs/canvas/deep-linking.md#file-based-subagent-spawn--shoggoth-fileprompt-urls).

```html
<a href="shoggoth-fileprompt://jsonl/deploy-notes.md?agentId=developer">Deploy</a>
```

### `shoggoth-canvas://` — Canvas File References

Reference files in other canvas sessions without hardcoding the server origin or base path. The SPA rewrites these URLs at runtime to the correct `/_c/<session>/<path>` route.

**Format:** `shoggoth-canvas://<session>/<path>`

**Example:**

```html
<img src="shoggoth-canvas://my-project/logo.png" />
<a href="shoggoth-canvas://dashboard/index.html">Open Dashboard</a>
```

## API Endpoints

| Endpoint             | Method | Description                                                                     |
| -------------------- | ------ | ------------------------------------------------------------------------------- |
| `/api/agent`         | POST   | Calls `sessionsSpawn` in-process via trusted plugin identity                    |
| `/api/file-spawn`    | POST   | Reads a prompt file from `<agent workspace>/canvas`; spawns via `sessionsSpawn` |
| `/api/canvas-config` | GET    | Returns canvas configuration for the SPA                                        |

## Canvas Session URLs

Each canvas session is accessed via its session ID in the URL path:

```
http://<host>:<port>/<sessionId>/
```

For example:

- `http://localhost:3456/main/` — the default `main` session
- `http://localhost:3456/developer/` — the `developer` session

When running behind a reverse proxy with a base path (e.g., `basePath: "/canvas"`):

- `https://example.com/canvas/developer/`

The root path (`/`) redirects to `/main/` by default.

Sessions map to the `canvas/` directory of each agent listed in `agentWorkspaces`; a session only exists once its directory is present on disk — the server does not create it. In deployments without a `main` agent, `/main/` returns 404.

## Session Files

Place HTML/CSS/JS files in the agent's `canvas/` workspace directory. The server serves them at `/<session>/<path>`. File changes trigger live reload in the browser.

## A2UI Persistence

A2UI surface state is persisted to a local SQLite database so it survives server restarts. On startup, all cached surfaces are loaded from the database and replayed to connecting SPA clients.

- The database is managed by `A2UIStore` (`better-sqlite3`, synchronous)
- The in-memory `Map` in `A2UIManager` remains the primary data source; SQLite is the backing store
- Every mutation (`upsertSurface`, `setRoot`, `updateDataModel`, `deleteSurface`, `clearAll`) writes through to SQLite
- DB location defaults to `/var/lib/shoggoth/state/a2ui.db`, configurable via `a2uiDbPath`

## Reactive Data Binding (A2UI)

A2UI surfaces support a reactive data-binding layer that lets agents push structured data sources and bind UI components to live, filterable data.

Key capabilities:

- **Data Sources** — Push named datasets via `updateDataModel` (with `$sources`) or the `dataSourcePush` JSONL shorthand. Supports incremental merges with `primaryKey`.
- **Filtering** — Select and MultiSelect components can `bind` to data sources, applying filter operations (`eq`, `contains`, `gte`, `lte`, `range`, `in`) that reactively update all bound displays. Clearing a MultiSelect shows all data.
- **Sorting** — Table and Repeat components support optional sorting via the `sortable` prop. Tables sort by clicking column headers (⬆/⬇ indicators); Repeat components include a sort direction dropdown. Sorting operates on raw data values.
- **Display Binding** — Table, Badge, and Text components accept a `dataSource` prop for dynamic content with built-in aggregates (`count`, `sum`, `avg`, `min`, `max`) and compact number formatting.
- **Repeat** — The Repeat component iterates over filtered rows, rendering a template per row with `${field}` placeholders and transforms like `percentOfMax`.

See [docs/a2ui-reactive.md](docs/a2ui-reactive.md) for the full data binding guide and [docs/components.md](docs/components.md) for the complete component reference.

## Snapshot Capture

The `canvas.snapshot` tool captures the canvas as a base64 PNG. A snapshot helper script (using `dom-to-image-more`) is injected into canvas HTML at serve time — the same pattern as deep link injection. When a snapshot is requested, the parent SPA sends a `postMessage` to the iframe, the injected script captures `document.body` from within the frame, and sends the image back via `postMessage`. This works for same-origin files and `data:` URLs. External cross-origin URLs cannot be captured. Falls back to parent-level DOM capture for A2UI surfaces. 30s timeout.

## Documentation

- [Component Reference](../../docs/canvas/components.md) — all A2UI components with props and examples
- [Reactive Data Binding](../../docs/canvas/a2ui-reactive.md) — data sources, filtering, aggregates
- [Deep Linking](../../docs/canvas/deep-linking.md) — URL schemes, confirmation dialog, file-spawn
- [Creating Catalog Packages](../../docs/canvas/creating-catalog-packages.md) — third-party component catalogs
- [JSONL Watcher](../../docs/canvas/jsonl-watcher.md) — auto-push from filesystem
- [Tool Reference](../../docs/tools/canvas.md) — tool parameters and usage
