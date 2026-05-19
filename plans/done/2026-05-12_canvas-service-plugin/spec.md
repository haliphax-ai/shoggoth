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

## 2. URL Scheme Renaming

All `openclaw://`-prefixed URL schemes are renamed to `shoggoth://`:

| Old scheme                           | New scheme                           |
| ------------------------------------ | ------------------------------------ |
| `openclaw://agent?...`               | `shoggoth://agent?...`               |
| `openclaw-fileprompt://...`          | `shoggoth-fileprompt://...`          |
| `openclaw-canvas://<session>/<path>` | `shoggoth-canvas://<session>/<path>` |

This affects:

- Deep link interception in the injected script (`deep-link-script.ts`)
- URL scheme parsing in client-side code (`url-schemes.ts`, `url-rewriter.ts`)
- Canvas route handling for `openclaw-canvas://` protocol navigation
- All documentation referencing URL schemes

---

## 3. Plugin Manifest

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

## 4. Configuration (No Environment Variables)

The Canvas plugin reads all configuration from the Shoggoth config system (`ctx.config`) and built-in defaults. **No environment variables are used.** This follows the Shoggoth project convention where configuration flows through the layered config system, not process environment.

### 4.1 Config Schema

A new `canvas` key is added to the Shoggoth config schema:

```ts
interface CanvasConfig {
  /** Bind address. Default: "0.0.0.0" */
  host: string;
  /** Listen port. Default: 3456 */
  port: number;
  /** Public base path when behind a reverse proxy. Default: "/" */
  basePath: string;
  /** Skip deep link confirmation dialog. Default: false */
  skipConfirm: boolean;
  /** Path to SQLite database for A2UI surface persistence. */
  a2uiDbPath: string;
  /** Directory names to ignore in file watcher. Default: ["tmp", "jsonl"] */
  ignoreDirs: string[];
  /** Agent-specific workspace canvas directories. Default: {} */
  agentWorkspaces: Record<string, string>;
}
```

Defaults:

```ts
const DEFAULT_CANVAS_CONFIG: CanvasConfig = {
  host: "0.0.0.0",
  port: 3456,
  basePath: "/",
  skipConfirm: false,
  a2uiDbPath: "~/.shoggoth/canvas/a2ui-cache.db",
  ignoreDirs: ["tmp", "jsonl"],
  agentWorkspaces: {},
};
```

### 4.2 Config Access

```ts
// In the service.register hook:
const canvasConfig: CanvasConfig = {
  ...DEFAULT_CANVAS_CONFIG,
  ...ctx.config.services?.canvas,
};
```

### 4.3 Trusted Identity for Auth

The plugin authenticates proxy route requests using its own trusted identity as a Shoggoth plugin. No external gateway token, API key, or environment variable is needed.

In OpenClaw, the canvas server held a gateway token because it was an external process communicating with the gateway over HTTP. In Shoggoth, the plugin runs **in-process** as a trusted extension of the daemon. The daemon already trusts plugin-registered code — there is no separate authentication boundary.

```ts
// No auth config needed. The plugin IS the trusted identity.
// Proxy routes (/api/agent, /api/file-spawn) are registered within
// the plugin's Express server, which only accepts requests routed
// through the ServiceGateway (i.e., from the browser).
```

If additional security is needed (e.g., to prevent unauthorized access to proxy routes from non-browser sources), Shoggoth's config system can provide an optional signing secret:

```ts
interface CanvasConfig {
  // ...other fields...
  /**
   * Optional HMAC secret for proxy route request signing.
   * If omitted, the plugin's trusted identity is sufficient.
   */
  proxySigningSecret?: string;
}
```

---

## 5. Plugin Entrypoint

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

## 6. Service Registration

In the `service.register` hook, the plugin:

1. Reads canvas config from `ctx.config.services?.canvas` merged with defaults
2. Starts the Express + WebSocket server on the configured port
3. Calls `ctx.registerService()` to register with the `ServiceRegistry`
4. Calls `ctx.registerTools()` to register direct tool handlers

### Service Entry

```ts
ctx.registerService({
  id: "canvas",
  label: "Canvas",
  capabilities: ["canvas", "a2ui", "web"],
  expose: "both",
  port: canvasConfig.port,
  protocol: "http+ws",
  basePath: canvasConfig.basePath,
});
```

`expose: "both"` means:

- The Express HTTP server is proxied through Shoggoth's `ServiceGateway` at `/svc/canvas/...`
- The WebSocket endpoints (`/ws`, `/ws/a2ui`) are proxied at `/svc/canvas/ws` and `/svc/canvas/ws/a2ui`
- Direct tools are invocable in-process without HTTP overhead

---

## 7. Direct Tool Definitions

Eight tools replace the OpenClaw `NodeClient.executeCommand()` dispatch. All are `DirectServiceTool` entries registered via `ctx.registerTools()`.

### 7.1 `canvas.present`

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

### 7.2 `canvas.hide`

Hide the canvas panel.

```ts
{
  name: "canvas.hide",
  description: "Hide the canvas panel.",
  parameters: { type: "object", properties: {} },
  async handler(args, ctx) { /* ... */ },
}
```

### 7.3 `canvas.navigate`

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

### 7.4 `canvas.eval`

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

### 7.5 `canvas.snapshot`

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

### 7.6 `canvas.a2ui.push`

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

### 7.7 `canvas.a2ui.pushJSONL`

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

### 7.8 `canvas.a2ui.reset`

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

## 8. Tool Handler Implementation Pattern

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

## 9. Proxy Routes (Adapted, Not Removed)

### 9.1 `POST /api/agent` (Agent Deep Link Proxy)

**Purpose:** Lets the browser spawn a subagent by clicking a `shoggoth://agent?message=...` deep link in canvas content. The SPA POSTs to this route; the plugin spawns the subagent in-process using its trusted identity.

**OpenClaw behavior:** HTTP-proxies to the gateway's `/tools/invoke` with `sessions_spawn`, using a gateway token.

**Shoggoth behavior:** Calls Shoggoth's internal session spawn mechanism directly. No external HTTP call, no gateway token — the plugin is a trusted in-process extension.

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

  // Instead of HTTP-proxying to external gateway with a token:
  //   → call Shoggoth's internal session spawn (trusted in-process)
  const result = await sessionsSpawn({
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

### 9.2 `POST /api/file-spawn` (File Prompt Spawn)

**Purpose:** Lets the browser spawn a subagent from a prompt file stored in the canvas workspace. The SPA POSTs a file path; the plugin reads the prompt text and spawns the subagent via trusted identity.

**OpenClaw behavior:** Reads the prompt file, then HTTP-proxies to the gateway's `/tools/invoke` with `sessions_spawn`, using a gateway token.

**Shoggoth behavior:** Reads the prompt file, then calls Shoggoth's internal session spawn mechanism directly. No token needed — trusted in-process plugin.

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

  // Instead of HTTP-proxying to external gateway with a token:
  //   → call Shoggoth's internal session spawn (trusted in-process)
  const result = await sessionsSpawn({
    task: prompt,
    mode: "run",
    agentId: parsed.agentId,
    model: parsed.model,
    sessionKey: parsed.sessionKey || "devnull",
  });

  res.json({ ok: true, result });
});
```

### 9.3 Why These Routes Must Be Preserved

Both routes serve **operator-initiated** subagent spawning:

1. **Operator** clicks an A2UI button or deep link in the Canvas SPA
2. **Browser** POSTs to the canvas server route
3. **Canvas server** spawns a subagent on the operator's behalf

This is fundamentally different from agent-initiated spawning. The browser cannot call Shoggoth's session tools directly — it needs the canvas server as a trusted intermediary. In OpenClaw, the intermediary HTTP-proxies to the gateway using a token. In Shoggoth, the intermediary calls session spawn in-process using its plugin-trusted identity — no token, no external HTTP call.

### 9.4 Session Spawn Mechanism

The plugin receives a `sessionsSpawn` function from the daemon at `service.register` time. This is the same mechanism used by `registerService` and `registerTools` — the daemon passes capability functions to the plugin through the registration context:

```ts
interface ServiceRegisterCtx {
  readonly registerService: (entry: PluginServiceEntry) => void;
  readonly registerTools: (tools: DirectServiceTool[]) => void;
  readonly sessionsSpawn: (opts: {
    task: string;
    mode: "run";
    agentId?: string;
    model?: string;
    runTimeoutSeconds?: number;
    sessionKey: string;
  }) => Promise<{ sessionId: string /* ... */ }>;
  readonly config: Readonly<ShoggothConfig>;
}
```

---

## 10. Health Probe

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

## 11. Shutdown

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

## 12. Removed Components

These OpenClaw-specific components are deleted entirely:

| Component                                            | Reason                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `NodeClient`                                         | Shoggoth plugin system handles registration; no Ed25519 auth needed |
| MCP server (`mcp/`)                                  | Tools are natively exposed to Shoggoth agents                       |
| All `OPENCLAW_*` environment variables               | Replaced by Shoggoth config system (`ctx.config`) and defaults      |
| `OPENCLAW_GATEWAY_WS_URL` / `OPENCLAW_GATEWAY_TOKEN` | No external gateway connection                                      |
| `openclaw.json` config reading                       | Replaced by Shoggoth config via `ctx.config`                        |
| `haliphax-openclaw` URL scheme prefix                | Renamed to `shoggoth`                                               |

---

## 13. Adapted Components

These components are preserved with modified implementations:

| Component                   | Change                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent-proxy` route         | Server-side: calls Shoggoth session spawn in-process using trusted identity instead of HTTP-proxying to external gateway with a token. SPA-facing API unchanged. Deep link scheme changed from `openclaw://` to `shoggoth://`. |
| `file-spawn` route          | Same: calls Shoggoth session spawn in-process. File prompt scheme changed from `openclaw-fileprompt://` to `shoggoth-fileprompt://`.                                                                                           |
| `deep-link-script.ts`       | URL scheme changed from `openclaw://` to `shoggoth://`                                                                                                                                                                         |
| `url-rewriter.ts`           | URL scheme changed from `openclaw-canvas://` to `shoggoth-canvas://`                                                                                                                                                           |
| `url-schemes.ts`            | All three schemes renamed                                                                                                                                                                                                      |
| Server startup (`index.ts`) | Reads config from plugin context instead of environment variables                                                                                                                                                              |

---

## 14. Workspace Resolution

OpenClaw reads agent workspace paths from `~/.openclaw/openclaw.json`. The Shoggoth plugin reads them from `ctx.config.services?.canvas.agentWorkspaces` with fallback to `ctx.config.agents.list`:

```ts
const canvasConfig = { ...DEFAULT_CANVAS_CONFIG, ...ctx.config.services?.canvas };
const agentsList = ctx.config.agents?.list ?? [];
const agentWorkspaceMap = new Map<string, string>();
for (const agent of agentsList) {
  const ws =
    canvasConfig.agentWorkspaces[agent.id] ??
    path.join(agent.workspace ?? defaultWorkspace, "canvas");
  fs.mkdirSync(ws, { recursive: true });
  agentWorkspaceMap.set(agent.id, ws);
}
```

---

## 15. Config Schema Registration

The plugin is activated by adding an entry to the Shoggoth config's `plugins` array:

```json
{
  "plugins": [{ "package": "@shoggoth/service-canvas" }]
}
```

Optional canvas configuration under the `services` key:

```json
{
  "services": {
    "canvas": {
      "port": 3456,
      "host": "0.0.0.0",
      "basePath": "/",
      "skipConfirm": false,
      "a2uiDbPath": "~/.shoggoth/canvas/a2ui-cache.db",
      "ignoreDirs": ["tmp", "jsonl"],
      "agentWorkspaces": {}
    }
  }
}
```

All fields are optional — defaults are applied for any omitted field.

Or for local development:

```json
{
  "plugins": [{ "path": "./packages/service-canvas" }]
}
```

---

## 16. File Layout (Final)

```
packages/service-canvas/
├── package.json                    # shoggothPlugin manifest
├── tsconfig.json
├── src/
│   ├── plugin.ts                   # Plugin entrypoint (factory + hooks)
│   ├── server/
│   │   ├── index.ts                # Express app, startup, shutdown (adapted)
│   │   ├── services/
│   │   │   ├── gateway.ts          # WebSocket server (/ws, /ws/a2ui)
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
│   │   │   ├── deep-link-script.ts  # shoggoth:// deep link injection
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
│   └── client/                     # Vue 3 SPA
│       ├── main.ts
│       ├── router.ts
│       ├── views/
│       ├── components/
│       ├── store/
│       ├── services/
│       │   ├── ws-client.ts
│       │   ├── url-rewriter.ts     # shoggoth-canvas:// rewriter
│       │   └── deep-link.ts        # shoggoth:// parser
│       ├── utils/
│       │   └── url-schemes.ts      # shoggoth://, shoggoth-fileprompt://, shoggoth-canvas://
│       └── styles/
├── packages/
│   ├── a2ui-sdk/                   # @shoggoth/a2ui-sdk
│   ├── a2ui-catalog-basic/         # @shoggoth/a2ui-catalog-basic
│   ├── a2ui-catalog-extended/      # @shoggoth/a2ui-catalog-extended
│   └── a2ui-catalog-all/           # @shoggoth/a2ui-catalog-all
└── test/                           # vitest tests (adapted)
```

---

## 17. Documentation Files

The following docs are ported and updated:

| Source                                                  | Target                                                      | Changes                                                                                                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openclaw-canvas-web/README.md`                         | `packages/service-canvas/README.md`                         | Rename all `openclaw` → `shoggoth`, replace env var config with Shoggoth config section, remove node client / MCP sections, update proxy route descriptions, update URL schemes             |
| `openclaw-canvas-web/AGENTS.md`                         | `packages/service-canvas/AGENTS.md`                         | Rename all `openclaw` → `shoggoth`, update architecture diagram, remove node client references, document proxy routes as in-process session spawn with trusted identity, update URL schemes |
| `openclaw-canvas-web/docs/components.md`                | `packages/service-canvas/docs/components.md`                | Rename scope references                                                                                                                                                                     |
| `openclaw-canvas-web/docs/creating-catalog-packages.md` | `packages/service-canvas/docs/creating-catalog-packages.md` | Rename scope references                                                                                                                                                                     |
| `openclaw-canvas-web/docs/deep-linking.md`              | `packages/service-canvas/docs/deep-linking.md`              | Update to describe in-process Shoggoth session spawn with trusted identity; update URL schemes to `shoggoth://`                                                                             |
| `openclaw-canvas-web/docs/a2ui-reactive.md`             | `packages/service-canvas/docs/a2ui-reactive.md`             | Rename scope references                                                                                                                                                                     |
| `openclaw-canvas-web/docs/jsonl-watcher.md`             | `packages/service-canvas/docs/jsonl-watcher.md`             | Rename scope references; replace env var config with Shoggoth config                                                                                                                        |
| —                                                       | `docs/tools/canvas.md`                                      | **NEW** — tool reference for all 8 canvas tools                                                                                                                                             |

---

## 18. New Tool Reference Doc

A new `docs/tools/canvas.md` is created in the main Shoggoth docs, following the same format as other tool docs. It documents all 8 canvas tools with:

- Tool name and description
- Parameter schema
- Example invocations
- Notes on session scoping, A2UI catalogs, and snapshot limitations
- Section on operator-initiated spawning via proxy routes (`/api/agent`, `/api/file-spawn`)
- Configuration reference (Shoggoth config, no environment variables)
- URL scheme reference (`shoggoth://`, `shoggoth-fileprompt://`, `shoggoth-canvas://`)
