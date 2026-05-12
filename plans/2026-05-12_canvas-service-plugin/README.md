---
date: 2026-05-12
completed: never
---

# Canvas Web Server — Shoggoth Service Plugin Port

## Summary

Port the [OpenClaw Canvas web server](https://github.com/haliphax-ai/openclaw-canvas-web) to Shoggoth's plugin and service registry system. The Canvas server becomes a `service`-kind plugin (`@shoggoth/service-canvas`) that registers its HTTP/WebSocket endpoints through the `ServiceGateway` and exposes canvas manipulation commands as direct in-process tools. All `openclaw` package scopes are renamed to `shoggoth`, OpenClaw-specific components (node client, MCP server) are removed, and documentation is fully ported.

## Motivation

The Canvas web server is a cross-platform canvas that agents control via WebSocket. It renders HTML content and A2UI (Agent-to-UI) surfaces in a Vue 3 SPA. Currently built for OpenClaw, it uses:

- **NodeClient** — Ed25519-authenticated gateway node registration to receive `node.invoke` commands
- **HTTP proxy routes** (`/api/agent`, `/api/file-spawn`) — intermediaries that let the browser spawn subagents/prompt sessions by proxying to the gateway's `/tools/invoke` (the browser can't hold gateway credentials)
- **MCP server** — separate process exposing canvas commands via MCP

In Shoggoth:

- NodeClient is replaced by the plugin system's `service.register` hook
- The proxy routes stay but call Shoggoth's internal session mechanisms directly instead of HTTP-proxying to an external gateway
- The MCP server is removed because tools are natively exposed to agents

## Design

### Architecture

```
Shoggoth Agent ──tool call──▶ DirectServiceTool handler ──▶ Gateway (in-memory)
                                                              │
Browser ──click A2UI element──▶ SPA ──POST /api/agent──▶ plugin route
                                   │                        │
                                   └──POST /api/file───┐   │
                                                        ▼   ▼
                                              Shoggoth session spawn (in-process)
```

The plugin starts its own Express + WebSocket server on a configured port. Agent tool calls bypass HTTP entirely — they invoke the same in-memory `Gateway` object directly. Browser-initiated spawns go through the Express routes, which call Shoggoth's internal session mechanisms in-process (no external HTTP proxy needed).

### Package Renaming

All `openclaw`-prefixed scopes become `shoggoth`:

| Old                                        | New                                 |
| ------------------------------------------ | ----------------------------------- |
| `@haliphax-openclaw/a2ui-sdk`              | `@shoggoth/a2ui-sdk`                |
| `@haliphax-openclaw/a2ui-catalog-basic`    | `@shoggoth/a2ui-catalog-basic`      |
| `@haliphax-openclaw/a2ui-catalog-extended` | `@shoggoth/a2ui-catalog-extended`   |
| `@haliphax-openclaw/a2ui-catalog-all`      | `@shoggoth/a2ui-catalog-all`        |
| `openclaw-canvas-web` (project)            | `@shoggoth/service-canvas` (plugin) |

### Removed vs. Adapted Components

| Component                                            | Action    | Reason / Replacement                                                                                                                                     |
| ---------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NodeClient`                                         | Remove    | Shoggoth plugin system handles registration; no Ed25519 auth needed                                                                                      |
| MCP server                                           | Remove    | Tools are natively exposed to Shoggoth agents                                                                                                            |
| `agent-proxy` route                                  | **Adapt** | Operator-initiated subagent spawn from browser clicks. Stays but calls Shoggoth session spawn in-process instead of HTTP-proxying to external gateway    |
| `file-spawn` route                                   | **Adapt** | Operator-initiated prompt file spawn from browser clicks. Stays but calls Shoggoth session spawn in-process instead of HTTP-proxying to external gateway |
| `OPENCLAW_GATEWAY_WS_URL` / `OPENCLAW_GATEWAY_TOKEN` | Remove    | No external gateway connection                                                                                                                           |
| `openclaw.json` config reading                       | Remove    | Replaced by Shoggoth config via `ctx.config`                                                                                                             |

### Proxy Route Adaptation

Both proxy routes (`/api/agent` and `/api/file-spawn`) serve a critical purpose: they let the **operator** (via the browser) spawn subagents or prompt existing sessions by clicking A2UI elements in the canvas. The browser can't call Shoggoth's session tools directly, so the canvas server acts as a trusted intermediary.

In OpenClaw, these routes HTTP-proxy to the gateway's `/tools/invoke` endpoint. In Shoggoth, since the plugin runs in-process, the routes call Shoggoth's internal session spawn mechanism directly:

- **No external HTTP call** — the plugin has direct access to Shoggoth's session runtime
- **No gateway token needed** — the plugin is a trusted in-process extension
- **Same browser-facing API** — the SPA sends the same POST requests; only the server-side implementation changes

### Tool Surface

Eight direct tools replace the OpenClaw `NodeClient.executeCommand()` dispatch:

| Tool                    | Description                                |
| ----------------------- | ------------------------------------------ |
| `canvas.present`        | Show/present canvas content for a session  |
| `canvas.hide`           | Hide the canvas panel                      |
| `canvas.navigate`       | Navigate to a session/path or external URL |
| `canvas.eval`           | Execute JavaScript in the canvas iframe    |
| `canvas.snapshot`       | Capture canvas as base64 PNG               |
| `canvas.a2ui.push`      | Push A2UI surface commands (JSONL)         |
| `canvas.a2ui.pushJSONL` | Push raw JSONL A2UI payload                |
| `canvas.a2ui.reset`     | Clear A2UI surface state                   |

### Environment Variables

All `OPENCLAW_CANVAS_*` variables are renamed to `SHOGGOTH_CANVAS_*`. Gateway-related variables (`OPENCLAW_GATEWAY_WS_URL`, `OPENCLAW_GATEWAY_TOKEN`) are removed.

### Service Registration

```ts
ctx.registerService({
  id: "canvas",
  label: "Canvas",
  capabilities: ["canvas", "a2ui", "web"],
  expose: "both",
  port: 3456,
  protocol: "http+ws",
  basePath: "/",
});
```

`expose: "both"` means the service is accessible via the `ServiceGateway` proxy (for browsers) and via direct tool handlers (for agents).

### Documentation

All Canvas project documentation is ported and updated:

- `README.md`, `AGENTS.md`, and all `docs/` files
- References to `openclaw` replaced with `shoggoth`
- Node client and MCP sections removed
- Proxy route docs updated to describe in-process Shoggoth session spawn instead of gateway HTTP proxy
- New `docs/tools/canvas.md` created in the main Shoggoth docs

## Testing Strategy

- **Unit tests:** Each tool handler, service registration, health probe, and shutdown hook
- **Proxy route tests:** `/api/agent` and `/api/file-spawn` adapted to mock Shoggoth session spawn instead of HTTP proxying to external gateway
- **Integration tests:** Plugin loads in the daemon, service appears in registry, tools are callable, SPA is accessible via gateway proxy
- **Existing tests:** Ported from the OpenClaw Canvas project, adapted for the plugin model (no mocks for gateway node client or external HTTP calls)
- **Regression:** Full Shoggoth test suite must pass unchanged

## Considerations

- The `Gateway` class (WebSocket server) is shared between the plugin's HTTP server and direct tool handlers — it must be a singleton within the plugin process
- `canvas.snapshot` is async and uses a pending promise map with a 30s timeout — the direct tool handler must await this
- The Vue SPA client code is unchanged; only server-side code is ported
- A2UI catalog packages (`a2ui-sdk`, `a2ui-catalog-basic`, `a2ui-catalog-extended`, `a2ui-catalog-all`) are ported as separate packages within the monorepo
- The `ServiceGateway` handles WebSocket upgrade proxying — no special config needed for `/ws` and `/ws/a2ui`
- Deep links (`openclaw://`) are handled client-side by the injected script; the server-side route (`/api/agent`) now calls Shoggoth session spawn in-process instead of HTTP-proxying to an external gateway
- The `openclaw-canvas://` URL scheme should be renamed to `shoggoth-canvas://` for consistency (TBD — may be deferred to avoid breaking existing canvas content)
- **Operator-initiated spawning is the core use case for the proxy routes:** an operator clicks an A2UI button in the canvas → SPA POSTs to `/api/agent` or `/api/file-spawn` → plugin spawns a subagent or prompts an existing session. This is fundamentally different from agent-initiated spawning and must be preserved.

## Migration

- No database schema changes in the core Shoggoth database
- Canvas's own SQLite database (A2UI cache) is unaffected
- Config gains a `{ "package": "@shoggoth/service-canvas" }` entry in the `plugins` array
- Existing Canvas deployments must update environment variable names (`OPENCLAW_CANVAS_*` → `SHOGGOTH_CANVAS_*`)
- No state migration needed — the A2UI SQLite cache is forward-compatible

## References

- [`spec.md`](spec.md) — Full type signatures, tool definitions, and file layout
- [`implementation.md`](implementation.md) — Phased implementation steps
- [Shoggoth plugins docs](../../docs/plugins.md) — Plugin system reference
- [Service demo package](../../packages/service-demo/) — Reference `service`-kind plugin implementation
- [Original Canvas project](https://github.com/haliphax-ai/openclaw-canvas-web) — Source of truth for server/client code being ported
