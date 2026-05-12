# @shoggoth/service-canvas

A Shoggoth service plugin that provides a browser-based canvas surface for agent-to-user interaction. Agents can present content, navigate pages, execute JavaScript, take snapshots, and push reactive A2UI components to connected clients via WebSocket.

## Installation

The plugin is included in the Shoggoth monorepo. Add it to your config:

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
      "host": "127.0.0.1",
      "port": 3100,
      "basePath": "/",
      "skipConfirm": false,
      "a2uiDbPath": "",
      "ignoreDirs": ["node_modules", ".git", "tmp"],
      "agentWorkspaces": {}
    }
  }
}
```

| Field             | Type     | Default                             | Description                                   |
| ----------------- | -------- | ----------------------------------- | --------------------------------------------- |
| `host`            | string   | `"127.0.0.1"`                       | Bind address for the canvas server            |
| `port`            | number   | `3100`                              | Port for HTTP + WebSocket server              |
| `basePath`        | string   | `"/"`                               | Base path for serving the canvas SPA          |
| `skipConfirm`     | boolean  | `false`                             | Skip confirmation prompts for destructive ops |
| `a2uiDbPath`      | string   | `"/var/lib/shoggoth/state/a2ui.db"` | Path to A2UI state database                   |
| `ignoreDirs`      | string[] | `[]`                                | Directories to ignore in file watching        |
| `agentWorkspaces` | object   | `{}`                                | Map of agent IDs to workspace root paths      |

## Architecture

```
┌─────────────────────────────────────────────┐
│              Shoggoth Daemon                 │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │       service-canvas plugin           │  │
│  │                                       │  │
│  │  ┌─────────┐  ┌──────────────────┐   │  │
│  │  │ Express │  │  WebSocket GW    │   │  │
│  │  │ Server  │  │  (Gateway)       │   │  │
│  │  └────┬────┘  └────────┬─────────┘   │  │
│  │       │                 │             │  │
│  │  ┌────┴────┐     ┌─────┴──────┐      │  │
│  │  │ Routes  │     │ SPA Clients │      │  │
│  │  └─────────┘     └────────────┘      │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  sessionsSpawn (trusted, in-process)        │
└─────────────────────────────────────────────┘
```

- **Express server** handles HTTP routes (`/api/agent`, `/api/file-spawn`)
- **Gateway** manages WebSocket connections from canvas SPA clients
- **Tools** (8 total) are registered as direct service tools — no MCP dispatch
- **Session spawning** uses the daemon's in-process `sessionsSpawn` with trusted plugin identity (no token)

## Tools

The plugin registers 8 tools:

| Tool                    | Description                               |
| ----------------------- | ----------------------------------------- |
| `canvas.present`        | Show a canvas surface to a session        |
| `canvas.hide`           | Hide the canvas from all sessions         |
| `canvas.navigate`       | Navigate a session's canvas to a URL/path |
| `canvas.eval`           | Execute JavaScript in a session's canvas  |
| `canvas.snapshot`       | Take a screenshot (base64 PNG)            |
| `canvas.a2ui.push`      | Push A2UI reactive data to a session      |
| `canvas.a2ui.pushJSONL` | Push A2UI data as JSONL (alias for push)  |
| `canvas.a2ui.reset`     | Clear A2UI state for a session            |

See [Tool Reference](../../docs/tools/canvas.md) for full parameter documentation.

## URL Schemes

The canvas uses custom URL schemes for deep linking:

| Scheme                   | Purpose                            |
| ------------------------ | ---------------------------------- |
| `shoggoth://`            | Agent interaction deep links       |
| `shoggoth-fileprompt://` | File-based prompt spawning         |
| `shoggoth-canvas://`     | Cross-session canvas URL rewriting |

See [Deep Linking](docs/deep-linking.md) for details.

## Proxy Routes

Two HTTP endpoints support operator-initiated session spawning from the canvas SPA:

### POST `/api/agent`

Spawn a session with a text message.

```json
{
  "message": "Explain this code",
  "agentId": "developer",
  "model": "anthropic/claude-sonnet-4-20250514",
  "timeoutSeconds": 120,
  "sessionKey": "optional-session-key"
}
```

### POST `/api/file-spawn`

Read a file and spawn a session with its content.

```json
{
  "file": "/path/to/prompt.md",
  "agentId": "developer",
  "model": "anthropic/claude-sonnet-4-20250514",
  "sessionKey": "optional-session-key"
}
```

Path traversal is blocked — `..` segments are rejected.

## Health

The plugin registers a health probe named `canvas` that reports:

- `pass` when the HTTP server is listening
- `fail` when the server is not running

## Related Packages

- `@shoggoth/a2ui-sdk` — SDK for building A2UI catalog packages
- `@shoggoth/a2ui-catalog-basic` — Basic UI component catalog
- `@shoggoth/a2ui-catalog-extended` — Extended UI components
- `@shoggoth/a2ui-catalog-all` — Meta-package including all catalogs
