# Canvas Service Plugin — Specification

Type signatures, interfaces, schemas, and code examples for porting the OpenClaw Canvas web server to Shoggoth's plugin and service registry system.

---

## 1. Package Renaming

All `openclaw`-prefixed packages and scopes become `shoggoth`-prefixed.

| Current name                               | New name                                    |
| ------------------------------------------ | ------------------------------------------- |
| `@haliphax-openclaw/a2ui-sdk`              | `@shoggoth/a2ui-sdk`                        |
| `@haliphax-openclaw/a2ui-catalog-basic`    | `@shoggoth/a2ui-catalog-basic`              |
| `@haliphax-openclaw/a2ui-catalog-extended` | `@shoggoth/a2ui-catalog-extended`           |
| `@haliphax-openclaw/a2ui-catalog-all`      | `@shoggoth/a2ui-catalog-all`                |
| `openclaw-canvas` (project)                | `@shoggoth/service-canvas` (plugin package) |

Internal imports referencing `@haliphax-openclaw/*` are updated to `@shoggoth/*`.

---

## 2. Plugin Manifest

The plugin's `package.json` declares the `shoggothPlugin` property bag:

```json
{
  "name": "@shoggoth/service-canvas",
  "version": "0.1.0",
  "type": "module",
  "shoggothPlugin": {
    "kind": "service",
    "entrypoint": "./src/plugin.ts"
  },
  "dependencies": {
    "@shoggoth/plugins": "*",
    "@shoggoth/shared": "*",
    "express": "^5.1.0",
    "ws": "^8.18.0",
    "better-sqlite3": "^12.8.0",
    "chokidar": "^4.0.0",
    "mime-types": "^2.1.35"
  }
}
```

---

## 3. Plugin Entrypoint

The entrypoint exports a factory function returning `Plugin<ShoggothHooks>`:

```ts
import type { Plugin } from "hooks-plugin";
import type { ShoggothHooks } from "@shoggoth/plugins";
import type { DirectServiceTool } from "@shoggoth/plugins";

export default function createCanvasPlugin(): Plugin<ShoggothHooks> {
  return {
    name: "service-canvas",
    hooks: {
      "service.register"(ctx) {
        /* ... */
      },
      "health.register"(ctx) {
        /* ... */
      },
      "daemon.shutdown"(ctx) {
        /* ... */
      },
    },
  };
}
```

---

## 4. Service Registration

In the `service.register` hook, the plugin:

1. Starts the Express + WebSocket server on a configured port
2. Calls `ctx.registerService()` to register with the `ServiceRegistry`
3. Calls `ctx.registerTools()` to register direct tool handlers

### Service Entry

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

`expose: "both"` means:

- The Express HTTP server is proxied through Shoggoth's `ServiceGateway` at `/svc/canvas/...`
- The WebSocket endpoints (`/ws`, `/ws/a2ui`) are proxied at `/svc/canvas/ws` and `/svc/canvas/ws/a2ui`
- Direct tools are invocable in-process without HTTP overhead

---

## 5. Direct Tool Definitions

Eight tools replace the OpenClaw `NodeClient.executeCommand()` dispatch. All are `DirectServiceTool` entries registered via `ctx.registerTools()`.

### 5.1 `canvas.present`

Show/present canvas content for a session.

```ts
{
  name: "canvas.present",
  description: "Show the canvas panel for a given session. If the session has a URL or file path, navigates to it.",
  parameters: {
    type: "object",
    properties: {
      session: { type: "string", description: "Session ID (e.g. 'developer'). Defaults to 'main'." },
      target: { type: "string", description: "URL or file path to present." },
      surface: { type: "string", description: "Optional A2UI surface to activate." },
    },
  },
  async handler(args, ctx) { /* ... */ },
}
```

### 5.2 `canvas.hide`

Hide the canvas panel.

```ts
{
  name: "canvas.hide",
  description: "Hide the canvas panel.",
  parameters: { type: "object", properties: {} },
  async handler(args, ctx) { /* ... */ },
}
```

### 5.3 `canvas.navigate`

Navigate to a session/path or external URL.

```ts
{
  name: "canvas.navigate",
  description: "Navigate the canvas to a session file path or external URL. For external URLs, only http/https are allowed.",
  parameters: {
    type: "object",
    properties: {
      session: { type: "string", description: "Session ID. Defaults to 'main'." },
      path: { type: "string", description: "File path within the session directory." },
      url: { type: "string", description: "External URL (http/https) or shoggoth-canvas:// URL." },
    },
  },
  async handler(args, ctx) { /* ... */ },
}
```

### 5.4 `canvas.eval`

Execute JavaScript in the canvas iframe.

```ts
{
  name: "canvas.eval",
  description: "Execute JavaScript in the canvas iframe context.",
  parameters: {
    type: "object",
    properties: {
      js: { type: "string", description: "JavaScript code to execute." },
      session: { type: "string", description: "Session ID. Defaults to 'main'." },
    },
    required: ["js"],
  },
  async handler(args, ctx) { /* ... */ },
}
```

### 5.5 `canvas.snapshot`

Capture the current canvas as a base64 PNG.

```ts
{
  name: "canvas.snapshot",
  description: "Capture the current canvas content as a base64 PNG image. Works for same-origin content and A2UI surfaces. Cross-origin iframes cannot be captured.",
  parameters: {
    type: "object",
    properties: {
      session: { type: "string", description: "Session ID. Defaults to 'main'." },
    },
  },
  async handler(args, ctx) { /* ... */ },
}
```

### 5.6 `canvas.a2ui.push`

Push A2UI surface commands as JSONL.

```ts
{
  name: "canvas.a2ui.push",
  description: "Push A2UI surface commands to a canvas session. The payload is a JSONL string where each line is an A2UI command object.",
  parameters: {
    type: "object",
    properties: {
      payload: { type: "string", description: "JSONL string of A2UI commands." },
      session: { type: "string", description: "Session ID. Defaults to 'main'." },
    },
    required: ["payload"],
  },
  async handler(args, ctx) { /* ... */ },
}
```

### 5.7 `canvas.a2ui.pushJSONL`

Alias for `canvas.a2ui.push` — accepts a raw JSONL string.

```ts
{
  name: "canvas.a2ui.pushJSONL",
  description: "Push a raw JSONL A2UI payload string to a canvas session. Alias for canvas.a2ui.push.",
  parameters: {
    type: "object",
    properties: {
      payload: { type: "string", description: "Raw JSONL string." },
      session: { type: "string", description: "Session ID. Defaults to 'main'." },
    },
    required: ["payload"],
  },
  async handler(args, ctx) { /* ... */ },
}
```

### 5.8 `canvas.a2ui.reset`

Clear A2UI surface state.

```ts
{
  name: "canvas.a2ui.reset",
  description: "Clear all A2UI surfaces for a session, or all sessions if no session is specified.",
  parameters: {
    type: "object",
    properties: {
      session: { type: "string", description: "Session ID. If omitted, clears all sessions." },
    },
  },
  async handler(args, ctx) { /* ... */ },
}
```

---

## 6. Tool Handler Implementation Pattern

Each handler follows the same pattern as the existing `NodeClient.executeCommand()` cases, adapted to the `DirectServiceTool` interface:

```ts
async handler(args, ctx) {
  const session = (args.session as string) || "main";

  // Dispatch to the in-memory Gateway instance (same object the WS server uses)
  gateway.broadcastSpaSession(session, {
    type: "canvas.show",
    session,
  });

  return {
    resultJson: JSON.stringify({ ok: true, session }),
  };
}
```

The `gateway` object is the same `Gateway` instance created during `service.register` — no HTTP round-trip needed.

For `canvas.snapshot`, the handler uses `gateway.requestSnapshot()` which returns a promise that resolves when the SPA sends the image back via WebSocket.

---

## 7. Proxy Routes (Adapted, Not Removed)

### 7.1 `POST /api/agent` (Agent Deep Link Proxy)

**Purpose:** Lets the browser spawn a subagent by clicking an `openclaw://agent?message=...` deep link in canvas content. The SPA POSTs to this route; the plugin spawns the subagent in-process.

**OpenClaw behavior:** HTTP-proxies to the gateway's `/tools/invoke` with `sessions_spawn`.

**Shoggoth behavior:** Calls Shoggoth's internal session spawn mechanism directly. No external HTTP call, no gateway token needed — the plugin is a trusted in-process extension.

**Request body:**

```ts
{
  message: string;       // Required. The task/prompt for the subagent.
  agentId?: string;      // Optional. Target agent ID.
  model?: string;        // Optional. Model override.
  thinking?: string;     // Optional. Thinking mode.
  timeoutSeconds?: number;  // Optional. Run timeout.
  sessionKey?: string;   // Optional. Session routing key (default: 'devnull').
}
```

**Handler implementation:**

```ts
router.post("/api/agent", (req, res) => {
  // ... parse body, validate message ...

  // Instead of HTTP-proxying to external gateway:
  //   → call Shoggoth's internal session spawn
  const result = await shoggothSessionsSpawn({
    task: parsed.message,
    mode: "run",
    agentId: parsed.agentId,
    model: parsed.model,
    runTimeoutSeconds: parsed.timeoutSeconds,
    sessionKey: parsed.sessionKey || "devnull",
  });

  res.json({ ok: true, result });
});
```

The SPA-facing API is identical — only the server-side implementation changes.

### 7.2 `POST /api/file-spawn` (File Prompt Spawn)

**Purpose:** Lets the browser spawn a subagent from a prompt file stored in the canvas workspace. The SPA POSTs a file path; the plugin reads the prompt text and spawns the subagent. This is how `openclaw-fileprompt://` links work.

**OpenClaw behavior:** Reads the prompt file, then HTTP-proxies to the gateway's `/tools/invoke` with `sessions_spawn`.

**Shoggoth behavior:** Reads the prompt file, then calls Shoggoth's internal session spawn mechanism directly.

**Request body:**

```ts
{
  file: string;          // Required. Path to the prompt file (relative to session canvas dir).
  agentId?: string;      // Optional. Target agent ID.
  model?: string;        // Optional. Model override.
  sessionKey?: string;   // Optional. Session routing key (default: 'devnull').
}
```

**Handler implementation:**

```ts
router.post("/api/file-spawn", async (req, res) => {
  // ... parse body, validate file path, block traversal ...

  const root = agentId ? agentWorkspaceMap.get(agentId) : canvasRoot;
  const resolved = path.resolve(root, filePath);
  // ... traversal guard ...

  const prompt = await fs.readFile(resolved, "utf-8");

  // Instead of HTTP-proxying to external gateway:
  //   → call Shoggoth's internal session spawn
  const result = await shoggothSessionsSpawn({
    task: prompt,
    mode: "run",
    agentId: parsed.agentId,
    model: parsed.model,
    sessionKey: parsed.sessionKey || "devnull",
  });

  res.json({ ok: true, result });
});
```

### 7.3 Why These Routes Must Be Preserved

Both routes serve **operator-initiated** subagent spawning:

1. **Operator** clicks an A2UI button or deep link in the Canvas SPA
2. **Browser** POSTs to the canvas server route
3. **Canvas server** spawns a subagent on the operator's behalf

This is fundamentally different from agent-initiated spawning. The browser cannot call Shoggoth's session tools directly — it needs the canvas server as a trusted intermediary. In OpenClaw, the intermediary HTTP-proxies to the gateway. In Shoggoth, the intermediary calls session spawn in-process.

### 7.4 Session Spawn Mechanism

The plugin needs access to Shoggoth's session spawn capability. The exact mechanism depends on what the Shoggoth daemon exposes to plugins at `service.register` time. Options:

1. **Pass a `sessionsSpawn` function** from the daemon context to the plugin (cleanest — same pattern as `registerService`/`registerTools`)
2. **Use the `ServiceToolRegistry`** to look up and invoke the session spawn tool
3. **Accept a `sessionsSpawn` callback** as part of the `PluginServiceEntry`

The plan assumes option 1 — the daemon passes a spawn function in the registration context.

---

## 8. Health Probe

```ts
"health.register"(ctx) {
  ctx.registerProbe({
    name: "canvas",
    check: async () => ({
      status: server?.listening ? "pass" : "fail",
      detail: server?.listening ? `Listening on port ${port}` : "Server not running",
    }),
  });
},
```

---

## 9. Shutdown

```ts
async "daemon.shutdown"() {
  gateway.broadcastSpa({ type: "server.shutdown" });
  jsonlWatcher.close();
  await fileWatcher.close();
  gateway.close();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
},
```

---

## 10. Environment Variable Renaming

All `OPENCLAW_CANVAS_*` variables are renamed to `SHOGGOTH_CANVAS_*`:

| Old                            | New                            |
| ------------------------------ | ------------------------------ |
| `OPENCLAW_CANVAS_HOST`         | `SHOGGOTH_CANVAS_HOST`         |
| `OPENCLAW_CANVAS_PORT`         | `SHOGGOTH_CANVAS_PORT`         |
| `OPENCLAW_CANVAS_BASE_PATH`    | `SHOGGOTH_CANVAS_BASE_PATH`    |
| `OPENCLAW_CANVAS_SKIP_CONFIRM` | `SHOGGOTH_CANVAS_SKIP_CONFIRM` |
| `OPENCLAW_CANVAS_A2UI_DB`      | `SHOGGOTH_CANVAS_A2UI_DB`      |
| `OPENCLAW_CANVAS_ROOT`         | `SHOGGOTH_CANVAS_ROOT`         |
| `OPENCLAW_CANVAS_IGNORE_DIRS`  | `SHOGGOTH_CANVAS_IGNORE_DIRS`  |

`OPENCLAW_GATEWAY_WS_URL` and `OPENCLAW_GATEWAY_TOKEN` are **removed** — the plugin no longer connects to an OpenClaw gateway.

---

## 11. Removed Components

These OpenClaw-specific components are deleted entirely:

| Component                                                     | Reason                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| `NodeClient`                                                  | Shoggoth plugin system handles registration; no Ed25519 auth needed |
| MCP server (`mcp/`)                                           | Tools are natively exposed to Shoggoth agents                       |
| `OPENCLAW_GATEWAY_WS_URL` / `OPENCLAW_GATEWAY_TOKEN` env vars | No gateway connection                                               |
| `openclaw.json` config reading                                | Replaced by Shoggoth config (`ctx.config`)                          |

---

## 12. Adapted Components

These components are preserved with modified implementations:

| Component           | Change                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `agent-proxy` route | Server-side: calls Shoggoth session spawn in-process instead of HTTP-proxying to external gateway. SPA-facing API unchanged. |
| `file-spawn` route  | Server-side: calls Shoggoth session spawn in-process instead of HTTP-proxying to external gateway. SPA-facing API unchanged. |

---

## 13. Workspace Resolution

OpenClaw reads agent workspace paths from `~/.openclaw/openclaw.json`. The Shoggoth plugin reads them from `ctx.config.agents.list` at `service.register` time:

```ts
const agentsList = ctx.config.agents?.list ?? [];
const agentWorkspaceMap = new Map<string, string>();
for (const agent of agentsList) {
  const ws = agent.workspace ?? defaultWorkspace;
  const canvasDir = path.join(ws, "canvas");
  fs.mkdirSync(canvasDir, { recursive: true });
  agentWorkspaceMap.set(agent.id, canvasDir);
}
```

---

## 14. Config Schema

The plugin is activated by adding an entry to the Shoggoth config's `plugins` array:

```json
{
  "plugins": [{ "package": "@shoggoth/service-canvas" }]
}
```

Or for local development:

```json
{
  "plugins": [{ "path": "./packages/service-canvas" }]
}
```

---

## 15. File Layout (Final)

```
packages/service-canvas/
├── package.json                    # shoggothPlugin manifest
├── tsconfig.json
├── src/
│   ├── plugin.ts                   # Plugin entrypoint (factory + hooks)
│   ├── server/
│   │   ├── index.ts                # Express app, startup, shutdown (adapted)
│   │   ├── services/
│   │   │   ├── gateway.ts          # WebSocket server (/gateway, /ws, /ws/a2ui)
│   │   │   ├── session-manager.ts  # Active session tracking
│   │   │   ├── file-resolver.ts    # Path resolution with traversal guard
│   │   │   ├── file-watcher.ts     # chokidar live reload
│   │   │   ├── jsonl-watcher.ts    # JSONL A2UI auto-push
│   │   │   ├── a2ui-manager.ts     # A2UI surface state
│   │   │   ├── a2ui-store.ts       # SQLite persistence
│   │   │   ├── a2ui-pipeline.ts    # A2UI command processing
│   │   │   ├── a2ui-commands.ts    # v0.8 → v0.9 normalization
│   │   │   └── catalog-registry.ts # Catalog package discovery
│   │   ├── shared/
│   │   │   ├── deep-link-script.ts
│   │   │   └── snapshot-script.ts
│   │   ├── commands/
│   │   │   ├── canvas.ts           # show, hide, navigate, eval, snapshot
│   │   │   └── a2ui.ts             # push, reset
│   │   └── routes/
│   │       ├── canvas.ts           # GET /:session/:path
│   │       ├── catalogs.ts         # GET /api/catalogs
│   │       ├── canvas-config.ts    # GET /api/canvas-config
│   │       ├── scaffold.ts         # GET /scaffold
│   │       ├── agent-proxy.ts      # POST /api/agent — operator-initiated spawn (adapted)
│   │       └── file-spawn.ts       # POST /api/file-spawn — operator-initiated spawn (adapted)
│   └── client/                     # Vue 3 SPA (unchanged)
│       ├── main.ts
│       ├── router.ts
│       ├── views/
│       ├── components/
│       ├── store/
│       ├── services/
│       ├── utils/
│       └── styles/
├── packages/
│   ├── a2ui-sdk/                   # @shoggoth/a2ui-sdk
│   ├── a2ui-catalog-basic/         # @shoggoth/a2ui-catalog-basic
│   ├── a2ui-catalog-extended/      # @shoggoth/a2ui-catalog-extended
│   └── a2ui-catalog-all/           # @shoggoth/a2ui-catalog-all
└── test/                           # vitest tests (adapted)
```

---

## 16. Documentation Files

The following docs are ported and updated:

| Source                                                  | Target                                                      | Changes                                                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw-canvas-web/README.md`                         | `packages/service-canvas/README.md`                         | Rename all `openclaw` → `shoggoth`, update env vars, remove node client / MCP sections, update proxy route descriptions                           |
| `openclaw-canvas-web/AGENTS.md`                         | `packages/service-canvas/AGENTS.md`                         | Rename all `openclaw` → `shoggoth`, update architecture diagram, remove node client references, document proxy routes as in-process session spawn |
| `openclaw-canvas-web/docs/components.md`                | `packages/service-canvas/docs/components.md`                | Rename scope references                                                                                                                           |
| `openclaw-canvas-web/docs/creating-catalog-packages.md` | `packages/service-canvas/docs/creating-catalog-packages.md` | Rename scope references                                                                                                                           |
| `openclaw-canvas-web/docs/deep-linking.md`              | `packages/service-canvas/docs/deep-linking.md`              | Update to describe in-process Shoggoth session spawn instead of gateway HTTP proxy                                                                |
| `openclaw-canvas-web/docs/a2ui-reactive.md`             | `packages/service-canvas/docs/a2ui-reactive.md`             | Rename scope references                                                                                                                           |
| `openclaw-canvas-web/docs/jsonl-watcher.md`             | `packages/service-canvas/docs/jsonl-watcher.md`             | Rename scope references                                                                                                                           |
| —                                                       | `docs/tools/canvas.md`                                      | **NEW** — tool reference for all 8 canvas tools                                                                                                   |

---

## 17. New Tool Reference Doc

A new `docs/tools/canvas.md` is created in the main Shoggoth docs, following the same format as other tool docs. It documents all 8 canvas tools with:

- Tool name and description
- Parameter schema
- Example invocations
- Notes on session scoping, A2UI catalogs, and snapshot limitations
- Section on operator-initiated spawning via proxy routes (`/api/agent`, `/api/file-spawn`)
